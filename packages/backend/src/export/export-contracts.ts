import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const exportFormatSchema = z.enum(['TXT', 'MARKDOWN', 'JSON', 'ZIP']);
export const exportItemFormatSchema = z.enum(['ARTICLE', 'TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER',
  'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'LINKEDIN_CAROUSEL_SCRIPT', 'INSTAGRAM_CAROUSEL_SCRIPT', 'INSTAGRAM_STORIES_SCRIPT']);
const selectionSchema = z.object({ format: exportItemFormatSchema, revisionId: z.uuid(), reviewCounter: z.number().int().nonnegative() }).strict();
export const createExportInput = z.object({ expectedProjectRevision: z.number().int().nonnegative(), commandKey: z.string().regex(/^[\w-]{1,128}$/u),
  format: exportFormatSchema, items: z.array(selectionSchema).min(1).max(11) }).strict().superRefine((value, ctx) => {
  if (value.format !== 'ZIP' && value.items.length !== 1) ctx.addIssue({ code: 'custom', message: 'Individual export requires exactly one output' });
  const script = value.items.some(item => item.format.endsWith('_SCRIPT'));
  if (value.format === 'JSON' && (!script || value.items.length !== 1)) ctx.addIssue({ code: 'custom', message: 'JSON export requires exactly one approved script' });
  if (script && value.format === 'TXT') ctx.addIssue({ code: 'custom', message: 'Scripts are available as JSON, Markdown, or ZIP' });
  if (new Set(value.items.map(item => item.format)).size !== value.items.length) ctx.addIssue({ code: 'custom', message: 'Output formats must be unique' });
});
export const exportManifestItemSchema = z.object({ format: exportItemFormatSchema, revisionId: z.uuid(), number: z.number().int().positive(),
  sha256: hash, contentMode: z.enum(['FACTUAL', 'CREATIVE']), reviewCounter: z.number().int().nonnegative(),
  provenance: z.record(z.string(), z.json()) }).strict();
export const exportManifestSchema = z.object({ schemaVersion: z.literal('export-manifest-v1'), projectId: z.uuid(), projectRevision: z.number().int().nonnegative(),
  formats: z.array(exportItemFormatSchema).min(1).max(11), format: exportFormatSchema, frozenAt: z.iso.datetime(),
  items: z.array(exportManifestItemSchema).min(1).max(11), sources: z.array(z.record(z.string(), z.json())).max(10000) }).strict();
export const exportJobManifestSchema = z.object({ schemaVersion: z.literal('export-job-v1'), requestId: z.uuid(), manifestHash: hash, commandHash: hash }).strict();
export type CreateExportInput = z.infer<typeof createExportInput>;
export type ExportManifest = z.infer<typeof exportManifestSchema>;
export type ExportManifestItem = z.infer<typeof exportManifestItemSchema>;
export type ExportJobManifest = z.infer<typeof exportJobManifestSchema>;
