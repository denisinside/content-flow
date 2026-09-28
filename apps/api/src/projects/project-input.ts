import { z } from 'zod';
import { ProjectFormat } from '@contextflow/backend';

const topic = z.string().trim().min(1).max(500);
const formats = z.array(z.enum(ProjectFormat)).min(1).max(Object.keys(ProjectFormat).length).refine(values => new Set(values).size === values.length);
export const projectIdInput = z.uuid();
export const createProjectInput = z.object({ workspaceId: z.uuid(), topic, formats }).strict();
export const updateProjectInput = z.object({ expectedRevision: z.number().int().positive().max(2_147_483_646), topic: topic.optional(), formats: formats.optional() })
  .strict().refine(value => value.topic !== undefined || value.formats !== undefined);
export const listProjectsInput = z.object({ cursor: z.uuid().optional(), workspaceId: z.uuid().optional() }).strict();
export type CreateProjectInput = z.infer<typeof createProjectInput>;
export type UpdateProjectInput = z.infer<typeof updateProjectInput>;
