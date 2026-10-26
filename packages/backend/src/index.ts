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
export { SourceEvidenceService } from './evidence/evidence.service.js';
export { createSourceEvidenceJobHandlers } from './evidence/jobs-handler.js';
export { indexSourceEvidenceInput, searchSourceEvidenceInput, embeddingRequestSchema, embeddingOutputSchema,
  validateEmbeddingOutput, embeddingRequestHash } from './evidence/contracts.js';
export { DifyEmbeddingProvider, EmbeddingProviderError, embeddingWorkflowRelease, embeddingWorkflowSettings } from './evidence/embedding-provider.js';
export { relevanceInputSchema, relevanceOutputSchema, relevanceInputHash, validateRelevanceOutput,
  RELEVANCE_LIMITS } from './evidence/relevance-contracts.js';
export type { RelevanceInput, RelevanceOutput, RelevanceCandidate } from './evidence/relevance-contracts.js';
export { DifySourceRelevanceProvider, SourceRelevanceProviderError, sourceRelevanceWorkflowRelease,
  sourceRelevanceWorkflowSettings } from './evidence/relevance-provider.js';
export { ContentMode, EditorialOrigin } from './generated/prisma/enums.js';
export { EditorialService, canonicalBriefHash } from './editorial/editorial.service.js';
export { saveBriefInput, manualOutlineInput, reviewOutlineInput, generateOutlineInput, outlineContentSchema,
  outlineOutputSchema, outlineInputManifestSchema } from './editorial/contracts.js';
export type { SaveBriefInput, ManualOutlineInput, OutlineContent, OutlineOutput, OutlineWorkflowRelease, OutlineInputManifest } from './editorial/contracts.js';
export { DifyOutlineProvider, OutlineProviderError, outlineWorkflowRelease, outlineWorkflowSettings, OUTLINE_CONTRACT } from './editorial/provider.js';
export type { OutlineProviderInput, OutlineWorkflowSettings } from './editorial/provider.js';
export { createOutlineJobHandler } from './editorial/jobs-handler.js';
export { ArticleService } from './editorial/article.service.js';
export { ArticleAnnotationService } from './editorial/article-annotation.service.js';
export { createArticleAnnotationInput, replyArticleAnnotationInput, actArticleAnnotationInput, listArticleAnnotationsInput } from './editorial/article-annotations.js';
export { articleContentSchema, articleDocumentDetails, saveArticleDraftInput, importArticleInput, checkpointArticleInput,
  reviewArticleInput, generateArticleInput, articleInputManifestSchema, articleOutputSchema, articleWorkflowReleaseSchema } from './editorial/article-contracts.js';
export type { ArticleContent, ArticleNode, ArticleMark, ArticleMapping, ArticleInputManifest, ArticleOutput, ArticleWorkflowRelease } from './editorial/article-contracts.js';
export { DifyArticleProvider, ArticleProviderError, articleWorkflowRelease, articleWorkflowSettings, ARTICLE_CONTRACT } from './editorial/article-provider.js';
export type { ArticleProviderInput, ArticleWorkflowSettings } from './editorial/article-provider.js';
export { createArticleJobHandler } from './editorial/article-jobs-handler.js';
export { TelegramService } from './editorial/telegram.service.js';
export { ScriptService } from './editorial/script.service.js';
export { VisualService } from './visuals/visual.service.js';
export { VisualRenderer } from './visuals/visual-renderer.js';
export { VisualBackgroundService } from './visuals/background.service.js';
export { createBackgroundJobHandler } from './visuals/background-jobs-handler.js';
export { DifyBackgroundProvider, BackgroundProviderError, backgroundWorkflowRelease, backgroundWorkflowSettings } from './visuals/background-provider.js';
export { backgroundGenerateSchema, backgroundApplySchema } from './visuals/background-contracts.js';
export { ScriptLanguageService } from './editorial/script-language.service.js';
export { scriptContentSchema, scriptFrameSchema, scriptMappingSchema, scriptSaveDraftInput, scriptCheckpointInput, scriptReviewInput } from './editorial/script-contracts.js';
export type { ScriptContent, ScriptFrame } from './editorial/script-contracts.js';
export { scriptLanguageReviewInput, scriptLanguageAcceptInput } from './editorial/script-language.service.js';
export { LanguageSuggestionService } from './editorial/language-suggestion.service.js';
export { languageSuggestionTargetType, languageSuggestionLocator, reviewLanguageSuggestionsInput, listLanguageSuggestionsInput,
  acceptLanguageSuggestionsInput, rejectLanguageSuggestionInput } from './editorial/language-suggestion-contracts.js';
