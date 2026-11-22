import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { canonicalBriefHash } from '../editorial/editorial.service.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { sha256Text, type IndexSourceEvidenceInput, type SearchSourceEvidenceInput } from './contracts.js';
import { SourceEvidenceService } from './evidence.service.js';
import { SourceGroundingService } from './source-grounding.service.js';
import { adaptationFormatSchema, type AdaptationFormat } from '../editorial/telegram-contracts.js';
import { sourceWritingInputSchema } from './writing-contracts.js';
import { ArticleService } from '../editorial/article.service.js';
import { sourceArticleContext } from './source-article-context.js';
import { FactualBasisService } from '../claims/factual-basis.service.js';

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
type RequestInput = Readonly<{ schemaVersion: 'source-writing-request-v1'; commandKey: string; task: 'OUTLINE' | 'ADAPTATION'; format?: AdaptationFormat; expectedAdaptationRevision?: number;
  inputMode?: 'DIRECT' | 'ARTICLE_DERIVED'; includeLink?: boolean; approvedArticle?: { versionId: string; sha256: string; title: string; text: string }; inheritedSourceEvidenceSetId?: string;
  brief: FrozenBrief; context: readonly FrozenContext[]; snapshots: readonly FrozenSnapshot[]; expectedOutlineRevision: number;
  release: unknown; noticeVersion: string; acceptedAt: string }>;
type StageData = { indexJobIds?: string[]; searchJobId?: string; sourceEvidenceSetId?: string; sourceEvidenceSetHash?: string;
  writingJobId?: string; outlineRevisionId?: string; articleVersionId?: string; adaptationRevisionId?: string;
  sourceStarter?: { topic: string; excerpts: Array<{ label: string; text: string; truncated: boolean }> } };
type RequestRow = { id: string; projectId: string; requestedBy: string; commandKey: string; task: string; stage: string;
  inputManifestJson: unknown; inputHash: string; stageDataJson: unknown; revision: number; errorCategory: string | null;
  createdAt: Date; updatedAt: Date; nextCheckAt: Date | null };
type Claimed = { request: RequestRow; input: RequestInput; data: StageData };

function asJson(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function boundedField(label: string, value: string, maxBytes: number): string {
  const points = [...value.trim()];
  let output = '';
  for (const point of points) {
    if (Buffer.byteLength(`${label}: ${output}${point}`, 'utf8') > maxBytes) break;
    output += point;
  }
  return output ? `${label}: ${output}` : '';
}

function outlineQuery(brief: FrozenBrief): string {
  // Prioritize the actual topic and central message, then use a small amount of
  // audience context. Keep each field explicitly bounded and UTF-8 safe.
  return [boundedField('Topic', brief.topic, 680), boundedField('Central message', brief.centralMessage, 500),
    boundedField('Audience', brief.audience, 190), boundedField('Category', brief.category, 32)].filter(Boolean).join('\n');
}

function toWritingBrief(brief: FrozenBrief) {
  return { topic: brief.topic, audience: brief.audience, centralMessage: brief.centralMessage, category: brief.category,
    tone: brief.tone, targetLength: brief.targetLength, cta: brief.cta, exclusions: brief.exclusions, notes: brief.notes };
}

function parseRequest(row: RequestRow): RequestInput {
  const value = row.inputManifestJson as RequestInput;
  if (!value || value.schemaVersion !== 'source-writing-request-v1' || value.commandKey !== row.commandKey
    || value.task !== row.task || !['OUTLINE','ADAPTATION'].includes(row.task) || canonicalManifestHash(value) !== row.inputHash) {
    throw new ConflictException('Source writing request integrity check failed');
  }
  return value;
}

function parseStageData(value: unknown): StageData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConflictException('Invalid source writing stage state');
  return value as StageData;
}

