import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { canonicalBriefHash } from '../editorial/editorial.service.js';
import { outlineContentSchema } from '../editorial/contracts.js';
import type { ArticleService, SourceArticleInputs } from '../editorial/article.service.js';
import type { ArticleContent } from '../editorial/article-contracts.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { sha256Text, type IndexSourceEvidenceInput, type SearchSourceEvidenceInput } from './contracts.js';
import { SourceEvidenceService } from './evidence.service.js';
import { SourceGroundingService } from './source-grounding.service.js';
import { FactualBasisService } from '../claims/factual-basis.service.js';
import { sourceWritingInputSchema, validateSourceWritingOutput, type SourceWritingInput } from './writing-contracts.js';
import { assembleSourceArticle, sourceOutlineSections } from './writing-article-content.js';

const CHECK_INTERVAL_MS = 1_000;
const CHECK_LEASE_MS = 15_000;
const MAX_PER_TICK = 10;
const MAX_WRITING_INPUT_BYTES = 150_000;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN']);

type FrozenSnapshot = Readonly<{ snapshotId: string; sha256: string; materialId: string; sequence: number; label: string }>;
type FrozenContext = Readonly<{ snapshotId: string; purpose: 'NOTES' | 'BRANDBOOK' | 'STYLE_SAMPLE'; sha256: string; text: string }>;
type FrozenStyle = Readonly<{ brandbook: string; tone: string; settings: unknown }>;
type FrozenBrief = Readonly<{ id: string; hash: string; contentMode: 'FACTUAL'; topic: string; audience: string;
  centralMessage: string; category: string; tone: string; targetLength: number; cta: string; exclusions: readonly string[];
  notes: string; workspaceId: string; workspaceStyleRevision: number; style: FrozenStyle }>;
type FrozenSection = Readonly<{ id: string; title: string; purpose: string; targetWords: number; claimRevisionIds: readonly string[] }>;
type RequestInput = Readonly<{ schemaVersion: 'source-writing-request-v1'; commandKey: string; task: 'ARTICLE'; brief: FrozenBrief;
  context: readonly FrozenContext[]; snapshots: readonly FrozenSnapshot[]; outlineRevisionId: string; outlineHash: string;
  outline: { title: string; sections: readonly FrozenSection[] }; expectedArticleRevision: number; release: unknown;
  noticeVersion: string; acceptedAt: string }>;
type SectionStage = FrozenSection & { searchJobId?: string; packetId?: string; writingJobId?: string; writingInputHash?: string;
  output?: unknown; outputHash?: string; executionId?: string };
type StageData = { indexJobIds?: string[]; sections: SectionStage[]; sourceEvidenceSetId?: string; sourceEvidenceSetHash?: string;
  articleVersionId?: string };
type RequestRow = { id: string; projectId: string; requestedBy: string; commandKey: string; task: string; stage: string;
  inputManifestJson: unknown; inputHash: string; stageDataJson: unknown; revision: number; errorCategory: string | null;
  createdAt: Date; updatedAt: Date; nextCheckAt: Date | null };
type Claimed = { request: RequestRow; input: RequestInput; data: StageData };
type ChildRef = { id: string; operation: string; commandKey?: string; manifestCommandKey?: string };

