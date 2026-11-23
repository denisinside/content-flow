import { describe, it, expect, vi } from 'vitest';
import { ServiceUnavailableException } from '@nestjs/common';
import { JobFenceLost } from '../jobs/contracts.js';
import { normalizeGeneratedBackground } from './background-normalization.js';

const input = Buffer.from([255,216,255]);
const makeResult = () => ({ bytes: Buffer.from([137,80,78,71,13,10,26,10]), mediaType: 'image/png' as const, width:1080,height:1080,sha256:'a'.repeat(64) });

describe('background normalization after paid generation', () => {
  it('retries a temporarily busy local renderer without another provider call', async () => {
    const normalizeImage=vi.fn().mockRejectedValueOnce(new ServiceUnavailableException('Visual renderer is busy; retry shortly'))
      .mockRejectedValueOnce(new ServiceUnavailableException('Visual renderer is busy; retry shortly'))
      .mockResolvedValue(makeResult());
    const wait=vi.fn(async () => {});
    const result=await normalizeGeneratedBackground({normalizeImage} as never,input,'image/jpeg',new AbortController().signal,wait);
    expect(result.width).toBe(1080);
    expect(normalizeImage).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });
  it('does not retry bad raster data or a different renderer error', async () => {
    const normalizeImage=vi.fn().mockRejectedValue(new Error('Invalid raster image'));
    const wait=vi.fn(async () => {});
    await expect(normalizeGeneratedBackground({normalizeImage} as never,input,'image/jpeg',new AbortController().signal,wait))
      .rejects.toThrow('Invalid raster image');
    expect(normalizeImage).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });
  it('stops if the job was cancelled while waiting', async () => {
    const controller=new AbortController();
    const normalizeImage=vi.fn().mockRejectedValue(new ServiceUnavailableException('Visual renderer is busy; retry shortly'));
    const wait=vi.fn(async () => {controller.abort();});
    await expect(normalizeGeneratedBackground({normalizeImage} as never,input,'image/jpeg',controller.signal,wait))
      .rejects.toBeInstanceOf(JobFenceLost);
    expect(normalizeImage).toHaveBeenCalledTimes(1);
  });
});
