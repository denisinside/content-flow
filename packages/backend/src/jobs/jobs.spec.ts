import { describe, expect, it } from 'vitest';
import { canonicalManifestHash } from './job-service.js';
import { retryAllowed } from './contracts.js';

describe('durable command and retry policy', () => {
  it('hashes canonical keys while retaining exact array/input versions', () => {
    expect(canonicalManifestHash({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalManifestHash({ a: { c: 3, d: 4 }, b: 2 }));
    expect(canonicalManifestHash({ snapshots: ['a', 'b'] })).not.toBe(canonicalManifestHash({ snapshots: ['b', 'a'] }));
    expect(() => canonicalManifestHash({ invalid: undefined })).toThrow();
  });
  it('requires a known failed or unsubmitted outcome, a safe category, and a remaining attempt/deadline', () => {
    const job = { status: 'FAILED' as const, attemptCount: 2, errorCategory: 'TRANSIENT_TRANSPORT', providerOutcome: 'KNOWN_FAILED' as const, deadlineAt: new Date(Date.now() + 5000) };
    expect(retryAllowed(job)).toBe(true);
    for (const providerOutcome of ['UNKNOWN', 'MAY_STILL_RUN', 'KNOWN_SUCCEEDED'] as const) expect(retryAllowed({ ...job, providerOutcome })).toBe(false);
    expect(retryAllowed({ ...job, attemptCount: 3 })).toBe(false);
    expect(retryAllowed({ ...job, errorCategory: 'INVALID_CONTRACT' })).toBe(false);
    expect(retryAllowed({ ...job, deadlineAt: new Date(0) })).toBe(false);
  });
});
