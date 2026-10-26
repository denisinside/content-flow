import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { retryAllowed } from '../jobs/contracts.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, MAX_EMBEDDING_BATCH, embeddingRequestSchema,
  embeddingRequestHash, indexSourceEvidenceInput, searchSourceEvidenceInput, sha256Text, validateEmbeddingOutput,
  type EmbeddingOutput, type EmbeddingRequest, type IndexSourceEvidenceInput, type SearchSourceEvidenceInput } from './contracts.js';
import { embeddingWorkflowSettings } from './embedding-provider.js';
import { sourceRelevanceWorkflowSettings } from './relevance-provider.js';
import { relevanceInputHash, relevanceInputSchema, validateRelevanceOutput, type RelevanceCandidate, type RelevanceOutput } from './relevance-contracts.js';
import { selectRelevantCandidates } from './relevance-selection.js';
import { EVIDENCE_RELEVANCE_CONTRACT, EVIDENCE_SEARCH_V2_CONTRACT, evidenceRelevanceManifestSchema,
  evidenceSearchV2ManifestSchema, HYBRID_SOURCE_V4_POLICY, type EvidenceRelevanceManifest, type EvidenceSearchV2Manifest }
  from './relevance-job-contracts.js';
import { buildSearchChunks, reciprocalRankFusion, selectDiversePassages, validateExactCitation,
  type EvidenceSnapshot, type FusedRank, type SearchChunk } from './retrieval.js';
import { selectEvidenceSpans, substantiveEvidenceRanges } from './passage-selection.js';

const CHUNKER_VERSION = 'paragraph-window-v1';
const JOB_DEADLINE_MS = 600_000;
const INDEX_CONTRACT = 'source-embedding-v1';
type RetrievalPolicy = Readonly<{ version: 'hybrid-source-v1' | 'hybrid-source-v2' | 'hybrid-source-v3'; rankConstant: 60;
  byteBudget: number; maxPassages: number; adjacentContextChunks: 1 }>;

type FrozenSnapshot = Readonly<{ snapshotId: string; materialId: string; snapshotSha256: string; sequence: number; label: string }>;
type FrozenRelease = Readonly<{ endpoint: string; workflowId: string; releaseId: string; configDigest: string }>;
type IndexManifest = Readonly<{ schemaVersion: 'source-embedding-job-v1'; commandKey: string; requestSnapshotIds: readonly string[]; indexId: string;
  snapshot: FrozenSnapshot; request: EmbeddingRequest; release: FrozenRelease; noticeVersion: string; acceptedAt: string }>;
type SearchManifest = Readonly<{ schemaVersion: 'evidence-search-job-v1'; commandKey: string; query: string;
  snapshots: readonly FrozenSnapshot[]; indexes: readonly Readonly<{ indexId: string; snapshotId: string; snapshotSha256: string; configDigest: string }>[];
  retrievalPolicy: RetrievalPolicy; request: EmbeddingRequest; release: FrozenRelease; noticeVersion: string; acceptedAt: string }>;
type AnySearchManifest = SearchManifest | EvidenceSearchV2Manifest;

type DbSnapshot = { id: string; projectId: string; materialId: string; sequence: number; normalizedText: string; sha256: string;
  label: string; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] };
type DbChunk = { id: string; projectId: string; snapshotId: string; snapshotSha256: string; startOffset: number; endOffset: number;
  sha256: string; text: string; ordinal: number; indexId: string };
type SearchHit = { id: string; score: number };

