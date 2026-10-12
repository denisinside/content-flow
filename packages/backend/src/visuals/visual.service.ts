import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { AssetPurpose, AssetState } from '../generated/prisma/enums.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { compositionSchema, DEFAULT_VISUAL_STYLE, FONT_HASHES, RENDERER_VERSION, colorSchema, fontSchema, imageRefs, makeFrame, type ImageRef, type VisualComposition, type VisualDefaults, type VisualFrame } from '@contextflow/visuals';
import type { PrivateAssetStore } from '../storage/private-asset-store.js';
import type { ScriptService } from '../editorial/script.service.js';
import type { TelegramService } from '../editorial/telegram.service.js';
import { scriptContentSchema } from '../editorial/script-contracts.js';
import { telegramContentSchema, type AdaptationFormat } from '../editorial/telegram-contracts.js';
import { VisualRenderer } from './visual-renderer.js';

const FORMATS = ['LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'] as const;
type VisualFormat = typeof FORMATS[number];
type ParentKind = 'ADAPTATION' | 'SCRIPT';
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const hashBytes = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isFormat = (value: string): value is VisualFormat => (FORMATS as readonly string[]).includes(value);
const workspaceScope = (value: string): value is 'PROJECT' | 'WORKSPACE' => value === 'PROJECT' || value === 'WORKSPACE';
const safeUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const objectRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

type ParentSource = {
  kind: ParentKind; id: string; sha256: string; reviewCounter: number; content: unknown;
  staleReasons: string[]; blockingReasons: string[]; eligible: boolean;
};

/** Versioned editable compositions sourced only from exact approved channel or script revisions. */
export class VisualService {
  constructor(readonly prisma: PrismaClient, private readonly channels: TelegramService, private readonly scripts: ScriptService,
    private readonly renderer: VisualRenderer, private readonly storage: PrivateAssetStore) {}

