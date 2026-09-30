import { randomBytes, randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DependencyHealthService, DurableJobWorker, ImportProviders, PrivateAssetStore, createImportJobHandlers, loadRuntimeConfig } from '@contextflow/backend';
import { AppModule } from '../../apps/api/src/app.module.js';
import { AuthProvider } from '../../apps/api/src/auth/auth-provider.js';
import { loadAuthConfig } from '../../apps/api/src/auth/auth-config.js';
import { SessionService } from '../../apps/api/src/auth/session-service.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../apps/api/src/auth/csrf.js';
import { EXTERNAL_PROCESSING_NOTICE } from '../../apps/api/src/auth/external-processing.js';

type Identity = { id: string; cookie: string };
type Submitted = { material: { id: string; revision: number; currentSnapshotId: string | null; originalAssetId: string | null }; job: { id: string; status: string; errorCategory: string | null } };
const policyDigest = 'a'.repeat(64);
const pdf = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Catalog>> endobj\n%%EOF');
function syntheticDocx(): Buffer {
  const entries = [
    ['[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ['_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'],
    ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Український абзац</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>А</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'],
  ];
  const locals: Buffer[] = [], centrals: Buffer[] = []; let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name!), content = Buffer.from(text!); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
    locals.push(local, filename, content);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); centrals.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const docx = syntheticDocx();
const policy = { schemaVersion: 'contextflow-egress-v1', policyDigest, publicOnly: true, pinDns: true, validateEveryRedirect: true,
  validateSubresources: true, networkIsolation: true, maxRedirects: 5, maxRequests: 100, maxResponseBytes: 10485760 };