export type { ReviewLanguageSuggestionsInput, ListLanguageSuggestionsInput, AcceptLanguageSuggestionsInput } from './editorial/language-suggestion-contracts.js';
export { telegramContentSchema, telegramOutputSchema, telegramInputManifestSchema, telegramWorkflowReleaseSchema,
  adaptationFormatSchema, validateFormatContent, saveTelegramDraftInput, checkpointTelegramInput, reviewTelegramInput, rereviewTelegramInput, generateTelegramInput } from './editorial/telegram-contracts.js';
export type { AdaptationFormat, TelegramContent, TelegramOutput, TelegramInputManifest, TelegramWorkflowRelease, SaveTelegramDraftInput, ReviewTelegramInput, GenerateTelegramInput } from './editorial/telegram-contracts.js';
export { DifyTelegramProvider, TelegramProviderError, telegramWorkflowRelease, telegramWorkflowSettings, TELEGRAM_CONTRACT } from './editorial/telegram-provider.js';
export type { TelegramProviderInput, TelegramWorkflowSettings } from './editorial/telegram-provider.js';
export { createTelegramJobHandler } from './editorial/telegram-jobs-handler.js';
export { ExportService } from './export/export.service.js';
export { createExportJobHandler } from './export/export-jobs-handler.js';
export { createExportInput, exportManifestSchema, exportJobManifestSchema } from './export/export-contracts.js';
export type { CreateExportInput, ExportManifest, ExportManifestItem, ExportJobManifest } from './export/export-contracts.js';
export { renderExportFiles, zipExportFiles } from './export/export-renderer.js';
export { GoogleOAuthClient, GoogleOAuthError, GOOGLE_DOCS_FILE_SCOPE } from './google-docs/google-oauth-client.js';
export type { GoogleOAuthTokens, GoogleOAuthClientOptions } from './google-docs/google-oauth-client.js';
export { GoogleOAuthCrypto } from './google-docs/google-oauth-crypto.js';
export type { GoogleOAuthCiphertext, GoogleOAuthKeyring, StoredGoogleOAuthTokens } from './google-docs/google-oauth-crypto.js';
export { GoogleDocsClient, GoogleDocsApiError, GoogleDocsPartialUpdateError } from './google-docs/google-docs-client.js';
export type { GoogleDocsDocument, GoogleDocsBatchResponse, GoogleDocsClientOptions } from './google-docs/google-docs-client.js';
export { googleTabToArticleContent, articleContentToGoogleRequests, mapGoogleRangeToArticle } from './google-docs/article-conversion.js';
export type { GoogleTabImportResult } from './google-docs/article-conversion.js';
export { loadGoogleOAuthRuntime } from './google-docs/google-oauth-runtime.js';
export type { GoogleOAuthRuntime } from './google-docs/google-oauth-runtime.js';
export { GoogleSyncCredentials } from './google-docs/google-sync-credentials.js';
export type { GoogleSyncCredentialsContext } from './google-docs/google-sync-credentials.js';
export * from './google-docs/google-doc-sync-contracts.js';
export { GoogleDocSyncService } from './google-docs/google-doc-sync.service.js';
export { createGoogleDocSyncHandler } from './google-docs/google-doc-sync-handler.js';
export { GoogleDocSyncPoller } from './google-docs/google-doc-sync-poller.js';
export { PrivateObjectCleanup, PrivateObjectCleanupPoller } from './lifecycle/private-object-cleanup.js';
export { SourceGroundingService } from './evidence/source-grounding.service.js';
export { SourcePreparationService, SourcePreparationPoller } from './evidence/preparation.service.js';
export { SourceArticlePreparationService, SourceArticlePreparationPoller } from './evidence/article-preparation.service.js';
export { createSourceWritingJobHandler } from './evidence/writing-jobs-handler.js';
export { sourceWritingWorkflowRelease, sourceWritingWorkflowSettings, DifySourceWritingProvider, SourceWritingProviderError } from './evidence/writing-provider.js';
export { sourceWritingInputSchema, sourceWritingOutputSchema, validateSourceWritingOutput } from './evidence/writing-contracts.js';
export { BriefProposalService } from './editorial/brief-proposal.service.js';
export { createBriefProposalJobHandler } from './editorial/brief-proposal-jobs-handler.js';
export { briefProposalCommandSchema, briefProposalWorkflowInputSchema, briefProposalOutputSchema, validateBriefProposalOutput } from './editorial/brief-proposal-contracts.js';
export type { BriefProposalFields, BriefProposalCommand, BriefProposalWorkflowInput, BriefProposalWorkflowOutput } from './editorial/brief-proposal-contracts.js';
export { briefProposalWorkflowRelease, briefProposalWorkflowSettings } from './editorial/brief-proposal-provider.js';
