import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { installEvidenceDeskFixture } from './fixtures/evidence-desk.js'
import { installM63Fixture, projectId } from './fixtures/m63-editorial.js'

const sourceText = [
  '# Заголовок джерела {#заголовок}',
  '',
  '[До прикладу](#приклад-коду) · [Невідомий](#workspace-task)',
  '',
  'Пробіл&nbsp;між словами, символ &amp; та звичайний абзац.',
  '',
  '| Поле | Значення |',
  '| --- | --- |',
  '| Учасники | 12 |',
  '',
  '- пункт **із жирним**',
  '- пункт *із курсивом*',
  '',
  '1. перший нумерований пункт',
  '2. другий нумерований пункт',
  '',
  'Команда `print("&nbsp;")` зберігає сутність буквально.',
  '',
  '## Приклад коду {#приклад-коду}',
  '',
  '```text',
  'literal &nbsp; remains code',
  '```',
  '',
  'Перший абзац після розділювача.',
  '',
  '<p>&nbsp;</p>',
  '<div> &nbsp; </div>',
  '',
  'Другий абзац після розділювача.',
  '',
  '## Дублікат {#приклад-коду}',
  '',
  '## Схожий ідентифікатор {#приклад-коду--2}',
].join('\n')

const now = '2026-10-20T10:00:00Z'
const snapshotId = 'snapshot-1'

async function installMarkdownSnapshot(page: Page, markdown: string) {
  await installM63Fixture(page, false, false, false)
  await page.route(`**/api/v1/projects/${projectId}/materials/source-1/snapshots/${snapshotId}`, async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405 })
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ snapshot: {
        id: snapshotId,
        materialId: 'source-1',
        sequence: 1,
        origin: 'LOCAL_FILE',
        createdAt: now,
        createdBy: 'Synthetic test',
        projectId,
        normalizedText: markdown,
        sha256: 'synthetic-markdown-hash',
        bytes: markdown.length,
        previousSnapshotId: null,
        fragments: [{ id: 'fragment-1', ordinal: 0, startOffset: 0, endOffset: markdown.length, sha256: 'synthetic-fragment-hash' }],
      } }),
    })
  })
}

async function saveViewportScreenshot(page: Page, testInfo: TestInfo, label: string) {
  const width = page.viewportSize()?.width ?? 0
  await page.screenshot({ path: testInfo.outputPath(`${label}-${width}.png`), fullPage: false })
}

test('source reader renders Markdown, decodes prose entities, preserves code and keeps fragments lazy at common widths', async ({ page }, testInfo) => {
  await installMarkdownSnapshot(page, sourceText)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${projectId}/sources`)
  await page.getByRole('button', { name: 'Звіт про щоденні поїздки Фактичне джерело' }).click()

  const reader = page.locator('.source-reader')
  const markdown = reader.locator('[data-source-markdown]').first()
  await expect(markdown.locator('h1')).toHaveText('Заголовок джерела')
  const exampleHeading = markdown.getByRole('heading', { name: 'Приклад коду', exact: true })
  const exampleId = await exampleHeading.getAttribute('id')
  expect(exampleId).toBeTruthy()
  await expect(markdown.getByRole('link', { name: 'До прикладу', exact: true })).toHaveAttribute('href', `#${exampleId}`)
  await expect(markdown.getByRole('link', { name: 'Невідомий', exact: true })).toHaveCount(0)
  await markdown.getByRole('link', { name: 'До прикладу', exact: true }).click()
  await expect(exampleHeading).toBeInViewport()
  await expect(markdown.locator('table')).toBeVisible()
  await expect(markdown.locator('ul li strong')).toHaveText('із жирним')
  await expect(markdown.locator('ul li em')).toHaveText('із курсивом')
  expect(await markdown.locator('.source-markdown__body > ul').evaluate(element => getComputedStyle(element).listStyleType)).toBe('disc')
  expect(await markdown.locator('.source-markdown__body > ol').evaluate(element => getComputedStyle(element).listStyleType)).toBe('decimal')
  await expect(markdown.locator('ul input[type="checkbox"]')).toHaveCount(0)
  await expect(markdown).toContainText('Пробіл між словами, символ & та звичайний абзац.')
  await expect(markdown.locator('pre').filter({ hasText: 'literal &nbsp; remains code' })).toBeVisible()
  await expect(markdown.locator('code').filter({ hasText: 'print("&nbsp;")' })).toBeVisible()
  await expect(markdown.locator('p')).toHaveCount(9)
  await expect(markdown.locator('p').filter({ hasText: /^\s*$/ })).toHaveCount(0)
  await expect(markdown.locator('.source-markdown__literal-html')).toHaveCount(0)

  for (const width of [1280, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect(page.locator('body')).toBeVisible()
    const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }))
    expect(dimensions.document, `document overflow at ${width}px: ${JSON.stringify(dimensions)}`).toBeLessThanOrEqual(dimensions.viewport)
    await saveViewportScreenshot(page, testInfo, 'source-reader')
    if (width === 390) {
      await markdown.locator('h1').scrollIntoViewIfNeeded()
      await page.screenshot({ path: testInfo.outputPath('source-reader-content-390.png'), fullPage: false })
    }
  }

  const rawDetails = reader.locator('details.source-raw-text')
  await expect(rawDetails.locator('summary')).toHaveText('Початкова розмітка')
  await rawDetails.locator('summary').click()
  await expect(rawDetails.locator('pre')).toHaveText(sourceText)

  const fragmentDetails = reader.locator('details.source-fragments')
  await expect(fragmentDetails.locator('ol')).toHaveCount(0)
  await reader.locator('details.source-metadata > summary').click()
  await fragmentDetails.locator('> summary').click()
  await expect(fragmentDetails.locator('ol [data-source-markdown]')).toContainText('Заголовок джерела')
  const fragmentMarkdown = fragmentDetails.locator('ol [data-source-markdown]')
  const fragmentExampleId = await fragmentMarkdown.getByRole('heading', { name: 'Приклад коду', exact: true }).getAttribute('id')
  expect(fragmentExampleId).toBeTruthy()
  expect(fragmentExampleId).not.toBe(exampleId)
  await expect(fragmentMarkdown.getByRole('link', { name: 'До прикладу', exact: true })).toHaveAttribute('href', `#${fragmentExampleId}`)
  const headingIds = await reader.locator('[data-source-markdown] h1[id], [data-source-markdown] h2[id]').evaluateAll(nodes => nodes.map(node => node.id))
  expect(new Set(headingIds).size).toBe(headingIds.length)
})