function requestView(row: RequestRow) {
  const data = parseStageData(row.stageDataJson);
  return { id: row.id, stage: row.stage, errorCategory: row.errorCategory,
    sourceStarter: data.sourceStarter,
    resultRefs: data.outlineRevisionId ? { outlineRevisionId: data.outlineRevisionId,
      ...(data.sourceEvidenceSetId ? { sourceEvidenceSetId: data.sourceEvidenceSetId } : {}) }
      : data.adaptationRevisionId ? { adaptationRevisionId: data.adaptationRevisionId } : data.articleVersionId ? { articleVersionId: data.articleVersionId,
        ...(data.sourceEvidenceSetId ? { sourceEvidenceSetId: data.sourceEvidenceSetId } : {}) }
      : data.sourceEvidenceSetId ? { sourceEvidenceSetId: data.sourceEvidenceSetId } : undefined,
    revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * Freezes task inputs and coordinates indexing → retrieval → a sealed evidence
 * set. It intentionally does not require a completed approved-claims basis.
 * Durable provider work stays in Job rows and is reconciled by the poller.
 */
export class SourcePreparationService {
  private readonly logger = new Logger(SourcePreparationService.name);
  private readonly grounding: SourceGroundingService;
  private readonly articles: ArticleService;
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService, private readonly evidence: SourceEvidenceService,
    private readonly facts: FactualBasisService, private readonly env: Record<string, string | undefined> = process.env) {
    this.grounding = new SourceGroundingService();
    this.articles = new ArticleService(prisma,jobs,facts);
  }

  private async lockProject(tx: Prisma.TransactionClient, userId: string, projectId: string, effects = true): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
      WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
        AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL
      FOR UPDATE OF p FOR SHARE OF w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
    if (effects) await this.jobs.assertEffects(tx, projectId, userId);
  }

  private async currentSourceInputs(tx: Prisma.TransactionClient, userId: string, projectId: string, format: 'ARTICLE' | AdaptationFormat = 'ARTICLE') {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    if (!project.formats.includes(format)) throw new ConflictException('Select Article before generating an outline');
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: { include: {
      requiredClaims: true, contextSnapshots: { include: { snapshot: true } }, style: true } } } });
    const current = brief?.currentRevision;
    if (!current || current.contentMode !== 'FACTUAL') throw new ConflictException('Save a factual brief before preparing source evidence');
    if (current.requiredClaims.length) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    if (current.workspaceStyleRevision !== project.workspace.styleRevision || current.workspaceId !== project.workspaceId
      || canonicalBriefHash(current) !== current.sha256) throw new ConflictException('Brief or workspace style changed; save a new brief revision');
    const materials = await tx.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE', currentSnapshotId: { not: null } },
      orderBy: [{ id: 'asc' }], select: { id: true, label: true, currentSnapshotId: true,
        currentSnapshot: { select: { id: true, sha256: true, sequence: true, materialId: true } } } });
    if (!materials.length || materials.some(row => !row.currentSnapshot)) throw new ConflictException('Add at least one included factual source');
    const snapshots: FrozenSnapshot[] = materials.map(row => ({ snapshotId: row.currentSnapshot!.id, sha256: row.currentSnapshot!.sha256,
      materialId: row.id, sequence: row.currentSnapshot!.sequence, label: row.label }));
    const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { externalProcessingAcceptedAt: true,
      externalProcessingNoticeVersion: true } });
    if (!profile.externalProcessingAcceptedAt || profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) {
      throw new ConflictException('Accept the current external-processing notice before preparing source evidence');
    }
    const style = current.style;
    const frozenBrief: FrozenBrief = { id: current.id, hash: current.sha256, contentMode: 'FACTUAL', topic: current.topic,
      audience: current.audience, centralMessage: current.centralMessage, category: current.category, tone: current.tone,
      targetLength: current.targetLength, cta: current.cta, exclusions: current.exclusions as string[], notes: current.notes,
      workspaceId: current.workspaceId, workspaceStyleRevision: current.workspaceStyleRevision,
      style: { brandbook: style.brandbook, tone: style.tone, settings: JSON.parse(JSON.stringify(style.settings)) as unknown } };
    const context: FrozenContext[] = current.contextSnapshots.map(row => {
      if (!['NOTES', 'BRANDBOOK', 'STYLE_SAMPLE'].includes(row.capturedPurpose)) throw new ConflictException('Invalid selected writing context purpose');
      if (sha256Text(row.snapshot.normalizedText) !== row.snapshot.sha256) throw new ConflictException('A selected context source changed');
      return { snapshotId: row.snapshotId, purpose: row.capturedPurpose as FrozenContext['purpose'], sha256: row.snapshot.sha256, text: row.snapshot.normalizedText };
    }).sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    return { project, brief: frozenBrief, context, snapshots, acceptedAt: profile.externalProcessingAcceptedAt.toISOString() };
  }

  prepareOutline(userId: string,projectId: string,input: { commandKey: string }) { return this.prepare(userId,projectId,input); }
  prepareAdaptation(userId: string,projectId: string,input: { commandKey: string; format: AdaptationFormat; expectedRevision: number; inputMode?: 'DIRECT' | 'ARTICLE_DERIVED'; includeLink?: boolean }) {
    if (input.includeLink && input.format !== 'TELEGRAM_POST') throw new ConflictException('Only Telegram supports a link placeholder');
    if (input.inputMode !== undefined && !['DIRECT','ARTICLE_DERIVED'].includes(input.inputMode)) throw new ConflictException('Invalid channel input mode');
    return this.prepare(userId,projectId,input,{ format: adaptationFormatSchema.parse(input.format),expectedRevision: input.expectedRevision,inputMode: input.inputMode ?? 'DIRECT',includeLink: input.includeLink ?? false });
  }
  private async prepare(userId: string, projectId: string, input: { commandKey: string }, channel?: { format: AdaptationFormat; expectedRevision: number; inputMode: 'DIRECT' | 'ARTICLE_DERIVED'; includeLink: boolean }) {
    const task = channel ? 'ADAPTATION' : 'OUTLINE';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.commandKey)) {
      throw new ConflictException('Invalid source preparation command key');
    }
    const existing = await this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId);
      return tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "commandKey"=${input.commandKey} FOR UPDATE`;
    });
    if (existing[0]) {
      if (!this.matchesCommand(existing[0],task,channel)) throw new ConflictException('Command key already belongs to another source-writing task');
      return requestView(existing[0]);
    }

    // Capture the writing release before accepting a request; the helper is
    // supplied by the source-writing provider module in the R7 integration.
    const { sourceWritingWorkflowRelease } = await import('./writing-provider.js');
    const release = sourceWritingWorkflowRelease(this.env);
    return this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId + 'source-writing' + input.commandKey},0))::text`;
      const replay = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "commandKey"=${input.commandKey} FOR UPDATE`;
      if (replay[0]) {
        if (!this.matchesCommand(replay[0],task,channel)) throw new ConflictException('Command key already belongs to another source-writing task');
        return requestView(replay[0]);
      }
      const frozen = await this.currentSourceInputs(tx, userId, projectId,channel?.format ?? 'ARTICLE');
      const outline = await tx.outline.findUnique({ where: { projectId }, select: { revision: true } });
      if (channel) { const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId,format: channel.format } }, select: { revision: true } }); if ((adaptation?.revision ?? 0) !== channel.expectedRevision) throw new ConflictException('Channel draft changed before generation'); }
      const parent = channel?.inputMode === 'ARTICLE_DERIVED' ? await sourceArticleContext(tx,projectId,this.articles) : null;
      if (parent && parent.briefRevisionId !== frozen.brief.id) throw new ConflictException('Article and channel need the same current Brief');
      const manifest: RequestInput = { schemaVersion: 'source-writing-request-v1', commandKey: input.commandKey, task, ...(channel ? { format: channel.format,expectedAdaptationRevision: channel.expectedRevision,inputMode: channel.inputMode,includeLink: channel.includeLink } : {}),
        ...(parent ? { approvedArticle: parent.approvedArticle,inheritedSourceEvidenceSetId: parent.sourceEvidenceSetId } : {}),
        brief: frozen.brief, context: frozen.context, snapshots: frozen.snapshots, expectedOutlineRevision: outline?.revision ?? 0,
        release, noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: frozen.acceptedAt };
      const boundedBase = { schemaVersion: 'source-writing-input-v1', requestId: randomUUID(), task,
        ...(parent ? { approvedArticle: parent.approvedArticle } : {}),
        brief: toWritingBrief(frozen.brief), style: frozen.brief.style, context: frozen.context, passages: [], requiredClaims: [] };
      if (Buffer.byteLength(JSON.stringify(boundedBase), 'utf8') > MAX_WRITING_INPUT_BYTES) throw new ConflictException('INPUT_TOO_LARGE');
      const id = randomUUID(), now = new Date(), inputHash = canonicalManifestHash(manifest);
      const rows = await tx.$queryRaw<RequestRow[]>`INSERT INTO contextflow."SourceWritingRequest"
        ("id","projectId","requestedBy","commandKey","task","stage","inputManifestJson","inputHash","stageDataJson","revision","createdAt","updatedAt","nextCheckAt")
        VALUES (${id}::uuid,${projectId}::uuid,${userId}::uuid,${input.commandKey},${task},'INDEXING',${JSON.stringify(manifest)}::jsonb,
          ${inputHash},'{}'::jsonb,1,${now},${now},${now}) RETURNING *`;
      return requestView(rows[0]!);
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private matchesCommand(row: RequestRow,task: string,channel?: { format: AdaptationFormat; expectedRevision: number; inputMode: 'DIRECT' | 'ARTICLE_DERIVED'; includeLink: boolean }) {
    const saved = parseRequest(row);
    return saved.task === task && (!channel || saved.format === channel.format && saved.expectedAdaptationRevision === channel.expectedRevision
      && (saved.inputMode ?? 'DIRECT') === channel.inputMode && (saved.includeLink ?? false) === channel.includeLink);
  }

  async get(userId: string, projectId: string, requestId: string) {
    return this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId, false);
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "task" IN ('OUTLINE','ADAPTATION')`;
      if (!rows[0]) throw new NotFoundException('Source writing request not found');
      return requestView(rows[0]);
    });
  }

  async cancel(userId: string, projectId: string, requestId: string) {
    const result = await this.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId, false);
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "task" IN ('OUTLINE','ADAPTATION') FOR UPDATE`;
      if (!rows[0]) throw new NotFoundException('Source writing request not found');
      const current = rows[0];
      const shouldCancel = !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(current.stage);
      if (shouldCancel) {
        await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stage"='CANCELLED',"errorCategory"='CANCELLED',
          "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL
          WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid`;
      }
      return { current, shouldCancel };
    });
    const data = parseStageData(result.current.stageDataJson);
    if (result.shouldCancel) await this.cancelOwnedChildren(projectId, userId, requestId, data);
    return this.get(userId, projectId, requestId);
  }

  /** A single poller pass; safe for concurrent processes through row locks and leases. */
  async pollOnce(now = new Date()): Promise<void> {
    const due = await this.prisma.$queryRaw<Array<{ id: string; projectId: string }>>`SELECT "id"::text,"projectId"::text
      FROM contextflow."SourceWritingRequest" WHERE "task" IN ('OUTLINE','ADAPTATION') AND "stage" IN ('INDEXING','SEARCHING','READY','GENERATING')
        AND ("nextCheckAt" IS NULL OR "nextCheckAt"<=${now}) ORDER BY "nextCheckAt" NULLS FIRST,"createdAt","id" LIMIT ${MAX_PER_TICK}`;
    for (const candidate of due) {
      try { await this.advance(candidate.projectId, candidate.id, now); }
      catch (error) {
        try { await this.fail(candidate.projectId, candidate.id, error); }
        catch { this.logger.error('Failed to persist source preparation failure'); }
        this.logger.error('Source preparation request failed during a poller step');
      }
    }
  }

  private async claim(projectId: string, requestId: string, now: Date): Promise<Claimed | null> {
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      const rows = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid FOR UPDATE`;
      const request = rows[0];
      if (!request || !['OUTLINE','ADAPTATION'].includes(request.task) || !['INDEXING','SEARCHING','READY','GENERATING'].includes(request.stage)
        || request.nextCheckAt && request.nextCheckAt > now) return null;
      try { await this.jobs.assertEffects(tx, projectId, request.requestedBy); }
      catch { await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stage"='FAILED',"errorCategory"='ACCESS_REVOKED',
        "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL WHERE "id"=${requestId}::uuid`; return null; }
      const input = parseRequest(request);
      if (request.stage !== 'GENERATING') await this.assertFrozenCurrent(tx, projectId, input);
      const claimed = await tx.$queryRaw<RequestRow[]>`UPDATE contextflow."SourceWritingRequest" SET "nextCheckAt"=${new Date(now.getTime() + CHECK_LEASE_MS)},
        "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid
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
      if (input.inheritedSourceEvidenceSetId) {
        const set = await this.prisma.$transaction(tx => this.grounding.inspectSet(tx,projectId,input.inheritedSourceEvidenceSetId!,input.brief.id,true));
        // Keep the legal state transition; no re-indexing or unrelated source search for a derived post.
        await this.updateStage(request,'SEARCHING',{ ...data,sourceEvidenceSetId: set.id,sourceEvidenceSetHash: set.sha256 });
        return;
      }
      if (!data.indexJobIds) {
        const input: IndexSourceEvidenceInput = { commandKey: stableUuid(`${request.id}:index`), snapshotIds: requestManifestSnapshots(claimed.input) };
        const result = await this.evidence.index(request.requestedBy, projectId, input);
        const refs = result.jobs.map(job => ({ id: job.id, operation: 'SOURCE_EMBEDDING', manifestCommandKey: stableUuid(`${request.id}:index`) }));
        await this.updateStage(request, 'INDEXING', { ...data, indexJobIds: result.jobs.map(job => job.id) });
        await this.cancelChildrenIfTerminal(projectId, request.id, request.requestedBy, refs);
        return;
      }
      const jobs = await this.jobsFor(projectId, data.indexJobIds);
      if (jobs.length !== data.indexJobIds.length) { await this.failCategory(request, 'INDEX_JOB_MISSING'); return; }
      if (jobs.some(job => !TERMINAL.has(job.status))) { await this.defer(request); return; }
      if (jobs.some(job => job.status !== 'SUCCEEDED')) { await this.failCategory(request, jobs.find(job => job.status !== 'SUCCEEDED')?.errorCategory ?? 'INDEX_FAILED'); return; }
      await this.updateStage(request, 'SEARCHING', data);
      return;
    }
    if (request.stage === 'SEARCHING') {
      if (input.inheritedSourceEvidenceSetId && data.sourceEvidenceSetId === input.inheritedSourceEvidenceSetId) {
        await this.updateStage(request,'READY',data); return;
      }
      if (!data.searchJobId) {
        const query = outlineQuery(input.brief);
        const searchInput: SearchSourceEvidenceInput = { commandKey: stableUuid(`${request.id}:search`),
          snapshotIds: requestManifestSnapshots(input), query };
        const result = await this.evidence.search(request.requestedBy, projectId, searchInput);
        const refs = [{ id: result.job.id, operation: 'EVIDENCE_SEARCH', commandKey: searchInput.commandKey }];
        await this.updateStage(request, 'SEARCHING', { ...data, searchJobId: result.job.id });
        await this.cancelChildrenIfTerminal(projectId, request.id, request.requestedBy, refs);
        return;
      }
      const resolved = await this.evidence.resolveSearchJob(projectId, data.searchJobId);
      const job = resolved.job;
      if (!TERMINAL.has(job.status)) { await this.defer(request); return; }
      if (job.status !== 'SUCCEEDED') { await this.failCategory(request, job.errorCategory ?? 'SEARCH_FAILED'); return; }
      const packetId = resolved.packetId;
      if (!packetId) { await this.failCategory(request, 'SEARCH_PACKET_MISSING'); return; }
      const set = await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
        await this.jobs.assertEffects(tx, projectId, request.requestedBy);
        await this.assertFrozenCurrent(tx, projectId, input);
        const packets = await tx.$queryRaw<Array<{ packetId: string; passageCount: number; sha256: string; manifestJson: unknown; status: string }>>`SELECT p."id"::text AS "packetId",
            count(i."spanId")::int AS "passageCount",p."sha256",p."manifestJson",j."status"::text AS "status"
          FROM contextflow."SourceEvidencePacket" p LEFT JOIN contextflow."SourceEvidencePacketItem" i
            ON i."projectId"=p."projectId" AND i."packetId"=p."id"
          JOIN contextflow."Job" j ON j."projectId"=p."projectId" AND j."id"=p."jobId"
          WHERE p."projectId"=${projectId}::uuid AND p."id"=${packetId}::uuid
          GROUP BY p."id",j."status"`;
        if (!packets.length) throw new ConflictException('SEARCH_PACKET_MISSING');
        if (packets[0]!.status !== 'SUCCEEDED' || canonicalManifestHash(packets[0]!.manifestJson) !== packets[0]!.sha256) {
          throw new ConflictException('SEARCH_PACKET_INVALID');
        }
        if (packets[0]!.passageCount === 0) throw new ConflictException('NO_RELEVANT_SOURCE_EVIDENCE');
        return this.grounding.createSet(tx, projectId, request.requestedBy, input.brief.id, [packetId]);
      }, { maxWait: 5_000, timeout: 20_000 });
      await this.updateStage(request, 'READY', { ...data, sourceEvidenceSetId: set.id, sourceEvidenceSetHash: set.sha256 });
      return;
    }
    if (request.stage === 'READY') {
      await this.enqueueWritingJob(projectId, request, input, data);
      return;
    }
    if (request.stage === 'GENERATING') {
      if (!data.writingJobId) { await this.failCategory(request, 'WRITING_JOB_MISSING'); return; }
      const job = await this.prisma.job.findFirst({ where: { id: data.writingJobId, projectId } });
      if (!job) { await this.failCategory(request, 'WRITING_JOB_MISSING'); return; }
      if (!TERMINAL.has(job.status)) { await this.defer(request); return; }
      if (job.status === 'SUCCEEDED') {
        const refs = job.resultRefs as { outlineRevisionId?: unknown; adaptationRevisionId?: unknown } | null;
        const id = input.task === 'OUTLINE' ? refs?.outlineRevisionId : refs?.adaptationRevisionId;
        if (typeof id !== 'string') { await this.failCategory(request, 'GENERATION_RESULT_MISSING'); return; }
        await this.updateStage(request, 'SUCCEEDED', { ...data, ...(input.task === 'OUTLINE' ? { outlineRevisionId: id } : { adaptationRevisionId: id }) });
      }
      else if (job.status === 'FAILED' && job.providerOutcome === 'KNOWN_SUCCEEDED'
        && ['WRITING_DRAFT_INVALID', 'NEEDS_HUMAN', 'INSUFFICIENT_EVIDENCE'].includes(job.errorCategory ?? '')
        && data.sourceEvidenceSetId && data.sourceEvidenceSetHash) await this.saveSourceStarter(request, input, data);
      else await this.failCategory(request, job.errorCategory ?? 'WRITING_FAILED');
    }
  }

  private async saveSourceStarter(request: RequestRow, input: RequestInput, data: StageData) {
    await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${request.projectId}::uuid FOR UPDATE`;
      await this.jobs.assertEffects(tx, request.projectId, request.requestedBy);
      await this.assertFrozenCurrent(tx, request.projectId, input);
      const set = await this.grounding.inspectSet(tx, request.projectId, data.sourceEvidenceSetId!, input.brief.id, true);
      if (set.sha256 !== data.sourceEvidenceSetHash) throw new ConflictException('INPUT_INTEGRITY');
      const labels = new Map(input.snapshots.map(snapshot => [snapshot.snapshotId, snapshot.label]));
      const quotes = [...new Map(set.passages.map(passage => [passage.quote, passage])).values()].slice(0, 3);
      const sourceStarter = { topic: input.brief.topic, excerpts: quotes.map(passage => {
        const points = Array.from(passage.quote);
        return { label: labels.get(passage.snapshotId) ?? 'Джерело', text: points.slice(0, 360).join(''), truncated: points.length > 360 };
      }) };
      await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest"
        SET "stage"='FAILED',"errorCategory"='SOURCE_STARTER_READY',"stageDataJson"=${JSON.stringify({ ...data, sourceStarter })}::jsonb,
          "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL
        WHERE "projectId"=${request.projectId}::uuid AND "id"=${request.id}::uuid AND "revision"=${request.revision} AND "stage"='GENERATING'`;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async enqueueWritingJob(projectId: string, request: RequestRow, input: RequestInput, data: StageData): Promise<Job> {
    if (!data.sourceEvidenceSetId || !data.sourceEvidenceSetHash) throw new ConflictException('Frozen source evidence set is missing');
    const { sourceWritingWorkflowRelease } = await import('./writing-provider.js');
    const release = sourceWritingWorkflowRelease(this.env);
    if (canonicalManifestHash(release) !== canonicalManifestHash(input.release)) throw new ConflictException('Source writing workflow configuration changed');
    return this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      await this.jobs.assertEffects(tx, projectId, request.requestedBy);
      await this.assertFrozenCurrent(tx, projectId, input);
      const set = await this.grounding.inspectSet(tx, projectId, data.sourceEvidenceSetId!, input.brief.id, true);
      if (set.sha256 !== data.sourceEvidenceSetHash) throw new ConflictException('Frozen source evidence set changed');
      const outline = await tx.outline.findUnique({ where: { projectId }, select: { revision: true } });
      if (input.task === 'OUTLINE' && (outline?.revision ?? 0) !== input.expectedOutlineRevision) throw new ConflictException('Outline changed while evidence was prepared');
      const brief = toWritingBrief(input.brief);
      const passages = set.passages.map(row => ({ id: row.id, packetId: row.packetId, snapshotId: row.snapshotId, quote: row.quote }));
      const requiredClaims = set.requiredClaims.map(row => ({ ...row, evidence: row.evidence }));
      if (requiredClaims.some(row => row.evidence.length > 10)) throw new ConflictException('REQUIRED_EVIDENCE_LIMIT');
      const writingRequest = sourceWritingInputSchema.parse({ schemaVersion: 'source-writing-input-v1', requestId: request.id, task: input.task, ...(input.task === 'ADAPTATION' ? { format: input.format,...(input.approvedArticle ? { approvedArticle: input.approvedArticle } : {}) } : {}), brief,
        style: input.brief.style, context: input.context, passages, requiredClaims });
      if (Buffer.byteLength(JSON.stringify(writingRequest), 'utf8') > MAX_WRITING_INPUT_BYTES) {
        throw new ConflictException('INPUT_TOO_LARGE');
      }
      const manifest = { schemaVersion: 'source-writing-job-v1', requestId: request.id, task: input.task, ...(input.task === 'ADAPTATION' ? { format: input.format,inputMode: input.inputMode ?? 'DIRECT',includeLink: input.includeLink ?? false } : {}),
        briefRevisionId: input.brief.id, briefHash: input.brief.hash, workspaceId: input.brief.workspaceId,
        workspaceStyleRevision: input.brief.workspaceStyleRevision, expectedRevision: input.task === 'ADAPTATION' ? input.expectedAdaptationRevision : input.expectedOutlineRevision,
        sourceEvidenceSetId: set.id, setHash: set.sha256, request: writingRequest, release: input.release,
        noticeVersion: input.noticeVersion, acceptedAt: input.acceptedAt };
      const job = await this.jobs.create(tx, { projectId, userId: request.requestedBy, operation: 'SOURCE_WRITING',
        contractVersion: 'source-writing-v1', commandKey: `source-writing-${request.id}`, inputManifest: asJson(manifest), deadlineMs: 600_000 });
      const locked = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid FOR UPDATE`;
      if (!locked[0] || locked[0].revision !== request.revision || locked[0].stage !== 'READY') {
        throw new ConflictException('Source writing request changed before generation was queued');
      }
      await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stageDataJson"=${JSON.stringify({ ...data, writingJobId: job.id })}::jsonb,
        "stage"='GENERATING',"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=CURRENT_TIMESTAMP
        WHERE "projectId"=${projectId}::uuid AND "id"=${request.id}::uuid`;
      return job;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async assertFrozenCurrent(tx: Prisma.TransactionClient, projectId: string, input: RequestInput): Promise<void> {
    if (input.inputMode === 'ARTICLE_DERIVED') {
      const parent = await sourceArticleContext(tx,projectId,this.articles);
      if (parent.sourceEvidenceSetId !== input.inheritedSourceEvidenceSetId || canonicalManifestHash(parent.approvedArticle) !== canonicalManifestHash(input.approvedArticle)) throw new ConflictException('Approved Article changed during preparation');
    }
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    if (!project.formats.includes(input.task === 'ADAPTATION' ? input.format! : 'ARTICLE') || project.workspace.styleRevision !== input.brief.workspaceStyleRevision) {
      throw new ConflictException('Project formats or workspace style changed during source preparation');
    }
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: { include: {
      requiredClaims: true, contextSnapshots: true, style: true } } } });
    const current = brief?.currentRevision;
    if (!current || current.id !== input.brief.id || current.sha256 !== input.brief.hash || canonicalBriefHash(current) !== current.sha256
      || current.workspaceId !== input.brief.workspaceId || current.workspaceStyleRevision !== input.brief.workspaceStyleRevision) {
      throw new ConflictException('Brief or workspace style changed during source preparation');
    }
    if (current.requiredClaims.length) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    const capturedContexts = current.contextSnapshots.map(row => ({ snapshotId: row.snapshotId, purpose: row.capturedPurpose }))
      .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    const frozenContexts = input.context.map(row => ({ snapshotId: row.snapshotId, purpose: row.purpose }))
      .sort((a, b) => a.snapshotId.localeCompare(b.snapshotId));
    if (canonicalManifestHash(capturedContexts) !== canonicalManifestHash(frozenContexts)) {
      throw new ConflictException('Selected writing context changed during source preparation');
    }
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
  }

  private async jobsFor(projectId: string, ids: readonly string[]) {
    if (!ids.length) return [] as Job[];
    return this.prisma.job.findMany({ where: { projectId, id: { in: [...ids] } } });
  }

  private childRefs(requestId: string, data: StageData) {
    return [
      ...(data.indexJobIds ?? []).map(id => ({ id, operation: 'SOURCE_EMBEDDING', manifestCommandKey: stableUuid(`${requestId}:index`) })),
      ...(data.searchJobId ? [{ id: data.searchJobId, operation: 'EVIDENCE_SEARCH', commandKey: stableUuid(`${requestId}:search`) }] : []),
      ...(data.writingJobId ? [{ id: data.writingJobId, operation: 'SOURCE_WRITING', commandKey: `source-writing-${requestId}` }] : []),
    ];
  }
  private async cancelOwnedChildren(projectId: string, userId: string, requestId: string, data: StageData): Promise<void> {
    await this.cancelOwnedRefs(projectId, userId, this.childRefs(requestId, data));
  }
  private async cancelOwnedRefs(projectId: string, userId: string, refs: readonly { id: string; operation: string; commandKey?: string; manifestCommandKey?: string }[]): Promise<void> {
    for (const ref of refs) {
      const job = await this.prisma.job.findFirst({ where: { id: ref.id, projectId } });
      const manifest = job?.inputManifest as { commandKey?: unknown } | null;
      if (job && job.operation === ref.operation && (!ref.commandKey || job.commandKey === ref.commandKey)
        && (!ref.manifestCommandKey || manifest?.commandKey === ref.manifestCommandKey)
        && (!TERMINAL.has(job.status) || job.operation === 'EVIDENCE_SEARCH' && job.contractVersion === 'evidence-search-v2')) {
        await this.jobs.cancel(userId, projectId, ref.id);
      }
    }
  }
  private async cancelChildrenIfTerminal(projectId: string, requestId: string, userId: string,
    refs: readonly { id: string; operation: string; commandKey?: string; manifestCommandKey?: string }[]): Promise<void> {
    const rows = await this.prisma.$queryRaw<Array<{ stage: string }>>`SELECT "stage" FROM contextflow."SourceWritingRequest"
      WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid`;
    if (!['FAILED', 'CANCELLED'].includes(rows[0]?.stage ?? '')) return;
    if (['FAILED','CANCELLED'].includes(rows[0]?.stage ?? '')) await this.cancelOwnedRefs(projectId, userId, refs);
  }

  private async updateStage(request: RequestRow, stage: string, data: StageData): Promise<boolean> {
    return this.prisma.$transaction(async tx => {
      const locked = await tx.$queryRaw<RequestRow[]>`SELECT * FROM contextflow."SourceWritingRequest"
        WHERE "projectId"=${request.projectId}::uuid AND "id"=${request.id}::uuid FOR UPDATE`;
      if (!locked[0] || locked[0].revision !== request.revision || locked[0].stage !== request.stage) return false;
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
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "task" IN ('OUTLINE','ADAPTATION') FOR UPDATE`;
      const row = rows[0];
      if (!row || !['INDEXING','SEARCHING','READY','GENERATING'].includes(row.stage)) return null;
      await tx.$executeRaw`UPDATE contextflow."SourceWritingRequest" SET "stage"='FAILED',"errorCategory"=${category},
        "revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP,"nextCheckAt"=NULL
        WHERE "projectId"=${projectId}::uuid AND "id"=${requestId}::uuid AND "revision"=${row.revision}`;
      return row;
    });
    if (!failed) return;
    const data = parseStageData(failed.stageDataJson);
    await this.cancelOwnedChildren(projectId, failed.requestedBy, failed.id, data);
  }
}

function requestManifestSnapshots(input: RequestInput): string[] { return input.snapshots.map(row => row.snapshotId); }

/** Lifecycle wrapper is registered by the worker module for the new poller. */
export class SourcePreparationPoller {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  constructor(private readonly preparation: SourcePreparationService) {}
  onModuleInit(): void {
    this.timer = setInterval(() => { void this.tick(); }, CHECK_INTERVAL_MS);
    this.timer.unref();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }
  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.preparation.pollOnce(); }
    catch { this.logger.error('Source preparation poller pass failed; next interval will retry'); }
    finally { this.busy = false; }
  }
  private readonly logger = new Logger(SourcePreparationPoller.name);
}
