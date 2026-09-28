import { test, expect } from '@playwright/test';
import { apiOrigin, workerOrigin } from './ports.js';

test('API and worker expose real dependency readiness and OpenAPI', async ({ request }) => {
  for (const url of [`${apiOrigin}/api/health/ready`, `${workerOrigin}/health/ready`]) {
    const response = await request.get(url);
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ready', checks: { database: 'up', redis: 'up' } });
  }
  const document = await (await request.get(`${apiOrigin}/api/openapi.json`)).json() as { paths: Record<string, unknown> };
  expect(document.paths['/api/health/ready']).toBeDefined();
});

test('web loads local fonts and renders without errors or overflow', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Від джерел');
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '.codex/artifacts/m11/web-' + width + '.png', fullPage: true });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.fonts.check('16px Onest'))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('16px "Source Serif 4"'))).toBe(true);
  console.log(await page.locator('body').ariaSnapshot());
});
