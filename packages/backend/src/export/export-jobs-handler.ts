import type { Prisma } from '../generated/prisma/client.js';
import type { JobContext, JobHandler, JobCommitResult } from '../jobs/contracts.js';
import { JobFailure } from '../jobs/contracts.js';
import type { ExportService } from './export.service.js';

/** Local deterministic render job. It has no provider submission or AI execution. */
export function createExportJobHandler(service: ExportService): JobHandler {
  const stagedByAttempt = new Map<string, unknown>();
  return {
    operation: 'EXPORT_BUILD',
    async execute(context: JobContext): Promise<unknown> {
      await context.setProgress('VALIDATING_EXPORT');
      try {
        const staged = await service.build(context.job, context.signal);
        if (context.signal.aborted) {
          await service.cleanupStaged(staged);
          throw new JobFailure('CANCELLED', 'NOT_SUBMITTED');
        }
        stagedByAttempt.set(context.attempt.id, staged);
        await context.setProgress('EXPORT_STAGED');
        return staged;
      } catch (error) {
        if (error instanceof JobFailure) throw error;
        throw new JobFailure('EXECUTION_FAILED', 'NOT_SUBMITTED');
      }
    },
    async commit(tx: Prisma.TransactionClient, result: unknown, job): Promise<JobCommitResult> {
      return service.commit(tx, job, result);
    },
    async completed(context) {
      stagedByAttempt.delete(context.attempt.id);
    },
    async failed(context) {
      const staged = stagedByAttempt.get(context.attempt.id);
      stagedByAttempt.delete(context.attempt.id);
      await service.cleanupStaged(staged);
    },
  };
}
