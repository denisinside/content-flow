import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { DifyTelegramProvider, TelegramProviderError, sha256, telegramWorkflowRelease, telegramWorkflowSettings, type TelegramProviderInput } from './telegram-provider.js';

const directory = new URL('./workflows/adaptation-generation/', import.meta.url);
const release = JSON.parse(readFileSync(new URL('release.json', directory), 'utf8')) as Record<string, unknown>;
const env = { NODE_ENV: 'test', DIFY_API_BASE_URL: 'https://dify.example.test/v1', DIFY_ADAPTATION_WORKFLOW_ID: randomUUID(),
  DIFY_ADAPTATION_API_KEY: 'synthetic-telegram-key', DIFY_ADAPTATION_CONFIG_SHA256: String(release['configDigest']) };
const input: TelegramProviderInput = { schemaVersion: 'channel-context-v1', format: 'TELEGRAM_POST', inputMode: 'DIRECT', contentMode: 'CREATIVE', includeLink: true,
  brief: { topic: 'Тема повідомлення' }, style: { brandbook: '', tone: '', settings: {} }, claims: [], context: [], article: null };
const storyInput: TelegramProviderInput = { ...input, format: 'INSTAGRAM_STORIES', includeLink: false };
const output = { schemaVersion: 'adaptation-v1', format: 'TELEGRAM_POST', content: { text: 'Короткий допис.', mappings: [] } };
const storyOutput = { schemaVersion: 'adaptation-v1', format: 'INSTAGRAM_STORIES', content: { text: 'Короткий підпис.', mappings: [] },
  script: { frames: [{ id: randomUUID(), purpose: 'Показати ключовий факт.', text: 'Ключовий факт.', visualHint: 'Великий заголовок.',
    transition: 'Плавно перейти до наступного кадру.', mappings: [] }] } };
const report = (status = 'ready', contentHash: string | null = '0'.repeat(64)) => JSON.stringify({ schemaVersion: 'adaptation-editorial-report-v1', status, contentHash });
const signal = () => new AbortController().signal;
const sse = (...events: unknown[]) => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''),
  { headers: { 'Content-Type': 'text/event-stream' } });