describe('durable URL and private digital-document imports', () => {
  const config = loadRuntimeConfig(), authConfig = loadAuthConfig(), health = new DependencyHealthService(config);
  const provider = new AuthProvider(authConfig), sessions = new SessionService(health.prisma, provider, authConfig);
  const migrationPool = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const identities: Identity[] = [];
  let app: NestExpressApplication, baseUrl: string, worker: DurableJobWorker, projectId: string;
  let owner: Identity, foreign: Identity, member: Identity;
  let webText = 'Український абзац джерела.\n\n| Показник | Значення |\n|---|---|\n| Рік | 2026 |';
  let documentText = 'Документ українською.\n\n| А | Б |\n|---|---|\n| 1 | 2 |';
  let failNextWeb = false;
  const transport = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/contextflow/egress-policy')) return new Response(JSON.stringify(policy));
    if (url.endsWith('/v2/scrape')) {
      if (failNextWeb) { failNextWeb = false; throw new Error('Synthetic unknown remote outcome'); }
      const body = JSON.parse(String(init?.body)) as { url: string };
      return new Response(JSON.stringify({ success: true, data: { markdown: webText, metadata: { statusCode: 200, url: body.url, title: 'Synthetic public webpage' },
        remoteFetch: { policyDigest, requests: [{ url: body.url, addresses: ['93.184.216.34'], connectedAddress: '93.184.216.34', responseBytes: 100, redirect: false }] } } }));
    }
    if (url.endsWith('/v1/convert/file')) {
      expect((init?.body as FormData).get('do_ocr')).toBe('false');
      expect((init?.body as FormData).get('force_ocr')).toBe('false');
      const file = (init?.body as FormData).get('files') as File;
      expect(Buffer.from(await file.arrayBuffer())).toEqual(file.name.endsWith('.docx') ? docx : pdf);
      return new Response(JSON.stringify({ status: 'success', document: { md_content: documentText }, processing_time: 0.5 }));
    }
    throw new Error('Unexpected synthetic provider request');
  });

  async function identity(): Promise<Identity> {
    const session = await provider.register(`cf-import-${randomUUID()}@example.test`, randomBytes(24).toString('base64url'), 'Import integration');
    if (!session) throw new Error('Synthetic TEST account was not confirmed');
    const local = await sessions.create(session, 'Import integration');
    const value = { id: session.identity.id, cookie: local.cookie }; identities.push(value); return value;
  }
  async function request<T = unknown>(user: Identity, method: string, path: string, body?: unknown) {
    const headers = new Headers({ Cookie: `${SESSION_COOKIE}=${user.cookie}` });
    if (method !== 'GET') {
      const csrf = await fetch(baseUrl + '/api/auth/session', { headers });
      const protection = await csrf.json() as { csrfToken: string };
      const csrfCookie = csrf.headers.getSetCookie().find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';')[0];
      headers.set('Cookie', `${SESSION_COOKIE}=${user.cookie}; ${csrfCookie}`);
      headers.set('x-csrf-token', protection.csrfToken); headers.set('Origin', authConfig.webOrigin);
    }
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
    const response = await fetch(baseUrl + path, { method, headers, ...(payload ? { body: payload } : {}) });
    return { response, body: await response.json().catch(() => ({})) as T };
  }
  const root = () => `/api/v1/projects/${projectId}`;
  async function run(id: string) {
    const job = await health.prisma.job.findUniqueOrThrow({ where: { id } });
    // Execute the real durable worker with its Postgres lease/fence and Redis queue
    // connection. Separate job fault tests exercise BullMQ dispatch/reconstruction.
    await worker.process({ jobId: id, ordinal: job.attemptCount + 1 });
    return health.prisma.job.findUniqueOrThrow({ where: { id } });
  }
  async function document(user = owner, name = 'original.pdf') {
    const form = new FormData(); form.set('label', 'Digital PDF'); form.set('purpose', 'FACTUAL_SOURCE'); form.set('commandKey', randomUUID());
    form.set('file', new File([pdf], name, { type: 'application/pdf' }));
    return request<Submitted>(user, 'POST', root() + '/materials/document', form);
  }

  beforeAll(async () => {
    vi.stubEnv('TEST_FIRECRAWL_ENDPOINT', 'https://gateway.example.com'); vi.stubEnv('TEST_FIRECRAWL_EGRESS_POLICY_SHA256', policyDigest);
    vi.stubEnv('TEST_DOCLING_ENDPOINT', 'https://docling.example.com'); vi.stubEnv('TEST_DOCLING_VERSION', '1.21.0');
    app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    app.useBodyParser('json', { limit: '1mb' }); await app.init(); await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address(); if (!address || typeof address === 'string') throw new Error('API did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
    owner = await identity(); foreign = await identity(); member = await identity();
    const workspace = await health.prisma.workspace.create({ data: { ownerId: owner.id, name: 'Import TEST workspace',
      members: { create: [{ userId: owner.id }, { userId: member.id }] }, styles: { create: { revision: 1, createdBy: owner.id } } } });
    const project = await health.prisma.project.create({ data: { workspaceId: workspace.id, createdBy: owner.id, topic: 'Import TEST project', formats: ['TELEGRAM_POST'] } }); projectId = project.id;
    await request(owner, 'POST', '/api/auth/external-processing', { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
    await request(member, 'POST', '/api/auth/external-processing', { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
    worker = new DurableJobWorker(health.prisma, config.redisUrl, EXTERNAL_PROCESSING_NOTICE.version,
      createImportJobHandlers({ prisma: health.prisma, assets: app.get(PrivateAssetStore), providers: new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, transport, async () => ['93.184.216.34']) }),
      { queueName: 'cf-import-test-' + randomUUID() });
  });

  afterAll(async () => {
    await worker?.close();
    if (projectId) {
      const assets = await health.prisma.asset.findMany({ where: { projectId }, select: { bucket: true, objectKey: true } });
      const client = await migrationPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM contextflow."SourceFragment" WHERE "projectId" = $1', [projectId]);
        await client.query('UPDATE contextflow."Material" SET "currentSnapshotId" = NULL, "revision" = "revision" + 1 WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."SourceSnapshot" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Material" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Asset" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT id FROM contextflow."Job" WHERE "projectId" = $1)', [projectId]);
        await client.query('DELETE FROM contextflow."Job" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."ProjectMember" WHERE "projectId" = $1', [projectId]);
        await client.query('DELETE FROM contextflow."Project" WHERE id = $1', [projectId]); await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      for (const asset of assets) await app.get(PrivateAssetStore).remove(asset.bucket, asset.objectKey);
    }
    const userIds = identities.map(value => value.id);
    for (const workspace of await health.prisma.workspace.findMany({ where: { ownerId: { in: userIds } }, select: { id: true } })) {
      await health.prisma.workspaceStyleRevision.deleteMany({ where: { workspaceId: workspace.id } });
      await health.prisma.workspaceMember.deleteMany({ where: { workspaceId: workspace.id } }); await health.prisma.workspace.delete({ where: { id: workspace.id } });
    }
    await health.prisma.appSession.deleteMany({ where: { userId: { in: userIds } } }); await health.prisma.userProfile.deleteMany({ where: { id: { in: userIds } } });
    for (const user of identities) {
      const secret = process.env['TEST_SUPABASE_SECRET_KEY'] ?? '';
      const response = await fetch(authConfig.providerUrl + '/auth/v1/admin/users/' + user.id, { method: 'DELETE', headers: { apikey: secret, Authorization: 'Bearer ' + secret } });
      if (!response.ok) throw new Error('Synthetic account cleanup failed');
    }
    await app?.close(); await migrationPool.end(); await health.onModuleDestroy(); vi.unstubAllEnvs();
  });

  it('accepts one snapshot per logical URL job and explicit identical/changed reimports with exact comparison', async () => {
    const input = { label: 'Public URL', purpose: 'FACTUAL_SOURCE', url: 'https://example.com/#fragment', commandKey: randomUUID() };
    const submitted = await request<Submitted>(owner, 'POST', root() + '/materials/url', input);
    expect(submitted.response.status).toBe(201);
    const replay = await request<Submitted>(owner, 'POST', root() + '/materials/url', input);
    expect(replay.body.job.id).toBe(submitted.body.job.id); expect(replay.body.material.id).toBe(submitted.body.material.id);
    expect((await request(owner, 'POST', root() + '/materials/url', { ...input, label: 'Conflicting payload' })).response.status).toBe(409);
    expect((await run(submitted.body.job.id)).status).toBe('SUCCEEDED');
    await worker.process({ jobId: submitted.body.job.id, ordinal: 1 });
    const first = await health.prisma.sourceSnapshot.findFirstOrThrow({ where: { jobId: submitted.body.job.id } });
    expect(first).toMatchObject({ normalizedText: webText, sequence: 1, origin: 'WEB_IMPORT', providerMetadata: expect.objectContaining({ provider: 'firecrawl', policyDigest }) });
    expect(await health.prisma.sourceSnapshot.count({ where: { jobId: submitted.body.job.id } })).toBe(1);
    const materialPath = root() + '/materials/' + submitted.body.material.id;
    const identical = await request<Submitted>(member, 'POST', materialPath + '/reimport', { expectedRevision: 2, commandKey: randomUUID() });
    expect((await run(identical.body.job.id)).status).toBe('SUCCEEDED');
    const same = await health.prisma.sourceSnapshot.findFirstOrThrow({ where: { jobId: identical.body.job.id } });
    expect(same.id).not.toBe(first.id); expect(same.sha256).toBe(first.sha256); expect(same.previousSnapshotId).toBe(first.id);
    webText = 'Нова версія джерела.\n\nНові дані.';
    const changed = await request<Submitted>(owner, 'POST', materialPath + '/reimport', { expectedRevision: 3, commandKey: randomUUID() });
    expect((await run(changed.body.job.id)).status).toBe('SUCCEEDED');
    const latest = await health.prisma.sourceSnapshot.findFirstOrThrow({ where: { jobId: changed.body.job.id } });
    const compared = await request<{ identical: boolean; left: { normalizedText: string }; right: { normalizedText: string } }>(member, 'GET', `${materialPath}/compare?left=${first.id}&right=${latest.id}`);
    expect(compared.body).toMatchObject({ identical: false, left: { normalizedText: first.normalizedText }, right: { normalizedText: webText } });
    expect((await request(foreign, 'GET', materialPath)).response.status).toBe(404);
    expect((await request(foreign, 'GET', root() + '/jobs/' + submitted.body.job.id)).response.status).toBe(404);
    expect(JSON.stringify((await request(owner, 'GET', materialPath)).body)).not.toMatch(/secret|apiKey|objectKey|bucket|firecrawlEndpoint/iu);
    failNextWeb = true;
    const unknown = await request<Submitted>(owner, 'POST', materialPath + '/reimport', { expectedRevision: 4, commandKey: randomUUID() });
    expect(await run(unknown.body.job.id)).toMatchObject({ status: 'OUTCOME_UNKNOWN', errorCategory: 'UNKNOWN_OUTCOME' });
    expect((await health.prisma.material.findUniqueOrThrow({ where: { id: submitted.body.material.id } })).currentSnapshotId).toBe(latest.id);
    expect((await request(owner, 'POST', root() + '/jobs/' + unknown.body.job.id + '/retry')).response.status).toBe(409);
  });

  it('converts validated DOCX bytes and rejects mismatched/oversized digital uploads and unsafe URLs at the API boundary', async () => {
    const form = new FormData(); form.set('label', 'DOCX source'); form.set('purpose', 'FACTUAL_SOURCE'); form.set('commandKey', randomUUID());
    form.set('file', new File([new Uint8Array(docx)], 'джерело.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const submitted = await request<Submitted>(member, 'POST', root() + '/materials/document', form);
    expect(submitted.response.status).toBe(201); expect((await run(submitted.body.job.id)).status).toBe('SUCCEEDED');
    const saved = await health.prisma.sourceSnapshot.findFirstOrThrow({ where: { jobId: submitted.body.job.id } });
    expect(saved).toMatchObject({ normalizedText: documentText, originalFilename: 'джерело.docx', providerMetadata: expect.objectContaining({ options: expect.objectContaining({ from_formats: 'docx', do_ocr: 'false' }) }) });
    for (const [name, bytes, type] of [['fake.docx', pdf, 'application/octet-stream'], ['fake.pdf', Buffer.from('text'), 'application/pdf'],
      ['oversized.pdf', Buffer.alloc(10 * 1024 * 1024 + 1), 'application/pdf']] as const) {
      const invalid = new FormData(); invalid.set('label', 'Invalid'); invalid.set('purpose', 'NOTES'); invalid.set('commandKey', randomUUID());
      invalid.set('file', new File([new Uint8Array(bytes)], name, { type }));
      expect([400, 413]).toContain((await request(owner, 'POST', root() + '/materials/document', invalid)).response.status);
    }
    for (const url of ['http://127.1/', 'https://user:pass@example.com/', 'http://[2001:0db8::1]/']) {
      expect((await request(owner, 'POST', root() + '/materials/url', { label: 'Unsafe', purpose: 'FACTUAL_SOURCE', url, commandKey: randomUUID() })).response.status).toBe(400);
    }
  });

  it('retains private PDF originals, preserves successful versions after no-text extraction and records manual fallback', async () => {
    const initial = await document(); expect(initial.response.status).toBe(201);
    expect((await run(initial.body.job.id)).status).toBe('SUCCEEDED');
    const first = await health.prisma.sourceSnapshot.findFirstOrThrow({ where: { jobId: initial.body.job.id } });
    expect(first).toMatchObject({ normalizedText: documentText, origin: 'DOCUMENT_IMPORT', originalAssetId: initial.body.material.originalAssetId,
      providerMetadata: expect.objectContaining({ provider: 'docling', version: '1.21.0', options: expect.objectContaining({ do_ocr: 'false' }) }) });
    documentText = '';
    const again = await request<Submitted>(owner, 'POST', root() + '/materials/' + initial.body.material.id + '/reimport', { expectedRevision: 2, commandKey: randomUUID() });
    expect(await run(again.body.job.id)).toMatchObject({ status: 'FAILED', errorCategory: 'NO_TEXT' });
    expect((await health.prisma.material.findUniqueOrThrow({ where: { id: initial.body.material.id } })).currentSnapshotId).toBe(first.id);
    const scan = await document(owner, 'scan.pdf'); expect(await run(scan.body.job.id)).toMatchObject({ status: 'FAILED', errorCategory: 'NO_TEXT' });
    const downloadPath = root() + '/assets/' + scan.body.material.originalAssetId + '/download';
    const download = await fetch(baseUrl + downloadPath, { headers: { Cookie: `${SESSION_COOKIE}=${member.cookie}` } });
    expect(download.status).toBe(200); expect(download.headers.get('content-type')).toBe('application/pdf'); expect(Buffer.from(await download.arrayBuffer())).toEqual(pdf);
    expect((await request(foreign, 'GET', downloadPath)).response.status).toBe(404);
    const fallback = await request<{ snapshot: { origin: string; originalAssetId: string } }>(member, 'POST', root() + '/materials/' + scan.body.material.id + '/snapshots', { expectedRevision: 1, text: 'Ручна транскрипція цифрового оригіналу.' });
    expect(fallback.response.status).toBe(201); expect(fallback.body.snapshot).toMatchObject({ origin: 'MANUAL_TEXT', originalAssetId: scan.body.material.originalAssetId });
    documentText = 'Restored digital content';
  });

  it('keeps frozen imports through selection edits while fencing membership loss, cancellation and manual revisions', async () => {
    const selected = await document();
    const selectionPath = root() + '/materials/' + selected.body.material.id;
    expect((await request(owner, 'PATCH', selectionPath, { expectedRevision: 1, included: false, purpose: 'NOTES', label: 'Renamed during conversion' })).response.status).toBe(200);
    expect((await run(selected.body.job.id)).status).toBe('SUCCEEDED');
    expect(await health.prisma.material.findUniqueOrThrow({ where: { id: selected.body.material.id } })).toMatchObject({ included: false, purpose: 'NOTES', label: 'Renamed during conversion', revision: 3 });
    const submitted = await document(member);
    const workspace = await health.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { workspaceId: true } });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace.workspaceId, userId: member.id } }, data: { leftAt: new Date() } });
    expect(await run(submitted.body.job.id)).toMatchObject({ status: 'FAILED', errorCategory: 'ACCESS_REVOKED' });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace.workspaceId, userId: member.id } }, data: { leftAt: null } });
    const cancelled = await document();
    expect((await request(owner, 'POST', root() + '/jobs/' + cancelled.body.job.id + '/cancel')).response.status).toBe(201);
    expect((await run(cancelled.body.job.id)).status).toBe('CANCELLED');
    const edited = await document();
    await request(owner, 'POST', root() + '/materials/' + edited.body.material.id + '/snapshots', { expectedRevision: 1, text: 'Human fallback entered before converter commit' });
    expect(await run(edited.body.job.id)).toMatchObject({ status: 'FAILED', errorCategory: 'SOURCE_CHANGED' });
    expect(await health.prisma.sourceSnapshot.count({ where: { jobId: edited.body.job.id } })).toBe(0);
  });
});
