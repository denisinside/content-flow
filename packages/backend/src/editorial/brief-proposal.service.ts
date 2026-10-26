import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { JobOperation } from '../generated/prisma/enums.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { jobView } from '../jobs/contracts.js';
import { briefProposalWorkflowSettings } from './brief-proposal-provider.js';
import { briefProposalCommandSchema, briefProposalWorkflowInputSchema,
  type BriefProposalCommand, type BriefProposalFields, type BriefProposalWorkflowInput } from './brief-proposal-contracts.js';

const CONTRACT = 'brief-proposal-v1';
const MAX_SOURCES = 20;
const MAX_EXCERPT_BYTES = 60_000;
const ellipsis = '\n\n[… пропущено …]\n\n';

type FrozenSource = Readonly<{ snapshotId: string; sha256: string; label: string; excerpt: string; sampled: boolean; sourceBytes: number; excerptBytes: number }>;
export type BriefProposalManifest = Readonly<{
  schemaVersion: 'brief-proposal-job-v1';
  payloadHash: string;
  projectTopic: string;
  workspaceId: string;
  styleRevision: number;
  currentBriefRevisionId: string | null;
  currentBriefHash: string | null;
  contentMode: 'FACTUAL' | 'CREATIVE';
  currentBrief: BriefProposalFields;
  sources: readonly FrozenSource[];
  request: BriefProposalWorkflowInput;
  release: { endpoint: string; workflowId: string; releaseId: string; configDigest: string };
  noticeVersion: string;
  acceptedAt: string;
}>;
type ProposalRefs = Readonly<{ schemaVersion: 'brief-proposal-result-v1'; output: unknown; aiExecutionId: string;
  requestHash: string; sources: readonly Pick<FrozenSource, 'snapshotId' | 'label' | 'sampled' | 'sourceBytes' | 'excerptBytes'>[] }>;

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function proposalConflict(code: string, message: string): ConflictException { return new ConflictException({ code, message }); }

function takeUtf8(value: string, maxBytes: number): string {
  let output = '', used = 0;
  for (const point of value) {
    const bytes = Buffer.byteLength(point, 'utf8');
    if (used + bytes > maxBytes) break;
    output += point; used += bytes;
  }
  return output;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  let output = '', used = 0;
  for (const point of [...value].reverse()) {
    const bytes = Buffer.byteLength(point, 'utf8');
    if (used + bytes > maxBytes) break;
    output = point + output; used += bytes;
  }
  return output;
}

function sampledExcerpt(text: string, budget: number): { excerpt: string; sampled: boolean } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= budget) return { excerpt: text, sampled: false };
  const markerBytes = Buffer.byteLength(ellipsis, 'utf8');
  const perEdge = Math.max(1, Math.floor((budget - markerBytes) / 3));
  const points = [...text];
  const chars = Math.max(1, Math.floor(points.length / 3));
  const head = takeUtf8(points.slice(0, chars).join(''), perEdge);
  const middle = takeUtf8(points.slice(Math.floor((points.length - chars) / 2), Math.floor((points.length + chars) / 2)).join(''), perEdge);
  const tail = takeUtf8Suffix(points.slice(-chars).join(''), perEdge);
  let excerpt = `${head}${ellipsis}${middle}${ellipsis}${tail}`;
  // Uneven UTF-8 density may make the excerpts exceed their share. Shrink each
  // edge deterministically until both the per-source and aggregate bound hold.
  let edgeBudget = perEdge;
  while (Buffer.byteLength(excerpt, 'utf8') > budget && edgeBudget > 1) {
    edgeBudget -= 1;
    excerpt = `${takeUtf8(points.slice(0, chars).join(''), edgeBudget)}${ellipsis}`
      + `${takeUtf8(points.slice(Math.floor((points.length - chars) / 2), Math.floor((points.length + chars) / 2)).join(''), edgeBudget)}${ellipsis}`
      + takeUtf8Suffix(points.slice(-chars).join(''), edgeBudget);
  }
  return { excerpt, sampled: true };
}

function parseManifest(job: Job): BriefProposalManifest {
  const manifest = job.inputManifest as unknown as BriefProposalManifest;
  const { requestHash, ...requestBase } = manifest?.request ?? {} as BriefProposalWorkflowInput;
  if (job.operation !== JobOperation.BRIEF_PROPOSAL || job.contractVersion !== CONTRACT || manifest?.schemaVersion !== 'brief-proposal-job-v1'
    || canonicalManifestHash({ contractVersion: job.contractVersion, inputManifest: job.inputManifest }) !== job.inputHash
    || !manifest.request || requestHash !== canonicalManifestHash(requestBase)) {
    throw new ConflictException('Brief proposal job integrity check failed');
  }
  return manifest;
}

