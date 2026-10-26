import { expect, type Page } from '@playwright/test'
import { installM63Fixture, projectId, sourceName } from './m63-editorial.js'

const base = `/api/v1/projects/${projectId}`
const excerpt = 'У дослідженні взяли участь 12 мешканців міста.'

type EvidenceDeskFixtureOptions = {
  indexed?: boolean
  configured?: boolean
  emptySources?: boolean
  indexNetworkFailureOnce?: boolean
  indexTerminalStatus?: 'RUNNING' | 'SUCCEEDED' | 'CANCELLED' | 'OUTCOME_UNKNOWN'
  indexHttpFailure?: number
  searchFailure?: 'network' | '422' | '409'
  searchPollStatuses?: Array<'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'OUTCOME_UNKNOWN'>
  searchErrorCategory?: string | null
  emptySearchResults?: boolean
  relevanceSelection?: boolean
  hasMore?: boolean
  tamperSnapshot?: boolean
  deferSnapshot?: boolean
}

export async function installEvidenceDeskFixture(page: Page, options: EvidenceDeskFixtureOptions = {}) {
  const baseFixture = await installM63Fixture(page, false, false, true)
  const violations: string[] = []
  const searchBodies: unknown[] = []
  const indexCommandKeys: string[] = []
  const snapshotRequests: string[] = []
  let indexed = options.indexed ?? true
  let failIndexOnce = options.indexNetworkFailureOnce ?? false
  let pollCount = 0
  let indexTerminalStatus: string | null = null
  let currentQuery = 'Як проходять щоденні поїздки мешканців?'
  let searchPollCount = 0
  let searchFailure = options.searchFailure
  let releaseSnapshot: (() => void) | undefined
  let snapshotStartedResolve: (() => void) | undefined
  const snapshotStarted = new Promise<void>(resolve => { snapshotStartedResolve = resolve })
  await page.route('**/api/v1/projects/' + projectId + '/evidence**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === `${base}/evidence` && request.method() === 'GET') {
      const ready = indexed
      return json({
        configuration: { configured: options.configured ?? true },
        materials: options.emptySources ? [] : [
          { id: 'source-1', label: sourceName, snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', snapshotSequence: 1, indexState: ready ? 'READY' : 'MISSING', chunkCount: ready ? 1 : 0, readyChunkCount: ready ? 1 : 0 },
        ],
      })
    }
    if (path === `${base}/evidence/index` && request.method() === 'POST') {
      const body = request.postDataJSON() as { commandKey: string; snapshotIds: string[] }
      expect(body.commandKey).toMatch(/^[0-9a-f-]{36}$/i)
      expect(body.snapshotIds).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
      indexCommandKeys.push(body.commandKey)
      if (options.indexHttpFailure) return json({ error: 'INDEX_REJECTED' }, options.indexHttpFailure)
      if (failIndexOnce) {
        failIndexOnce = false
        return route.abort('failed')
      }
      indexTerminalStatus = options.indexTerminalStatus ?? 'SUCCEEDED'
      return json({ jobs: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'QUEUED' }] }, 202)
    }
    if (path === `${base}/evidence/search` && request.method() === 'POST') {
      const body = request.postDataJSON() as { commandKey: string; query: string; snapshotIds: string[] }
      expect(body.commandKey).toMatch(/^[0-9a-f-]{36}$/i)
      expect(body.query.trim()).not.toBe('')
      expect(body.snapshotIds).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'])
      searchBodies.push(body)
      currentQuery = body.query
      searchPollCount = 0
      if (searchFailure === 'network') return route.abort('failed')
      if (searchFailure === '422') return json({ error: 'INVALID_QUERY' }, 422)
      if (searchFailure === '409') return json({ error: 'SOURCE_CHANGED' }, 409)
      return json({ job: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status: 'RUNNING', progressStage: 'RETRIEVING', errorCategory: null, retryAllowed: false } }, 202)
    }
    if (path === `${base}/evidence/search/dddddddd-dddd-4ddd-8ddd-dddddddddddd` && request.method() === 'GET') {
      pollCount += 1
      const statuses = options.searchPollStatuses ?? ['SUCCEEDED']
      const status = statuses[Math.min(searchPollCount++, statuses.length - 1)] ?? 'SUCCEEDED'
      const terminal = !['QUEUED', 'RUNNING'].includes(status)
      return json({
        job: { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', status, progressStage: terminal ? 'COMPLETE' : options.relevanceSelection ? 'CHECKING_RELEVANCE' : 'RETRIEVING', errorCategory: options.searchErrorCategory ?? null, retryAllowed: status === 'FAILED' },
        packet: status === 'SUCCEEDED' ? {
          id: 'synthetic-evidence-packet', query: currentQuery, searchMode: 'hybrid', hasMore: options.hasMore ?? false,
          ...(options.relevanceSelection ? { selectionMode: 'relevance-v1' } : {}),
          passages: options.emptySearchResults ? [] : [{ id: 'synthetic-passage', snapshotId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fragmentId: 'fragment-1', startOffset: 0, endOffset: excerpt.length, quote: excerpt, sha256: 'synthetic-quote-hash', materialId: 'source-1', materialLabel: sourceName, snapshotSequence: 1 }],
        } : null,
      })
    }
    violations.push(`Unknown evidence API: ${request.method()} ${path}`)
    return json({ error: 'UNMOCKED_EVIDENCE_API' }, 599)
  })
  await page.route(`**/api/v1/projects/${projectId}/jobs/cccccccc-cccc-4ccc-8ccc-cccccccccccc`, async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405 })
    const status = indexTerminalStatus ?? 'RUNNING'
    if (status === 'SUCCEEDED') indexed = true
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status } }),
    })
  })
  await page.route(`**${base}/materials/source-1/snapshots/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`, async route => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 405 })
    snapshotRequests.push(route.request().url())
    snapshotStartedResolve?.()
    if (options.deferSnapshot) await new Promise<void>(resolve => { releaseSnapshot = resolve })
    const normalizedText = options.tamperSnapshot ? `Змінена версія. ${excerpt}` : `${excerpt} Вони описали інші деталі.`
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ snapshot: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', materialId: 'source-1', sequence: 1, normalizedText,
    } }) })
  })
  return { ...baseFixture, violations, searchBodies, indexCommandKeys, snapshotRequests, snapshotStarted,
    setIndexStatus: (value: string) => { indexTerminalStatus = value },
    releaseSnapshot: () => releaseSnapshot?.(), setSearchFailure: (value?: 'network' | '422' | '409') => { searchFailure = value },
    get pollCount() { return pollCount }, get searchPollCount() { return searchPollCount } }
}
