import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { PrivateAssetStore } from '../storage/private-asset-store.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../external-processing-notice.js';
import { validateDigitalDocument, ImportValidationError } from './document-validation.js';
import { ImportProviders, ImportProviderError, DOCLING_OPTIONS, FIRECRAWL_OPTIONS, IMPORT_CONTRACT } from './providers.js';
import { importedFragments, normalizeImportedText } from './source-text.js';

const manifestSchema = z.object({ materialId: z.uuid(), expectedRevision: z.number().int().positive(), expectedSnapshotId: z.uuid().nullable().optional(),
  label: z.string().min(1).max(200), noticeVersion: z.string(), acceptedAt: z.iso.datetime(),
  sourceUrl: z.string().max(2048).optional(), originalAssetId: z.uuid().optional(), originalFilename: z.string().max(255).optional(),
  mediaType: z.string().max(200).optional(), originalSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  settings: z.object({ firecrawlEndpoint: z.string(), firecrawlVersion: z.string(), remotePolicyDigest: z.string(), doclingEndpoint: z.string(), doclingVersion: z.string() }).strict(),
  options: z.unknown(), requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const resultSchema = z.object({ text: z.string().max(200_000), metadata: z.record(z.string(), z.unknown()) }).strict();
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
function failure(error: unknown): never {
  if (error instanceof JobFailure || error instanceof JobFenceLost) throw error;
  if (error instanceof ImportProviderError) throw new JobFailure(error.code === 'TRANSIENT' ? 'RATE_LIMIT' : error.code,
    error.code === 'UNKNOWN_OUTCOME' ? 'UNKNOWN' : 'KNOWN_FAILED');
  if (error instanceof ImportValidationError) throw new JobFailure(error.code, 'NOT_SUBMITTED');
  throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
}

export function createImportJobHandlers(dependencies: { prisma: PrismaClient; assets: PrivateAssetStore; providers?: ImportProviders }): JobHandler[] {
  const providers = dependencies.providers ?? new ImportProviders();
  return (['WEB_IMPORT', 'DOCUMENT_IMPORT'] as const).map(operation => ({ operation,
    async execute(context) {
      try {
        if (context.job.contractVersion !== IMPORT_CONTRACT) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
        const manifest = manifestSchema.parse(context.job.inputManifest);
        if (manifest.noticeVersion !== EXTERNAL_PROCESSING_NOTICE.version) throw new JobFailure('INVALID_CONTRACT', 'NOT_SUBMITTED');
        const expectedOptions = operation === 'WEB_IMPORT' ? FIRECRAWL_OPTIONS : DOCLING_OPTIONS;
        if (canonicalManifestHash(manifest.options) !== canonicalManifestHash(expectedOptions)) throw new JobFailure('CONFIG_CHANGED', 'NOT_SUBMITTED');
        const material = await dependencies.prisma.material.findFirst({ where: { id: manifest.materialId, projectId: context.job.projectId },
          select: { id: true, kind: true, sourceUrl: true, originalAssetId: true, originalFilename: true } });
        if (!material) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
        await context.setProgress('VALIDATING_INPUT');
        if (operation === 'WEB_IMPORT') {
          if (material.kind !== 'URL' || !manifest.sourceUrl || material.sourceUrl !== manifest.sourceUrl) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
          return await providers.web(manifest.sourceUrl, manifest.settings, context.signal, () => context.recordSubmissionIntent());
        }
        if (material.kind !== 'FILE' || !manifest.originalAssetId || material.originalAssetId !== manifest.originalAssetId || material.originalFilename !== manifest.originalFilename
          || !manifest.originalFilename || !manifest.mediaType || !manifest.originalSha256) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
        const asset = await dependencies.prisma.asset.findFirst({ where: { id: manifest.originalAssetId, projectId: context.job.projectId,
          state: 'AVAILABLE', purpose: 'ORIGINAL', sha256: manifest.originalSha256, mediaType: manifest.mediaType }, select: { bucket: true, objectKey: true, bytes: true } });
        if (!asset) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
        const bytes = await dependencies.assets.read(asset.bucket, asset.objectKey, manifest.originalSha256);
        if (BigInt(bytes.length) !== asset.bytes) throw new JobFailure('INVALID_SOURCE', 'NOT_SUBMITTED');
        const document = validateDigitalDocument({ originalname: manifest.originalFilename, mimetype: manifest.mediaType, buffer: bytes, size: bytes.length });
        return await providers.document(document, manifest.settings, context.signal, () => context.recordSubmissionIntent());
      } catch (error) { return failure(error); }
    },
    async commit(tx, raw, job) {
      try {
        const manifest = manifestSchema.parse(job.inputManifest), result = resultSchema.parse(raw);
        const metadata = result.metadata;
        if (manifest.noticeVersion !== EXTERNAL_PROCESSING_NOTICE.version || metadata['schemaVersion'] !== IMPORT_CONTRACT
          || !z.iso.datetime().safeParse(metadata['retrievedAt']).success || Buffer.byteLength(JSON.stringify(metadata)) > 200_000
          || metadata['provider'] !== (operation === 'WEB_IMPORT' ? 'firecrawl' : 'docling')
          || metadata['version'] !== (operation === 'WEB_IMPORT' ? manifest.settings.firecrawlVersion : manifest.settings.doclingVersion)
          || operation === 'WEB_IMPORT' && (metadata['requestedUrl'] !== manifest.sourceUrl || metadata['policyDigest'] !== manifest.settings.remotePolicyDigest)
          || operation === 'DOCUMENT_IMPORT' && metadata['originalSha256'] !== manifest.originalSha256) {
          throw new JobFailure('INVALID_CONTRACT', 'KNOWN_FAILED');
        }
        const text = normalizeImportedText(result.text), fragments = importedFragments(text);
        const priorAccepted = await tx.sourceSnapshot.findFirst({ where: { jobId: job.id }, select: { id: true, materialId: true } });
        if (priorAccepted) return { materialId: priorAccepted.materialId, snapshotId: priorAccepted.id };
        await tx.$queryRaw`SELECT "id" FROM contextflow."Material" WHERE "id" = ${manifest.materialId}::uuid AND "projectId" = ${job.projectId}::uuid FOR UPDATE`;
        const material = await tx.material.findFirst({ where: { id: manifest.materialId, projectId: job.projectId }, select: { revision: true, currentSnapshotId: true } });
        // Legacy manifests retain their conservative revision fence. New inputs
        // fence content only, allowing selection/label edits for future work.
        if (!material || (manifest.expectedSnapshotId === undefined
          ? material.revision !== manifest.expectedRevision : material.currentSnapshotId !== manifest.expectedSnapshotId)) {
          throw new JobFailure('SOURCE_CHANGED', 'KNOWN_FAILED');
        }
        const previous = await tx.sourceSnapshot.findFirst({ where: { projectId: job.projectId, materialId: manifest.materialId }, orderBy: { sequence: 'desc' }, select: { id: true, sequence: true } });
        const snapshot = await tx.sourceSnapshot.create({ data: { id: randomUUID(), projectId: job.projectId, materialId: manifest.materialId,
          sequence: (previous?.sequence ?? 0) + 1, normalizedText: text, sha256: createHash('sha256').update(Buffer.from(text)).digest('hex'),
          bytes: Buffer.byteLength(text), origin: operation, originalAssetId: manifest.originalAssetId ?? null,
          originalFilename: manifest.originalFilename ?? null, previousSnapshotId: previous?.id ?? null, createdBy: job.requestedBy,
          jobId: job.id, providerMetadata: json(result.metadata) } });
        await tx.sourceFragment.createMany({ data: fragments.map(fragment => ({ ...fragment, projectId: job.projectId, snapshotId: snapshot.id })) });
        await tx.material.update({ where: { projectId_id: { projectId: job.projectId, id: manifest.materialId } }, data: {
          currentSnapshotId: snapshot.id, revision: { increment: 1 }, updatedAt: new Date() } });
        return { materialId: manifest.materialId, snapshotId: snapshot.id };
      } catch (error) { return failure(error); }
    },
  }));
}
