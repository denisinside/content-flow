import { describe, expect, it } from 'vitest';
import type { RelevanceCandidate, RelevanceOutput } from './relevance-contracts.js';
import { selectRelevantCandidates } from './relevance-selection.js';

const candidate = (id: string, snapshotId: string, quote = id): RelevanceCandidate => ({ id: id.repeat(64).slice(0, 64),
  snapshotId, fragmentId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`, startOffset: 0,
  endOffset: quote.length, quote, sha256: 'a'.repeat(64), snapshotSha256: 'b'.repeat(64), label: snapshotId });
const output = (ids: readonly string[]): RelevanceOutput => ({ schemaVersion: 'source-relevance-v1', requestId: '00000000-0000-4000-8000-000000000001',
  requestHash: 'c'.repeat(64), decisions: [], rankedIds: ids.map(id => id.repeat(64).slice(0, 64)) });

describe('selectRelevantCandidates', () => {
  it('round-robins only useful candidates and never fills from rejected candidates', () => {
    const rows = [candidate('1', 'a'), candidate('2', 'a'), candidate('3', 'b')];
    const result = selectRelevantCandidates({ candidates: rows, output: output(['1', '2', '3']), maxPassages: 2, byteBudget: 10 });
    expect(result.candidates.map(row => row.id)).toEqual([rows[0]!.id, rows[2]!.id]);
    expect(result.hasMore).toBe(true);
  });

  it('returns an empty valid selection when the relevance model rejects everything', () => {
    const result = selectRelevantCandidates({ candidates: [candidate('1', 'a')], output: output([]), maxPassages: 20, byteBudget: 100 });
    expect(result).toMatchObject({ candidates: [], hasMore: false, usefulCount: 0, usedBytes: 0 });
  });

  it('skips a quote that exceeds remaining bytes while allowing later smaller sources', () => {
    const rows = [candidate('1', 'a', 'large-large'), candidate('2', 'b', 'small')];
    const result = selectRelevantCandidates({ candidates: rows, output: output(['1', '2']), maxPassages: 20, byteBudget: 6 });
    expect(result.candidates.map(row => row.id)).toEqual([rows[1]!.id]);
    expect(result.hasMore).toBe(true);
  });
});
