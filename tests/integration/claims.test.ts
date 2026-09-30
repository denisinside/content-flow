import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyHealthService, DurableJobService, FactualBasisService, EXTERNAL_PROCESSING_NOTICE, importedFragments, loadRuntimeConfig,
  type ClaimWorkflowRelease, type JobHandler } from '@contextflow/backend';

describe('exact claim evidence, human review and frozen factual prerequisites', () => {
  const config = loadRuntimeConfig(), health = new DependencyHealthService(config);
  const jobs = new DurableJobService(health.prisma, { noticeVersion: EXTERNAL_PROCESSING_NOTICE.version });
  const facts = new FactualBasisService(health.prisma, jobs);
  const migration = new Pool({ connectionString: config.directDatabaseUrl, ssl: false, max: 2 });
  const owner = randomUUID(), member = randomUUID(), foreign = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID(), otherProject = randomUUID();
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  type Source = { materialId: string; snapshotId: string; fragmentId: string; text: string; startOffset: number; endOffset: number; sha256: string };
  let source!: Source, alternate!: Source, notes!: Source, foreignSource!: Source;
  const release: ClaimWorkflowRelease = { endpoint: 'https://api.dify.ai/v1', workflowId: 'synthetic-workflow', releaseId: 'synthetic-release',
    configDigest: 'a'.repeat(64), contractVersion: 'claims-v1', promptTemplateVersion: 'claim-prompt-v1' };
  async function addSource(targetProject: string, text: string, purpose: 'FACTUAL_SOURCE' | 'NOTES' = 'FACTUAL_SOURCE'): Promise<Source> {
    const materialId = randomUUID(), snapshotId = randomUUID(), fragments = importedFragments(text);
    await health.prisma.$transaction(async tx => {
      await tx.material.create({ data: { id: materialId, projectId: targetProject, kind: 'TEXT', purpose, label: 'Synthetic exact source', createdBy: owner } });
      await tx.sourceSnapshot.create({ data: { id: snapshotId, projectId: targetProject, materialId, sequence: 1, normalizedText: text,
        sha256: hash(text), bytes: Buffer.byteLength(text, 'utf8'), origin: 'MANUAL_TEXT', createdBy: owner } });
      await tx.sourceFragment.createMany({ data: fragments.map(fragment => ({ ...fragment, projectId: targetProject, snapshotId })) });
      await tx.material.update({ where: { id: materialId }, data: { currentSnapshotId: snapshotId, revision: { increment: 1 }, updatedAt: new Date() } });
    });
    const first = fragments[0]!;
    return { materialId, snapshotId, fragmentId: first.id, text: text.slice(first.startOffset, first.endOffset), startOffset: first.startOffset, endOffset: first.endOffset, sha256: first.sha256 };
  }
  const evidence = (value = source) => ({ snapshotId: value.snapshotId, fragmentId: value.fragmentId, startOffset: value.startOffset,
    endOffset: value.endOffset, quote: value.text, sha256: value.sha256, relation: 'SUPPORTS' as const });
  const create = (wording = 'Україна має 24 області.', value = source) => facts.create(owner, projectId, { wording, evidence: [evidence(value)] });
  beforeAll(async () => {
    expect((await health.check()).status).toBe('ready');
    await health.prisma.userProfile.createMany({ data: [owner, member, foreign].map(id => ({ id })) });
    await health.prisma.workspace.create({ data: { id: workspaceId, name: 'Claim review fixture', ownerId: owner,
      members: { create: [{ userId: owner }, { userId: member }] } } });
    await health.prisma.project.createMany({ data: [projectId, otherProject].map(id => ({ id, workspaceId, createdBy: owner, topic: 'Factual basis', formats: ['TELEGRAM_POST'] })) });
    source = await addSource(projectId, 'Україна має 24 області. 🇺🇦\n\nТаблиця: область | кількість.');
    alternate = await addSource(projectId, 'Альтернативне джерело вказує 25 областей.');
    notes = await addSource(projectId, 'Стилістична нотатка не є фактичним доказом.', 'NOTES');
    foreignSource = await addSource(otherProject, 'Матеріал іншого проєкту.');
  });
  afterAll(async () => {
    for (const id of [projectId, otherProject]) {
      const client = await migration.connect();
      try {
        await client.query('BEGIN');
        for (const table of ['BasisClaimEvidence', 'BasisClaim', 'FactualBasisRevision', 'ConflictResolutionEvidence', 'ClaimConflictParticipant', 'ClaimConflict']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [id]);
        await client.query('UPDATE contextflow."Claim" SET "currentRevisionId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [id]);
        for (const table of ['ClaimEvidence', 'ClaimRevision', 'Claim', 'AIExecution']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [id]);
        await client.query('DELETE FROM contextflow."JobAttempt" WHERE "jobId" IN (SELECT "id" FROM contextflow."Job" WHERE "projectId"=$1)', [id]);
        await client.query('DELETE FROM contextflow."Job" WHERE "projectId"=$1', [id]);
        await client.query('UPDATE contextflow."Material" SET "currentSnapshotId"=NULL,"revision"="revision"+1,"updatedAt"=CURRENT_TIMESTAMP WHERE "projectId"=$1', [id]);
        for (const table of ['SourceFragment', 'SourceSnapshot', 'Material']) await client.query(`DELETE FROM contextflow."${table}" WHERE "projectId"=$1`, [id]);
        await client.query('DELETE FROM contextflow."Project" WHERE "id"=$1', [id]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }
    await health.prisma.workspaceMember.deleteMany({ where: { workspaceId } });
    await health.prisma.workspace.delete({ where: { id: workspaceId } });
    await health.prisma.userProfile.deleteMany({ where: { id: { in: [owner, member, foreign] } } });
    await migration.end(); await health.onModuleDestroy();
  });

  it('offers explicit missing factual basis and unverified creative mode, without requiring Q14 for manual review', async () => {
    expect(await facts.basis(member, projectId, 'FACTUAL')).toMatchObject({ missingBasis: true, unverified: false, basis: null, blockingReasons: ['MISSING_BASIS'] });
    expect(await facts.basis(member, projectId, 'CREATIVE')).toMatchObject({ missingBasis: false, unverified: true, basis: null, blockingReasons: [] });
    const created = await create();
    expect(created.claim.currentRevision).toMatchObject({ status: 'PROPOSED', approvedAt: null });
    await expect(facts.extract(owner, projectId, randomUUID(), release)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects invented quotes, mismatched UTF-16 ranges, foreign references and nonfactual or missing support', async () => {
    for (const invalid of [ { ...evidence(), quote: 'Invented text' }, { ...evidence(), endOffset: source.endOffset - 1 },
      { ...evidence(), sha256: '0'.repeat(64) }, evidence(foreignSource), evidence(notes), { ...evidence(), relation: 'CONTRADICTS' as const } ]) {
      await expect(facts.create(owner, projectId, { wording: 'Invalid evidence', evidence: [invalid] })).rejects.toMatchObject({ status: 400 });
    }
    await expect(facts.list(foreign, projectId)).rejects.toMatchObject({ status: 404 });
    const count = await health.prisma.claim.count({ where: { projectId } });
    expect(count).toBe(1);
    const startOffset = source.text.indexOf('🇺');
    const quote = source.text.slice(startOffset, startOffset + 1);
    await expect(facts.create(owner, projectId, { wording: 'A split Unicode scalar is not an exact storable excerpt',
      evidence: [{ ...evidence(), startOffset, endOffset: startOffset + 1, quote, sha256: hash(quote) }] })).rejects.toMatchObject({ status: 400 });
  });
  it('preserves first approval, approved wording and history when edits append and withdrawal is terminal', async () => {
    const initial = (await create()).claim;
    const approved = (await facts.review(member, projectId, initial.id, initial.currentRevisionId!, 'approve', { expectedRevision: initial.revision })).claim;
    expect(approved.currentRevision).toMatchObject({ status: 'APPROVED', approvedBy: member });
    const basis = await facts.freezeBasis(owner, projectId, { claimRevisionIds: [approved.currentRevisionId!] });
    expect(basis.basis.valid).toBe(true);
    const edited = (await facts.edit(owner, projectId, initial.id, { expectedRevision: approved.revision, wording: 'Нове формулювання.', evidence: [evidence()] })).claim;
    expect(edited.currentRevision).toMatchObject({ status: 'PROPOSED', number: 2 });
    expect((await facts.basis(member, projectId, 'FACTUAL')).basis).toMatchObject({ id: basis.basis.id, valid: false, blockingReasons: ['CLAIM_CHANGED'] });
    const detail = await facts.detail(member, projectId, initial.id);
    expect(detail.revisions.find(row => row.id === initial.currentRevisionId)).toMatchObject({ wording: initial.currentRevision!.wording, status: 'APPROVED', approvedBy: member });
    const withdrawn = (await facts.review(owner, projectId, initial.id, initial.currentRevisionId!, 'withdraw', { expectedRevision: edited.revision, reason: 'Reviewed withdrawal' })).claim;
    await expect(facts.review(member, projectId, initial.id, initial.currentRevisionId!, 'withdraw', { expectedRevision: withdrawn.revision })).rejects.toMatchObject({ status: 409 });
    await expect(health.prisma.claimRevision.update({ where: { id: initial.currentRevisionId! }, data: { wording: 'Overwrite' } })).rejects.toThrow();
    await expect(health.prisma.claimRevision.update({ where: { id: initial.currentRevisionId! }, data: { withdrawnAt: null, withdrawnBy: null, withdrawalReason: null } })).rejects.toThrow();
  });
  it('keeps rejected revisions terminal and permits a separate reviewed revision', async () => {
    const initial = (await create('A proposed interpretation')).claim;
    const rejected = (await facts.review(member, projectId, initial.id, initial.currentRevisionId!, 'reject', { expectedRevision: initial.revision })).claim;
    await expect(facts.review(owner, projectId, initial.id, initial.currentRevisionId!, 'approve', { expectedRevision: rejected.revision })).rejects.toMatchObject({ status: 409 });
    const edited = (await facts.edit(owner, projectId, initial.id, { expectedRevision: rejected.revision, wording: 'Reviewed revised interpretation', evidence: [evidence()] })).claim;
    const approved = await facts.review(member, projectId, initial.id, edited.currentRevisionId!, 'approve', { expectedRevision: edited.revision });
    expect(approved.claim.currentRevision?.status).toBe('APPROVED');
    expect((await facts.detail(owner, projectId, initial.id)).revisions.find(row => row.id === initial.currentRevisionId)?.status).toBe('REJECTED');
  });
  it('keeps evidence attached to old snapshots after reimport and purpose/include changes', async () => {
    const created = (await create()).claim;
    const approved = (await facts.review(member, projectId, created.id, created.currentRevisionId!, 'approve', { expectedRevision: created.revision })).claim;
    const frozen = await facts.freezeBasis(owner, projectId, { claimRevisionIds: [approved.currentRevisionId!] });
    const text = 'Оновлене джерело: новий текст.', id = randomUUID();
    await health.prisma.$transaction(async tx => {
      await tx.sourceSnapshot.create({ data: { id, projectId, materialId: source.materialId, sequence: 2, previousSnapshotId: source.snapshotId,
        normalizedText: text, sha256: hash(text), bytes: Buffer.byteLength(text), origin: 'MANUAL_TEXT', createdBy: owner } });
      await tx.sourceFragment.createMany({ data: importedFragments(text).map(row => ({ ...row, projectId, snapshotId: id })) });
      await tx.material.update({ where: { id: source.materialId }, data: { currentSnapshotId: id, included: false, purpose: 'BRANDBOOK', revision: { increment: 1 }, updatedAt: new Date() } });
    });
    const inspected = await facts.detail(member, projectId, created.id);
    expect(inspected.claim.currentRevision?.evidence[0]).toMatchObject({ snapshotId: source.snapshotId, materialId: source.materialId, snapshotSequence: 1, quote: source.text });
    expect((await facts.basis(member, projectId, 'FACTUAL')).basis).toMatchObject({ id: frozen.basis.id, valid: true });
    await health.prisma.material.update({ where: { id: source.materialId }, data: { included: true, purpose: 'FACTUAL_SOURCE', revision: { increment: 1 }, updatedAt: new Date() } });
  });
  it('invalidates exact evidence terminally and blocks its frozen basis without rewriting the manifest', async () => {
    const created = (await create()).claim;
    const approved = (await facts.review(owner, projectId, created.id, created.currentRevisionId!, 'approve', { expectedRevision: created.revision })).claim;
    const frozen = await facts.freezeBasis(member, projectId, { claimRevisionIds: [approved.currentRevisionId!] });
    const evidenceId = approved.currentRevision!.evidence[0]!.id;
    const invalidated = await facts.invalidate(member, projectId, created.id, evidenceId, { expectedRevision: approved.revision, reason: 'Evidence does not support the interpretation' });
    expect(invalidated.claim.currentRevision?.evidence[0]).toMatchObject({ invalidatedBy: member, invalidationReason: 'Evidence does not support the interpretation' });
    const basis = await facts.basis(owner, projectId, 'FACTUAL');
    expect(basis).toMatchObject({ missingBasis: true, basis: { id: frozen.basis.id, valid: false, manifest: frozen.basis.manifest } });
    expect(basis.blockingReasons).toContain('INVALID_EVIDENCE');
    await expect(facts.invalidate(owner, projectId, created.id, evidenceId, { expectedRevision: invalidated.claim.revision, reason: 'Change judgement' })).rejects.toMatchObject({ status: 409 });
    await expect(health.prisma.claimEvidence.update({ where: { id: evidenceId }, data: { invalidatedBy: null, invalidatedAt: null, invalidationReason: null } })).rejects.toThrow();
  });
  it('holds conflicting stable claims, records formulation/evidence/rationale, and never automatically approves', async () => {
    const first = (await create()).claim, second = (await create('25 областей за альтернативним джерелом.', alternate)).claim;
    const flagged = await facts.flagConflict(member, projectId, { revisionIds: [first.currentRevisionId!, second.currentRevisionId!], rationale: 'Different region counts' });
    await expect(facts.review(owner, projectId, first.id, first.currentRevisionId!, 'approve', { expectedRevision: first.revision })).rejects.toMatchObject({ status: 409 });
    await expect(facts.resolveConflict(owner, projectId, flagged.conflict.id, { selectedRevisionId: first.currentRevisionId!, selectedEvidenceIds: [second.currentRevision!.evidence[0]!.id], formulation: first.currentRevision!.wording, rationale: 'Wrong evidence' })).rejects.toMatchObject({ status: 400 });
    const resolved = await facts.resolveConflict(owner, projectId, flagged.conflict.id, { selectedRevisionId: first.currentRevisionId!,
      selectedEvidenceIds: [first.currentRevision!.evidence[0]!.id], formulation: first.currentRevision!.wording, rationale: 'Source one has the reviewed formulation' });
    expect(resolved.conflict).toMatchObject({ resolvedBy: owner, selectedRevisionId: first.currentRevisionId, resolutionRationale: 'Source one has the reviewed formulation' });
    expect((await facts.detail(member, projectId, first.id)).claim.currentRevision?.status).toBe('PROPOSED');
    const approvedFirst = (await facts.review(member, projectId, first.id, first.currentRevisionId!, 'approve', { expectedRevision: first.revision })).claim;
    await facts.review(owner, projectId, second.id, second.currentRevisionId!, 'approve', { expectedRevision: second.revision });
    await facts.freezeBasis(owner, projectId, { claimRevisionIds: [approvedFirst.currentRevisionId!] });
    await expect(facts.freezeBasis(owner, projectId, { claimRevisionIds: [second.currentRevisionId!] })).rejects.toMatchObject({ status: 409 });
    await expect(facts.resolveConflict(owner, projectId, flagged.conflict.id, { selectedRevisionId: first.currentRevisionId!, selectedEvidenceIds: [first.currentRevision!.evidence[0]!.id], formulation: first.currentRevision!.wording, rationale: 'Repeat' })).rejects.toMatchObject({ status: 409 });
  });
  it('freezes included factual inputs, validates an entire candidate batch, and preserves worker fences', async () => {
    await health.prisma.userProfile.update({ where: { id: owner }, data: { externalProcessingNoticeVersion: EXTERNAL_PROCESSING_NOTICE.version, externalProcessingAcceptedAt: new Date() } });
    const job = await facts.extract(owner, projectId, randomUUID(), release);
    const manifest = job.inputManifest as { snapshots: Array<{ snapshotId: string; materialId: string; fragments: Array<{ id: string; startOffset: number; endOffset: number; sha256: string }> }> };
    expect(manifest.snapshots.some(row => row.materialId === notes.materialId)).toBe(false);
    const selected = manifest.snapshots.find(row => row.materialId === alternate.materialId)!;
    const claim = { key: 'candidate', wording: 'Provider candidate', evidence: [evidence(alternate)] };
    const before = await health.prisma.claim.count({ where: { projectId } });
    const invalid = { schemaVersion: 'claims-v1', claims: [claim, { ...claim, key: 'bad', evidence: [{ ...evidence(alternate), quote: 'Fabricated quotation' }] }], conflicts: [] };
    await expect(health.prisma.$transaction(tx => facts.commitExtracted(tx, job, invalid))).rejects.toMatchObject({ category: 'INVALID_CONTRACT' });
    expect(await health.prisma.claim.count({ where: { projectId } })).toBe(before);
    const valid = { schemaVersion: 'claims-v1', claims: [claim], conflicts: [] };
    await health.prisma.material.update({ where: { id: alternate.materialId }, data: { included: false, purpose: 'STYLE_SAMPLE', revision: { increment: 1 }, updatedAt: new Date() } });
    const active = await jobs.claim(job.id, 1, 'candidate-worker');
    const handler: JobHandler = { operation: 'CLAIM_EXTRACTION', execute: async () => valid, commit: (tx, result, current) => facts.commitExtracted(tx, current, result) };
    await jobs.succeed(active!.job, active!.attempt, handler, valid);
    const stored = await jobs.get(member, projectId, job.id);
    const ids = (stored.resultRefs as { claimIds: string[] }).claimIds;
    expect((await facts.detail(member, projectId, ids[0]!)).claim.currentRevision).toMatchObject({ status: 'PROPOSED', approvedAt: null });
    expect((await facts.detail(member, projectId, ids[0]!)).claim.currentRevision?.evidence[0]?.snapshotId).toBe(selected.snapshotId);
    await expect(jobs.succeed(active!.job, active!.attempt, handler, valid)).rejects.toThrow('fenced');
    await health.prisma.material.update({ where: { id: alternate.materialId }, data: { included: true, purpose: 'FACTUAL_SOURCE', revision: { increment: 1 }, updatedAt: new Date() } });
  });
  it('reopens a resolved conflict explicitly after editing and preserves the original decision', async () => {
    const first = (await create('First reviewed formulation', alternate)).claim;
    const second = (await create('Other formulation', alternate)).claim;
    const old = await facts.flagConflict(owner, projectId, { revisionIds: [first.currentRevisionId!, second.currentRevisionId!], rationale: 'Review the formulations' });
    await facts.resolveConflict(member, projectId, old.conflict.id, { selectedRevisionId: first.currentRevisionId!,
      selectedEvidenceIds: [first.currentRevision!.evidence[0]!.id], formulation: first.currentRevision!.wording, rationale: 'Choose first wording' });
    const approved = (await facts.review(owner, projectId, first.id, first.currentRevisionId!, 'approve', { expectedRevision: first.revision })).claim;
    const edited = (await facts.edit(member, projectId, first.id, { expectedRevision: approved.revision, wording: 'New reviewed formulation', evidence: [evidence(alternate)] })).claim;
    await expect(facts.freezeBasis(owner, projectId, { claimRevisionIds: [edited.currentRevisionId!] })).rejects.toMatchObject({ status: 409 });
    const reopened = await facts.reopenConflict(owner, projectId, old.conflict.id, { rationale: 'The selected wording changed and needs a new decision' });
    expect(reopened.conflict).toMatchObject({ supersedesId: old.conflict.id, resolvedAt: null, selectedRevisionId: null });
    expect(reopened.conflict.participants.find(row => row.claimId === first.id)?.revisionId).toBe(edited.currentRevisionId);
    await expect(facts.reopenConflict(member, projectId, old.conflict.id, { rationale: 'Duplicate successor' })).rejects.toMatchObject({ status: 409 });
    await expect(facts.review(owner, projectId, first.id, edited.currentRevisionId!, 'approve', { expectedRevision: edited.revision })).rejects.toMatchObject({ status: 409 });
    await facts.resolveConflict(member, projectId, reopened.conflict.id, { selectedRevisionId: edited.currentRevisionId!,
      selectedEvidenceIds: [edited.currentRevision!.evidence[0]!.id], formulation: edited.currentRevision!.wording, rationale: 'Accept the revised wording explicitly' });
    const reviewed = (await facts.review(owner, projectId, first.id, edited.currentRevisionId!, 'approve', { expectedRevision: edited.revision })).claim;
    expect((await facts.freezeBasis(member, projectId, { claimRevisionIds: [reviewed.currentRevisionId!] })).basis.valid).toBe(true);
    const history = await facts.conflicts(member, projectId);
    expect(history.conflicts.find(row => row.id === old.conflict.id)).toMatchObject({ selectedRevisionId: first.currentRevisionId, formulation: first.currentRevision!.wording,
      resolutionRationale: 'Choose first wording', supersededById: reopened.conflict.id });
    expect((await facts.detail(owner, projectId, first.id)).revisions.find(row => row.id === first.currentRevisionId)).toMatchObject({ status: 'APPROVED', wording: first.currentRevision!.wording });
  });
  it('serializes concurrent extraction commits and denies requester membership or archive races', async () => {
    const [one, two] = await Promise.all([facts.extract(owner, projectId, randomUUID(), release), facts.extract(owner, projectId, randomUUID(), release)]);
    const [first, second] = await Promise.all([jobs.claim(one.id, 1, 'parallel-one'), jobs.claim(two.id, 1, 'parallel-two')]);
    const output = { schemaVersion: 'claims-v1', claims: [{ key: 'parallel', wording: 'Parallel candidate', evidence: [evidence(alternate)] }], conflicts: [] };
    const handler: JobHandler = { operation: 'CLAIM_EXTRACTION', execute: async () => output, commit: (tx, result, job) => facts.commitExtracted(tx, job, result) };
    await Promise.all([jobs.succeed(first!.job, first!.attempt, handler, output), jobs.succeed(second!.job, second!.attempt, handler, output)]);
    expect((await jobs.get(owner, projectId, one.id)).status).toBe('SUCCEEDED');
    expect((await jobs.get(owner, projectId, two.id)).status).toBe('SUCCEEDED');
    const race = await facts.extract(owner, projectId, randomUUID(), release), active = await jobs.claim(race.id, 1, 'membership-race');
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: owner } }, data: { leftAt: new Date() } });
    await expect(jobs.succeed(active!.job, active!.attempt, handler, output)).rejects.toMatchObject({ status: 403 });
    await expect(facts.create(owner, projectId, { wording: 'No access', evidence: [evidence(alternate)] })).rejects.toMatchObject({ status: 404 });
    await health.prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: owner } }, data: { leftAt: null } });
    await jobs.cancel(member, projectId, race.id);
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } });
    await expect(create('Archived command', alternate)).rejects.toMatchObject({ status: 404 });
    await health.prisma.workspace.update({ where: { id: workspaceId }, data: { archivedAt: null } });
  });
  it('enforces relational basis/evidence ancestry and immutable manifests using the runtime role', async () => {
    const current = (await create('Immutable relation check', alternate)).claim;
    const approved = (await facts.review(owner, projectId, current.id, current.currentRevisionId!, 'approve', { expectedRevision: current.revision })).claim;
    const frozen = await facts.freezeBasis(owner, projectId, { claimRevisionIds: [approved.currentRevisionId!] });
    await expect(health.prisma.factualBasisRevision.update({ where: { id: frozen.basis.id }, data: { manifest: {} } })).rejects.toThrow();
    const other = (await create('Other revision evidence', alternate)).claim;
    await expect(health.prisma.basisClaimEvidence.create({ data: { projectId, basisId: frozen.basis.id, claimRevisionId: approved.currentRevisionId!, evidenceId: other.currentRevision!.evidence[0]!.id } })).rejects.toThrow();
    await expect(health.prisma.claim.delete({ where: { id: current.id } })).rejects.toThrow();
    const localEvidence = approved.currentRevision!.evidence[0]!;
    await expect(health.prisma.claimEvidence.update({ where: { id: localEvidence.id }, data: { quote: 'Rewritten' } })).rejects.toThrow();
  });
  it('pages every claim and conflict deterministically without foreign Project cursor access', async () => {
    for (let batch = 0; batch < 11; batch++) await Promise.all(Array.from({ length: 5 }, (_, index) => create(`Pagination claim ${batch * 5 + index}`, alternate)));
    const claimIds: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await facts.list(member, projectId, cursor);
      expect(page.claims.length).toBeLessThanOrEqual(50);
      claimIds.push(...page.claims.map(row => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(claimIds).size).toBe(claimIds.length);
    expect(claimIds.length).toBe(await health.prisma.claim.count({ where: { projectId } }));
    await expect(facts.list(owner, otherProject, claimIds[0])).rejects.toMatchObject({ status: 404 });
    const first = (await create('Pagination participant one', alternate)).claim, second = (await create('Pagination participant two', alternate)).claim;
    for (let batch = 0; batch < 11; batch++) await Promise.all(Array.from({ length: 5 }, (_, index) => facts.flagConflict(owner, projectId,
      { revisionIds: [first.currentRevisionId!, second.currentRevisionId!], rationale: `Pagination conflict ${batch * 5 + index}` })));
    const conflictIds: string[] = [];
    cursor = undefined;
    do {
      const page = await facts.conflicts(member, projectId, cursor);
      expect(page.conflicts.length).toBeLessThanOrEqual(50);
      conflictIds.push(...page.conflicts.map(row => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(conflictIds).size).toBe(conflictIds.length);
    expect(conflictIds.length).toBe(await health.prisma.claimConflict.count({ where: { projectId } }));
    await expect(facts.conflicts(owner, otherProject, conflictIds[0])).rejects.toMatchObject({ status: 404 });
  });
});
