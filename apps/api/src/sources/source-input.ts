import { z } from 'zod';
import { MaterialPurpose } from '@contextflow/backend';

const label = z.string().trim().min(1).max(200);
const purpose = z.enum(MaterialPurpose);
const text = z.string().min(1).max(200_000);
export const resourceIdInput = z.uuid();
export const createTextSourceInput = z.object({ label, purpose, text }).strict();
export const updateMaterialInput = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646),
  label: label.optional(), purpose: purpose.optional(), included: z.boolean().optional(),
}).strict().refine(value => value.label !== undefined || value.purpose !== undefined || value.included !== undefined);
export const appendSnapshotInput = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646), text,
}).strict();
export const uploadSourceInput = z.object({ label, purpose }).strict();
export type CreateTextSourceInput = z.infer<typeof createTextSourceInput>;
export type UpdateMaterialInput = z.infer<typeof updateMaterialInput>;
export type AppendSnapshotInput = z.infer<typeof appendSnapshotInput>;
export type UploadSourceInput = z.infer<typeof uploadSourceInput>;