export class BriefProposalService {
  constructor(readonly prisma: PrismaClient, private readonly jobs: DurableJobService,
    private readonly env: Record<string, string | undefined> = process.env) {}

  async configured(userId: string, projectId: string): Promise<boolean> {
    await this.prisma.$transaction(tx => this.lock(tx, userId, projectId, false));
    try { briefProposalWorkflowSettings(this.env); return true; } catch { return false; }
  }

  private async lock(tx: Prisma.TransactionClient, userId: string, projectId: string, effects = true) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
      WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
        AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL
      FOR UPDATE OF p FOR SHARE OF w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
    if (effects) await this.jobs.assertEffects(tx, projectId, userId);
  }

  private async current(tx: Prisma.TransactionClient, projectId: string, contentMode: 'FACTUAL' | 'CREATIVE') {
    const project = await tx.project.findUniqueOrThrow({ where: { id: projectId }, include: { workspace: true } });
    const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: {
      workspaceId: project.workspaceId, revision: project.workspace.styleRevision } } });
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: true } });
    if ((brief?.revision ?? 0) < 0) throw new ConflictException('Invalid current brief revision');
    const materials = await tx.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      orderBy: [{ id: 'asc' }], select: { id: true, label: true, currentSnapshotId: true, currentSnapshot: { select: {
        id: true, sha256: true, normalizedText: true, materialId: true } } } });
    if (contentMode === 'FACTUAL' && !materials.length) throw proposalConflict('NO_FACTUAL_SOURCES', 'Додайте й увімкніть хоча б одне фактичне джерело для брифу.');
    if (materials.some(row => !row.currentSnapshotId || !row.currentSnapshot)) throw proposalConflict('SOURCE_IMPORT_PENDING', 'Дочекайтеся завершення обробки кожного увімкненого джерела.');
    if (materials.length > MAX_SOURCES) throw proposalConflict('TOO_MANY_FACTUAL_SOURCES', `Для пропозиції брифу можна використати до ${MAX_SOURCES} джерел. Вимкніть зайві джерела на сторінці «Джерела».`);
    const budget = Math.floor(MAX_EXCERPT_BYTES / materials.length);
    const sources: FrozenSource[] = materials.map(row => {
      const snapshot = row.currentSnapshot!;
      if (snapshot.materialId !== row.id || sha256(snapshot.normalizedText) !== snapshot.sha256) throw proposalConflict('STALE_SOURCE', 'Одне з джерел змінилося. Оновіть сторінку й повторіть спробу.');
      const selected = sampledExcerpt(snapshot.normalizedText, budget);
      return { snapshotId: snapshot.id, sha256: snapshot.sha256, label: row.label, excerpt: selected.excerpt,
        sampled: selected.sampled, sourceBytes: Buffer.byteLength(snapshot.normalizedText, 'utf8'), excerptBytes: Buffer.byteLength(selected.excerpt, 'utf8') };
    });
    return { project, style, brief, sources };
  }

  private payloadHash(input: BriefProposalCommand): string {
    return canonicalManifestHash({ expectedRevision: input.expectedRevision, contentMode: input.contentMode, currentBrief: input.currentBrief });
  }

  async prepare(userId: string, projectId: string, raw: unknown) {
    const input = briefProposalCommandSchema.parse(raw);
    // Idempotent replay is checked before reading current sources, so a retry
    // returns the exact frozen operation even if the live project changed.
    const replay = await this.prisma.$transaction(async tx => {
      await this.lock(tx, userId, projectId);
      const existing = await tx.job.findUnique({ where: { projectId_operation_commandKey: {
        projectId, operation: JobOperation.BRIEF_PROPOSAL, commandKey: input.commandKey } } });
      if (!existing) return null;
      const frozen = parseManifest(existing);
      if (frozen.payloadHash !== this.payloadHash(input)) throw new ConflictException('This command was already used for different brief inputs');
      return existing;
    });
    if (replay) return replay;

    const settings = briefProposalWorkflowSettings(this.env);
    const { apiKey: _apiKey, ...release } = settings;
    void _apiKey;
    const created = await this.prisma.$transaction(async tx => {
      await this.lock(tx, userId, projectId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId + JobOperation.BRIEF_PROPOSAL + input.commandKey},0))::text`;
      const existing = await tx.job.findUnique({ where: { projectId_operation_commandKey: {
        projectId, operation: JobOperation.BRIEF_PROPOSAL, commandKey: input.commandKey } } });
      if (existing) {
        if (parseManifest(existing).payloadHash !== this.payloadHash(input)) throw new ConflictException('This command was already used for different brief inputs');
        return existing;
      }
      const live = await this.current(tx, projectId, input.contentMode);
      if ((live.brief?.revision ?? 0) !== input.expectedRevision) throw proposalConflict('BRIEF_CHANGED', 'Бриф змінився. Оновіть сторінку перед новою пропозицією.');
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { externalProcessingAcceptedAt: true, externalProcessingNoticeVersion: true } });
      if (!profile.externalProcessingAcceptedAt || profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) {
        throw new ForbiddenException('Accept the current external-processing notice before proposing a brief');
      }
      const { endpoint, workflowId, releaseId, configDigest } = release;
      const requestBase = { schemaVersion: 'brief-proposal-input-v1' as const, requestId: randomUUID(), topic: live.project.topic,
        contentMode: input.contentMode, currentBrief: input.currentBrief,
        style: { tone: live.style.tone, brandbook: live.style.brandbook },
        sources: live.sources.map(({ snapshotId, sha256: sourceHash, label, excerpt, sampled }) => ({ snapshotId,
          sha256: sourceHash, label, excerpt, sampled })) };
      const requestHash = canonicalManifestHash(requestBase);
      let request: BriefProposalWorkflowInput;
      try { request = briefProposalWorkflowInputSchema.parse({ ...requestBase, requestHash }); }
      catch { throw proposalConflict('INPUT_TOO_LARGE', 'Занадто багато тексту в брифі або стилі. Скоротіть його й повторіть спробу.'); }
      const manifest: BriefProposalManifest = { schemaVersion: 'brief-proposal-job-v1', payloadHash: this.payloadHash(input),
        projectTopic: live.project.topic, workspaceId: live.project.workspaceId, styleRevision: live.style.revision,
        currentBriefRevisionId: live.brief?.currentRevisionId ?? null, currentBriefHash: live.brief?.currentRevision?.sha256 ?? null,
        contentMode: input.contentMode, currentBrief: input.currentBrief, sources: live.sources, request,
        release: { endpoint, workflowId, releaseId, configDigest }, noticeVersion: EXTERNAL_PROCESSING_NOTICE.version,
        acceptedAt: profile.externalProcessingAcceptedAt.toISOString() };
      if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 260_000) throw new ConflictException('Brief proposal input exceeds its size limit');
      return this.jobs.create(tx, { projectId, userId, operation: JobOperation.BRIEF_PROPOSAL, contractVersion: CONTRACT,
        commandKey: input.commandKey, inputManifest: manifest as unknown as Prisma.InputJsonObject });
    }, { maxWait: 10_000, timeout: 30_000 });
    return created;
  }

  async get(userId: string, projectId: string, jobId: string) {
    const job = await this.jobs.get(userId, projectId, jobId);
    if (job.operation !== JobOperation.BRIEF_PROPOSAL) throw new NotFoundException('Brief proposal not found');
    const manifest = parseManifest(job);
    const stale = await this.prisma.$transaction(async tx => {
      await this.lock(tx, userId, projectId, false);
      return !(await this.isCurrent(tx, projectId, manifest));
    });
    const refs = job.resultRefs as ProposalRefs | null;
    const proposal = job.status === 'SUCCEEDED' && refs?.schemaVersion === 'brief-proposal-result-v1' ? refs.output : null;
    const sources = refs?.schemaVersion === 'brief-proposal-result-v1' ? refs.sources : manifest.sources.map(({ snapshotId, label, sampled, sourceBytes, excerptBytes }) => ({ snapshotId, label, sampled, sourceBytes, excerptBytes }));
    return { job: jobView(job), proposal, stale, sources };
  }

  async isCurrent(tx: Prisma.TransactionClient, projectId: string, manifest: BriefProposalManifest): Promise<boolean> {
    const project = await tx.project.findUnique({ where: { id: projectId }, include: { workspace: true } });
    const brief = await tx.brief.findUnique({ where: { projectId }, include: { currentRevision: true } });
    if (!project || project.topic !== manifest.projectTopic || project.workspaceId !== manifest.workspaceId
      || project.workspace.styleRevision !== manifest.styleRevision
      || (brief?.currentRevisionId ?? null) !== manifest.currentBriefRevisionId
      || (brief?.currentRevision?.sha256 ?? null) !== manifest.currentBriefHash) return false;
    const selected = await tx.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE' },
      orderBy: [{ id: 'asc' }], select: { label: true, currentSnapshotId: true, currentSnapshot: { select: { sha256: true } } } });
    if (selected.length !== manifest.sources.length || selected.some(row => !row.currentSnapshotId || !row.currentSnapshot)) return false;
    return selected.every((row, index) => row.label === manifest.sources[index]?.label && row.currentSnapshotId === manifest.sources[index]?.snapshotId
      && row.currentSnapshot?.sha256 === manifest.sources[index]?.sha256);
  }
}
