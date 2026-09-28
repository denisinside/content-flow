import {
  BadRequestException, ConflictException, HttpException, Inject, Injectable, InternalServerErrorException, NotFoundException,
  ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { DependencyHealthService, AssetPurpose, MaterialKind, SourceOrigin, type Prisma } from '@contextflow/backend';
import { PrivateAssetStore, STORAGE_MAX_BYTES } from '../storage/private-asset-store.js';
import { ExternalProcessingService } from '../auth/external-processing.js';
import { SessionService } from '../auth/session-service.js';
import { tokenDigest } from '../auth/session-crypto.js';
import type { AppendSnapshotInput, CreateTextSourceInput, UpdateMaterialInput, UploadSourceInput } from './source-input.js';

const MATERIAL_SELECT = {
  id: true, projectId: true, kind: true, purpose: true, label: true, included: true, revision: true,
  currentSnapshotId: true, createdBy: true, createdAt: true, updatedAt: true,
} as const;
const SNAPSHOT_SELECT = {
  id: true, sequence: true, sha256: true, bytes: true, origin: true, originalAssetId: true,
  originalFilename: true, previousSnapshotId: true, createdBy: true, createdAt: true,
} as const;
type MaterialRecord = Prisma.MaterialGetPayload<{ select: typeof MATERIAL_SELECT }>;
type SnapshotRecord = Prisma.SourceSnapshotGetPayload<{ select: typeof SNAPSHOT_SELECT }>;
type UploadedFile = { originalname: string; mimetype: string; buffer: Buffer; size: number };

function iso<T extends { createdAt: Date }>(record: T) { return { ...record, createdAt: record.createdAt.toISOString() }; }
function materialView(record: MaterialRecord) {
  return { ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() };
}
function snapshotView(record: SnapshotRecord) { return iso(record); }
function sha256(bytes: Buffer | string): string { return createHash('sha256').update(bytes).digest('hex'); }

export function normalizeSourceText(value: string): string {
  const normalized = value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.trim() || normalized.length > 200_000 || Buffer.from(normalized, 'utf8').toString('utf8') !== normalized
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(normalized)) {
    throw new BadRequestException('Source text is empty, too long, or contains unsupported control characters');
  }
  return normalized;
}

export function sourceFragments(text: string) {
  const fragments: Array<{ id: string; ordinal: number; startOffset: number; endOffset: number; sha256: string }> = [];
  const separator = /\n(?:[ \t]*\n)+/gu;
  let start = 0;
  for (const match of text.matchAll(separator)) {
    const end = match.index;
    if (end > start) fragments.push({ id: randomUUID(), ordinal: fragments.length + 1, startOffset: start,
      endOffset: end, sha256: sha256(Buffer.from(text.slice(start, end), 'utf8')) });
    start = end + match[0].length;
  }
  if (start < text.length) fragments.push({ id: randomUUID(), ordinal: fragments.length + 1, startOffset: start,
    endOffset: text.length, sha256: sha256(Buffer.from(text.slice(start), 'utf8')) });
  if (!fragments.length || fragments.length > 1000) throw new BadRequestException('Source must contain between 1 and 1000 paragraphs');
  return fragments;
}

export function decodeSourceFile(file: UploadedFile): { text: string; filename: string; mediaType: string } {
  if (file.size > STORAGE_MAX_BYTES || file.buffer.byteLength !== file.size) throw new BadRequestException('Source file exceeds the 1 MiB limit');
  let headerFilename = file.originalname;
  // Busboy decodes raw UTF-8 multipart filename bytes as Latin-1. Recover that common
  // representation while leaving already-decoded Unicode and true legacy Latin-1 intact.
  if ([...headerFilename].every(character => character.codePointAt(0)! <= 0xff)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(headerFilename, 'latin1'));
      if (decoded) headerFilename = decoded;
    } catch { /* Preserve a valid legacy Latin-1 filename when it is not UTF-8 bytes. */ }
  }
  const filename = basename(headerFilename.replaceAll('\\', '/'));
  if (!filename || filename.length > 255 || filename !== filename.trim() || /[\u0000-\u001F\u007F]/u.test(filename)) {
    throw new BadRequestException('Invalid source filename');
  }
  const extension = filename.toLowerCase().split('.').at(-1);
  if (!extension || !['txt', 'md', 'markdown'].includes(extension)) throw new BadRequestException('Only TXT and Markdown files are supported');
  const acceptedMime = file.mimetype === 'application/octet-stream' || file.mimetype === 'text/plain'
    || (file.mimetype === 'text/markdown' && extension !== 'txt');
  if (!acceptedMime) throw new BadRequestException('File type does not match its TXT or Markdown extension');
  if (file.buffer.subarray(0, 5).toString('ascii') === '%PDF-' || file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    || file.buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw new BadRequestException('Binary documents are not supported as TXT or Markdown');
  }
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.buffer); }
  catch { throw new BadRequestException('Source file must contain valid UTF-8 text'); }
  const text = normalizeSourceText(decoded);
  return { text, filename, mediaType: extension === 'txt' ? 'text/plain' : 'text/markdown' };
}