function asJson(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

function safeHash(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }

function releaseFor(env: Record<string, string | undefined>): FrozenRelease {
  const { apiKey: _apiKey, ...release } = embeddingWorkflowSettings(env);
  void _apiKey;
  return release;
}

function relevanceReleaseFor(env: Record<string, string | undefined>): FrozenRelease {
  const { apiKey: _apiKey, ...release } = sourceRelevanceWorkflowSettings(env);
  void _apiKey;
  return release;
}

function candidateId(candidate: Omit<RelevanceCandidate, 'id'>): string {
  return createHash('sha256').update(JSON.stringify([candidate.snapshotId, candidate.fragmentId, candidate.startOffset,
    candidate.endOffset, candidate.sha256])).digest('hex');
}

function relevanceCommandKey(parentJobId: string): string { return `relevance-${parentJobId}`; }

function indexConfigDigest(release: FrozenRelease): string {
  return canonicalManifestHash({ schemaVersion: 'source-search-index-config-v1', chunkerVersion: CHUNKER_VERSION,
    model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, maxUnicodeChars: 4000, maxUtf8Bytes: 1536,
    releaseId: release.releaseId, releaseConfigDigest: release.configDigest });
}

function fullSnapshot(row: DbSnapshot): EvidenceSnapshot {
  return { id: row.id, projectId: row.projectId, normalizedText: row.normalizedText, sha256: row.sha256,
    fragments: row.fragments.map(fragment => ({ id: fragment.id, startOffset: fragment.startOffset,
      endOffset: fragment.endOffset, sha256: fragment.sha256 })) };
}

function snapshotManifest(row: DbSnapshot): FrozenSnapshot {
  return { snapshotId: row.id, materialId: row.materialId, snapshotSha256: row.sha256, sequence: row.sequence, label: row.label };
}

function embeddingRequest(task: 'DOCUMENT' | 'QUERY', texts: EmbeddingRequest['texts']): EmbeddingRequest {
  return embeddingRequestSchema.parse({ schemaVersion: 'source-embedding-request-v1', requestId: randomUUID(), task, texts });
}

export class EvidenceServiceError extends Error {
  constructor(readonly category: string, readonly outcome: 'NOT_SUBMITTED' | 'KNOWN_FAILED' | 'KNOWN_SUCCEEDED' | 'UNKNOWN' = 'KNOWN_FAILED') {
    super(category); this.name = 'EvidenceServiceError';
  }
}

/**
 * Owns source search indexes and immutable evidence packets. The current
 * approved-claim workflow remains separate; this service only returns exact
 * source passages for a frozen user query.
 */
export class SourceEvidenceService {
  constructor(readonly prisma: PrismaClient, readonly jobs: DurableJobService,
    private readonly env: Record<string, string | undefined> = process.env) {}

  private async assertReadable(userId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, archivedAt: null, trashedAt: null,
      workspace: { archivedAt: null, trashedAt: null, members: { some: { userId, leftAt: null } } } }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
  }

  private async withReadableTransaction<T>(userId: string, projectId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async tx => {
      const access = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id"=p."workspaceId"
        JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
        WHERE p."id"=${projectId}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL
          AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
          AND m."userId"=${userId}::uuid AND m."leftAt" IS NULL
        FOR SHARE OF p,w,m`;
      if (!access.length) throw new NotFoundException('Project not found');
      return operation(tx);
    });
  }

  private async getCurrentSnapshots(db: Prisma.TransactionClient, projectId: string, snapshotIds: readonly string[]): Promise<DbSnapshot[]> {
    const rows = await db.sourceSnapshot.findMany({ where: { projectId, id: { in: [...snapshotIds] }, currentForMaterials: {
      some: { included: true, purpose: 'FACTUAL_SOURCE' } } }, include: {
      material: { select: { id: true, label: true } }, fragments: { select: { id: true, startOffset: true, endOffset: true, sha256: true }, orderBy: { ordinal: 'asc' } },
    }, orderBy: { id: 'asc' } });
    if (rows.length !== snapshotIds.length) throw new ConflictException('Choose current included factual sources before indexing or searching');
    return rows.map(row => ({ id: row.id, projectId: row.projectId, materialId: row.materialId, sequence: row.sequence,
      normalizedText: row.normalizedText, sha256: row.sha256, label: row.material.label, fragments: row.fragments }));
  }

  async list(userId: string, projectId: string) {
    return this.withReadableTransaction(userId, projectId, async tx => {
      let release: FrozenRelease | undefined;
      try { release = releaseFor(this.env); } catch { release = undefined; }
      const digest = release ? indexConfigDigest(release) : undefined;
      const materials = await tx.material.findMany({ where: { projectId, included: true, purpose: 'FACTUAL_SOURCE',
        currentSnapshotId: { not: null } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: {
        id: true, label: true, currentSnapshotId: true, currentSnapshot: { select: { sequence: true } },
      } });
      const ids = materials.flatMap(row => row.currentSnapshotId ? [row.currentSnapshotId] : []);
      const indexes = digest && ids.length ? await tx.$queryRaw<Array<{ id: string; snapshotId: string; chunkCount: number; readyChunkCount: number }>>`
      SELECT i."id"::text, i."snapshotId"::text,
        count(c."id") FILTER (WHERE c."requiresEmbedding")::int AS "chunkCount",
        count(e."chunkId") FILTER (WHERE c."requiresEmbedding")::int AS "readyChunkCount"
      FROM contextflow."SourceSearchIndex" i
      LEFT JOIN contextflow."SourceSearchChunk" c ON c."projectId"=i."projectId" AND c."indexId"=i."id"
      LEFT JOIN contextflow."SourceChunkEmbedding" e ON e."projectId"=c."projectId" AND e."chunkId"=c."id"
        WHERE i."projectId"=${projectId}::uuid AND i."snapshotId"=ANY(${ids}::uuid[]) AND i."configDigest"=${digest}
        GROUP BY i."id",i."snapshotId"` : [];
      const bySnapshot = new Map(indexes.map(row => [row.snapshotId, row]));
      return { configuration: { configured: !!release }, materials: materials.map(material => {
        const snapshotId = material.currentSnapshotId;
        const indexed = snapshotId ? bySnapshot.get(snapshotId) : undefined;
        const chunkCount = indexed?.chunkCount ?? 0, readyChunkCount = indexed?.readyChunkCount ?? 0;
        return { id: material.id, label: material.label, snapshotId, snapshotSequence: material.currentSnapshot?.sequence ?? null,
          indexState: !indexed || chunkCount === 0 ? 'MISSING' as const : readyChunkCount === chunkCount ? 'READY' as const : 'PARTIAL' as const,
          chunkCount, readyChunkCount };
      }) };
    });
  }

  async index(userId: string, projectId: string, rawInput: IndexSourceEvidenceInput) {
    const input = indexSourceEvidenceInput.parse(rawInput);
    await this.assertReadable(userId, projectId);
    // DurableJobService accepts only word characters and hyphens. Keep a
    // trailing separator so this fixed UUID prefix cannot match another key.
    const baseCommand = `source-index-${input.commandKey}-`;
    // A replay resolves before current-selection checks: the caller must be
    // able to retrieve the same frozen jobs even after sources change.
    const previous = await this.withReadableTransaction(userId, projectId, tx => tx.job.findMany({
      where: { projectId, operation: 'SOURCE_EMBEDDING', commandKey: { startsWith: baseCommand } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    if (previous.length) {
      const manifests = previous.map(job => job.inputManifest as unknown as IndexManifest);
      if (manifests.some(manifest => manifest.schemaVersion !== 'source-embedding-job-v1' || manifest.commandKey !== input.commandKey
        || canonicalManifestHash(manifest.requestSnapshotIds ?? []) !== canonicalManifestHash([...input.snapshotIds].sort()))) {
        throw new ConflictException('Command key already belongs to different frozen source indexes');
      }
      return { jobs: previous.map(job => ({ id: job.id, status: job.status })) };
    }
    let release: FrozenRelease;
    try { release = releaseFor(this.env); } catch { throw new ConflictException('The source embedding workflow is not configured'); }
    const digest = indexConfigDigest(release);
    const observedJobs = new Map<string, { id: string; status: Job['status'] }>();
    const jobs: Job[] = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      await this.jobs.assertEffects(tx, projectId, userId);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId + baseCommand}, 0))::text`;
      const replay = await tx.job.findMany({ where: { projectId, operation: 'SOURCE_EMBEDDING', commandKey: { startsWith: baseCommand } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      if (replay.length) return replay;
      const snapshots = await this.getCurrentSnapshots(tx, projectId, input.snapshotIds);
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { externalProcessingAcceptedAt: true,
        externalProcessingNoticeVersion: true } });
      if (!profile.externalProcessingAcceptedAt || profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) {
        throw new ConflictException('Accept the current external-processing notice before indexing sources');
      }
      const created: Job[] = [];
      for (const row of snapshots) {
        if (!safeHash(row.sha256) || sha256Text(row.normalizedText) !== row.sha256) throw new ConflictException('A selected source snapshot has changed');
        const stableIndex = await tx.$queryRaw<Array<{ id: string }>>`INSERT INTO contextflow."SourceSearchIndex"
          ("id","projectId","snapshotId","snapshotSha256","chunkerVersion","model","dimensions","configDigest","createdBy","createdAt")
          VALUES (${randomUUID()}::uuid,${projectId}::uuid,${row.id}::uuid,${row.sha256},${CHUNKER_VERSION},${EMBEDDING_MODEL},${EMBEDDING_DIMENSIONS},${digest},${userId}::uuid,CURRENT_TIMESTAMP)
          ON CONFLICT ("projectId","snapshotId","configDigest") DO NOTHING RETURNING "id"::text`;
        const indexId = stableIndex[0]?.id ?? (await tx.$queryRaw<Array<{ id: string }>>`SELECT "id"::text FROM contextflow."SourceSearchIndex"
          WHERE "projectId"=${projectId}::uuid AND "snapshotId"=${row.id}::uuid AND "configDigest"=${digest}`)[0]?.id;
        if (!indexId) throw new ConflictException('Could not create a source search index');
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId + indexId}, 0))::text`;
        const built = buildSearchChunks(fullSnapshot(row), { chunkerVersion: CHUNKER_VERSION });
        let existing = await tx.$queryRaw<Array<{ id: string; ordinal: number; startOffset: number; endOffset: number; sha256: string; text: string }>>`SELECT c."id"::text,
          c."ordinal",c."startOffset",c."endOffset",c."sha256",c."text" FROM contextflow."SourceSearchChunk" c
          WHERE c."projectId"=${projectId}::uuid AND c."indexId"=${indexId}::uuid ORDER BY c."ordinal"`;
        if (!existing.length && built.length) {
          const data = built.map((chunk, ordinal) => ({ id: randomUUID(), projectId, indexId, snapshotId: row.id,
            snapshotSha256: row.sha256, ordinal, startOffset: chunk.startOffset, endOffset: chunk.endOffset, sha256: sha256Text(chunk.text),
            text: chunk.text, requiresEmbedding: chunk.text.trim().length > 0 }));
          for (let offset = 0; offset < data.length; offset += MAX_EMBEDDING_BATCH) {
            await tx.sourceSearchChunk.createMany({ data: data.slice(offset, offset + MAX_EMBEDDING_BATCH) });
          }
          existing = await tx.$queryRaw`SELECT c."id"::text,c."ordinal",c."startOffset",c."endOffset",c."sha256",c."text"
            FROM contextflow."SourceSearchChunk" c WHERE c."projectId"=${projectId}::uuid AND c."indexId"=${indexId}::uuid ORDER BY c."ordinal"`;
        }
        if (existing.length !== built.length || existing.some((chunk, ordinal) => {
          const expected = built[ordinal];
          return !expected || chunk.ordinal !== ordinal || chunk.startOffset !== expected.startOffset || chunk.endOffset !== expected.endOffset
            || chunk.text !== expected.text || chunk.sha256 !== sha256Text(expected.text);
        })) {
          throw new ConflictException('The stored source index does not match the selected snapshot');
        }
        const chunks = await tx.$queryRaw<Array<{ id: string; ordinal: number; text: string; sha256: string }>>`SELECT c."id"::text,c."ordinal",c."text",c."sha256"
          FROM contextflow."SourceSearchChunk" c LEFT JOIN contextflow."SourceChunkEmbedding" e
            ON e."projectId"=c."projectId" AND e."chunkId"=c."id"
          WHERE c."projectId"=${projectId}::uuid AND c."indexId"=${indexId}::uuid AND c."requiresEmbedding"=true AND e."chunkId" IS NULL ORDER BY c."ordinal"`;
        const existingJobs = await tx.job.findMany({ where: { projectId, operation: 'SOURCE_EMBEDDING', status: { in: ['QUEUED','RETRY_WAIT','RUNNING','OUTCOME_UNKNOWN','CANCELLED'] } },
          select: { id: true, status: true, providerOutcome: true, inputManifest: true,
            attempts: { where: { providerSubmittedAt: { not: null } }, select: { id: true }, take: 1 } } });
        const reserved = new Set(existingJobs.flatMap(job => {
          const manifest = job.inputManifest as unknown as IndexManifest;
          if (manifest?.indexId !== indexId) return [];
          const mayStillRun = job.status !== 'CANCELLED' || (job.attempts.length > 0
            && ['UNKNOWN','MAY_STILL_RUN'].includes(job.providerOutcome));
          if (!mayStillRun) return [];
          observedJobs.set(job.id, { id: job.id, status: job.status });
          return manifest.request.texts.map(text => text.id);
        }));
        const pending = chunks.filter(chunk => !reserved.has(chunk.id));
        for (let offset = 0, batch = 0; offset < pending.length; offset += MAX_EMBEDDING_BATCH, batch++) {
          const selected = pending.slice(offset, offset + MAX_EMBEDDING_BATCH);
          const request = embeddingRequest('DOCUMENT', selected.map(chunk => ({ id: chunk.id,
            text: chunk.text, sha256: chunk.sha256 })));
          const manifest: IndexManifest & { requestSnapshotIds: string[] } = { schemaVersion: 'source-embedding-job-v1', commandKey: input.commandKey,
            requestSnapshotIds: [...input.snapshotIds].sort(), indexId, snapshot: snapshotManifest(row), request, release,
            noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: profile.externalProcessingAcceptedAt.toISOString() };
          created.push(await this.jobs.create(tx, { projectId, userId, operation: 'SOURCE_EMBEDDING', contractVersion: INDEX_CONTRACT,
            commandKey: `${baseCommand}${row.id}-${batch}`, inputManifest: asJson(manifest), deadlineMs: JOB_DEADLINE_MS }));
        }
      }
      return created;
    }, { maxWait: 10_000, timeout: 120_000 });
    const result = new Map([...observedJobs, ...jobs.map(job => [job.id, { id: job.id, status: job.status }] as const)]);
    return { jobs: [...result.values()] };
  }

  async search(userId: string, projectId: string, rawInput: SearchSourceEvidenceInput) {
    const input = searchSourceEvidenceInput.parse(rawInput);
    await this.assertReadable(userId, projectId);
    const existing = await this.withReadableTransaction(userId, projectId, tx => tx.job.findFirst({
      where: { projectId, operation: 'EVIDENCE_SEARCH', commandKey: input.commandKey } }));
    if (existing) {
      const rawManifest = existing.inputManifest as unknown as SearchManifest | EvidenceSearchV2Manifest;
      const manifest = rawManifest.schemaVersion === 'evidence-search-job-v2' ? evidenceSearchV2ManifestSchema.parse(rawManifest) : rawManifest;
      if (!['evidence-search-job-v1', 'evidence-search-job-v2'].includes(manifest.schemaVersion) || manifest.query !== input.query
        || canonicalManifestHash(manifest.snapshots.map(row => row.snapshotId).sort()) !== canonicalManifestHash([...input.snapshotIds].sort())) {
        throw new ConflictException('Command key already belongs to a different evidence query');
      }
      return { job: { id: existing.id, status: existing.status } };
    }
    let release: FrozenRelease;
    try { release = releaseFor(this.env); } catch { throw new ConflictException('The source embedding workflow is not configured'); }
    let relevanceRelease: FrozenRelease;
    try { relevanceRelease = relevanceReleaseFor(this.env); } catch { throw new ConflictException('The source relevance workflow is not configured'); }
    const digest = indexConfigDigest(release);
    const job = await this.prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId + 'EVIDENCE_SEARCH' + input.commandKey}, 0))::text`;
      const replay = await tx.job.findUnique({ where: { projectId_operation_commandKey: { projectId, operation: 'EVIDENCE_SEARCH', commandKey: input.commandKey } } });
      if (replay) return replay;
      await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR UPDATE`;
      await this.jobs.assertEffects(tx, projectId, userId);
      const snapshots = await this.getCurrentSnapshots(tx, projectId, input.snapshotIds);
      const indexes = await tx.$queryRaw<Array<{ id: string; snapshotId: string; snapshotSha256: string; configDigest: string;
        chunkCount: number; readyChunkCount: number }>>`SELECT i."id"::text,i."snapshotId"::text,i."snapshotSha256",i."configDigest",
          count(c."id") FILTER (WHERE c."requiresEmbedding")::int AS "chunkCount",
          count(e."chunkId") FILTER (WHERE c."requiresEmbedding")::int AS "readyChunkCount"
        FROM contextflow."SourceSearchIndex" i LEFT JOIN contextflow."SourceSearchChunk" c
          ON c."projectId"=i."projectId" AND c."indexId"=i."id"
        LEFT JOIN contextflow."SourceChunkEmbedding" e ON e."projectId"=c."projectId" AND e."chunkId"=c."id"
        WHERE i."projectId"=${projectId}::uuid AND i."snapshotId"=ANY(${snapshots.map(row => row.id)}::uuid[]) AND i."configDigest"=${digest}
        GROUP BY i."id",i."snapshotId" ORDER BY i."snapshotId"`;
      if (indexes.length !== snapshots.length || indexes.some(index => !index.chunkCount || index.readyChunkCount !== index.chunkCount
        || snapshots.find(row => row.id === index.snapshotId)?.sha256 !== index.snapshotSha256)) {
        throw new ConflictException('Index every selected current source before searching');
      }
      const profile = await tx.userProfile.findUniqueOrThrow({ where: { id: userId }, select: { externalProcessingAcceptedAt: true,
        externalProcessingNoticeVersion: true } });
      if (!profile.externalProcessingAcceptedAt || profile.externalProcessingNoticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) {
        throw new ConflictException('Accept the current external-processing notice before searching sources');
      }
      const manifest: EvidenceSearchV2Manifest = evidenceSearchV2ManifestSchema.parse({ schemaVersion: 'evidence-search-job-v2', commandKey: input.commandKey, query: input.query,
        snapshots: snapshots.map(snapshotManifest), indexes: indexes.map(index => ({ indexId: index.id, snapshotId: index.snapshotId,
          snapshotSha256: index.snapshotSha256, configDigest: index.configDigest })),
        retrievalPolicy: HYBRID_SOURCE_V4_POLICY, request: embeddingRequest('QUERY', [{ id: randomUUID(), text: input.query, sha256: sha256Text(input.query) }]), release, relevanceRelease,
        noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, acceptedAt: profile.externalProcessingAcceptedAt.toISOString() });
      return this.jobs.create(tx, { projectId, userId, operation: 'EVIDENCE_SEARCH', contractVersion: EVIDENCE_SEARCH_V2_CONTRACT,
        commandKey: input.commandKey, inputManifest: asJson(manifest), deadlineMs: JOB_DEADLINE_MS });
    }, { maxWait: 10_000, timeout: 30_000 });
    return { job: { id: job.id, status: job.status } };
  }

  async validateEmbeddingSubmission(projectId: string, manifest: IndexManifest | AnySearchManifest,
    db: PrismaClient | Prisma.TransactionClient = this.prisma): Promise<void> {
    if (manifest.schemaVersion === 'evidence-search-job-v2') {
      try { evidenceSearchV2ManifestSchema.parse(manifest); } catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED'); }
      let currentRelevance: FrozenRelease;
      try { currentRelevance = relevanceReleaseFor(this.env); } catch { throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED'); }
      if (canonicalManifestHash(currentRelevance) !== canonicalManifestHash(manifest.relevanceRelease)) {
        throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED');
      }
    }
    const settings = releaseFor(this.env);
    if (canonicalManifestHash(settings) !== canonicalManifestHash(manifest.release)
      || manifest.noticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED');
    const snapshots = 'snapshot' in manifest ? [manifest.snapshot] : manifest.snapshots;
    const expectedIndexes = 'indexId' in manifest ? [{ indexId: manifest.indexId, snapshotId: manifest.snapshot.snapshotId,
      snapshotSha256: manifest.snapshot.snapshotSha256 }] : manifest.indexes;
    // These same-project reads are independent. A standalone client may run
    // them on separate connections; inside a fence transaction they retain
    // the same authoritative transaction and every original predicate.
    const readSnapshots = () => db.sourceSnapshot.findMany({ where: { projectId, id: { in: snapshots.map(row => row.snapshotId) },
      currentForMaterials: { some: { included: true, purpose: 'FACTUAL_SOURCE' } } }, select: { id: true, sha256: true } });
    const readIndexes = () => db.$queryRaw<Array<{ id: string; snapshotId: string; snapshotSha256: string; configDigest: string }>>`SELECT "id"::text,
        "snapshotId"::text,"snapshotSha256","configDigest" FROM contextflow."SourceSearchIndex"
      WHERE "projectId"=${projectId}::uuid AND "id"=ANY(${expectedIndexes.map(row => row.indexId)}::uuid[])`;
    const [actual, valid] = db === this.prisma
      ? await Promise.all([readSnapshots(), readIndexes()])
      : [await readSnapshots(), await readIndexes()];
    if (actual.length !== snapshots.length || snapshots.some(frozen => actual.find(row => row.id === frozen.snapshotId)?.sha256 !== frozen.snapshotSha256)) {
      throw new EvidenceServiceError('SOURCE_CHANGED', 'NOT_SUBMITTED');
    }
    if (valid.length !== expectedIndexes.length || expectedIndexes.some(frozen => {
      const actual = valid.find(row => row.id === frozen.indexId);
      return !actual || actual.snapshotId !== frozen.snapshotId || actual.snapshotSha256 !== frozen.snapshotSha256
        || actual.configDigest !== indexConfigDigest(settings);
    })) throw new EvidenceServiceError('SOURCE_CHANGED', 'NOT_SUBMITTED');
    if (manifest.schemaVersion === 'source-embedding-job-v1' && manifest.request.task === 'DOCUMENT') {
      const chunks = await db.$queryRaw<Array<{ id: string; sha256: string; text: string }>>`SELECT "id"::text,"sha256","text"
        FROM contextflow."SourceSearchChunk" WHERE "projectId"=${projectId}::uuid AND "indexId"=${manifest.indexId}::uuid
          AND "id"=ANY(${manifest.request.texts.map(row => row.id)}::uuid[])`;
      if (chunks.length !== manifest.request.texts.length || manifest.request.texts.some(frozen => {
        const actual = chunks.find(row => row.id === frozen.id);
        return !actual || actual.sha256 !== frozen.sha256 || actual.text !== frozen.text || sha256Text(actual.text) !== frozen.sha256;
      })) throw new EvidenceServiceError('SOURCE_CHANGED', 'NOT_SUBMITTED');
    }
  }

  async validateRelevanceSubmission(projectId: string, rawManifest: EvidenceRelevanceManifest,
    db: PrismaClient | Prisma.TransactionClient = this.prisma): Promise<void> {
    let manifest: EvidenceRelevanceManifest;
    try { manifest = evidenceRelevanceManifestSchema.parse(rawManifest); }
    catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED'); }
    let relevanceRelease: FrozenRelease;
    try { relevanceRelease = relevanceReleaseFor(this.env); } catch { throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED'); }
    if (canonicalManifestHash(relevanceRelease) !== canonicalManifestHash(manifest.release)) {
      throw new EvidenceServiceError('CONFIG_CHANGED', 'NOT_SUBMITTED');
    }
    const parent = await db.job.findFirst({ where: { id: manifest.parentJobId, projectId, operation: 'EVIDENCE_SEARCH',
      contractVersion: EVIDENCE_SEARCH_V2_CONTRACT }, select: { id: true, projectId: true, contractVersion: true, status: true,
        inputHash: true, inputManifest: true, resultRefs: true, requestedBy: true } });
    if (!parent || parent.status !== 'SUCCEEDED' || parent.inputHash !== manifest.parentInputHash) {
      throw new EvidenceServiceError('SOURCE_CHANGED', 'NOT_SUBMITTED');
    }
    const refs = parent.resultRefs as { relevanceJobId?: unknown } | null;
    if (!refs || typeof refs.relevanceJobId !== 'string') throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED');
    if (manifest.commandKey !== relevanceCommandKey(parent.id)) throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED');
    const linkedChild = await db.job.findFirst({ where: { id: refs.relevanceJobId, projectId, operation: 'EVIDENCE_SEARCH',
      contractVersion: EVIDENCE_RELEVANCE_CONTRACT }, select: { id: true, requestedBy: true, commandKey: true,
        contractVersion: true, inputHash: true, inputManifest: true } });
    const expectedChildHash = canonicalManifestHash({ contractVersion: EVIDENCE_RELEVANCE_CONTRACT, inputManifest: manifest });
    if (!linkedChild || linkedChild.requestedBy !== parent.requestedBy || linkedChild.commandKey !== relevanceCommandKey(parent.id)
      || linkedChild.inputHash !== expectedChildHash || canonicalManifestHash(linkedChild.inputManifest) !== canonicalManifestHash(manifest)) {
      throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED');
    }
    let parentManifest: EvidenceSearchV2Manifest;
    try { parentManifest = evidenceSearchV2ManifestSchema.parse(parent.inputManifest); }
    catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED'); }
    if (parent.projectId !== projectId || canonicalManifestHash(parentManifest.snapshots) !== canonicalManifestHash(manifest.snapshots)
      || canonicalManifestHash(parentManifest.indexes) !== canonicalManifestHash(manifest.indexes)
      || canonicalManifestHash(parentManifest.retrievalPolicy) !== canonicalManifestHash(manifest.retrievalPolicy)
      || canonicalManifestHash(parentManifest.release) !== canonicalManifestHash(manifest.embeddingRelease)
      || canonicalManifestHash(parentManifest.relevanceRelease) !== canonicalManifestHash(manifest.release)
      || parentManifest.query !== manifest.query || parentManifest.noticeVersion !== manifest.noticeVersion
      || parentManifest.acceptedAt !== manifest.acceptedAt) throw new EvidenceServiceError('INVALID_CONTRACT', 'NOT_SUBMITTED');
    await this.validateEmbeddingSubmission(projectId, parentManifest, db);
    const snapshots = await db.sourceSnapshot.findMany({ where: { projectId, id: { in: manifest.snapshots.map(row => row.snapshotId) },
      currentForMaterials: { some: { included: true, purpose: 'FACTUAL_SOURCE' } } }, select: { id: true, sha256: true,
        normalizedText: true, fragments: { select: { id: true, startOffset: true, endOffset: true } } } });
    if (snapshots.length !== manifest.snapshots.length || manifest.request.candidates.some(candidate => {
      const source = snapshots.find(row => row.id === candidate.snapshotId);
      const fragment = source?.fragments.find(row => row.id === candidate.fragmentId);
      const candidateWithoutId = { snapshotId: candidate.snapshotId, fragmentId: candidate.fragmentId,
        startOffset: candidate.startOffset, endOffset: candidate.endOffset, quote: candidate.quote,
        sha256: candidate.sha256, snapshotSha256: candidate.snapshotSha256, label: candidate.label };
      return !source || !fragment || source.sha256 !== candidate.snapshotSha256
        || candidate.startOffset < fragment.startOffset || candidate.endOffset > fragment.endOffset
        || source.normalizedText.slice(candidate.startOffset, candidate.endOffset) !== candidate.quote
        || sha256Text(candidate.quote) !== candidate.sha256 || candidate.id !== candidateId(candidateWithoutId);
    })) throw new EvidenceServiceError('SOURCE_CHANGED', 'NOT_SUBMITTED');
  }

  async commitEmbedding(tx: Prisma.TransactionClient, projectId: string, jobId: string, manifest: IndexManifest, output: EmbeddingOutput): Promise<void> {
    await this.validateEmbeddingSubmission(projectId, manifest, tx);
    try { validateEmbeddingOutput(output, manifest.request); } catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED'); }
    if (manifest.request.task !== 'DOCUMENT' || output.task !== 'DOCUMENT' || output.embeddings.length !== manifest.request.texts.length) {
      throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
    }
    for (const item of output.embeddings) {
      const inserted = await tx.$executeRaw`INSERT INTO contextflow."SourceChunkEmbedding" ("projectId","chunkId","jobId","createdAt","embedding")
        SELECT ${projectId}::uuid,c."id",${jobId}::uuid,CURRENT_TIMESTAMP,contextflow.parse_source_vector(${`[${item.values.join(',')}]`})
        FROM contextflow."SourceSearchChunk" c WHERE c."projectId"=${projectId}::uuid AND c."indexId"=${manifest.indexId}::uuid
          AND c."id"=${item.id}::uuid AND c."sha256"=${item.sha256}
        ON CONFLICT ("projectId","chunkId") DO NOTHING`;
      if (inserted !== 1) {
        const prior = await tx.$queryRaw<Array<{ jobId: string }>>`SELECT "jobId"::text FROM contextflow."SourceChunkEmbedding"
          WHERE "projectId"=${projectId}::uuid AND "chunkId"=${item.id}::uuid`;
        if (prior[0]?.jobId !== jobId) throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_SUCCEEDED');
      }
    }
  }

  async commitSearch(tx: Prisma.TransactionClient, projectId: string, jobId: string, userId: string,
    manifest: AnySearchManifest, output: EmbeddingOutput) {
    await this.validateEmbeddingSubmission(projectId, manifest, tx);
    try { validateEmbeddingOutput(output, manifest.request); } catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED'); }
    if (manifest.request.task !== 'QUERY' || output.task !== 'QUERY' || output.embeddings.length !== 1) {
      throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
    }
    await tx.$queryRaw`SELECT "id" FROM contextflow."Project" WHERE "id"=${projectId}::uuid FOR SHARE`;
    const snapshots = await tx.sourceSnapshot.findMany({ where: { projectId, id: { in: manifest.snapshots.map(row => row.snapshotId) } }, include: {
      fragments: { select: { id: true, startOffset: true, endOffset: true, sha256: true }, orderBy: { ordinal: 'asc' } },
    } });
    const snapshotById = new Map(snapshots.map(row => [row.id, row]));
    for (const frozen of manifest.snapshots) {
      const actual = snapshotById.get(frozen.snapshotId);
      if (!actual || actual.sha256 !== frozen.snapshotSha256 || sha256Text(actual.normalizedText) !== frozen.snapshotSha256) {
        throw new EvidenceServiceError('SOURCE_CHANGED', 'KNOWN_FAILED');
      }
    }
    const vector = `[${output.embeddings[0]!.values.join(',')}]`;
    const indexIds = manifest.indexes.map(row => row.indexId);
    const allChunks = await tx.$queryRaw<DbChunk[]>`SELECT c."id"::text,c."projectId"::text,c."snapshotId"::text,c."snapshotSha256",
      c."startOffset",c."endOffset",c."sha256",c."text",c."ordinal",c."indexId"::text
      FROM contextflow."SourceSearchChunk" c WHERE c."projectId"=${projectId}::uuid AND c."indexId"=ANY(${indexIds}::uuid[])
      ORDER BY c."snapshotId",c."ordinal"`;
    const chunks: SearchChunk[] = allChunks.map(row => ({ id: row.id, projectId: row.projectId, snapshotId: row.snapshotId,
      snapshotSha256: row.snapshotSha256, startOffset: row.startOffset, endOffset: row.endOffset, text: row.text, fragments: [] }));
    const snapshotMetadata = new Map(manifest.snapshots.map(row => [row.snapshotId, row]));
    const substantive = new Map(snapshots.map(row => [row.id,
      substantiveEvidenceRanges(fullSnapshot({ ...row, label: snapshotMetadata.get(row.id)!.label }))]));
    const searchableChunkIds = chunks.filter(chunk => substantive.get(chunk.snapshotId)!.some(range =>
      range.startOffset < chunk.endOffset && range.endOffset > chunk.startOffset)).map(chunk => chunk.id);
    const excludeStructural = manifest.retrievalPolicy.version === 'hybrid-source-v3' || manifest.retrievalPolicy.version === 'hybrid-source-v4';
    const semantic = await tx.$queryRaw<SearchHit[]>`SELECT c."id"::text AS "id", (1-contextflow.source_vector_cosine_distance(e."embedding",${vector}))::float8 AS "score"
      FROM contextflow."SourceSearchChunk" c JOIN contextflow."SourceChunkEmbedding" e
        ON e."projectId"=c."projectId" AND e."chunkId"=c."id"
      WHERE c."projectId"=${projectId}::uuid AND c."indexId"=ANY(${indexIds}::uuid[])
        AND (${!excludeStructural} OR c."id"=ANY(${searchableChunkIds}::uuid[]))
      ORDER BY contextflow.source_vector_cosine_distance(e."embedding",${vector}),c."id" LIMIT 50`;
    const lexical = await tx.$queryRaw<SearchHit[]>`SELECT c."id"::text AS "id",
        ts_rank_cd(c."searchVector",plainto_tsquery('simple',${manifest.query}))::float8 AS "score"
      FROM contextflow."SourceSearchChunk" c
      WHERE c."projectId"=${projectId}::uuid AND c."indexId"=ANY(${indexIds}::uuid[])
        AND (${!excludeStructural} OR c."id"=ANY(${searchableChunkIds}::uuid[]))
        AND c."searchVector" @@ plainto_tsquery('simple',${manifest.query})
      ORDER BY "score" DESC,c."id" LIMIT 50`;
    const ranking = reciprocalRankFusion({ semantic: semantic.map(row => ({ id: row.id, score: row.score })),
      lexical: lexical.map(row => ({ id: row.id, score: row.score })), rankConstant: manifest.retrievalPolicy.rankConstant });
    if (manifest.schemaVersion === 'evidence-search-job-v2') {
      return this.commitRelevanceParent(tx, projectId, jobId, userId, manifest, snapshots, chunks, ranking.results, snapshotMetadata);
    }
    const selection = selectDiversePassages({ chunks, ranking: ranking.results, byteBudget: manifest.retrievalPolicy.byteBudget,
      maxPassages: manifest.retrievalPolicy.maxPassages, adjacentContextChunks: manifest.retrievalPolicy.adjacentContextChunks });
    const spans: Array<{ id: string; snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string;
      sha256: string; snapshotSha256: string; materialId: string; label: string; sequence: number }> = [];
    let candidateCount = selection.candidateCount;
    let hasMore = selection.hasMore;
    if (manifest.retrievalPolicy.version !== 'hybrid-source-v1') {
      const exact = selectEvidenceSpans({ snapshots: snapshots.map(row => fullSnapshot({ ...row, label: snapshotMetadata.get(row.id)!.label })),
        chunks, ranking: ranking.results, windows: selection.passages, query: manifest.query,
        excludeStructural: manifest.retrievalPolicy.version === 'hybrid-source-v3',
        maxPassages: manifest.retrievalPolicy.maxPassages, byteBudget: manifest.retrievalPolicy.byteBudget });
      candidateCount = exact.candidateCount;
      hasMore = hasMore || exact.hasMore;
      for (const source of exact.passages) {
        const metadata = snapshotMetadata.get(source.snapshotId)!;
        spans.push({ ...source, id: randomUUID(), materialId: metadata.materialId, label: metadata.label, sequence: metadata.sequence });
      }
    } else for (const passage of selection.passages) {
      const row = snapshotById.get(passage.snapshotId), metadata = snapshotMetadata.get(passage.snapshotId);
      if (!row || !metadata || passage.snapshotSha256 !== row.sha256 || row.normalizedText.slice(passage.startOffset, passage.endOffset) !== passage.text) {
        throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
      }
      const evidenceSnapshot = fullSnapshot({ ...row, label: metadata.label });
      for (const fragment of row.fragments) {
        const startOffset = Math.max(passage.startOffset, fragment.startOffset), endOffset = Math.min(passage.endOffset, fragment.endOffset);
        if (endOffset <= startOffset) continue;
        const quote = row.normalizedText.slice(startOffset, endOffset);
        if (!quote.trim()) continue;
        const source = validateExactCitation(evidenceSnapshot, { snapshotId: row.id,
          fragmentId: fragment.id, startOffset, endOffset, quote, sha256: sha256Text(quote) });
        spans.push({ id: randomUUID(), snapshotId: row.id, fragmentId: fragment.id, startOffset, endOffset, quote: source.quote,
          sha256: source.sha256, snapshotSha256: source.snapshotSha256, materialId: metadata.materialId, label: metadata.label, sequence: metadata.sequence });
      }
    }
    const packetId = randomUUID();
    const packetManifest = { schemaVersion: 'source-evidence-packet-v1', query: manifest.query, configDigest: indexConfigDigest(manifest.release),
      retrievalPolicy: manifest.retrievalPolicy,
      indexIds, snapshots: manifest.snapshots, searchJobId: jobId, requestHash: embeddingRequestHash(manifest.request),
      channels: ranking.channels, candidateCount, hasMore,
      passages: spans.map((span, ordinal) => ({ id: span.id, snapshotId: span.snapshotId, fragmentId: span.fragmentId,
        startOffset: span.startOffset, endOffset: span.endOffset, sha256: span.sha256, ordinal })) };
    const packetHash = canonicalManifestHash(packetManifest);
    await tx.$executeRaw`INSERT INTO contextflow."SourceEvidencePacket"
      ("id","projectId","jobId","query","manifestJson","sha256","createdBy","createdAt")
      VALUES (${packetId}::uuid,${projectId}::uuid,${jobId}::uuid,${manifest.query},${JSON.stringify(packetManifest)}::jsonb,${packetHash},${userId}::uuid,CURRENT_TIMESTAMP)`;
    const spanRows = spans.map(span => ({ id: span.id, projectId, snapshotId: span.snapshotId, fragmentId: span.fragmentId,
      startOffset: span.startOffset, endOffset: span.endOffset, quote: span.quote, sha256: span.sha256,
      snapshotSha256: span.snapshotSha256, createdBy: userId }));
    for (let offset = 0; offset < spanRows.length; offset += 500) {
      await tx.sourceEvidenceSpan.createMany({ data: spanRows.slice(offset, offset + 500) });
      await tx.sourceEvidencePacketItem.createMany({ data: spanRows.slice(offset, offset + 500).map((span, index) => ({ projectId,
        packetId, spanId: span.id, ordinal: offset + index })) });
    }
    return { packetId, packetHash, passageCount: spans.length, hasMore };
  }

  private async commitRelevanceParent(tx: Prisma.TransactionClient, projectId: string, jobId: string, userId: string,
    manifest: EvidenceSearchV2Manifest, snapshots: Omit<DbSnapshot, 'label'>[], chunks: SearchChunk[], ranking: readonly FusedRank[],
    snapshotMetadata: Map<string, FrozenSnapshot>) {
    const rankedWindows = ranking.slice(0, 50).flatMap(hit => {
      const chunk = chunks.find(row => row.id === hit.id);
      return chunk ? [{ snapshotId: chunk.snapshotId, startOffset: chunk.startOffset, endOffset: chunk.endOffset }] : [];
    });
    const exact = selectEvidenceSpans({ snapshots: snapshots.map(row => fullSnapshot({ ...row,
      label: snapshotMetadata.get(row.id)!.label })), chunks, ranking, windows: rankedWindows, query: manifest.query,
      excludeStructural: true, maxPassages: 60, byteBudget: 60_000, sourceDiversity: false });
    const metadata = new Map(manifest.snapshots.map(row => [row.snapshotId, row]));
    const candidates = exact.passages.map(span => {
      const item = metadata.get(span.snapshotId);
      if (!item || span.snapshotSha256 !== item.snapshotSha256) throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED');
      const frozen = { snapshotId: span.snapshotId, fragmentId: span.fragmentId, startOffset: span.startOffset,
        endOffset: span.endOffset, quote: span.quote, sha256: span.sha256, snapshotSha256: span.snapshotSha256, label: item.label };
      return { ...frozen, id: candidateId(frozen) };
    });
    const parent = await tx.job.findUniqueOrThrow({ where: { id: jobId }, select: { inputHash: true } });
    if (candidates.length === 0) {
      const packetId = randomUUID();
      const packetManifest = { schemaVersion: 'source-evidence-packet-v1', query: manifest.query,
        configDigest: indexConfigDigest(manifest.release), retrievalPolicy: manifest.retrievalPolicy,
        indexIds: manifest.indexes.map(row => row.indexId), snapshots: manifest.snapshots, searchJobId: jobId,
        relevanceJobId: null, relevanceReleaseId: manifest.relevanceRelease.releaseId, relevanceConfigDigest: manifest.relevanceRelease.configDigest,
        relevanceRequestHash: null, candidateIdentityHash: canonicalManifestHash([]), candidateCount: 0,
        usefulCandidateCount: 0, hasMore: exact.hasMore, selectionMode: 'relevance-v1',
        decisions: [], channels: ['semantic', 'lexical'], passages: [] };
      const packetHash = canonicalManifestHash(packetManifest);
      await tx.$executeRaw`INSERT INTO contextflow."SourceEvidencePacket"
        ("id","projectId","jobId","query","manifestJson","sha256","createdBy","createdAt")
        VALUES (${packetId}::uuid,${projectId}::uuid,${jobId}::uuid,${manifest.query},${JSON.stringify(packetManifest)}::jsonb,${packetHash},${userId}::uuid,CURRENT_TIMESTAMP)`;
      return { packetId, packetHash, passageCount: 0, hasMore: exact.hasMore, candidateCount: 0 };
    }
    const request = relevanceInputSchema.parse({ schemaVersion: 'source-relevance-request-v1', requestId: randomUUID(),
      query: manifest.query, candidates });
    const childManifest = evidenceRelevanceManifestSchema.parse({ schemaVersion: 'evidence-relevance-job-v1',
      commandKey: relevanceCommandKey(jobId), parentJobId: jobId, parentInputHash: parent.inputHash, query: manifest.query,
      snapshots: manifest.snapshots, indexes: manifest.indexes, retrievalPolicy: manifest.retrievalPolicy,
      embeddingRelease: manifest.release, release: manifest.relevanceRelease, request,
      candidateCount: exact.candidateCount, hasMore: exact.hasMore,
      noticeVersion: manifest.noticeVersion, acceptedAt: manifest.acceptedAt });
    const child = await this.jobs.create(tx, { projectId, userId, operation: 'EVIDENCE_SEARCH',
      contractVersion: EVIDENCE_RELEVANCE_CONTRACT, commandKey: childManifest.commandKey,
      inputManifest: asJson(childManifest), deadlineMs: JOB_DEADLINE_MS });
    return { relevanceJobId: child.id, candidateCount: exact.candidateCount, hasMore: exact.hasMore };
  }

  async commitRelevance(tx: Prisma.TransactionClient, projectId: string, jobId: string, userId: string,
    rawManifest: EvidenceRelevanceManifest, rawOutput: unknown) {
    let manifest: EvidenceRelevanceManifest;
    try { manifest = evidenceRelevanceManifestSchema.parse(rawManifest); }
    catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED'); }
    await this.validateRelevanceSubmission(projectId, manifest, tx);
    let output: RelevanceOutput;
    try { output = validateRelevanceOutput(rawOutput, manifest.request); }
    catch { throw new EvidenceServiceError('INVALID_CONTRACT', 'KNOWN_FAILED'); }
    const parent = await tx.job.findFirst({ where: { id: manifest.parentJobId, projectId, operation: 'EVIDENCE_SEARCH',
      contractVersion: EVIDENCE_SEARCH_V2_CONTRACT }, select: { id: true, requestedBy: true, inputHash: true, resultRefs: true } });
    const refs = parent?.resultRefs as { relevanceJobId?: unknown } | null;
    if (!parent || parent.inputHash !== manifest.parentInputHash || parent.requestedBy !== userId
      || refs?.relevanceJobId !== jobId) throw new EvidenceServiceError('SOURCE_CHANGED', 'KNOWN_FAILED');
    const snapshots = await tx.sourceSnapshot.findMany({ where: { projectId, id: { in: manifest.snapshots.map(row => row.snapshotId) } },
      include: { fragments: { select: { id: true, startOffset: true, endOffset: true, sha256: true }, orderBy: { ordinal: 'asc' } } } });
    const snapshotMap = new Map(snapshots.map(row => [row.id, row]));
    const selected = selectRelevantCandidates({ candidates: manifest.request.candidates, output,
      maxPassages: manifest.retrievalPolicy.maxPassages, byteBudget: manifest.retrievalPolicy.byteBudget });
    const decisionMap = new Map(output.decisions.map(row => [row.id, row]));
    const spans = selected.candidates.map(candidate => {
      const snapshot = snapshotMap.get(candidate.snapshotId);
      const metadata = manifest.snapshots.find(row => row.snapshotId === candidate.snapshotId);
      if (!snapshot || !metadata || snapshot.sha256 !== candidate.snapshotSha256
        || sha256Text(snapshot.normalizedText) !== snapshot.sha256) throw new EvidenceServiceError('SOURCE_CHANGED', 'KNOWN_FAILED');
      const source = validateExactCitation(fullSnapshot({ ...snapshot, label: metadata.label }), {
        snapshotId: candidate.snapshotId, fragmentId: candidate.fragmentId, startOffset: candidate.startOffset,
        endOffset: candidate.endOffset, quote: candidate.quote, sha256: candidate.sha256 });
      return { id: randomUUID(), relevanceId: candidate.id, relevance: decisionMap.get(candidate.id)!.relevance,
        snapshotId: source.snapshotId, fragmentId: source.fragmentId,
        startOffset: source.startOffset, endOffset: source.endOffset, quote: source.quote, sha256: source.sha256,
        snapshotSha256: source.snapshotSha256, materialId: metadata.materialId, label: metadata.label, sequence: metadata.sequence };
    });
    const packetId = randomUUID();
    const packetManifest = { schemaVersion: 'source-evidence-packet-v1', query: manifest.query,
      configDigest: indexConfigDigest(manifest.embeddingRelease), retrievalPolicy: manifest.retrievalPolicy,
      indexIds: manifest.indexes.map(row => row.indexId), snapshots: manifest.snapshots, searchJobId: manifest.parentJobId,
      relevanceJobId: jobId, relevanceReleaseId: manifest.release.releaseId, relevanceConfigDigest: manifest.release.configDigest,
      relevanceRequestId: manifest.request.requestId, relevanceRequestHash: relevanceInputHash(manifest.request),
      candidateIdentityHash: canonicalManifestHash(manifest.request.candidates.map(({ id, snapshotId, fragmentId, startOffset,
        endOffset, sha256, snapshotSha256 }) => ({ id, snapshotId, fragmentId, startOffset, endOffset, sha256, snapshotSha256 }))),
      candidateCount: manifest.candidateCount, usefulCandidateCount: selected.usefulCount,
      hasMore: manifest.hasMore || selected.hasMore, selectionMode: 'relevance-v1',
      decisions: output.decisions.map(row => ({ ...row, rank: output.rankedIds.indexOf(row.id) })),
      channels: ['semantic', 'lexical'],
      passages: spans.map((span, ordinal) => ({ id: span.id, snapshotId: span.snapshotId, fragmentId: span.fragmentId,
        startOffset: span.startOffset, endOffset: span.endOffset, sha256: span.sha256, ordinal,
        relevanceId: span.relevanceId, relevance: span.relevance })) };
    const packetHash = canonicalManifestHash(packetManifest);
    await tx.$executeRaw`INSERT INTO contextflow."SourceEvidencePacket"
      ("id","projectId","jobId","query","manifestJson","sha256","createdBy","createdAt")
      VALUES (${packetId}::uuid,${projectId}::uuid,${manifest.parentJobId}::uuid,${manifest.query},${JSON.stringify(packetManifest)}::jsonb,${packetHash},${userId}::uuid,CURRENT_TIMESTAMP)`;
    const rows = spans.map(span => ({ id: span.id, projectId, snapshotId: span.snapshotId, fragmentId: span.fragmentId,
      startOffset: span.startOffset, endOffset: span.endOffset, quote: span.quote, sha256: span.sha256,
      snapshotSha256: span.snapshotSha256, createdBy: userId }));
    for (let offset = 0; offset < rows.length; offset += 500) {
      await tx.sourceEvidenceSpan.createMany({ data: rows.slice(offset, offset + 500) });
      await tx.sourceEvidencePacketItem.createMany({ data: rows.slice(offset, offset + 500).map((span, index) => ({ projectId,
        packetId, spanId: span.id, ordinal: offset + index })) });
    }
    return { packetId, parentJobId: manifest.parentJobId, packetHash, passageCount: spans.length,
      hasMore: manifest.hasMore || selected.hasMore };
  }

  /** Resolves a stable v2 search id to its relevance child without exposing packets early. */
  async resolveSearchJob(projectId: string, rootJobId: string,
    db: PrismaClient | Prisma.TransactionClient = this.prisma) {
    const rootJob = await db.job.findFirst({ where: { id: rootJobId, projectId, operation: 'EVIDENCE_SEARCH' } });
    if (!rootJob) throw new NotFoundException('Evidence search job not found');
    const rootRefs = rootJob.resultRefs as { packetId?: unknown; relevanceJobId?: unknown } | null;
    if (rootJob.contractVersion !== EVIDENCE_SEARCH_V2_CONTRACT) {
      const packetId = typeof rootRefs?.packetId === 'string' && rootJob.status === 'SUCCEEDED' ? rootRefs.packetId : null;
      return { rootJob, job: rootJob, packetId, relevancePending: false };
    }
    let manifest: EvidenceSearchV2Manifest;
    try { manifest = evidenceSearchV2ManifestSchema.parse(rootJob.inputManifest); }
    catch { throw new ConflictException('Evidence search manifest is invalid'); }
    if (typeof rootRefs?.relevanceJobId !== 'string') {
      const packetId = typeof rootRefs?.packetId === 'string' && rootJob.status === 'SUCCEEDED' ? rootRefs.packetId : null;
      if (rootJob.status === 'SUCCEEDED' && !packetId) throw new ConflictException('Completed evidence search has no final packet');
      return { rootJob, job: rootJob, packetId, relevancePending: false };
    }
    const child = await db.job.findFirst({ where: { id: rootRefs.relevanceJobId, projectId, operation: 'EVIDENCE_SEARCH',
      contractVersion: EVIDENCE_RELEVANCE_CONTRACT } });
    if (!child) throw new ConflictException('Evidence relevance job link is invalid');
    let childManifest: EvidenceRelevanceManifest;
    try { childManifest = evidenceRelevanceManifestSchema.parse(child.inputManifest); }
    catch { throw new ConflictException('Evidence relevance manifest is invalid'); }
    if (child.requestedBy !== rootJob.requestedBy || childManifest.parentJobId !== rootJob.id
      || childManifest.parentInputHash !== rootJob.inputHash || rootJob.status !== 'SUCCEEDED'
      || childManifest.query !== manifest.query || child.commandKey !== relevanceCommandKey(rootJob.id)
      || child.inputHash !== canonicalManifestHash({ contractVersion: EVIDENCE_RELEVANCE_CONTRACT, inputManifest: childManifest })
      || canonicalManifestHash(childManifest.snapshots) !== canonicalManifestHash(manifest.snapshots)
      || canonicalManifestHash(childManifest.indexes) !== canonicalManifestHash(manifest.indexes)
      || canonicalManifestHash(childManifest.retrievalPolicy) !== canonicalManifestHash(manifest.retrievalPolicy)
      || canonicalManifestHash(childManifest.embeddingRelease) !== canonicalManifestHash(manifest.release)
      || canonicalManifestHash(childManifest.release) !== canonicalManifestHash(manifest.relevanceRelease)) {
      throw new ConflictException('Evidence relevance job does not match its parent search');
    }
    const childRefs = child.resultRefs as { packetId?: unknown; parentJobId?: unknown } | null;
    let packetId: string | null = null;
    if (child.status === 'SUCCEEDED') {
      const candidatePacketId = typeof childRefs?.packetId === 'string' ? childRefs.packetId : null;
      const packet = candidatePacketId ? await db.sourceEvidencePacket.findFirst({ where: { id: candidatePacketId,
        projectId, jobId: rootJob.id }, select: { id: true } }) : null;
      if (!candidatePacketId || !packet || childRefs?.parentJobId !== rootJob.id) {
        throw new ConflictException('Completed relevance job has no matching final packet');
      }
      packetId = candidatePacketId;
    }
    return { rootJob, job: child, packetId, relevancePending: !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(child.status) };
  }

  async result(userId: string, projectId: string, jobId: string) {
    return this.withReadableTransaction(userId, projectId, async tx => {
      const resolved = await this.resolveSearchJob(projectId, jobId, tx);
      const { rootJob, job: effectiveJob } = resolved;
      let packet: null | { id: string; query: string; searchMode: 'hybrid'; selectionMode?: 'relevance-v1'; hasMore: boolean; passages: unknown[] } = null;
      if (effectiveJob.status === 'SUCCEEDED' && resolved.packetId) {
        const rows = await tx.$queryRaw<Array<{ packetId: string; query: string; manifestJson: unknown; spanId: string;
        snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string; sha256: string; ordinal: number }>>`
        SELECT p."id"::text AS "packetId",p."query",p."manifestJson",s."id"::text AS "spanId",s."snapshotId"::text,s."fragmentId"::text,
          s."startOffset",s."endOffset",s."quote",s."sha256",i."ordinal"
        FROM contextflow."SourceEvidencePacket" p LEFT JOIN contextflow."SourceEvidencePacketItem" i
          ON i."projectId"=p."projectId" AND i."packetId"=p."id"
        LEFT JOIN contextflow."SourceEvidenceSpan" s ON s."projectId"=i."projectId" AND s."id"=i."spanId"
        WHERE p."projectId"=${projectId}::uuid AND p."jobId"=${rootJob.id}::uuid AND p."id"=${resolved.packetId}::uuid ORDER BY i."ordinal"`;
        if (rows.length && rows[0]?.packetId) {
          const manifest = rows[0]!.manifestJson as { hasMore?: boolean; selectionMode?: 'relevance-v1' };
          const input = rootJob.inputManifest as unknown as SearchManifest | EvidenceSearchV2Manifest;
          const snapshots = new Map(input.snapshots.map(row => [row.snapshotId, row]));
          packet = { id: rows[0]!.packetId, query: rows[0]!.query, searchMode: 'hybrid',
            ...(manifest.selectionMode === 'relevance-v1' ? { selectionMode: 'relevance-v1' as const } : {}), hasMore: !!manifest.hasMore,
            passages: rows.filter(row => row.spanId).map(row => { const source = snapshots.get(row.snapshotId); return {
              id: row.spanId, snapshotId: row.snapshotId, fragmentId: row.fragmentId, startOffset: row.startOffset, endOffset: row.endOffset,
              quote: row.quote, sha256: row.sha256, materialId: source?.materialId ?? '', materialLabel: source?.label ?? '',
              snapshotSequence: source?.sequence ?? 0,
            }; }) };
        }
      }
      return { job: { id: rootJob.id, status: effectiveJob.status,
        progressStage: resolved.relevancePending && ['QUEUED', 'RUNNING'].includes(effectiveJob.status)
          ? 'CHECKING_RELEVANCE' : effectiveJob.progressStage,
        errorCategory: effectiveJob.errorCategory, retryAllowed: retryAllowed(effectiveJob) }, packet };
    });
  }
}
