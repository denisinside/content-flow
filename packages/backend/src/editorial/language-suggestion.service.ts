import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { articleContentSchema, articleDocumentDetails, type ArticleContent, type ArticleNode } from './article-contracts.js';
import { applyInlineReplacement } from './article-annotation.service.js';
import { telegramContentSchema, validateFormatContent, type AdaptationFormat, type TelegramContent } from './telegram-contracts.js';
import { type AcceptLanguageSuggestionsInput, type ReviewLanguageSuggestionsInput } from './language-suggestion-contracts.js';
import { findTypographySuggestions, type ExcludedRange } from './language-suggestion-scanner.js';
import type { ArticleService } from './article.service.js';

type Locator = 'TITLE' | 'BODY' | 'COVER_TEXT';
type ScanField = { locator: Locator; text: string; excluded: ExcludedRange[] };
const adaptationFormats = new Set<AdaptationFormat>(['TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER',
  'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES']);
function json<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function articleFields(content: ArticleContent): ScanField[] {
  const blocks: { text: string; excluded: ExcludedRange[]; quoted: boolean }[] = [];
  function walk(node: ArticleNode, quoted: boolean) {
    const isQuoted = quoted || node.type === 'blockquote';
    if (node.type === 'paragraph' || node.type === 'heading') {
      let text = '', cursor = 0;
      const excluded: ExcludedRange[] = [];
      for (const child of node.content ?? []) {
        const part = child.type === 'hardBreak' ? '\n' : child.text ?? '';
        if (child.marks?.some(mark => mark.type === 'evidence')) excluded.push({ start: cursor, end: cursor + part.length });
        text += part; cursor += part.length;
      }
      blocks.push({ text, excluded, quoted: isQuoted });
      return;
    }
    for (const child of node.content ?? []) walk(child, isQuoted);
  }
  walk(content.document, false);
  let offset = 0;
  const excluded: ExcludedRange[] = [];
  for (const block of blocks) {
    if (block.quoted) excluded.push({ start: offset, end: offset + block.text.length });
    else excluded.push(...block.excluded.map(range => ({ start: offset + range.start, end: offset + range.end })));
    offset += block.text.length + 2;
  }
  const body = articleDocumentDetails(content).plainText;
  return [{ locator: 'TITLE', text: content.title, excluded: [] }, { locator: 'BODY', text: body, excluded }];
}

function adaptationFields(content: TelegramContent): ScanField[] {
  const textExcluded = content.mappings.filter(row => (row.field ?? 'text') === 'text').map(row => ({ start: row.startOffset, end: row.endOffset }));
  const fields: ScanField[] = [{ locator: 'BODY', text: content.text, excluded: textExcluded }];
  if (content.cover) {
    const coverExcluded = content.mappings.filter(row => row.field === 'cover').map(row => ({ start: row.startOffset, end: row.endOffset }));
    fields.push({ locator: 'COVER_TEXT', text: content.cover.text, excluded: coverExcluded });
  }
  return fields;
}

function replaceText(text: string, start: number, end: number, expected: string, replacement: string): string {
  if (text.slice(start, end) !== expected) throw new ConflictException('Language finding no longer matches the current text');
  return text.slice(0, start) + replacement + text.slice(end);
}

function articleEdit(content: ArticleContent, locator: Locator, start: number, end: number, expected: string, replacement: string): ArticleContent {
  if (locator === 'TITLE') return articleContentSchema.parse({ ...content, title: replaceText(content.title, start, end, expected, replacement) });
  if (locator !== 'BODY') throw new BadRequestException('Article finding has an invalid text locator');
  const body = articleDocumentDetails(content).plainText;
  if (body.slice(start, end) !== expected) throw new ConflictException('Language finding no longer matches the current article text');
  return applyInlineReplacement(content, { start, end }, replacement);
}

