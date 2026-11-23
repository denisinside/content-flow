<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import SourceMarkdown from './SourceMarkdown.vue'


type IndexState = 'READY' | 'PARTIAL' | 'MISSING'
interface EvidenceMaterial {
  id: string
  label: string
  snapshotId: string | null
  snapshotSequence: number | null
  indexState: IndexState
  chunkCount: number
  readyChunkCount: number
  indexing?: boolean
}
interface Passage {
  id: string
  snapshotId: string
  fragmentId: string
  startOffset: number
  endOffset: number
  quote: string
  sha256: string
  materialId: string
  materialLabel: string
  snapshotSequence: number
}
interface SearchPacket {
  id: string
  query: string
  searchMode: 'hybrid'
  hasMore: boolean
  selectionMode?: 'relevance-v1'
  passages: Passage[]
}
interface SearchJob {
  id: string
  status: string
  progressStage: string | null
  errorCategory: string | null
  retryAllowed: boolean
}
interface IndexJob {
  id: string
  status: string
}
interface Snapshot {
  id: string
  materialId: string
  sequence: number
  normalizedText: string
}
interface PendingSearch {
  commandKey: string
  query: string
  snapshotIds: string[]
}
interface RecoveryState {
  version: 1
  query: string
  selectedSnapshotIds: string[]
  pendingSearch: PendingSearch | null
  searchJobId: string | null
  packetJobId: string | null
  searchContext: PendingSearch | null
  packetContext: { query: string; snapshotIds: string[] } | null
  pendingIndexCommand: { commandKey: string; snapshotIds: string[] } | null
  indexJobIds: string[]
  pendingAfterIndex: PendingSearch | null
}

const props = defineProps<{ projectId: string; projectTopic: string; userId: string; csrfToken: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; back: []; projects: [] }>()

const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
const recoveryKey = `cf:evidence:${props.userId}:${props.projectId}`
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const recovery = readRecovery()
const loading = ref(true)
const loadError = ref('')
const configured = ref(false)
const materials = ref<EvidenceMaterial[]>([])
const sourceListQuery = ref('')
const sourceListMode = ref<'ALL' | 'SELECTED' | 'READY' | 'NEEDS_INDEX'>('ALL')
const sourceVisibleLimit = ref(25)
const filteredSourceMaterials = computed(() => {
  const term = sourceListQuery.value.trim().toLocaleLowerCase('uk-UA')
  return materials.value.filter(item => {
    if (sourceListMode.value === 'SELECTED' && (!item.snapshotId || !selectedSnapshotIds.value.includes(item.snapshotId))) return false
    if (sourceListMode.value === 'READY' && item.indexState !== 'READY') return false
    if (sourceListMode.value === 'NEEDS_INDEX' && item.indexState === 'READY') return false
    return !term || item.label.toLocaleLowerCase('uk-UA').includes(term)
  })
})
const visibleSourceMaterials = computed(() => filteredSourceMaterials.value.slice(0, sourceVisibleLimit.value))
function resetSourceLimit() { sourceVisibleLimit.value = 25 }
const selectedSnapshotIds = ref<string[]>(recovery?.selectedSnapshotIds ?? [])
let selectionInitialized = recovery !== null
const sourcesOpen = ref(true)
const query = ref(recovery?.query ?? props.projectTopic.slice(0, 1000))
const queryByteLength = computed(() => new TextEncoder().encode(query.value.trim()).byteLength)
const busy = ref(false)
const indexBusy = ref(false)
const indexError = ref('')
const indexNotice = ref('')
const searchJob = ref<SearchJob | null>(null)
const packet = ref<SearchPacket | null>(null)
const packetContext = ref<RecoveryState['packetContext']>(recovery?.packetContext ?? null)
const currentSearchRequest = ref<PendingSearch | null>(recovery?.searchContext ?? null)
const searchJobId = ref(recovery?.searchJobId ?? null)
const packetJobId = ref(recovery?.packetJobId ?? null)
const submittingSearch = ref(false)
const searchError = ref('')
const searchNotice = ref('')
const showAllPassages = ref(false)
const pendingSearch = ref<PendingSearch | null>(null)
const pendingIndexCommand = ref<RecoveryState['pendingIndexCommand']>(recovery?.pendingIndexCommand ?? null)
const pendingAfterIndex = ref<PendingSearch | null>(recovery?.pendingAfterIndex ?? null)
const snapshot = ref<Snapshot | null>(null)
const snapshotError = ref('')
const snapshotLoading = ref(false)
const inspectorDialog = ref<HTMLDialogElement | null>(null)
const inspectorPassage = ref<Passage | null>(null)
let inspectorTrigger: HTMLElement | null = null
let requestController: AbortController | null = null
let inspectorController: AbortController | null = null
let indexTimer: ReturnType<typeof setTimeout> | undefined
let searchTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let sessionExpired = false
let initialLoaded = false
let recoveryResumed = false
let indexAttempt = 0
const indexJobs = ref<IndexJob[]>((recovery?.indexJobIds ?? []).map(id => ({ id, status: 'RUNNING' })))
const indexNeedsReadinessRefresh = ref(false)

function readRecovery(): RecoveryState | null {
  if (!props.userId || !uuidPattern.test(props.projectId)) return null
  try {
    const raw = sessionStorage.getItem(recoveryKey)
    if (!raw || raw.length > 24_000) return null
    const value = JSON.parse(raw) as Partial<RecoveryState>
    const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length <= 100 && ids.every(id => typeof id === 'string' && uuidPattern.test(id))
    const validSearch = (item: unknown): item is PendingSearch => {
      if (!item || typeof item !== 'object') return false
      const request = item as Partial<PendingSearch>
      return typeof request.commandKey === 'string' && uuidPattern.test(request.commandKey)
        && typeof request.query === 'string' && request.query.length > 0 && request.query.length <= 1000
        && new TextEncoder().encode(request.query).byteLength <= 1536 && validIds(request.snapshotIds)
    }
    const validCommand = (item: unknown): item is NonNullable<RecoveryState['pendingIndexCommand']> => {
      if (!item || typeof item !== 'object') return false
      const command = item as Partial<NonNullable<RecoveryState['pendingIndexCommand']>>
      return typeof command.commandKey === 'string' && uuidPattern.test(command.commandKey) && validIds(command.snapshotIds)
    }
    if (value.version !== 1 || typeof value.query !== 'string' || value.query.length > 1000 || !validIds(value.selectedSnapshotIds)) return null
    if (!(value.pendingSearch === null || validSearch(value.pendingSearch))) return null
    if (!(value.pendingAfterIndex === null || validSearch(value.pendingAfterIndex))) return null
    if (!(value.pendingIndexCommand === null || validCommand(value.pendingIndexCommand))) return null
    if (!(value.searchJobId === null || typeof value.searchJobId === 'string' && uuidPattern.test(value.searchJobId))) return null
    if (!(value.packetJobId == null || typeof value.packetJobId === 'string' && uuidPattern.test(value.packetJobId))) return null
    if (!(value.searchContext == null || validSearch(value.searchContext))) return null
    if (!validIds(value.indexJobIds)) return null
    if (!(value.packetContext === null || value.packetContext && typeof value.packetContext.query === 'string' && value.packetContext.query.length <= 1000 && validIds(value.packetContext.snapshotIds))) return null
    return value as RecoveryState
  } catch {
    return null
  }
}

