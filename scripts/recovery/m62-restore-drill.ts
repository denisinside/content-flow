import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pg from 'pg';
import { ArticleService, EditorialService, DependencyHealthService, DurableJobService, EXTERNAL_PROCESSING_NOTICE, FactualBasisService, PrivateAssetStore,
  ScriptService, TelegramService, VisualRenderer, VisualService, ExportService, createExportJobHandler, loadRuntimeConfig, privateStorageConfig } from '@contextflow/backend';
import { SourceService } from '../../apps/api/dist/sources/source.service.js';
import { compositionSchema } from '../../packages/visuals/src/index.js';

const { Client } = pg;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
// Restored copies never submit provider work. Renderer browser contexts independently abort network routes.
globalThis.fetch = async () => { throw new Error('External provider calls disabled during restore drill'); };
const container = 'contextflow-dev-postgres-test-1';
const reportPath = resolve(root, '.local-checks/m62/restore-drill.json');
let currentStage = 'configuration';
const stage = (name: string) => { currentStage = name; process.stdout.write(`[m62-restore] ${name}\n`); };
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const envFile = await readFile(resolve(root, '.env'), 'utf8');
function env(name: string): string {
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#=\s]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] !== name) continue;
    const value = m[2] ?? '';
    return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value.replace(/\s+#.*$/, '').trim();
  }
  throw new Error(`missing-${name.toLowerCase()}`);
}
function testUrl(name: string, role: string) {
  const url = new URL(env(name));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || url.port !== '54330'
    || url.pathname !== '/contextflow_test' || decodeURIComponent(url.username) !== role || url.searchParams.get('schema') !== 'contextflow') throw new Error('unsafe-test-database-target');
  return url;
}
const baseMigration = testUrl('TEST_DIRECT_DATABASE_URL', 'cf_migrate');
const baseRuntime = testUrl('TEST_DATABASE_URL', 'cf_runtime');
const adminPassword = env('TEST_POSTGRES_ADMIN_PASSWORD');
const migrationPassword = env('TEST_POSTGRES_MIGRATION_PASSWORD');
const names = `cf_m62_${randomUUID().replaceAll('-', '')}`;
const sourceDb = `${names}_source`;
const targetDb = `${names}_restore`;
const sourceMigrationUrl = new URL(baseMigration); sourceMigrationUrl.pathname = `/${sourceDb}`;
const sourceRuntimeUrl = new URL(baseRuntime); sourceRuntimeUrl.pathname = `/${sourceDb}`;
const targetMigrationUrl = new URL(baseMigration); targetMigrationUrl.pathname = `/${targetDb}`;
const targetRuntimeUrl = new URL(baseRuntime); targetRuntimeUrl.pathname = `/${targetDb}`;
const admin = new Client({ host: '127.0.0.1', port: 54330, database: 'postgres', user: 'postgres', password: adminPassword, ssl: false, connectionTimeoutMillis: 5000, application_name: 'contextflow-m62-restore-drill' });
const createdDbs: string[] = [];
const testObjectIds: Array<{ projectId: string; key: string }> = [];
const containerDump = `/tmp/${names}.dump`;
const hostDump = resolve(root, '.local-checks/m62', `${names}.dump`);
const sourceRoot = resolve(root, '.local-checks/m62/source-private');
const restoreRoot = resolve(root, '.local-checks/m62/restored-private');
const storage = new PrivateAssetStore({ ...privateStorageConfig({ NODE_ENV: 'test' }), directory: sourceRoot });
const restoredStorage = new PrivateAssetStore({ ...privateStorageConfig({ NODE_ENV: 'test' }), directory: restoreRoot });
const migrationCli = resolve(dirname(require.resolve('prisma/package.json')), 'build/index.js');
const record: Record<string, unknown> = { drill: 'M6.2 synthetic populated database and private object restore', startedAt: new Date().toISOString(), target: 'isolated local TEST PostgreSQL container', providersBlocked: true };