function adaptationEdit(content: TelegramContent, locator: Locator, start: number, end: number, expected: string, replacement: string): TelegramContent {
  const field = locator === 'BODY' ? 'text' : locator === 'COVER_TEXT' ? 'cover' : null;
  if (!field) throw new BadRequestException('Adaptation finding has an invalid text locator');
  const target = field === 'text' ? content.text : content.cover?.text;
  if (target === undefined) throw new ConflictException('Language finding target is no longer available');
  const updatedText = replaceText(target, start, end, expected, replacement);
  const shift = replacement.length - (end - start);
  const mappings = content.mappings.map(row => {
    if (((row.field ?? 'text') === 'text') !== (field === 'text')) return row;
    if (row.startOffset < end && row.endOffset > start) throw new ConflictException('Language finding overlaps an evidence span');
    return row.startOffset >= end ? { ...row, startOffset: row.startOffset + shift, endOffset: row.endOffset + shift } : row;
  });
  const updated = field === 'text'
    ? { ...content, text: updatedText, mappings }
    : { ...content, cover: { ...content.cover!, text: updatedText }, mappings };
  return telegramContentSchema.parse(updated);
}

export class LanguageSuggestionService {
  constructor(readonly prisma: PrismaClient, private readonly articles: ArticleService) {}

  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write: boolean) {
    const rows = write
      ? await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, write: boolean, run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return run(tx); });
  }

  private async currentTarget(tx: Prisma.TransactionClient, project: string, targetType: 'ARTICLE' | 'ADAPTATION', sourceRevisionId: string) {
    if (targetType === 'ARTICLE') {
      const source = await tx.articleVersion.findFirst({ where: { id: sourceRevisionId, projectId: project } });
      const article = source ? await tx.article.findFirst({ where: { id: source.articleId, projectId: project }, include: { draft: true } }) : null;
      if (!source || !article) throw new NotFoundException('Article version not found');
      return { counter: article.revision, source, draft: article.draft, format: 'ARTICLE' as const,
        current: !!article.draft && !source.withdrawnAt && source.claimsSealed && article.draft.baseVersionId === source.id && article.draft.sha256 === source.sha256
          && canonicalManifestHash(article.draft.content) === source.sha256 && canonicalManifestHash(source.content) === source.sha256 };
    }
    const source = await tx.adaptationRevision.findFirst({ where: { id: sourceRevisionId, projectId: project }, include: { adaptation: true } });
    const adaptation = source ? await tx.adaptation.findFirst({ where: { id: source.adaptationId, projectId: project }, include: { draft: true } }) : null;
    if (!source || !adaptation || !adaptationFormats.has(source.adaptation.format as AdaptationFormat)) throw new NotFoundException('Adaptation version not found');
    const draft = adaptation.draft;
    const sameInputs = !!draft && draft.inputMode === source.inputMode && draft.contentMode === source.contentMode && draft.briefRevisionId === source.briefRevisionId
      && draft.basisRevisionId === source.basisRevisionId && draft.sourceArticleVersionId === source.sourceArticleVersionId && draft.workspaceId === source.workspaceId
      && draft.workspaceStyleRevision === source.workspaceStyleRevision && draft.includeLink === source.includeLink;
    return { counter: adaptation.revision, source, draft: adaptation.draft, format: source.adaptation.format as AdaptationFormat,
      current: !!adaptation.draft && !source.withdrawnAt && source.claimsSealed && sameInputs && adaptation.draft.baseRevisionId === source.id
        && adaptation.draft.sha256 === source.sha256 && canonicalManifestHash(adaptation.draft.content) === source.sha256 && canonicalManifestHash(source.content) === source.sha256 };
  }

  private async ensureTargetSelected(tx: Prisma.TransactionClient, project: string, type: 'ARTICLE' | 'ADAPTATION', format: string) {
    const row = await tx.project.findUnique({ where: { id: project }, select: { formats: true } });
    if (!row || (type === 'ARTICLE' ? !row.formats.includes('ARTICLE') : !row.formats.includes(format as never))) throw new ConflictException('Select this format before reviewing language');
  }

  private async suggestions(tx: Prisma.TransactionClient, project: string, targetType: 'ARTICLE' | 'ADAPTATION', targetId: string, hash: string, fields: ScanField[], user?: string) {
    const rows = [];
    for (const field of fields) for (const finding of findTypographySuggestions(field.text, field.excluded)) {
      const existing = await tx.languageSuggestion.findFirst({ where: { projectId: project, targetType, targetId, contentHash: hash,
        locator: field.locator, locatorStart: finding.start, locatorEnd: finding.end, originalText: finding.originalText,
        replacementText: finding.replacementText, provenance: 'LOCAL_TYPOGRAPHY' } });
      rows.push(existing ?? (user ? await tx.languageSuggestion.create({ data: { id: randomUUID(), projectId: project, targetType, targetId,
        contentHash: hash, locator: field.locator, locatorStart: finding.start, locatorEnd: finding.end, originalText: finding.originalText,
        replacementText: finding.replacementText, finding: finding.finding, provenance: 'LOCAL_TYPOGRAPHY', createdBy: user } }) : null));
    }
    return rows.filter((row): row is NonNullable<typeof row> => row !== null);
  }
  private view(row: { id: string; targetType: string; targetId: string; contentHash: string; locator: string; locatorStart: number; locatorEnd: number;
    originalText: string; replacementText: string; finding: string; provenance: string; status: string; createdAt: Date; resultVersionId: string | null }, stale: boolean) {
    return { id: row.id, targetType: row.targetType, sourceRevisionId: row.targetId, contentHash: row.contentHash,
      locator: { field: row.locator, start: row.locatorStart, end: row.locatorEnd }, originalText: row.originalText,
      replacementText: row.replacementText, finding: row.finding, provenance: row.provenance, status: row.status, resultVersionId: row.resultVersionId,
      stale, createdAt: row.createdAt.toISOString() };
  }

  review(user: string, project: string, input: ReviewLanguageSuggestionsInput) {
    return this.command(user, project, true, async tx => {
      const target = await this.currentTarget(tx, project, input.targetType, input.sourceRevisionId);
      await this.ensureTargetSelected(tx, project, input.targetType, target.format);
      if (target.counter !== input.expectedRevision) throw new ConflictException('Draft changed; retain local text and reload before reviewing');
      if (!target.current || !target.source.sha256 || canonicalManifestHash(target.source.content) !== target.source.sha256) throw new ConflictException('Language review requires the exact current saved checkpoint');
      let fields: ScanField[];
      if (input.targetType === 'ARTICLE') fields = articleFields(articleContentSchema.parse(target.source.content));
      else fields = adaptationFields(validateFormatContent(target.format as AdaptationFormat, telegramContentSchema.parse(target.source.content)));
      const suggestions = await this.suggestions(tx, project, input.targetType, target.source.id, target.source.sha256, fields, user);
      return { suggestions: suggestions.map(row => this.view(row, false)) };
    });
  }

  list(user: string, project: string, targetType: 'ARTICLE' | 'ADAPTATION', sourceRevisionId: string) {
    return this.command(user, project, false, async tx => {
      const target = await this.currentTarget(tx, project, targetType, sourceRevisionId);
      await this.ensureTargetSelected(tx, project, targetType, target.format);
      const rows = await tx.languageSuggestion.findMany({ where: { projectId: project, targetType, targetId: sourceRevisionId }, orderBy: [{ locator: 'asc' }, { locatorStart: 'asc' }] });
      const suggestions = rows.map(row => this.view(row, row.contentHash !== target.source.sha256 || !target.current));
      return { suggestions };
    });
  }

  accept(user: string, project: string, input: AcceptLanguageSuggestionsInput) {
    return this.command(user, project, true, async tx => {
      const target = await this.currentTarget(tx, project, input.targetType, input.sourceRevisionId);
      await this.ensureTargetSelected(tx, project, input.targetType, target.format);
      if (target.counter !== input.expectedRevision) throw new ConflictException('Draft changed; retain local text and reload before accepting language edits');
      if (!target.current || !target.source.sha256 || canonicalManifestHash(target.source.content) !== target.source.sha256) throw new ConflictException('Language suggestions are stale; review the current saved checkpoint');
      const selected = await tx.languageSuggestion.findMany({ where: { projectId: project, id: { in: input.suggestionIds }, targetType: input.targetType, targetId: target.source.id } });
      if (selected.length !== input.suggestionIds.length || selected.some(row => row.status !== 'OPEN' || row.contentHash !== target.source.sha256)) throw new ConflictException('Selected language suggestions are stale or already decided');
      const fieldOf = (row: (typeof selected)[number]) => row.locator as Locator;
      const ordered = [...selected].sort((a, b) => fieldOf(a).localeCompare(fieldOf(b)) || b.locatorStart - a.locatorStart);
      for (let i = 0; i < ordered.length; i++) {
        const row = ordered[i]!;
        if (row.locatorEnd <= row.locatorStart || row.locatorEnd - row.locatorStart !== row.originalText.length) throw new ConflictException('Language suggestion locator is invalid');
        const next = ordered[i + 1];
        if (next && next.locator === row.locator && next.locatorEnd > row.locatorStart) throw new ConflictException('Selected language suggestions overlap');
      }
      const decidedAt = new Date();
      if (input.targetType === 'ARTICLE') {
        let content = articleContentSchema.parse(target.source.content);
        for (const row of ordered) content = articleEdit(content, row.locator as Locator, row.locatorStart, row.locatorEnd, row.originalText, row.replacementText);
        const candidateVersionId = await this.articles.appendAnnotationCandidate(tx, user, project, target.source.id, content, input.expectedRevision);
        await tx.languageSuggestion.updateMany({ where: { projectId: project, id: { in: input.suggestionIds }, status: 'OPEN' }, data: { status: 'ACCEPTED', resultVersionId: candidateVersionId, decidedBy: user, decidedAt } });
        const rows = await tx.languageSuggestion.findMany({ where: { projectId: project, id: { in: input.suggestionIds } } });
        return { candidateVersionId, suggestions: rows.map(row => this.view(row, false)) };
      }
      const source = target.source as Prisma.AdaptationRevisionGetPayload<{ include: { adaptation: true } }>;
      const adaptation = await tx.adaptation.findFirstOrThrow({ where: { id: source.adaptationId, projectId: project }, include: { draft: true } });
      if (!adaptation.draft) throw new ConflictException('Adaptation draft no longer exists');
      let content = validateFormatContent(target.format as AdaptationFormat, telegramContentSchema.parse(source.content));
      for (const row of ordered) content = adaptationEdit(content, row.locator as Locator, row.locatorStart, row.locatorEnd, row.originalText, row.replacementText);
      content = validateFormatContent(target.format as AdaptationFormat, telegramContentSchema.parse(content));
      const data = { content: json(content), sha256: canonicalManifestHash(content), baseRevisionId: source.id, origin: 'MANUAL' as const, updatedBy: user, updatedAt: decidedAt };
      await tx.adaptationDraft.upsert({ where: { adaptationId: adaptation.id }, create: { adaptationId: adaptation.id, projectId: project, ...data,
        inputMode: source.inputMode, contentMode: source.contentMode, briefRevisionId: source.briefRevisionId, basisRevisionId: source.basisRevisionId,
        sourceArticleVersionId: source.sourceArticleVersionId, workspaceId: source.workspaceId, workspaceStyleRevision: source.workspaceStyleRevision, includeLink: source.includeLink }, update: data });
      await tx.adaptation.update({ where: { id: adaptation.id }, data: { revision: { increment: 1 } } });
      await tx.languageSuggestion.updateMany({ where: { projectId: project, id: { in: input.suggestionIds }, status: 'OPEN' }, data: { status: 'ACCEPTED', decidedBy: user, decidedAt } });
      const rows = await tx.languageSuggestion.findMany({ where: { projectId: project, id: { in: input.suggestionIds } } });
      return { adaptationRevision: adaptation.revision + 1, suggestions: rows.map(row => this.view(row, false)) };
    });
  }

  reject(user: string, project: string, id: string, expectedRevision: number) {
    return this.command(user, project, true, async tx => {
      const row = await tx.languageSuggestion.findFirst({ where: { id, projectId: project } });
      if (!row) throw new NotFoundException('Language suggestion not found');
      const target = await this.currentTarget(tx, project, row.targetType, row.targetId);
      await this.ensureTargetSelected(tx, project, row.targetType, target.format);
      if (target.counter !== expectedRevision) throw new ConflictException('Draft changed; reload before deciding this suggestion');
      if (row.status !== 'OPEN') throw new ConflictException('Language suggestion is already decided');
      const decidedAt = new Date();
      await tx.languageSuggestion.update({ where: { id: row.id }, data: { status: 'REJECTED', decidedBy: user, decidedAt } });
      return { suggestion: this.view(await tx.languageSuggestion.findUniqueOrThrow({ where: { id: row.id } }), row.contentHash !== target.source.sha256 || !target.current) };
    });
  }
}