  private async lock(tx: Prisma.TransactionClient, user: string, project: string, write = true) {
    const rows = write
      ? await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`
      : await tx.$queryRaw<{ id: string }[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR SHARE OF p,w,m`;
    if (!rows.length) throw new NotFoundException('Project not found');
  }
  private command<T>(user: string, project: string, action: (tx: Prisma.TransactionClient) => Promise<T>, write = true) {
    return this.prisma.$transaction(async tx => { await this.lock(tx, user, project, write); return action(tx); });
  }
  private format(raw: string): VisualFormat {
    if (!isFormat(raw)) throw new BadRequestException('Unsupported visual format');
    return raw;
  }
  private async style(tx: Prisma.TransactionClient, workspaceId: string) {
    const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { styleRevision: true } });
    const style = await tx.workspaceStyleRevision.findUniqueOrThrow({ where: { workspaceId_revision: { workspaceId, revision: workspace.styleRevision } } });
    const raw = objectRecord(style.settings);
    const color = (key: string, fallback: string) => colorSchema.safeParse(raw[key]).success ? raw[key] as string : fallback;
    const font = fontSchema.safeParse(raw['visualFont']).success ? raw['visualFont'] as VisualDefaults['font'] : DEFAULT_VISUAL_STYLE.font;
    let logo: ImageRef | null = null;
    const logoId = raw['visualLogoId'];
    if (typeof logoId === 'string' && safeUuid(logoId)) {
      const asset = await tx.workspaceVisualAsset.findFirst({ where: { id: logoId, workspaceId }, select: { id: true, sha256: true } });
      if (asset) logo = { type: 'workspace', id: asset.id, sha256: asset.sha256 };
    }
    return { revision: style.revision, revisionId: `${workspaceId}:${style.revision}`, defaults: {
      background: color('visualBackground', DEFAULT_VISUAL_STYLE.background), text: color('visualText', DEFAULT_VISUAL_STYLE.text),
      accent: color('visualAccent', DEFAULT_VISUAL_STYLE.accent), font, logo,
    } satisfies VisualDefaults };
  }
  private async parent(tx: Prisma.TransactionClient, project: string, format: VisualFormat, kind: ParentKind, revisionId: string, requireCurrent = true): Promise<ParentSource> {
    const requiredKind: ParentKind = format.endsWith('COVER') ? 'ADAPTATION' : 'SCRIPT';
    if (kind !== requiredKind) throw new ConflictException('Visual format does not accept this parent type');
    const selected = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { formats: true } });
    if (!selected.formats.includes(format as AdaptationFormat)) throw new ConflictException('Select this format on the Project before creating visuals');
    if (kind === 'ADAPTATION') {
      const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format: format as AdaptationFormat } } });
      const row = adaptation ? await tx.adaptationRevision.findFirst({ where: { projectId: project, adaptationId: adaptation.id, id: revisionId } }) : null;
      if (!adaptation || !row || requireCurrent && (adaptation.currentApprovedRevisionId !== row.id || !row.approvedAt || !!row.withdrawnAt)) throw new ConflictException('Choose the current approved cover adaptation');
      const inspect = await this.channels.inspectRevision(tx, project, row);
      return { kind, id: row.id, sha256: row.sha256, reviewCounter: row.reviewCounter, content: row.content,
        staleReasons: inspect.staleReasons, blockingReasons: inspect.blockingReasons, eligible: inspect.eligible };
    }
    const script = await tx.script.findUnique({ where: { projectId_format: { projectId: project, format } } });
    const row = script ? await tx.scriptRevision.findFirst({ where: { projectId: project, scriptId: script.id, id: revisionId } }) : null;
    if (!script || !row || requireCurrent && (script.currentApprovedRevisionId !== row.id || !row.approvedAt || !!row.withdrawnAt)) throw new ConflictException('Choose the current approved carousel or stories script');
    const inspect = await this.scripts.inspectRevision(tx, project, row);
    return { kind, id: row.id, sha256: row.sha256, reviewCounter: row.reviewCounter, content: row.content,
      staleReasons: inspect.staleReasons, blockingReasons: inspect.blockingReasons, eligible: inspect.eligible };
  }
  private async currentParent(tx: Prisma.TransactionClient, project: string, format: VisualFormat): Promise<ParentSource | null> {
    const selection = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { formats: true } });
    if (!selection.formats.includes(format)) return null;
    const kind: ParentKind = format.endsWith('COVER') ? 'ADAPTATION' : 'SCRIPT';
    if (kind === 'ADAPTATION') {
      const adaptation = await tx.adaptation.findUnique({ where: { projectId_format: { projectId: project, format: format as AdaptationFormat } } });
      if (!adaptation?.currentApprovedRevisionId) return null;
      return this.parent(tx, project, format, kind, adaptation.currentApprovedRevisionId);
    }
    const script = await tx.script.findUnique({ where: { projectId_format: { projectId: project, format } } });
    if (!script?.currentApprovedRevisionId) return null;
    return this.parent(tx, project, format, kind, script.currentApprovedRevisionId);
  }
  private parentFrames(parent: ParentSource) {
    if (parent.kind === 'ADAPTATION') {
      const content = telegramContentSchema.parse(parent.content);
      const cover = content.cover;
      if (!cover) throw new ConflictException('Approved cover adaptation has no cover text');
      return [{ id: randomUUID(), sourceFrameId: null, purpose: 'Обкладинка', text: cover.text,
        mappings: content.mappings.filter(map => map.field === 'cover').map(mapping => ({ startOffset: mapping.startOffset, endOffset: mapping.endOffset,
          quote: mapping.quote, claimRevisionId: mapping.claimRevisionId, evidenceId: mapping.evidenceId })) }];
    }
    const content = scriptContentSchema.parse(parent.content);
    if (!content.frames.length) throw new ConflictException('Approved script has no frames');
    return content.frames.map(frame => ({ id: frame.id, sourceFrameId: frame.id, purpose: frame.purpose, text: frame.text, mappings: frame.mappings }));
  }
  private async buildInitial(tx: Prisma.TransactionClient, project: string, format: VisualFormat, parent: ParentSource, defaults: VisualDefaults): Promise<VisualComposition> {
    const sourceFrames = this.parentFrames(parent);
    const height: VisualComposition['height'] = format === 'INSTAGRAM_STORIES' ? 1920 : format.includes('CAROUSEL') ? 1350 : 1080;
    const templateId: VisualFrame['templateId'] = 'editorial';
    const frames = sourceFrames.map((source, index) => {
      const mappings = source.mappings.map(({ startOffset, endOffset, quote, claimRevisionId, evidenceId }) => ({ startOffset, endOffset, quote, claimRevisionId, evidenceId }));
      const frame = makeFrame({ id: source.id, text: source.text, purpose: source.purpose, mappings }, height, templateId, defaults);
      frame.sourceFrameId = source.sourceFrameId;
      if (parent.kind === 'ADAPTATION') frame.sourceFrameId = null;
      if (index === 0 && defaults.logo) { /* makeFrame includes the frozen brand logo resource */ }
      return frame;
    });
    return compositionSchema.parse({ schemaVersion: 'visual-v1', rendererVersion: RENDERER_VERSION, width: 1080, height, frames });
  }
  private dropInvalidMappings(raw: unknown): unknown {
    if (!raw || typeof raw !== 'object') return raw;
    const value = structuredClone(raw) as { frames?: Array<{ layers?: Array<{ type?: string; text?: string; mappings?: Array<{ startOffset: number; endOffset: number; quote: string }> }> }> };
    for (const frame of value.frames ?? []) for (const layer of frame.layers ?? []) if (layer.type === 'text' && layer.text && layer.mappings) {
      layer.mappings = layer.mappings.filter(mapping => mapping.startOffset < mapping.endOffset && layer.text!.slice(mapping.startOffset, mapping.endOffset) === mapping.quote);
    }
    return value;
  }
  private unmapped(content: VisualComposition) {
    return content.frames.some(frame => frame.layers.some(layer => {
      if (layer.type !== 'text') return false;
      let cursor = 0;
      for (const mapping of [...layer.mappings].sort((a, b) => a.startOffset - b.startOffset)) {
        if (layer.text.slice(cursor, mapping.startOffset).trim()) return true;
        cursor = mapping.endOffset;
      }
      return !!layer.text.slice(cursor).trim();
    }));
  }
  async inspectParent(tx: Prisma.TransactionClient, project: string, format: VisualFormat, row: { parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number }) {
    if (row.parentKind !== 'ADAPTATION' && row.parentKind !== 'SCRIPT') return { staleReasons: [], blockingReasons: ['PARENT_KIND_INVALID'], eligible: false };
    let parent: ParentSource;
    try { parent = await this.parent(tx, project, format, row.parentKind, row.parentRevisionId, false); }
    catch (error) {
      if (error instanceof ConflictException || error instanceof NotFoundException) return { staleReasons: ['PARENT_CHANGED'], blockingReasons: ['PARENT_UNAVAILABLE'], eligible: false };
      throw error;
    }
    const staleReasons = [...parent.staleReasons];
    const blockingReasons = [...parent.blockingReasons];
    const current = await this.currentParent(tx, project, format);
    if (!current || current.id !== row.parentRevisionId) staleReasons.push('PARENT_CHANGED');
    if (parent.sha256 !== row.parentRevisionHash || parent.reviewCounter !== row.parentReviewCounter) blockingReasons.push('PARENT_INTEGRITY');
    return { staleReasons: [...new Set(staleReasons)], blockingReasons: [...new Set(blockingReasons)], eligible: parent.eligible && !staleReasons.length && !blockingReasons.length };
  }
  /** Shared visual approval/freshness inspection. Does not call the renderer or mutate review state. */
  async inspectRevision(tx: Prisma.TransactionClient, project: string, row: {
    id: string; projectId: string; compositionId: string; content: Prisma.JsonValue; sha256: string; number: number;
    parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number;
    parentAdaptationRevisionId: string | null; parentScriptRevisionId: string | null; resourceManifest: Prisma.JsonValue;
    rendererVersion: string; approvedAt: Date | null; withdrawnAt: Date | null; reviewCounter: number;
    previews: Array<{ frameId: string; rendererVersion: string; fontHashes: Prisma.JsonValue; overflow: Prisma.JsonValue;
      asset: { id: string; projectId: string; sha256: string; mediaType: string; state: AssetState } }>;
  }) {
    const staleReasons: string[] = [], blockingReasons: string[] = [];
    const owner = await tx.visualComposition.findFirst({ where: { id: row.compositionId, projectId: project }, select: { id: true, currentApprovedRevisionId: true } });
    if (!owner || row.projectId !== project) blockingReasons.push('COMPOSITION_UNAVAILABLE');
    const parsed = compositionSchema.safeParse(row.content);
    if (!parsed.success || canonicalManifestHash(row.content) !== row.sha256) blockingReasons.push('CONTENT_INTEGRITY');
    if (parsed.success) {
      const content = parsed.data;
      if (row.rendererVersion !== content.rendererVersion || content.rendererVersion !== RENDERER_VERSION) blockingReasons.push('RENDERER_VERSION_UNSUPPORTED');
      if (row.parentKind === 'ADAPTATION' ? !row.parentAdaptationRevisionId || row.parentScriptRevisionId !== null
        || row.parentAdaptationRevisionId !== row.parentRevisionId
        : row.parentKind === 'SCRIPT' ? !row.parentScriptRevisionId || row.parentAdaptationRevisionId !== null
          || row.parentScriptRevisionId !== row.parentRevisionId : true) blockingReasons.push('PARENT_ANCESTRY_INVALID');
      const composition = await tx.visualComposition.findFirst({ where: { id: row.compositionId, projectId: project }, select: { format: true } });
      const format = composition?.format as VisualFormat | undefined;
      const parent = composition ? await this.parent(tx, project, format!, row.parentKind as ParentKind, row.parentRevisionId, false).catch(error => {
        if (error instanceof ConflictException || error instanceof NotFoundException) return null;
        throw error;
      }) : null;
      if (!parent) { staleReasons.push('PARENT_CHANGED'); blockingReasons.push('PARENT_UNAVAILABLE'); }
      else {
        const parentInspection = await this.inspectParent(tx, project, format!, row);
        staleReasons.push(...parentInspection.staleReasons);
        blockingReasons.push(...parentInspection.blockingReasons);
        if (!parentInspection.eligible) blockingReasons.push('PARENT_NOT_ELIGIBLE');
        try { this.assertMappings(parsed.data, parent); }
        catch (error) { if (error instanceof BadRequestException) blockingReasons.push('EVIDENCE_MAPPING_INVALID'); else throw error; }
      }
      const projectRow = await tx.project.findUnique({ where: { id: project }, select: { workspaceId: true } });
      if (!projectRow) blockingReasons.push('PROJECT_UNAVAILABLE');
      else {
        try {
          const currentResources = await this.resourceRecords(tx, project, projectRow.workspaceId, parsed.data);
          const expectedManifest = currentResources.map(({ ref, mediaType }) => ({ ref, mediaType }));
          if (canonicalManifestHash(row.resourceManifest) !== canonicalManifestHash(expectedManifest)) blockingReasons.push('RESOURCE_MANIFEST_MISMATCH');
        } catch (error) {
          if (error instanceof ConflictException || error instanceof NotFoundException) blockingReasons.push('RESOURCE_UNAVAILABLE');
          else throw error;
        }
      }
      const frameIds = parsed.data.frames.map(frame => frame.id);
      const previewIds = row.previews.map(preview => preview.frameId);
      if (previewIds.length !== frameIds.length || new Set(previewIds).size !== previewIds.length || frameIds.some(id => !previewIds.includes(id))) {
        blockingReasons.push('CANONICAL_PREVIEW_MISSING');
      }
      const firstPreview = row.previews[0];
      if (firstPreview && row.previews.some(preview => preview.rendererVersion !== firstPreview.rendererVersion
        || canonicalManifestHash(preview.fontHashes) !== canonicalManifestHash(firstPreview.fontHashes))) blockingReasons.push('PREVIEW_RECEIPTS_MISMATCH');
      const expectedFontHashes = canonicalManifestHash(FONT_HASHES);
      if (row.previews.some(preview => preview.rendererVersion !== `${row.rendererVersion};chromium-${preview.rendererVersion.split(';chromium-')[1] ?? ''}`
        || !/^konva-[^;]+;chromium-[\w.-]+$/.test(preview.rendererVersion)
        || canonicalManifestHash(preview.fontHashes) !== expectedFontHashes)) blockingReasons.push('PREVIEW_RENDER_RECEIPT_INVALID');
      if (row.previews.some(preview => !Array.isArray(preview.overflow) || preview.overflow.length !== 0)) blockingReasons.push('TEXT_OVERFLOW');
      if (row.previews.some(preview => preview.asset.projectId !== project || preview.asset.mediaType !== 'image/png'
        || preview.asset.state !== AssetState.AVAILABLE || !/^[a-f0-9]{64}$/.test(preview.asset.sha256))) blockingReasons.push('PREVIEW_ASSET_INVALID');
    }
    if (owner?.currentApprovedRevisionId === row.id && (!row.approvedAt || row.withdrawnAt)) blockingReasons.push('APPROVAL_POINTER_INVALID');
    if (row.withdrawnAt) blockingReasons.push('APPROVAL_WITHDRAWN');
    if (row.approvedAt && owner?.currentApprovedRevisionId !== row.id) staleReasons.push('APPROVAL_NOT_CURRENT');
    const stale = [...new Set(staleReasons)], blocking = [...new Set(blockingReasons)];
    return { staleReasons: stale, blockingReasons: blocking, hasUnmapped: parsed.success ? this.unmapped(parsed.data) : false,
      approved: !!row.approvedAt && !row.withdrawnAt && owner?.currentApprovedRevisionId === row.id,
      eligible: !stale.length && !blocking.length && (!row.approvedAt || owner?.currentApprovedRevisionId === row.id) };
  }
  private async state(tx: Prisma.TransactionClient, project: string, format: VisualFormat) {
    const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true, formats: true } });
    const defaults = await this.style(tx, p.workspaceId);
    const owner = await tx.visualComposition.findUnique({ where: { projectId_format: { projectId: project, format } }, include: { draft: true } });
    const selectedParent = owner?.draft
      ? await this.parent(tx, project, format, owner.draft.parentKind as ParentKind, owner.draft.parentRevisionId, false).catch(() => null)
      : await this.currentParent(tx, project, format);
    const parent = selectedParent ? { ...selectedParent, ...(owner?.draft ? await this.inspectParent(tx, project, format, owner.draft) : {}) } : null;
    const revisions = owner ? await tx.visualCompositionRevision.findMany({ where: { projectId: project, compositionId: owner.id }, orderBy: { number: 'desc' }, include: { previews: { include: { asset: { select: { id: true, projectId: true, sha256: true, mediaType: true, state: true } } } } } }) : [];
    return { format, formatSelected: p.formats.includes(format), style: defaults,
      parent,
      composition: owner ? { id: owner.id, revision: owner.revision, currentApprovedRevisionId: owner.currentApprovedRevisionId,
        draft: owner.draft ? { counter: owner.draft.counter, content: owner.draft.content, sha256: owner.draft.sha256,
          parentKind: owner.draft.parentKind, parentRevisionId: owner.draft.parentRevisionId, parentRevisionHash: owner.draft.parentRevisionHash,
          parentReviewCounter: owner.draft.parentReviewCounter, workspaceStyleRevision: owner.draft.workspaceStyleRevision,
          hasUnmapped: this.unmapped(compositionSchema.parse(owner.draft.content)), ...(await this.inspectParent(tx, project, format, owner.draft)) } : null,
        revisions: await Promise.all(revisions.map(async row => ({ id: row.id, number: row.number, content: row.content, sha256: row.sha256,
          approvedBy: row.approvedBy, approvedAt: row.approvedAt, withdrawnBy: row.withdrawnBy, withdrawnAt: row.withdrawnAt, reviewCounter: row.reviewCounter,
          parentKind: row.parentKind, parentRevisionId: row.parentRevisionId, parentRevisionHash: row.parentRevisionHash,
          parentReviewCounter: row.parentReviewCounter, workspaceStyleRevision: row.workspaceStyleRevision,
          previews: row.previews.map(preview => ({ assetId: preview.assetId, frameId: preview.frameId,
            sha256: preview.asset.sha256, rendererVersion: preview.rendererVersion, fontHashes: preview.fontHashes, overflow: preview.overflow })),
          ...(await this.inspectRevision(tx, project, row)) }))) } : null };
  }
  get(user: string, project: string, rawFormat: string) {
    const format = this.format(rawFormat);
    return this.command(user, project, tx => this.state(tx, project, format), false);
  }
  initialize(user: string, project: string, rawFormat: string, input: { parentRevisionId: string }) {
    const format = this.format(rawFormat), kind: ParentKind = format.endsWith('COVER') ? 'ADAPTATION' : 'SCRIPT';
    return this.command(user, project, async tx => {
      if (!safeUuid(input.parentRevisionId)) throw new BadRequestException('Invalid parent revision identifier');
      if (await tx.visualComposition.findUnique({ where: { projectId_format: { projectId: project, format } } })) throw new ConflictException('Visual composition already exists');
      const parent = await this.parent(tx, project, format, kind, input.parentRevisionId);
      if (!parent.eligible) throw new ConflictException('Approved parent needs review before visual initialization');
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      const style = await this.style(tx, p.workspaceId);
      const content = await this.buildInitial(tx, project, format, parent, style.defaults);
      const composition = await tx.visualComposition.create({ data: { projectId: project, workspaceId: p.workspaceId, format, revision: 1 } });
      await tx.visualCompositionDraft.create({ data: { projectId: project, compositionId: composition.id, counter: 1,
        parentKind: kind, parentRevisionId: parent.id, parentRevisionHash: parent.sha256, parentReviewCounter: parent.reviewCounter,
        workspaceId: p.workspaceId, parentAdaptationRevisionId: kind === 'ADAPTATION' ? parent.id : null,
        parentScriptRevisionId: kind === 'SCRIPT' ? parent.id : null, workspaceStyleRevision: style.revision,
        content: json(content), sha256: canonicalManifestHash(content), updatedBy: user } });
      return this.state(tx, project, format);
    });
  }
  saveDraft(user: string, project: string, rawFormat: string, input: { expectedRevision: number; expectedDraftCounter: number; composition: unknown; workspaceStyleRevision?: number }) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const owner = await tx.visualComposition.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if (!owner || owner.revision !== input.expectedRevision) throw new ConflictException('Visual composition changed; reload before saving');
      const draft = await tx.visualCompositionDraft.findUnique({ where: { compositionId: owner.id } });
      if (!draft || draft.counter !== input.expectedDraftCounter) throw new ConflictException('Visual draft changed; reload before saving');
      const sanitized = compositionSchema.safeParse(this.dropInvalidMappings(input.composition));
      if (!sanitized.success) throw new BadRequestException('Invalid visual composition');
      const parent = await this.parent(tx, project, format, draft.parentKind as ParentKind, draft.parentRevisionId, false);
      this.assertMappings(sanitized.data, parent);
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      if (input.workspaceStyleRevision !== undefined) {
        const style = await tx.workspaceStyleRevision.findUnique({ where: { workspaceId_revision: { workspaceId: p.workspaceId, revision: input.workspaceStyleRevision } }, select: { revision: true } });
        if (!style) throw new ConflictException('Workspace style revision is unavailable; reload the style defaults');
      }
      await this.resourceRecords(tx, project, p.workspaceId, sanitized.data);
      await tx.visualCompositionDraft.update({ where: { compositionId: owner.id }, data: { counter: { increment: 1 }, content: json(sanitized.data),
        ...(input.workspaceStyleRevision === undefined ? {} : { workspaceStyleRevision: input.workspaceStyleRevision }),
        sha256: canonicalManifestHash(sanitized.data), updatedBy: user, updatedAt: new Date() } });
      await tx.visualComposition.update({ where: { id: owner.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, format);
    });
  }
  checkpoint(user: string, project: string, rawFormat: string, input: { expectedRevision: number; expectedDraftCounter: number }) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const owner = await tx.visualComposition.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if (!owner || owner.revision !== input.expectedRevision) throw new ConflictException('Visual composition changed; reload before checkpointing');
      const draft = await tx.visualCompositionDraft.findUnique({ where: { compositionId: owner.id } });
      if (!draft || draft.counter !== input.expectedDraftCounter || canonicalManifestHash(draft.content) !== draft.sha256) throw new ConflictException('Visual draft changed or failed integrity check');
      const content = compositionSchema.parse(draft.content);
      const parent = await this.parent(tx, project, format, draft.parentKind as ParentKind, draft.parentRevisionId, false);
      this.assertMappings(content, parent);
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      const resources = await this.resourceRecords(tx, project, p.workspaceId, content);
      const latest = await tx.visualCompositionRevision.findFirst({ where: { compositionId: owner.id }, orderBy: { number: 'desc' } });
      await tx.visualCompositionRevision.create({ data: { projectId: project, compositionId: owner.id, number: (latest?.number ?? 0) + 1,
        parentKind: draft.parentKind, parentRevisionId: draft.parentRevisionId, parentRevisionHash: draft.parentRevisionHash,
        workspaceId: draft.workspaceId, parentAdaptationRevisionId: draft.parentAdaptationRevisionId, parentScriptRevisionId: draft.parentScriptRevisionId,
        parentReviewCounter: draft.parentReviewCounter, workspaceStyleRevision: draft.workspaceStyleRevision, content: json(content),
        sha256: canonicalManifestHash(content), resourceManifest: json(resources.map(({ ref, mediaType }) => ({ ref, mediaType }))),
        rendererVersion: content.rendererVersion, createdBy: user } });
      await tx.visualCompositionDraft.update({ where: { compositionId: owner.id }, data: { counter: { increment: 1 } } });
      await tx.visualComposition.update({ where: { id: owner.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, format);
    });
  }
  refreshParent(user: string, project: string, rawFormat: string, input: { expectedRevision: number }) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const owner = await tx.visualComposition.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if (!owner || owner.revision !== input.expectedRevision) throw new ConflictException('Visual composition changed; reload before refreshing its parent');
      const draft = await tx.visualCompositionDraft.findUnique({ where: { compositionId: owner.id } });
      if (!draft) throw new ConflictException('Visual draft is unavailable');
      const parent = await this.currentParent(tx, project, format);
      if (!parent || !parent.eligible) throw new ConflictException('A current approved parent needs review before rebasing this visual draft');
      const parsed = compositionSchema.safeParse(this.dropInvalidMappings(draft.content));
      if (!parsed.success) throw new ConflictException('Visual draft content is invalid; reload before rebasing');
      const content = structuredClone(parsed.data);
      const allowed = this.sourceMappings(parent);
      const coverMappings = parent.kind === 'ADAPTATION' ? allowed.values().next().value as Set<string> | undefined : undefined;
      for (const frame of content.frames) {
        if (parent.kind === 'ADAPTATION') frame.sourceFrameId = null;
        else if (!frame.sourceFrameId || !allowed.has(frame.sourceFrameId)) frame.sourceFrameId = null;
        const parentMappings = frame.sourceFrameId ? allowed.get(frame.sourceFrameId) : coverMappings;
        for (const layer of frame.layers) if (layer.type === 'text') {
          layer.mappings = layer.mappings.filter(mapping => parentMappings?.has(`${mapping.claimRevisionId}:${mapping.evidenceId}:${mapping.quote}`));
        }
      }
      const rebased = compositionSchema.parse(content);
      this.assertMappings(rebased, parent);
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      await this.resourceRecords(tx, project, p.workspaceId, rebased);
      await tx.visualCompositionDraft.update({ where: { compositionId: owner.id }, data: { counter: { increment: 1 },
        parentKind: parent.kind, parentRevisionId: parent.id, parentRevisionHash: parent.sha256, parentReviewCounter: parent.reviewCounter,
        parentAdaptationRevisionId: parent.kind === 'ADAPTATION' ? parent.id : null,
        parentScriptRevisionId: parent.kind === 'SCRIPT' ? parent.id : null, content: json(rebased), sha256: canonicalManifestHash(rebased),
        updatedBy: user, updatedAt: new Date() } });
      await tx.visualComposition.update({ where: { id: owner.id }, data: { revision: { increment: 1 } } });
      return this.state(tx, project, format);
    });
  }
  review(user: string, project: string, rawFormat: string, revisionId: string, action: 'approve' | 'withdraw', input: {
    expectedRevision: number; expectedReviewCounter: number; acknowledgeUnmapped: boolean;
  }) {
    const format = this.format(rawFormat);
    return this.command(user, project, async tx => {
      const owner = await tx.visualComposition.findUnique({ where: { projectId_format: { projectId: project, format } } });
      if (!owner || owner.revision !== input.expectedRevision) throw new ConflictException('Visual composition changed; reload before reviewing');
      const row = await tx.visualCompositionRevision.findFirst({ where: { id: revisionId, projectId: project, compositionId: owner.id },
        include: { previews: { include: { asset: { select: { id: true, projectId: true, sha256: true, mediaType: true, state: true } } } } } });
      if (!row) throw new NotFoundException('Visual revision not found');
      if (row.reviewCounter !== input.expectedReviewCounter) throw new ConflictException('Visual review counter is missing or stale');
      if (action === 'withdraw') {
        if (!row.approvedAt || row.withdrawnAt) throw new ConflictException('Only an active historical visual approval can be withdrawn');
        await tx.visualCompositionRevision.update({ where: { id: row.id }, data: { withdrawnBy: user, withdrawnAt: new Date(), reviewCounter: { increment: 1 } } });
        await tx.visualComposition.update({ where: { id: owner.id }, data: { revision: { increment: 1 },
          ...(owner.currentApprovedRevisionId === row.id ? { currentApprovedRevisionId: null } : {}) } });
      } else {
        if (row.approvedAt || row.withdrawnAt) throw new ConflictException('Only a new visual checkpoint can be approved');
        const latest = await tx.visualCompositionRevision.findFirst({ where: { compositionId: owner.id }, orderBy: { number: 'desc' }, select: { id: true } });
        const draft = await tx.visualCompositionDraft.findUnique({ where: { compositionId: owner.id } });
        if (latest?.id !== row.id || !draft || canonicalManifestHash(draft.content) !== draft.sha256 || draft.sha256 !== row.sha256
          || draft.parentKind !== row.parentKind || draft.parentRevisionId !== row.parentRevisionId || draft.parentRevisionHash !== row.parentRevisionHash
          || draft.parentReviewCounter !== row.parentReviewCounter || draft.workspaceId !== row.workspaceId
          || draft.parentAdaptationRevisionId !== row.parentAdaptationRevisionId || draft.parentScriptRevisionId !== row.parentScriptRevisionId) {
          throw new ConflictException('Approve only the latest checkpoint matching the current visual draft and exact parent');
        }
        const inspection = await this.inspectRevision(tx, project, row);
        if (inspection.staleReasons.length || inspection.blockingReasons.length || !inspection.eligible) throw new ConflictException('Visual revision needs correction or a new checkpoint before approval');
        if (inspection.hasUnmapped && !input.acknowledgeUnmapped) throw new ConflictException('Acknowledge unmapped visual text before approval');
        await tx.visualCompositionRevision.update({ where: { id: row.id }, data: { approvedBy: user, approvedAt: new Date(), reviewCounter: { increment: 1 } } });
        await tx.visualComposition.update({ where: { id: owner.id }, data: { currentApprovedRevisionId: row.id, revision: { increment: 1 } } });
      }
      return this.state(tx, project, format);
    });
  }
  private sourceMappings(parent: ParentSource) {
    const frames = this.parentFrames(parent);
    return new Map(frames.map(frame => [frame.id, new Set(frame.mappings.map(mapping => `${mapping.claimRevisionId}:${mapping.evidenceId}:${mapping.quote}`))]));
  }
  private assertMappings(content: VisualComposition, parent: ParentSource) {
    const allowed = this.sourceMappings(parent);
    for (const frame of content.frames) for (const layer of frame.layers) if (layer.type === 'text') {
      if (parent.kind === 'ADAPTATION' && frame.sourceFrameId !== null) throw new BadRequestException('Visual cover text source does not match its approved parent');
      if (parent.kind === 'SCRIPT' && frame.sourceFrameId !== null && !allowed.has(frame.sourceFrameId)) throw new BadRequestException('Visual frame source does not match its approved parent');
      const parentMappings = frame.sourceFrameId ? allowed.get(frame.sourceFrameId) : parent.kind === 'ADAPTATION' ? allowed.values().next().value : undefined;
      if (parent.kind === 'SCRIPT' && !frame.sourceFrameId && layer.mappings.length) throw new BadRequestException('New visual text cannot inherit evidence mappings');
      for (const mapping of layer.mappings) if (!parentMappings?.has(`${mapping.claimRevisionId}:${mapping.evidenceId}:${mapping.quote}`)) {
        throw new BadRequestException('Visual evidence mapping is outside its approved parent frame');
      }
    }
  }
  private async resourceRecords(tx: Prisma.TransactionClient, project: string, workspaceId: string, content: VisualComposition) {
    const refs = [...new Map(imageRefs(content).map(ref => [`${ref.type}:${ref.id}`, ref])).values()];
    const resources: Array<{ ref: ImageRef; bucket: string; objectKey: string; sha256: string; mediaType: string }> = [];
    for (const ref of refs) {
      if (ref.type === 'project') {
        const asset = await tx.asset.findFirst({ where: { id: ref.id, projectId: project, state: AssetState.AVAILABLE }, select: { bucket: true, objectKey: true, sha256: true, mediaType: true } });
        if (!asset || asset.sha256 !== ref.sha256 || !['image/png', 'image/jpeg'].includes(asset.mediaType)) throw new ConflictException('Project image resource changed or is unavailable');
        resources.push({ ref, ...asset });
      } else {
        const asset = await tx.workspaceVisualAsset.findFirst({ where: { id: ref.id, workspaceId }, select: { bucket: true, objectKey: true, sha256: true, mediaType: true } });
        if (!asset || asset.sha256 !== ref.sha256 || !['image/png', 'image/jpeg'].includes(asset.mediaType)) throw new ConflictException('Workspace image resource changed or is unavailable');
        resources.push({ ref, ...asset });
      }
    }
    return resources;
  }
  private async loadResources(records: Awaited<ReturnType<VisualService['resourceRecords']>>) {
    return Promise.all(records.map(async row => ({ ref: row.ref, mediaType: row.mediaType,
      bytes: await this.storage.read(row.bucket, row.objectKey, row.sha256) })));
  }
  private async discardStaged(project: string, workspaceId: string, user: string, stored: { bucket: string; objectKey: string }) {
    const id = randomUUID();
    try {
      await this.prisma.privateObjectDeletion.create({ data: { id, projectId: project, workspaceId, requestedBy: user,
        bucket: stored.bucket, objectKey: stored.objectKey } });
    } catch {
      try { await this.storage.remove(stored.bucket, stored.objectKey); return; }
      catch { throw new ServiceUnavailableException('Private staged visual asset requires cleanup'); }
    }
    try {
      await this.storage.remove(stored.bucket, stored.objectKey);
      await this.prisma.privateObjectDeletion.update({ where: { id }, data: { state: 'DELETED', deletedAt: new Date(), errorCategory: null } });
    } catch { /* The durable cleanup journal retries this object. */ }
  }
  async createAsset(user: string, project: string, rawScope: string, input: { filename: string; mediaType: string; base64: string }) {
    if (!workspaceScope(rawScope) || !['image/png', 'image/jpeg'].includes(input.mediaType) || input.base64.length > 7_000_000
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new BadRequestException('Invalid raster image input');
    const bytes = Buffer.from(input.base64, 'base64');
    if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== input.base64) throw new BadRequestException('Raster image exceeds its size limit');
    const p = await this.command(user, project, tx => tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } }), false);
    const normalized = await this.renderer.normalizeImage(bytes, input.mediaType as 'image/png' | 'image/jpeg');
    const assetId = randomUUID(), digest = normalized.sha256 || hashBytes(normalized.bytes);
    const stored = rawScope === 'PROJECT' ? await this.storage.put(project, assetId, normalized.bytes)
      : await this.storage.putWorkspaceVisual(p.workspaceId, assetId, normalized.bytes);
    try {
      return await this.command(user, project, async tx => {
        const latest = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
        if (latest.workspaceId !== p.workspaceId) throw new ConflictException('Project Workspace changed; retry upload');
        if (rawScope === 'PROJECT') {
          const asset = await tx.asset.create({ data: { id: assetId, projectId: project, bucket: stored.bucket, objectKey: stored.objectKey,
            mediaType: normalized.mediaType, bytes: BigInt(normalized.bytes.length), sha256: digest, state: AssetState.AVAILABLE, purpose: AssetPurpose.GENERATED, createdBy: user } });
          return { scope: rawScope, id: asset.id, ref: { type: 'project', id: asset.id, sha256: asset.sha256 }, mediaType: asset.mediaType, bytes: Number(asset.bytes) };
        }
        const asset = await tx.workspaceVisualAsset.create({ data: { id: assetId, workspaceId: p.workspaceId, bucket: stored.bucket, objectKey: stored.objectKey,
          mediaType: normalized.mediaType, bytes: BigInt(normalized.bytes.length), sha256: digest, createdBy: user } });
        return { scope: rawScope, id: asset.id, ref: { type: 'workspace', id: asset.id, sha256: asset.sha256 }, mediaType: asset.mediaType, bytes: Number(asset.bytes) };
      });
    } catch (error) { await this.discardStaged(project, p.workspaceId, user, stored); throw error; }
  }
  async preview(user: string, project: string, rawFormat: string, revisionId: string, frameId: string) {
    const format = this.format(rawFormat);
    const staged = await this.command(user, project, async tx => {
      const revision = await tx.visualCompositionRevision.findFirst({ where: { id: revisionId, projectId: project }, include: { composition: true } });
      if (!revision || revision.composition.format !== format) throw new NotFoundException('Visual revision not found');
      const content = compositionSchema.safeParse(revision.content);
      if (!content.success || canonicalManifestHash(revision.content) !== revision.sha256) throw new ConflictException('Visual revision integrity check failed');
      const frame = content.data.frames.find(item => item.id === frameId);
      if (!frame) throw new NotFoundException('Visual frame not found');
      const prior = await tx.visualPreview.findFirst({ where: { projectId: project, revisionId, frameId }, include: { asset: true } });
      if (prior) return { prior: { assetId: prior.assetId, frameId, sha256: prior.asset.sha256, rendererVersion: prior.rendererVersion,
        fontHashes: prior.fontHashes, overflow: prior.overflow } };
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      const resources = await this.resourceRecords(tx, project, p.workspaceId, content.data);
      return { prior: null, compositionId: revision.compositionId, revisionSha256: revision.sha256, content: content.data, workspaceId: p.workspaceId, resources };
    }, false);
    if (staged.prior) return staged.prior;
    const resources = await this.loadResources(staged.resources);
    const rendered = await this.renderer.render(staged.content, frameId, resources);
    if (hashBytes(rendered.bytes) !== rendered.sha256) throw new ConflictException('Canonical renderer output failed integrity verification');
    const assetId = randomUUID(), stored = await this.storage.putExport(project, assetId, rendered.bytes);
    try {
      const committed = await this.command(user, project, async tx => {
        const revision = await tx.visualCompositionRevision.findFirst({ where: { id: revisionId, projectId: project }, include: { composition: true } });
        if (!revision || revision.compositionId !== staged.compositionId || revision.composition.format !== format || revision.sha256 !== staged.revisionSha256
          || canonicalManifestHash(revision.content) !== revision.sha256) throw new ConflictException('Visual revision changed; reload before preview');
        const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
        if (p.workspaceId !== staged.workspaceId) throw new ConflictException('Project Workspace changed; retry preview');
        const currentResources = await this.resourceRecords(tx, project, p.workspaceId, staged.content);
        if (canonicalManifestHash(currentResources.map(({ ref, mediaType }) => ({ ref, mediaType })))
          !== canonicalManifestHash(staged.resources.map(({ ref, mediaType }) => ({ ref, mediaType })))) throw new ConflictException('Visual image resources changed; reload before preview');
        const prior = await tx.visualPreview.findFirst({ where: { projectId: project, revisionId, frameId }, include: { asset: true } });
        if (prior) return { existed: true, result: { assetId: prior.assetId, frameId, sha256: prior.asset.sha256, rendererVersion: prior.rendererVersion,
          fontHashes: prior.fontHashes, overflow: prior.overflow } };
        const asset = await tx.asset.create({ data: { id: assetId, projectId: project, bucket: stored.bucket, objectKey: stored.objectKey,
          mediaType: 'image/png', bytes: BigInt(rendered.bytes.length), sha256: rendered.sha256, state: AssetState.AVAILABLE, purpose: AssetPurpose.GENERATED, createdBy: user } });
        const preview = await tx.visualPreview.create({ data: { projectId: project, workspaceId: staged.workspaceId, compositionId: staged.compositionId, revisionId,
          assetId, frameId, rendererVersion: rendered.rendererVersion, fontHashes: json(rendered.fontHashes), overflow: json(rendered.overflow) } });
        return { existed: false, result: { assetId: asset.id, frameId, sha256: asset.sha256, rendererVersion: preview.rendererVersion,
          fontHashes: preview.fontHashes, overflow: preview.overflow } };
      });
      if (committed.existed) await this.discardStaged(project, staged.workspaceId, user, stored);
      return committed.result;
    } catch (error) { await this.discardStaged(project, staged.workspaceId, user, stored); throw error; }
  }
  async readPreview(user: string, project: string, assetId: string) {
    const meta = await this.command(user, project, async tx => {
      const preview = await tx.visualPreview.findFirst({ where: { projectId: project, assetId }, include: { asset: true } });
      if (!preview || preview.asset.mediaType !== 'image/png' || preview.asset.state !== AssetState.AVAILABLE) throw new NotFoundException('Visual preview not found');
      return { bucket: preview.asset.bucket, objectKey: preview.asset.objectKey, sha256: preview.asset.sha256 };
    }, false);
    const bytes = await this.storage.read(meta.bucket, meta.objectKey, meta.sha256);
    await this.command(user, project, async tx => {
      const current = await tx.visualPreview.findFirst({ where: { projectId: project, assetId }, include: { asset: true } });
      if (!current || current.asset.sha256 !== meta.sha256) throw new NotFoundException('Visual preview not found');
    }, false);
    return bytes;
  }
  async readAsset(user: string, project: string, scope: string, assetId: string) {
    if (!workspaceScope(scope)) throw new BadRequestException('Invalid visual asset scope');
    const meta = await this.command(user, project, async tx => {
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      const asset = scope === 'PROJECT'
        ? await tx.asset.findFirst({ where: { projectId: project, id: assetId, state: AssetState.AVAILABLE, mediaType: { in: ['image/png', 'image/jpeg'] } } })
        : await tx.workspaceVisualAsset.findFirst({ where: { workspaceId: p.workspaceId, id: assetId, mediaType: { in: ['image/png', 'image/jpeg'] } } });
      if (!asset) throw new NotFoundException('Visual image not found');
      return { bucket: asset.bucket, objectKey: asset.objectKey, sha256: asset.sha256, mediaType: asset.mediaType };
    }, false);
    const bytes = await this.storage.read(meta.bucket, meta.objectKey, meta.sha256);
    await this.command(user, project, async tx => {
      const p = await tx.project.findUniqueOrThrow({ where: { id: project }, select: { workspaceId: true } });
      const current = scope === 'PROJECT'
        ? await tx.asset.findFirst({ where: { id: assetId, projectId: project, sha256: meta.sha256, state: AssetState.AVAILABLE }, select: { id: true } })
        : await tx.workspaceVisualAsset.findFirst({ where: { id: assetId, workspaceId: p.workspaceId, sha256: meta.sha256 }, select: { id: true } });
      if (!current) throw new NotFoundException('Visual image not found');
    }, false);
    return { bytes, mediaType: meta.mediaType };
  }
}
