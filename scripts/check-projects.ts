import { randomUUID } from 'node:crypto';
import { DependencyHealthService, loadRuntimeConfig } from '@contextflow/backend';

class RollbackFixture extends Error {}
async function main(): Promise<void> {
  const health = new DependencyHealthService(loadRuntimeConfig());
  const userId = randomUUID();
  const projectId = randomUUID();
  const workspaceId = randomUUID();
  const assetId = randomUUID();
  try {
    if ((await health.check()).status !== 'ready') throw new Error('Dependencies unavailable');
    try {
      await health.prisma.$transaction(async tx => {
        await tx.userProfile.create({ data: { id: userId, displayName: 'Synthetic rollback fixture' } });
        await tx.workspace.create({ data: { id: workspaceId, name: 'Synthetic rollback workspace', ownerId: userId,
          members: { create: { userId } }, styles: { create: { revision: 1, createdBy: userId } } } });
        await tx.project.create({ data: { id: projectId, workspaceId, topic: 'Synthetic rollback project', formats: ['ARTICLE'], createdBy: userId } });
        await tx.asset.create({ data: { id: assetId, projectId, bucket: 'private-assets', objectKey: `${projectId}/${assetId}/fixture.txt`, mediaType: 'text/plain', bytes: 1n,
          sha256: 'a'.repeat(64), state: 'AVAILABLE', purpose: 'ORIGINAL', createdBy: userId } });
        const updated = await tx.project.updateMany({ where: { id: projectId, revision: 1, workspace: { members: { some: { userId, leftAt: null } } } },
          data: { topic: 'Updated synthetic rollback project', formats: ['LINKEDIN_TEXT', 'INSTAGRAM_COVER'], revision: { increment: 1 }, updatedAt: new Date() } });
        if (updated.count !== 1) throw new Error('Project update unavailable');
        const selected = await tx.project.findUnique({ where: { id: projectId }, select: { formats: true } });
        if (selected?.formats.join(',') !== 'LINKEDIN_TEXT,INSTAGRAM_COVER') throw new Error('Optional article format change unavailable');
        const asset = await tx.asset.findFirst({ where: { id: assetId, projectId, state: 'AVAILABLE', project: { workspace: { members: { some: { userId, leftAt: null } } } } } });
        if (!asset) throw new Error('Authorized fixture asset unavailable');
        const outsider = await tx.project.findFirst({ where: { id: projectId, workspace: { members: { some: { userId: randomUUID(), leftAt: null } } } } });
        if (outsider) throw new Error('Nonmember access permitted');
        throw new RollbackFixture();
      });
    } catch (error) { if (!(error instanceof RollbackFixture)) throw error; }
    if (await health.prisma.userProfile.findUnique({ where: { id: userId } })) throw new Error('Fixture rollback failed');
    console.info('Workspace project and private asset metadata DML and ancestry filtering verified; synthetic transaction rolled back. No provider accounts, objects or emails created.');
  } finally { await health.onModuleDestroy(); }
}
void main().catch(() => { console.error('Project verification failed; no private values logged.'); process.exitCode = 1; });
