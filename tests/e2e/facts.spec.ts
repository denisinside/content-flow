import { test, expect } from '@playwright/test'
import { installEvidenceDeskFixture } from './fixtures/evidence-desk.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('the Evidence screen has no claims catalogue or factual-basis workflow', async ({ page }) => {
  const fixture = await installEvidenceDeskFixture(page)
  const retiredRequests: string[] = []
  await page.route(/\/api\/v1\/projects\/[^/]+\/(claims|conflicts|basis|factual-basis)(\/|\?|$)/, async route => {
    retiredRequests.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`)
    await route.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ message: 'RETIRED_CLAIMS_API' }) })
  })

  await page.goto(`/projects/${projectId}/facts`)

  await expect(page.getByRole('heading', { name: 'Докази для матеріалу', level: 1 })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Що потрібно підтвердити або пояснити?' })).toBeVisible()
  await expect(page.getByRole('button', { name: /твердженн|фактичн.*основ/i })).toHaveCount(0)
  await expect(page.getByRole('region', { name: /витягуван.*твердженн|збережен.*твердженн/i })).toHaveCount(0)
  await expect(page.getByText(/перед написанням.*схвал.*твердженн|схвален.*фактичн.*основ/i)).toHaveCount(0)

  expect(retiredRequests).toEqual([])
  expect(fixture.violations).toEqual([])
  expect(fixture.pageErrors).toEqual([])
})