@Injectable()
export class SourceService {
  constructor(
    @Inject(DependencyHealthService) private readonly health: DependencyHealthService,
    @Inject(PrivateAssetStore) private readonly assets: PrivateAssetStore,
    @Inject(ExternalProcessingService) private readonly externalProcessing: ExternalProcessingService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  private async assertReadable(userId: string, projectId: string): Promise<void> {
    const project = await this.health.prisma.project.findFirst({ where: { id: projectId,
      workspace: { members: { some: { userId, leftAt: null } } } }, select: { id: true } });
    if (!project) throw new NotFoundException('Project not found');
  }

  private async lockProject(tx: Prisma.TransactionClient, userId: string, projectId: string): Promise<void> {
    const access = await tx.$queryRaw<Array<{ id: string }>>`SELECT p."id" FROM contextflow."Project" p
      JOIN contextflow."Workspace" w ON w."id" = p."workspaceId"
      JOIN contextflow."WorkspaceMember" m ON m."workspaceId" = w."id"
      WHERE p."id" = ${projectId}::uuid AND p."archivedAt" IS NULL AND w."archivedAt" IS NULL
      AND m."userId" = ${userId}::uuid AND m."leftAt" IS NULL FOR SHARE OF p, w, m`;
    if (!access.length) throw new NotFoundException('Project not found');
  }

  private async checkUploadSession(userId: string, cookie: string): Promise<void> {
    const session = await this.sessions.check(cookie, false);
    if (session.kind === 'unavailable') throw new ServiceUnavailableException('Authentication temporarily unavailable');
    if (session.kind !== 'active' || session.user.id !== userId) throw new UnauthorizedException('Session expired');
  }

  private async lockUploadSession(tx: Prisma.TransactionClient, userId: string, cookie: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT s."id" FROM contextflow."AppSession" s
      JOIN contextflow."UserProfile" p ON p."id" = s."userId"
      WHERE s."cookieDigest" = ${tokenDigest(cookie)} AND s."userId" = ${userId}::uuid
      AND s."revokedAt" IS NULL AND s."expiresAt" > CURRENT_TIMESTAMP
      AND s."lastUserActivityAt" > CURRENT_TIMESTAMP - (p."idleTimeoutMinutes" * INTERVAL '1 minute')
      FOR SHARE OF s, p`;
    if (!rows.length) throw new UnauthorizedException('Session expired');
  }

  private async lockMaterial(tx: Prisma.TransactionClient, userId: string, projectId: string, materialId: string): Promise<void> {
    await this.lockProject(tx, userId, projectId);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM contextflow."Material"
      WHERE id = ${materialId}::uuid AND "projectId" = ${projectId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Source not found');
  }

  private async addSnapshot(tx: Prisma.TransactionClient, args: {
    userId: string; projectId: string; materialId: string; text: string; origin: SourceOrigin;
    originalAssetId?: string; originalFilename?: string;
  }) {
    const previous = await tx.sourceSnapshot.findFirst({ where: { projectId: args.projectId, materialId: args.materialId },
      orderBy: { sequence: 'desc' }, select: { id: true, sequence: true } });
    const textBytes = Buffer.from(args.text, 'utf8');
    const snapshot = await tx.sourceSnapshot.create({ data: {
      id: randomUUID(), projectId: args.projectId, materialId: args.materialId,
      sequence: (previous?.sequence ?? 0) + 1, normalizedText: args.text, sha256: sha256(textBytes), bytes: textBytes.byteLength,
      origin: args.origin, originalAssetId: args.originalAssetId ?? null, originalFilename: args.originalFilename ?? null,
      previousSnapshotId: previous?.id ?? null, createdBy: args.userId,
    }, select: SNAPSHOT_SELECT });
    const fragments = sourceFragments(args.text);
    await tx.sourceFragment.createMany({ data: fragments.map(fragment => ({ ...fragment,
      projectId: args.projectId, snapshotId: snapshot.id })) });
    await tx.material.update({ where: { projectId_id: { projectId: args.projectId, id: args.materialId } }, data: {
      currentSnapshotId: snapshot.id, revision: { increment: 1 }, updatedAt: new Date(),
    } });
    return { snapshot, fragments };
  }

  async list(userId: string, projectId: string) {
    await this.assertReadable(userId, projectId);
    const materials = await this.health.prisma.material.findMany({ where: { projectId }, select: MATERIAL_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return { materials: materials.map(materialView) };
  }

  async createText(userId: string, projectId: string, input: CreateTextSourceInput) {
    const text = normalizeSourceText(input.text);
    sourceFragments(text);
    return this.health.prisma.$transaction(async tx => {
      await this.lockProject(tx, userId, projectId);
      const materialId = randomUUID();
      await tx.material.create({ data: { id: materialId, projectId, kind: MaterialKind.TEXT,
        purpose: input.purpose, label: input.label, createdBy: userId }, select: { id: true } });
      const result = await this.addSnapshot(tx, { userId, projectId, materialId, text, origin: SourceOrigin.MANUAL_TEXT });
      return { material: materialView(await tx.material.findUniqueOrThrow({ where: { projectId_id: { projectId, id: materialId } }, select: MATERIAL_SELECT })),
        snapshot: snapshotView(result.snapshot) };
    });
  }

  async upload(userId: string, projectId: string, cookie: string, input: UploadSourceInput, file: UploadedFile) {
    const decoded = decodeSourceFile(file);
    sourceFragments(decoded.text);
    await this.health.prisma.$transaction(tx => this.lockProject(tx, userId, projectId));
    if (this.assets.config.driver === 'supabase') await this.externalProcessing.requireAccepted(userId);
    const assetId = randomUUID();
    const originalBytes = Buffer.from(file.buffer);
    let location: { bucket: string; objectKey: string };
    try { location = await this.assets.put(projectId, assetId, originalBytes); }
    catch { throw new InternalServerErrorException('Could not store source file'); }
    try {
      await this.checkUploadSession(userId, cookie);
      return await this.health.prisma.$transaction(async tx => {
        await this.lockUploadSession(tx, userId, cookie);
        await this.lockProject(tx, userId, projectId);
        const materialId = randomUUID();
        await tx.material.create({ data: { id: materialId, projectId, kind: MaterialKind.FILE,
          purpose: input.purpose, label: input.label, createdBy: userId }, select: { id: true } });
        await tx.asset.create({ data: { id: assetId, projectId, bucket: location.bucket, objectKey: location.objectKey,
          mediaType: decoded.mediaType, bytes: BigInt(originalBytes.byteLength), sha256: sha256(originalBytes),
          state: 'STAGED', purpose: AssetPurpose.ORIGINAL, createdBy: userId } });
        const result = await this.addSnapshot(tx, { userId, projectId, materialId, text: decoded.text,
          origin: SourceOrigin.LOCAL_FILE, originalAssetId: assetId, originalFilename: decoded.filename });
        const available = await tx.asset.updateMany({ where: { id: assetId, projectId, state: 'STAGED' }, data: { state: 'AVAILABLE' } });
        if (available.count !== 1) throw new InternalServerErrorException('Source original could not be finalized');
        return { material: materialView(await tx.material.findUniqueOrThrow({ where: { projectId_id: { projectId, id: materialId } }, select: MATERIAL_SELECT })),
          snapshot: snapshotView(result.snapshot) };
      });
    } catch (originalError) {
      try { await this.assets.remove(location.bucket, location.objectKey); }
      catch {
        throw new InternalServerErrorException('Source upload failed and staged-file cleanup could not complete');
      }
      if (originalError instanceof HttpException) throw originalError;
      throw new InternalServerErrorException('Source upload could not be completed');
    }
  }

  async update(userId: string, projectId: string, materialId: string, input: UpdateMaterialInput) {
    return this.health.prisma.$transaction(async tx => {
      await this.lockMaterial(tx, userId, projectId, materialId);
      const changed = await tx.material.updateMany({ where: { projectId, id: materialId, revision: input.expectedRevision }, data: {
        ...(input.label !== undefined ? { label: input.label } : {}), ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
        ...(input.included !== undefined ? { included: input.included } : {}), revision: { increment: 1 }, updatedAt: new Date(),
      } });
      if (changed.count !== 1) throw new ConflictException('Source changed; reload before saving');
      return { material: materialView(await tx.material.findUniqueOrThrow({ where: { projectId_id: { projectId, id: materialId } }, select: MATERIAL_SELECT })) };
    });
  }

  async appendText(userId: string, projectId: string, materialId: string, input: AppendSnapshotInput) {
    const text = normalizeSourceText(input.text);
    sourceFragments(text);
    return this.health.prisma.$transaction(async tx => {
      await this.lockMaterial(tx, userId, projectId, materialId);
      const current = await tx.material.findUniqueOrThrow({ where: { projectId_id: { projectId, id: materialId } }, select: { revision: true, currentSnapshotId: true } });
      if (current.revision !== input.expectedRevision) throw new ConflictException('Source changed; reload before saving');
      const prior = current.currentSnapshotId ? await tx.sourceSnapshot.findUniqueOrThrow({ where: { projectId_id: { projectId, id: current.currentSnapshotId } }, select: { originalAssetId: true, originalFilename: true } }) : null;
      const result = await this.addSnapshot(tx, { userId, projectId, materialId, text, origin: SourceOrigin.MANUAL_TEXT,
        ...(prior?.originalAssetId && prior.originalFilename ? { originalAssetId: prior.originalAssetId, originalFilename: prior.originalFilename } : {}) });
      return { material: materialView(await tx.material.findUniqueOrThrow({ where: { projectId_id: { projectId, id: materialId } }, select: MATERIAL_SELECT })),
        snapshot: snapshotView(result.snapshot) };
    });
  }

  async detail(userId: string, projectId: string, materialId: string) {
    await this.assertReadable(userId, projectId);
    const material = await this.health.prisma.material.findFirst({ where: { id: materialId, projectId }, select: MATERIAL_SELECT });
    if (!material) throw new NotFoundException('Source not found');
    const snapshots = await this.health.prisma.sourceSnapshot.findMany({ where: { projectId, materialId }, select: SNAPSHOT_SELECT,
      orderBy: { sequence: 'desc' } });
    return { material: materialView(material), snapshots: snapshots.map(snapshotView) };
  }

  async snapshot(userId: string, projectId: string, materialId: string, snapshotId: string) {
    await this.assertReadable(userId, projectId);
    const snapshot = await this.health.prisma.sourceSnapshot.findFirst({ where: { id: snapshotId, projectId, materialId },
      include: { fragments: { select: { id: true, ordinal: true, startOffset: true, endOffset: true, sha256: true }, orderBy: { ordinal: 'asc' } } } });
    if (!snapshot) throw new NotFoundException('Source snapshot not found');
    return { snapshot: { ...snapshotView(snapshot), normalizedText: snapshot.normalizedText,
      fragments: snapshot.fragments } };
  }

  async download(userId: string, projectId: string, assetId: string) {
    const asset = await this.health.prisma.asset.findFirst({ where: { id: assetId, projectId, state: 'AVAILABLE',
      project: { workspace: { members: { some: { userId, leftAt: null } } } },
      sourceSnapshots: { some: { projectId, originalAssetId: assetId } } },
      select: { id: true, projectId: true, bucket: true, objectKey: true, mediaType: true, bytes: true, sha256: true,
        sourceSnapshots: { where: { originalAssetId: assetId }, orderBy: { createdAt: 'asc' }, take: 1, select: { originalFilename: true } } } });
    if (!asset) throw new NotFoundException('Source file not found');
    const bytes = await this.assets.read(asset.bucket, asset.objectKey, asset.sha256);
    if (BigInt(bytes.byteLength) !== asset.bytes) throw new InternalServerErrorException('Stored source file failed integrity checks');
    const stillAuthorized = await this.health.prisma.asset.findFirst({ where: { id: assetId, projectId, state: 'AVAILABLE',
      sourceSnapshots: { some: { projectId, originalAssetId: assetId } },
      project: { workspace: { members: { some: { userId, leftAt: null } } } } }, select: { id: true } });
    if (!stillAuthorized) throw new NotFoundException('Source file not found');
    return { assetId: asset.id, bytes, mediaType: asset.mediaType, filename: asset.sourceSnapshots[0]?.originalFilename ?? 'source.txt' };
  }

  async assertAssetReadable(userId: string, projectId: string, assetId: string): Promise<void> {
    const asset = await this.health.prisma.asset.findFirst({ where: { id: assetId, projectId, state: 'AVAILABLE',
      sourceSnapshots: { some: { projectId, originalAssetId: assetId } },
      project: { workspace: { members: { some: { userId, leftAt: null } } } } }, select: { id: true } });
    if (!asset) throw new NotFoundException('Source file not found');
  }
}
