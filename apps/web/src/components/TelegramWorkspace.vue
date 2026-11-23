<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { sourceWritingFailure, type SourceWritingStatus } from '@/source-writing-feedback'
import SourceMarkdown from './SourceMarkdown.vue'
import SourceWritingStarter from './SourceWritingStarter.vue'

type InputMode = 'DIRECT' | 'ARTICLE_DERIVED'
type ContentMode = 'FACTUAL' | 'CREATIVE'
type ChannelFormat = 'TELEGRAM_POST' | 'LINKEDIN_TEXT' | 'LINKEDIN_COVER' | 'INSTAGRAM_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES'
interface Mapping { startOffset: number; endOffset: number; quote: string; claimRevisionId: string; evidenceId: string; field?: 'text' | 'cover' }
interface SourceMapping { startOffset: number; endOffset: number; quote: string; passageId: string; packetId: string; field?: 'text' | 'cover' }
interface SourcePassage { passageId: string; packetId: string; snapshotId: string; quote: string; materialId: string; materialTitle: string; startOffset: number; endOffset: number }
interface Content { text: string; mappings: Mapping[]; sourceMappings?: SourceMapping[]; cover?: { text: string; instruction: string } }
interface Inputs { inputMode: InputMode; contentMode: ContentMode; includeLink: boolean; briefRevisionId: string; sourceEvidenceSetId?: string | null; sourceArticleVersionId: string | null; workspaceId: string; workspaceStyleRevision: number }
interface Draft extends Inputs { content: Content; baseRevisionId: string | null }
interface Revision extends Inputs { id: string; number: number; content: Content; hasUnmapped: boolean; status: 'PROPOSED' | 'APPROVED' | 'WITHDRAWN'; origin: string; sourceAdaptationRevision?: number; reviewCounter: number; approvedAt: string | null; approvedBy: string | null; withdrawnAt: string | null; withdrawalReason: string | null; reviewedBriefRevisionId: string | null; reviewedSourceArticleVersionId: string | null; reviewedWorkspaceStyleRevision: number | null; reviewedBy: string | null; reviewedAt: string | null; acknowledgedUnmapped: boolean; staleReasons: string[]; blockingReasons: string[] }
interface Job { id: string; status: string; operation: string; format?: ChannelFormat; retryAllowed: boolean; errorCategory?: string | null; safeMessage?: string | null }
interface LanguageSuggestion { id: string; sourceRevisionId: string; locator: { start: number; end: number }; originalText: string; replacementText: string; finding: string; status: 'OPEN' | 'ACCEPTED' | 'REJECTED'; stale: boolean }
interface RecoveredDraft { content: Content; inputMode: InputMode; contentMode: ContentMode; includeLink: boolean; expectedRevision: number }
interface State { adaptation: { id: string; revision: number; draft: Draft | null; currentApprovedRevisionId: string | null; revisions: Revision[] } | null; formatSelected?: boolean; telegramSelected?: boolean; brief: { id: string; revision: number; currentRevision: { id: string; contentMode: ContentMode } | null; history: unknown[] } | null; style: { revision: number }; approvedArticle: { id: string; number: number; sourceEvidenceSetId?: string | null; contentMode: ContentMode; title?: string; approvedAt?: string; inspection?: { eligible?: boolean; staleReasons?: string[]; blockingReasons: string[] } } | null; eligibleSourcePassages?: SourcePassage[]; staleReasons: string[]; mappingIssues: { locator: string; reason: string }[]; hasUnmapped: boolean; blockingReasons: string[] }
const props = withDefaults(defineProps<{ projectId: string; projectTopic: string; csrfToken: string; userId: string; formats?: ChannelFormat[]; initialFormat?: ChannelFormat; archived?: boolean }>(), { formats: () => ['TELEGRAM_POST'], initialFormat: 'TELEGRAM_POST' })
const emit = defineEmits<{ 'session-expired': []; 'format-change': [format: ChannelFormat]; 'caption-generated': []; 'review-article': [] }>()
const base = computed(() => `/api/v1/projects/${encodeURIComponent(props.projectId)}/telegram?format=${encodeURIComponent(format.value)}`)
const projectBase = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
const recoveryKey = computed(() => `cf:channel:${props.userId}:${props.projectId}:${format.value}`)
const state = ref<State | null>(null)
const text = ref('')
const coverText = ref('')
const coverInstruction = ref('')
const format = ref<ChannelFormat>(props.initialFormat)
const inputMode = ref<InputMode>('DIRECT')
const contentMode = ref<ContentMode>('CREATIVE')
const includeLink = ref(false)
const expectedRevision = ref(0)
const baseline = ref('')
const saving = ref(false)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const savedVersionNumber = ref<number | null>(null)
const checkpointing = ref(false)
const conflict = ref(false)
const recovered = ref<RecoveredDraft | null>(null)
const historyOpen = ref(false)
const editor = ref<HTMLTextAreaElement | null>(null)
const coverEditor = ref<HTMLTextAreaElement | null>(null)
const selection = ref<{ start: number; end: number } | null>(null)
// On an empty editor these options are inputs for generation, and autosaving
// them would move the adaptation revision while its first proposal is running.
const dirty = computed(() => !!(state.value?.adaptation?.draft || text.value || coverText.value || coverInstruction.value)
  && baseline.value !== serialize())
const readonly = computed(() => props.archived || !(state.value?.formatSelected ?? (format.value === 'TELEGRAM_POST' && state.value?.telegramSelected)))
const isCover = computed(() => format.value === 'LINKEDIN_COVER' || format.value === 'INSTAGRAM_COVER')
const textLimit = computed(() => format.value === 'TELEGRAM_POST' ? 4096 : 10000)
const formatLabel = computed(() => ({ TELEGRAM_POST: 'Допис у Telegram', LINKEDIN_TEXT: 'Публікація у LinkedIn', LINKEDIN_COVER: 'Обкладинка LinkedIn', INSTAGRAM_COVER: 'Обкладинка Instagram', LINKEDIN_CAROUSEL: 'Карусель LinkedIn', INSTAGRAM_CAROUSEL: 'Карусель Instagram', INSTAGRAM_STORIES: 'Історії Instagram' })[format.value])
const selectedArticle = computed(() => state.value?.approvedArticle)
const proposalOpen = ref(false)
let requestedProposalId: string | null = null
const articleSourceNeedsReview = computed(() => inputMode.value === 'ARTICLE_DERIVED' && !!selectedArticle.value && (selectedArticle.value.inspection?.eligible !== true || !!selectedArticle.value.inspection?.staleReasons?.length))
const activeApproval = computed(() => state.value?.adaptation?.revisions.find(row => row.id === state.value?.adaptation?.currentApprovedRevisionId) ?? null)
const latestProposal = computed(() => {
  const adaptation = state.value?.adaptation
  const revision = adaptation?.revisions.find(row => row.origin === 'AI')
  return revision?.status === 'PROPOSED' && revision.id !== adaptation?.draft?.baseRevisionId ? revision : null
})
function proposalIssue(revision: Revision) {
  if (revision.staleReasons.length) return 'Вхідні дані змінилися. Запропонуйте новий текст, щоб використати актуальні джерела.'
  if (revision.sourceAdaptationRevision !== undefined && revision.sourceAdaptationRevision !== state.value?.adaptation?.revision) {
    return 'Чернетка змінилася після запуску. Можете скопіювати потрібні фрагменти або запропонувати текст знову.'
  }
  return ''
}
const hasScript = computed(() => ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'].includes(format.value))
const localMappingIssues = computed(() => mappings.value.filter(item => fieldText(item.field).slice(item.startOffset, item.endOffset) !== item.quote))
const mappings = ref<Mapping[]>([])
const sourceMappings = ref<SourceMapping[]>([])
const sourceRequest = ref<SourceWritingStatus | null>(null)
const sourceResultPending = ref(false)
const sourceRecoveryKey = computed(() => `${recoveryKey.value}:source-request`)
const sourceActive = computed(() => !!sourceRequest.value && !['SUCCEEDED','FAILED','CANCELLED'].includes(sourceRequest.value.stage))
const selectedSource = ref<SourcePassage | null>(null)
const sourceContext = ref<string | null>(null)
const sourceLoading = ref(false)
const sourceError = ref('')
const jobs = ref<Job[]>([])
const jobMessage = ref('')
const languageSuggestions = ref<LanguageSuggestion[]>([])
const selectedLanguageIds = ref<string[]>([])
const languageMessage = ref('')
const languageBusy = ref(false)
const saveStatus = computed(() => saving.value ? 'Зберігаємо…' : conflict.value ? 'Потрібно узгодити зміни' : error.value && dirty.value ? 'Не збережено' : dirty.value ? 'Є незбережені зміни' : 'Збережено')
let timer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let hydration = false
let sessionEnded = false
let inFlight: Promise<boolean> | null = null
const commandKeys = new Map<string, string>()
let formatEpoch = 0
let polling = false
let loadedCreativeResultId: string | undefined
let controller = new AbortController()
const activeJob = computed(() => sourceActive.value || sourceResultPending.value || jobs.value.some(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)))