function persistRecovery() {
  if (!props.userId || disposed || sessionExpired) return
  const value: RecoveryState = {
    version: 1,
    query: query.value.slice(0, 1000),
    selectedSnapshotIds: selectedSnapshotIds.value.slice(0, 100),
    pendingSearch: pendingSearch.value,
    searchJobId: searchJobId.value,
    packetJobId: packetJobId.value,
    searchContext: currentSearchRequest.value,
    packetContext: packetContext.value,
    pendingIndexCommand: pendingIndexCommand.value,
    indexJobIds: indexJobs.value.map(job => job.id).slice(0, 100),
    pendingAfterIndex: pendingAfterIndex.value,
  }
  try { sessionStorage.setItem(recoveryKey, JSON.stringify(value)) } catch { /* The active task remains usable if browser storage is unavailable. */ }
}

watch([query, selectedSnapshotIds, pendingSearch, searchJobId, packetJobId, currentSearchRequest, packetContext, pendingIndexCommand, pendingAfterIndex, indexJobs], persistRecovery, { deep: true })

const selectedMaterials = () => materials.value.filter(item => item.snapshotId && selectedSnapshotIds.value.includes(item.snapshotId))
const canSearch = () => Boolean(query.value.trim()) && query.value.trim().length <= 1000 && queryByteLength.value <= 1536 && selectedMaterials().length > 0
const allSelectedReady = () => selectedMaterials().length > 0 && selectedMaterials().every(item => item.indexState === 'READY')
const activeSearch = () => Boolean(searchJob.value && ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(searchJob.value.status))
const firstPassages = () => packet.value?.passages.slice(0, showAllPassages.value ? undefined : 6) ?? []
const indexSelection = () => materials.value.filter(item => item.snapshotId && selectedSnapshotIds.value.includes(item.snapshotId))
const packetIsCurrent = computed(() => Boolean(packet.value && packetContext.value
  && packetContext.value.query === query.value.trim()
  && sameIds(packetContext.value.snapshotIds, selectedSnapshotIds.value)))

function countLabel(count: number) {
  const mod10 = count % 10, mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} уривок`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} уривки`
  return `${count} уривків`
}

