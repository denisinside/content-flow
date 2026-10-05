import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DifyOutlineProvider, OutlineProviderError, outlineWorkflowRelease, outlineWorkflowSettings } from './provider.js';
import { canonicalManifestHash } from '../jobs/job-service.js';

const directory = new URL('./workflows/outline-generation/', import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json', directory), 'utf8')) as Record<string, string>;
const env = { NODE_ENV: 'test', TEST_DIFY_API_BASE_URL: 'https://dify.example.test/v1',
  TEST_DIFY_OUTLINE_GENERATION_PUBLISHED_WORKFLOW_ID: randomUUID(), TEST_DIFY_OUTLINE_GENERATION_API_KEY: 'synthetic-outline-key',
  TEST_DIFY_OUTLINE_GENERATION_CONFIG_SHA256: release['configDigest'] };
describe('controlled outline workflow boundary', () => {
  it('pins the exact prompt, native graph and complete configuration without secrets', () => {
    const hash = (name: string) => createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex');
    expect(hash('prompt.md')).toBe(release['promptSha256']);
    expect(hash('outline-generation-v1.yml')).toBe(release['workflowDslSha256']);
    const { configDigest, ...unsigned } = release;
    expect(canonicalManifestHash(unsigned)).toBe(configDigest);
    expect(outlineWorkflowRelease(env)).toMatchObject({ configDigest, contractVersion: 'outline-v1', releaseId: release['releaseId'] });
    expect(outlineWorkflowRelease(env)).not.toHaveProperty('apiKey');
  });
  it('requires separate outline credentials and a matching release attestation, with no TEST fallback', () => {
    expect(() => outlineWorkflowSettings({ ...env, TEST_DIFY_OUTLINE_GENERATION_CONFIG_SHA256: '0'.repeat(64) })).toThrow(OutlineProviderError);
    expect(() => outlineWorkflowSettings({ NODE_ENV: 'test', DIFY_OUTLINE_GENERATION_API_KEY: 'development-secret' })).toThrow(OutlineProviderError);
    expect(() => outlineWorkflowRelease({ ...env, TEST_DIFY_API_BASE_URL: 'https://user:secret@dify.example.test/v1' })).toThrow(OutlineProviderError);
  });
  it('does not issue a provider request when the transactional submission guard fails', async () => {
    let calls = 0;
    const provider = new DifyOutlineProvider(async () => { calls++; throw new Error('Transport must not be called'); });
    await expect(provider.execute(outlineWorkflowSettings(env), randomUUID(), { schemaVersion: 'outline-context-v1',
      contentMode: 'CREATIVE', brief: { topic: 'Тема' }, style: { brandbook: '', tone: '', settings: {} }, claims: [], context: [] },
      new AbortController().signal, async () => { throw new Error('Evidence withdrawn'); }, async () => {})).rejects.toThrow('Evidence withdrawn');
    expect(calls).toBe(0);
  });
});