function content(): Content { return { text: text.value, mappings: [...mappings.value].sort((a, b) => a.startOffset - b.startOffset), ...(sourceMappings.value.length ? { sourceMappings: [...sourceMappings.value] } : {}), ...(isCover.value ? { cover: { text: coverText.value, instruction: coverInstruction.value } } : {}) } }
function fieldText(field?: 'text' | 'cover') { return field === 'cover' ? coverText.value : text.value }
function serialize() { return JSON.stringify({ content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value }) }
function retain() { if (sessionEnded || !props.userId || hydration || !dirty.value) return; try { sessionStorage.setItem(recoveryKey.value, JSON.stringify({ content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value, expectedRevision: expectedRevision.value })) } catch { /* Live text remains available if session storage is full. */ } }
function changed() { if (hydration || disposed) return; savedVersionNumber.value = null; retain(); clearTimeout(timer); if (!conflict.value && !recovered.value) timer = setTimeout(() => void save(), 700) }
function populate(draft?: Draft | null) {
  savedVersionNumber.value = null
  hydration = true
  text.value = draft?.content.text ?? ''
  coverText.value = draft?.content.cover?.text ?? ''
  coverInstruction.value = draft?.content.cover?.instruction ?? ''
  mappings.value = draft?.content.mappings ?? []; sourceMappings.value = draft?.content.sourceMappings ?? []
  inputMode.value = draft?.inputMode ?? 'DIRECT'
  contentMode.value = draft?.contentMode ?? state.value?.brief?.currentRevision?.contentMode ?? 'CREATIVE'
  includeLink.value = draft?.includeLink ?? false
  expectedRevision.value = state.value?.adaptation?.revision ?? 0
  baseline.value = serialize()
  hydration = false
}
async function request(path = '', body?: unknown, projectScope = false) {
  const requestFormat = format.value, requestEpoch = formatEpoch
  const url = path ? `${projectScope ? projectBase : base.value.split('?')[0]}${path}` : base.value
  const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify({ format: format.value, ...body }) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    if (response.status === 409 && requestEpoch === formatEpoch && requestFormat === format.value) conflict.value = true
    throw new Error(response.status === 409 ? 'Матеріал або редакційні залежності змінилися. Ваш текст збережено в цьому вікні.' : response.status === 503 ? 'AI-генерація тимчасово недоступна. Ви можете продовжувати редагування.' : response.status === 400 ? 'Перевірте текст і прив’язку до джерел.' : 'Не вдалося виконати дію. Ваш текст залишився в редакторі; повторіть спробу.')
  }
  return response.json()
}
async function load(reset = false) {
  const requestedFormat = format.value, requestedEpoch = formatEpoch
  const previousState = state.value
  const next = await request() as State
  if (requestedEpoch !== formatEpoch || requestedFormat !== format.value || disposed || (!reset && state.value !== previousState)) return false
  state.value = next
  if (reset) populate(state.value.adaptation?.draft)
  return true
}
async function save(): Promise<boolean> {
  clearTimeout(timer)
  if (inFlight) { const ok = await inFlight; return ok && dirty.value ? save() : ok }
  if (!dirty.value) return true
  if (readonly.value || conflict.value || recovered.value) return false
  savedVersionNumber.value = null
  const saveFormat = format.value, saveEpoch = formatEpoch, saveRecoveryKey = recoveryKey.value
  const submitted = serialize(), submittedContent = content(), submittedInputMode = inputMode.value, submittedContentMode = contentMode.value, submittedIncludeLink = includeLink.value, submittedExpectedRevision = expectedRevision.value
  saving.value = true; error.value = ''
  inFlight = (async () => {
    try {
      const result = await request('/draft', { expectedRevision: submittedExpectedRevision, content: submittedContent, inputMode: submittedInputMode, contentMode: submittedContentMode, includeLink: submittedIncludeLink }) as State
      if (disposed || saveEpoch !== formatEpoch || saveFormat !== format.value) {
        const stored = sessionStorage.getItem(saveRecoveryKey)
        if (stored) {
          try {
            const recoveredDraft = JSON.parse(stored) as RecoveredDraft
            if (JSON.stringify({ content: recoveredDraft.content, inputMode: recoveredDraft.inputMode, contentMode: recoveredDraft.contentMode, includeLink: recoveredDraft.includeLink }) === submitted) sessionStorage.removeItem(saveRecoveryKey)
          } catch { /* Keep an unreadable recovery record for manual recovery. */ }
        }
        return false
      }
      state.value = result
      expectedRevision.value = state.value.adaptation?.revision ?? expectedRevision.value
      baseline.value = submitted
      if (!dirty.value) sessionStorage.removeItem(recoveryKey.value); else retain()
      return true
    } catch (cause) {
      if (!disposed && (saveEpoch !== formatEpoch || saveFormat !== format.value)) {
        try { sessionStorage.setItem(saveRecoveryKey, JSON.stringify({ content: submittedContent, inputMode: submittedInputMode, contentMode: submittedContentMode, includeLink: submittedIncludeLink, expectedRevision: submittedExpectedRevision })) } catch { /* The old editor contents were already submitted; browser storage may be full. */ }
      } else if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти.'
      return false
    }
    finally { saving.value = false; inFlight = null }
  })()
  const ok = await inFlight
  return ok && dirty.value && !disposed ? save() : ok
}
async function command(path: string, extra: Record<string, unknown> = {}, replace = false, approve = false) {
  const commandFormat = format.value, commandEpoch = formatEpoch
  if (busy.value || readonly.value || !await save() || busy.value || disposed || commandEpoch !== formatEpoch || commandFormat !== format.value) return
  busy.value = true; error.value = ''
  if (path === '/checkpoint') savedVersionNumber.value = null
  try {
    const result = await request(path, { expectedRevision: expectedRevision.value, ...extra }) as State
    if (commandEpoch !== formatEpoch || commandFormat !== format.value) return
    state.value = result; expectedRevision.value = state.value.adaptation?.revision ?? expectedRevision.value
    if (replace) populate(state.value.adaptation?.draft)
    if (path === '/checkpoint' && !replace) {
      const baseRevisionId = result.adaptation?.draft?.baseRevisionId
      const version = result.adaptation?.revisions.find(row => row.id === baseRevisionId)
      savedVersionNumber.value = version?.number ?? null
      if (approve && version?.status === 'PROPOSED' && !dirty.value) {
        const next = await request(`/${version.id}/approve`, { expectedRevision: expectedRevision.value, expectedReviewCounter: version.reviewCounter }) as State
        if (disposed || commandEpoch !== formatEpoch) return
        state.value = next
        expectedRevision.value = next.adaptation?.revision ?? expectedRevision.value
        savedVersionNumber.value = null
        emit('caption-generated')
      }
    }
    if (/\/(?:approve|withdraw|rereview)$/u.test(path)) emit('caption-generated')
  }
  catch (cause) { if (commandEpoch === formatEpoch && commandFormat === format.value) error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { busy.value = false }
}
async function checkpoint(approve = false) {
  checkpointing.value = true
  try { await command('/checkpoint', {}, false, approve) }
  finally { checkpointing.value = false }
}
async function refreshInputs() {
  if (!await save()) return
  await command('/draft', { content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value, refreshInputs: true }, true)
}
async function generateFromSources() {
  if (dirty.value && state.value?.adaptation?.draft && !await save()) return
  retain(); busy.value = true; error.value = ''
  const generationFormat = format.value,generationEpoch = formatEpoch
  const key = `source:${generationFormat}:${expectedRevision.value}:${inputMode.value}:${includeLink.value}`
  const commandKey = commandKeys.get(key) ?? crypto.randomUUID(); commandKeys.set(key,commandKey)
  try {
    const result = await request('/source-prepare',{ commandKey,expectedRevision: expectedRevision.value,inputMode: inputMode.value,includeLink: includeLink.value }) as { request: SourceWritingStatus }
    if (generationEpoch !== formatEpoch) return
    requestedProposalId = result.request.id
    acceptSourceStatus(result.request)
    commandKeys.delete(key)
    void pollJobs()
  } catch (cause) { if (generationEpoch === formatEpoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося підготувати текст із джерел.' }
  finally { busy.value = false }
}
async function cancelSourceRequest() {
  if (!sourceRequest.value || busy.value) return
  const cancelEpoch = formatEpoch
  busy.value = true
  try {
    const response = await fetch(`${projectBase}/source-writing/${sourceRequest.value.id}/cancel`,{ method: 'POST',credentials: 'same-origin',signal: controller.signal,
      headers: { 'Content-Type': 'application/json','X-CSRF-Token': props.csrfToken },body: '{}' })
    if (!response.ok) throw new Error('Не вдалося скасувати підготовку.')
    const result = await response.json() as { request: SourceWritingStatus }
    if (cancelEpoch === formatEpoch) acceptSourceStatus(result.request)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося скасувати підготовку.' }
  finally { busy.value = false }
}
function acceptSourceStatus(status: SourceWritingStatus) {
  sourceRequest.value = status
  sourceResultPending.value = status.stage === 'SUCCEEDED'
  jobMessage.value = status.stage === 'CANCELLED' ? 'Підготовку скасовано. Ваш текст збережено.' : ''
  rememberSourceRequest()
}
function rememberSourceRequest() {
  try { if (sourceRequest.value && (sourceActive.value || sourceResultPending.value || sourceRequest.value.sourceStarter)) sessionStorage.setItem(sourceRecoveryKey.value,sourceRequest.value.id); else sessionStorage.removeItem(sourceRecoveryKey.value) }
  catch { /* The durable request remains on the server when browser storage is unavailable. */ }
}
function restoreSourceRequest() {
  try {
    const id = sessionStorage.getItem(sourceRecoveryKey.value)
    if (id && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(id)) sourceRequest.value = { id,stage: 'INDEXING',errorCategory: null }
  } catch { /* Draft recovery and ordinary editing remain available. */ }
}
function linkSourcePassage(passage: SourcePassage) {
  const element = activeMappingField.value === 'cover' ? coverEditor.value : editor.value
  const range = selection.value
  if (!range || !element || range.end <= range.start) { error.value = 'Спочатку виділіть речення в тексті.'; return }
  sourceMappings.value = [...sourceMappings.value.filter(row => (row.field ?? 'text') !== activeMappingField.value || row.endOffset <= range.start || row.startOffset >= range.end),
    { startOffset: range.start,endOffset: range.end,quote: passage.quote,passageId: passage.passageId,packetId: passage.packetId,...(activeMappingField.value === 'cover' ? { field: 'cover' as const } : {}) }]
  mappings.value = mappings.value.filter(row => (row.field ?? 'text') !== activeMappingField.value || row.endOffset <= range.start || row.startOffset >= range.end)
  selectedSource.value = passage; changed()
}
async function openSourcePassage(passage: SourcePassage) {
  selectedSource.value = passage; sourceContext.value = null; sourceError.value = ''; sourceLoading.value = true
  try {
    const result = await request(`/materials/${encodeURIComponent(passage.materialId)}/snapshots/${encodeURIComponent(passage.snapshotId)}`,undefined,true) as { snapshot?: { normalizedText?: string } }
    if (selectedSource.value !== passage) return
    const snapshotText = result.snapshot?.normalizedText
    if (typeof snapshotText !== 'string') throw new Error('Не вдалося прочитати збережений знімок джерела.')
    const start = passage.startOffset
    const end = passage.endOffset
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
      || end - start !== passage.quote.length || snapshotText.slice(start, end) !== passage.quote) {
      throw new Error('Уривок не збігається зі збереженим джерелом. Посилання залишилося без змін.')
    }
    sourceContext.value = snapshotText
  } catch (cause) {
    if (selectedSource.value === passage) sourceError.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити джерело.'
  } finally { if (selectedSource.value === passage) sourceLoading.value = false }
}
function inspectMappedSource(mapping: SourceMapping) {
  const passage = state.value?.eligibleSourcePassages?.find(row => row.passageId === mapping.passageId && row.packetId === mapping.packetId)
  if (passage) void openSourcePassage(passage)
  else sourceError.value = 'Уривок недоступний у поточному наборі джерел.'
}
function retrySourcePassage() { if (selectedSource.value) void openSourcePassage(selectedSource.value) }
function closeSourcePassage() { selectedSource.value = null; sourceContext.value = null; sourceError.value = '' }
async function generate() {
  if (busy.value || readonly.value) return
  if (contentMode.value === 'FACTUAL') { await generateFromSources(); return }
  if (!await save()) return
  const payload = { expectedRevision: expectedRevision.value, format: format.value, inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value }
  const identity = JSON.stringify(payload)
  const commandKey = commandKeys.get(identity) ?? crypto.randomUUID()
  commandKeys.set(identity, commandKey); busy.value = true; error.value = ''
  const generationFormat = format.value, generationEpoch = formatEpoch
  try {
    const result = await request('/generate', { ...payload, commandKey }) as { job: Job }
    commandKeys.delete(identity)
    if (generationEpoch !== formatEpoch || generationFormat !== format.value) return
    jobs.value = [result.job, ...jobs.value.filter(job => job.id !== result.job.id)]
    requestedProposalId = result.job.id
    jobMessage.value = 'Створюємо пропозицію. Чернетка залишиться доступною для редагування.'
    void pollJobs()
  } catch (cause) { if (generationEpoch === formatEpoch && generationFormat === format.value) error.value = cause instanceof Error ? cause.message : 'Не вдалося створити пропозицію.' }
  finally { busy.value = false }
}
async function pollJobs() {
  if (disposed || polling) return
  clearTimeout(pollTimer)
  polling = true
  const requestedEpoch = formatEpoch
  const isCurrent = () => !disposed && requestedEpoch === formatEpoch
  try {
    if (sourceActive.value && sourceRequest.value) {
      const currentRequest = sourceRequest.value
      const result = await fetch(`${projectBase}/source-writing/${currentRequest.id}`,{ credentials: 'same-origin',signal: controller.signal })
      if (result.status === 401) { emit('session-expired'); return }
      const status = result.ok ? (await result.json() as { request: SourceWritingStatus }).request : null
      if (!isCurrent()) return
      if (sourceRequest.value === currentRequest && status) acceptSourceStatus(status)
      else if (sourceRequest.value === currentRequest && result.status === 404) { sourceRequest.value = null; rememberSourceRequest() }
    }
    if (sourceResultPending.value && await load()) {
      if (sourceRequest.value?.id === requestedProposalId) { proposalOpen.value = true; requestedProposalId = null }
      sourceResultPending.value = false
      rememberSourceRequest()
      emit('caption-generated')
    }
    if (!isCurrent()) return
    const response = await fetch(`${projectBase}/jobs`, { credentials: 'same-origin', signal: controller.signal })
    if (response.status === 401) { emit('session-expired'); return }
    if (response.ok) {
      const result = await response.json() as { jobs: Job[] }
      if (!isCurrent()) return
      jobs.value = result.jobs.filter(job => job.operation === 'TELEGRAM_GENERATION' && (job.format === format.value || (!job.format && format.value === 'TELEGRAM_POST')))
      const latest = jobs.value[0]
      if (latest?.status === 'SUCCEEDED' && latest.id !== loadedCreativeResultId && await load()) {
        if (latest.id === requestedProposalId) { proposalOpen.value = true; requestedProposalId = null }
        loadedCreativeResultId = latest.id
        if (!sourceRequest.value) jobMessage.value = ''
        emit('caption-generated')
      } else if (latest?.status === 'RETRY_WAIT' && latest.errorCategory === 'WRITING_DRAFT_INVALID' && !sourceRequest.value) {
        jobMessage.value = 'Перший варіант не пройшов перевірку. Готуємо нову пропозицію…'
      } else if (latest && ['FAILED', 'CANCELLED'].includes(latest.status) && !sourceRequest.value) {
        jobMessage.value = latest.safeMessage || (latest.status === 'CANCELLED' ? 'Генерацію скасовано. Ваш текст збережено.' : sourceWritingFailure(latest.errorCategory ?? null))
      }
    }
  } catch { /* Keep pending results eligible for the next status poll. */ }
  finally {
    polling = false
    if (!disposed) pollTimer = setTimeout(() => void pollJobs(), !isCurrent() || sourceResultPending.value || activeJob.value ? 2000 : 7000)
  }
}
async function loadLanguageSuggestions() {
  const sourceRevisionId = state.value?.adaptation?.draft?.baseRevisionId
  const requestedFormat = format.value, requestedEpoch = formatEpoch
  if (!sourceRevisionId) { languageSuggestions.value = []; return }
  try {
    const params = new URLSearchParams({ targetType: 'ADAPTATION', sourceRevisionId })
    const response = await fetch(`${projectBase}/language-suggestions?${params}`, { credentials: 'same-origin', signal: controller.signal })
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) return
    const suggestions = (await response.json() as { suggestions: LanguageSuggestion[] }).suggestions
    if (requestedEpoch !== formatEpoch || requestedFormat !== format.value) return
    languageSuggestions.value = suggestions
    selectedLanguageIds.value = selectedLanguageIds.value.filter(id => languageSuggestions.value.some(item => item.id === id && item.status === 'OPEN' && !item.stale))
  } catch { /* Language review is secondary; saved content remains available. */ }
}
function draftMatchesBase() {
  const draft = state.value?.adaptation?.draft
  if (!draft?.baseRevisionId) return false
  const baseRevision = state.value?.adaptation?.revisions.find(item => item.id === draft.baseRevisionId)
  return !!baseRevision && JSON.stringify(draft.content) === JSON.stringify(baseRevision.content)
}
async function reviewLanguage() {
  if (languageBusy.value || readonly.value) return
  const reviewFormat = format.value, reviewEpoch = formatEpoch
  languageBusy.value = true; languageMessage.value = ''; error.value = ''
  try {
    if (!await save()) return
    if (!draftMatchesBase()) await command('/checkpoint', {}, true)
    const sourceRevisionId = state.value?.adaptation?.draft?.baseRevisionId
    if (!sourceRevisionId || !draftMatchesBase()) throw new Error('Збережіть версію тексту перед мовною перевіркою.')
    const response = await fetch(`${projectBase}/language-suggestions/review`, { credentials: 'same-origin', signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify({ targetType: 'ADAPTATION', sourceRevisionId, expectedRevision: state.value?.adaptation?.revision }) })
    if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
    if (!response.ok) { if (response.status === 409) conflict.value = true; throw new Error(response.status === 409 ? 'Матеріал змінився. Оновіть його перед мовною перевіркою.' : 'Не вдалося перевірити мову матеріалу.') }
    const suggestions = (await response.json() as { suggestions: LanguageSuggestion[] }).suggestions
    if (reviewEpoch !== formatEpoch || reviewFormat !== format.value) return
    languageSuggestions.value = suggestions
    selectedLanguageIds.value = languageSuggestions.value.filter(item => item.status === 'OPEN' && !item.stale).map(item => item.id)
    languageMessage.value = languageSuggestions.value.length ? 'Перегляньте пропозиції та виберіть, які застосувати.' : 'Мовних зауважень не знайдено.'
  } catch (cause) { if (reviewEpoch === formatEpoch && reviewFormat === format.value) languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося перевірити мову матеріалу.' }
  finally { languageBusy.value = false }
}
async function mutateLanguage(path: string, body: unknown) {
  if (languageBusy.value || readonly.value || dirty.value || !state.value?.adaptation) return
  const mutationFormat = format.value, mutationEpoch = formatEpoch
  languageBusy.value = true; languageMessage.value = ''
  try {
    const response = await fetch(`${projectBase}/language-suggestions${path}`, { credentials: 'same-origin', signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) })
    if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
    if (!response.ok) { if (response.status === 409) conflict.value = true; throw new Error(response.status === 409 ? 'Матеріал змінився. Оновіть його перед застосуванням пропозицій.' : 'Не вдалося оновити мовні пропозиції.') }
    if (mutationEpoch !== formatEpoch || mutationFormat !== format.value) return
    if (path === '/accept') { await load(true); languageMessage.value = 'Вибрані правки застосовано до чернетки. Перевірте текст і збережіть нову версію.'; selectedLanguageIds.value = [] }
    else await loadLanguageSuggestions()
  } catch (cause) { if (mutationEpoch === formatEpoch && mutationFormat === format.value) languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося оновити мовні пропозиції.' }
  finally { languageBusy.value = false }
}
function acceptLanguage() {
  const first = languageSuggestions.value.find(item => selectedLanguageIds.value.includes(item.id) && item.status === 'OPEN' && !item.stale)
  if (!first || !selectedLanguageIds.value.length || dirty.value) return
  void mutateLanguage('/accept', { targetType: 'ADAPTATION', sourceRevisionId: first.sourceRevisionId, expectedRevision: state.value?.adaptation?.revision, suggestionIds: [...selectedLanguageIds.value] })
}
function rejectLanguage(item: LanguageSuggestion) {
  void mutateLanguage(`/${encodeURIComponent(item.id)}/reject`, { expectedRevision: state.value?.adaptation?.revision })
}
async function jobAction(job: Job, action: 'retry' | 'cancel') {
  try {
    const response = await fetch(`${projectBase}/jobs/${job.id}/${action}`, { credentials: 'same-origin', method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: '{}' })
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) throw new Error('Не вдалося виконати дію із завданням.')
    await pollJobs()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Дія недоступна.' }
}
function chooseSelection() {
  const el = editor.value
  if (el && el.selectionEnd > el.selectionStart) selection.value = { start: el.selectionStart, end: el.selectionEnd }
}
const activeMappingField = ref<'text' | 'cover'>('text')
function chooseCoverSelection() {
  activeMappingField.value = 'cover'
  const el = coverEditor.value
  if (el && el.selectionEnd > el.selectionStart) selection.value = { start: el.selectionStart, end: el.selectionEnd }
}
function chooseBodySelection() { activeMappingField.value = 'text'; chooseSelection() }
function editText(event: Event) {
  activeMappingField.value = 'text'; updateText((event.target as HTMLTextAreaElement).value, 'text')
}
function editCoverText(event: Event) { activeMappingField.value = 'cover'; updateText((event.target as HTMLTextAreaElement).value, 'cover') }
function updateText(next: string, field: 'text' | 'cover' = 'text') {
  const previous = field === 'cover' ? coverText.value : text.value
  let start = 0, oldEnd = previous.length, newEnd = next.length
  while (start < oldEnd && start < newEnd && previous[start] === next[start]) start++
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd-- }
  const delta = next.length - previous.length
  sourceMappings.value = sourceMappings.value.flatMap(row => (row.field ?? 'text') !== field || row.endOffset <= start ? [row] : row.startOffset >= oldEnd ? [{ ...row,startOffset: row.startOffset+delta,endOffset: row.endOffset+delta }] : [])
  const adjusted = mappings.value.map(row => {
    if ((row.field ?? 'text') !== field) return row
    if (row.endOffset <= start) return row
    if (row.startOffset >= oldEnd) return { ...row, startOffset: row.startOffset + delta, endOffset: row.endOffset + delta }
    return { ...row, startOffset: Math.min(row.startOffset, start), endOffset: row.endOffset > oldEnd ? row.endOffset + delta : newEnd }
  }).filter(row => row.endOffset > row.startOffset)
  // A replacement spanning several citations has no unique surviving range.
  // Remove only overlapping links; retained quotes require explicit relinking.
  const untouched = mappings.value.filter(row => (row.field ?? 'text') !== field)
  mappings.value = [...untouched, ...adjusted.filter(row => (row.field ?? 'text') === field).filter((row, index, rows) => !rows.some((other, otherIndex) => otherIndex !== index && row.startOffset < other.endOffset && other.startOffset < row.endOffset))]
  if (field === 'cover') coverText.value = next; else text.value = next
  selection.value = null; changed()
}
function insertPlaceholder() {
  const el = editor.value
  if (!el) { updateText(`${text.value}${text.value && !text.value.endsWith('\n') ? '\n' : ''}[ПОСИЛАННЯ]`); return }
  const start = el.selectionStart, end = el.selectionEnd, token = '[ПОСИЛАННЯ]'
  updateText(`${text.value.slice(0, start)}${token}${text.value.slice(end)}`)
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
}
function inputFreshness(reasons: string[]) {
  const labels: Record<string, string> = { BRIEF_CHANGED: 'змінився бриф', WORKSPACE_STYLE_CHANGED: 'змінився стиль простору', FACTUAL_BASIS_CHANGED: 'змінилися джерельні докази', MISSING_FACTUAL_BASIS: 'бракує джерельних доказів', INVALID_ORIGINAL_FACTUAL_BASIS: 'джерельні докази початкової версії втратили придатність', SOURCE_ARTICLE_CHANGED: 'змінилася погоджена стаття', INVALID_ORIGINAL_SOURCE_ARTICLE: 'початкова стаття більше не погоджена', INVALID_ORIGINAL_SOURCE_EVIDENCE: 'докази початкової статті потребують перегляду' }
  const specific = reasons.flatMap(reason => labels[reason] ? [labels[reason]] : [])
  return [...new Set(specific)].join(', ') || 'змінилися джерела або налаштування'
}
function formatDate(value?: string | null) { return value ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—' }
function restoreLocal() {
  const item = recovered.value
  if (!item) return
  hydration = true; text.value = item.content.text; coverText.value = item.content.cover?.text ?? ''; coverInstruction.value = item.content.cover?.instruction ?? ''; mappings.value = item.content.mappings; sourceMappings.value = item.content.sourceMappings ?? []; inputMode.value = item.inputMode; contentMode.value = item.contentMode; includeLink.value = item.includeLink
  recovered.value = null; expectedRevision.value = item.expectedRevision; hydration = false; conflict.value = expectedRevision.value !== (state.value?.adaptation?.revision ?? 0); baseline.value = ''; retain(); if (!conflict.value) void save()
}
function discardLocal() { recovered.value = null; sessionStorage.removeItem(recoveryKey.value) }
async function reconcile(useLocal: boolean) {
  try { if (!await load(!useLocal)) return; expectedRevision.value = state.value?.adaptation?.revision ?? 0; conflict.value = false; error.value = ''; recovered.value = null; if (useLocal) { baseline.value = ''; await save() } else sessionStorage.removeItem(recoveryKey.value) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити.' }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { retain(); event.preventDefault(); event.returnValue = '' } }
function endSession() { sessionEnded = true; disposed = true; controller.abort(); clearTimeout(timer); clearTimeout(pollTimer); hydration = true; text.value = ''; coverText.value = ''; coverInstruction.value = ''; mappings.value = []; sourceMappings.value = []; recovered.value = null; state.value = null; jobs.value = []; sessionStorage.removeItem(recoveryKey.value) }
function titleFor(formatValue: ChannelFormat) { return ({ TELEGRAM_POST: 'допис у Telegram', LINKEDIN_TEXT: 'публікацію у LinkedIn', LINKEDIN_COVER: 'обкладинку LinkedIn', INSTAGRAM_COVER: 'обкладинку Instagram', LINKEDIN_CAROUSEL: 'карусель LinkedIn', INSTAGRAM_CAROUSEL: 'карусель Instagram', INSTAGRAM_STORIES: 'історії Instagram' })[formatValue] }
async function switchFormat(event: Event) {
  const next = (event.target as HTMLSelectElement).value as ChannelFormat
  if (busy.value || languageBusy.value) { (event.target as HTMLSelectElement).value = format.value; return }
  if (next === format.value || !props.formats.includes(next)) return
  if (!await save()) { (event.target as HTMLSelectElement).value = format.value; return }
  emit('format-change', next)
}
watch(() => props.initialFormat, async (next) => {
  if (next === format.value) return
  if (dirty.value) retain()
  clearTimeout(timer)
  format.value = next; formatEpoch++
  sourceResultPending.value = false
  loadedCreativeResultId = undefined
  state.value = null; jobs.value = []; sourceRequest.value = null; jobMessage.value = ''; error.value = ''; conflict.value = false; recovered.value = null; languageSuggestions.value = []; selectedLanguageIds.value = []; languageMessage.value = ''
  loading.value = true
  const requestedEpoch = formatEpoch
  try {
    if (!await load(true)) return
    restoreSourceRequest()
    const stored = sessionStorage.getItem(recoveryKey.value)
    if (stored) { const value = JSON.parse(stored) as RecoveredDraft; if (JSON.stringify({ content: value.content, inputMode: value.inputMode, contentMode: value.contentMode, includeLink: value.includeLink }) !== baseline.value) recovered.value = value; else sessionStorage.removeItem(recoveryKey.value) }
  } catch (cause) { if (requestedEpoch === formatEpoch) error.value = cause instanceof Error ? cause.message : `Не вдалося відкрити ${titleFor(format.value)}.` }
  finally { if (requestedEpoch === formatEpoch) { loading.value = false; if (!disposed) void loadLanguageSuggestions() } }
})
watch([text, coverText, coverInstruction, inputMode, contentMode, includeLink], changed)
watch(() => props.userId, () => { controller.abort(); endSession() })
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('cf:article-session-ended', endSession)
  try {
    await load(true)
    restoreSourceRequest()
    const stored = sessionStorage.getItem(recoveryKey.value)
    if (stored) { const value = JSON.parse(stored) as RecoveredDraft; if (JSON.stringify({ content: value.content, inputMode: value.inputMode, contentMode: value.contentMode, includeLink: value.includeLink }) !== baseline.value) recovered.value = value; else sessionStorage.removeItem(recoveryKey.value) }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити Telegram.' }
  finally { loading.value = false; if (!disposed) { void pollJobs(); void loadLanguageSuggestions() } }
})
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('cf:article-session-ended', endSession); if (!disposed) { retain(); disposed = true } controller.abort(); clearTimeout(timer); clearTimeout(pollTimer) })
</script>

<template>
  <div class="telegram-workspace">
    <header class="telegram-heading">
      <div>
        <h1 id="telegram-title">
          {{ formatLabel }}
        </h1>
      </div>
      <Button
        class="workspace-button"
        variant="ghost"
        :disabled="busy"
        @click="historyOpen = !historyOpen"
      >
        Історія й походження
      </Button>
    </header>

    <p
      v-if="loading"
      class="telegram-state"
      role="status"
    >
      Відкриваємо редактор каналів…
    </p>
    <section
      v-else-if="error && !state"
      class="telegram-state"
      role="alert"
    >
      <p>{{ error }}</p><Button
        class="workspace-button"
        variant="outline"
        @click="load(true)"
      >
        Спробувати ще раз
      </Button>
    </section>
    <template v-else-if="state">
      <p
        v-if="readonly"
        class="telegram-notice"
      >
        {{ props.archived ? 'Архівований проєкт доступний лише для перегляду.' : `${formatLabel} не вибрано серед форматів цього проєкту.` }}
      </p>
      <div
        v-if="articleSourceNeedsReview || state.staleReasons.length"
        class="telegram-notice telegram-stale"
        role="status"
      >
        <p v-if="articleSourceNeedsReview">
          Після погодження статті {{ inputFreshness(selectedArticle?.inspection?.staleReasons ?? []) }}. Допис можна редагувати й зберігати. Для нової пропозиції спочатку перегляньте погодження статті.
        </p>
        <p v-else>
          Щоб погодити цю версію допису, оновіть її основу. Причина — {{ inputFreshness(state.staleReasons) }}. Текст допису збережеться.
        </p>
        <Button
          v-if="articleSourceNeedsReview"
          class="workspace-button"
          variant="outline"
          :disabled="busy || saving"
          @click="emit('review-article')"
        >
          Перейти до погодження статті
        </Button>
        <Button
          v-else
          class="workspace-button"
          variant="outline"
          :disabled="busy || readonly || conflict || !!recovered || state.brief?.currentRevision?.contentMode !== contentMode || (inputMode === 'ARTICLE_DERIVED' && (!selectedArticle || articleSourceNeedsReview))"
          @click="refreshInputs"
        >
          Оновити основу допису
        </Button>
      </div>
      <div
        v-if="recovered"
        class="telegram-recovery"
        role="status"
      >
        <p>Знайдено текст, що залишився в цій вкладці. Відновити його?</p>
        <Button
          class="workspace-button"
          variant="outline"
          @click="restoreLocal"
        >
          Відновити
        </Button>
        <Button
          class="workspace-button"
          variant="ghost"
          @click="discardLocal"
        >
          Відкинути копію
        </Button>
      </div>
      <div
        v-if="conflict"
        class="telegram-recovery"
        role="alert"
      >
        <p>На сервері з’явилася новіша версія. Локальний текст збережено.</p>
        <Button
          class="workspace-button"
          variant="outline"
          @click="reconcile(true)"
        >
          Зберегти мій текст після оновлення
        </Button>
        <Button
          class="workspace-button"
          variant="ghost"
          @click="reconcile(false)"
        >
          Завантажити серверну версію
        </Button>
      </div>

      <div class="telegram-controls">
        <label class="telegram-select">Формат
          <select
            :value="format"
            :disabled="busy || saving || props.formats.length < 2"
            @change="switchFormat"
          >
            <option
              v-for="choice in props.formats"
              :key="choice"
              :value="choice"
            >{{ ({ TELEGRAM_POST: 'Допис у Telegram', LINKEDIN_TEXT: 'Публікація у LinkedIn', LINKEDIN_COVER: 'Обкладинка LinkedIn', INSTAGRAM_COVER: 'Обкладинка Instagram', LINKEDIN_CAROUSEL: 'Карусель LinkedIn', INSTAGRAM_CAROUSEL: 'Карусель Instagram', INSTAGRAM_STORIES: 'Історії Instagram' } as Record<ChannelFormat, string>)[choice] }}</option>
          </select>
        </label>
        <label class="telegram-select">Джерело матеріалу
          <select
            v-model="inputMode"
            :disabled="readonly || busy"
          >
            <option value="DIRECT">Самостійний допис</option>
            <option
              value="ARTICLE_DERIVED"
              :disabled="!selectedArticle || selectedArticle.inspection?.eligible !== true"
            >За погодженою статтею</option>
          </select>
        </label>
        <label class="telegram-select">Режим роботи
          <select
            v-model="contentMode"
            :disabled="readonly || busy"
          >
            <option value="FACTUAL">На основі джерел</option>
            <option value="CREATIVE">Авторський · без перевірки джерел</option>
          </select>
        </label>
        <label
          v-if="format === 'TELEGRAM_POST'"
          class="telegram-link-toggle"
        ><input
          v-model="includeLink"
          type="checkbox"
          :disabled="readonly || busy"
        > Передбачити місце для посилання</label>
      </div>
      <p
        v-if="contentMode === 'CREATIVE'"
        class="telegram-unverified"
      >
        Авторський режим · Текст створюється з брифу й авторських вказівок без пошуку в джерелах.
      </p>
      <p
        v-if="inputMode === 'DIRECT'"
        class="telegram-source-note"
      >
        Самостійний допис працює без статті та структури. У режимі «На основі джерел» система шукає уривки за брифом у джерелах проєкту.
      </p>
      <p
        v-else
        class="telegram-source-note"
      >
        Джерело: {{ selectedArticle?.title || 'погоджена стаття' }} (версія {{ selectedArticle?.number }}). Зміни чернетки статті не змінюють цю адаптацію.
      </p>
      <p
        v-if="state.brief?.currentRevision?.contentMode !== contentMode"
        class="telegram-notice"
      >
        Збережіть бриф у вибраному режимі, перш ніж редагувати чи створювати допис.
      </p>
      <div
        v-if="jobMessage"
        class="telegram-job-state"
        :role="activeJob ? 'status' : 'alert'"
      >
        <p>{{ jobMessage }}</p>
        <Button
          v-for="job in jobs.filter(row => ['FAILED', 'RETRY_WAIT'].includes(row.status) && row.retryAllowed)"
          :key="job.id"
          class="workspace-button"
          variant="outline"
          :disabled="busy || readonly"
          @click="jobAction(job, 'retry')"
        >
          Спробувати генерацію ще раз
        </Button>
        <Button
          v-for="job in jobs.filter(row => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(row.status))"
          :key="`cancel-${job.id}`"
          class="workspace-button"
          variant="ghost"
          :disabled="busy || readonly"
          @click="jobAction(job, 'cancel')"
        >
          Скасувати генерацію
        </Button>
      </div>

      <details
        v-if="latestProposal"
        class="telegram-proposal"
        :open="proposalOpen"
        @toggle="proposalOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary id="channel-proposal-heading">
          {{ sourceRequest?.stage === 'FAILED' ? 'Попередня пропозиція тексту' : 'Пропозиція тексту' }}
        </summary>
        <p class="telegram-history-text">
          {{ latestProposal.content.text }}
        </p>
        <template v-if="latestProposal.content.cover">
          <p class="telegram-history-text">
            <strong>Текст обкладинки:</strong> {{ latestProposal.content.cover.text }}
          </p>
          <p class="telegram-history-instruction">
            <strong>Завдання:</strong> {{ latestProposal.content.cover.instruction }}
          </p>
        </template>
        <p
          v-if="proposalIssue(latestProposal)"
          class="telegram-source-note"
        >
          {{ proposalIssue(latestProposal) }}
        </p>
        <div class="telegram-history-actions">
          <Button
            class="workspace-button workspace-button-primary"
            :disabled="busy || readonly || dirty || conflict || !!recovered || !!proposalIssue(latestProposal)"
            @click="command(`/${latestProposal.id}/apply`, {}, true)"
          >
            Застосувати до чернетки
          </Button>
          <a
            v-if="hasScript"
            href="#script-title"
          >Перейти до сценарію</a>
        </div>
      </details>

      <SourceWritingStarter
        v-if="sourceRequest?.sourceStarter"
        :starter="sourceRequest.sourceStarter"
      />

      <div class="telegram-layout">
        <section
          class="telegram-paper"
          aria-label="Редактор матеріалу"
        >
          <div class="telegram-paper-heading">
            <p>Текст публікації</p><span>{{ text.length }} / {{ textLimit }}</span>
          </div>
          <label
            class="sr-only"
            for="telegram-manuscript"
          >Текст публікації</label>
          <textarea
            id="telegram-manuscript"
            ref="editor"
            :value="text"
            class="telegram-manuscript"
            :maxlength="textLimit"
            rows="12"
            :readonly="readonly || busy || languageBusy"
            aria-describedby="telegram-save-state"
            @select="chooseBodySelection"
            @input="editText"
            @keyup="chooseBodySelection"
            @mouseup="chooseBodySelection"
          />
          <template v-if="isCover">
            <label
              class="telegram-paper-heading cover-field-label"
              for="cover-copy"
            >Текст на обкладинці · {{ coverText.length }} / 200</label>
            <textarea
              id="cover-copy"
              ref="coverEditor"
              :value="coverText"
              class="telegram-manuscript cover-manuscript"
              maxlength="200"
              rows="4"
              :readonly="readonly || busy || languageBusy"
              @select="chooseCoverSelection"
              @input="editCoverText"
              @keyup="chooseCoverSelection"
              @mouseup="chooseCoverSelection"
            />
            <label
              class="telegram-paper-heading cover-field-label"
              for="cover-instruction"
            >Завдання для обкладинки · {{ coverInstruction.length }} / 2000</label>
            <textarea
              id="cover-instruction"
              v-model="coverInstruction"
              class="telegram-instruction"
              maxlength="2000"
              rows="3"
              :readonly="readonly || busy || languageBusy"
              placeholder="Що має передати обкладинка? Опишіть задум словами."
            />
            <p
              v-if="!coverText.trim() || !coverInstruction.trim()"
              class="telegram-source-note"
            >
              Щоб погодити або експортувати обкладинку, заповніть її текст і завдання.
            </p>
          </template>
          <p
            id="telegram-save-state"
            class="telegram-save-state"
            role="status"
            aria-live="polite"
          >
            {{ state.adaptation?.draft || dirty || saving ? saveStatus : '' }}<span v-if="dirty && !saving"> · зміни збережуться автоматично</span>
          </p>
          <div class="telegram-actions">
            <Button
              v-if="format === 'TELEGRAM_POST'"
              class="workspace-button"
              variant="outline"
              :disabled="readonly || busy || conflict || !!recovered"
              @click="insertPlaceholder"
            >
              Вставити [ПОСИЛАННЯ]
            </Button>
            <Button
              class="workspace-button"
              variant="outline"
              :disabled="readonly || busy || activeJob || conflict || !!recovered || state.brief?.currentRevision?.contentMode !== contentMode || (inputMode === 'ARTICLE_DERIVED' && (!selectedArticle || articleSourceNeedsReview || !!selectedArticle.inspection?.blockingReasons.length))"
              @click="generate"
            >
              Запропонувати текст
            </Button>
            <Button
              class="workspace-button workspace-button-primary"
              :disabled="readonly || busy || checkpointing || conflict || !!recovered || !text.trim() || text.length > textLimit || coverText.length > 200 || coverInstruction.length > 2000"
              @click="checkpoint()"
            >
              {{ checkpointing ? 'Зберігаємо версію…' : 'Зберегти версію' }}
            </Button>
            <Button
              class="workspace-button workspace-button-primary"
              :disabled="readonly || busy || checkpointing || conflict || !!recovered || !text.trim() || text.length > textLimit || (isCover && (!coverText.trim() || !coverInstruction.trim()))"
              @click="checkpoint(true)"
            >
              Зберегти й погодити
            </Button>
          </div>
          <p
            v-if="savedVersionNumber !== null && !dirty"
            role="status"
          >
            Версію {{ savedVersionNumber }} збережено.
          </p>
          <section
            class="telegram-language"
            aria-labelledby="language-heading"
          >
            <div class="telegram-paper-heading">
              <h2 id="language-heading">
                Пробіли й пунктуація
              </h2>
              <Button
                class="workspace-button"
                variant="outline"
                :disabled="readonly || busy || saving || languageBusy || conflict || !!recovered"
                @click="reviewLanguage"
              >
                {{ languageBusy ? 'Перевіряємо…' : 'Перевірити' }}
              </Button>
            </div>
            <p
              v-if="languageMessage"
              role="status"
            >
              {{ languageMessage }}
            </p>
            <article
              v-for="suggestion in languageSuggestions"
              :key="suggestion.id"
              class="telegram-language-item"
            >
              <p class="telegram-language-finding">
                {{ suggestion.finding }}
              </p>
              <p class="telegram-language-change">
                <del>{{ suggestion.originalText }}</del> → <ins>{{ suggestion.replacementText }}</ins>
              </p>
              <p
                v-if="suggestion.stale"
                class="telegram-stale"
              >
                Ця пропозиція стосується старішої версії.
              </p>
              <label
                v-else-if="suggestion.status === 'OPEN'"
                class="telegram-language-select"
              ><input
                v-model="selectedLanguageIds"
                type="checkbox"
                :value="suggestion.id"
                :disabled="readonly || languageBusy || dirty"
              > Застосувати цю правку</label>
              <p
                v-else
                class="telegram-language-status"
              >
                {{ suggestion.status === 'ACCEPTED' ? 'Застосовано' : 'Відхилено' }}
              </p>
              <Button
                v-if="suggestion.status === 'OPEN' && !suggestion.stale"
                class="workspace-button"
                variant="ghost"
                :disabled="readonly || languageBusy || dirty"
                @click="rejectLanguage(suggestion)"
              >
                Відхилити
              </Button>
            </article>
            <Button
              v-if="selectedLanguageIds.length"
              class="workspace-button workspace-button-primary"
              :disabled="readonly || languageBusy || dirty"
              @click="acceptLanguage"
            >
              Застосувати вибрані правки
            </Button>
          </section>
          <div
            v-if="localMappingIssues.length || state.mappingIssues.length"
            class="telegram-mapping-warning"
            role="status"
          >
            Є посилання на речення, які змінилися в тексті або на обкладинці. Видаліть їх або виділіть точні слова й прив’яжіть знову.
          </div>
          <div
            v-if="sourceActive || sourceResultPending || (sourceRequest?.stage === 'FAILED' && !sourceRequest.sourceStarter)"
            role="status"
          >
            {{ sourceRequest?.stage === 'FAILED' ? sourceWritingFailure(sourceRequest.errorCategory) : sourceResultPending ? 'Пропозиція готова. Завантажуємо текст…' : 'Готуємо текст із джерел…' }}
            <Button
              v-if="sourceActive"
              variant="ghost"
              :disabled="busy"
              @click="cancelSourceRequest"
            >
              Скасувати підготовку
            </Button>
          </div>
          <details
            v-if="sourceMappings.length"
            aria-label="Посилання на уривки"
            class="telegram-linked"
          >
            <summary>Прив’язані уривки</summary>
            <p
              v-for="mapping in sourceMappings"
              :key="`${mapping.passageId}:${mapping.startOffset}`"
            >
              «{{ fieldText(mapping.field).slice(mapping.startOffset,mapping.endOffset) }}»
              <Button
                variant="ghost"
                @click="inspectMappedSource(mapping)"
              >
                Переглянути уривок
              </Button>
              <Button
                variant="ghost"
                :disabled="readonly"
                @click="sourceMappings = sourceMappings.filter(row => row !== mapping); changed()"
              >
                Прибрати посилання
              </Button>
            </p>
          </details>
          <p
            v-if="sourceError && !selectedSource"
            class="telegram-source-error"
            role="alert"
          >
            {{ sourceError }}
          </p>
          <p
            v-if="includeLink"
            class="telegram-link-note"
          >
            Посилання необов’язкове. Текст [ПОСИЛАННЯ] можна замінити вручну; URL для погодження не потрібен.
          </p>
          <div
            v-if="!readonly"
            class="telegram-review-controls"
          >
            <p v-if="activeApproval">
              {{ activeApproval.staleReasons.length ? 'Раніше погоджена версія допису' : 'Погоджена версія допису' }} (версія {{ activeApproval.number }})
            </p>
          </div>
        </section>

        <aside
          class="telegram-evidence"
          aria-labelledby="telegram-evidence-heading"
        >
          <h2 id="telegram-evidence-heading">
            Докази для допису
          </h2>
          <p>Виділіть точні слова в тексті, а потім прив’яжіть їх до доказу.</p>
          <section
            v-if="selectedSource"
            aria-label="Вибраний уривок"
          >
            <header class="telegram-source-context-heading">
              <h3>{{ selectedSource.materialTitle }}</h3><Button
                variant="ghost"
                @click="closeSourcePassage"
              >
                Закрити
              </Button>
            </header>
            <p
              v-if="sourceLoading"
              role="status"
            >
              Відкриваємо збережене джерело…
            </p>
            <p
              v-else-if="sourceError"
              role="alert"
            >
              {{ sourceError }} <Button
                variant="ghost"
                @click="retrySourcePassage"
              >
                Спробувати знову
              </Button>
            </p>
            <blockquote
              v-else-if="sourceContext"
              class="telegram-source-context"
            >
              <SourceMarkdown
                :text="sourceContext"
                :highlight="{ startOffset: selectedSource.startOffset, endOffset: selectedSource.endOffset }"
              />
            </blockquote>
            <blockquote v-else>
              <SourceMarkdown
                :text="selectedSource.quote"
                compact
              />
            </blockquote>
            <a :href="`/projects/${projectId}/sources`">Відкрити джерела проєкту</a>
          </section>
          <div
            class="telegram-passage-list"
            tabindex="0"
            aria-label="Уривки джерел"
          >
            <article
              v-for="item in state.eligibleSourcePassages ?? []"
              :key="item.passageId"
              class="telegram-evidence-item"
            >
              <h3>{{ item.materialTitle }}</h3><blockquote>
                <SourceMarkdown
                  :text="item.quote"
                  compact
                />
              </blockquote>
              <Button
                variant="ghost"
                @click="openSourcePassage(item)"
              >
                Відкрити джерело
              </Button>
              <Button
                variant="outline"
                :disabled="readonly || contentMode !== 'FACTUAL'"
                @mousedown.prevent
                @click="linkSourcePassage(item)"
              >
                Прив’язати виділення до уривка
              </Button>
            </article>
          </div>
          <p
            v-if="!state.eligibleSourcePassages?.length"
            class="telegram-empty-evidence"
          >
            Добірка доказів з’явиться після підготовки тексту із джерел.
          </p>
        </aside>
      </div>

      <section
        v-if="historyOpen"
        class="telegram-history"
        aria-labelledby="telegram-history-heading"
      >
        <header>
          <h2 id="telegram-history-heading">
            Історія й походження
          </h2><Button
            class="workspace-button"
            variant="ghost"
            @click="historyOpen = false"
          >
            Закрити
          </Button>
        </header>
        <p v-if="!state.adaptation?.revisions.length">
          Збережіть версію, щоб зафіксувати допис і його джерела.
        </p>
        <article
          v-for="revision in state.adaptation?.revisions"
          :key="revision.id"
          class="telegram-history-entry"
        >
          <div class="telegram-history-title">
            <h3>Версія {{ revision.number }}</h3><p>{{ revision.status === 'APPROVED' ? 'Погоджено' : revision.status === 'WITHDRAWN' ? 'Відкликано' : revision.id === state.adaptation?.draft?.baseRevisionId ? 'У чернетці' : revision.origin === 'AI' ? 'Пропозиція AI · очікує застосування' : 'Очікує перегляду' }} · {{ revision.inputMode === 'DIRECT' ? 'Самостійний допис' : 'За статтею' }} · {{ revision.contentMode === 'FACTUAL' ? 'Фактичний режим' : 'Авторський · неперевірено' }}</p>
          </div>
          <p
            v-if="revision.staleReasons.length"
            class="telegram-stale"
            role="status"
          >
            Потребує перегляду: {{ inputFreshness(revision.staleReasons) }}.
          </p>
          <p
            v-if="revision.blockingReasons.length"
            class="telegram-notice"
          >
            Не можна погодити: {{ revision.blockingReasons.join(', ') }}
          </p>
          <blockquote class="telegram-history-text">
            {{ revision.content.text }}
          </blockquote>
          <template v-if="revision.content.cover">
            <p class="telegram-history-text">
              <strong>Текст обкладинки:</strong> {{ revision.content.cover.text }}
            </p>
            <p class="telegram-history-instruction">
              <strong>Завдання:</strong> {{ revision.content.cover.instruction || 'Не вказано' }}
            </p>
          </template>
          <details>
            <summary>Початкові входи й квитанція перегляду</summary>
            <dl class="telegram-inputs">
              <dt>Бриф</dt><dd>{{ revision.briefRevisionId }}</dd><dt>Стиль простору</dt><dd>Версія {{ revision.workspaceStyleRevision }}</dd><dt>Джерельний контекст</dt><dd>{{ revision.sourceEvidenceSetId || 'Не використовувався' }}</dd><dt>Стаття-джерело</dt><dd>{{ revision.sourceArticleVersionId || 'Немає · прямий шлях' }}</dd><dt>Посилання</dt><dd>{{ revision.includeLink ? 'Передбачалося місце' : 'Не передбачалося' }}</dd><dt>Погоджено</dt><dd>{{ formatDate(revision.approvedAt) }}{{ revision.approvedBy ? ` · ${revision.approvedBy}` : '' }}</dd><dt>Останній перегляд</dt><dd>{{ formatDate(revision.reviewedAt) }}{{ revision.reviewedBy ? ` · ${revision.reviewedBy}` : '' }}</dd><dt>Переглянуті залежності</dt><dd>Бриф {{ revision.reviewedBriefRevisionId || '—' }}; джерела {{ revision.sourceEvidenceSetId || '—' }}; стиль {{ revision.reviewedWorkspaceStyleRevision ?? '—' }}; стаття {{ revision.reviewedSourceArticleVersionId || '—' }}</dd>
            </dl>
            <p v-if="revision.acknowledgedUnmapped">
              Редактор підтвердив перегляд речень без прив’язки до доказів.
            </p>
            <p v-if="revision.withdrawalReason">
              Причина відкликання: {{ revision.withdrawalReason }}
            </p>
          </details>
          <div class="telegram-history-actions">
            <Button
              v-if="revision.origin === 'AI' && revision.status === 'PROPOSED' && revision.id !== latestProposal?.id && revision.id !== state.adaptation?.draft?.baseRevisionId"
              class="workspace-button"
              variant="outline"
              :disabled="busy || readonly || dirty || conflict || !!recovered || !!proposalIssue(revision)"
              @click="command(`/${revision.id}/apply`, {}, true)"
            >
              Застосувати до чернетки
            </Button>
            <template v-if="revision.status === 'PROPOSED' && revision.id === (state.adaptation?.draft?.baseRevisionId ?? null)">
              <Button
                class="workspace-button workspace-button-primary"
                :disabled="busy || readonly || dirty || conflict || !!revision.blockingReasons.length"
                @click="command(`/${revision.id}/approve`, { expectedReviewCounter: revision.reviewCounter })"
              >
                Погодити версію
              </Button>
            </template>
            <Button
              v-if="revision.status === 'APPROVED' && revision.id === state.adaptation?.currentApprovedRevisionId && revision.staleReasons.length"
              class="workspace-button workspace-button-primary"
              :disabled="busy || readonly || dirty || conflict || !!revision.blockingReasons.length"
              @click="command(`/${revision.id}/rereview`, { expectedReviewCounter: revision.reviewCounter })"
            >
              Переглянути без зміни тексту
            </Button>
            <Button
              v-if="revision.status === 'APPROVED' && revision.id === state.adaptation?.currentApprovedRevisionId"
              class="workspace-button"
              variant="ghost"
              :disabled="busy || readonly || dirty"
              @click="command(`/${revision.id}/withdraw`, { reason: 'Відкликано редактором' })"
            >
              Відкликати погодження
            </Button>
          </div>
        </article>
      </section>
      <p
        v-if="error && state"
        class="telegram-error"
        role="alert"
      >
        {{ error }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.telegram-workspace { width: 100%; min-width: 0; color: var(--ink); }
.telegram-heading { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin: 0 0 28px; }
.telegram-heading h1 { margin: 0; font: 550 39px/1.2 SourceSerif, Georgia, serif; letter-spacing: -.025em; }
.telegram-context { max-width: 60ch; margin: 0 0 7px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.telegram-notice, .telegram-unverified, .telegram-stale, .telegram-source-note { max-width: 78ch; margin: 14px 0; color: var(--lead-ink, #555a60); font-size: 14px; line-height: 1.55; }
.telegram-stale { color: var(--review, #945000); }
.telegram-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 16px 28px; padding: 18px 0; border-block: 1px solid var(--rule); }
.telegram-select { display: grid; gap: 6px; color: var(--muted); font-size: 12px; }
.telegram-select select { min-width: 220px; max-width: 100%; padding: 9px 32px 9px 10px; border: 1px solid var(--field-rule); border-radius: 0; background: var(--paper); color: var(--ink); font: inherit; font-size: 14px; }
.telegram-link-toggle { display: flex; align-items: center; gap: 8px; min-height: 40px; color: var(--ink); font-size: 14px; }
.telegram-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(250px, 310px); align-items: start; gap: clamp(24px, 5vw, 72px); margin-top: 26px; }
.telegram-paper { min-width: 0; }
.telegram-paper-heading { display: flex; justify-content: space-between; gap: 14px; align-items: baseline; margin-bottom: 10px; }
.telegram-paper-heading p { margin: 0; font-size: 14px; font-weight: 600; }
.telegram-paper-heading h2 { margin: 0; font: 550 21px/1.3 SourceSerif, Georgia, serif; }
.telegram-paper-heading span, .telegram-save-state { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.telegram-manuscript { box-sizing: border-box; display: block; width: 100%; min-height: 320px; resize: vertical; padding: 24px clamp(20px, 4vw, 48px); border: 1px solid var(--rule); border-radius: 0; background: var(--paper); color: var(--ink); font: 400 20px/1.65 SourceSerif, Georgia, serif; overflow-wrap: anywhere; }
.telegram-manuscript::selection { color: #20262b; background: #edece7; }
.cover-field-label { margin-top: 24px; }
.cover-manuscript { min-height: 140px; }
.telegram-instruction { box-sizing: border-box; width: 100%; min-height: 108px; resize: vertical; padding: 12px 14px; border: 1px solid var(--field-rule); border-radius: 0; background: var(--paper); color: var(--ink); font: 400 15px/1.55 Onest, sans-serif; }
.telegram-instruction:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
.telegram-manuscript:focus-visible, .telegram-select select:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
.telegram-save-state { min-height: 18px; margin: 8px 0; }
.telegram-actions, .telegram-history-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.telegram-language { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--rule); }
.telegram-language > p { color: var(--muted); font-size: 13px; line-height: 1.5; }
.telegram-language-item { padding: 12px 0; border-top: 1px solid var(--rule); }
.telegram-language-finding, .telegram-language-status { margin: 0 0 6px; color: var(--muted); font-size: 13px; }
.telegram-language-change { margin: 0 0 8px; overflow-wrap: anywhere; font: 17px/1.5 SourceSerif, Georgia, serif; }
.telegram-language-change del { color: var(--review, #945000); }
.telegram-language-change ins { color: var(--approved, #32664b); text-decoration-thickness: 1px; }
.telegram-language-select { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
.telegram-review-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--rule); font-size: 13px; }
.telegram-review-controls p { margin: 0; color: var(--approved, #32664b); }
.telegram-evidence { min-width: 0; }
.telegram-evidence h2, .telegram-history h2, .telegram-proposal h2 { margin: 0; font: 550 25px/1.3 SourceSerif, Georgia, serif; }
.telegram-evidence > p { color: var(--muted); font-size: 13px; line-height: 1.55; }
.telegram-passage-list { max-height: 750px; overflow-y: auto; }
.telegram-linked summary, .telegram-proposal summary { cursor: pointer; font-weight: 600; }
.telegram-linked p { padding: 12px 0; margin: 0; border-top: 1px solid var(--rule); }
.telegram-linked summary { padding: 12px 0; }
.telegram-proposal summary { font: 550 25px/1.3 SourceSerif, Georgia, serif; }
.telegram-linked button { text-decoration: underline; text-underline-offset: 3px; }
.telegram-evidence-item { padding: 16px 0; border-top: 1px solid var(--rule); }
.telegram-evidence-item h3 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.45; }
.telegram-evidence-item p { margin: 7px 0; color: var(--muted); font-size: 12px; }
.telegram-evidence-item blockquote { margin: 10px 0 12px; padding: 0 0 0 12px; border-left: 1px solid var(--rule); color: var(--lead-ink); font: 15px/1.5 SourceSerif, Georgia, serif; }
.telegram-source-context { max-height: 360px; overflow: auto; overflow-wrap: anywhere; }
.telegram-source-context-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.telegram-source-context-heading h3 { min-width: 0; overflow-wrap: anywhere; }
.telegram-source-context mark { background: var(--source-highlight, #edece7); color: var(--ink); text-decoration: underline; text-decoration-color: var(--muted); text-underline-offset: 3px; }
.telegram-source-error { color: var(--error); line-height: 1.5; }
.telegram-empty-evidence { padding-block: 14px; border-top: 1px solid var(--rule); }
.telegram-mapping-warning, .telegram-recovery, .telegram-error { margin: 12px 0; padding: 12px 0; border-block: 1px solid var(--rule); color: var(--review, #945000); font-size: 13px; line-height: 1.5; }
.telegram-job-state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 12px 0; padding: 10px 0; border-bottom: 1px solid var(--rule); color: var(--muted); font-size: 13px; }
.telegram-job-state p { margin: 0 auto 0 0; }
.telegram-recovery { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.telegram-recovery p { margin: 0 auto 0 0; }
.telegram-mapping-list { margin-top: 14px; border-top: 1px solid var(--rule); }
.telegram-mapping-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--rule); font: 14px/1.45 SourceSerif, Georgia, serif; }
.telegram-link-note { margin: 14px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.telegram-proposal { margin: 20px 0 28px; padding: 16px 0; border-block: 1px solid var(--rule); }
.telegram-proposal a { align-self: center; text-decoration: underline; text-underline-offset: 0.18em; }
.telegram-history { margin-top: 44px; border-top: 1px solid var(--ink); }
.telegram-history > header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 0; }
.telegram-history-entry { padding: 20px 0; border-top: 1px solid var(--rule); }
.telegram-history-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 18px; }
.telegram-history-title h3 { margin: 0; font: 550 21px/1.3 SourceSerif, Georgia, serif; }
.telegram-history-title p { margin: 0; color: var(--muted); font-size: 13px; }
.telegram-history-text { max-width: 70ch; white-space: pre-wrap; overflow-wrap: anywhere; font: 17px/1.55 SourceSerif, Georgia, serif; }
.telegram-history-entry details { margin-block: 12px; font-size: 13px; }
.telegram-history-entry summary { cursor: pointer; }
.telegram-inputs { display: grid; grid-template-columns: minmax(130px, auto) minmax(0, 1fr); gap: 5px 14px; margin: 12px 0; overflow-wrap: anywhere; }
.telegram-inputs dt { color: var(--muted); }
.telegram-inputs dd { margin: 0; }
.telegram-history-entry ul { padding-left: 20px; color: var(--muted); overflow-wrap: anywhere; }
.telegram-state { padding: 22px 0; }
.telegram-workspace :deep(button:focus-visible), .telegram-history summary:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
@media (max-width: 900px) { .telegram-layout { grid-template-columns: minmax(0, 1fr); gap: 32px; } .telegram-evidence { border-top: 1px solid var(--rule); padding-top: 20px; } .telegram-evidence-item { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; } .telegram-evidence-item blockquote { margin: 2px 0 4px; } }
@media (max-width: 600px) { .telegram-heading { align-items: start; flex-direction: column; gap: 8px; margin-bottom: 20px; } .telegram-heading h1 { font-size: 34px; } .telegram-controls { align-items: stretch; flex-direction: column; gap: 14px; } .telegram-select select { width: 100%; min-width: 0; } .telegram-manuscript { min-height: 280px; padding: 18px 16px; font-size: 18px; } .telegram-actions { align-items: stretch; flex-direction: column; } .telegram-actions > * { width: 100%; } .telegram-recovery { align-items: stretch; flex-direction: column; } .telegram-recovery > * { width: 100%; } .telegram-evidence-item { display: flex; } .telegram-inputs { grid-template-columns: minmax(0, 1fr); gap: 2px; } .telegram-inputs dd { margin-bottom: 8px; } }
@media (prefers-reduced-motion: reduce) { .telegram-workspace *, .telegram-workspace *::before, .telegram-workspace *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
</style>