function sourceCountLabel(count: number) {
  const mod10 = count % 10, mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return `${count} джерело`
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} джерела`
  return `${count} джерел`
}

function safeError(status: number) {
  if (status === 401) { emit('session-expired'); return 'Сесія завершилася. Увійдіть знову, щоб продовжити.' }
  if (status === 403) return 'Пошук недоступний. Перевірте доступ і згоду на зовнішню обробку.'
  if (status === 409) return 'Стан джерел змінився. Оновіть сторінку й повторіть дію.'
  if (status === 400 || status === 422) return 'Перевірте запит і вибрані джерела. Введений текст залишився у формі.'
  return 'Не вдалося виконати запит. Введений текст і попередні результати збережено.'
}

function displayError(cause: unknown, fallback: string) {
  if (cause instanceof Error && typeof cause === 'object' && 'status' in cause) return cause.message
  return fallback
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'same-origin', ...options })
  if (disposed) throw new DOMException('Workspace closed', 'AbortError')
  if (response.status === 401) { sessionExpired = true; try { sessionStorage.removeItem(recoveryKey) } catch { /* Ignore unavailable browser storage. */ } }
  if (!response.ok) throw Object.assign(new Error(safeError(response.status)), { status: response.status })
  return response.json() as Promise<T>
}

function command<T>(path: string, body: unknown, signal?: AbortSignal) {
  return request<T>(path, {
    method: 'POST', ...(signal ? { signal } : {}),
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
    body: JSON.stringify(body),
  })
}

let automaticIndexTimer: ReturnType<typeof setTimeout> | undefined
async function loadEvidence() {
  clearTimeout(automaticIndexTimer)
  requestController?.abort()
  requestController = new AbortController()
  const signal = requestController.signal
  if (!initialLoaded) loading.value = true
  loadError.value = ''
  try {
    const result = await request<{ configuration: { configured: boolean }; materials: EvidenceMaterial[] }>('/evidence', { signal })
    if (disposed || signal.aborted) return
    configured.value = result.configuration.configured
    materials.value = result.materials
    const known = new Set(result.materials.flatMap(item => item.snapshotId ? [item.snapshotId] : []))
    selectedSnapshotIds.value = selectionInitialized
      ? selectedSnapshotIds.value.filter(id => known.has(id))
      : result.materials.flatMap(item => item.snapshotId ? [item.snapshotId] : [])
    selectionInitialized = true
    if (!recoveryResumed) await resumeRecovery(known)
    sourcesOpen.value = !allSelectedReady()
  } catch (cause) {
    if (!disposed && !(cause instanceof DOMException && cause.name === 'AbortError')) loadError.value = displayError(cause, 'Не вдалося завантажити вибрані джерела. Спробуйте оновити їх.')
  } finally {
    if (!disposed && !signal.aborted && materials.value.some(item => item.indexing)) {
      automaticIndexTimer = setTimeout(() => void loadEvidence(), 5000)
    }
    initialLoaded = true
    if (!disposed && !signal.aborted) loading.value = false
  }
}

async function resumeRecovery(knownSnapshotIds: Set<string>) {
  recoveryResumed = true
  if (!recovery) return
  const referencesExist = (ids: string[]) => ids.every(id => knownSnapshotIds.has(id))
  const staleSearch = recovery.pendingSearch && !referencesExist(recovery.pendingSearch.snapshotIds)
    || recovery.searchContext && !referencesExist(recovery.searchContext.snapshotIds)
    || recovery.packetContext && !referencesExist(recovery.packetContext.snapshotIds)
  const staleIndex = recovery.pendingIndexCommand && !referencesExist(recovery.pendingIndexCommand.snapshotIds)
  const staleJobs = recovery.indexJobIds.length > 0 && !referencesExist(recovery.pendingIndexCommand?.snapshotIds ?? recovery.pendingAfterIndex?.snapshotIds ?? recovery.selectedSnapshotIds)
  if (staleSearch || staleIndex || staleJobs) {
    pendingSearch.value = null
    pendingIndexCommand.value = null
    pendingAfterIndex.value = null
    searchJobId.value = null
    indexJobs.value = []
    searchError.value = 'Склад джерел змінився після перерваної дії. Перевірте вибір і запустіть пошук заново.'
    indexError.value = 'Склад джерел змінився після перерваної підготовки. Перевірте вибір джерел.'
    persistRecovery()
    return
  }
  if (recovery.searchJobId) {
    searchJobId.value = recovery.searchJobId
    busy.value = true
    searchNotice.value = 'Відновлюємо стан пошуку.'
    try {
      const result = await request<{ job: SearchJob; packet: SearchPacket | null }>(`/evidence/search/${encodeURIComponent(recovery.searchJobId)}`)
      if (disposed) return
      searchJob.value = result.job
      currentSearchRequest.value = recovery.searchContext ?? recovery.pendingSearch
      if (result.packet && result.job.status === 'SUCCEEDED') {
        packet.value = result.packet
        packetContext.value = currentSearchRequest.value ? { query: currentSearchRequest.value.query, snapshotIds: currentSearchRequest.value.snapshotIds } : recovery.packetContext
        packetJobId.value = result.job.id
      }
      if (activeSearch()) scheduleSearchPoll()
      else {
        busy.value = false
        if (result.job.status !== 'SUCCEEDED') {
          searchJobId.value = null
          searchError.value = searchErrorText(result.job)
        }
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        busy.value = false
        searchError.value = displayError(cause, 'Не вдалося відновити стан попереднього пошуку. Перевірте його ще раз.')
      }
    }
  } else if (recovery.pendingSearch) {
    pendingSearch.value = recovery.pendingSearch
    searchError.value = 'Запуск пошуку не підтверджено. Повторіть той самий запит, щоб перевірити його за збереженим ключем.'
  }
  const currentJobSucceeded = recovery.searchJobId && searchJob.value?.id === recovery.searchJobId && searchJob.value.status === 'SUCCEEDED' && packet.value
  if (recovery.packetJobId && !currentJobSucceeded && recovery.packetJobId !== recovery.searchJobId) {
    try {
      const result = await request<{ job: SearchJob; packet: SearchPacket | null }>(`/evidence/search/${encodeURIComponent(recovery.packetJobId)}`)
      if (!disposed && result.job.status === 'SUCCEEDED' && result.packet) {
        packet.value = result.packet
        packetContext.value = recovery.packetContext
        packetJobId.value = result.job.id
      }
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) searchNotice.value = 'Попередній результат більше не вдалося відновити.'
    }
  }
  if (recovery.indexJobIds.length) {
    indexBusy.value = true
    indexJobs.value = recovery.indexJobIds.map(id => ({ id, status: 'RUNNING' }))
    await pollIndexJobs()
  } else if (recovery.pendingIndexCommand) {
    pendingIndexCommand.value = recovery.pendingIndexCommand
    indexError.value = 'Запуск підготовки не підтверджено. Повторіть ту саму дію, щоб перевірити її за збереженим ключем.'
  }
}

function scheduleIndexPoll() {
  if (indexTimer) clearTimeout(indexTimer)
  indexTimer = setTimeout(() => { indexAttempt += 1; void pollIndexJobs() }, Math.min(1000 * 2 ** Math.min(indexAttempt, 3), 8000))
}

function activeIndexJobs() { return indexJobs.value.filter(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)) }

async function finishIndexJobs() {
  if (indexJobs.value.some(job => ['CANCELLED', 'OUTCOME_UNKNOWN'].includes(job.status))) {
    indexBusy.value = false
    indexNeedsReadinessRefresh.value = true
    clearQueuedSearch()
    indexError.value = indexJobs.value.some(job => job.status === 'OUTCOME_UNKNOWN')
      ? 'Не вдалося підтвердити результат підготовки. Зовнішня обробка могла ще тривати, тому новий запит автоматично не запускався.'
      : 'Підготовку скасовано. Частина джерел може залишитися неготовою до пошуку.'
    indexNotice.value = ''
    return
  }
  if (activeIndexJobs().length) {
    scheduleIndexPoll()
    return
  }
  indexBusy.value = false
  indexNeedsReadinessRefresh.value = true
  await refreshIndexReadiness()
}

async function pollIndexJobs() {
  if (!indexBusy.value || disposed) return
  const active = activeIndexJobs()
  if (!active.length) { await finishIndexJobs(); return }
  requestController?.abort()
  requestController = new AbortController()
  const signal = requestController.signal
  try {
    const updates = await Promise.all(active.map(async job => {
      const result = await request<{ job: IndexJob }>(`/jobs/${encodeURIComponent(job.id)}`, { signal })
      return result.job
    }))
    if (disposed || signal.aborted) return
    const byId = new Map(updates.map(job => [job.id, job]))
    indexJobs.value = indexJobs.value.map(job => byId.get(job.id) ?? job)
    await finishIndexJobs()
  } catch (cause) {
    if (disposed || signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return
    indexBusy.value = false
    indexNeedsReadinessRefresh.value = true
    indexError.value = displayError(cause, 'Не вдалося перевірити стан підготовки. Оновіть готовність джерел; новий платний запит не запускався.')
    indexNotice.value = ''
  }
}

async function refreshIndexReadiness() {
  indexNeedsReadinessRefresh.value = false
  await loadEvidence()
  if (loadError.value) {
    indexNeedsReadinessRefresh.value = true
    indexError.value = 'Стан підготовки не оновився. Спробуйте оновити готовність джерел ще раз.'
    return
  }
  if (allSelectedReady()) {
    indexError.value = ''
    indexNotice.value = 'Пошук у вибраних джерелах готовий.'
    const queued = pendingAfterIndex.value
    if (queued && queued.query === query.value.trim() && sameIds(queued.snapshotIds, selectedIds())) {
      pendingAfterIndex.value = null
      await findEvidence(true)
    } else if (queued) {
      clearQueuedSearch()
      indexNotice.value = 'Джерела підготовлено. Запит або вибір джерел змінився, тож натисніть «Знайти в джерелах», щоб продовжити.'
    }
  } else {
    indexError.value = 'Підготовка завершилася, але не всі вибрані фрагменти готові. Оновіть стан або змініть вибір джерел.'
    indexNeedsReadinessRefresh.value = true
  }
}

function toggleSource(item: EvidenceMaterial) {
  if (!item.snapshotId || busy.value || indexBusy.value) return
  selectedSnapshotIds.value = selectedSnapshotIds.value.includes(item.snapshotId)
    ? selectedSnapshotIds.value.filter(id => id !== item.snapshotId)
    : [...selectedSnapshotIds.value, item.snapshotId]
  invalidateAutoSearch()
}

function selectAllSources() {
  if (busy.value || indexBusy.value || pendingSearch.value || pendingIndexCommand.value) return
  selectedSnapshotIds.value = materials.value.flatMap(item => item.snapshotId ? [item.snapshotId] : [])
}

function clearSources() {
  if (busy.value || indexBusy.value || pendingSearch.value || pendingIndexCommand.value) return
  selectedSnapshotIds.value = []
  invalidateAutoSearch()
}

function isSelected(item: EvidenceMaterial) { return Boolean(item.snapshotId && selectedSnapshotIds.value.includes(item.snapshotId)) }
function indexStateLabel(item: EvidenceMaterial) {
  if (!item.snapshotId) return 'Текст ще не готовий'
  if (item.indexing && item.indexState !== 'READY') return 'Автоматично готується до пошуку…'
  if (item.indexState === 'READY') return 'Готове до пошуку'
  if (item.indexState === 'PARTIAL') return `Частково готове · ${item.readyChunkCount} з ${item.chunkCount} фрагментів`
  return 'Потрібно підготувати для пошуку'
}

async function indexSources(retrySame = false, requestedSnapshotIds?: string[]) {
  const selected = indexSelection()
  const snapshotIds = requestedSnapshotIds ?? selected.map(item => item.snapshotId as string)
  if (!configured.value || props.archived || !snapshotIds.length || indexBusy.value) return
  const requestBody = retrySame && pendingIndexCommand.value
    ? pendingIndexCommand.value
    : { commandKey: newCommandKey(), snapshotIds }
  pendingIndexCommand.value = requestBody
  indexBusy.value = true
  indexAttempt = 0
  indexError.value = ''
  indexNotice.value = 'Готуємо вибрані джерела до пошуку.'
  try {
    const result = await command<{ jobs: IndexJob[] }>('/evidence/index', requestBody)
    pendingIndexCommand.value = null
    indexJobs.value = result.jobs
    persistRecovery()
    if (!indexJobs.value.length) {
      indexBusy.value = false
      indexNeedsReadinessRefresh.value = true
      indexError.value = 'Сервер не повернув стан завдань. Оновіть готовність джерел; повторний запит автоматично не запускався.'
      indexNotice.value = ''
      return
    }
    await finishIndexJobs()
  } catch (cause) {
    indexBusy.value = false
    const status = cause && typeof cause === 'object' && 'status' in cause ? Number((cause as { status: unknown }).status) : 0
    if ([400, 401, 403, 409, 422].includes(status)) {
      pendingIndexCommand.value = null
      clearQueuedSearch()
    }
    indexError.value = displayError(cause, 'Не вдалося підтвердити, чи запит на підготовку було прийнято. Повторіть ту саму дію, щоб перевірити результат.')
  }
}

async function startIndexForSearch(snapshotIds: string[]) {
  await indexSources(false, snapshotIds)
}

function sameIds(left: string[], right: string[]) {
  const sortedRight = [...right].sort()
  return left.length === right.length && [...left].sort().every((value, index) => value === sortedRight[index])
}

function clearQueuedSearch() {
  const commandKey = pendingAfterIndex.value?.commandKey
  pendingAfterIndex.value = null
  if (commandKey && pendingSearch.value?.commandKey === commandKey) pendingSearch.value = null
}

function invalidateAutoSearch() {
  if (!pendingAfterIndex.value) return
  if (pendingAfterIndex.value.query !== query.value.trim() || !sameIds(pendingAfterIndex.value.snapshotIds, selectedSnapshotIds.value)) {
    clearQueuedSearch()
  }
}

function searchErrorText(job: SearchJob) {
  if (job.status === 'OUTCOME_UNKNOWN') return 'Стан пошуку невідомий. Повторіть той самий запит, щоб безпечно перевірити його результат.'
  if (job.errorCategory === 'INDEX_NOT_READY' || job.errorCategory === 'INDEX_MISSING') return 'Для вибраних джерел ще готується пошук. Підготуйте їх і повторіть запит.'
  if (job.errorCategory === 'CONFIG' || job.errorCategory === 'CONFIG_CHANGED') return 'Пошук не налаштовано або його конфігурація змінилася. Зверніться до адміністратора простору.'
  if (job.errorCategory === 'TIMEOUT') return 'Пошук триває довше, ніж очікувалося. Перевірте стан або спробуйте ще раз.'
  return 'Не вдалося знайти уривки. Запит залишився у формі; змініть його або повторіть пошук.'
}

function searchStateLabel(job: SearchJob) {
  if (job.progressStage === 'CHECKING_RELEVANCE') return 'Відбираємо уривки, корисні для вашого запиту.'
  if (job.status === 'QUEUED') return 'Запит у черзі.'
  if (job.status === 'RETRY_WAIT') return 'Пошук повторюється.'
  return 'Шукаємо відповідні уривки у вибраних джерелах.'
}

function selectedIds() { return indexSelection().filter(item => item.indexState === 'READY' || item.indexState === 'PARTIAL').map(item => item.snapshotId as string) }
function newCommandKey() { return crypto.randomUUID() }

async function findEvidence(retrySame = false) {
  if (props.archived || busy.value || indexBusy.value || activeSearch() || !configured.value) return
  const cleanQuery = query.value.trim()
  const byteLength = new TextEncoder().encode(cleanQuery).byteLength
  if (!cleanQuery || cleanQuery.length > 1000 || byteLength > 1536 || !canSearch()) return
  if (!allSelectedReady()) {
    if (pendingIndexCommand.value) {
      indexError.value = 'Попередній запит на підготовку ще не підтверджений. Повторіть ту саму дію або оновіть готовність джерел.'
      return
    }
    const requestBody: PendingSearch = { commandKey: newCommandKey(), query: cleanQuery, snapshotIds: selectedMaterials().map(item => item.snapshotId as string) }
    pendingSearch.value = requestBody
    pendingAfterIndex.value = requestBody
    await startIndexForSearch(requestBody.snapshotIds)
    return
  }
  const requestBody = retrySame && pendingSearch.value
    ? pendingSearch.value
    : { commandKey: newCommandKey(), query: cleanQuery, snapshotIds: selectedIds() }
  pendingSearch.value = requestBody
  currentSearchRequest.value = requestBody
  searchJob.value = null
  searchJobId.value = null
  persistRecovery()
  busy.value = true
  submittingSearch.value = true
  searchError.value = ''
  searchNotice.value = ''
  try {
    const result = await command<{ job: SearchJob }>('/evidence/search', requestBody)
    if (disposed) return
    searchJob.value = result.job
    searchJobId.value = result.job.id
    pendingSearch.value = null
    persistRecovery()
    if (activeSearch()) scheduleSearchPoll()
    else await pollSearch()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return
    searchError.value = displayError(cause, 'Не вдалося підтвердити, чи пошук було запущено. Повторіть той самий запит, щоб перевірити результат.')
    const status = cause && typeof cause === 'object' && 'status' in cause ? Number((cause as { status: unknown }).status) : 0
    if ([400, 401, 403, 409, 422].includes(status)) {
      pendingSearch.value = null
      searchJobId.value = null
      searchNotice.value = 'Запит не прийнято. Перевірте текст і вибрані джерела.'
    } else {
      searchNotice.value = 'Результат запуску невідомий. Перевірте той самий запит, щоб не створити дубль.'
    }
  } finally {
    if (!disposed) { busy.value = false; submittingSearch.value = false; persistRecovery() }
  }
}

function scheduleSearchPoll() {
  if (searchTimer) clearTimeout(searchTimer)
  // Schedule after the previous response: no overlapping requests or growing
  // delay hiding a completed search. A rate-limited retry keeps its longer wait.
  searchTimer = setTimeout(() => { void pollSearch() }, searchJob.value?.status === 'RETRY_WAIT' ? 8000 : 1500)
}

async function pollSearch() {
  const jobId = searchJob.value?.id
  if (!jobId || disposed) return
  requestController?.abort()
  requestController = new AbortController()
  const signal = requestController.signal
  try {
    const result = await request<{ job: SearchJob; packet: SearchPacket | null }>(`/evidence/search/${encodeURIComponent(jobId)}`, { signal })
    if (disposed || signal.aborted || searchJob.value?.id !== jobId) return
    searchJob.value = result.job
    if (activeSearch()) {
      scheduleSearchPoll()
      return
    }
    if (result.job.status === 'SUCCEEDED') {
      packet.value = result.packet
      packetContext.value = currentSearchRequest.value
        ? { query: currentSearchRequest.value.query, snapshotIds: [...currentSearchRequest.value.snapshotIds] }
        : packetContext.value
      packetJobId.value = result.job.id
      showAllPassages.value = false
      searchError.value = ''
      searchNotice.value = result.packet?.passages.length
        ? result.packet.selectionMode === 'relevance-v1'
          ? 'Відібрані для цього запиту уривки. Перевірте їхній зміст у джерелах.'
          : 'Найближчі за змістом уривки. Перевірте, чи містять вони потрібну відповідь.'
        : result.packet?.selectionMode === 'relevance-v1'
          ? 'Серед перевірених уривків не знайдено корисних для цього запиту. Уточніть питання або додайте джерела.'
          : 'Не знайдено достатньо близьких уривків. Спробуйте інакше сформулювати запит або змінити джерела.'
      pendingSearch.value = null
    } else {
      searchError.value = searchErrorText(result.job)
      searchNotice.value = result.job.retryAllowed ? 'Можна повторити цей запит.' : 'Попередні результати залишилися доступні.'
      pendingSearch.value = result.job.status === 'OUTCOME_UNKNOWN' ? pendingSearch.value : null
      searchJobId.value = result.job.status === 'OUTCOME_UNKNOWN' ? searchJobId.value : null
      if (result.job.status !== 'OUTCOME_UNKNOWN') currentSearchRequest.value = null
    }
    busy.value = false
    persistRecovery()
  } catch (cause) {
    if (disposed || signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError')) return
    searchError.value = 'Не вдалося перевірити стан пошуку. Перевірте його ще раз.'
    searchNotice.value = 'Поточний запит і вибрані джерела збережено.'
    busy.value = false
  }
}

async function refreshSearch() {
  if (searchJob.value?.id) {
    searchError.value = ''
    busy.value = true
    await pollSearch()
    return
  }
  if (pendingSearch.value) await findEvidence(true)
}


function onSourceDisclosureToggle(event: Event) {
  sourcesOpen.value = (event.currentTarget as HTMLDetailsElement).open
}

async function openSource(passage: Passage, event: MouseEvent) {
  inspectorTrigger = event.currentTarget as HTMLElement
  inspectorPassage.value = passage
  snapshot.value = null
  snapshotError.value = ''
  snapshotLoading.value = true
  inspectorController?.abort()
  const controller = new AbortController()
  inspectorController = controller
  await nextTick()
  if (!inspectorDialog.value?.open) inspectorDialog.value?.showModal()
  document.getElementById('evidence-source-close')?.focus()
  try {
    const result = await request<{ snapshot: Snapshot }>(
      `/materials/${encodeURIComponent(passage.materialId)}/snapshots/${encodeURIComponent(passage.snapshotId)}`,
      { signal: controller.signal },
    )
    if (disposed || controller.signal.aborted || inspectorController !== controller || !inspectorDialog.value?.open) return
    const selected = result.snapshot
    if (selected.id !== passage.snapshotId || selected.materialId !== passage.materialId || passage.startOffset < 0 || passage.endOffset > selected.normalizedText.length || passage.endOffset <= passage.startOffset || selected.normalizedText.slice(passage.startOffset, passage.endOffset) !== passage.quote) {
      snapshotError.value = 'Точний уривок цієї версії джерела більше не вдалося перевірити.'
      return
    }
    snapshot.value = selected
    // Mount the captured text before looking for its highlight. While loading is
    // true the template only contains the status message, even after nextTick.
    snapshotLoading.value = false
    await nextTick()
    if (disposed || controller.signal.aborted || inspectorController !== controller || !inspectorDialog.value?.open) return
    const target = inspectorDialog.value.querySelector('mark, .source-markdown__fallback')
    target?.scrollIntoView({ block: 'center', inline: 'nearest' })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError' || controller.signal.aborted || inspectorController !== controller || !inspectorDialog.value?.open) return
    snapshotError.value = displayError(cause, 'Не вдалося відкрити збережений текст джерела. Спробуйте ще раз.')
  } finally {
    if (inspectorController === controller && !controller.signal.aborted) snapshotLoading.value = false
  }
}

function closeSource() {
  inspectorController?.abort()
  inspectorController = null
  snapshotLoading.value = false
  inspectorDialog.value?.close()
  inspectorPassage.value = null
  snapshot.value = null
  void nextTick(() => { if (inspectorTrigger?.isConnected) inspectorTrigger.focus() })
}

function onDialogClose() {
  inspectorController?.abort()
  inspectorController = null
  snapshotLoading.value = false
  inspectorPassage.value = null
  snapshot.value = null
  void nextTick(() => { if (inspectorTrigger?.isConnected) inspectorTrigger.focus() })
}

onMounted(() => { void loadEvidence() })
onBeforeUnmount(() => {
  disposed = true
  requestController?.abort()
  inspectorController?.abort()
  if (indexTimer) clearTimeout(indexTimer)
  clearTimeout(automaticIndexTimer)
  if (searchTimer) clearTimeout(searchTimer)
  if (inspectorDialog.value?.open) inspectorDialog.value.close()
})
</script>

<template>
  <div class="evidence-workspace facts-workspace">
    <header class="evidence-heading">
      <h1
        id="evidence-title"
        tabindex="-1"
      >
        Докази для матеріалу
      </h1>
      <p class="evidence-lead">
        Сформулюйте, що потрібно з’ясувати. Знайдемо точні уривки у вибраних джерелах.
      </p>
    </header>

    <form
      class="evidence-search"
      @submit.prevent="findEvidence(Boolean(pendingSearch && !searchJob))"
    >
      <label for="evidence-query">Що потрібно підтвердити або пояснити?</label>
      <textarea
        id="evidence-query"
        v-model="query"
        class="evidence-query"
        rows="3"
        maxlength="1000"
        :disabled="Boolean(activeSearch()) || Boolean(pendingSearch && !searchJob && !pendingAfterIndex) || archived"
        placeholder="Наприклад: як система перевіряє вхід користувача?"
        @input="invalidateAutoSearch"
      />
      <div class="evidence-search-footer">
        <Button
          class="evidence-primary"
          type="submit"
          :aria-busy="busy || indexBusy || Boolean(activeSearch())"
          :disabled="archived || busy || indexBusy || Boolean(activeSearch()) || !canSearch() || !configured"
        >
          {{ pendingAfterIndex ? 'Готуємо джерела для пошуку…' : activeSearch() ? 'Пошук триває…' : submittingSearch ? 'Шукаємо…' : pendingSearch && !searchJob ? 'Перевірити той самий запит' : 'Знайти в джерелах' }}
        </Button>
      </div>
      <p
        v-if="query.trim() && queryByteLength > 1536"
        class="evidence-inline-error"
        role="alert"
      >
        Запит задовгий. Спробуйте коротше сформулювати питання.
      </p>
    </form>

    <section
      class="evidence-sources"
      aria-labelledby="evidence-sources-title"
    >
      <div class="evidence-section-heading">
        <div>
          <h2 id="evidence-sources-title">
            Джерела
          </h2>
        </div>
      </div>

      <p
        v-if="loading"
        class="evidence-muted"
        role="status"
      >
        Завантажуємо вибрані матеріали…
      </p>
      <div
        v-else-if="loadError"
        class="evidence-alert"
        role="alert"
      >
        <p>{{ loadError }}</p>
        <Button
          type="button"
          variant="outline"
          class="evidence-secondary"
          @click="loadEvidence"
        >
          Оновити джерела
        </Button>
      </div>
      <details
        v-else
        class="evidence-source-disclosure"
        :open="sourcesOpen"
        @toggle="onSourceDisclosureToggle"
      >
        <summary>
          <span>{{ selectedMaterials().length ? `Вибрано ${sourceCountLabel(selectedMaterials().length)}` : 'Виберіть джерела для пошуку' }}</span>
          <span class="evidence-source-disclosure-action">{{ sourcesOpen ? 'Згорнути' : 'Змінити' }}</span>
        </summary>
        <div class="evidence-source-disclosure-content">
          <div
            v-if="materials.length"
            class="evidence-source-controls"
          >
            <p>Виберіть матеріали для пошуку.</p>
            <div>
              <Button
                type="button"
                variant="ghost"
                class="evidence-source-control"
                :disabled="archived || busy || indexBusy || Boolean(pendingSearch) || Boolean(pendingIndexCommand)"
                @click="selectAllSources"
              >
                Вибрати всі
              </Button>
              <Button
                type="button"
                variant="ghost"
                class="evidence-source-control"
                :disabled="archived || busy || indexBusy || Boolean(pendingSearch) || Boolean(pendingIndexCommand) || !selectedSnapshotIds.length"
                @click="clearSources"
              >
                Очистити вибір
              </Button>
            </div>
          </div>
          <div
            v-if="!materials.length"
            class="evidence-empty"
          >
            <p>У проєкті ще немає готових джерел для пошуку.</p>
            <a :href="`/projects/${projectId}/sources`">Додати джерела</a>
          </div>
          <div
            v-if="materials.length"
            class="evidence-material-filters"
          >
            <input
              v-model="sourceListQuery"
              type="search"
              aria-label="Знайти джерело для пошуку"
              placeholder="Знайти джерело"
              @input="resetSourceLimit"
            >
            <select
              v-model="sourceListMode"
              aria-label="Фільтр джерел для пошуку"
              @change="resetSourceLimit"
            >
              <option value="ALL">
                Усі джерела
              </option>
              <option value="SELECTED">
                Вибрані
              </option>
              <option value="READY">
                Готові
              </option>
              <option value="NEEDS_INDEX">
                Потребують підготовки
              </option>
            </select>
            <span>{{ filteredSourceMaterials.length }} з {{ materials.length }}</span>
          </div>
          <p
            v-if="materials.length && !filteredSourceMaterials.length"
            class="evidence-empty"
          >
            Немає джерел за вибраними фільтрами.
          </p>
          <ul
            v-else-if="filteredSourceMaterials.length"
            class="evidence-material-list"
          >
            <li
              v-for="material in visibleSourceMaterials"
              :key="material.id"
              class="evidence-material"
            >
              <label class="evidence-material-choice">
                <input
                  type="checkbox"
                  :checked="isSelected(material)"
                  :disabled="!material.snapshotId || archived || busy || indexBusy || Boolean(pendingSearch) || Boolean(pendingIndexCommand)"
                  @change="toggleSource(material)"
                >
                <span class="evidence-material-name">{{ material.label }}</span>
              </label>
              <span
                class="evidence-material-state"
                :data-state="material.indexState"
              >
                {{ indexBusy && material.snapshotId && material.indexState !== 'READY' ? 'Готуємо для пошуку…' : indexStateLabel(material) }}
              </span>
              <a
                class="evidence-source-link"
                :href="`/projects/${projectId}/sources`"
              >Відкрити джерело</a>
            </li>
          </ul>
          <button
            v-if="filteredSourceMaterials.length > visibleSourceMaterials.length"
            type="button"
            class="evidence-source-more"
            @click="sourceVisibleLimit += 25"
          >
            Показати ще ({{ filteredSourceMaterials.length - visibleSourceMaterials.length }})
          </button>
          <Button
            v-if="materials.some(item => item.snapshotId && item.indexState !== 'READY' && !item.indexing)"
            type="button"
            variant="outline"
            class="evidence-secondary"
            :disabled="archived || indexBusy || !configured || !indexSelection().length"
            @click="indexSources(Boolean(pendingIndexCommand))"
          >
            {{ indexBusy ? 'Готуємо джерела…' : pendingIndexCommand ? 'Перевірити ту саму дію' : 'Підготувати до пошуку' }}
          </Button>
        </div>
      </details>

      <p
        v-if="!configured && !loading"
        class="evidence-alert"
        role="alert"
      >
        Пошук ще не підключено. Джерела збережені; потрібне налаштування сервера.
      </p>
    </section>
    <p
      v-if="indexNotice"
      class="evidence-notice"
      role="status"
    >
      {{ indexNotice }}
    </p>
    <div
      v-if="indexError"
      class="evidence-alert"
      role="alert"
    >
      <p>{{ indexError }}</p>
      <Button
        v-if="indexNeedsReadinessRefresh"
        type="button"
        variant="outline"
        class="evidence-secondary"
        :disabled="indexBusy"
        @click="refreshIndexReadiness"
      >
        Оновити готовність джерел
      </Button>
      <Button
        v-else
        type="button"
        variant="outline"
        class="evidence-secondary"
        :disabled="indexBusy"
        @click="indexSources(Boolean(pendingIndexCommand))"
      >
        {{ pendingIndexCommand ? 'Перевірити ту саму дію' : 'Спробувати ще раз' }}
      </Button>
    </div>

    <section
      class="evidence-results"
      aria-labelledby="evidence-results-title"
      aria-live="polite"
    >
      <div class="evidence-section-heading">
        <div>
          <h2 id="evidence-results-title">
            {{ packet ? 'Знайдені уривки' : 'Результати пошуку' }}
          </h2>
          <p
            v-if="packet && !packetIsCurrent"
            class="evidence-stale-result"
          >
            Попередній результат · {{ countLabel(packet.passages.length) }} · за запитом: {{ packet.query }}
          </p>
          <p v-else-if="packet">
            За запитом: {{ packet.query }}
          </p>
        </div>
        <span
          v-if="packet && packetIsCurrent"
          class="evidence-result-count"
        >{{ countLabel(packet.passages.length) }}</span>
      </div>

      <p
        v-if="activeSearch()"
        class="evidence-muted"
        role="status"
      >
        {{ searchStateLabel(searchJob!) }}
      </p>
      <p
        v-else-if="busy"
        class="evidence-muted"
        role="status"
      >
        Запускаємо пошук…
      </p>
      <div
        v-if="searchError"
        class="evidence-alert"
        role="alert"
      >
        <p>{{ searchError }}</p>
        <Button
          v-if="searchJob || pendingSearch"
          type="button"
          variant="outline"
          class="evidence-secondary"
          :disabled="busy"
          @click="refreshSearch"
        >
          Перевірити стан ще раз
        </Button>
      </div>
      <p
        v-if="searchNotice"
        class="evidence-muted"
      >
        {{ searchNotice }}
      </p>

      <ol
        v-if="packet?.passages.length"
        class="evidence-passage-list"
      >
        <li
          v-for="passage in firstPassages()"
          :key="passage.id"
          class="evidence-passage"
        >
          <blockquote>
            <SourceMarkdown
              :text="passage.quote"
              compact
            />
          </blockquote>
          <div class="evidence-passage-footer">
            <span>{{ passage.materialLabel }}</span>
            <button
              type="button"
              class="evidence-open-source"
              @click="openSource(passage, $event)"
            >
              Відкрити в джерелі
            </button>
          </div>
        </li>
      </ol>
      <Button
        v-if="packet && packet.passages.length > 6 && !showAllPassages"
        type="button"
        variant="ghost"
        class="evidence-show-more"
        @click="showAllPassages = true"
      >
        Показати ще {{ packet.passages.length - 6 }} уривків
      </Button>
      <p
        v-if="packet?.hasMore"
        class="evidence-muted evidence-more-hint"
      >
        Є й інші можливі уривки. Уточніть запит, щоб змінити добірку.
      </p>
      <p
        v-else-if="packet && !packet.passages.length && !searchError"
        class="evidence-muted"
      >
        За цим запитом уривків не знайдено. Спробуйте уточнити запит або вибрати інші джерела.
      </p>
      <p
        v-else-if="!packet && !searchError && !activeSearch() && !loading"
        class="evidence-muted evidence-empty-results"
      >
        Пошук ще не запускали. Введіть запит і натисніть «Знайти в джерелах».
      </p>
    </section>

    <dialog
      ref="inspectorDialog"
      class="evidence-inspector"
      aria-labelledby="evidence-source-title"
      @close="onDialogClose"
    >
      <div class="evidence-inspector-header">
        <div>
          <h2 id="evidence-source-title">
            {{ inspectorPassage?.materialLabel ?? 'Джерело' }}
          </h2>
          <p v-if="inspectorPassage">
            Збережена версія {{ inspectorPassage.snapshotSequence }}
          </p>
        </div>
        <Button
          id="evidence-source-close"
          type="button"
          variant="ghost"
          class="evidence-close"
          @click="closeSource"
        >
          Закрити
        </Button>
      </div>
      <p
        v-if="snapshotLoading"
        role="status"
        class="evidence-muted"
      >
        Відкриваємо збережений текст…
      </p>
      <p
        v-else-if="snapshotError"
        role="alert"
        class="evidence-alert"
      >
        {{ snapshotError }}
      </p>
      <div
        v-else-if="snapshot && inspectorPassage"
        class="evidence-captured-text"
        tabindex="0"
        aria-label="Збережений текст із виділеним доказовим уривком"
      >
        <SourceMarkdown
          :text="snapshot.normalizedText"
          :highlight="{ startOffset: inspectorPassage.startOffset, endOffset: inspectorPassage.endOffset }"
        />
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.evidence-workspace { max-width: 1220px; margin: 0 auto; padding: 0 48px 64px; color: var(--ink); }
.evidence-heading { margin: 0 0 25px; }
.evidence-heading h1 { margin: 0; font-family: var(--serif); font-size: 39px; line-height: 1.2; font-weight: 550; letter-spacing: -.025em; }
.evidence-lead { max-width: 68ch; margin: 9px 0 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
.evidence-search { display: grid; gap: 10px; max-width: 800px; padding: 0 0 26px; border-bottom: 1px solid var(--rule); }
.evidence-search > label { font-size: 13px; font-weight: 600; }
.evidence-query { width: 100%; min-height: 105px; padding: 13px 15px; border: 1px solid var(--field-rule, var(--rule)); border-radius: 3px; background: var(--document); color: var(--ink); font: inherit; font-family: var(--serif); font-size: 18px; line-height: 1.55; resize: vertical; }
.evidence-query:focus-visible, .evidence-material-choice input:focus-visible, .evidence-open-source:focus-visible, .evidence-captured-text:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.evidence-search-footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.evidence-hint, .evidence-muted, .evidence-section-heading p, .evidence-inspector-header p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.evidence-primary, .evidence-secondary { min-height: 40px; border-radius: 3px; font-size: 13px; }
.evidence-primary { flex-shrink: 0; background: var(--graphite, #30383d); color: #fff; }
.evidence-sources, .evidence-results { padding: 26px 0; border-bottom: 1px solid var(--rule); }
.evidence-section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 18px; margin-bottom: 15px; }
.evidence-section-heading h2 { margin: 0 0 3px; font-family: var(--serif); font-size: 24px; line-height: 1.3; font-weight: 500; }
.evidence-source-disclosure { border-top: 1px solid var(--rule); }
.evidence-source-disclosure summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 50px; color: var(--ink); font-size: 13px; cursor: pointer; list-style-position: inside; }
.evidence-source-disclosure summary:focus-visible, .evidence-source-control:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.evidence-source-disclosure-action { color: var(--muted); text-decoration: underline; text-underline-offset: 3px; }
.evidence-source-disclosure-content { padding-bottom: 8px; }
.evidence-source-controls { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0 0 8px; color: var(--muted); font-size: 12px; }
.evidence-source-controls p { margin: 0; }
.evidence-source-controls > div { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.evidence-source-control { min-height: 38px; padding: 4px 0; color: var(--ink); font-size: 12px; text-decoration: underline; text-underline-offset: 3px; }
.evidence-material-filters { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:0 0 12px; }
.evidence-material-filters input,.evidence-material-filters select { min-height:36px; min-width:0; padding:7px 9px; border:1px solid var(--rule); border-radius:3px; background:var(--paper); color:var(--ink); font:12px var(--sans); }
.evidence-material-filters input { flex:1 1 170px; }
.evidence-material-filters select { flex:1 1 155px; }
.evidence-material-filters span { flex:none; color:var(--muted); font-size:12px; }
.evidence-source-more { padding:10px 0; border:0; background:transparent; font:500 12px var(--sans); color:var(--copper); text-decoration:underline; cursor:pointer; }
.evidence-source-more:focus-visible,.evidence-material-filters :is(input,select):focus-visible { outline:2px solid var(--copper); outline-offset:2px; }
.evidence-material-list, .evidence-passage-list { margin: 0; padding: 0; list-style: none; }
.evidence-material { display: grid; grid-template-columns: minmax(190px, 1fr) minmax(190px, auto) auto; align-items: center; gap: 15px; min-height: 58px; border-top: 1px solid var(--rule); }
.evidence-material-choice { display: flex; align-items: flex-start; gap: 10px; min-width: 0; font-size: 14px; line-height: 1.5; cursor: pointer; }
.evidence-material-choice input { flex-shrink: 0; margin: 4px 0 0; accent-color: var(--ink); }
.evidence-material-name { overflow-wrap: anywhere; }
.evidence-material-state { color: var(--muted); font-size: 12px; line-height: 1.5; }
.evidence-material-state[data-state="READY"] { color: var(--approval, var(--ink)); }
.evidence-material-state[data-state="PARTIAL"], .evidence-material-state[data-state="MISSING"] { color: var(--review, var(--muted)); }
.evidence-source-link, .evidence-empty a, .evidence-alert a { color: var(--ink); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.evidence-source-link { justify-self: end; font-size: 12px; }
.evidence-empty { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 0; border-top: 1px solid var(--rule); font-size: 14px; }
.evidence-empty p { margin: 0; }
.evidence-alert { display: grid; justify-items: start; gap: 9px; padding: 14px 0; color: var(--ink); font-size: 13px; line-height: 1.55; }
.evidence-alert p { margin: 0; }
.evidence-inline-error { margin: 0; color: var(--review, #8b5d2c); font-size: 12px; }
.evidence-notice { margin: 13px 0 0; color: var(--muted); font-size: 12px; }
.evidence-result-count { flex-shrink: 0; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.evidence-stale-result { max-width: 68ch; color: var(--review, var(--muted)) !important; }
.evidence-passage { padding: 17px 0; border-top: 1px solid var(--rule); }
.evidence-passage blockquote { max-width: 78ch; margin: 0 0 11px; font-family: var(--serif); font-size: 19px; line-height: 1.65; overflow-wrap: anywhere; }
.evidence-passage-footer { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.evidence-passage-footer span { overflow-wrap: anywhere; }
.evidence-open-source { min-height: 36px; padding: 4px 0; border: 0; background: transparent; color: var(--ink); font: inherit; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.evidence-show-more { margin-top: 7px; padding-inline: 0; text-decoration: underline; text-underline-offset: 3px; }
.evidence-more-hint { margin-top: 12px; }
.evidence-empty-results { padding: 10px 0; }
.evidence-inspector { position: fixed; inset: 0; margin: auto; width: min(860px, calc(100vw - 36px)); max-width: none; max-height: min(86vh, 920px); overflow: auto; padding: 0; border: 1px solid var(--rule); border-radius: 3px; background: var(--document); color: var(--ink); }
.evidence-inspector::backdrop { background: rgb(21 26 29 / 55%); }
.evidence-inspector-header { position: sticky; top: 0; z-index: 1; display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 22px 26px 16px; border-bottom: 1px solid var(--rule); background: var(--document); }
.evidence-inspector-header h2 { margin: 0 0 4px; font-family: var(--serif); font-size: 23px; font-weight: 500; line-height: 1.3; overflow-wrap: anywhere; }
.evidence-close { min-height: 40px; flex-shrink: 0; border-radius: 3px; }
.evidence-captured-text { max-height: calc(86vh - 100px); overflow: auto; padding: 22px 26px 34px; font-family: var(--serif); font-size: 17px; line-height: 1.75; overflow-wrap: anywhere; }
.evidence-captured-text mark { background: var(--source-highlight, #f2dfbd); color: inherit; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
@media (max-width: 1150px) { .evidence-workspace { padding-inline: 32px; } }
@media (max-width: 760px) {
  .evidence-workspace { padding: 0 20px 48px; }
  .evidence-heading h1 { font-size: 32px; }
  .evidence-lead { font-size: 14px; }
  .evidence-search-footer, .evidence-empty { align-items: stretch; flex-direction: column; }
  .evidence-primary { width: 100%; min-height: 44px; }
  .evidence-secondary { min-height: 44px; }
  .evidence-source-controls { align-items: flex-start; flex-direction: column; gap: 2px; }
  .evidence-source-controls > div { width: 100%; justify-content: space-between; }
  .evidence-material { grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; padding: 12px 0; }
  .evidence-material-choice { grid-column: 1 / -1; min-height: 30px; }
  .evidence-material-state { grid-column: 1; }
  .evidence-source-link { grid-column: 2; grid-row: 2; justify-self: end; min-height: 36px; display: inline-flex; align-items: center; }
  .evidence-section-heading { align-items: flex-start; flex-direction: column; }
  .evidence-result-count { margin-top: -9px; }
  .evidence-passage blockquote { font-size: 18px; }
  .evidence-passage-footer { align-items: flex-start; flex-direction: column; gap: 5px; }
  .evidence-open-source { min-height: 44px; }
  .evidence-inspector { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); }
  .evidence-inspector-header, .evidence-captured-text { padding-inline: 18px; }
  .evidence-inspector-header h2 { font-size: 21px; }
  .evidence-captured-text { max-height: calc(100dvh - 130px); font-size: 16px; }
}
</style>
