import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { articleContentSchema, articleDocumentDetails } from '../editorial/article-contracts.js';
import type { ArticleService } from '../editorial/article.service.js';
import { canonicalManifestHash } from '../jobs/job-service.js';

/** The complete approved text is editorial context; only its frozen passages are factual evidence. */
export async function sourceArticleContext(tx: Prisma.TransactionClient, projectId: string, articles: ArticleService) {
  const article = await tx.article.findUnique({ where: { projectId } });
  const version = article?.currentApprovedVersionId
    ? await tx.articleVersion.findFirst({ where: { id: article.currentApprovedVersionId, projectId }, include: { claims: true } }) : null;
  if (!version || !version.approvedAt || version.withdrawnAt || !version.sourceEvidenceSetId || !version.sourceEvidenceSealed
    || canonicalManifestHash(version.content) !== version.sha256 || !(await articles.inspectVersion(tx,projectId,version)).eligible) {
    throw new ConflictException('A current reviewed source-grounded Article is required');
  }
  const content = articleContentSchema.parse(version.content), text = articleDocumentDetails(content).plainText;
  if (!text.trim() || text.length > 100000) throw new ConflictException('INPUT_TOO_LARGE');
  return { sourceEvidenceSetId: version.sourceEvidenceSetId, briefRevisionId: version.briefRevisionId,
    approvedArticle: { versionId: version.id, sha256: version.sha256, title: content.title, text } };
}
