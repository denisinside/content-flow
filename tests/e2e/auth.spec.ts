import { mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { webOrigin } from './ports.js';

const TEST_PASSWORD = 'TestOnly!ContextFlow2026';
const SCREENSHOT_DIR = '.codex/artifacts/m12';

type AuthPayload = {
  authenticated?: boolean;
  csrfToken?: string;
  user?: { id?: string; email?: string; displayName?: string | null };
  confirmationRequired?: boolean;
};

function expectNoProviderTokens(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) expectNoProviderTokens(item);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(key.toLowerCase()).not.toMatch(/^(access_?token|refresh_?token|provider_?token)$/);
    expectNoProviderTokens(child);
  }
}

async function snapshotAtWidths(page: Page, state: string): Promise<void> {
  for (const width of [1440, 1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `${SCREENSHOT_DIR}/auth-${state}-${width}.png`, fullPage: true });
  }
}

test('real local auth flow keeps credentials and provider tokens out of the browser', async ({ page, context }) => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const responseBodies: Array<{ url: string; body: unknown }> = [];
  const setCookieHeaders: string[] = [];
  page.on('response', async response => {
    if (!response.url().includes('/api/auth/')) return;
    setCookieHeaders.push(...await response.headerValues('set-cookie'));
    try {
      responseBodies.push({ url: response.url(), body: await response.json() });
    } catch {
      // Error responses may not carry JSON; status and UI assertions cover those paths.
    }
  });

  const email = `m12-${Date.now()}-${Math.random().toString(36).slice(2, 9)}@example.test`;
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 2, name: 'Раді вас бачити' })).toBeVisible();
  await expect(page.getByLabel('Електронна пошта')).toBeVisible();
  await expect(page.getByLabel('Пароль')).toBeVisible();
  await snapshotAtWidths(page, 'login');

  await page.keyboard.press('Tab');
  const focusStyle = await page.evaluate(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return { visible: false };
    const style = getComputedStyle(active);
    return { visible: style.outlineStyle !== 'none' && style.outlineWidth !== '0px' };
  });
  expect(focusStyle.visible).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  const reducedTransitionMs = await page.locator('input[name="email"]').evaluate(el => {
    const duration = getComputedStyle(el).transitionDuration.split(',')[0]?.trim() ?? '0s';
    const amount = Number.parseFloat(duration);
    return duration.endsWith('ms') ? amount : amount * 1000;
  });
  expect(reducedTransitionMs).toBeLessThanOrEqual(0.01);

  const initialSession = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() as AuthPayload };
  });
  expect(initialSession.status).toBe(200);
  expect(initialSession.body.authenticated).toBe(false);
  expect(initialSession.body.csrfToken).toBeTruthy();

  const missingCsrf = await page.evaluate(async () => {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.test', password: 'invalid' }),
    });
    return response.status;
  });
  expect(missingCsrf).toBe(403);

  const wrongOrigin = await page.request.post(`${webOrigin}/api/auth/login`, {
    headers: { Origin: 'https://attacker.invalid', 'X-CSRF-Token': initialSession.body.csrfToken! },
    data: { email: 'nobody@example.test', password: 'invalid' },
  });
  expect(wrongOrigin.status()).toBe(403);

  await page.getByRole('button', { name: 'Реєстрація' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Створіть обліковий запис' })).toBeVisible();
  await expect(page.getByLabel(/Ваше ім’я/)).toBeVisible();
  await page.getByLabel(/Ваше ім’я/).fill('M12 Browser Test');
  await page.getByLabel('Електронна пошта').fill(email);
  await page.getByLabel('Пароль').fill(TEST_PASSWORD);
  await snapshotAtWidths(page, 'register');
  // Hold a visibility check begun before signup, then deliver its signed-out
  // response after signup succeeds. It must not replace the new auth state.
  let releaseCheck: (() => void) | undefined;
  let sawCheck: (() => void) | undefined;
  let finishCheck: (() => void) | undefined;
  const held = new Promise<void>(resolve => { releaseCheck = resolve; });
  const intercepted = new Promise<void>(resolve => { sawCheck = resolve; });
  const delivered = new Promise<void>(resolve => { finishCheck = resolve; });
  await page.route('**/api/auth/session', async route => {
    const original = await route.fetch();
    sawCheck?.(); await held;
    try { await route.fulfill({ response: original }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { finishCheck?.(); }
  }, { times: 1 });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await intercepted;
  await page.getByRole('button', { name: 'Створити обліковий запис' }).click();

  await expect(page.getByText('Вітаємо, M12 Browser Test', { exact: true })).toBeVisible({ timeout: 20_000 });
  releaseCheck?.(); await delivered;
  await expect(page.getByText('Вітаємо, M12 Browser Test', { exact: true })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await snapshotAtWidths(page, 'account');
  await expect(page.locator('input[name="password"]')).toHaveCount(0);

  const cookies = await context.cookies(webOrigin);
  const sessionCookie = cookies.find(cookie => cookie.name === '__Host-contextflow');
  const csrfCookie = cookies.find(cookie => cookie.name === '__Host-contextflow-csrf');
  for (const cookie of [sessionCookie, csrfCookie]) {
    expect(cookie, 'both opaque session and CSRF cookies should be set').toBeTruthy();
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite).toBe('Lax');
    expect(cookie!.path).toBe('/');
  }
  expect(setCookieHeaders.some(value => value.startsWith('__Host-contextflow='))).toBe(true);
  expect(setCookieHeaders.some(value => value.startsWith('__Host-contextflow-csrf='))).toBe(true);
  expect(setCookieHeaders.every(value => !/;\s*domain=/i.test(value))).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toMatch(/__Host-contextflow/);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })))
    .toEqual({ local: [], session: [] });

  await page.reload();
  await expect(page.getByText('Вітаємо, M12 Browser Test', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Вийти' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Раді вас бачити' })).toBeVisible();

  const replay = await fetch(`${webOrigin}/api/auth/session`, {
    headers: { Cookie: `${sessionCookie!.name}=${sessionCookie!.value}` }
  });
  expect((await replay.json() as AuthPayload).authenticated).toBe(false);

  await page.getByLabel('Електронна пошта').fill(email);
  await page.getByLabel('Пароль').fill('WrongPassword!2026');
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByRole('status')).toContainText('Не вдалося увійти. Перевірте адресу й пароль та спробуйте ще раз.');
  await expect(page.getByLabel('Пароль')).toHaveValue('');
  await expect(page.getByRole('heading', { level: 2, name: 'Раді вас бачити' })).toBeVisible();
  await snapshotAtWidths(page, 'error');

  await page.getByLabel('Пароль').fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Увійти' }).click();
  await expect(page.getByText('Вітаємо, M12 Browser Test', { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Вийти' }).click();
  await expect(page.getByRole('heading', { level: 2, name: 'Раді вас бачити' })).toBeVisible();

  const signedOut = await page.evaluate(async () => {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    return { status: response.status, body: await response.json() as AuthPayload };
  });
  expect(signedOut.status).toBe(200);
  expect(signedOut.body.authenticated).toBe(false);
  expectNoProviderTokens(responseBodies.map(entry => entry.body));
  expect(JSON.stringify(responseBodies).toLowerCase()).not.toMatch(/access_token|refresh_token/);
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })))
    .toEqual({ local: [], session: [] });
});
