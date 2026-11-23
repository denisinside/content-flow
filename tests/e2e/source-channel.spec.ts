import { expect, test } from '@playwright/test';
import { installSourceChannelFixture, passageId, proposedCaption, quote, sourceSetId } from './fixtures/source-channel.js';

test('an older article approval leaves channel saving available and links directly to article versions', async ({ page }) => {
  await installSourceChannelFixture(page, { oldApproval: true });
  await expect(page.getByText('Після погодження статті змінився бриф.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Запропонувати текст' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Зберегти версію' })).toBeEnabled();
  await page.getByRole('button', { name: 'Перейти до погодження статті' }).click();
  await expect(page).toHaveURL(/\/article\?review=1$/);
  await expect(page.getByRole('heading', { name: 'Версії статті' })).toBeVisible();
});

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
  await expect(page.getByRole('region', { name: 'Пропозиція тексту' })).toContainText(proposedCaption, { timeout: 10_000 });
  await expect(editor).toHaveValue('Ручна чернетка має лишитися на місці.');
  expect(sourceSetId).toBeTruthy(); expect(passageId).toBeTruthy();
});

test('pending source generation resumes after reload without another generation request',async ({ page }) => {
  const fixture = await installSourceChannelFixture(page,{ pending: true, emptyDraft: true, refreshFailsOnce: true });
  await page.getByRole('button',{ name: 'Запропонувати текст',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Скасувати підготовку',exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button',{ name: 'Скасувати підготовку',exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Історія й походження' }).click();
  expect(fixture.calls.filter(call => call.path.endsWith('/telegram/source-prepare'))).toHaveLength(1);
  fixture.completeRequest();
  const proposal = page.getByRole('region', { name: 'Пропозиція тексту' });
  await expect(proposal).toContainText(proposedCaption, { timeout: 10_000 });
  expect(fixture.calls.filter(call => call.path === 'failed-caption-refresh')).toHaveLength(1);
  expect(fixture.calls.filter(call => call.path.endsWith('/telegram/source-prepare'))).toHaveLength(1);
  const editor = page.getByRole('textbox', { name: 'Текст публікації' });
  await expect(editor).toHaveValue('');
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(proposal).toContainText(proposedCaption);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await proposal.getByRole('button', { name: 'Застосувати до чернетки' }).click();
  await expect(editor).toHaveValue(proposedCaption);
  await expect(proposal).toHaveCount(0);
});

test('a failed source generation shows reusable excerpts without overwriting the channel draft', async ({ page }) => {
  await installSourceChannelFixture(page, { starter: true });
  await page.getByRole('button', { name: 'Запропонувати текст', exact: true }).click();
  const starter = page.getByRole('region', { name: 'Робоча заготовка з джерел' });
  await expect(starter).toContainText(quote, { timeout: 10_000 });
  const disclosure = starter.locator('summary');
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(starter.getByRole('button', { name: 'Скопіювати заготовку' })).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(starter.getByRole('button', { name: 'Скопіювати заготовку' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Текст публікації' })).toHaveValue('Мій допис має залишитися.');
  await page.reload();
  await expect(starter.getByRole('button', { name: 'Скопіювати заготовку' })).toBeVisible();
});

test('initial generation choices do not autosave an empty channel draft', async ({ page }) => {
  const fixture = await installSourceChannelFixture(page, { emptyDraft: true, pending: true });
  await page.clock.install();
  await page.getByLabel('Джерело матеріалу').selectOption('ARTICLE_DERIVED');
  await page.getByLabel('Передбачити місце для посилання').check();
  await page.getByRole('button', { name: 'Запропонувати текст', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Скасувати підготовку', exact: true })).toBeVisible();
  await page.clock.fastForward(1_000);
  expect(fixture.calls.filter(call => call.path.endsWith('/draft'))).toHaveLength(0);
  expect(fixture.calls.find(call => call.path.endsWith('/source-prepare'))?.body).toMatchObject({
    expectedRevision: 0, inputMode: 'ARTICLE_DERIVED', includeLink: true,
  });
});
