import { expect, test } from '@playwright/test';
import { installSourceChannelFixture, passageId, quote, sourceSetId } from './fixtures/source-channel.js';

test('source citation opens its exact saved passage in context and preserves the editor text', async ({ page }) => {
  const fixture = await installSourceChannelFixture(page, { linkedCitation: true });
  const editor = page.getByRole('textbox', { name: 'Текст публікації' });
  const manualText = quote+' Мій ручний текст лишається під час перегляду джерела.';
  await editor.fill(manualText);
  await page.getByRole('button', { name: 'Переглянути уривок' }).click();
  await expect(page.getByRole('region',{ name: 'Вибраний уривок' }).getByRole('heading', { name: 'Звіт про мобільність' })).toBeVisible();
  await expect(page.locator('.telegram-source-context mark')).toHaveText(quote);
  await expect(page.locator('.telegram-source-context')).toContainText('Контекст перед уривком.');
  await expect(editor).toHaveValue(manualText);
  expect(fixture.calls.map(call => call.path)).toContain('snapshot');
  await expect.poll(() => fixture.calls.filter(call => call.path.endsWith('/telegram/draft')).length).toBeGreaterThan(0);
  expect((fixture.calls.findLast(call => call.path.endsWith('/telegram/draft'))!.body!.content as { sourceMappings: unknown[] }).sourceMappings).toEqual([{ startOffset: 0,endOffset: quote.length,quote,passageId,packetId: fixture.passage.packetId }]);
  await page.screenshot({ path: test.info().outputPath('channel-source-1280.png'),fullPage: true });
  await page.setViewportSize({ width: 390,height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('channel-source-390.png'),fullPage: true });
});

test('source inspector refuses a citation that does not match the captured snapshot', async ({ page }) => {
  await installSourceChannelFixture(page, { invalidQuote: true });
  const editor = page.getByRole('textbox', { name: 'Текст публікації' });
  await editor.fill('Ручний текст після помилки джерела.');
  await page.getByRole('button', { name: 'Відкрити джерело' }).click();
  await expect(page.getByRole('alert')).toContainText('не збігається зі збереженим джерелом');
  await expect(editor).toHaveValue('Ручний текст після помилки джерела.');
});

test('factual article-derived generation bypasses only the legacy basis gate and freezes source prep inputs', async ({ page }) => {
  const fixture = await installSourceChannelFixture(page);
  const editor = page.getByRole('textbox', { name: 'Текст публікації' });
  await editor.fill('Ручна чернетка має лишитися на місці.');
  await page.getByLabel('Джерело матеріалу').selectOption('ARTICLE_DERIVED');
  await page.getByLabel('Передбачити місце для посилання').check();
  const propose = page.getByRole('button', { name: 'Запропонувати текст' });
  await expect(propose).toBeEnabled();
  await propose.click();
  await expect.poll(() => fixture.calls.filter(call => call.path.endsWith('/telegram/source-prepare')).length).toBe(1);
  const prep = fixture.calls.find(call => call.path.endsWith('/telegram/source-prepare'))?.body;
  expect(prep).toMatchObject({ inputMode: 'ARTICLE_DERIVED', includeLink: true });
  expect(prep?.commandKey).toEqual(expect.any(String));
  await expect(page.getByText('Пропозиція з доказами готова. Перегляньте її в історії.')).toBeVisible({ timeout: 10_000 });
  await expect(editor).toHaveValue('Ручна чернетка має лишитися на місці.');
  expect(sourceSetId).toBeTruthy(); expect(passageId).toBeTruthy();
});

test('pending source generation resumes after reload without another generation request',async ({ page }) => {
  const fixture = await installSourceChannelFixture(page,{ pending: true });
  await page.getByRole('button',{ name: 'Запропонувати текст',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Скасувати підготовку',exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{ name: 'Скасувати підготовку',exact: true })).toBeVisible();
  expect(fixture.calls.filter(call => call.path.endsWith('/telegram/source-prepare'))).toHaveLength(1);
  fixture.completeRequest();
  await expect(page.getByText('Пропозиція з доказами готова. Перегляньте її в історії.')).toBeVisible({ timeout: 10000 });
  expect(fixture.calls.filter(call => call.path.endsWith('/telegram/source-prepare'))).toHaveLength(1);
});
