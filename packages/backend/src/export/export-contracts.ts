import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const exportFormatSchema = z.enum(['TXT', 'MARKDOWN', 'JSON', 'PNG', 'PDF', 'ZIP']);
export const exportItemFormatSchema = z.enum(['ARTICLE', 'TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER',
  'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'LINKEDIN_CAROUSEL_SCRIPT', 'INSTAGRAM_CAROUSEL_SCRIPT', 'INSTAGRAM_STORIES_SCRIPT',
  'LINKEDIN_COVER_VISUAL', 'INSTAGRAM_COVER_VISUAL', 'LINKEDIN_CAROUSEL_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL', 'INSTAGRAM_STORIES_VISUAL']);
const selectionSchema = z.object({ format: exportItemFormatSchema, revisionId: z.uuid(), reviewCounter: z.number().int().nonnegative() }).strict();
export const createExportInput = z.object({ expectedProjectRevision: z.number().int().nonnegative(), commandKey: z.string().regex(/^[\w-]{1,128}$/u),
  format: exportFormatSchema, items: z.array(selectionSchema).min(1).max(16) }).strict().superRefine((value, ctx) => {
  if (value.format !== 'ZIP' && value.items.length !== 1) ctx.addIssue({ code: 'custom', message: 'Individual export requires exactly one output' });
  const script = value.items.some(item => item.format.endsWith('_SCRIPT'));
  const visuals = value.items.filter(item => item.format.endsWith('_VISUAL'));
  if (value.format === 'JSON' && (!script || value.items.length !== 1)) ctx.addIssue({ code: 'custom', message: 'JSON export requires exactly one approved script' });
  if (script && value.format === 'TXT') ctx.addIssue({ code: 'custom', message: 'Scripts are available as JSON, Markdown or ZIP' });
  if (value.format === 'PNG' && (value.items.length !== 1 || !visuals[0]?.format.endsWith('_COVER_VISUAL')))
    ctx.addIssue({ code: 'custom', message: 'PNG export requires exactly one approved cover visual' });
  if (value.format === 'PDF' && (value.items.length !== 1 || !visuals[0]?.format.endsWith('_CAROUSEL_VISUAL')))
    ctx.addIssue({ code: 'custom', message: 'PDF export requires exactly one approved carousel visual' });
  if (visuals.length && !['PNG', 'PDF', 'ZIP'].includes(value.format)) ctx.addIssue({ code: 'custom', message: 'Visuals are available as PNG, PDF or ZIP' });
  if (new Set(value.items.map(item => item.format)).size !== value.items.length) ctx.addIssue({ code: 'custom', message: 'Output formats must be unique' });
});
export const visualFrameReceiptSchema = z.object({ frameId: z.uuid(), ordinal: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(),
  previewAssetId: z.uuid(), sha256: hash, rendererVersion: z.string().min(1).max(200), fontHashes: z.record(z.string(), hash) }).strict();
export const visualExportReceiptSchema = z.object({ compositionHash: hash, width: z.number().int().positive(), height: z.number().int().positive(),
  templateIds: z.array(z.string().min(1).max(100)), resourceManifest: z.array(z.record(z.string(), z.json())).max(100), rendererVersion: z.string().min(1).max(200),
  frames: z.array(visualFrameReceiptSchema).min(1).max(100) }).strict();
export const exportManifestItemSchema = z.object({ format: exportItemFormatSchema, revisionId: z.uuid(), number: z.number().int().positive(),
  sha256: hash, contentMode: z.enum(['FACTUAL', 'CREATIVE']), reviewCounter: z.number().int().nonnegative(),
  provenance: z.record(z.string(), z.json()), visual: visualExportReceiptSchema.optional() }).strict().superRefine((value, ctx) => {
    if (value.format.endsWith('_VISUAL') !== (value.visual !== undefined)) ctx.addIssue({ code: 'custom', message: 'Visual targets require an exact visual render receipt' });
  });
export const exportManifestSchema = z.object({ schemaVersion: z.literal('export-manifest-v1'), projectId: z.uuid(), projectRevision: z.number().int().nonnegative(),
  formats: z.array(exportItemFormatSchema).min(1).max(16), format: exportFormatSchema, frozenAt: z.iso.datetime(),
  items: z.array(exportManifestItemSchema).min(1).max(16), sources: z.array(z.record(z.string(), z.json())).max(10000) }).strict();
export const exportJobManifestSchema = z.object({ schemaVersion: z.literal('export-job-v1'), requestId: z.uuid(), manifestHash: hash, commandHash: hash }).strict();
export type CreateExportInput = z.infer<typeof createExportInput>;
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ExportManifestItem = z.infer<typeof exportManifestItemSchema>;
export type ExportJobManifest = z.infer<typeof exportJobManifestSchema>;