test('evidence quote and captured source render Markdown with exact canonical UTF-16 passage highlight; dialog closes with Escape and restores focus', async ({ page }, testInfo) => {
  const markdown = 'Попередній розділ джерела без вибраної цитати.\n\n'.repeat(80)
    + 'Перед **важливим** рішенням&nbsp;— звірте emoji 🧭 та висновок.'
  const startOffset = markdown.indexOf('**')
  const endOffset = markdown.length
  const quote = markdown.slice(startOffset, endOffset)
  const expectedDisplay = 'важливим рішенням — звірте emoji 🧭 та висновок.'
  const fixture = await installEvidenceDeskFixture(page)

  await page.route(`**/api/v1/projects/${projectId}/materials/source-1/snapshots/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, async route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ snapshot: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', materialId: 'source-1', sequence: 1,
      normalizedText: markdown,
    } }),
  }))
  await page.route(`**/api/v1/projects/${projectId}/evidence/search/dddddddd-dddd-4ddd-8ddd-dddddddddddd`, async route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'SUCCEEDED', progressStage: 'COMPLETE', errorCategory: null, retryAllowed: false },
      packet: { id: 'synthetic-markdown-packet', query: 'перевірка', searchMode: 'hybrid', hasMore: false, passages: [{
        id: 'synthetic-markdown-passage', snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fragmentId: 'fragment-1',
        startOffset, endOffset, quote, sha256: 'synthetic-markdown-quote-hash', materialId: 'source-1', materialLabel: 'Синтетичне джерело', snapshotSequence: 1,
      }] },
    }),
  }))

  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(`/projects/${projectId}/facts`)
  await page.getByRole('textbox', { name: 'Що потрібно підтвердити або пояснити?' }).fill('перевірка')
  await page.getByRole('button', { name: 'Знайти в джерелах' }).click()
  await expect(page.locator('.evidence-passage blockquote [data-source-markdown]')).toContainText(expectedDisplay)
  const inspectButton = page.getByRole('button', { name: 'Відкрити в джерелі' })
  await inspectButton.focus()
  await inspectButton.click()
  const dialog = page.getByRole('dialog', { name: 'Синтетичне джерело' })
  await expect(dialog).toBeVisible()
  const captured = dialog.locator('.evidence-captured-text [data-source-markdown]')
  await expect(captured.locator('.source-markdown__body')).toContainText('Перед важливим рішенням — звірте emoji 🧭 та висновок.')
  const marks = captured.locator('mark.source-markdown__mark')
  const fallback = captured.locator('details.source-markdown__fallback')
  await expect.poll(async () => marks.evaluateAll(nodes => nodes.map(node => node.textContent ?? '').join(''))).toBe(expectedDisplay)
  await expect.poll(async () => marks.first().evaluate(mark => {
    const scrollport = mark.closest('.evidence-captured-text')
    if (!scrollport) return false
    const target = mark.getBoundingClientRect()
    const viewport = scrollport.getBoundingClientRect()
    return target.top >= viewport.top && target.bottom <= viewport.bottom
  })).toBe(true)
  await expect(fallback).toHaveCount(1)
  await expect(fallback.locator('summary')).toHaveText('Точний фрагмент у джерелі')
  await fallback.locator('summary').click()
  await expect(fallback.locator('code')).toHaveText(quote)
  await saveViewportScreenshot(page, testInfo, 'evidence-inspector')
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(inspectButton).toBeFocused()
  expect(fixture.violations).toEqual([])
})

test('unsafe Markdown and raw HTML never create active links, images, scripts, or external requests', async ({ page }) => {
  const externalRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:5411') externalRequests.push(request.url())
  })
  const unsafeMarkdown = [
    '# Безпечне відображення',
    '',
    '[небезпечне посилання](javascript:alert(1))',
    '',
    '![трекер](https://tracker.invalid/pixel.png)',
    '',
    '<img src="https://tracker.invalid/raw.png" onerror="alert(1)">',
    '<script>window.__markdownExecuted = true</script>',
  ].join('\n')
  await installMarkdownSnapshot(page, unsafeMarkdown)
  await page.goto(`/projects/${projectId}/sources`)
  await page.getByRole('button', { name: 'Звіт про щоденні поїздки Фактичне джерело' }).click()
  const rendered = page.locator('.source-reader [data-source-markdown]').first()
  await expect(rendered.locator('h1')).toHaveText('Безпечне відображення')
  await expect(rendered.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(rendered.locator('img, script, iframe, object, embed')).toHaveCount(0)
  await expect(rendered).toContainText('небезпечне посилання')
  await expect(rendered).toContainText('трекер')
  expect(await page.evaluate(() => (window as Window & { __markdownExecuted?: boolean }).__markdownExecuted)).toBeUndefined()
  expect(externalRequests).toEqual([])
})
