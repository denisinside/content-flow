import { describe, expect, it } from 'vitest';
import { claimsOutputSchema, freezeBasisInput, MAX_CLAIMS_PER_EXTRACTION } from './contracts.js';

const evidence = { snapshotId: '00000000-0000-4000-8000-000000000001', fragmentId: '00000000-0000-4000-8000-000000000002',
  startOffset: 0, endOffset: 1, quote: 'x', sha256: 'a'.repeat(64), relation: 'SUPPORTS' as const };
function output(count: number) {
  return { schemaVersion: 'claims-v1', claims: Array.from({ length: count }, (_, index) => ({ key: `claim-${index}`,
    wording: `Synthetic claim ${index}`, evidence: [evidence] })), conflicts: [] };
}

describe('claims capacity contract', () => {
  it('accepts 500 candidates and basis references while keeping evidence and conflict bounds', () => {
    expect(MAX_CLAIMS_PER_EXTRACTION).toBe(500);
    expect(claimsOutputSchema.safeParse(output(500)).success).toBe(true);
    expect(freezeBasisInput.safeParse({ claimRevisionIds: Array.from({ length: 500 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`) }).success).toBe(true);

    const tooManyEvidence = { ...output(1), claims: [{ ...output(1).claims[0]!, evidence: Array.from({ length: 11 }, () => evidence) }] };
    expect(claimsOutputSchema.safeParse(tooManyEvidence).success).toBe(false);
    expect(claimsOutputSchema.safeParse({ ...output(1), conflicts: [{ claimKeys: Array.from({ length: 11 }, (_, i) => `key-${i}`), rationale: 'Synthetic' }] }).success).toBe(false);
  });

  it('rejects 501 candidates and 501 basis references', () => {
    expect(claimsOutputSchema.safeParse(output(501)).success).toBe(false);
    const tooManyIds = Array.from({ length: 501 }, (_, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
    expect(freezeBasisInput.safeParse({ claimRevisionIds: tooManyIds }).success).toBe(false);
  });
});
