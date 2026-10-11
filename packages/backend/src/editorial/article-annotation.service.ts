import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { articleContentSchema, articleDocumentDetails, type ArticleContent, type ArticleNode } from './article-contracts.js';
import { projectAnchor, type ActArticleAnnotationInput, type CreateArticleAnnotationInput } from './article-annotations.js';
import type { ArticleService } from './article.service.js';

type Range = { start: number; end: number };
function validBoundary(text: string, position: number) {
  if (position <= 0 || position >= text.length) return true;
  const before = text.charCodeAt(position - 1), after = text.charCodeAt(position);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** Replace UTF-16 plain-text offsets inside one paragraph/heading, keeping all outside marks intact. */
export function applyInlineReplacement(content: ArticleContent, range: Range, replacement: string): ArticleContent {
  const blocks: { node: ArticleNode; start: number; end: number }[] = []; let cursor = 0;
  function collect(node: ArticleNode) {
    if (node.type === 'paragraph' || node.type === 'heading') {
      const length = (node.content ?? []).reduce((sum, child) => sum + (child.type === 'hardBreak' ? 1 : child.text?.length ?? 0), 0);
      blocks.push({ node, start: cursor, end: cursor + length }); cursor += length + 2; return;
    }
    for (const child of node.content ?? []) collect(child);
  }
  collect(content.document);
  const block = blocks.find(item => range.start >= item.start && range.end <= item.end);
  if (!block) throw new ConflictException('Suggestion crosses article block boundaries and cannot be applied safely');
  const blockText = (block.node.content ?? []).map(child => child.type === 'hardBreak' ? '\n' : child.text ?? '').join('');
  if (!validBoundary(blockText, range.start - block.start) || !validBoundary(blockText, range.end - block.start)) throw new BadRequestException('Suggestion range splits a UTF-16 character');
  const children: ArticleNode[] = []; let local = 0, inserted = false, overlap = false;
  for (const child of block.node.content ?? []) {
    const text = child.type === 'hardBreak' ? '\n' : child.text ?? '', from = local, to = local + text.length; local = to;
    const a = range.start - block.start, b = range.end - block.start;
    if (to <= a || from >= b) { children.push(child); continue; }
    if (child.type !== 'text') throw new ConflictException('Suggestion crosses a hard break and cannot be applied safely');
    overlap = true;
    const left = text.slice(0, Math.max(0, a - from)), right = text.slice(Math.max(0, b - from));
    if (left) children.push({ ...child, text: left });
    if (!inserted) {
      const marks = child.marks?.filter(mark => mark.type !== 'evidence');
      if (replacement) children.push({ type: 'text', text: replacement, ...(marks?.length ? { marks } : {}) });
      inserted = true;
    }
    if (right) children.push({ ...child, text: right });
  }
  if (!overlap || !inserted) throw new ConflictException('Suggestion range no longer maps to editable text');
  const replaceBlock = (node: ArticleNode): ArticleNode => node === block.node ? { ...node, content: children } : node.content ? { ...node, content: node.content.map(replaceBlock) } : node;
  return articleContentSchema.parse({ ...content, document: replaceBlock(content.document) });
}

export class ArticleAnnotationService {
  constructor(readonly prisma: PrismaClient, private readonly articles: ArticleService) {}

  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write: boolean) {
    const rows = write
      ? await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, write: boolean, run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return run(tx); });
  }
  private async articleFormat(tx: Prisma.TransactionClient, project: string) {
    const row = await tx.project.findFirst({ where: { id: project, formats: { has: 'ARTICLE' } }, select: { id: true } });
    if (!row) throw new ConflictException('Select Article before annotating article versions');
  }
  private async thread(tx: Prisma.TransactionClient, project: string, id: string) {
    const thread = await tx.articleAnnotation.findFirst({ where: { projectId: project, id }, include: { sourceVersion: true, posts: { include: { creator: true }, orderBy: { createdAt: 'asc' } }, creator: true } });
    if (!thread) throw new NotFoundException('Article annotation not found');
    return thread;
  }
  private async view(tx: Prisma.TransactionClient, project: string, target: { id: string; plainText: string }, rows?: Awaited<ReturnType<ArticleAnnotationService['annotations']>>) {
    const annotations = rows ?? await this.annotations(tx, project);
    return { threads: annotations.map(row => {
      const anchor = row.articleVersionId === target.id
        ? { status: 'EXACT' as const, start: row.anchorStart, end: row.anchorEnd }
        : projectAnchor(target.plainText, row.quote, row.prefix, row.suffix);
      return { id: row.id, articleVersionId: row.articleVersionId, kind: row.kind, status: row.status, revision: row.revision,
        quote: row.quote, body: row.body, replacementText: row.replacementText, resultVersionId: row.resultVersionId,
        createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), authorName: row.creator.displayName ?? 'Команда',
        anchor,
        posts: row.posts.map(post => ({ id: post.id, body: post.body, action: post.action, createdBy: post.createdBy, createdAt: post.createdAt.toISOString(), authorName: post.creator.displayName ?? 'Команда' })) };
    }) };
  }
  private annotations(tx: Prisma.TransactionClient, project: string) {
    return tx.articleAnnotation.findMany({ where: { projectId: project }, include: { creator: true, posts: { include: { creator: true }, orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'asc' } });
  }
  private async target(tx: Prisma.TransactionClient, project: string, versionId?: string) {
    const select = { id: true, plainText: true } as const;
    const version = versionId
      ? await tx.articleVersion.findFirst({ where: { projectId: project, id: versionId }, select })
      : await tx.articleVersion.findFirst({ where: { projectId: project }, orderBy: { number: 'desc' }, select });
    if (!version) throw new NotFoundException('Article version not found');
    return version;
  }
  list(user: string, project: string, targetVersionId?: string) {
    return this.command(user, project, false, async tx => {
      await this.articleFormat(tx, project);
      const rows = await this.annotations(tx, project);
      let resolvedVersionId = targetVersionId;
      if (!resolvedVersionId) {
        const latest = await tx.articleVersion.findFirst({ where: { projectId: project }, orderBy: { number: 'desc' }, select: { id: true } });
        if (!latest) return { threads: [] };
        resolvedVersionId = latest.id;
      }
      const target = await this.target(tx, project, resolvedVersionId);
      return this.view(tx, project, target, rows);
    });
  }
  create(user: string, project: string, input: CreateArticleAnnotationInput) {
    return this.command(user, project, true, async tx => {
      await this.articleFormat(tx, project);
      const version = await tx.articleVersion.findFirst({ where: { projectId: project, id: input.articleVersionId } });
      if (!version) throw new NotFoundException('Article version not found');
      const sourceContent = articleContentSchema.safeParse(version.content);
      if (!sourceContent.success || canonicalManifestHash(sourceContent.data) !== version.sha256 || articleDocumentDetails(sourceContent.data).plainText !== version.plainText || input.contentHash !== version.sha256) throw new ConflictException('Article version changed; reload before commenting');
      const text = version.plainText;
      if (input.anchorEnd > text.length || !validBoundary(text, input.anchorStart) || !validBoundary(text, input.anchorEnd)) throw new BadRequestException('Annotation range is outside article text or splits a character');
      const quote = text.slice(input.anchorStart, input.anchorEnd);
      if (!quote.trim()) throw new BadRequestException('Select nonempty article text');
      const prefix = text.slice(Math.max(0, input.anchorStart - 120), input.anchorStart), suffix = text.slice(input.anchorEnd, input.anchorEnd + 120);
      const payloadHash = canonicalManifestHash({ articleVersionId: input.articleVersionId, contentHash: input.contentHash, anchorStart: input.anchorStart, anchorEnd: input.anchorEnd, body: input.body, kind: input.kind, replacementText: input.replacementText ?? null });
      const existing = await tx.articleAnnotation.findFirst({ where: { projectId: project, createdBy: user, commandKey: input.commandKey }, include: { sourceVersion: true, posts: { include: { creator: true }, orderBy: { createdAt: 'asc' } }, creator: true } });
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new ConflictException('Annotation command key was already used with different content');
        const target = await this.target(tx, project, input.articleVersionId); return { ...(await this.view(tx, project, target, [existing])), replayed: true };
      }
      const created = await tx.articleAnnotation.create({ data: { id: randomUUID(), projectId: project, articleVersionId: version.id, kind: input.kind, anchorStart: input.anchorStart,
        anchorEnd: input.anchorEnd, quote, prefix, suffix, body: input.body, replacementText: input.replacementText ?? null, commandKey: input.commandKey,
        payloadHash, createdBy: user },
        include: { sourceVersion: true, posts: { include: { creator: true }, orderBy: { createdAt: 'asc' } }, creator: true } });
      const target = await this.target(tx, project, input.articleVersionId); return { ...(await this.view(tx, project, target, [created])), replayed: false };
    });
  }
  reply(user: string, project: string, annotationId: string, expectedRevision: number, body: string) {
    return this.command(user, project, true, async tx => {
      const thread = await this.thread(tx, project, annotationId);
      if (thread.revision !== expectedRevision || thread.status !== 'OPEN') throw new ConflictException('Annotation changed or is closed; reload before replying');
      await tx.articleAnnotation.update({ where: { id: thread.id }, data: { revision: { increment: 1 } } });
      await tx.articleAnnotationPost.create({ data: { id: randomUUID(), projectId: project, annotationId: thread.id, body, action: 'REPLY', createdBy: user } });
      const updated = await this.thread(tx, project, annotationId), target = await this.target(tx, project, thread.articleVersionId);
      return { ...(await this.view(tx, project, target, [updated])), replayed: false };
    });
  }
  act(user: string, project: string, annotationId: string, input: ActArticleAnnotationInput) {
    return this.command(user, project, true, async tx => {
      const thread = await this.thread(tx, project, annotationId);
      if (thread.revision !== input.expectedRevision) throw new ConflictException('Annotation changed; reload before acting');
      let status = thread.status, resultVersionId = thread.resultVersionId, candidateVersionId: string | null = null;
      if (input.action === 'RESOLVE' || input.action === 'REOPEN') {
        if (thread.kind !== 'COMMENT' || (input.action === 'RESOLVE' ? thread.status !== 'OPEN' : thread.status !== 'RESOLVED')) throw new ConflictException('This comment cannot take that action');
        status = input.action === 'RESOLVE' ? 'RESOLVED' : 'OPEN';
      } else {
        if (thread.kind !== 'SUGGESTION' || thread.status !== 'OPEN') throw new ConflictException('This suggestion is already decided');
        if (input.action === 'REJECT') status = 'REJECTED';
        else {
          const article = await tx.article.findUnique({ where: { projectId: project }, include: { draft: true } });
          const source = thread.sourceVersion;
          if (!article || article.revision !== input.expectedArticleRevision || !article.draft || article.draft.baseVersionId !== source.id || article.draft.sha256 !== source.sha256 || canonicalManifestHash(article.draft.content) !== source.sha256) throw new ConflictException('Suggestion source is no longer the unchanged current draft');
          const content = applyInlineReplacement(articleContentSchema.parse(source.content), { start: thread.anchorStart, end: thread.anchorEnd }, thread.replacementText ?? '');
          const candidate = await this.articles.appendAnnotationCandidate(tx, user, project, source.id, content, input.expectedArticleRevision!);
          candidateVersionId = candidate; resultVersionId = candidate; status = 'ACCEPTED';
        }
      }
      await tx.articleAnnotation.update({ where: { id: thread.id }, data: { status, resultVersionId, revision: { increment: 1 } } });
      const body = input.action === 'ACCEPT' ? 'Пропозицію застосовано до окремої версії статті' : input.action === 'REJECT' ? 'Пропозицію відхилено' : input.action === 'RESOLVE' ? 'Коментар закрито' : 'Коментар знову відкрито';
      await tx.articleAnnotationPost.create({ data: { id: randomUUID(), projectId: project, annotationId: thread.id, body, action: input.action, createdBy: user } });
      const updated = await this.thread(tx, project, annotationId), target = await this.target(tx, project, thread.articleVersionId);
      return { ...(await this.view(tx, project, target, [updated])), replayed: false, ...(candidateVersionId ? { candidateVersionId } : {}) };
    });
  }
}
