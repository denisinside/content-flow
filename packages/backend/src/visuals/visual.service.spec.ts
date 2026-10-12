import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DEFAULT_VISUAL_STYLE, makeFrame, type VisualComposition } from '@contextflow/visuals';
import { VisualService } from './visual.service.js';

const ids = {
  project: '10000000-0000-4000-8000-000000000001', sourceFrame: '20000000-0000-4000-8000-000000000002',
  claim: '30000000-0000-4000-8000-000000000003', evidence: '40000000-0000-4000-8000-000000000004',
  foreignClaim: '50000000-0000-4000-8000-000000000005', foreignEvidence: '60000000-0000-4000-8000-000000000006',
};

function fixture() {
  const service = new VisualService({} as PrismaClient, {} as never, {} as never, {} as never, {} as never);
  return service as unknown as { assertMappings(content: VisualComposition, parent: { kind: 'SCRIPT' | 'ADAPTATION'; id: string; sha256: string; reviewCounter: number; content: unknown; staleReasons: string[]; blockingReasons: string[]; eligible: boolean }): void };
}

describe('visual composition source invariants', () => {
it('visual text cannot import an evidence mapping absent from its exact approved source frame', () => {
  const service = fixture();
  const parent = { kind: 'SCRIPT' as const, id: ids.sourceFrame, sha256: 'a'.repeat(64), reviewCounter: 1,
    content: { frames: [{ id: ids.sourceFrame, purpose: 'Fact', text: 'Точне джерельне твердження', visualHint: '', transition: '',
      mappings: [{ startOffset: 0, endOffset: 8, quote: 'Точне дж', claimRevisionId: ids.claim, evidenceId: ids.evidence }] }] },
    staleReasons: [], blockingReasons: [], eligible: true };
  const frame = makeFrame({ id: ids.sourceFrame, text: 'Точне джерельне твердження', purpose: 'Fact',
    mappings: [{ startOffset: 0, endOffset: 8, quote: 'Точне дж', claimRevisionId: ids.foreignClaim, evidenceId: ids.foreignEvidence }] }, 1350, 'editorial', DEFAULT_VISUAL_STYLE);
  const composition = { schemaVersion: 'visual-v1', rendererVersion: 'konva-10.7.1-visual-v1', width: 1080, height: 1350, frames: [frame] } as VisualComposition;
  expect(() => service.assertMappings(composition, parent)).toThrow(/outside its approved parent/);
});

it('cover initialization rejects a revision that is no longer the current approved adaptation', async () => {
  let creates = 0;
  const tx = {
    $queryRaw: async () => [{ id: ids.project }],
    project: { findUniqueOrThrow: async () => ({ formats: ['LINKEDIN_COVER'], workspaceId: ids.project }) },
    adaptation: { findUnique: async () => ({ id: ids.project, currentApprovedRevisionId: ids.evidence }) },
    adaptationRevision: { findFirst: async () => ({ id: ids.claim, approvedAt: new Date(), withdrawnAt: null }) },
    visualComposition: { findUnique: async () => null, create: async () => { creates++; return {}; } },
  };
  const prisma = { $transaction: async (run: (client: unknown) => unknown) => run(tx) };
  const service = new VisualService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  await expect(service.initialize(ids.project, ids.project, 'LINKEDIN_COVER', { parentRevisionId: ids.claim })).rejects.toThrow(/current approved cover adaptation/);
  expect(creates).toBe(0);
});

it('script visual initialization rejects a revision that is no longer current and approved', async () => {
  let creates = 0;
  const tx = {
    $queryRaw: async () => [{ id: ids.project }],
    project: { findUniqueOrThrow: async () => ({ formats: ['INSTAGRAM_CAROUSEL'], workspaceId: ids.project }) },
    script: { findUnique: async () => ({ id: ids.project, currentApprovedRevisionId: ids.evidence }) },
    scriptRevision: { findFirst: async () => ({ id: ids.claim, approvedAt: new Date(), withdrawnAt: null }) },
    visualComposition: { findUnique: async () => null, create: async () => { creates++; return {}; } },
  };
  const prisma = { $transaction: async (run: (client: unknown) => unknown) => run(tx) };
  const service = new VisualService(prisma as never, {} as never, {} as never, {} as never, {} as never);
  await expect(service.initialize(ids.project, ids.project, 'INSTAGRAM_CAROUSEL', { parentRevisionId: ids.claim })).rejects.toThrow(/current approved carousel or stories script/);
  expect(creates).toBe(0);
});
});