function asJson(value: unknown): Prisma.InputJsonObject { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject; }
function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function parseRequest(row: RequestRow): RequestInput {
  const value = row.inputManifestJson as RequestInput;
  if (!value || value.schemaVersion !== 'source-writing-request-v1' || value.commandKey !== row.commandKey
    || value.task !== row.task || row.task !== 'ARTICLE' || canonicalManifestHash(value) !== row.inputHash) {
    throw new ConflictException('Source article request integrity check failed');
  }
  return value;
}
function parseStageData(value: unknown): StageData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConflictException('Invalid source article stage state');
  return value as StageData;
}
function briefForWriting(brief: FrozenBrief) {
  return { topic: brief.topic, audience: brief.audience, centralMessage: brief.centralMessage, category: brief.category,
    tone: brief.tone, targetLength: brief.targetLength, cta: brief.cta, exclusions: brief.exclusions, notes: brief.notes };
}
function queryForSection(brief: FrozenBrief, section: FrozenSection): string {
  // Keep the section question specific; fields are individually budgeted and Unicode-safe.
  const pieces = [`Topic: ${brief.topic}`, `Section: ${section.title}`, `Purpose: ${section.purpose}`, `Audience: ${brief.audience}`];
  let output = '';
  for (const piece of pieces) {
    const remaining = 1536 - Buffer.byteLength(output ? `${output}\n${piece}` : piece, 'utf8');
    if (remaining >= 0) { output = output ? `${output}\n${piece}` : piece; continue; }
    if (remaining <= -Buffer.byteLength(piece, 'utf8')) continue;
    let bounded = '';
    for (const point of [...piece]) {
      const candidate = `${output ? `${output}\n` : ''}${bounded}${point}`;
      if (Buffer.byteLength(candidate, 'utf8') > 1536) break;
      bounded += point;
    }
    if (bounded.trim()) output = output ? `${output}\n${bounded}` : bounded;
    break;
  }
  return output;
}
function requestView(row: RequestRow) {
  const data = parseStageData(row.stageDataJson);
  return { id: row.id, stage: row.stage, errorCategory: row.errorCategory,
    resultRefs: data.articleVersionId ? { articleVersionId: data.articleVersionId,
      ...(data.sourceEvidenceSetId ? { sourceEvidenceSetId: data.sourceEvidenceSetId } : {}) }
      : data.sourceEvidenceSetId ? { sourceEvidenceSetId: data.sourceEvidenceSetId } : undefined,
    revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/** Coordinates exact evidence retrieval and section jobs for an approved outline. */
export class SourceArticlePreparationService {
  private readonly logger = new Logger(SourceArticlePreparationService.name);
  private readonly grounding: SourceGroundingService;
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly evidence: SourceEvidenceService,
    private readonly facts: FactualBasisService, private readonly articles: ArticleService,
    private readonly env: Record<string, string | undefined> = process.env) { this.grounding = new SourceGroundingService(); }

  private async lockProject(tx: Prisma.TransactionClient, userId: string, projectId: string, effects = true): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
      WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
        AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL
      FOR UPDATE OF p FOR SHARE OF w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
    if (effects) await this.jobs.assertEffects(tx, projectId, userId);
  }

  private async currentInputs(tx: Prisma.TransactionClient, userId: string, projectId: string) {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    if (!project.formats.includes('ARTICLE')) throw new ConflictException('Select Article before preparing a source article');
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: { include: {
      requiredClaims: true, contextSnapshots: { include: { snapshot: true } }, style: true } } } });
    const current = brief?.currentRevision;
    if (!current || current.contentMode !== 'FACTUAL') throw new ConflictException('Save a factual brief before preparing a source article');
    if (current.requiredClaims.length) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    if (current.workspaceStyleRevision !== project.workspace.styleRevision || current.workspaceId !== project.workspaceId
      || canonicalBriefHash(current) !== current.sha256) throw new ConflictException('Brief or workspace style changed; save a new brief revision');
    const outline = await tx.outline.findUnique({ where: { projectId }, include: { currentApprovedRevision: true, currentRevision: true } });
    const approved = outline?.currentApprovedRevision;
    if (!outline || !approved || !approved.approvedAt || approved.withdrawnAt || approved.contentMode !== 'FACTUAL'
      || !approved.sourceEvidenceSetId || !approved.sourceEvidenceSealed || outline.currentRevisionId !== approved.id
      || outline.currentApprovedRevisionId !== approved.id || approved.briefRevisionId !== current.id
      || canonicalManifestHash(approved.content) !== approved.sha256) {
      throw new ConflictException('Approve the current factual outline before preparing a source article');
    }
    await this.grounding.inspectSet(tx, projectId, approved.sourceEvidenceSetId, current.id, true);
    const parsedOutline = outlineContentSchema.parse(approved.content);
    if (parsedOutline.sections.length > 30) throw new ConflictException('OUTLINE_SECTION_LIMIT');
    const snapshots = await tx.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE', currentSnapshotId: { not: null } },
      orderBy: [{ id: 'asc' }], select: { id: true, label: true, currentSnapshotId: true,
        currentSnapshot: { select: { id: true, sha256: true, sequence: true, materialId: true } } } });
    if (!snapshots.length || snapshots.some(row => !row.currentSnapshot)) throw new ConflictException('Add at least one included factual source');
    const frozenSnapshots: FrozenSnapshot[] = snapshots.map(row => ({ snapshotId: row.currentSnapshot!.id, sha256: row.currentSnapshot!.sha256,
      materialId: row.id, sequence: row.currentSnapshot!.sequence, label: row.label }));
    const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { externalProcessingAcceptedAt: true,
      externalProcessingNoticeVersion: true } });
    if (!profile.externalProcessingAcceptedAt || profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) {
      throw new ConflictException('Accept the current external-processing notice before preparing a source article');
    }
    const article = await tx.article.findUnique({ where: { projectId }, select: { revision: true } });
    let normalizedOutline: ReturnType<typeof sourceOutlineSections>;
    try { normalizedOutline = sourceOutlineSections(approved.id, approved.content, current.targetLength); }
    catch { throw new ConflictException('OUTLINE_WORD_ALLOCATION_INVALID'); }
    const sections: FrozenSection[] = normalizedOutline.sections.map((section, index) => ({ ...section,
      claimRevisionIds: [...parsedOutline.sections[index]!.claimRevisionIds] }));
    if (new Set(sections.map(section => section.id)).size !== sections.length) throw new ConflictException('OUTLINE_SECTION_ID_DUPLICATE');
    const outlineClaims = new Set(sections.flatMap(section => section.claimRevisionIds));
    if (outlineClaims.size) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    const style = current.style;
    const frozenBrief: FrozenBrief = { id: current.id, hash: current.sha256, contentMode: 'FACTUAL', topic: current.topic,
      audience: current.audience, centralMessage: current.centralMessage, category: current.category, tone: current.tone,
      targetLength: current.targetLength, cta: current.cta, exclusions: current.exclusions as string[], notes: current.notes,
      workspaceId: current.workspaceId, workspaceStyleRevision: current.workspaceStyleRevision,
      style: { brandbook: style.brandbook, tone: style.tone, settings: JSON.parse(JSON.stringify(style.settings)) as unknown } };
    const context: FrozenContext[] = current.contextSnapshots.map(row => {
      if (!['NOTES', 'BRANDBOOK', 'STYLE_SAMPLE'].includes(row.capturedPurpose)) throw new ConflictException('Invalid selected writing context purpose');
      if (sha256Text(row.snapshot.normalizedText) !== row.snapshot.sha256) throw new ConflictException('A selected context source changed');
      return { snapshotId: row.snapshotId, purpose: row.capturedPurpose as FrozenContext['purpose'], sha256: row.snapshot.sha256,
        text: row.snapshot.normalizedText };
    }).sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    const outlineData = { title: normalizedOutline.title, sections };
    return { project, articleRevision: article?.revision ?? 0, brief: frozenBrief, context, snapshots: frozenSnapshots,
      outlineRevisionId: approved.id, outlineHash: approved.sha256, outline: outlineData,
      acceptedAt: profile.externalProcessingAcceptedAt.toISOString() };
  }

  async prepareArticle(userId: string, projectId: string, input: { commandKey: string; expectedRevision: number }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.commandKey)
      || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new ConflictException('Invalid source article preparation command');
    const existing = await this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId);
      return tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "commandKey"=${input.commandKey} FOR UPDATE`;
    });
    if (existing[0]) {
      if (existing[0].task !== 'ARTICLE') throw new ConflictException('Command key already belongs to another source-writing task');
      return requestView(existing[0]);
    }
    const { sourceWritingWorkflowRelease } = await import('./writing-provider.js');
    const release = sourceWritingWorkflowRelease(this.env);
    return this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId + 'source-writing' + input.commandKey},0))::text`;
      const replay = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "commandKey"=${input.commandKey} FOR UPDATE`;
      if (replay[0]) {
        if (replay[0].task !== 'ARTICLE') throw new ConflictException('Command key already belongs to another source-writing task');
        return requestView(replay[0]);
      }
      const frozen = await this.currentInputs(tx, userId, projectId);
      if (frozen.articleRevision !== input.expectedRevision) throw new ConflictException('Article changed; reload before generating');
      const manifest: RequestInput = { schemaVersion: 'source-writing-request-v1', commandKey: input.commandKey, task: 'ARTICLE',
        brief: frozen.brief, context: frozen.context, snapshots: frozen.snapshots, outlineRevisionId: frozen.outlineRevisionId,
        outlineHash: frozen.outlineHash, outline: frozen.outline, expectedArticleRevision: input.expectedRevision,
        release, noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: frozen.acceptedAt };
      const writingOutline = { title: frozen.outline.title, sections: frozen.outline.sections.map(({ id, title, purpose, targetWords }) => ({ id, title, purpose, targetWords })) };
      const first = frozen.outline.sections[0];
      const initial = { schemaVersion: 'source-writing-input-v1', requestId: randomUUID(), task: 'SECTION', brief: briefForWriting(frozen.brief),
        style: frozen.brief.style, context: frozen.context, section: first ? { id: first.id, title: first.title, purpose: first.purpose,
          targetWords: first.targetWords } : undefined, approvedOutline: writingOutline,
        passages: [], requiredClaims: [] };
      if (Buffer.byteLength(JSON.stringify(initial), 'utf8') > MAX_WRITING_INPUT_BYTES) throw new ConflictException('INPUT_TOO_LARGE');
      const id = randomUUID(), now = new Date(), inputHash = canonicalManifestHash(manifest);
      const stageData: StageData = { sections: frozen.outline.sections.map(section => ({ ...section })) };
      const rows = await tx.$queryRaw<RequestRow[]>`INSERT INTO contextflow."SourceWritingRequest"
        ("id","projectId","requestedBy","commandKey","task","stage","inputManifestJson","inputHash","stageDataJson","revision","createdAt","updatedAt","nextCheckAt")
        VALUES (${id}::uuid,${projectId}::uuid,${userId}::uuid,${input.commandKey},'ARTICLE','INDEXING',${JSON.stringify(manifest)}::jsonb,
          ${inputHash},${JSON.stringify(stageData)}::jsonb,1,${now},${now},${now}) RETURNING *`;
      return requestView(rows[0]!);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  async get(userId: string, projectId: string, requestId: string) {
    return this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId, false);
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "task"='ARTICLE'`;
      if (!rows[0]) throw new NotFoundException('Source article request not found');
      return requestView(rows[0]);
    });
  }

  async cancel(userId: string, projectId: string, requestId: string) {
    const row = await this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId);
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "task"='ARTICLE' FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new NotFoundException('Source article request not found');
      if (!['INDEXING','SEARCHING','READY','GENERATING'].includes(current.stage)) return current;
      const changed = await tx.$queryRaw<RequestRow[]>`UPDATE contextflow."SourceWritingRequest" SET "stage"='CANCELLED',
        "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "revision"=${current.revision} RETURNING *`;
      return changed[0] ?? current;
    });
    const data = parseStageData(row.stageDataJson);
    if (row.stage === 'CANCELLED') await this.cancelOwnedChildren(projectId, row.requestedBy, this.childRefs(row.id, data));
    return requestView(row);
  }

  async pollOnce(): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ projectId: string; id: string }>>`SELECT "projectId"::text,"id"::text
      FROM contextflow."SourceWritingRequest" WHERE "task"='ARTICLE' AND "stage" IN ('INDEXING','SEARCHING','READY','GENERATING')
        AND ("nextCheckAt" IS NULL OR "nextCheckAt"<=CURRENT_TIMESTAMP) ORDER BY "nextCheckAt" NULLS FIRST,"createdAt" LIMIT ${MAX_PER_TICK}`;
    for (const row of rows) {
      try { await this.advance(row.projectId, row.id, new Date()); }
      catch (error) { this.logger.error('Source article preparation step failed'); await this.fail(row.projectId, row.id, error); }
    }
  }

  private async claim(projectId: string, requestId: string, now: Date): Promise<Claimed | null> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid FOR UPDATE`;
      const request = rows[0];
      if (!request || request.task !== 'ARTICLE' || !['INDEXING','SEARCHING','READY','GENERATING'].includes(request.stage)
        || request.nextCheckAt && request.nextCheckAt > now) return null;
      const input = parseRequest(request);
      await this.lockProject(tx, request.requestedBy, projectId);
      await this.assertFrozenCurrent(tx, projectId, input);
      const claimed = await tx.$queryRaw<RequestRow[]>`UPDATE contextflow."SourceWritingRequest" SET "nextCheckAt"=${new Date(now.getTime() + CHECK_LEASE_MS)},
        "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid
        AND "revision"=${request.revision} RETURNING *`;
      if (!claimed[0]) return null;
      return { request: claimed[0], input, data: parseStageData(claimed[0].stageDataJson) };
    }, { maxWait: 5_000, timeout: 10_000 });
  }

  private async advance(projectId: string, requestId: string, now: Date): Promise<void> {
    const claimed = await this.claim(projectId, requestId, now);
    if (!claimed) return;
    const { request, input, data } = claimed;
    if (request.stage === 'INDEXING') {
      if (!data.indexJobIds) {
        const indexInput: IndexSourceEvidenceInput = { commandKey: stableUuid(`${request.id}:index`), snapshotIds: input.snapshots.map(row => row.snapshotId) };
        const result = await this.evidence.index(request.requestedBy, projectId, indexInput);
        const refs = result.jobs.map(job => ({ id: job.id, operation: 'SOURCE_EMBEDDING', manifestCommandKey: stableUuid(`${request.id}:index`) }));
        await this.update(request, 'INDEXING', { ...data, indexJobIds: result.jobs.map(job => job.id) });
        await this.cancelChildrenIfTerminal(projectId, request.id, request.requestedBy, refs);
        return;
      }
      const jobs = await this.jobsFor(projectId, data.indexJobIds);
      if (jobs.length !== data.indexJobIds.length) { await this.failCategory(request, 'INDEX_JOB_MISSING'); return; }
      if (jobs.some(job => !TERMINAL.has(job.status))) { await this.defer(request); return; }
      if (jobs.some(job => job.status !== 'SUCCEEDED')) { await this.failCategory(request, jobs.find(job => job.status !== 'SUCCEEDED')?.errorCategory ?? 'INDEX_FAILED'); return; }
      await this.update(request, 'SEARCHING', data); return;
    }
    if (request.stage === 'SEARCHING') {
      let submitted = false;
      for (const section of data.sections) {
        if (section.searchJobId) continue;
        const searchInput: SearchSourceEvidenceInput = { commandKey: stableUuid(`${request.id}:search:${section.id}`),
          snapshotIds: input.snapshots.map(row => row.snapshotId), query: queryForSection(input.brief, section) };
        const result = await this.evidence.search(request.requestedBy, projectId, searchInput);
        const updated = data.sections.map(item => item.id === section.id ? { ...item, searchJobId: result.job.id } : item);
        const refs = [{ id: result.job.id, operation: 'EVIDENCE_SEARCH', commandKey: searchInput.commandKey }];
        await this.update(request, 'SEARCHING', { ...data, sections: updated });
        await this.cancelChildrenIfTerminal(projectId, request.id, request.requestedBy, refs);
        submitted = true; break; // One provider submission per tick keeps the durable queue bounded.
      }
      if (submitted) return;
      const packetIds: string[] = [];
      const sections: SectionStage[] = [];
      for (const section of data.sections) {
        if (!section.searchJobId) { await this.failCategory(request, 'SEARCH_JOB_MISSING'); return; }
        const resolved = await this.evidence.resolveSearchJob(projectId, section.searchJobId);
        const job = resolved.job;
        if (!TERMINAL.has(job.status)) { await this.defer(request); return; }
        if (job.status !== 'SUCCEEDED') { await this.failCategory(request, job.errorCategory ?? 'SEARCH_FAILED'); return; }
        if (!resolved.packetId) { await this.failCategory(request, 'SEARCH_PACKET_MISSING'); return; }
        packetIds.push(resolved.packetId); sections.push({ ...section, packetId: resolved.packetId });
      }
      const uniquePacketIds = [...new Set(packetIds)];
      const set = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
        await this.lockProject(tx, request.requestedBy, projectId);
        await this.assertFrozenCurrent(tx, projectId, input);
        const packetCounts = await tx.$queryRaw<Array<{ packetId: string; passageCount: number; sha256: string; manifestJson: unknown; status: string }>>`SELECT p."id"::text AS "packetId",
            count(i."spanId")::int AS "passageCount",p."sha256",p."manifestJson",j."status"::text AS "status"
          FROM contextflow."SourceEvidencePacket" p LEFT JOIN contextflow."SourceEvidencePacketItem" i
            ON i."projectId"=p."projectId" AND i."packetId"=p."id"
          JOIN contextflow."Job" j ON j."projectId"=p."projectId" AND j."id"=p."jobId"
          WHERE p."projectId"=${projectId}::uuid AND p."id"=ANY(${uniquePacketIds}::uuid[])
          GROUP BY p."id",j."status"`;
        if (packetCounts.length !== uniquePacketIds.length) throw new ConflictException('SEARCH_PACKET_MISSING');
        if (packetCounts.some(packet => packet.status !== 'SUCCEEDED' || canonicalManifestHash(packet.manifestJson) !== packet.sha256)) {
          throw new ConflictException('SEARCH_PACKET_INVALID');
        }
        if (packetCounts.every(packet => packet.passageCount === 0)) {
          throw new ConflictException('NO_RELEVANT_SOURCE_EVIDENCE');
        }
        const sectionWithoutPassages = sections.some(section => packetCounts.find(packet => packet.packetId === section.packetId)?.passageCount === 0
          && !section.claimRevisionIds.length);
        if (sectionWithoutPassages) throw new ConflictException('NO_RELEVANT_SOURCE_EVIDENCE');
        return this.grounding.createSet(tx, projectId, request.requestedBy, input.brief.id, uniquePacketIds);
      }, { maxWait: 5_000, timeout: 20_000 });
      await this.update(request, 'READY', { ...data, sections, sourceEvidenceSetId: set.id, sourceEvidenceSetHash: set.sha256 }); return;
    }
    if (request.stage === 'READY') { await this.enqueueSections(projectId, request, input, data); return; }
    if (request.stage === 'GENERATING') {
      const jobs = await this.jobsFor(projectId, data.sections.map(section => section.writingJobId).filter((id): id is string => !!id));
      if (jobs.length !== data.sections.length || data.sections.some(section => !section.writingJobId)) { await this.failCategory(request, 'WRITING_JOB_MISSING'); return; }
      if (jobs.some(job => !TERMINAL.has(job.status))) { await this.defer(request); return; }
      const byId = new Map(jobs.map(job => [job.id, job]));
      if (jobs.some(job => job.status !== 'SUCCEEDED')) { await this.failCategory(request, jobs.find(job => job.status !== 'SUCCEEDED')?.errorCategory ?? 'WRITING_FAILED'); return; }
      const completed: Array<{ input: SourceWritingInput; output: unknown }> = [];
      const updatedSections: SectionStage[] = [];
      try {
        for (const section of data.sections) {
          const job = byId.get(section.writingJobId!)!;
          const refs = job.resultRefs as { output?: unknown; outputHash?: unknown; content?: unknown; executionId?: unknown; review?: unknown } | null;
          const manifest = job.inputManifest as { schemaVersion?: unknown; requestId?: unknown; task?: unknown; briefRevisionId?: unknown;
            briefHash?: unknown; workspaceId?: unknown; workspaceStyleRevision?: unknown; expectedRevision?: unknown; outlineRevisionId?: unknown;
            outlineHash?: unknown; sectionIndex?: unknown; packetId?: unknown; sourceEvidenceSetId?: unknown; setHash?: unknown;
            request?: unknown; release?: unknown; noticeVersion?: unknown; acceptedAt?: unknown } | null;
          const sectionInput = sourceWritingInputSchema.parse(manifest?.request);
          if (!refs || typeof refs.executionId !== 'string' || sectionInput.task !== 'SECTION' || sectionInput.section?.id !== section.id
            || job.operation !== 'SOURCE_WRITING' || job.contractVersion !== 'source-writing-v1'
            || job.inputHash !== canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest })
            || manifest?.schemaVersion !== 'source-writing-job-v1' || manifest.requestId !== request.id || manifest.task !== 'SECTION'
            || manifest.briefRevisionId !== input.brief.id || manifest.briefHash !== input.brief.hash || manifest.workspaceId !== input.brief.workspaceId
            || manifest.workspaceStyleRevision !== input.brief.workspaceStyleRevision || manifest.expectedRevision !== input.expectedArticleRevision
            || manifest.outlineRevisionId !== input.outlineRevisionId || manifest.outlineHash !== input.outlineHash
            || manifest.sectionIndex !== input.outline.sections.findIndex(item => item.id === section.id) || manifest.packetId !== section.packetId
            || manifest.sourceEvidenceSetId !== data.sourceEvidenceSetId || manifest.setHash !== data.sourceEvidenceSetHash
            || canonicalManifestHash(manifest.release) !== canonicalManifestHash(input.release)
            || manifest.noticeVersion !== input.noticeVersion || manifest.acceptedAt !== input.acceptedAt
            || !section.writingInputHash || canonicalManifestHash(sectionInput) !== section.writingInputHash) {
            throw new ConflictException('SECTION_RESULT_INVALID');
          }
          const output = validateSourceWritingOutput(refs.output, sectionInput);
          if (output.status !== 'ready' || !output.content || canonicalManifestHash(refs.content) !== canonicalManifestHash(output.content)
            || canonicalManifestHash(refs.review) !== canonicalManifestHash(output.review)
            || typeof refs.outputHash !== 'string' || canonicalManifestHash(output) !== refs.outputHash) throw new ConflictException('SECTION_RESULT_NOT_READY');
          completed.push({ input: sectionInput, output });
          updatedSections.push({ ...section, output, outputHash: refs.outputHash, executionId: refs.executionId });
        }
      } catch (error) { await this.failCategory(request, error instanceof ConflictException ? error.message : 'SECTION_RESULT_INVALID'); return; }
      const content = assembleSourceArticle(input.outline.title, completed);
      await this.appendArticle(projectId, request, input, data, content, updatedSections); return;
    }
  }

  private async enqueueSections(projectId: string, request: RequestRow, input: RequestInput, data: StageData): Promise<void> {
    if (!data.sourceEvidenceSetId || !data.sourceEvidenceSetHash) throw new ConflictException('Frozen source evidence set is missing');
    const { sourceWritingWorkflowRelease } = await import('./writing-provider.js');
    const release = sourceWritingWorkflowRelease(this.env);
    if (canonicalManifestHash(release) !== canonicalManifestHash(input.release)) throw new ConflictException('Source writing workflow configuration changed');
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      await this.lockProject(tx, request.requestedBy, projectId);
      await this.assertFrozenCurrent(tx, projectId, input);
      const set = await this.grounding.inspectSet(tx, projectId, data.sourceEvidenceSetId!, input.brief.id, true);
      if (set.sha256 !== data.sourceEvidenceSetHash) throw new ConflictException('Frozen source evidence set changed');
      const outline = await tx.outline.findUnique({ where: { projectId }, include: { currentApprovedRevision: true, currentRevision: true } });
      if (!outline?.currentApprovedRevision || outline.currentApprovedRevision.id !== input.outlineRevisionId
        || outline.currentRevisionId !== input.outlineRevisionId || outline.currentApprovedRevision.sha256 !== input.outlineHash) {
        throw new ConflictException('Approved outline changed while evidence was prepared');
      }
      const row = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid FOR UPDATE`;
      if (!row[0] || row[0].revision !== request.revision || row[0].stage !== 'READY') throw new ConflictException('Source article request changed before generation');
      const requiredById = new Map(set.requiredClaims.map(claim => [claim.claimRevisionId, claim]));
      const sections: SectionStage[] = [];
      for (const section of data.sections) {
        const packetId = section.packetId;
        if (!packetId) throw new ConflictException('SECTION_PACKET_MISSING');
        const passages = set.passages.filter(passage => passage.packetId === packetId)
          .map(row => ({ id: row.id, packetId: row.packetId, snapshotId: row.snapshotId, quote: row.quote }));
        const requiredClaims = section.claimRevisionIds.map(id => requiredById.get(id)).filter((claim): claim is NonNullable<typeof claim> => !!claim)
          .map(claim => ({ ...claim, evidence: [...claim.evidence] }));
        if (requiredClaims.length !== section.claimRevisionIds.length || requiredClaims.some(claim => claim.evidence.length > 10)) {
          throw new ConflictException('REQUIRED_EVIDENCE_LIMIT');
        }
        if (!passages.length && !requiredClaims.length) throw new ConflictException('SECTION_HAS_NO_SUPPORTING_EVIDENCE');
        const approvedOutline = { title: input.outline.title, sections: input.outline.sections.map(({ id, title, purpose, targetWords }) => ({ id, title, purpose, targetWords })) };
        const writingRequest = sourceWritingInputSchema.parse({ schemaVersion: 'source-writing-input-v1', requestId: request.id, task: 'SECTION',
          brief: briefForWriting(input.brief), style: input.brief.style, context: input.context,
          section: { id: section.id, title: section.title, purpose: section.purpose, targetWords: section.targetWords },
          approvedOutline, passages, requiredClaims });
        if (Buffer.byteLength(JSON.stringify(writingRequest), 'utf8') > MAX_WRITING_INPUT_BYTES) throw new ConflictException('INPUT_TOO_LARGE');
        const manifest = { schemaVersion: 'source-writing-job-v1', requestId: request.id, task: 'SECTION', briefRevisionId: input.brief.id,
          briefHash: input.brief.hash, workspaceId: input.brief.workspaceId, workspaceStyleRevision: input.brief.workspaceStyleRevision,
          expectedRevision: input.expectedArticleRevision, outlineRevisionId: input.outlineRevisionId, outlineHash: input.outlineHash,
          sectionIndex: input.outline.sections.findIndex(item => item.id === section.id), packetId,
          sourceEvidenceSetId: set.id, setHash: set.sha256, request: writingRequest, release: input.release,
          noticeVersion: input.noticeVersion, acceptedAt: input.acceptedAt };
        const job = await this.jobs.create(tx, { projectId, userId: request.requestedBy, operation: 'SOURCE_WRITING',
          contractVersion: 'source-writing-v1', commandKey: `source-writing-${request.id}-${section.id}`, inputManifest: asJson(manifest), deadlineMs: 600_000 });
        sections.push({ ...section, writingJobId: job.id, writingInputHash: canonicalManifestHash(writingRequest) });
      }
      await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stageDataJson"=${JSON.stringify({ ...data, sections })}::jsonb,
        "stage"='GENERATING',"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=CURRENT_TIMESTAMP
        WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid AND "revision"=${request.revision}`;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async appendArticle(projectId: string, request: RequestRow, input: RequestInput, data: StageData, content: ArticleContent,
    sections: SectionStage[]): Promise<void> {
    await this.prisma.$transaction(async tx => {
      await this.$lockCurrent(tx, request.requestedBy, projectId);
      await this.assertFrozenCurrent(tx, projectId, input);
      const row = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid FOR UPDATE`;
      if (!row[0] || row[0].revision !== request.revision || row[0].stage !== 'GENERATING') throw new ConflictException('Source article request changed before commit');
      const jobIds = sections.map(section => section.writingJobId!);
      const jobs = await tx.job.findMany({ where: { projectId, id: { in: jobIds } } });
      if (jobs.length !== sections.length || jobs.some(job => job.status !== 'SUCCEEDED')) throw new ConflictException('SECTION_JOB_CHANGED');
      const outline = await tx.outlineRevision.findFirst({ where: { id: input.outlineRevisionId, projectId } });
      if (!outline || outline.sha256 !== input.outlineHash || !outline.approvedAt || outline.withdrawnAt) throw new ConflictException('APPROVED_OUTLINE_CHANGED');
      const sourceInputs: SourceArticleInputs = { briefRevisionId: input.brief.id, basisRevisionId: null,
        sourceEvidenceSetId: data.sourceEvidenceSetId!, outlineRevisionId: input.outlineRevisionId,
        workspaceId: input.brief.workspaceId, workspaceStyleRevision: input.brief.workspaceStyleRevision,
        sourceSnapshotId: null, contentMode: 'FACTUAL', origin: 'AI' };
      const refs = await this.articles.appendSourceCandidate(tx, request.requestedBy, projectId, content, sourceInputs,
        input.expectedArticleRevision, jobIds[0], sections[0]?.executionId);
      const byId = new Map(jobs.map(job => [job.id, job]));
      const assembly = { schemaVersion: 'source-article-assembly-v1', requestId: request.id, requestHash: request.inputHash,
        articleVersionId: refs.articleVersionId, articleHash: canonicalManifestHash(content), outlineRevisionId: input.outlineRevisionId,
        outlineHash: input.outlineHash, sourceEvidenceSetId: data.sourceEvidenceSetId, setHash: data.sourceEvidenceSetHash,
        sections: sections.map((section, ordinal) => {
          const job = byId.get(section.writingJobId!);
          if (!job || !section.executionId || !section.outputHash || section.outputHash !== canonicalManifestHash(section.output)) {
            throw new ConflictException('SECTION_LINEAGE_INVALID');
          }
          return { sectionId: section.id, ordinal, jobId: job.id, executionId: section.executionId,
            inputHash: job.inputHash, outputHash: section.outputHash };
        }) };
      await tx.$executeRaw`INSERT INTO contextflow."SourceArticleAssembly"
        ("projectId","articleVersionId","requestId","manifestJson","sha256","createdAt")
        VALUES (${projectId}::uuid,${refs.articleVersionId}::uuid,${request.id}::uuid,${JSON.stringify(assembly)}::jsonb,
          ${canonicalManifestHash(assembly)},CURRENT_TIMESTAMP)`;
      const lineage = sections.map(({ id, title, purpose, targetWords, claimRevisionIds, writingJobId, writingInputHash, outputHash, executionId }) => ({
        id, title, purpose, targetWords, claimRevisionIds, writingJobId, writingInputHash, outputHash, executionId,
      }));
      const updated = await tx.$queryRaw<RequestRow[]>`UPDATE contextflow."SourceWritingRequest" SET "stageDataJson"=${JSON.stringify({ ...data,
        sections: lineage, articleVersionId: refs.articleVersionId })}::jsonb,"stage"='SUCCEEDED',"revision"="revision"+1,
        "updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid
        AND "revision"=${request.revision} RETURNING *`;
      if (!updated[0]) throw new ConflictException('Source article request changed before commit');
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async $lockCurrent(tx: Prisma.TransactionClient, userId: string, projectId: string): Promise<void> {
    await this.lockProject(tx, userId, projectId);
  }
  private async assertFrozenCurrent(tx: Prisma.TransactionClient, projectId: string, input: RequestInput): Promise<void> {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    if (!project.formats.includes('ARTICLE') || project.workspace.styleRevision !== input.brief.workspaceStyleRevision) {
      throw new ConflictException('Project formats or workspace style changed during source preparation');
    }
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: { include: {
      requiredClaims: true, contextSnapshots: { include: { snapshot: true } }, style: true } } } });
    const current = brief?.currentRevision;
    if (!current || current.id !== input.brief.id || current.sha256 !== input.brief.hash || canonicalBriefHash(current) !== current.sha256
      || current.workspaceId !== input.brief.workspaceId || current.workspaceStyleRevision !== input.brief.workspaceStyleRevision) {
      throw new ConflictException('Brief or workspace style changed during source preparation');
    }
    const contexts = current.contextSnapshots.map(row => ({ snapshotId: row.snapshotId, purpose: row.capturedPurpose }))
      .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    const frozenContexts = input.context.map(row => ({ snapshotId: row.snapshotId, purpose: row.purpose }))
      .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    if (canonicalManifestHash(contexts) !== canonicalManifestHash(frozenContexts)) throw new ConflictException('Selected writing context changed');
    const contextSnapshots = await tx.sourceSnapshot.findMany({ where: { projectId, id: { in: input.context.map(row => row.snapshotId) } },
      select: { id: true, sha256: true, normalizedText: true } });
    if (contextSnapshots.length !== input.context.length || input.context.some(row => {
      const found = contextSnapshots.find(snapshot => snapshot.id === row.snapshotId);
      return !found || found.sha256 !== row.sha256 || sha256Text(found.normalizedText) !== row.sha256 || found.normalizedText !== row.text;
    })) throw new ConflictException('A frozen writing context source changed');
    const materials = await tx.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE', currentSnapshotId: { not: null } },
      select: { id: true, currentSnapshotId: true, currentSnapshot: { select: { id: true, sha256: true, sequence: true } } }, orderBy: { id: 'asc' } });
    const actual: FrozenSnapshot[] = materials.flatMap(row => row.currentSnapshot ? [{ snapshotId: row.currentSnapshot.id, materialId: row.id,
      sequence: row.currentSnapshot.sequence, sha256: row.currentSnapshot.sha256, label: '' }] : []);
    const expected = input.snapshots.map(row => ({ snapshotId: row.snapshotId, materialId: row.materialId, sequence: row.sequence, sha256: row.sha256, label: '' }));
    if (canonicalManifestHash(actual) !== canonicalManifestHash(expected)) throw new ConflictException('Selected factual sources changed during preparation');
    const outline = await tx.outline.findUnique({ where: { projectId }, include: { currentApprovedRevision: true, currentRevision: true } });
    const approved = outline?.currentApprovedRevision;
    if (!approved || approved.id !== input.outlineRevisionId || approved.sha256 !== input.outlineHash || !approved.approvedAt || approved.withdrawnAt
      || outline?.currentRevisionId !== approved.id || outline.currentApprovedRevisionId !== approved.id || approved.briefRevisionId !== current.id
      || canonicalManifestHash(approved.content) !== approved.sha256) throw new ConflictException('Approved outline changed during source preparation');
    const article = await tx.article.findUnique({ where: { projectId }, select: { revision: true } });
    if ((article?.revision ?? 0) !== input.expectedArticleRevision) throw new ConflictException('Article changed during source preparation');
  }

  private async jobsFor(projectId: string, ids: readonly string[]) {
    if (!ids.length) return [] as Job[];
    return this.prisma.job.findMany({ where: { projectId, id: { in: [...ids] } } });
  }
  private async update(request: RequestRow, stage: string, data: StageData): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${request.projectId}::uuid AND "id"=${request.id}::uuid FOR UPDATE`;
      if (!rows[0] || rows[0].revision !== request.revision || rows[0].stage !== request.stage) return false;
      await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stageDataJson"=${JSON.stringify(data)}::jsonb,
        "stage"=${stage},"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=CURRENT_TIMESTAMP
        WHERE "projectId"=${request.projectId}::uuid AND "id"=${request.id}::uuid`;
      return true;
    });
  }
  private async defer(request: RequestRow): Promise<void> {
    await this.prisma.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "nextCheckAt"=${new Date(Date.now() + CHECK_INTERVAL_MS)},
      "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=${request.projectId}::uuid AND "id"=${request.id}::uuid AND "revision"=${request.revision}`;
  }
  private async failCategory(request: RequestRow, category: string): Promise<void> {
    await this.fail(request.projectId, request.id, new ConflictException(category.slice(0,64)));
  }
  private async fail(projectId: string, requestId: string, error: unknown): Promise<void> {
    const message = error instanceof ConflictException ? String(error.message) : '';
    const category = /^[A-Z0-9_-]{1,64}$/u.test(message) ? message : 'PREPARATION_FAILED';
    const failed = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "task"='ARTICLE' FOR UPDATE`;
      const row = rows[0];
      if (!row || !['INDEXING','SEARCHING','READY','GENERATING'].includes(row.stage)) return null;
      await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stage"='FAILED',"errorCategory"=${category},
        "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "revision"=${row.revision}`;
      return row;
    });
    if (!failed) return;
    const data = parseStageData(failed.stageDataJson);
    await this.cancelOwnedChildren(projectId, failed.requestedBy, this.childRefs(failed.id, data));
  }
  private async failClaimed(request: RequestRow, category: string): Promise<void> { await this.failCategory(request, category); }
  private childRefs(requestId: string, data: StageData): ChildRef[] {
    return [
      ...(data.indexJobIds ?? []).map(id => ({ id, operation: 'SOURCE_EMBEDDING', manifestCommandKey: stableUuid(`${requestId}:index`) })),
      ...data.sections.flatMap(section => [
        ...(section.searchJobId ? [{ id: section.searchJobId, operation: 'EVIDENCE_SEARCH', commandKey: stableUuid(`${requestId}:search:${section.id}`) }] : []),
        ...(section.writingJobId ? [{ id: section.writingJobId, operation: 'SOURCE_WRITING', commandKey: `source-writing-${requestId}-${section.id}` }] : []),
      ]),
    ];
  }
  private async cancelOwnedChildren(projectId: string, userId: string, refs: readonly ChildRef[]): Promise<void> {
    for (const ref of refs) {
      try { const job = await this.prisma.job.findFirst({ where: { id: ref.id, projectId } });
        const manifest = job?.inputManifest as { commandKey?: unknown } | null;
        if (job && job.operation === ref.operation && (!ref.commandKey || job.commandKey === ref.commandKey)
          && (!ref.manifestCommandKey || manifest?.commandKey === ref.manifestCommandKey)
          && (!TERMINAL.has(job.status) || job.operation === 'EVIDENCE_SEARCH' && job.contractVersion === 'evidence-search-v2')) {
          await this.jobs.cancel(userId, projectId, ref.id);
        } }
      catch { this.logger.error('Failed to cancel child job after source article request became terminal'); }
    }
  }
  private async cancelChildrenIfTerminal(projectId: string, requestId: string, userId: string, refs: readonly ChildRef[]): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ stage: string }>>`SELECT "stage" FROM contextflow."SourceWritingRequest"
      WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid`;
    if (['FAILED','CANCELLED'].includes(rows[0]?.stage ?? '')) await this.cancelOwnedChildren(projectId, userId, refs);
  }
}

/** Worker lifecycle wrapper; ARTICLE requests are isolated from the outline poller. */
export class SourceArticlePreparationPoller {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly logger = new Logger(SourceArticlePreparationPoller.name);
  constructor(private readonly preparation: SourceArticlePreparationService) {}
  onModuleInit(): void { this.timer = setInterval(() => { void this.tick(); }, CHECK_INTERVAL_MS); this.timer.unref(); }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async tick(): Promise<void> {
    if (this.busy) return; this.busy = true;
    try { await this.preparation.pollOnce(); }
    catch { this.logger.error('Source article preparation poller pass failed; next interval will retry'); }
    finally { this.busy = false; }
  }
}
