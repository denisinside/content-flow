import { Module } from '@nestjs/common';
import { loadRuntimeConfig } from './config.js';
import { DependencyHealthService } from './dependency-health.js';

@Module({
  providers: [{ provide: DependencyHealthService, useFactory: () => new DependencyHealthService(loadRuntimeConfig()) }],
  exports: [DependencyHealthService]
})
export class FoundationModule {}

export { DependencyHealthService } from './dependency-health.js';
export type { DependencyHealth } from './dependency-health.js';
export { ConfigurationError, loadRuntimeConfig, parseRuntimeConfig } from './config.js';
export type { BackendConfig } from './config.js';
export { databasePoolOptions } from './database-connection.js';
export type { Prisma } from './generated/prisma/client.js';
export { ProjectFormat, AssetState, AssetPurpose, MaterialKind, MaterialPurpose, SourceOrigin } from './generated/prisma/enums.js';
export { JobOperation, JobStatus, ProviderOutcome } from './generated/prisma/enums.js';
export { ClaimStatus, EvidenceRelation, ConflictOrigin, AIExecutionStatus } from './generated/prisma/enums.js';
export { validateDigitalDocument, originalFilename, DOCUMENT_MAX_BYTES, ImportValidationError } from './imports/document-validation.js';
export type { DigitalDocument } from './imports/document-validation.js';
export { normalizeImportUrl, validatePublicUrl, publicAddress, resolveAddresses } from './imports/url-validation.js';
export type { ResolveAddresses } from './imports/url-validation.js';
export { ImportProviders, ImportProviderError, IMPORT_CONTRACT, DOCLING_VERSION, FIRECRAWL_OPTIONS, DOCLING_OPTIONS, importProviderSettings, safeImportError, isOfficialFirecrawlCloud } from './imports/providers.js';
export type { ImportProviderSettings, ImportedSource } from './imports/providers.js';
export { normalizeImportedText, importedFragments } from './imports/source-text.js';
export { PrivateAssetStore, privateStorageConfig, STORAGE_MAX_BYTES } from './storage/private-asset-store.js';
export type { PrivateStorageConfig } from './storage/private-asset-store.js';
export { DurableJobService, JobFailure, JobFenceLost, DurableJobWorker, canonicalManifestHash, jobView, JOB_QUEUE, retryAllowed } from './jobs/index.js';
export type { JobHandler, JobContext, CreateJobInput, JobCommitResult } from './jobs/index.js';
export { createImportJobHandlers } from './imports/jobs-handler.js';
export { EXTERNAL_PROCESSING_NOTICE } from './external-processing-notice.js';
export { createClaimInput, editClaimInput, reviewClaimInput, invalidateEvidenceInput, createConflictInput,
  resolveConflictInput, reopenConflictInput, freezeBasisInput, extractClaimsInput, claimInputManifestSchema, claimsOutputSchema } from './claims/contracts.js';
export type { EvidenceInput, CreateClaimInput, EditClaimInput, ClaimInputManifest, ClaimWorkflowRelease, ClaimsOutput } from './claims/contracts.js';
export { DifyClaimProvider, ClaimProviderError, claimWorkflowRelease, claimWorkflowSettings, CLAIMS_CONTRACT } from './claims/provider.js';
export { FactualBasisService } from './claims/factual-basis.service.js';
export { createClaimJobHandler } from './claims/jobs-handler.js';
export { ContentMode, EditorialOrigin } from './generated/prisma/enums.js';
export { EditorialService, canonicalBriefHash } from './editorial/editorial.service.js';
export { saveBriefInput, manualOutlineInput, reviewOutlineInput, generateOutlineInput, outlineContentSchema,
  outlineOutputSchema, outlineInputManifestSchema } from './editorial/contracts.js';
export type { SaveBriefInput, ManualOutlineInput, OutlineContent, OutlineOutput, OutlineWorkflowRelease, OutlineInputManifest } from './editorial/contracts.js';
export { DifyOutlineProvider, OutlineProviderError, outlineWorkflowRelease, outlineWorkflowSettings, OUTLINE_CONTRACT } from './editorial/provider.js';
export type { OutlineProviderInput, OutlineWorkflowSettings } from './editorial/provider.js';
export { createOutlineJobHandler } from './editorial/jobs-handler.js';
export { ArticleService } from './editorial/article.service.js';
export { articleContentSchema, articleDocumentDetails, saveArticleDraftInput, importArticleInput, checkpointArticleInput,
  reviewArticleInput, generateArticleInput, articleInputManifestSchema, articleOutputSchema, articleWorkflowReleaseSchema } from './editorial/article-contracts.js';
export type { ArticleContent, ArticleNode, ArticleMark, ArticleMapping, ArticleInputManifest, ArticleOutput, ArticleWorkflowRelease } from './editorial/article-contracts.js';
export { DifyArticleProvider, ArticleProviderError, articleWorkflowRelease, articleWorkflowSettings, ARTICLE_CONTRACT } from './editorial/article-provider.js';
export type { ArticleProviderInput, ArticleWorkflowSettings } from './editorial/article-provider.js';
export { createArticleJobHandler } from './editorial/article-jobs-handler.js';
