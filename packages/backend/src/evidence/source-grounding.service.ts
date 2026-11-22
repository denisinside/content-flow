import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { sha256Text } from './contracts.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const setManifestSchema = z.object({ packets: z.array(z.object({ packetId: z.uuid(), sha256: hash,
  ordinal: z.number().int().nonnegative() }).strict()).min(1).max(30) }).strict();
const packetManifestSchema = z.object({ passages: z.array(z.object({ id: z.uuid(), snapshotId: z.uuid(), fragmentId: z.uuid(),
  startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), sha256: hash,
  ordinal: z.number().int().nonnegative(), relevanceId: hash.optional(), relevance: z.enum(['DIRECT', 'PARTIAL']).optional() }).strict()).max(1000) }).passthrough();

export type GroundingPassage = Readonly<{ id: string; packetId: string; snapshotId: string; fragmentId: string;
  startOffset: number; endOffset: number; quote: string; sha256: string; snapshotSha256: string }>;
export type GroundingSet = Readonly<{ id: string; sha256: string; briefRevisionId: string;
  passages: readonly GroundingPassage[]; snapshots: readonly Readonly<{ snapshotId: string; sha256: string }>[];
  requiredClaims: readonly Readonly<{ claimRevisionId: string; wording: string;
    evidence: readonly Readonly<{ evidenceId: string; quote: string }>[] }>[] }>;

type SetRow = { id: string; briefRevisionId: string; sha256: string; manifestJson: unknown; sealed: boolean };
type PacketRow = { id: string; sha256: string; manifestJson: unknown; status: string };
type SpanRow = GroundingPassage & { normalizedText: string | null; actualSnapshotHash: string;
  purpose: string; included: boolean; currentSnapshotId: string | null; ordinal: number };

/** Internal transaction API. Caller holds Project/Workspace/member locks. No AI approvals. */
export class SourceGroundingService {
  async createSet(tx: Prisma.TransactionClient, projectId: string, userId: string,
    briefRevisionId: string, packetIds: readonly string[]): Promise<GroundingSet> {
    if (!packetIds.length || packetIds.length > 30 || new Set(packetIds).size !== packetIds.length
      || packetIds.some(id => !z.uuid().safeParse(id).success)) throw new ConflictException('Invalid frozen evidence packet selection');
    const brief = await tx.briefRevision.findFirst({ where: { id: briefRevisionId, projectId }, select: { contentMode: true } });
    if (!brief || brief.contentMode !== 'FACTUAL') throw new ConflictException('Source evidence requires an exact factual brief');
    const packets = await this.packets(tx, projectId, packetIds);
    const manifest = { packets: packetIds.map((packetId, ordinal) => ({ packetId,
      sha256: packets.find(packet => packet.id === packetId)!.sha256, ordinal })) };
    const id = randomUUID();
    await tx.$executeRaw`INSERT INTO contextflow."SourceEvidenceSet"
      ("id","projectId","briefRevisionId","manifestJson","sha256","createdBy","createdAt","sealed")
      VALUES (${id}::uuid,${projectId}::uuid,${briefRevisionId}::uuid,${JSON.stringify(manifest)}::jsonb,
        ${canonicalManifestHash(manifest)},${userId}::uuid,CURRENT_TIMESTAMP,false)`;
    for (const item of manifest.packets) await tx.$executeRaw`INSERT INTO contextflow."SourceEvidenceSetPacket"
      ("projectId","setId","packetId","packetHash","ordinal") VALUES
      (${projectId}::uuid,${id}::uuid,${item.packetId}::uuid,${item.sha256},${item.ordinal})`;
    await tx.$executeRaw`UPDATE contextflow."SourceEvidenceSet" SET "sealed"=true WHERE "projectId"=${projectId}::uuid AND "id"=${id}::uuid`;
    return this.inspectSet(tx, projectId, id, briefRevisionId, true);
  }

  private async packets(tx: Prisma.TransactionClient, projectId: string, packetIds: readonly string[]): Promise<PacketRow[]> {
    const rows = await tx.$queryRaw<PacketRow[]>`SELECT p."id"::text,p."sha256",p."manifestJson",j."status"::text
      FROM contextflow."SourceEvidencePacket" p JOIN contextflow."Job" j ON j."projectId"=p."projectId" AND j."id"=p."jobId"
      WHERE p."projectId"=${projectId}::uuid AND p."id"=ANY(${[...packetIds]}::uuid[])`;
    if (rows.length !== packetIds.length || rows.some(row => row.status !== 'SUCCEEDED'
      || canonicalManifestHash(row.manifestJson) !== row.sha256)) throw new ConflictException('Evidence packet integrity or completion check failed');
    return packetIds.map(id => rows.find(row => row.id === id)!);
  }

