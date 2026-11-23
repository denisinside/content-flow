import { ServiceUnavailableException } from '@nestjs/common';
import { JobFenceLost } from '../jobs/contracts.js';
import type { VisualRenderer } from './visual-renderer.js';

type Normalizer = Pick<VisualRenderer, 'normalizeImage'>;
const RETRIES = 7;

async function waitForRenderer(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new JobFenceLost();
  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
  if (signal.aborted) throw new JobFenceLost();
}

/**
 * A paid image has already been downloaded. Briefly retry only the local
 * renderer's busy lock; never submit another generation to the provider.
 */
export async function normalizeGeneratedBackground(
  renderer: Normalizer,
  bytes: Buffer,
  mediaType: 'image/png' | 'image/jpeg',
  signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = waitForRenderer,
): ReturnType<Normalizer['normalizeImage']> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (signal.aborted) throw new JobFenceLost();
    try {
      return await renderer.normalizeImage(bytes, mediaType);
    } catch (error) {
      const busy = error instanceof ServiceUnavailableException
        && error.message === 'Visual renderer is busy; retry shortly';
      if (!busy || attempt === RETRIES) throw error;
      await wait(300 * (attempt + 1), signal);
    }
  }
  throw new Error('Unreachable background normalization state');
}