function run(command: string, args: string[], options: { input?: Buffer; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}) {
  const result = spawnSync(command, args, { cwd: root, env: options.env ?? process.env, input: options.input, encoding: options.input ? undefined : 'utf8', maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`command-failed:${command}:${result.status ?? 'spawn'}${result.signal ? `:${result.signal}` : ''}`);
  return result.stdout as Buffer | string;
}
async function createDb(name: string) {
  if (!/^cf_m62_[a-f0-9]{32}_(source|restore)$/.test(name)) throw new Error('unsafe-generated-database-name');
  await admin.query(`CREATE DATABASE "${name}"`);
  createdDbs.push(name);
  await admin.query(`GRANT CONNECT, CREATE ON DATABASE "${name}" TO cf_migrate`);
  await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO cf_runtime`);
}
function migrate(url: URL) {
  const result = spawnSync(process.execPath, [migrationCli, 'migrate', 'deploy', '--config', 'prisma7.config.ts'], { cwd: root,
    env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_URL: targetLike(url, 'cf_runtime'), TEST_DIRECT_DATABASE_URL: targetLike(url, 'cf_migrate') },
    encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('prisma-migrate-deploy-failed');
}
function targetLike(url: URL, role: string) { const copy = new URL(url); copy.username = role; copy.password = role === 'cf_runtime' ? baseRuntime.password : baseMigration.password; return copy.toString(); }
function client(url: URL, app: string) { return new Client({ connectionString: url.toString(), ssl: false, connectionTimeoutMillis: 5000, application_name: app }); }
async function fingerprints(url: URL) {
  const c = client(url, 'contextflow-m62-fingerprint'); await c.connect();
  try {
    const tables = await c.query(`SELECT tablename FROM pg_tables WHERE schemaname='contextflow' AND tablename <> '_prisma_migrations' ORDER BY tablename`);
    const out: Record<string, { rows: number; sha256: string }> = {};
    for (const { tablename } of tables.rows as Array<{ tablename: string }>) {
      if (!/^\w+$/.test(tablename)) throw new Error('unexpected-table-name');
      const q = await c.query(`SELECT count(*)::int AS rows, encode(sha256(convert_to(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY row_to_json(t)::text), ''), 'UTF8')), 'hex') AS digest FROM contextflow."${tablename}" t`);
      out[tablename] = { rows: q.rows[0].rows, sha256: q.rows[0].digest };
    }
    return out;
  } finally { await c.end(); }
}

try {
  stage('validate-isolated-local-test-container');
  await admin.connect();
  const containerCheck = run('docker', ['inspect', '--format', '{{.Config.Image}}', container]) as string;
  if (!containerCheck.includes('postgres:17.11-alpine')) throw new Error('unexpected-postgres-test-container');
  const roleCheck = await admin.query(`SELECT current_user='postgres' AS admin, (SELECT rolcanlogin AND NOT rolsuper FROM pg_roles WHERE rolname='cf_migrate') AS migration_role_limited`);
  if (!roleCheck.rows[0]?.admin || !roleCheck.rows[0]?.migration_role_limited) throw new Error('unexpected-local-test-service');

  stage('create-random-disposable-databases-and-apply-all-migrations');
  await createDb(sourceDb); await createDb(targetDb);
  migrate(sourceMigrationUrl);

  stage('populate-synthetic-reviewed-editorial-evidence-and-private-files');
  const owner = randomUUID(), outsider = randomUUID(), workspace = randomUUID(), project = randomUUID(), material = randomUUID(), snapshot = randomUUID(), fragment = randomUUID();
  const claim = randomUUID(), revision = randomUUID(), evidence = randomUUID(), basis = randomUUID();
  const claimText = 'Міський сервіс запрацює 15 травня.';
  const fileRows: Array<{ id: string; purpose: string; mediaType: string; fileName: string; bytes: Buffer; kind: 'original' | 'export' | 'visual' }> = [
    { id: randomUUID(), purpose: 'ORIGINAL', mediaType: 'text/plain', fileName: 'synthetic-source.txt', bytes: Buffer.from(`${claimText}\n`, 'utf8'), kind: 'original' },
  ];
  const objectManifest: Array<Record<string, unknown>> = [];
  for (const item of fileRows) {
    const stored = item.kind === 'export' ? await storage.putExport(project, item.id, item.bytes)
      : await storage.put(project, item.id, item.bytes);
    testObjectIds.push({ projectId: project, key: stored.objectKey });
    objectManifest.push({ id: item.id, purpose: item.purpose, category: item.fileName.replace(/^synthetic-/, '').replace(/\.(txt|png|jpg|zip)$/, ''), bucket: stored.bucket, objectKey: stored.objectKey, bytes: item.bytes.byteLength, sha256: hash(item.bytes) });
  }
  const c = client(sourceMigrationUrl, 'contextflow-m62-seed'); await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO contextflow."UserProfile" (id,"displayName","externalProcessingNoticeVersion","externalProcessingAcceptedAt") VALUES ($1,'Synthetic M6.2 owner',$2,now()),($3,'Synthetic outsider',$2,now())`, [owner, EXTERNAL_PROCESSING_NOTICE.version, outsider]);
    await c.query(`INSERT INTO contextflow."Workspace" (id,name,"ownerId") VALUES ($1,'M6.2 synthetic restore',$2)`, [workspace, owner]);
    await c.query(`INSERT INTO contextflow."WorkspaceMember" ("workspaceId","userId") VALUES ($1,$2)`, [workspace, owner]);
    await c.query(`INSERT INTO contextflow."WorkspaceStyleRevision" ("workspaceId",revision,"createdBy") VALUES ($1,1,$2)`, [workspace, owner]);
    await c.query(`INSERT INTO contextflow."Project" (id,"workspaceId",topic,formats,"createdBy") VALUES ($1,$2,'Synthetic restored project',ARRAY['ARTICLE','LINKEDIN_COVER','LINKEDIN_CAROUSEL']::contextflow."ProjectFormat"[],$3)`, [project, workspace, owner]);
    for (const item of fileRows) {
      const key = `${project}/originals/${item.id}`;
      await c.query(`INSERT INTO contextflow."Asset" (id,"projectId",bucket,"objectKey","mediaType",bytes,"sha256",state,purpose,"createdBy") VALUES ($1,$2,'local-originals',$3,$4,$5,$6,'AVAILABLE',$7,$8)`,
        [item.id, project, key, item.mediaType, item.bytes.byteLength, hash(item.bytes), item.purpose, owner]);
    }
    const sourceAsset = fileRows[0]!;
    await c.query(`INSERT INTO contextflow."Material" (id,"projectId",kind,purpose,label,"originalAssetId","originalFilename","createdBy") VALUES ($1,$2,'FILE','FACTUAL_SOURCE','Synthetic source',$3,$4,$5)`, [material, project, sourceAsset.id, sourceAsset.fileName, owner]);
    await c.query(`INSERT INTO contextflow."SourceSnapshot" (id,"projectId","materialId",sequence,"normalizedText",sha256,bytes,origin,"originalAssetId","originalFilename","createdBy") VALUES ($1,$2,$3,1,$4,$5,$6,'LOCAL_FILE',$7,$8,$9)`,
      [snapshot, project, material, claimText, hash(claimText), Buffer.byteLength(claimText), sourceAsset.id, sourceAsset.fileName, owner]);
    await c.query(`UPDATE contextflow."Material" SET "currentSnapshotId"=$1, revision=revision+1 WHERE id=$2`, [snapshot, material]);
    await c.query(`INSERT INTO contextflow."SourceFragment" (id,"projectId","snapshotId",ordinal,"startOffset","endOffset",sha256) VALUES ($1,$2,$3,1,0,$4,$5)`, [fragment, project, snapshot, claimText.length, hash(claimText)]);
    await c.query(`INSERT INTO contextflow."Claim" (id,"projectId","createdBy") VALUES ($1,$2,$3)`, [claim, project, owner]);
    await c.query(`INSERT INTO contextflow."ClaimRevision" (id,"projectId","claimId",number,wording,sha256,status,"createdBy","approvedBy","approvedAt") VALUES ($1,$2,$3,1,$4,$5,'APPROVED',$6,$6,now())`, [revision, project, claim, claimText, hash(claimText), owner]);
    await c.query(`UPDATE contextflow."Claim" SET "currentRevisionId"=$1 WHERE id=$2`, [revision, claim]);
    await c.query(`INSERT INTO contextflow."ClaimEvidence" (id,"projectId","claimRevisionId","snapshotId","fragmentId","startOffset","endOffset",quote,sha256,relation,"createdBy") VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,'SUPPORTS',$9)`, [evidence, project, revision, snapshot, fragment, claimText.length, claimText, hash(claimText), owner]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK').catch(() => {}); throw error; }
  finally { await c.end(); }

  const sourceConfig = loadRuntimeConfig();
  const sourceHealth = new DependencyHealthService({ ...sourceConfig, nodeEnv: 'test', databaseSslCaFile: undefined, databaseUrl: sourceRuntimeUrl.toString(), directDatabaseUrl: sourceMigrationUrl.toString() });
  const sourceJobs = new DurableJobService(sourceHealth.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version, retryBaseMs: 0 });
  const sourceFacts = new FactualBasisService(sourceHealth.prisma, sourceJobs);
  await sourceFacts.freezeBasis(owner, project, { claimRevisionIds: [revision] });
  const editorial = new EditorialService(sourceHealth.prisma, sourceJobs, sourceFacts);
  await editorial.saveBrief(owner, project, { expectedRevision: 0, contentMode: 'CREATIVE', topic: 'Місто', audience: 'Редактор',
    centralMessage: 'Синтетична перевірка відновлення', category: 'Контрольний набір', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [] });
  const sourceArticles = new ArticleService(sourceHealth.prisma, sourceJobs, sourceFacts);
  const sourceChannels = new TelegramService(sourceHealth.prisma, sourceJobs, sourceFacts, sourceArticles);
  const sourceScripts = new ScriptService(sourceHealth.prisma, sourceChannels);
  const sourceRenderer = new VisualRenderer();
  const sourceVisuals = new VisualService(sourceHealth.prisma, sourceChannels, sourceScripts, sourceRenderer, storage);
  const sourceExports = new ExportService(sourceHealth.prisma, sourceJobs, sourceArticles, sourceChannels, storage, sourceVisuals);
  const exportHandler = createExportJobHandler(sourceExports);
  const raster = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=';
  const logo = await sourceVisuals.createAsset(owner, project, 'WORKSPACE', { filename: 'logo.png', mediaType: 'image/png', base64: raster });
  const photo = await sourceVisuals.createAsset(owner, project, 'PROJECT', { filename: 'photo.png', mediaType: 'image/png', base64: raster });
  const background = await sourceVisuals.createAsset(owner, project, 'PROJECT', { filename: 'synthetic-background.png', mediaType: 'image/png', base64: raster });

  let cover = await sourceChannels.saveDraft(owner, project, { format: 'LINKEDIN_COVER', expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'CREATIVE',
    content: { text: 'Синтетичний заголовок міста.', mappings: [], cover: { text: 'Сервіс із 15 травня', instruction: 'Лаконічний тестовий макет' } } });
  cover = await sourceChannels.checkpoint(owner, project, { format: 'LINKEDIN_COVER', expectedRevision: cover.adaptation!.revision });
  const coverRevision = cover.adaptation!.revisions[0]!;
  await sourceChannels.review(owner, project, coverRevision.id, 'approve', { format: 'LINKEDIN_COVER', expectedRevision: cover.adaptation!.revision,
    expectedReviewCounter: coverRevision.reviewCounter, acknowledgeUnmapped: true });

  await editorial.saveBrief(owner, project, { expectedRevision: 1, contentMode: 'FACTUAL', topic: 'Місто', audience: 'Редактор',
    centralMessage: claimText, category: 'Контрольний набір', targetLength: 100, cta: '', exclusions: [], notes: '', requiredClaimRevisionIds: [revision] });
  let carousel = await sourceChannels.saveDraft(owner, project, { format: 'LINKEDIN_CAROUSEL', expectedRevision: 0, inputMode: 'DIRECT', contentMode: 'FACTUAL',
    content: { text: claimText, mappings: [{ startOffset: 0, endOffset: claimText.length, quote: claimText, claimRevisionId: revision, evidenceId: evidence }] } });
  carousel = await sourceChannels.checkpoint(owner, project, { format: 'LINKEDIN_CAROUSEL', expectedRevision: carousel.adaptation!.revision });
  const carouselRevision = carousel.adaptation!.revisions[0]!;
  await sourceChannels.review(owner, project, carouselRevision.id, 'approve', { format: 'LINKEDIN_CAROUSEL', expectedRevision: carousel.adaptation!.revision,
    expectedReviewCounter: carouselRevision.reviewCounter, acknowledgeUnmapped: true });

  let script = await sourceScripts.get(owner, project, 'LINKEDIN_CAROUSEL');
  script = await sourceScripts.saveDraft(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: 0, expectedDraftCounter: 0, parentAdaptationRevisionId: script.parent!.id,
    content: { frames: ['Термін', 'Доказ'].map((purpose, index) => ({ id: randomUUID(), purpose, text: index === 0 ? 'Запуск із 15 травня.' : claimText,
      visualHint: 'Стримана редакційна графіка', transition: index === 0 ? 'Далі' : 'Кінець',
      mappings: index === 1 ? [{ startOffset: 0, endOffset: claimText.length, quote: claimText, claimRevisionId: revision, evidenceId: evidence }] : [] })) } });
  script = await sourceScripts.checkpoint(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: script.script!.revision, expectedDraftCounter: script.script!.draft!.counter });
  const scriptRevision = script.script!.revisions[0]!;
  await sourceScripts.review(owner, project, 'LINKEDIN_CAROUSEL', scriptRevision.id, 'approve', { expectedRevision: script.script!.revision,
    expectedReviewCounter: scriptRevision.reviewCounter, acknowledgeUnmapped: true });

  const visualParent = await sourceVisuals.get(owner, project, 'LINKEDIN_CAROUSEL');
  let visual = await sourceVisuals.initialize(owner, project, 'LINKEDIN_CAROUSEL', { parentRevisionId: visualParent.parent!.id });
  const editable = compositionSchema.parse(visual.composition!.draft!.content);
  editable.frames[0]!.layers.unshift({ id: randomUUID(), type: 'image', x: 0, y: 0, width: editable.width, height: editable.height,
    resource: { type: 'project', id: background.id, sha256: background.ref.sha256 }, role: 'background', fit: 'cover' });
  editable.frames[0]!.layers.push({ id: randomUUID(), type: 'image', x: 84, y: 900, width: 120, height: 80,
    resource: { type: 'project', id: photo.id, sha256: photo.ref.sha256 }, fit: 'contain' });
  editable.frames[0]!.layers.push({ id: randomUUID(), type: 'image', x: 900, y: 900, width: 80, height: 80,
    resource: { type: 'workspace', id: logo.id, sha256: logo.ref.sha256 }, fit: 'contain' });
  visual = await sourceVisuals.saveDraft(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: visual.composition!.revision,
    expectedDraftCounter: visual.composition!.draft!.counter, composition: editable });
  visual = await sourceVisuals.checkpoint(owner, project, 'LINKEDIN_CAROUSEL', { expectedRevision: visual.composition!.revision, expectedDraftCounter: visual.composition!.draft!.counter });
  const visualRevision = visual.composition!.revisions[0]!;
  const composition = visualRevision.content as { frames: Array<{ id: string }> };
  for (const frame of composition.frames) await sourceVisuals.preview(owner, project, 'LINKEDIN_CAROUSEL', visualRevision.id, frame.id);
  visual = await sourceVisuals.get(owner, project, 'LINKEDIN_CAROUSEL');
  await sourceVisuals.review(owner, project, 'LINKEDIN_CAROUSEL', visualRevision.id, 'approve', { expectedRevision: visual.composition!.revision,
    expectedReviewCounter: visualRevision.reviewCounter, acknowledgeUnmapped: true });

  const ready = await sourceExports.readiness(owner, project);
  const scriptRow = await sourceHealth.prisma.scriptRevision.findFirstOrThrow({ where: { projectId: project, id: scriptRevision.id } });
  const request = await sourceExports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'ZIP', items: [
    { format: 'LINKEDIN_CAROUSEL_SCRIPT', revisionId: scriptRevision.id, reviewCounter: scriptRow.reviewCounter },
    { format: 'LINKEDIN_CAROUSEL_VISUAL', revisionId: visualRevision.id, reviewCounter: visualRevision.reviewCounter + 1 },
  ] });
  const claimed = await sourceJobs.claim(request.jobId, 1, `m62-${randomUUID()}`);
  if (!claimed) throw new Error('synthetic-export-job-not-claimable');
  const jobContext = { job: claimed.job, attempt: claimed.attempt, signal: new AbortController().signal,
    recordSubmissionIntent: async () => {}, recordProviderRun: async () => {}, setProgress: async () => {} };
  const exportStage = await exportHandler.execute(jobContext);
  await sourceJobs.succeed(claimed.job, claimed.attempt, exportHandler, exportStage);
  await exportHandler.completed?.(jobContext, exportStage);
  const exported = await sourceExports.download(owner, project, request.exportId);
  const pdfRequest = await sourceExports.freeze(owner, project, { expectedProjectRevision: ready.projectRevision, commandKey: randomUUID(), format: 'PDF', items: [
    { format: 'LINKEDIN_CAROUSEL_VISUAL', revisionId: visualRevision.id, reviewCounter: visualRevision.reviewCounter + 1 },
  ] });
  const pdfClaim = await sourceJobs.claim(pdfRequest.jobId, 1, `m62-pdf-${randomUUID()}`);
  if (!pdfClaim) throw new Error('pdf-job-not-claimable');
  const pdfContext = { ...jobContext, job: pdfClaim.job, attempt: pdfClaim.attempt };
  const pdfStage = await exportHandler.execute(pdfContext);
  await sourceJobs.succeed(pdfClaim.job, pdfClaim.attempt, exportHandler, pdfStage);
  await exportHandler.completed?.(pdfContext, pdfStage);
  const exportedPdf = await sourceExports.download(owner, project, pdfRequest.exportId);
  const backendRequire = createRequire(resolve(root, 'packages/backend/package.json'));
  const PDFDocument = (backendRequire('pdf-lib') as { PDFDocument: { load(bytes: Uint8Array): Promise<{ getPageCount(): number }> } }).PDFDocument;
  if ((await PDFDocument.load(exportedPdf.bytes)).getPageCount() !== 2) throw new Error('carousel-pdf-page-order-count');
  if (!exported.bytes.subarray(0, 2).equals(Buffer.from('PK'))) throw new Error('approved-export-invalid-zip');
  const sourcePreviews = await sourceHealth.prisma.visualPreview.findMany({ where: { projectId: project }, include: { asset: true } });
  const sourceExportAssets = await sourceHealth.prisma.exportArtifact.findMany({ where: { projectId: project }, include: { asset: true } });
  const imageAssets = await sourceHealth.prisma.asset.findMany({ where: { id: { in: [photo.id, background.id] } } });
  const workspaceLogo = await sourceHealth.prisma.workspaceVisualAsset.findUniqueOrThrow({ where: { id: logo.id } });
  for (const row of [...sourcePreviews.map(x => x.asset), ...sourceExportAssets.map(x => x.asset), ...imageAssets, workspaceLogo]) {
    const bytes = await storage.read(row.bucket, row.objectKey, row.sha256);
    objectManifest.push({ id: row.id, purpose: 'purpose' in row ? row.purpose : 'WORKSPACE_VISUAL', category: row.id === logo.id ? 'workspace-logo' : row.id === photo.id ? 'project-photo'
      : row.id === background.id ? 'synthetic-background' : 'purpose' in row && row.purpose === 'EXPORT' ? 'approved-export' : 'preview', bucket: row.bucket,
      objectKey: row.objectKey, bytes: bytes.length, sha256: hash(bytes), mediaType: row.mediaType });
    testObjectIds.push({ projectId: project, key: row.objectKey });
  }
  await sourceRenderer.onModuleDestroy();
  await sourceHealth.onModuleDestroy();
  record.editorialArtifacts = { approvedCaptionRevision: coverRevision.id, approvedFactualAdaptationRevision: carouselRevision.id,
    approvedScriptRevision: scriptRevision.id, approvedVisualRevision: visualRevision.id, previewCount: sourcePreviews.length,
    exportId: request.exportId, approvedZipBytes: exported.bytes.length, approvedZipSha256: hash(exported.bytes) };
  record.objectInventory = objectManifest;
  record.syntheticIds = { owner, outsider, workspace, project, snapshot, claimRevision: revision, evidence, basis };
  record.providerSubmissions = 'fetch denied; no provider adapters or workers started';

  stage('create-custom-postgresql-backup-and-restore-into-isolated-target');
  run('docker', ['exec', '-e', `PGPASSWORD=${migrationPassword}`, container, 'pg_dump', '-U', 'cf_migrate', '-d', sourceDb, '--format=custom', '--no-owner', '--compress=6', '-f', containerDump]);
  await mkdir(dirname(hostDump), { recursive: true });
  run('docker', ['cp', `${container}:${containerDump}`, hostDump]);
  const dump = await readFile(hostDump);
  if (dump.length < 1000) throw new Error('custom-dump-empty');
  run('docker', ['exec', '-e', `PGPASSWORD=${migrationPassword}`, container, 'pg_restore', '-U', 'cf_migrate', '-d', targetDb, '--no-owner', '--exit-on-error', containerDump]);
  stage('copy-and-verify-private-object-backup-into-independent-root');
  for (const object of objectManifest) {
    const key = String(object.objectKey), digest = String(object.sha256);
    const bytes = await storage.read(String(object.bucket), key, digest);
    if (bytes.length !== object.bytes) throw new Error('object-inventory-size-mismatch');
    const target = resolve(restoreRoot, key);
    if (!target.startsWith(restoreRoot + '/'.replace('/', process.platform === 'win32' ? '\\' : '/'))) throw new Error('unsafe-restore-object-path');
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    if (hash(await restoredStorage.read(String(object.bucket), key, digest)) !== digest) throw new Error('restored-object-hash-mismatch');
    await storage.remove(String(object.bucket), key);
  }
  record.objectsPhysicallyRestored = objectManifest.length;
  record.databaseBackup = { format: 'PostgreSQL custom archive', bytes: dump.length, sha256: hash(dump), sourceDatabase: sourceDb, targetDatabase: targetDb };

  stage('verify-restored-schema-rows-fks-links-and-table-fingerprints');
  const sourceFingerprint = await fingerprints(sourceMigrationUrl), targetFingerprint = await fingerprints(targetMigrationUrl);
  if (JSON.stringify(sourceFingerprint) !== JSON.stringify(targetFingerprint)) throw new Error('restored-table-fingerprints-differ');
  const check = client(targetMigrationUrl, 'contextflow-m62-integrity'); await check.connect();
  try {
    const integrity = await check.query(`SELECT
      (SELECT count(*)=1 FROM contextflow."ClaimEvidence" e JOIN contextflow."SourceSnapshot" s ON s.id=e."snapshotId" AND s."projectId"=e."projectId" JOIN contextflow."SourceFragment" f ON f.id=e."fragmentId" AND f."snapshotId"=e."snapshotId") AS evidence_source_links,
      (SELECT count(*)=1 FROM contextflow."ClaimRevision" r JOIN contextflow."ClaimEvidence" e ON e."claimRevisionId"=r.id WHERE r.status='APPROVED' AND r."approvedBy" IS NOT NULL AND r."approvedAt" IS NOT NULL) AS approval_preserved,
      (SELECT count(*)=1 FROM contextflow."BasisClaim" b JOIN contextflow."BasisClaimEvidence" be ON be."basisId"=b."basisId" AND be."claimRevisionId"=b."claimRevisionId") AS basis_parent_links,
      (SELECT count(*)=$2 FROM contextflow."Asset" a JOIN contextflow."Project" p ON p.id=a."projectId" JOIN contextflow."Workspace" w ON w.id=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w.id WHERE m."userId"=$1) AS project_workspace_membership` , [owner, objectManifest.length - 1]);
    if (Object.values(integrity.rows[0]).some(value => value !== true)) throw new Error('restored-relational-integrity-failed');
    record.relationalChecks = integrity.rows[0]; record.tableFingerprints = targetFingerprint;
  } finally { await check.end(); }

  stage('verify-runtime-authorized-source-download-and-outsider-denial');
  const original = fileRows[0]!;
  const restoredConfig = loadRuntimeConfig();
  const health = new DependencyHealthService({ ...restoredConfig, nodeEnv: 'test', databaseSslCaFile: undefined, databaseUrl: targetRuntimeUrl.toString(), directDatabaseUrl: targetMigrationUrl.toString() });
  try {
    const sourceService = new SourceService(health as never, restoredStorage, {} as never, {} as never, {} as never);
    const allowed = await sourceService.download(owner, project, original.id);
    if (hash(allowed.bytes) !== hash(original.bytes) || allowed.filename !== original.fileName) throw new Error('authorized-download-mismatch');
    let outsiderDenied = false;
    try { await sourceService.download(outsider, project, original.id); } catch (error) { outsiderDenied = (error as { status?: number }).status === 404; }
    if (!outsiderDenied) throw new Error('outsider-download-not-denied');
    record.downloadAuthorization = { member: 'allowed; exact bytes and filename recovered', outsider: 'denied with 404' };
    const restoredJobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
    const restoredFacts = new FactualBasisService(health.prisma, restoredJobs);
    const restoredArticles = new ArticleService(health.prisma, restoredJobs, restoredFacts);
    const restoredChannels = new TelegramService(health.prisma, restoredJobs, restoredFacts, restoredArticles);
    const restoredScripts = new ScriptService(health.prisma, restoredChannels);
    const restoredRenderer = new VisualRenderer();
    try {
      const restoredVisuals = new VisualService(health.prisma, restoredChannels, restoredScripts, restoredRenderer, restoredStorage);
      const restoredExports = new ExportService(health.prisma, restoredJobs, restoredArticles, restoredChannels, restoredStorage, restoredVisuals);
      const zip = await restoredExports.download(owner, project, request.exportId);
      const pdf = await restoredExports.download(owner, project, pdfRequest.exportId);
      if (hash(pdf.bytes) !== hash(exportedPdf.bytes) || (await PDFDocument.load(pdf.bytes)).getPageCount() !== 2) throw new Error('restored-approved-pdf-mismatch');
      await writeFile(resolve(root, '.local-checks/m62/recovered.zip'), zip.bytes, { mode: 0o600 });
      await writeFile(resolve(root, '.local-checks/m62/recovered.pdf'), pdf.bytes, { mode: 0o600 });
      const firstPreview = sourcePreviews[0]!;
      const previewBytes = await restoredVisuals.readPreview(owner, project, firstPreview.assetId);
      if (hash(previewBytes) !== firstPreview.asset.sha256) throw new Error('restored-preview-hash-mismatch');
      await writeFile(resolve(root, '.local-checks/m62/recovered.png'), previewBytes, { mode: 0o600 });
      if (hash(zip.bytes) !== hash(exported.bytes)) throw new Error('restored-approved-export-mismatch');
      let denied = false;
      try { await restoredExports.download(outsider, project, request.exportId); } catch (error) { denied = (error as { status?: number }).status === 404; }
      if (!denied) throw new Error('restored-export-outsider-allowed');
      for (const [scope, id] of [['WORKSPACE', logo.id], ['PROJECT', photo.id], ['PROJECT', background.id]] as const) {
        const image = await restoredVisuals.readAsset(owner, project, scope, id);
        if (!image.bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('restored-resource-not-png');
        let imageDenied = false;
        try { await restoredVisuals.readAsset(outsider, project, scope, id); } catch (error) { imageDenied = (error as {status?: number}).status === 404; }
        if (!imageDenied) throw new Error('restored-resource-outsider-allowed');
      }
      record.restoredExport = { exactApprovedZip: true, exactApprovedPdf: true, pdfPages: 2, outsiderDenied: true, bytes: zip.bytes.length };
    } finally { await restoredRenderer.onModuleDestroy(); }
  } finally { await health.onModuleDestroy(); }

  stage('inject-transactional-failed-migration-and-prove-restored-copy-unchanged');
  const beforeFailure = await fingerprints(targetMigrationUrl);
  const failing = client(targetMigrationUrl, 'contextflow-m62-failed-migration'); await failing.connect();
  let expectedFailure = false;
  try {
    await failing.query('BEGIN');
    await failing.query(`ALTER TABLE contextflow."Workspace" ADD COLUMN "m62FailureProbe" text`);
    try { await failing.query(`INSERT INTO contextflow."Project" (id,"workspaceId",topic,formats,"createdBy") VALUES ($1,$2,'failed migration row',ARRAY['ARTICLE']::contextflow."ProjectFormat"[],$3)`, [randomUUID(), randomUUID(), owner]); }
    catch (error) { expectedFailure = (error as { code?: string }).code === '23503'; }
    await failing.query('ROLLBACK');
    if (!expectedFailure) throw new Error('migration-failure-injection-did-not-fail-as-expected');
    const probe = await failing.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='contextflow' AND table_name='Workspace' AND column_name='m62FailureProbe'`);
    if (probe.rows[0].count !== 0) throw new Error('failed-migration-schema-change-remained');
  } finally { await failing.end(); }
  const afterFailure = await fingerprints(targetMigrationUrl);
  if (JSON.stringify(beforeFailure) !== JSON.stringify(afterFailure)) throw new Error('failed-migration-changed-restored-data');
  record.failedMigration = { injected: 'transactional ALTER plus invalid project foreign key', expectedSqlState: '23503', schemaAndRowsRolledBack: true, fingerprintsUnchanged: true };

  record.result = 'passed';
  record.finishedAt = new Date().toISOString();
  record.limitations = ['Synthetic isolated local TEST drill only; no DEV/cloud claim.', 'One bounded functional drill; no backup cadence, retention, RTO or RPO established.', 'Background is a synthetic local image resource, not a paid provider generation.', 'Provider fetch calls are denied and no worker started; process/queue recovery has its separate receipt.'];
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  stage('passed; sanitized report written');
} catch (error) {
  record.result = 'failed'; record.failedAt = new Date().toISOString(); record.stage = currentStage; record.failure = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9:._-]/g, '_').slice(0, 140) : 'unknown';
  await mkdir(dirname(reportPath), { recursive: true }).catch(() => {});
  await writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }).catch(() => {});
  process.exitCode = 1;
  stage(`failed at ${String(record.failure)}`);
} finally {
  for (const object of testObjectIds) {
    await storage.remove('local-originals', object.key).catch(() => {});
    await restoredStorage.remove('local-originals', object.key).catch(() => {});
  }
  await unlink(hostDump).catch(() => {});
  try { run('docker', ['exec', container, 'rm', '-f', containerDump], { maxBuffer: 1024 * 1024 }); } catch { /* Container cleanup is also bounded to the unique archive path. */ }
  if (admin) {
    for (const name of createdDbs.reverse()) {
      try { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [name]); await admin.query(`DROP DATABASE "${name}"`); }
      catch { process.stderr.write(`[m62-restore] cleanup failed for generated database ${name}\n`); process.exitCode = 1; }
    }
    await admin.end().catch(() => {});
  }
}
