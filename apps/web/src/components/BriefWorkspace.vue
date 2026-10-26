<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'

interface BriefRevision { id: string; number: number; contentMode: 'FACTUAL' | 'CREATIVE'; topic: string; audience: string; centralMessage: string; category: string; tone: string; targetLength: number; cta: string; exclusions: string[]; notes: string; style?: { revision: number; tone: string; brandbook: string }; workspaceStyleRevision?: number; contextSnapshots?: unknown; createdAt?: string }
interface Section { title: string; purpose: string; sourcePassageIds?: string[] }
interface OutlineRevision { id: string; number: number; briefRevisionId: string; origin: string; status: string; sourceEvidenceSetId?: string | null; sourceEvidenceSealed?: boolean; content: { title: string; sections: Section[] }; createdAt?: string; approvedAt?: string; withdrawnAt?: string }
interface State { brief: { revision: number; currentRevision: BriefRevision; history: BriefRevision[] } | null; outline: { revision: number; currentRevision: OutlineRevision | null; currentApprovedRevisionId: string | null; revisions: OutlineRevision[] } | null; style: { revision: number; tone: string; brandbook: string; settings: unknown }; articleSelected: boolean }
interface Job { id: string; operation: string; status: string; retryAllowed: boolean; errorCategory?: string; progressStage: string }
interface SourceWritingRequest { id: string; stage: 'INDEXING' | 'SEARCHING' | 'READY' | 'GENERATING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'; errorCategory: string | null; resultRefs?: { outlineRevisionId?: string; sourceEvidenceSetId?: string }; revision: number }
interface BriefProposalFields { topic: string; audience: string; centralMessage: string; category: string; tone: string; targetLength: number; cta: string; exclusions: string[]; notes: string }
interface BriefProposalJob { id: string; status: string; errorCategory?: string | null; retryAllowed?: boolean; progressStage?: string }
interface BriefProposalSource { snapshotId?: string; label: string; sampled: boolean; sourceBytes: number; excerptBytes: number }
interface BriefProposalResult { schemaVersion?: string; status: 'ready' | 'needs_human'; brief: BriefProposalFields | null; assumptions: string[] }
interface BriefProposalResponse { job: BriefProposalJob; proposal: BriefProposalResult | null; stale: boolean; sources: BriefProposalSource[] }
interface BriefProposalCommand { commandKey: string; expectedRevision: number; currentBrief: BriefProposalFields; contentMode: 'FACTUAL' | 'CREATIVE' }
interface BriefFormSnapshot extends Omit<BriefProposalFields, 'exclusions'> { contentMode: 'FACTUAL' | 'CREATIVE'; exclusions: string }
interface BriefProposalSession { jobId?: string; command?: BriefProposalCommand; submitted: BriefFormSnapshot; draft: BriefFormSnapshot; applied?: boolean }
const props = defineProps<{ projectId: string; projectTopic: string; csrfToken: string; userId: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()
const state = ref<State | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const conflict = ref(false)
const saved = ref('')
const baseline = ref('')
const outlineBaseline = ref('')
const briefExpectedRevision = ref(0)
const outlineExpectedRevision = ref(0)
const loadedBriefId = ref<string | null>(null)
const loadedOutlineId = ref<string | null>(null)
const form = reactive({ contentMode: 'FACTUAL' as 'FACTUAL' | 'CREATIVE', topic: props.projectTopic, audience: '', centralMessage: '', category: '', tone: '', targetLength: 600, cta: '', exclusions: '', notes: '' })
const outline = reactive({ title: '', sections: [] as Section[] })
const jobs = ref<Job[]>([])
const jobError = ref('')
const sourceRequest = ref<SourceWritingRequest | null>(null)
const sourceRequestError = ref('')
const sourceSubmitting = ref(false)
const briefProposalConfigured = ref<boolean | null>(null)
const briefProposalConfigError = ref(false)
const briefProposalSubmitting = ref(false)
const briefProposalRefreshing = ref(false)
const briefProposalApplying = ref(false)
const briefProposalError = ref('')
const briefProposalResponse = ref<BriefProposalResponse | null>(null)
const briefProposalSession = ref<BriefProposalSession | null>(null)
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
const dirty = computed(() => JSON.stringify(form) !== baseline.value)
const outlineDirty = computed(() => JSON.stringify(outline) !== outlineBaseline.value)
const valid = computed(() => form.topic.trim() && Number.isInteger(Number(form.targetLength)) && Number(form.targetLength) >= 50 && Number(form.targetLength) <= 20000)
const currentOutline = computed(() => state.value?.outline?.currentRevision)
const candidates = computed(() => state.value?.outline?.revisions.filter(item => item.origin === 'AI' && item.id !== currentOutline.value?.id && item.status === 'PROPOSED') ?? [])
const activeJob = computed(() => jobs.value.some(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)))
const briefProposalActive = computed(() => !!briefProposalResponse.value && ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(briefProposalResponse.value.job.status))
const briefProposalFieldsChanged = computed(() => {
  const submitted = briefProposalSession.value?.submitted
  return !!submitted && JSON.stringify(editableBriefSnapshot()) !== JSON.stringify(submitted)
})
const styleChanged = computed(() => !!state.value?.brief?.currentRevision.workspaceStyleRevision && state.value.brief.currentRevision.workspaceStyleRevision !== state.value.style.revision)
const outdatedOutline = computed(() => !!currentOutline.value && currentOutline.value.briefRevisionId !== state.value?.brief?.currentRevision.id)
const remoteBriefChanged = computed(() => loadedBriefId.value !== (state.value?.brief?.currentRevision.id ?? null))
const remoteOutlineChanged = computed(() => loadedOutlineId.value !== (currentOutline.value?.id ?? null))
const generationBlocked = computed(() => !state.value?.brief || dirty.value || styleChanged.value || remoteBriefChanged.value)
const sourcePreparationActive = computed(() => !!sourceRequest.value && ['INDEXING', 'SEARCHING', 'READY', 'GENERATING'].includes(sourceRequest.value.stage))
const outlineApprovalBlocked = computed(() => generationBlocked.value || outlineDirty.value || remoteOutlineChanged.value || outdatedOutline.value
  || (form.contentMode === 'FACTUAL' && !currentOutline.value?.sourceEvidenceSetId))
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
let sourceTimer: ReturnType<typeof setTimeout> | undefined
let briefProposalTimer: ReturnType<typeof setTimeout> | undefined
let briefProposalPollActive = false
const controller = new AbortController()
let commandKey: string | null = null
const seenJobs = new Map<string, string>()
const sourceRequestStorageKey = `contextflow:source-outline:${props.projectId}`
const sourceCommandStorageKey = `${sourceRequestStorageKey}:command`
const briefProposalStorageKey = `contextflow:brief-proposal:${props.projectId}:${props.userId}`
function storageGet(key: string) { try { return sessionStorage.getItem(key) } catch { return null } }
function storageSet(key: string, value: string) { try { sessionStorage.setItem(key, value) } catch { /* Resume remains available while this page is open. */ } }
function storageRemove(key: string) { try { sessionStorage.removeItem(key) } catch { /* Storage can be disabled by the browser. */ } }
function currentBriefFields(): BriefProposalFields {
  return { topic: form.topic, audience: form.audience, centralMessage: form.centralMessage,
    category: form.category, tone: form.tone, targetLength: Number(form.targetLength), cta: form.cta,
    exclusions: form.exclusions.split('\n').map(line => line.trim()).filter(Boolean), notes: form.notes }
}
function editableBriefSnapshot(): BriefFormSnapshot {
  return { ...currentBriefFields(), contentMode: form.contentMode, exclusions: form.exclusions }
}
function writeBriefProposalSession(value: BriefProposalSession | null) {
  briefProposalSession.value = value
  if (value) storageSet(briefProposalStorageKey, JSON.stringify(value))
  else storageRemove(briefProposalStorageKey)
}
watch(form, () => {
  const session = briefProposalSession.value
  if (!session) return
  session.draft = editableBriefSnapshot()
  storageSet(briefProposalStorageKey, JSON.stringify(session))
}, { deep: true, flush: 'sync' })
function populate() {
  const revision = state.value?.brief?.currentRevision
  if (revision) {
    // Convert the array before touching the reactive form. Its synchronous
    // watcher reads exclusions as text and must never observe the API shape.
    const { exclusions, ...fields } = revision
    Object.assign(form, { ...fields, exclusions: exclusions.join('\n') })
  }
  else Object.assign(form, { tone: state.value?.style.tone ?? '', topic: props.projectTopic })
  // Only editable fields participate in save/dirty state.
  for (const key of Object.keys(form)) if (!['contentMode', 'topic', 'audience', 'centralMessage', 'category', 'tone', 'targetLength', 'cta', 'exclusions', 'notes'].includes(key)) delete (form as unknown as Record<string, unknown>)[key]
  baseline.value = JSON.stringify(form)
  briefExpectedRevision.value = state.value?.brief?.revision ?? 0
  loadedBriefId.value = state.value?.brief?.currentRevision.id ?? null
  populateOutline()
}
function populateOutline() {
  const content = currentOutline.value?.content
  outline.title = content?.title ?? form.topic
  outline.sections = content ? content.sections.map(section => ({ title: section.title, purpose: section.purpose, ...(section.sourcePassageIds ? { sourcePassageIds: [...section.sourcePassageIds] } : {}) })) : []
  outlineBaseline.value = JSON.stringify(outline)
  outlineExpectedRevision.value = state.value?.outline?.revision ?? 0
  loadedOutlineId.value = currentOutline.value?.id ?? null
}
async function request(path: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(payload) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    let proposalCode: string | null = null
    if (path === '/brief/proposals' && response.status === 409) {
      try {
        const body: unknown = await response.clone().json()
        if (body && typeof body === 'object') {
          const record = body as Record<string, unknown>
          const nested = record.message && typeof record.message === 'object' ? record.message as Record<string, unknown> : null
          const code = nested?.code ?? record.code
          if (typeof code === 'string') proposalCode = code
        }
      } catch { /* Fall back to a general conflict message if the server body is not JSON. */ }
      if (proposalCode === 'BRIEF_CHANGED') conflict.value = true
    }
    if (response.status === 409 && path !== '/brief/proposals') conflict.value = true
    if (response.status === 503 && path === '/outline/generate') throw new Error('AI-генерація ще не налаштована. Створіть структуру вручну.')
    if (response.status === 503 && path === '/outline/source-prepare') throw new Error('Генерацію з джерел ще не налаштовано. Збережіть план вручну або зверніться до адміністратора.')
    if (response.status === 503 && path === '/brief/proposals') throw new Error('AI-пропозицію брифу ще не налаштовано. Збережіть бриф вручну або зверніться до адміністратора.')
    if (response.status === 403 && path === '/brief/proposals') throw new Error('Перевірте доступ до проєкту й згоду на зовнішню обробку даних.')
    if (response.status === 400 && path === '/brief/proposals') throw new Error('Додайте хоча б одне включене джерело, перевірте тему й повторіть спробу.')
    if (path === '/brief/proposals' && response.status === 409) {
      const messages: Record<string, string> = {
        NO_FACTUAL_SOURCES: 'Додайте й увімкніть хоча б одне фактичне джерело на сторінці «Джерела».',
        SOURCE_IMPORT_PENDING: 'Дочекайтеся завершення обробки всіх увімкнених джерел, потім повторіть.',
        TOO_MANY_FACTUAL_SOURCES: 'Для пропозиції можна включити не більше 20 джерел. Вимкніть зайві на сторінці «Джерела».',
        BRIEF_CHANGED: 'Бриф змінився. Оновіть дані перед новою пропозицією.',
        INPUT_TOO_LARGE: 'Контекст брифу або стилю завеликий. Скоротіть його й повторіть.',
        STALE_SOURCE: 'Одне з джерел змінилося. Оновіть дані джерел і повторіть.',
      }
      throw new Error(proposalCode ? messages[proposalCode] ?? 'Бриф або джерела змінилися. Перевірте джерела й повторіть.'
        : 'Бриф або джерела змінилися. Переконайтеся, що вибрано від 1 до 20 оброблених джерел.')
    }
    throw new Error(response.status === 409 ? 'Матеріал змінився. Ваш текст збережено у формі. Оновіть дані перед повторною дією.' : response.status === 400 ? 'Перевірте заповнення брифу та джерела проєкту.' : 'Дія тимчасово недоступна. Перевірте з’єднання й повторіть спробу.')
  }
  return response.json()
}
async function load(reset = false): Promise<boolean> {
  try { state.value = await request('/editorial') as State; if (!disposed && reset) { populate(); conflict.value = false; error.value = '' }; return true }
  catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити бриф.'; return false }
  finally { if (!disposed) loading.value = false }
}
async function mutate(path: string, payload: unknown, kind: 'brief' | 'outline' | 'other' = 'other') {
  if (busy.value || props.archived) return
  busy.value = true; error.value = ''; saved.value = ''
  try {
    await request(path, payload)
    if (disposed) return
    await load()
    if (kind === 'brief') { const draft = JSON.parse(JSON.stringify(outline)) as typeof outline; const previousBaseline = outlineBaseline.value; const previousExpectedRevision = outlineExpectedRevision.value; const previousOutlineId = loadedOutlineId.value; const keepOutline = outlineDirty.value; populate(); if (keepOutline) { Object.assign(outline, draft); outlineBaseline.value = previousBaseline; outlineExpectedRevision.value = previousExpectedRevision; loadedOutlineId.value = previousOutlineId } if (briefProposalSession.value?.applied) { writeBriefProposalSession(null); briefProposalResponse.value = null } saved.value = 'Бриф збережено' }
    if (kind === 'outline') { populateOutline(); saved.value = 'Структуру збережено' }
    if (path.includes('/outline/') && kind === 'other') outlineExpectedRevision.value = state.value?.outline?.revision ?? outlineExpectedRevision.value
    conflict.value = false
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти.' }
  finally { if (!disposed) busy.value = false }
}
function saveBrief() { return mutate('/brief', { ...form, targetLength: Number(form.targetLength), exclusions: form.exclusions.split('\n').map(line => line.trim()).filter(Boolean), requiredClaimRevisionIds: [], expectedRevision: briefExpectedRevision.value }, 'brief') }
async function loadBriefProposalConfig() {
  try {
    const result = await request('/brief/proposals/config') as { configured?: boolean }
    briefProposalConfigured.value = result.configured === true
    briefProposalConfigError.value = false
  } catch { briefProposalConfigured.value = null; briefProposalConfigError.value = true }
}
function briefProposalFailureText(category?: string | null) {
  if (category === 'NO_INCLUDED_SOURCES') return 'Увімкніть принаймні одне джерело на сторінці «Джерела» й повторіть.'
  if (category === 'NO_RELEVANT_SOURCE_EVIDENCE') return 'У джерелах не знайшлося достатньої опори для цієї теми. Уточніть тему або виберіть інші джерела.'
  if (category === 'INPUT_TOO_LARGE') return 'Забагато тексту у вибраних джерелах. Скоротіть набір джерел і повторіть.'
  if (category === 'ACCESS_REVOKED') return 'Доступ до проєкту змінився. Оновіть сторінку й перевірте права доступу.'
  if (category === 'CONFIGURATION_ERROR' || category === 'PROVIDER_NOT_CONFIGURED') return 'AI-пропозицію брифу ще не налаштовано. Збережіть бриф вручну або зверніться до адміністратора.'
  return 'Попередні дані залишилися. Перевірте джерела й спробуйте ще раз.'
}
function proposalSourcesLabel(sources: BriefProposalSource[]) {
  const sampled = sources.filter(source => source.sampled).length
  const lastTwo = sources.length % 100
  const last = sources.length % 10
  const noun = lastTwo >= 11 && lastTwo <= 14 ? 'джерел' : last === 1 ? 'джерело' : last >= 2 && last <= 4 ? 'джерела' : 'джерел'
  return `Враховано ${sources.length} ${noun}${sampled ? `, ${sampled} опрацьовано частково` : ''}.`
}
function briefProposalStageLabel(status?: string) {
  if (!status) return briefProposalSubmitting.value ? 'Надсилаємо запит…' : 'Запит очікує підтвердження.'
  return ({ QUEUED: 'Готуємо пропозицію брифу…', RUNNING: 'Готуємо пропозицію брифу…', RETRY_WAIT: 'Повторюємо підготовку пропозиції…',
    SUCCEEDED: 'Пропозиція брифу готова до перегляду.', FAILED: 'Не вдалося підготувати пропозицію брифу.',
    CANCELLED: 'Підготовку пропозиції скасовано.', OUTCOME_UNKNOWN: 'Не вдалося підтвердити результат запиту.' } as Record<string, string>)[status] ?? 'Обробка пропозиції брифу.'
}
function persistBriefProposalResult(result: BriefProposalResponse) {
  briefProposalResponse.value = result
  const session = briefProposalSession.value
  if (session) writeBriefProposalSession(session)
  clearTimeout(briefProposalTimer)
  if (['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(result.job.status)) {
    briefProposalTimer = setTimeout(() => void refreshBriefProposal(), 1500)
  }
}
async function refreshBriefProposal() {
  clearTimeout(briefProposalTimer)
  const session = briefProposalSession.value
  if (disposed || briefProposalApplying.value || !session?.jobId || briefProposalRefreshing.value || briefProposalPollActive) return
  briefProposalPollActive = true
  briefProposalRefreshing.value = true
  try {
    const result = await request(`/brief/proposals/${session.jobId}`) as BriefProposalResponse
    if (!disposed) { briefProposalError.value = ''; persistBriefProposalResult(result) }
  } catch (cause) {
    if (!disposed) {
      briefProposalError.value = cause instanceof Error ? cause.message : 'Не вдалося оновити пропозицію брифу.'
      briefProposalTimer = setTimeout(() => void refreshBriefProposal(), 3500)
    }
  } finally {
    briefProposalRefreshing.value = false
    briefProposalPollActive = false
  }
}
async function postBriefProposal(command: BriefProposalCommand) {
  if (briefProposalSubmitting.value || disposed) return
  briefProposalSubmitting.value = true
  briefProposalError.value = ''
  try {
    const result = await request('/brief/proposals', command) as { job: BriefProposalJob }
    if (disposed) return
    const session = briefProposalSession.value
    if (session) writeBriefProposalSession({ jobId: result.job.id, submitted: session.submitted, draft: session.draft,
      ...(session.applied ? { applied: true } : {}) })
    persistBriefProposalResult({ job: result.job, proposal: null, stale: false, sources: [] })
    await refreshBriefProposal()
  } catch (cause) {
    if (!disposed) briefProposalError.value = cause instanceof Error ? cause.message : 'Не вдалося розпочати підготовку пропозиції.'
    // Keep the original key and body so a retry can safely recover an unknown POST outcome.
  } finally { if (!disposed) briefProposalSubmitting.value = false }
}
async function proposeBrief() {
  if (props.archived || busy.value || briefProposalSubmitting.value || briefProposalActive.value || !valid.value) return
  if (briefProposalConfigured.value !== true) {
    briefProposalError.value = briefProposalConfigured.value === false
      ? 'AI-пропозицію брифу ще не налаштовано. Збережіть бриф вручну або зверніться до адміністратора.'
      : 'Перевіряємо налаштування AI. Спробуйте ще раз за мить.'
    return
  }
  const command: BriefProposalCommand = { commandKey: crypto.randomUUID(), expectedRevision: briefExpectedRevision.value,
    contentMode: form.contentMode, currentBrief: currentBriefFields() }
  const snapshot = editableBriefSnapshot()
  briefProposalResponse.value = null
  briefProposalError.value = ''
  writeBriefProposalSession({ command, submitted: snapshot, draft: snapshot })
  await postBriefProposal(command)
}
async function resumeBriefProposal() {
  const raw = storageGet(briefProposalStorageKey)
  if (!raw) return
  try {
    const session = JSON.parse(raw) as BriefProposalSession
    if (!session || typeof session.submitted?.topic !== 'string' || typeof session.draft?.topic !== 'string'
      || (session.jobId !== undefined && typeof session.jobId !== 'string')) throw new Error('Invalid brief proposal session')
    writeBriefProposalSession(session)
    Object.assign(form, session.draft)
    if (session.jobId) await refreshBriefProposal()
    else if (session.command) await postBriefProposal(session.command)
  } catch {
    storageRemove(briefProposalStorageKey)
    briefProposalSession.value = null
  }
}
async function retryBriefProposalPost() {
  const command = briefProposalSession.value?.command
  if (command) { await postBriefProposal(command); return }
  await refreshBriefProposal()
}
async function retryBriefProposalJob() {
  const session = briefProposalSession.value
  const result = briefProposalResponse.value
  if (!session?.jobId || !result?.job.retryAllowed || busy.value || props.archived) return
  briefProposalSubmitting.value = true
  briefProposalError.value = ''
  try {
    await request(`/jobs/${session.jobId}/retry`, {})
    await refreshBriefProposal()
  } catch (cause) { briefProposalError.value = cause instanceof Error ? cause.message : 'Не вдалося повторити пропозицію.' }
  finally { if (!disposed) briefProposalSubmitting.value = false }
}
async function applyBriefProposal() {
  const session = briefProposalSession.value
  if (!session?.jobId || form.contentMode !== session.submitted.contentMode) {
    briefProposalError.value = 'Режим матеріалу змінився. Створіть нову пропозицію для поточного режиму.'
    return
  }
  if (briefProposalApplying.value) return
  briefProposalApplying.value = true
  try {
    clearTimeout(briefProposalTimer)
    // This GET is the authoritative freshness check. An older poll may still
    // finish later, but it cannot replace the response used for this decision.
    const latest = await request(`/brief/proposals/${session.jobId}`) as BriefProposalResponse
    persistBriefProposalResult(latest)
    const proposal = latest?.proposal
    if (!latest || latest.job.status !== 'SUCCEEDED' || latest.stale) {
      briefProposalError.value = 'Бриф, стиль або джерела змінилися після запиту. Створіть нову пропозицію.'
      return
    }
    if (!proposal || proposal.status !== 'ready' || !proposal.brief) {
      briefProposalError.value = 'Пропозиція потребує додаткових даних. Уточніть тему або додайте джерела.'
      return
    }
    // The proposal API stores exclusions as an array while the editor stores
    // them as newline-separated text. Convert before mutating reactive state:
    // the synchronous draft watcher runs after every property assignment.
    const { exclusions, ...fields } = proposal.brief
    Object.assign(form, { ...fields, exclusions: exclusions.join('\n'), contentMode: session.submitted.contentMode })
    session.applied = true
    session.draft = editableBriefSnapshot()
    writeBriefProposalSession(session)
    briefProposalError.value = ''
    saved.value = ''
  } catch (cause) {
    if (!disposed) briefProposalError.value = cause instanceof Error ? cause.message : 'Не вдалося перевірити пропозицію брифу.'
  } finally { if (!disposed) briefProposalApplying.value = false }
}
function saveOutline() { return mutate('/outline/manual', { expectedRevision: outlineExpectedRevision.value, briefRevisionId: state.value?.brief?.currentRevision.id,
  ...(currentOutline.value?.sourceEvidenceSetId ? { sourceEvidenceSetId: currentOutline.value.sourceEvidenceSetId } : {}), content: { ...JSON.parse(JSON.stringify(outline)), sections: outline.sections.map(section => ({ ...section, claimRevisionIds: [] })) } }, 'outline') }
async function generate() {
  if (form.contentMode === 'FACTUAL') { await prepareSourceOutline(); return }
  commandKey ??= crypto.randomUUID()
  await mutate('/outline/generate', { commandKey })
  if (!error.value) commandKey = null
  await loadJobs()
}
function acceptSourceRequest(value: SourceWritingRequest) {
  sourceRequest.value = value
  sourceRequestError.value = ''
  if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(value.stage)) {
    clearTimeout(sourceTimer)
    if (value.stage === 'SUCCEEDED') storageRemove(sourceCommandStorageKey)
  } else {
    storageSet(sourceRequestStorageKey, value.id)
    clearTimeout(sourceTimer)
    sourceTimer = setTimeout(() => void pollSourceRequest(), 1800)
  }
}
async function postSourcePreparation(key: string) {
  if (sourceSubmitting.value) return
  sourceSubmitting.value = true
  sourceRequestError.value = ''; error.value = ''
  try {
    const result = await request('/outline/source-prepare', { commandKey: key }) as { request: SourceWritingRequest }
    storageRemove(sourceCommandStorageKey)
    storageSet(sourceRequestStorageKey, result.request.id)
    acceptSourceRequest(result.request)
    if (result.request.stage === 'SUCCEEDED') await load()
  } catch (cause) {
    sourceRequestError.value = cause instanceof Error ? cause.message : 'Не вдалося розпочати підготовку джерел.'
  } finally { if (!disposed) sourceSubmitting.value = false }
}
async function prepareSourceOutline() {
  const key = storageGet(sourceCommandStorageKey) ?? crypto.randomUUID()
  storageSet(sourceCommandStorageKey, key)
  await postSourcePreparation(key)
}
async function pollSourceRequest() {
  clearTimeout(sourceTimer)
  const current = sourceRequest.value
  if (disposed || !current || !sourcePreparationActive.value) return
  try {
    const result = await request(`/source-writing/${current.id}`) as { request: SourceWritingRequest }
    acceptSourceRequest(result.request)
    if (result.request.stage === 'SUCCEEDED') {
      await load()
      storageRemove(sourceRequestStorageKey)
    }
  } catch (cause) {
    if (!disposed) {
      sourceRequestError.value = cause instanceof Error ? cause.message : 'Не вдалося оновити підготовку джерел.'
      sourceTimer = setTimeout(() => void pollSourceRequest(), 3500)
    }
  }
}
async function resumeSourceRequest() {
  const id = storageGet(sourceRequestStorageKey)
  if (id) {
    try {
      const result = await request(`/source-writing/${id}`) as { request: SourceWritingRequest }
      acceptSourceRequest(result.request)
      if (result.request.stage === 'SUCCEEDED') { await load(); storageRemove(sourceRequestStorageKey) }
      else if (['FAILED', 'CANCELLED'].includes(result.request.stage)) storageRemove(sourceRequestStorageKey)
      return
    } catch (cause) { sourceRequestError.value = cause instanceof Error ? cause.message : 'Не вдалося відновити підготовку джерел.'; return }
  }
  const pendingKey = storageGet(sourceCommandStorageKey)
  if (pendingKey) await postSourcePreparation(pendingKey)
}
async function cancelSourcePreparation() {
  const current = sourceRequest.value
  if (!current || !sourcePreparationActive.value || busy.value || props.archived) return
  busy.value = true
  sourceRequestError.value = ''
  try {
    const result = await request(`/source-writing/${current.id}/cancel`, {}) as { request: SourceWritingRequest }
    acceptSourceRequest(result.request)
    if (result.request.stage === 'CANCELLED') storageRemove(sourceRequestStorageKey)
  } catch (cause) { sourceRequestError.value = cause instanceof Error ? cause.message : 'Не вдалося скасувати підготовку джерел.' }
  finally { if (!disposed) busy.value = false }
}
async function refreshSourcePreparation() {
  if (sourceRequest.value) { await pollSourceRequest(); return }
  const pendingKey = storageGet(sourceCommandStorageKey)
  if (pendingKey) await postSourcePreparation(pendingKey)
}
function sourceStageLabel(stage: SourceWritingRequest['stage']) {
  return ({ INDEXING: 'Готуємо джерела до пошуку…', SEARCHING: 'Шукаємо в джерелах уривки для плану…',
    READY: 'Джерела підготовлено. Переходимо до плану…', GENERATING: 'Створюємо план на основі знайдених уривків…',
    SUCCEEDED: 'Пропозиція плану готова до перегляду.', FAILED: 'Не вдалося підготувати пропозицію плану.',
    CANCELLED: 'Підготовку скасовано.' } as const)[stage]
}
function sourceFailureText(category: string | null) {
  if (category === 'NO_RELEVANT_SOURCE_EVIDENCE') return 'Серед перевірених уривків немає достатньої опори для цього плану. Уточніть бриф, додайте джерела або створіть план вручну.'
  if (category === 'ACCESS_REVOKED') return 'Доступ до проєкту змінився. Перевірте, чи маєте доступ, і запустіть дію знову.'
  if (category === 'WRITING_FAILED') return 'Не вдалося створити план. Ваші записи й попередні версії залишилися.'
  if (category === 'SEARCH_PACKET_MISSING' || category === 'SEARCH_FAILED') return 'Не вдалося знайти придатні уривки у вибраних джерелах. Перевірте джерела або створіть план вручну.'
  if (category === 'INPUT_TOO_LARGE' || category === 'REQUIRED_EVIDENCE_LIMIT') return 'Поточний контекст завеликий для автоматичного плану. Скоротіть бриф або контекст і повторіть.'
  return 'Попередні записи залишилися. Перевірте джерела або створіть план вручну.'
}
function passageCountLabel(count: number) {
  const lastTwo = count % 100
  const last = count % 10
  const noun = lastTwo >= 11 && lastTwo <= 14 ? 'уривків' : last === 1 ? 'уривок' : last >= 2 && last <= 4 ? 'уривки' : 'уривків'
  return `${count} ${noun}`
}
async function jobAction(job: Job, action: string) { await mutate(`/jobs/${job.id}/${action}`, {}); await loadJobs() }
async function loadJobs() {
  clearTimeout(timer)
  if (disposed || !state.value?.articleSelected) return
  try {
    const result = await request('/jobs') as { jobs: Job[] }
    if (disposed) return
    jobs.value = result.jobs.filter(job => job.operation === 'OUTLINE_GENERATION')
    for (const job of jobs.value) {
      if (job.status === 'SUCCEEDED' && seenJobs.get(job.id) !== 'SUCCEEDED') await load()
      seenJobs.set(job.id, job.status)
    }
    jobError.value = ''
  } catch { if (!disposed) jobError.value = 'Не вдалося оновити стан генерації.' }
  finally { if (!disposed) timer = setTimeout(() => void loadJobs(), activeJob.value ? 2000 : 5000) }
}
function jobLabel(job: Job) { return ({ QUEUED: 'Очікує обробки', RUNNING: 'Створюємо структуру', RETRY_WAIT: 'Очікує повторної спроби', SUCCEEDED: 'Пропозиція готова', FAILED: 'Не вдалося створити структуру', CANCELLED: 'Генерацію скасовано', OUTCOME_UNKNOWN: 'Результат зовнішньої обробки невідомий' } as Record<string, string>)[job.status] ?? 'Обробка' }
function onFocus() {
  if (sourcePreparationActive.value || storageGet(sourceCommandStorageKey)) void refreshSourcePreparation()
  if (briefProposalSession.value?.jobId) void refreshBriefProposal()
  else if (briefProposalSession.value?.command) void retryBriefProposalPost()
}
onMounted(async () => { await Promise.all([load(true), loadBriefProposalConfig()]); await loadJobs(); await resumeSourceRequest(); await resumeBriefProposal(); window.addEventListener('focus', onFocus) })
onBeforeUnmount(() => { disposed = true; controller.abort(); clearTimeout(timer); clearTimeout(sourceTimer); clearTimeout(briefProposalTimer); window.removeEventListener('focus', onFocus) })
</script>

<template>
  <section
    class="brief-workspace author-desk-task"
    :data-workspace-leave-risk="!loading && (dirty || outlineDirty || busy)"
    aria-labelledby="brief-title"
  >
    <header class="brief-heading">
      <div>
        <h1 id="brief-title">
          Бриф
        </h1><p class="brief-lead">
          Опишіть тему самі або попросіть AI запропонувати бриф за джерелами.
        </p>
      </div>
      <div
        v-if="state && !loading"
        class="brief-heading-actions"
      >
        <span role="status">{{ dirty ? 'Є незбережені зміни' : saved || (state.brief ? 'Бриф збережено' : '') }}</span>
        <Button
          type="button"
          variant="outline"
          class="workspace-button"
          :disabled="busy || archived || !valid || briefProposalConfigured !== true || briefProposalSubmitting || briefProposalActive"
          @click="proposeBrief"
        >
          {{ briefProposalSubmitting || briefProposalActive ? 'Готуємо пропозицію…' : 'Запропонувати бриф' }}
        </Button>
        <Button
          type="submit"
          form="brief-form"
          class="workspace-button workspace-button-primary"
          :disabled="busy || archived || !valid || (!!state.brief && !dirty && !styleChanged)"
        >
          {{ busy ? 'Зберігаємо…' : 'Зберегти бриф' }}
        </Button>
      </div>
    </header>
    <p
      v-if="loading"
      role="status"
    >
      Завантажуємо бриф…
    </p>
    <Alert
      v-if="error"
      variant="destructive"
      class="workspace-alert"
      role="alert"
    >
      <AlertTitle>{{ conflict ? 'Є нові зміни' : 'Не вдалося виконати дію' }}</AlertTitle><AlertDescription>{{ error }}</AlertDescription><Button
        v-if="conflict || !state"
        variant="outline"
        class="workspace-button"
        @click="load(true)"
      >
        {{ conflict ? 'Скинути мої зміни й оновити' : 'Спробувати ще раз' }}
      </Button>
    </Alert>
    <template v-if="state && !loading">
      <p
        v-if="briefProposalConfigured === false"
        class="brief-proposal-notice"
        role="status"
      >
        AI-пропозицію брифу ще не підключено в цьому середовищі. Поки що бриф можна заповнити вручну.
      </p>
      <p
        v-else-if="briefProposalConfigError"
        class="brief-proposal-notice"
        role="status"
      >
        Не вдалося перевірити налаштування AI. Оновіть сторінку й спробуйте ще раз.
      </p>
      <section
        v-if="briefProposalResponse || briefProposalSession?.command"
        class="brief-proposal"
        aria-labelledby="brief-proposal-title"
      >
        <div class="brief-section-heading">
          <h2 id="brief-proposal-title">
            Пропозиція брифу
          </h2>
          <Button
            v-if="briefProposalSession?.command && !briefProposalSession.jobId"
            type="button"
            variant="outline"
            class="workspace-button"
            :disabled="briefProposalSubmitting || archived"
            @click="retryBriefProposalPost"
          >
            Перевірити запит
          </Button>
          <Button
            v-else-if="briefProposalResponse?.job.status === 'OUTCOME_UNKNOWN'"
            type="button"
            variant="outline"
            class="workspace-button"
            :disabled="briefProposalRefreshing || archived"
            @click="refreshBriefProposal"
          >
            Перевірити стан
          </Button>
          <Button
            v-else-if="briefProposalResponse?.job.retryAllowed"
            type="button"
            variant="outline"
            class="workspace-button"
            :disabled="briefProposalSubmitting || archived"
            @click="retryBriefProposalJob"
          >
            Повторити спробу
          </Button>
        </div>
        <p
          v-if="briefProposalSession?.jobId"
          class="brief-proposal-status"
          role="status"
          aria-live="polite"
        >
          {{ briefProposalStageLabel(briefProposalResponse?.job.status) }}
        </p>
        <p
          v-if="briefProposalError"
          class="brief-proposal-error"
          role="alert"
        >
          {{ briefProposalError }}
        </p>
        <template v-if="briefProposalResponse?.job.status === 'FAILED'">
          <p class="brief-proposal-error">
            {{ briefProposalFailureText(briefProposalResponse.job.errorCategory) }}
          </p>
        </template>
        <p
          v-if="briefProposalResponse?.stale"
          class="brief-proposal-error"
          role="status"
        >
          Бриф, стиль або джерела змінилися після запиту. Створіть нову пропозицію.
        </p>
        <template v-if="briefProposalResponse?.job.status === 'SUCCEEDED' && briefProposalResponse.proposal">
          <template v-if="briefProposalResponse.proposal.status === 'ready' && briefProposalResponse.proposal.brief">
            <p class="field-hint">
              {{ proposalSourcesLabel(briefProposalResponse.sources) }}
            </p>
            <details
              v-if="briefProposalResponse.sources.length"
              class="brief-proposal-sources"
            >
              <summary>Показати джерела</summary>
              <ul>
                <li
                  v-for="source in briefProposalResponse.sources"
                  :key="source.snapshotId ?? source.label"
                >
                  {{ source.label }}<span v-if="source.sampled"> · опрацьовано частково</span>
                </li>
              </ul>
            </details>
            <dl class="brief-proposal-fields">
              <div><dt>Тема</dt><dd>{{ briefProposalResponse.proposal.brief.topic }}</dd></div>
              <div><dt>Аудиторія</dt><dd>{{ briefProposalResponse.proposal.brief.audience || 'Не визначено' }}</dd></div>
              <div><dt>Головне повідомлення</dt><dd>{{ briefProposalResponse.proposal.brief.centralMessage || 'Не визначено' }}</dd></div>
              <div><dt>Категорія</dt><dd>{{ briefProposalResponse.proposal.brief.category || 'Не визначено' }}</dd></div>
              <div><dt>Тон</dt><dd>{{ briefProposalResponse.proposal.brief.tone || 'Не визначено' }}</dd></div>
              <div><dt>Бажаний обсяг</dt><dd>{{ briefProposalResponse.proposal.brief.targetLength }} слів</dd></div>
              <div><dt>Заклик до дії</dt><dd>{{ briefProposalResponse.proposal.brief.cta || 'Не визначено' }}</dd></div>
              <div><dt>Чого уникати</dt><dd>{{ briefProposalResponse.proposal.brief.exclusions.join(' · ') || 'Не визначено' }}</dd></div>
              <div><dt>Авторські нотатки</dt><dd>{{ briefProposalResponse.proposal.brief.notes || 'Немає' }}</dd></div>
            </dl>
            <ul
              v-if="briefProposalResponse.proposal.assumptions.length"
              class="brief-proposal-assumptions"
              aria-label="Припущення пропозиції"
            >
              <li
                v-for="(assumption, index) in briefProposalResponse.proposal.assumptions"
                :key="index"
              >
                Припущення: {{ assumption }}
              </li>
            </ul>
            <p
              v-if="briefProposalFieldsChanged && !briefProposalResponse.stale && form.contentMode !== briefProposalSession?.submitted.contentMode"
              class="brief-proposal-error"
              role="status"
            >
              Режим матеріалу змінився після запиту. Створіть нову пропозицію для поточного режиму.
            </p>
            <div class="brief-actions">
              <Button
                type="button"
                class="workspace-button workspace-button-primary"
                :disabled="busy || archived || briefProposalApplying || briefProposalResponse.stale || form.contentMode !== briefProposalSession?.submitted.contentMode || remoteBriefChanged || styleChanged"
                @click="applyBriefProposal"
              >
                {{ briefProposalFieldsChanged ? 'Замінити поля пропозицією' : 'Використати пропозицію' }}
              </Button>
              <span>Перегляньте й відредагуйте поля, потім натисніть «Зберегти бриф».</span>
            </div>
          </template>
          <p
            v-else
            class="brief-proposal-error"
            role="status"
          >
            Для цієї теми бракує даних, щоб запропонувати всі поля брифу. Додайте контекст у джерела й спробуйте ще раз.
          </p>
        </template>
      </section>
      <p
        v-if="remoteBriefChanged || remoteOutlineChanged"
        class="brief-review"
        role="status"
      >
        Інший редактор зберіг нову версію. Ваш текст залишається у формі. <Button
          variant="outline"
          class="workspace-button"
          :disabled="busy"
          @click="load(true)"
        >
          Скинути мої зміни й оновити
        </Button>
      </p>
      <p
        v-if="styleChanged"
        class="brief-review"
        role="status"
      >
        Стиль простору змінився. Збережіть нову версію брифу перед роботою зі структурою.
      </p>
      <div class="brief-layout">
        <form
          id="brief-form"
          class="brief-document"
          @submit.prevent="saveBrief"
        >
          <fieldset
            class="brief-fields"
            :disabled="busy || archived"
          >
            <legend class="sr-only">
              Зміст брифу
            </legend>
            <label
              class="brief-field brief-wide"
              for="brief-topic"
            >Тема<Textarea
              id="brief-topic"
              v-model="form.topic"
              rows="2"
              required
              maxlength="500"
              class="workspace-input"
            /></label>
            <label
              class="brief-field brief-wide"
              for="brief-audience"
            >Аудиторія<span
              aria-hidden="true"
              class="brief-optional"
            >Необов’язково</span><Textarea
              id="brief-audience"
              v-model="form.audience"
              rows="2"
              maxlength="2000"
              class="workspace-input"
            /></label>
            <label
              class="brief-field brief-wide"
              for="brief-message"
            >Головне повідомлення<span
              aria-hidden="true"
              class="brief-optional"
            >Необов’язково</span><Textarea
              id="brief-message"
              v-model="form.centralMessage"
              rows="2"
              maxlength="4000"
              class="workspace-input"
            /></label>
            <label
              class="brief-field"
              for="brief-category"
            >Категорія<input
              id="brief-category"
              v-model="form.category"
              maxlength="120"
              class="workspace-input"
            ></label>
            <label
              class="brief-field"
              for="brief-tone"
            >Тон<input
              id="brief-tone"
              v-model="form.tone"
              maxlength="10000"
              class="workspace-input"
            ></label>
            <label
              class="brief-field"
              for="brief-length"
            >Бажаний обсяг, слів<input
              id="brief-length"
              v-model.number="form.targetLength"
              type="number"
              min="50"
              max="20000"
              step="1"
              required
              class="workspace-input"
            ></label>
            <label
              class="brief-field"
              for="brief-cta"
            >Заклик до дії<input
              id="brief-cta"
              v-model="form.cta"
              maxlength="2000"
              class="workspace-input"
            ></label>
            <label
              class="brief-field brief-wide"
              for="brief-exclusions"
            >Чого уникати<Textarea
              id="brief-exclusions"
              v-model="form.exclusions"
              rows="2"
              class="workspace-input"
            /><span class="field-hint">Кожне виключення — з нового рядка.</span></label>
            <label
              class="brief-field brief-wide"
              for="brief-notes"
            >Авторські нотатки<Textarea
              id="brief-notes"
              v-model="form.notes"
              rows="4"
              maxlength="10000"
              class="workspace-input"
            /></label>
          </fieldset>
        </form>
        <aside
          class="brief-context"
          aria-labelledby="brief-context-title"
        >
          <h2 id="brief-context-title">
            Основа матеріалу
          </h2>
          <fieldset
            class="brief-modes"
            :disabled="archived || busy"
          >
            <legend>Як працюємо з темою</legend><label><input
              v-model="form.contentMode"
              type="radio"
              value="FACTUAL"
            > На основі джерел</label><label><input
              v-model="form.contentMode"
              type="radio"
              value="CREATIVE"
            > Творчий матеріал</label>
          </fieldset>
          <p
            v-if="form.contentMode === 'CREATIVE'"
            class="brief-review"
            role="status"
          >
            Авторський матеріал спирається на тему й нотатки; для фактичного режиму система шукає уривки у вибраних джерелах.
          </p>
          <p
            v-else
            class="brief-review"
            role="status"
          >
            Бриф можна зберегти з темою. Для створення плану система шукатиме докази у вибраних джерелах.
          </p>
        </aside>
      </div>
      <details
        v-if="state.brief"
        class="brief-details"
      >
        <summary>Історія та контекст брифу</summary><p>Поточна версія {{ state.brief.currentRevision.number }}. Режим матеріалу й стиль зберігаються разом із кожною версією.</p><div
          v-for="revision in state.brief.history"
          :key="revision.id"
          class="brief-history"
        >
          <h3>Версія {{ revision.number }} · {{ revision.topic }}</h3><p>{{ revision.centralMessage }}</p><p>{{ revision.contentMode === 'CREATIVE' ? 'Творчий матеріал' : 'На основі джерел' }} · {{ revision.tone }}</p><details>
            <summary>Збережений контекст</summary><p v-if="revision.style">
              Стиль простору · Версія {{ revision.style.revision }} · {{ revision.style.tone }}
            </p><pre>{{ JSON.stringify(revision.contextSnapshots, null, 2) }}</pre>
          </details>
        </div>
      </details>
      <section
        v-if="state.articleSelected"
        class="brief-outline"
        aria-labelledby="outline-title"
      >
        <div class="brief-section-heading">
          <div>
            <h2 id="outline-title">
              План статті
            </h2>
          </div><Button
            class="workspace-button"
            variant="outline"
            :disabled="busy || sourceSubmitting || archived || generationBlocked || activeJob || sourcePreparationActive"
            @click="generate"
          >
            {{ sourceSubmitting || sourcePreparationActive ? 'Готуємо план…' : form.contentMode === 'FACTUAL' ? 'Створити план із джерел' : 'Запропонувати структуру' }}
          </Button>
        </div>
        <div
          v-if="sourceRequest"
          class="brief-source-progress"
          :data-stage="sourceRequest.stage.toLowerCase()"
          aria-live="polite"
          aria-atomic="true"
        >
          <p role="status">
            {{ sourceStageLabel(sourceRequest.stage) }}
          </p>
          <p
            v-if="sourceRequest.stage === 'FAILED'"
            class="field-hint"
          >
            {{ sourceFailureText(sourceRequest.errorCategory) }}
          </p>
          <p
            v-if="sourceRequest.stage === 'CANCELLED'"
            class="field-hint"
          >
            Попередні записи та поточний план залишилися без змін.
          </p>
          <div class="brief-source-actions">
            <Button
              v-if="sourcePreparationActive"
              type="button"
              variant="outline"
              class="workspace-button"
              :disabled="busy || archived"
              @click="cancelSourcePreparation"
            >
              Скасувати підготовку
            </Button>
            <Button
              v-if="sourceRequest.stage === 'FAILED' || sourceRequest.stage === 'CANCELLED'"
              type="button"
              variant="outline"
              class="workspace-button"
              :disabled="busy || archived || generationBlocked || activeJob"
              @click="generate"
            >
              Спробувати знову
            </Button>
          </div>
        </div>
        <p
          v-if="sourceRequestError"
          class="brief-source-error"
          role="alert"
        >
          {{ sourceRequestError }}
          <Button
            type="button"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived"
            @click="refreshSourcePreparation"
          >
            Перевірити стан
          </Button>
        </p>
        <p
          v-if="!state.brief || dirty"
          class="field-hint"
        >
          Збережіть бриф, щоб працювати зі структурою.
        </p>
        <p
          v-if="jobError"
          role="alert"
        >
          {{ jobError }} <button
            type="button"
            @click="loadJobs"
          >
            Оновити стан
          </button>
        </p>
        <div
          v-for="job in jobs.filter(item => item.status !== 'SUCCEEDED')"
          :key="job.id"
          class="brief-job"
        >
          <p role="status">
            {{ jobLabel(job) }}
          </p><p
            v-if="['FAILED', 'OUTCOME_UNKNOWN'].includes(job.status)"
            class="field-hint"
          >
            Попередня робота збережена. Можна відредагувати структуру вручну. <template v-if="job.status === 'OUTCOME_UNKNOWN'">
              Пізній результат не буде застосовано. Новий запуск може спричинити повторну оплату.
            </template>
          </p><Button
            v-if="['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived"
            @click="jobAction(job, 'cancel')"
          >
            Скасувати генерацію
          </Button><Button
            v-if="job.retryAllowed"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived"
            @click="jobAction(job, 'retry')"
          >
            Повторити спробу
          </Button>
        </div>
        <details
          v-for="candidate in candidates"
          :key="candidate.id"
          class="brief-candidate"
        >
          <summary>Пропозиція AI · Не застосовано</summary><h3>{{ candidate.content.title }}</h3><p
            v-if="candidate.sourceEvidenceSetId"
            class="field-hint"
          >
            У плані використано {{ passageCountLabel(candidate.content.sections.reduce((total, section) => total + (section.sourcePassageIds?.length ?? 0), 0)) }} із джерел.
          </p><ol>
            <li
              v-for="(section, index) in candidate.content.sections"
              :key="index"
            >
              <strong>{{ section.title }}</strong><p>{{ section.purpose }}</p><p
                v-if="section.sourcePassageIds?.length"
                class="field-hint"
              >
                Джерельних уривків: {{ section.sourcePassageIds.length }}
              </p>
            </li>
          </ol><Button
            class="workspace-button"
            variant="outline"
            :disabled="busy || archived || dirty || outlineDirty || remoteOutlineChanged || remoteBriefChanged"
            @click="mutate(`/outline/${candidate.id}/apply`, { expectedRevision: state.outline?.revision ?? 0 }, 'outline')"
          >
            Застосувати структуру
          </Button><p
            v-if="outlineDirty"
            class="field-hint"
          >
            Спочатку збережіть ручні зміни структури.
          </p>
        </details>
        <h3
          v-if="currentOutline"
          class="outline-reading-title"
        >
          {{ currentOutline.content.title }}
        </h3>
        <ol
          v-if="currentOutline"
          class="outline-reading"
        >
          <li
            v-for="(section, index) in currentOutline.content.sections"
            :key="index"
          >
            <h3>{{ section.title }}</h3>
            <p>{{ section.purpose }}</p><p
              v-if="section.sourcePassageIds?.length"
              class="field-hint"
            >
              Джерельних уривків: {{ section.sourcePassageIds.length }}
            </p>
          </li>
        </ol>
        <details
          v-if="state.brief"
          class="outline-edit"
          :open="!currentOutline || outlineDirty"
        >
          <summary>{{ currentOutline ? 'Редагувати план' : 'Створити план вручну' }}</summary>
          <form
            v-if="state.brief"
            @submit.prevent="saveOutline"
          >
            <fieldset
              class="brief-fields"
              :disabled="busy || archived"
            >
              <legend class="sr-only">
                Редагування структури
              </legend><label
                class="brief-field brief-wide"
                for="outline-heading"
              >Заголовок статті<input
                id="outline-heading"
                v-model="outline.title"
                required
                maxlength="500"
                class="workspace-input"
                data-slot="input"
              ></label><div
                v-for="(section, index) in outline.sections"
                :key="index"
                class="outline-section brief-wide"
              >
                <div class="brief-section-heading">
                  <h3>Розділ {{ index + 1 }}</h3><Button
                    type="button"
                    variant="ghost"
                    class="workspace-button"
                    :aria-label="`Видалити розділ ${index + 1}`"
                    @click="outline.sections.splice(index, 1)"
                  >
                    Видалити
                  </Button>
                </div><label
                  class="brief-field"
                  :for="`outline-title-${index}`"
                >Назва розділу<input
                  :id="`outline-title-${index}`"
                  v-model="section.title"
                  required
                  maxlength="300"
                  class="workspace-input"
                ></label><label
                  class="brief-field"
                  :for="`outline-purpose-${index}`"
                >Про що цей розділ<Textarea
                  :id="`outline-purpose-${index}`"
                  v-model="section.purpose"
                  rows="2"
                  maxlength="2000"
                  required
                  class="workspace-input"
                /></label>
              </div>
            </fieldset><div class="brief-actions">
              <Button
                type="button"
                variant="outline"
                class="workspace-button"
                :disabled="busy || archived || outline.sections.length >= 30"
                @click="outline.sections.push({ title: '', purpose: '' })"
              >
                Додати розділ
              </Button><Button
                type="submit"
                class="workspace-button workspace-button-primary"
                :disabled="busy || archived || dirty || (!outlineDirty && !outdatedOutline) || !outline.title.trim() || !outline.sections.length || outline.sections.some(section => !section.title.trim() || !section.purpose.trim())"
              >
                Зберегти структуру
              </Button>
            </div>
          </form>
        </details>
        <p
          v-if="outdatedOutline"
          class="brief-review"
        >
          Бриф змінився після створення цієї структури. Збережіть нову редакцію структури для поточного брифу.
        </p><div
          v-if="currentOutline"
          class="brief-actions"
        >
          <span role="status">{{ outlineDirty ? 'Є незбережені зміни структури' : currentOutline.status === 'APPROVED' ? 'Структуру схвалено' : currentOutline.status === 'WITHDRAWN' ? 'Схвалення відкликано' : 'Структура потребує перегляду' }}</span><Button
            v-if="currentOutline.status === 'PROPOSED'"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived || dirty || outlineApprovalBlocked"
            @click="mutate(`/outline/${currentOutline.id}/approve`, { expectedRevision: state.outline?.revision ?? 0 })"
          >
            Схвалити структуру
          </Button>
        </div>
        <details
          v-if="state.outline?.revisions.length"
          class="brief-details"
        >
          <summary>Історія структури</summary><article
            v-for="revision in state.outline.revisions"
            :key="revision.id"
            class="brief-history"
          >
            <h3>Версія {{ revision.number }} · {{ revision.content.title }}</h3><p>{{ revision.origin === 'AI' ? 'Пропозиція AI' : 'Ручна редакція' }} · {{ revision.status === 'APPROVED' ? 'Схвалено' : revision.status === 'WITHDRAWN' ? 'Схвалення відкликано' : 'Потребує перегляду' }}</p><ol>
              <li
                v-for="(section, index) in revision.content.sections"
                :key="index"
              >
                {{ section.title }} — {{ section.purpose }}
              </li>
            </ol>
          </article>
        </details>
      </section>
    </template>
  </section>
</template>

<style scoped>
.brief-workspace { margin-bottom: 40px; color: var(--ink); }
.brief-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 64px; align-items: start; }
.brief-context { min-width: 0; border-top: 1px solid var(--rule); padding-top: 18px; }
.brief-context h2 { font-size: 23px; margin: 0 0 24px; }
.brief-heading { display: flex; align-items: start; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
.brief-heading-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 12px; }
.brief-heading-actions span { color: var(--muted); font-size: 12px; }
.brief-heading h1 { font-family: var(--serif); font-size: 39px; line-height: 1.2; font-weight: 550; letter-spacing: -.025em; margin: 0; }
.brief-lead { font-size: 15px; line-height: 1.65; color: var(--muted); max-width: 650px; margin: 10px 0 0; }
.brief-document { min-width: 0; }
.brief-proposal { margin: 8px 0 32px; padding: 18px 0 24px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.brief-proposal h2 { margin: 0; }
.brief-proposal-status { margin: 10px 0; font-size: 14px; line-height: 1.55; }
.brief-proposal-error { margin: 12px 0; color: var(--review, #93602c); line-height: 1.55; }
.brief-proposal-notice { margin: 0 0 24px; color: var(--muted); font-size: 14px; line-height: 1.55; }
.brief-proposal-sources { margin: 10px 0 18px; font-size: 13px; }
.brief-proposal-sources ul { margin: 0; padding: 0 0 0 20px; color: var(--muted); }
.brief-proposal-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 28px; margin: 20px 0; }
.brief-proposal-fields div { min-width: 0; }
.brief-proposal-fields dt { margin-bottom: 4px; color: var(--muted); font-size: 12px; }
.brief-proposal-fields dd { margin: 0; line-height: 1.55; overflow-wrap: anywhere; }
.brief-proposal-assumptions { margin: 18px 0; padding: 12px 0 0 20px; border-top: 1px solid var(--rule); color: var(--muted); line-height: 1.55; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.brief-modes { display: grid; gap: 14px; }
legend { font-weight: 500; font-size: 13px; margin-bottom: 12px; }
.brief-modes label { display: flex; align-items: flex-start; gap: 10px; line-height: 1.5; }
input[type='checkbox'], input[type='radio'] { margin-top: 4px; accent-color: var(--copper); flex: 0 0 auto; }
.brief-review, .brief-evidence { line-height: 1.55; padding: 12px 0; font-size: 14px; }
.brief-review { color: var(--review, #93602c); }
.brief-evidence { color: var(--evidence, #2c6660); }
.brief-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px 24px; margin-top: 0; }
.brief-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-weight: 400; font-size: 13px; }
.brief-optional { color: var(--muted); font-size: 12px; }
.brief-wide { grid-column: 1 / -1; }
.brief-field input, .brief-field textarea { min-height: 44px; width: 100%; padding: 10px 0; border: 0; border-bottom: 1px solid var(--field-rule, #bec1c4); border-radius: 0; background: var(--document); color: var(--ink); font-family: var(--serif); font-size: 20px; font-weight: 400; box-shadow: none; line-height: 1.55; }
.brief-field input:hover { border-color: var(--ink); }
.brief-field textarea { resize: vertical; }
.brief-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 24px; }
.brief-actions span { font-size: 13px; color: var(--muted); }
.brief-details { padding: 20px 0; border-bottom: 1px solid var(--rule); font-size: 14px; line-height: 1.6; }
summary { cursor: pointer; font-weight: 500; padding: 12px 0; min-height: 44px; }
.brief-history { padding: 12px 0; border-top: 1px solid var(--rule); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.brief-outline { margin-top: 40px; border-top: 1px solid var(--rule); padding-top: 24px; }
.outline-reading { max-width: 78ch; padding-left: 24px; margin: 24px 0; }
.outline-reading-title { margin: 24px 0 0; font-size: 25px; font-weight: 550; }
.outline-reading li { padding: 4px 0 18px 8px; }
.outline-reading h3 { margin: 0 0 6px; font-size: 21px; }
.outline-reading p { margin: 0; line-height: 1.6; color: var(--muted); }
.outline-edit { border-top: 1px solid var(--rule); }
.outline-edit > summary { margin-bottom: 12px; }
.brief-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2 { font-family: var(--serif); font-size: 28px; font-weight: 600; margin: 8px 0; }
h3 { font-family: var(--serif); font-size: 21px; font-weight: 600; }
.outline-section { padding: 16px 0; border-top: 1px solid var(--rule); display: grid; gap: 16px; }
.brief-candidate, .brief-job { margin: 20px 0; padding: 16px 0; border-top: 1px solid var(--rule); }
.brief-candidate summary { color: var(--proposal, #725078); }
.brief-source-progress { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: 10px 20px; margin: 16px 0; padding: 12px 0; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
.brief-source-progress p { margin: 0; line-height: 1.55; }
.brief-source-progress > p:first-child { font-size: 14px; }
.brief-source-progress .field-hint { flex: 1 1 100%; color: var(--muted); }
.brief-source-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.brief-source-error { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; color: var(--review, #93602c); }
:where(input, textarea, summary, button):focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
@media (max-width: 900px) { .brief-layout { grid-template-columns: minmax(0, 1fr) 240px; gap: 32px; } }
@media (max-width: 760px) { .brief-heading { flex-direction: column; } .brief-heading-actions { justify-content: flex-start; } .brief-layout { grid-template-columns: minmax(0, 1fr); gap: 32px; } .brief-field input, .brief-field textarea { font-size: 18px; } .brief-fields, .brief-proposal-fields { grid-template-columns: minmax(0, 1fr); } .brief-section-heading { align-items: flex-start; flex-direction: column; } .brief-heading h1 { font-size: 32px; } }
</style>
