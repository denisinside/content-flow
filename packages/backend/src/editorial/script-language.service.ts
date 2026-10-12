import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { scriptContentSchema, type ScriptContent } from './script-contracts.js';
import { findTypographySuggestions } from './language-suggestion-scanner.js';
import type { ScriptService } from './script.service.js';

export const scriptLanguageReviewInput = z.object({ sourceRevisionId: z.uuid(), expectedRevision: z.number().int().nonnegative() }).strict();
export const scriptLanguageAcceptInput = scriptLanguageReviewInput.extend({ suggestionIds: z.array(z.uuid()).min(1).max(100)
  .refine(ids => new Set(ids).size === ids.length) }).strict();

/** Exact checkpoint and frame-local typography; accepting changes only the mutable script. */
export class ScriptLanguageService {
  constructor(readonly prisma: PrismaClient, private readonly scripts: ScriptService) {}

  private command<T>(user: string, project: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => {
      const access = await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p
        JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id"
        WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL
          AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`;
      if (!access.length) throw new NotFoundException('Project not found');
      return action(tx);
    });
  }

  private async target(tx: Prisma.TransactionClient, project: string, sourceId: string, expected: number) {
    const source = await tx.scriptRevision.findFirst({ where: { id: sourceId, projectId: project } });
    const script = source ? await tx.script.findFirst({ where: { id: source.scriptId, projectId: project } }) : null;
    const draft = script ? await tx.scriptDraft.findUnique({ where: { scriptId: script.id } }) : null;
    if (!source || !script || !draft) throw new NotFoundException('Saved script checkpoint not found');
    const projectRow = await tx.project.findUniqueOrThrow({ where: { id: project } });
    const inspection = await this.scripts.inspectRevision(tx, project, source);
    if (script.revision !== expected || !projectRow.formats.includes(script.format) || source.withdrawnAt || !source.claimsSealed
      || draft.baseRevisionId !== source.id || draft.sha256 !== source.sha256
      || draft.parentAdaptationRevisionId !== source.parentAdaptationRevisionId
      || draft.parentAdaptationRevisionHash !== source.parentAdaptationRevisionHash
      || draft.parentAdaptationReviewCounter !== source.parentAdaptationReviewCounter
      || canonicalManifestHash(draft.content) !== source.sha256 || canonicalManifestHash(source.content) !== source.sha256
      || inspection.staleReasons.length || inspection.blockingReasons.some(reason => reason !== 'UNMAPPED_NOT_ACKNOWLEDGED')) {
      throw new ConflictException('Script language suggestions are stale; preserve local text and save a new checkpoint');
    }
    return { source, script, draft, content: scriptContentSchema.parse(draft.content) };
  }

  review(user: string, project: string, input: z.infer<typeof scriptLanguageReviewInput>) {
    return this.command(user, project, async tx => {
      const target = await this.target(tx, project, input.sourceRevisionId, input.expectedRevision);
      let count = 0;
      scan: for (const frame of target.content.frames) {
        const excluded = frame.mappings.map(row => ({ start: row.startOffset, end: row.endOffset }));
        for (const finding of findTypographySuggestions(frame.text, excluded)) {
          if (count++ >= 100) break scan;
          const existing = await tx.scriptLanguageSuggestion.findFirst({ where: { projectId: project, sourceRevisionId: target.source.id,
            frameId: frame.id, contentHash: target.source.sha256, startOffset: finding.start, endOffset: finding.end,
            originalText: finding.originalText, replacementText: finding.replacementText } });
          if (!existing) await tx.scriptLanguageSuggestion.create({ data: { id: randomUUID(), projectId: project,
            sourceRevisionId: target.source.id, frameId: frame.id, contentHash: target.source.sha256,
            startOffset: finding.start, endOffset: finding.end, originalText: finding.originalText,
            replacementText: finding.replacementText, finding: finding.finding, createdBy: user } });
        }
      }
      const suggestions = await tx.scriptLanguageSuggestion.findMany({ where: { projectId: project, sourceRevisionId: target.source.id },
        orderBy: [{ frameId: 'asc' }, { startOffset: 'asc' }, { id: 'asc' }] });
      return { sourceRevisionId: target.source.id, expectedRevision: target.script.revision, suggestions };
    });
  }

  accept(user: string, project: string, input: z.infer<typeof scriptLanguageAcceptInput>) {
    return this.command(user, project, async tx => {
      const target = await this.target(tx, project, input.sourceRevisionId, input.expectedRevision);
      const findings = await tx.scriptLanguageSuggestion.findMany({ where: { id: { in: input.suggestionIds }, projectId: project,
        sourceRevisionId: target.source.id, contentHash: target.source.sha256, status: 'OPEN' }, orderBy: { startOffset: 'desc' } });
      if (findings.length !== input.suggestionIds.length) throw new ConflictException('Script language suggestion is no longer open');
      const content: ScriptContent = structuredClone(target.content);
      for (const finding of findings) {
        const frame = content.frames.find(row => row.id === finding.frameId);
        if (!frame || frame.text.slice(finding.startOffset, finding.endOffset) !== finding.originalText) {
          throw new ConflictException('Script language finding no longer matches its frame');
        }
        const shift = finding.replacementText.length - (finding.endOffset - finding.startOffset);
        frame.mappings = frame.mappings.map(mapping => {
          if (mapping.startOffset < finding.endOffset && mapping.endOffset > finding.startOffset) {
            throw new ConflictException('Script language finding overlaps evidence');
          }
          return mapping.startOffset >= finding.endOffset
            ? { ...mapping, startOffset: mapping.startOffset + shift, endOffset: mapping.endOffset + shift } : mapping;
        });
        frame.text = frame.text.slice(0, finding.startOffset) + finding.replacementText + frame.text.slice(finding.endOffset);
      }
      const validated = scriptContentSchema.safeParse(content);
      if (!validated.success) throw new BadRequestException('Edited script exceeds its content bounds');
      await tx.scriptDraft.update({ where: { scriptId: target.script.id }, data: {
        content: JSON.parse(JSON.stringify(validated.data)) as Prisma.InputJsonValue, sha256: canonicalManifestHash(validated.data),
        baseRevisionId: null, counter: { increment: 1 }, updatedBy: user, updatedAt: new Date(),
      } });
      await tx.script.update({ where: { id: target.script.id }, data: { revision: { increment: 1 } } });
      await tx.scriptLanguageSuggestion.updateMany({ where: { id: { in: findings.map(row => row.id) }, projectId: project, status: 'OPEN' },
        data: { status: 'ACCEPTED', decidedBy: user, decidedAt: new Date() } });
      return { sourceRevisionId: target.source.id, expectedRevision: target.script.revision + 1, content: validated.data };
    });
  }

  reject(user: string, project: string, suggestionId: string, expectedRevision: number) {
    return this.command(user, project, async tx => {
      const finding = await tx.scriptLanguageSuggestion.findFirst({ where: { id: suggestionId, projectId: project, status: 'OPEN' } });
      if (!finding) throw new NotFoundException('Open script language suggestion not found');
      await this.target(tx, project, finding.sourceRevisionId, expectedRevision);
      await tx.scriptLanguageSuggestion.update({ where: { id: finding.id }, data: { status: 'REJECTED', decidedBy: user, decidedAt: new Date() } });
      return { rejected: true };
    });
  }
}