describe('controlled Telegram workflow boundary', () => {
  it('uses one shared DIFY mapping and rejects missing or mismatched configuration', () => {
    for (const NODE_ENV of ['development', 'test', 'production']) {
      expect(telegramWorkflowSettings({ ...env, NODE_ENV })).toMatchObject({ apiKey: env.DIFY_ADAPTATION_API_KEY,
        workflowId: env.DIFY_ADAPTATION_WORKFLOW_ID, configDigest: env.DIFY_ADAPTATION_CONFIG_SHA256 });
    }
    expect(() => telegramWorkflowSettings({ ...env, DIFY_ADAPTATION_CONFIG_SHA256: '0'.repeat(64) })).toThrow(TelegramProviderError);
    expect(() => telegramWorkflowSettings({ ...env, DIFY_API_BASE_URL: 'https://user:secret@dify.example.test/v1' })).toThrow(TelegramProviderError);
    expect(() => telegramWorkflowSettings({ ...env, DIFY_ADAPTATION_API_KEY: '' })).toThrow(TelegramProviderError);
  });
  it('pins the provider configuration to the reviewed local release files', () => {
    const hash = (name: string) => createHash('sha256').update(readFileSync(new URL(name, directory))).digest('hex');
    expect(hash('prompt.md')).toBe(release['promptSha256']);
    expect(hash('adaptation-generation-v1.yml')).toBe(release['workflowDslSha256']);
    const { configDigest, ...unsigned } = release;
    expect(canonicalManifestHash(unsigned)).toBe(configDigest);
    expect(telegramWorkflowRelease(env)).toMatchObject({ configDigest, contractVersion: 'adaptation-v1', releaseId: release['releaseId'] });
    expect(telegramWorkflowRelease(env)).not.toHaveProperty('apiKey');
    expect(release['adaptationLimits']).toMatchObject({ maxScriptFrames: 30, maxScriptFrameTextUtf16: 3000,
      maxScriptTextUtf16: 30000, maxScriptMappings: 100, maxScriptBytes: 200000 });
  });
  it('sends the frozen context and captures the provider run before returning a candidate', async () => {
    const settings = telegramWorkflowSettings(env), runId = randomUUID(), captured: string[] = [];
    const provider = new DifyTelegramProvider(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { inputs: Record<string, string>; response_mode: string };
      expect(body.response_mode).toBe('streaming'); expect(JSON.parse(body.inputs['editorial_json'] ?? '')).toEqual(input);
      return sse({ event: 'workflow_started', workflow_run_id: runId }, { event: 'workflow_finished', workflow_run_id: runId,
        data: { workflow_id: settings.workflowId, status: 'succeeded', model: 'synthetic', outputs: {
          adaptation_json: JSON.stringify(output), adaptation_report: report('ready', sha256(JSON.stringify(output))) } } });
    });
    const request = provider.execute(settings, randomUUID(), input, signal(), async () => {}, async id => { captured.push(id); });
    const resultPromise = request.catch(error => { throw error; });
    expect(captured).toEqual([]);
    const result = await resultPromise;
    expect(result).toMatchObject({ output, workflowRunId: runId, model: 'synthetic' });
    expect(captured).toEqual([runId]);
  });
  it('does not submit if the frozen-context guard fails', async () => {
    let calls = 0;
    const provider = new DifyTelegramProvider(async () => { calls++; throw new Error('Unexpected transport'); });
    await expect(provider.execute(telegramWorkflowSettings(env), randomUUID(), input, signal(), async () => { throw new Error('Source withdrawn'); }, async () => {}))
      .rejects.toThrow('Source withdrawn');
    expect(calls).toBe(0);
  });
  it('rejects inconsistent route context and missing factual evidence before transport', async () => {
    let calls = 0;
    const provider = new DifyTelegramProvider(async () => { calls++; throw new Error('Unexpected transport'); });
    const derived = { ...input, inputMode: 'ARTICLE_DERIVED' as const, article: null };
    const factual = { ...input, contentMode: 'FACTUAL' as const };
    for (const value of [derived, factual]) await expect(provider.execute(telegramWorkflowSettings(env), randomUUID(), value, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', outcome: 'NOT_SUBMITTED' });
    expect(calls).toBe(0);
  });
  it('reports unknown POST outcomes without blindly resubmitting', async () => {
    let calls = 0;
    const provider = new DifyTelegramProvider(async () => { calls++; throw new TypeError('Synthetic connection reset'); });
    await expect(provider.execute(telegramWorkflowSettings(env), randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', outcome: 'UNKNOWN' });
    expect(calls).toBe(1);
  });
  it.each(['needs_human', 'insufficient_evidence'])('blocks a %s report and accepts a null hash for blocked output', async status => {
    const settings = telegramWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyTelegramProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: { adaptation_json: '', adaptation_report: report(status, null) } } }));
    await expect(provider.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'PROVIDER_FAILED', outcome: 'KNOWN_FAILED' });
  });
  it('rejects a ready report whose content hash is stale or whose output fails adaptation-v1', async () => {
    const settings = telegramWorkflowSettings(env), runId = randomUUID();
    const provider = new DifyTelegramProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: { adaptation_json: JSON.stringify(output), adaptation_report: report() } } }));
    await expect(provider.execute(settings, randomUUID(), input, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });
  it('accepts a reviewed story script, marks a missing script for regeneration and rejects a mismatched format', async () => {
    const settings = telegramWorkflowSettings(env), runId = randomUUID();
    const respond = (candidate: unknown) => new DifyTelegramProvider(async () => sse({ event: 'workflow_finished', workflow_run_id: runId,
      data: { workflow_id: settings.workflowId, status: 'succeeded', outputs: {
        adaptation_json: JSON.stringify(candidate), adaptation_report: report('ready', sha256(JSON.stringify(candidate))) } } }));
    const accepted = await respond(storyOutput).execute(settings, randomUUID(), storyInput, signal(), async () => {}, async () => {});
    expect(accepted.output).toEqual(storyOutput);
    const missingScript = { ...storyOutput, script: undefined };
    await expect(respond(missingScript).execute(settings, randomUUID(), storyInput, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INVALID_DRAFT', outcome: 'KNOWN_SUCCEEDED' });
    const misplacedScript = { ...storyOutput, format: 'LINKEDIN_TEXT' };
    await expect(respond(misplacedScript).execute(settings, randomUUID(), storyInput, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
    await expect(respond(storyOutput).execute(settings, randomUUID(), { ...input, format: 'LINKEDIN_TEXT', includeLink: false }, signal(), async () => {}, async () => {}))
      .rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });
  it('reconciles only the captured workflow run with its frozen workflow identity', async () => {
    const settings = telegramWorkflowSettings(env), runId = randomUUID();
    const outputs = { adaptation_json: JSON.stringify(output), adaptation_report: report('ready', sha256(JSON.stringify(output))) };
    const provider = new DifyTelegramProvider(async url => {
      expect(url).toBe(`${settings.endpoint}/workflows/run/${runId}`);
      return Response.json({ id: runId, workflow_id: settings.workflowId, status: 'succeeded', outputs });
    });
    expect(await provider.resume(settings, runId, signal())).toEqual({ output, workflowRunId: runId, model: null });
    const wrongRun = new DifyTelegramProvider(async () => Response.json({ id: randomUUID(), workflow_id: settings.workflowId, status: 'succeeded', outputs }));
    await expect(wrongRun.resume(settings, runId, signal())).rejects.toMatchObject({ code: 'INCOMPATIBLE_CONTRACT' });
  });
});
