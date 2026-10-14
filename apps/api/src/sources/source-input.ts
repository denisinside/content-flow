import { z } from 'zod';
import { MaterialPurpose } from '@contextflow/backend';

const label = z.string().trim().min(1).max(200);
const optionalCreateLabel = z.string().trim().max(200).optional().transform(value => value || undefined);
const purpose = z.enum(MaterialPurpose);
const text = z.string().min(1).max(200_000);
export const resourceIdInput = z.uuid();
export const createTextSourceInput = z.object({ label: optionalCreateLabel, purpose, text }).strict();
export const updateMaterialInput = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646),
  label: label.optional(), purpose: purpose.optional(), included: z.boolean().optional(),
}).strict().refine(value => value.label !== undefined || value.purpose !== undefined || value.included !== undefined);
export const appendSnapshotInput = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646), text,
}).strict();
export const uploadSourceInput = z.object({ label: optionalCreateLabel, purpose }).strict();
export const importUrlInput = z.object({ label: optionalCreateLabel, purpose, url: z.string().min(1).max(2048), commandKey: z.uuid() }).strict();
export const importDocumentInput = z.object({ label: optionalCreateLabel, purpose, commandKey: z.uuid() }).strict();
export const reimportSourceInput = z.object({ expectedRevision: z.number().int().positive().max(2_147_483_646), commandKey: z.uuid() }).strict();
export type CreateTextSourceInput = z.infer<typeof createTextSourceInput>;
export type UpdateMaterialInput = z.infer<typeof updateMaterialInput>;
export type AppendSnapshotInput = z.infer<typeof appendSnapshotInput>;
export type UploadSourceInput = z.infer<typeof uploadSourceInput>;
export type ImportUrlInput = z.infer<typeof importUrlInput>;
export type ImportDocumentInput = z.infer<typeof importDocumentInput>;
export type ReimportSourceInput = z.infer<typeof reimportSourceInput>;

/** Deterministic human-readable label when the user leaves the creation label blank. */
export function defaultSourceLabel(kind: 'TEXT' | 'FILE' | 'URL', value: string): string {
  if (kind === 'TEXT') {
    const collapsed = value.replace(/\s+/gu, ' ').trim();
    const points = Array.from(collapsed);
    return points.length > 80 ? `${points.slice(0, 80).join('')}…` : collapsed;
  }

  const points = Array.from(value);
  let result = '';
  for (const point of points) {
    if (result.length + point.length > 199) break;
    result += point;
  }
  if (result.length < value.length) result += '…';
  return result || (kind === 'URL' ? 'Вебсторінка' : 'Файл');
}
