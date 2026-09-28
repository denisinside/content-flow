import { z } from 'zod';

export const workspaceIdInput = z.uuid();
const workspaceName = z.string().trim().min(1).max(120);
const email = z.email().trim().max(254).transform(value => value.toLowerCase());
export const createWorkspaceInput = z.object({ name: workspaceName }).strict();
export const listWorkspacesInput = z.object({ cursor: z.uuid().optional() }).strict();
export const inviteInput = z.object({ email }).strict();
export const acceptInviteInput = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const transferInput = z.object({ userId: z.uuid() }).strict();

const settingValue = z.union([z.string().max(500), z.boolean(), z.number().finite()]);
const settings = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), settingValue)
  .refine(value => Object.keys(value).length <= 50);
export const updateStyleInput = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646),
  brandbook: z.string().max(50_000).optional(),
  tone: z.string().max(10_000).optional(),
  settings: settings.optional()
}).strict().refine(value => value.brandbook !== undefined || value.tone !== undefined || value.settings !== undefined);

export type UpdateStyleInput = z.infer<typeof updateStyleInput>;
