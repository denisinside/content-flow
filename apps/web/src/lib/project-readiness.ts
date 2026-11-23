/** Read-only, short-lived single-flight readiness preview shared by the project overview and export tab.
 * Export creation still performs its own authoritative server-side validation. */
interface CachedPreview { expiresAt: number; promise: Promise<unknown> }
const previews = new Map<string, CachedPreview>()
const PREVIEW_TTL_MS = 20_000
const keyOf = (projectId: string, userId: string) => userId + ':' + projectId

export function invalidateProjectReadiness(projectId: string, userId: string) {
  previews.delete(keyOf(projectId, userId))
}

export function getProjectReadinessPreview<T>(projectId: string, userId: string): Promise<T> {
  const key = keyOf(projectId, userId)
  const found = previews.get(key)
  if (found && Date.now() < found.expiresAt) return found.promise as Promise<T>
  const url = '/api/v1/projects/' + encodeURIComponent(projectId) + '/exports?view=items'
  const promise: Promise<T> = fetch(url, { credentials: 'same-origin', cache: 'no-store' })
    .then(async response => {
      if (!response.ok) {
        const error = new Error('Readiness unavailable') as Error & { status: number }
        error.status = response.status
        throw error
      }
      return await response.json() as T
    })
  const record: CachedPreview = { expiresAt: Date.now() + PREVIEW_TTL_MS, promise }
  previews.set(key, record)
  void promise.catch(() => { if (previews.get(key) === record) previews.delete(key) })
  return promise
}

export function prefetchProjectReadiness(projectId: string, userId: string) {
  void getProjectReadinessPreview(projectId, userId).catch(() => { /* Opening export will show its own error. */ })
}