  async inspectSet(tx: Prisma.TransactionClient, projectId: string, setId: string,
    briefRevisionId: string, requireCurrent = false): Promise<GroundingSet> {
    const sets = await tx.$queryRaw<SetRow[]>`SELECT "id"::text,"briefRevisionId"::text,"sha256","manifestJson","sealed"
      FROM contextflow."SourceEvidenceSet" WHERE "projectId"=${projectId}::uuid AND "id"=${setId}::uuid`;
    const set = sets[0];
    if (!set?.sealed || set.briefRevisionId !== briefRevisionId || canonicalManifestHash(set.manifestJson) !== set.sha256) {
      throw new ConflictException('Source evidence set does not match its captured brief and hash');
    }
    const parsed = setManifestSchema.safeParse(set.manifestJson);
    if (!parsed.success || new Set(parsed.data.packets.map(row => row.packetId)).size !== parsed.data.packets.length
      || parsed.data.packets.some((row, index) => row.ordinal !== index)) throw new ConflictException('Source evidence set manifest is invalid');
    const packetIds = parsed.data.packets.map(row => row.packetId);
    const packets = await this.packets(tx, projectId, packetIds);
    const edges = await tx.$queryRaw<Array<{ packetId: string; packetHash: string; ordinal: number }>>`
      SELECT "packetId"::text,"packetHash","ordinal" FROM contextflow."SourceEvidenceSetPacket"
      WHERE "projectId"=${projectId}::uuid AND "setId"=${setId}::uuid ORDER BY "ordinal"`;
    if (canonicalManifestHash(edges.map(row => ({ packetId: row.packetId, sha256: row.packetHash, ordinal: row.ordinal })))
      !== canonicalManifestHash(parsed.data.packets) || packets.some(row => parsed.data.packets.find(packet => packet.packetId === row.id)?.sha256 !== row.sha256)) {
      throw new ConflictException('Source evidence set packet membership changed');
    }
    const rows = await tx.$queryRaw<SpanRow[]>`SELECT s."id"::text,i."packetId"::text,s."snapshotId"::text,s."fragmentId"::text,
      s."startOffset",s."endOffset",s."quote",s."sha256",s."snapshotSha256",snap."sha256" AS "actualSnapshotHash",
      CASE WHEN row_number() OVER (PARTITION BY s."snapshotId" ORDER BY i."packetId", i."ordinal") = 1
        THEN snap."normalizedText" END AS "normalizedText",
      m."purpose"::text,m."included",m."currentSnapshotId"::text,i."ordinal"
      FROM contextflow."SourceEvidencePacketItem" i JOIN contextflow."SourceEvidenceSpan" s ON s."projectId"=i."projectId" AND s."id"=i."spanId"
      JOIN contextflow."SourceSnapshot" snap ON snap."projectId"=s."projectId" AND snap."id"=s."snapshotId"
      JOIN contextflow."Material" m ON m."projectId"=snap."projectId" AND m."id"=snap."materialId"
      WHERE i."projectId"=${projectId}::uuid AND i."packetId"=ANY(${packetIds}::uuid[]) ORDER BY i."packetId",i."ordinal"`;
    // Read and hash the body once per snapshot, even when many packets cite it.
    const snapshotBodies = new Map<string, { text: string; hash: string }>();
    for (const row of rows) {
      if (row.normalizedText === null) continue;
      const hash = sha256Text(row.normalizedText);
      if (hash !== row.actualSnapshotHash) throw new ConflictException('Source snapshot integrity check failed');
      snapshotBodies.set(row.snapshotId, { text: row.normalizedText, hash });
    }
    const snapshots = new Map<string, string>();
    const passages: GroundingPassage[] = [];
    for (const packet of packets) {
      const manifest = packetManifestSchema.safeParse(packet.manifestJson);
      const members = rows.filter(row => row.packetId === packet.id);
      if (!manifest.success || manifest.data.passages.length !== members.length
        || manifest.data.passages.some((entry, index) => entry.ordinal !== index || entry.id !== members[index]?.id
          || entry.snapshotId !== members[index]?.snapshotId || entry.fragmentId !== members[index]?.fragmentId
          || entry.startOffset !== members[index]?.startOffset || entry.endOffset !== members[index]?.endOffset
          || entry.sha256 !== members[index]?.sha256)) throw new ConflictException('Evidence packet contains an invalid source membership');
      for (const row of members) {
        const snapshot = snapshotBodies.get(row.snapshotId);
        if (!snapshot || row.snapshotSha256 !== snapshot.hash
          || snapshot.text.slice(row.startOffset, row.endOffset) !== row.quote || sha256Text(row.quote) !== row.sha256
          || requireCurrent && (!row.included || row.purpose !== 'FACTUAL_SOURCE' || row.currentSnapshotId !== row.snapshotId)) {
          throw new ConflictException('Source evidence is invalid or the selected source version changed');
        }
        snapshots.set(row.snapshotId, row.snapshotSha256);
        if (!passages.some(passage => passage.id === row.id)) passages.push({ id: row.id, packetId: row.packetId, snapshotId: row.snapshotId, fragmentId: row.fragmentId,
          startOffset: row.startOffset, endOffset: row.endOffset, quote: row.quote, sha256: row.sha256, snapshotSha256: row.snapshotSha256 });
      }
    }
    if (!passages.length) throw new ConflictException('No supporting passages were found for this task');
    const brief = await tx.briefRevision.findFirst({ where: { id: briefRevisionId, projectId }, include: { requiredClaims: true } });
    if (!brief || brief.contentMode !== 'FACTUAL') throw new ConflictException('Evidence set requires its original factual brief');
    if (brief.requiredClaims.length) throw new ConflictException('REQUIRED_CLAIMS_RETIRED');
    return { id: set.id, sha256: set.sha256, briefRevisionId, passages,
      snapshots: [...snapshots].map(([snapshotId, sha256]) => ({ snapshotId, sha256 })), requiredClaims: [] };
  }
}
