import { z } from 'zod';

export const PRESENCE_PAGES = [
  'article', 'outline', 'brief', 'telegram', 'linkedin-text', 'linkedin-cover', 'instagram-cover',
  'linkedin-carousel', 'instagram-carousel', 'instagram-stories',
] as const;

export const presencePageSchema = z.enum(PRESENCE_PAGES);
export const presenceHeartbeatSchema = z.object({ page: presencePageSchema, clientId: z.uuid() }).strict();
export const PRESENCE_TTL_SECONDS = 60;
export const PRESENCE_HEARTBEAT_SECONDS = 20;
export const PRESENCE_POLL_SECONDS = 20;

export type PresencePage = z.infer<typeof presencePageSchema>;
export type PresenceHeartbeat = z.infer<typeof presenceHeartbeatSchema>;
export type PresencePerson = { userId: string; displayName: string };
export type ProjectPresence = { page: PresencePage; ttlSeconds: number; heartbeatSeconds: number; pollSeconds: number; people: PresencePerson[] };
