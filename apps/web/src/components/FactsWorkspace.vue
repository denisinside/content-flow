<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

interface Evidence {
  id?: string; snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string; sha256: string; relation: 'SUPPORTS' | 'CONTRADICTS'
  materialId?: string; materialLabel?: string; snapshotSequence?: number; invalidatedAt?: string | null; invalidatedBy?: string | null; invalidationReason?: string | null
}
interface Revision {
  id: string; number: number; wording: string; status: 'PROPOSED' | 'APPROVED' | 'REJECTED'; evidence: Evidence[]
  approvedAt?: string | null; approvedBy?: string | null; rejectedAt?: string | null; rejectedBy?: string | null; withdrawnAt?: string | null; withdrawnBy?: string | null; withdrawalReason?: string | null
  approvedByName?: string | null; rejectedByName?: string | null; withdrawnByName?: string | null
}
interface Claim { id: string; revision: number; currentRevisionId: string; currentRevision: Revision }
interface Conflict {
  id: string; origin: 'MANUAL' | 'DETECTED'; rationale: string; resolvedAt: string | null; resolvedBy?: string | null; selectedRevisionId?: string | null; formulation?: string | null; resolutionRationale?: string | null
  participants: { claimId: string; revisionId: string; wording: string }[]; selectedEvidenceIds: string[]
  supersedesId?: string | null; supersededById?: string | null
}
interface Basis { id: string; sequence: number; manifest: unknown; valid: boolean; blockingReasons: string[] }
interface BasisResult { mode: 'FACTUAL' | 'CREATIVE'; basis: Basis | null; eligibleClaims: Claim[]; missingBasis: boolean; unverified: boolean; blockingReasons: string[] }
interface Material { id: string; label: string; purpose: string; included: boolean; currentSnapshotId: string | null }
interface Snapshot { id: string; materialId: string; sequence: number; normalizedText: string; fragments: { id: string; startOffset: number; endOffset: number; sha256: string }[] }
interface Job { id: string; status: string; operation: string; progressStage: string; attemptCount: number; maxAttempts: number; retryAllowed: boolean; errorCategory: string | null; updatedAt: string }

const props = defineProps<{ projectId: string; projectTopic: string; csrfToken: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; back: []; projects: [] }>()
const claims = ref<Claim[]>([])
const conflicts = ref<Conflict[]>([])
const basisResult = ref<BasisResult | null>(null)
const mode = ref<'FACTUAL' | 'CREATIVE'>('FACTUAL')
const selectedBasis = ref<string[]>([])
const selected = ref<Claim | null>(null)
const displayed = ref<Revision | null>(null)
const history = ref<Revision[]>([])
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const noticeRequired = ref(false)
const message = ref('')
const editing = ref(false)
const wording = ref('')
const editorEvidence = ref<Evidence[]>([])
const editorError = ref('')
const refreshRequired = ref(false)
const materials = ref<Material[]>([])
const evidenceMaterial = ref('')
const evidenceSnapshot = ref<Snapshot | null>(null)
const fragmentId = ref('')
const excerptRange = ref<{ start: number; end: number } | null>(null)
const relation = ref<'SUPPORTS' | 'CONTRADICTS'>('SUPPORTS')
const evidenceLoading = ref(false)
const evidenceError = ref('')
const action = ref<'withdraw' | 'invalidate' | null>(null)
const actionEvidence = ref<Evidence | null>(null)
const actionReason = ref('')
const manualConflict = ref(false)
const conflictSelection = ref<string[]>([])
const conflictRationale = ref('')
const resolving = ref<Conflict | null>(null)
const resolutionRevision = ref<Revision | null>(null)
const resolutionId = ref('')
const resolutionEvidence = ref<string[]>([])
const resolutionRationale = ref('')
const reopening = ref<Conflict | null>(null)
const reopenRationale = ref('')
const jobs = ref<Job[]>([])
const jobError = ref('')
const restartConfirm = ref(false)
const activeConflicts = computed(() => conflicts.value.filter(conflict => !conflict.resolvedAt))
const currentDisplayed = computed(() => displayed.value?.id === selected.value?.currentRevisionId)
const supportingDraft = computed(() => editorEvidence.value.some(item => item.relation === 'SUPPORTS' && !item.invalidatedAt))
const chosenFragment = computed(() => evidenceSnapshot.value?.fragments.find(fragment => fragment.id === fragmentId.value) ?? null)
const fragmentQuote = computed(() => chosenFragment.value && evidenceSnapshot.value ? evidenceSnapshot.value.normalizedText.slice(chosenFragment.value.startOffset, chosenFragment.value.endOffset) : '')
const chosenQuote = computed(() => excerptRange.value ? fragmentQuote.value.slice(excerptRange.value.start, excerptRange.value.end) : fragmentQuote.value)
const selectedHasConflict = computed(() => activeConflicts.value.some(conflict => conflict.participants.some(participant => participant.claimId === selected.value?.id)))
const resolutionChoices = computed(() => resolving.value?.participants.flatMap(participant => {
  const claim = claims.value.find(item => item.id === participant.claimId)
  return claim ? [{ claimId: claim.id, revisionId: claim.currentRevisionId, wording: claim.currentRevision.wording }] : []
}) ?? [])
const latestJob = computed(() => jobs.value.find(job => job.operation === 'CLAIM_EXTRACTION') ?? null)
const jobActive = computed(() => latestJob.value && ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(latestJob.value.status))
const canApprove = computed(() => currentDisplayed.value && displayed.value?.status === 'PROPOSED' && !displayed.value.withdrawnAt && !selectedHasConflict.value && displayed.value.evidence.every(item => !item.invalidatedAt) && displayed.value.evidence.some(item => item.relation === 'SUPPORTS'))
let controller: AbortController | null = null
let evidenceController: AbortController | null = null
let jobController: AbortController | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let epoch = 0
let evidenceEpoch = 0
let jobEpoch = 0
let disposed = false
let extractionKey: string | null = null
const seenJobs = new Map<string, string>()
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}`

function status(revision: Revision) { return revision.withdrawnAt ? 'Схвалення відкликано' : ({ PROPOSED: 'Потребує перегляду', APPROVED: 'Схвалено', REJECTED: 'Відхилено' })[revision.status] }
function date(value?: string | null) { return value ? new Date(value).toLocaleString('uk-UA') : 'Не вказано' }
function blockingReason(value: string) {
  return ({ NO_ELIGIBLE_CLAIMS: 'Немає придатних схвалених тверджень.', NO_APPROVED_CLAIMS: 'Немає придатних схвалених тверджень.', MISSING_BASIS: 'Фактичну основу ще не збережено.', CLAIM_CHANGED: 'Склад тверджень змінився; перевірте основу.', WITHDRAWN: 'Схвалення використаного твердження відкликано.', INVALID_EVIDENCE: 'Використаний доказ визнано непридатним.', UNRESOLVED_CONFLICT: 'Є невирішена суперечність.' } as Record<string, string>)[value] ?? 'Основа потребує перевірки схвалень, доказів або суперечностей.'
}
function jobLabel(job: Job) { return ({ QUEUED: 'Очікує обробки', RUNNING: 'Виділяємо твердження', RETRY_WAIT: 'Очікує повторної спроби', FAILED: 'Не вдалося виділити твердження', OUTCOME_UNKNOWN: 'Результат зовнішньої обробки невідомий', CANCELLED: 'Виділення скасовано', SUCCEEDED: 'Пропозиції збережено для перегляду' } as Record<string, string>)[job.status] ?? 'Обробка джерел' }
function stageLabel(value: string) { return ({ WAITING: 'Очікування', PREPARING: 'Підготовка джерел', VALIDATING_INPUT: 'Перевірка джерел', PROCESSING: 'Зовнішня обробка', VALIDATING_OUTPUT: 'Перевірка тверджень і доказів', RETRY_WAIT: 'Очікування повторної спроби', COMPLETE: 'Готово', FAILED: 'Обробку завершено з помилкою', CANCELLED: 'Обробку скасовано' } as Record<string, string>)[value] ?? 'Обробка джерел' }
function jobFailure(job: Job) {
  if (job.status === 'OUTCOME_UNKNOWN') return 'Запит міг продовжити зовнішню обробку. Пізній результат не буде застосовано. Явний новий запуск може спричинити повторну оплату.'
  if (job.errorCategory === 'INVALID_CONTRACT') return 'Відповідь не пройшла перевірку тверджень або точних доказів. Придатні пропозиції не було додано; введіть твердження вручну.'
  if (job.errorCategory === 'CONFIG_CHANGED' || job.errorCategory === 'CONFIG') return 'Сервіс виділення не налаштовано або його версія змінилася. Можна додати твердження вручну.'
  if (job.errorCategory === 'TIMEOUT') return 'Обробка перевищила дозволений час. Попередні твердження збережено.'
  return 'Не вдалося завершити виділення. Попередні твердження збережено; перевірте джерела або додайте твердження вручну.'
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${base}${path}`, { credentials: 'same-origin', ...options })
  if (disposed) throw new DOMException('Workspace closed', 'AbortError')
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесія завершилася.') }
  if (!response.ok) {
    if (response.status === 403 && options.method) noticeRequired.value = true
    if (response.status === 409) throw new Error('Дані змінилися або ця дія більше недоступна. Ваш текст збережено у формі; перевірте актуальну версію.')
    if (response.status === 400 || response.status === 422) throw new Error('Перевірте формулювання, точний доказ та потрібні поля. Зміни залишилися у формі.')
    if (response.status === 403) throw new Error('Дія недоступна. Перевірте доступ і згоду на зовнішню обробку.')
    throw new Error('Не вдалося виконати дію. Попередні дані збережено; спробуйте ще раз.')
  }
  return response.json() as Promise<T>
}
function mutation<T>(path: string, body: unknown, method = 'POST') { return request<T>(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) }) }
function inputEvidence(item: Evidence) { return { snapshotId: item.snapshotId, fragmentId: item.fragmentId, startOffset: item.startOffset, endOffset: item.endOffset, quote: item.quote, sha256: item.sha256, relation: item.relation } }

async function allPages<T>(path: '/claims' | '/conflicts', key: 'claims' | 'conflicts', signal: AbortSignal): Promise<T[]> {
  const items: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  do {
    const page: { claims?: T[]; conflicts?: T[]; nextCursor: string | null } = await request(`${path}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { signal })
    items.push(...(page[key] ?? []))
    cursor = page.nextCursor
    if (cursor) {
      if (seen.has(cursor)) throw new Error('Не вдалося завантажити всі дані. Спробуйте оновити список.')
      seen.add(cursor)
    }
  } while (cursor)
  return items
}

async function load() {
  controller?.abort(); controller = new AbortController(); const version = ++epoch
  error.value = ''
  try {
    const result = await Promise.all([
      allPages<Claim>('/claims', 'claims', controller.signal), allPages<Conflict>('/conflicts', 'conflicts', controller.signal),
      request<BasisResult>(`/basis?mode=${mode.value}`, { signal: controller.signal }), request<{ materials: Material[] }>('/materials', { signal: controller.signal }),
    ])
    if (disposed || version !== epoch) return
    claims.value = result[0]; conflicts.value = result[1]; basisResult.value = result[2]
    materials.value = result[3].materials.filter(material => material.included && material.purpose === 'FACTUAL_SOURCE' && material.currentSnapshotId)
    selectedBasis.value = selectedBasis.value.filter(id => result[2].eligibleClaims.some(claim => claim.currentRevisionId === id))
    if (!editing.value && !resolving.value && (!displayed.value || displayed.value.id === selected.value?.currentRevisionId)) {
      const updated = claims.value.find(claim => claim.id === selected.value?.id) ?? null
      selected.value = updated; displayed.value = updated?.currentRevision ?? null
    }
  } catch (cause) { if (!disposed && version === epoch && !(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити твердження.' }
  finally { if (version === epoch) loading.value = false }
}

async function openClaim(claim: Claim, force = false) {
  if ((busy.value && !force) || editing.value) return
  selected.value = claim; displayed.value = claim.currentRevision; history.value = []; action.value = null
  if (!force) {
    await nextTick()
    document.getElementById('facts-reader-title')?.focus()
  }
  try { const result = await request<{ claim: Claim; revisions: Revision[] }>(`/claims/${encodeURIComponent(claim.id)}`); if (!disposed && selected.value?.id === claim.id && !editing.value) { const currentWasDisplayed = displayed.value?.id === claim.currentRevisionId; selected.value = result.claim; if (currentWasDisplayed) displayed.value = result.claim.currentRevision; history.value = result.revisions } }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Історія недоступна.' }
}

async function closeClaim() {
  if (busy.value || editing.value) return
  const claimId = selected.value?.id
  selected.value = null; displayed.value = null; action.value = null
  await nextTick()
  if (claimId) document.getElementById(`claim-${claimId}`)?.focus()
}

async function loadHistory() {
  const claimId = selected.value?.id
  if (!claimId || history.value.length) return
  try { const result = await request<{ claim: Claim; revisions: Revision[] }>(`/claims/${encodeURIComponent(claimId)}`); if (!disposed && selected.value?.id === claimId) history.value = result.revisions }
  catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Історія недоступна.' }
}

async function beginEdit(claim?: Claim) {
  if (busy.value || props.archived) return
  selected.value = claim ?? null; displayed.value = claim?.currentRevision ?? null
  wording.value = claim?.currentRevision.wording ?? ''; editorEvidence.value = claim?.currentRevision.evidence.map(item => ({ ...item })) ?? []
  editorError.value = ''; refreshRequired.value = false; editing.value = true; action.value = null
  evidenceSnapshot.value = null; evidenceMaterial.value = ''; fragmentId.value = ''; evidenceError.value = ''
  await nextTick(); document.getElementById('claim-wording')?.focus()
}

async function loadEvidence() {
  evidenceController?.abort(); evidenceController = new AbortController(); const version = ++evidenceEpoch
  evidenceSnapshot.value = null; fragmentId.value = ''; evidenceError.value = ''
  const material = materials.value.find(item => item.id === evidenceMaterial.value)
  if (!material?.currentSnapshotId) return
  evidenceLoading.value = true
  try {
    const result = await request<{ snapshot: Snapshot }>(`/materials/${encodeURIComponent(material.id)}/snapshots/${encodeURIComponent(material.currentSnapshotId)}`, { signal: evidenceController.signal })
    if (!disposed && version === evidenceEpoch) evidenceSnapshot.value = result.snapshot
  } catch (cause) { if (version === evidenceEpoch && !(cause instanceof DOMException && cause.name === 'AbortError')) evidenceError.value = cause instanceof Error ? cause.message : 'Доказ недоступний.' }
  finally { if (version === evidenceEpoch) evidenceLoading.value = false }
}
watch(evidenceMaterial, () => void loadEvidence())
watch(fragmentId, () => { excerptRange.value = null })
function chooseExcerpt() {
  const input = document.getElementById('evidence-select-text') as HTMLTextAreaElement | null
  if (input && input.selectionEnd > input.selectionStart) excerptRange.value = { start: input.selectionStart, end: input.selectionEnd }
}
async function addEvidence() {
  const fragment = chosenFragment.value, snapshot = evidenceSnapshot.value
  if (!fragment || !snapshot || busy.value || !chosenQuote.value.length || chosenQuote.value.length > 10000 || editorEvidence.value.length >= 10) return
  const quote = chosenQuote.value, startOffset = fragment.startOffset + (excerptRange.value?.start ?? 0), endOffset = fragment.startOffset + (excerptRange.value?.end ?? fragmentQuote.value.length)
  if (editorEvidence.value.some(item => item.snapshotId === snapshot.id && item.fragmentId === fragment.id && item.startOffset === startOffset && item.endOffset === endOffset && item.relation === relation.value)) return
  const hash = excerptRange.value ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(quote)))).map(value => value.toString(16).padStart(2, '0')).join('') : fragment.sha256
  if (disposed || !editing.value || evidenceSnapshot.value?.id !== snapshot.id || fragmentId.value !== fragment.id) return
  editorEvidence.value.push({ snapshotId: snapshot.id, fragmentId: fragment.id, startOffset, endOffset, quote, sha256: hash, relation: relation.value, materialId: evidenceMaterial.value, materialLabel: materials.value.find(item => item.id === evidenceMaterial.value)?.label ?? 'Фактичне джерело', snapshotSequence: snapshot.sequence })
  fragmentId.value = ''
}

async function saveClaim() {
  if (busy.value || props.archived || !wording.value.trim() || !supportingDraft.value) return
  busy.value = true; editorError.value = ''; noticeRequired.value = false
  try {
    const result = await mutation<{ claim: Claim }>(selected.value ? `/claims/${encodeURIComponent(selected.value.id)}` : '/claims', { ...(selected.value ? { expectedRevision: selected.value.revision } : {}), wording: wording.value.trim(), evidence: editorEvidence.value.map(inputEvidence) }, selected.value ? 'PATCH' : 'POST')
    if (disposed) return
    editing.value = false; refreshRequired.value = false; selected.value = result.claim; displayed.value = result.claim.currentRevision
    message.value = 'Твердження збережено як пропозицію. Схвалення потребує окремої дії.'; await load(); await openClaim(result.claim, true)
  } catch (cause) { if (!disposed) { editorError.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти твердження.'; refreshRequired.value = !!selected.value } }
  finally { busy.value = false }
}
async function refreshDraft() {
  if (!selected.value || busy.value) return
  busy.value = true
  try { const result = await request<{ claim: Claim; revisions: Revision[] }>(`/claims/${encodeURIComponent(selected.value.id)}`); if (!disposed) { selected.value = result.claim; displayed.value = result.claim.currentRevision; history.value = result.revisions; refreshRequired.value = false; editorError.value = 'Актуальну версію завантажено. Ваше формулювання й обрані докази залишилися у формі.' } }
  catch (cause) { editorError.value = cause instanceof Error ? cause.message : 'Не вдалося оновити версію; ваш текст залишився у формі.' }
  finally { busy.value = false }
}

async function review(kind: 'approve' | 'reject' | 'withdraw' | 'invalidate') {
  if (!selected.value || !displayed.value || busy.value || props.archived || !currentDisplayed.value) return
  if (kind === 'invalidate' && (!actionEvidence.value?.id || !actionReason.value.trim())) return
  busy.value = true; error.value = ''; noticeRequired.value = false
  const path = kind === 'invalidate' ? `/claims/${selected.value.id}/evidence/${actionEvidence.value!.id}/invalidate` : `/claims/${selected.value.id}/revisions/${displayed.value.id}/${kind}`
  try {
    const result = await mutation<{ claim: Claim }>(path, { expectedRevision: selected.value.revision, ...((kind === 'withdraw' || kind === 'invalidate') && actionReason.value.trim() ? { reason: actionReason.value.trim() } : {}) })
    if (disposed) return
    selected.value = result.claim; displayed.value = result.claim.currentRevision; action.value = null; actionReason.value = ''
    message.value = kind === 'approve' ? 'Цю версію схвалено.' : kind === 'reject' ? 'Пропозицію відхилено.' : kind === 'withdraw' ? 'Схвалення відкликано. Для відновлення потрібна нова версія.' : 'Доказ визнано непридатним. Історичний уривок збережено.'
    await load(); await openClaim(result.claim, true)
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати перегляд.' }
  finally { busy.value = false }
}

async function beginReviewAction(kind: 'withdraw' | 'invalidate', proof?: Evidence) {
  action.value = kind; actionEvidence.value = proof ?? null; actionReason.value = ''
  await nextTick(); document.getElementById('review-reason')?.focus()
}

async function createConflict() {
  if (busy.value || conflictSelection.value.length < 2 || !conflictRationale.value.trim() || props.archived) return
  busy.value = true; error.value = ''
  try { await mutation('/conflicts', { revisionIds: conflictSelection.value, rationale: conflictRationale.value.trim() }); manualConflict.value = false; conflictSelection.value = []; conflictRationale.value = ''; await load() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося записати суперечність.' }
  finally { busy.value = false }
}
async function beginResolve(conflict: Conflict) { resolving.value = conflict; resolutionId.value = ''; resolutionRevision.value = null; resolutionRationale.value = ''; resolutionEvidence.value = []; await nextTick(); document.getElementById('resolution-revision')?.focus() }
async function chooseResolution() {
  const participant = resolutionChoices.value.find(item => item.revisionId === resolutionId.value)
  resolutionRevision.value = null; resolutionEvidence.value = []
  if (!participant) return
  try { const result = await request<{ claim: Claim; revisions: Revision[] }>(`/claims/${encodeURIComponent(participant.claimId)}`); if (!disposed && resolutionId.value === participant.revisionId) { if (result.claim.currentRevisionId !== participant.revisionId) throw new Error('Твердження змінилося. Оновіть список і знову оберіть поточне формулювання.'); resolutionRevision.value = result.claim.currentRevision; resolutionEvidence.value = resolutionRevision.value.evidence.filter(item => item.relation === 'SUPPORTS' && !item.invalidatedAt && item.id).map(item => item.id!) } }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити докази.' }
}
watch(resolutionId, () => void chooseResolution())
async function resolveConflict() {
  if (!resolving.value || !resolutionRevision.value || !resolutionEvidence.value.length || !resolutionRationale.value.trim() || busy.value || props.archived) return
  busy.value = true; error.value = ''
  try { await mutation(`/conflicts/${resolving.value.id}/resolve`, { selectedRevisionId: resolutionRevision.value.id, selectedEvidenceIds: resolutionEvidence.value, formulation: resolutionRevision.value.wording, rationale: resolutionRationale.value.trim() }); resolving.value = null; message.value = 'Рішення записано з формулюванням, доказами й поясненням. Схвалення твердження залишається окремою дією.'; await load() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося записати рішення.' }
  finally { busy.value = false }
}

async function reopenConflict() {
  if (!reopening.value || !reopenRationale.value.trim() || busy.value || editing.value || props.archived) return
  busy.value = true; error.value = ''
  try { await mutation(`/conflicts/${reopening.value.id}/reopen`, { rationale: reopenRationale.value.trim() }); reopening.value = null; reopenRationale.value = ''; message.value = 'Суперечність відкрито для поточних версій. Попереднє рішення залишається в історії.'; await load() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося почати новий перегляд рішення.' }
  finally { busy.value = false }
}
async function beginReopen(conflict: Conflict) { reopening.value = conflict; reopenRationale.value = ''; await nextTick(); document.getElementById('reopen-rationale')?.focus() }

async function changeMode() { selectedBasis.value = []; await load() }
async function freezeBasis() {
  if (busy.value || !selectedBasis.value.length || props.archived) return
  busy.value = true; error.value = ''
  try { await mutation('/basis', { claimRevisionIds: selectedBasis.value }); message.value = 'Фактичну основу збережено з точними схваленими версіями.'; await load() }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти основу.' }
  finally { busy.value = false }
}

async function pollJobs() {
  if (disposed) return
  clearTimeout(timer); jobController?.abort(); jobController = new AbortController(); const version = ++jobEpoch
  try {
    const result = await request<{ jobs: Job[] }>('/jobs', { signal: jobController.signal })
    if (disposed || version !== jobEpoch) return
    jobs.value = result.jobs.filter(job => job.operation === 'CLAIM_EXTRACTION'); jobError.value = ''
    for (const job of jobs.value) {
      const previous = seenJobs.get(job.id); seenJobs.set(job.id, job.status)
      if (job.status === 'SUCCEEDED' && previous !== 'SUCCEEDED') { message.value = 'Нові пропозиції збережено для перегляду. Жодне твердження не схвалено автоматично.'; if (!busy.value) await load() }
    }
  } catch (cause) { if (!disposed && version === jobEpoch && !(cause instanceof DOMException && cause.name === 'AbortError')) jobError.value = 'Не вдалося оновити стан виділення. Перевірте стан ще раз.' }
  finally { if (!disposed && version === jobEpoch) timer = setTimeout(() => void pollJobs(), jobActive.value ? 2000 : 5000) }
}
async function extract(explicitNewRun = false) {
  if (busy.value || editing.value || props.archived || jobActive.value) return
  if (!explicitNewRun && latestJob.value?.status === 'OUTCOME_UNKNOWN') { restartConfirm.value = true; message.value = 'Підтвердьте явний новий запуск нижче. Попередня зовнішня обробка могла продовжитися й спричинити витрати.'; return }
  if (explicitNewRun) extractionKey = null
  extractionKey ??= crypto.randomUUID(); busy.value = true; error.value = ''; noticeRequired.value = false
  try { await mutation('/claims/extract', { commandKey: extractionKey }); if (!disposed) { extractionKey = null; restartConfirm.value = false; message.value = 'Виділення прийнято. Перевірте запропоновані твердження перед схваленням.'; await pollJobs(); await load() } }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося запустити виділення.' }
  finally { busy.value = false }
}
async function jobAction(kind: 'retry' | 'cancel') {
  if (!latestJob.value || busy.value || props.archived) return
  busy.value = true; jobError.value = ''; jobEpoch += 1; clearTimeout(timer); jobController?.abort()
  try { await mutation(`/jobs/${latestJob.value.id}/${kind}`, {}); await pollJobs() }
  catch { jobError.value = 'Стан змінився або ця дія недоступна. Оновіть стан і спробуйте ще раз.' }
  finally { busy.value = false }
}

onMounted(() => { void load(); void pollJobs() })
onBeforeUnmount(() => { disposed = true; epoch += 1; evidenceEpoch += 1; jobEpoch += 1; controller?.abort(); evidenceController?.abort(); jobController?.abort(); clearTimeout(timer) })
</script>

<template>
  <div
    class="facts-workspace author-desk-task"
    :data-workspace-leave-risk="editing || busy || !!action || manualConflict || !!resolving || !!reopening"
  >
    <header class="facts-heading">
      <h1 id="facts-title">
        Фактична основа
      </h1><p class="facts-lead">
        Перевірте твердження перед використанням у тексті.
      </p>
    </header>
    <Alert
      v-if="error"
      variant="destructive"
      class="facts-alert"
      role="alert"
    >
      <AlertTitle>Не вдалося виконати дію</AlertTitle><AlertDescription>{{ error }}</AlertDescription><a
        v-if="noticeRequired"
        href="#external-processing-notice"
      >Переглянути повідомлення й надати потрібну згоду</a>
    </Alert>
    <div class="facts-toolbar">
      <Button
        class="facts-button facts-primary"
        :disabled="busy || loading || editing || archived || !materials.length || !!jobActive"
        @click="extract()"
      >
        Виділити твердження
      </Button><Button
        class="facts-button"
        variant="outline"
        :disabled="busy || loading || editing || archived"
        @click="beginEdit()"
      >
        Додати твердження вручну
      </Button><Button
        class="facts-button"
        variant="ghost"
        :disabled="busy || editing"
        @click="load"
      >
        Оновити твердження
      </Button>
    </div>
    <p
      v-if="!loading && !materials.length"
      class="facts-muted"
    >
      Для виділення додайте фактичні джерела зі збереженим текстом і включіть їх у проєкт.
    </p>
    <p
      v-if="message"
      role="status"
      class="facts-message"
    >
      {{ message }}
    </p>
    <section
      v-if="latestJob && latestJob.status !== 'SUCCEEDED' || jobError"
      class="facts-job"
      aria-labelledby="facts-job-title"
    >
      <div class="facts-section-heading">
        <h3 id="facts-job-title">
          Виділення тверджень
        </h3><Button
          class="facts-button"
          variant="ghost"
          @click="pollJobs"
        >
          Оновити стан виділення
        </Button>
      </div>
      <p
        v-if="jobError"
        role="alert"
      >
        {{ jobError }}
      </p>
      <template v-if="latestJob">
        <p role="status">
          {{ jobLabel(latestJob) }}
        </p><p
          v-if="jobActive"
          class="facts-muted"
        >
          {{ stageLabel(latestJob.progressStage) }}
        </p><p
          v-if="['FAILED', 'OUTCOME_UNKNOWN'].includes(latestJob.status)"
          class="facts-message"
        >
          {{ jobFailure(latestJob) }}
        </p><div class="facts-actions">
          <Button
            v-if="jobActive"
            class="facts-button"
            variant="outline"
            :disabled="busy || archived"
            @click="jobAction('cancel')"
          >
            Скасувати виділення
          </Button><Button
            v-if="latestJob.retryAllowed"
            class="facts-button"
            variant="outline"
            :disabled="busy || archived"
            @click="jobAction('retry')"
          >
            Повторити спробу виділення
          </Button><Button
            v-if="['FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN'].includes(latestJob.status)"
            class="facts-button"
            variant="outline"
            :disabled="busy || editing || archived"
            @click="beginEdit()"
          >
            Додати вручну
          </Button><Button
            v-if="['CANCELLED', 'OUTCOME_UNKNOWN'].includes(latestJob.status)"
            class="facts-button"
            variant="outline"
            :disabled="busy || editing || archived"
            @click="restartConfirm ? extract(true) : restartConfirm = true"
          >
            {{ restartConfirm ? 'Підтвердити новий запуск виділення' : 'Запустити виділення знову' }}
          </Button><Button
            v-if="restartConfirm"
            class="facts-button"
            variant="ghost"
            @click="restartConfirm = false"
          >
            Залишити без змін
          </Button>
        </div><p
          v-if="jobActive || restartConfirm"
          class="facts-muted"
        >
          Зовнішня обробка й витрати можуть продовжитися після скасування. Новий запуск може спричинити повторну оплату.
        </p><details class="facts-details">
          <summary>Деталі виконання</summary><dl><dt>Етап</dt><dd>{{ stageLabel(latestJob.progressStage) }}</dd><dt>Спроби</dt><dd>{{ latestJob.attemptCount }} / {{ latestJob.maxAttempts }}</dd><dt>Оновлено</dt><dd>{{ date(latestJob.updatedAt) }}</dd><dt>Ідентифікатор</dt><dd>{{ latestJob.id }}</dd></dl>
        </details>
      </template>
    </section>
    <p
      v-if="loading"
      role="status"
      class="facts-muted"
    >
      Завантажуємо твердження, докази й основу…
    </p>
    <div
      v-else
      class="facts-columns"
      :class="{ 'with-reader': selected || editing }"
    >
      <section
        class="facts-list"
        aria-labelledby="facts-list-title"
      >
        <div class="facts-section-heading">
          <h3 id="facts-list-title">
            Твердження для перегляду
          </h3><span class="facts-muted">{{ claims.length }}</span>
        </div><p
          v-if="!claims.length"
          class="facts-muted"
        >
          Тверджень поки немає. Виділіть пропозиції з джерел або додайте підтверджене твердження вручну.
        </p><ul
          v-else
          class="claim-list"
        >
          <li
            v-for="claim in claims"
            :key="claim.id"
            :class="{ 'claim-selected': selected?.id === claim.id }"
          >
            <button
              :id="`claim-${claim.id}`"
              type="button"
              class="claim-open"
              :disabled="busy || editing"
              :aria-current="selected?.id === claim.id ? 'true' : undefined"
              @click="openClaim(claim)"
            >
              <span
                class="claim-status"
                :class="{ 'claim-approved': claim.currentRevision.status === 'APPROVED' && !claim.currentRevision.withdrawnAt }"
              >{{ status(claim.currentRevision) }}</span>
              <span class="claim-wording">{{ claim.currentRevision.wording }}</span>
            </button>
            <div class="claim-inline-evidence">
              <div
                v-for="item in claim.currentRevision.evidence"
                :key="item.id || `${item.snapshotId}-${item.fragmentId}-${item.startOffset}-${item.relation}`"
                class="claim-inline-excerpt"
              >
                <p class="evidence-attribution">
                  {{ item.materialLabel || 'Фактичне джерело' }}<template v-if="item.snapshotSequence">
                    · Версія {{ item.snapshotSequence }}
                  </template>
                  · {{ item.relation === 'SUPPORTS' ? 'Підтверджує' : 'Суперечить' }}
                </p>
                <blockquote>{{ item.quote }}</blockquote>
                <p
                  v-if="item.invalidatedAt"
                  class="facts-warning"
                >
                  Доказ визнано непридатним: {{ item.invalidationReason }}
                </p>
              </div>
              <Button
                class="facts-button"
                variant="ghost"
                :disabled="busy || editing"
                @click="openClaim(claim)"
              >
                {{ claim.currentRevision.status === 'PROPOSED' ? 'Переглянути й схвалити' : 'Історія та дії' }}
              </Button>
            </div>
          </li>
        </ul>
      </section>
      <section
        v-if="selected || editing"
        class="facts-reader"
        aria-labelledby="facts-reader-title"
        @keydown.esc.stop="closeClaim"
      >
        <form
          v-if="editing"
          class="claim-editor"
          @submit.prevent="saveClaim"
        >
          <h3 id="facts-reader-title">
            {{ selected ? 'Нова версія твердження' : 'Нове твердження' }}
          </h3><p
            v-if="selected?.currentRevision.status === 'APPROVED'"
            class="facts-muted"
          >
            Попереднє схвалення та докази зберігаються. Нову версію потрібно переглянути й схвалити окремо.
          </p><Field class="facts-field">
            <FieldLabel for="claim-wording">
              Формулювання твердження
            </FieldLabel><Textarea
              id="claim-wording"
              v-model="wording"
              rows="4"
              maxlength="2000"
              class="facts-input"
              :disabled="busy"
              required
            /><FieldDescription>Одне перевірюване твердження. Обов’язково додайте підтверджувальний доказ.</FieldDescription>
          </Field>
          <div class="evidence-editor">
            <h4>Обрані докази</h4><p
              v-if="!editorEvidence.length"
              class="facts-muted"
            >
              Додайте точний уривок зі збереженої версії фактичного джерела.
            </p><ul class="evidence-list">
              <li
                v-for="(item, index) in editorEvidence"
                :key="`${item.snapshotId}-${item.fragmentId}-${item.startOffset}-${item.endOffset}-${item.relation}`"
              >
                <p class="evidence-attribution">
                  {{ item.materialLabel || 'Фактичне джерело' }}<template v-if="item.snapshotSequence">
                    · Версія {{ item.snapshotSequence }}
                  </template> · {{ item.relation === 'SUPPORTS' ? 'Підтверджує' : 'Суперечить' }}
                </p><blockquote>{{ item.quote }}</blockquote><p
                  v-if="item.invalidatedAt"
                  class="facts-warning"
                >
                  Доказ визнано непридатним.
                </p><Button
                  class="facts-button"
                  variant="ghost"
                  type="button"
                  :disabled="busy"
                  @click="editorEvidence.splice(index, 1)"
                >
                  Прибрати доказ із нової версії
                </Button>
              </li>
            </ul>
          </div>
          <fieldset class="evidence-picker">
            <legend>Додати доказ із джерела</legend><Field class="facts-field">
              <FieldLabel for="evidence-material">
                Фактичне джерело
              </FieldLabel><select
                id="evidence-material"
                v-model="evidenceMaterial"
                class="facts-input"
                :disabled="busy"
              >
                <option value="">
                  Оберіть включене джерело
                </option><option
                  v-for="material in materials"
                  :key="material.id"
                  :value="material.id"
                >
                  {{ material.label }}
                </option>
              </select>
            </Field><p
              v-if="evidenceLoading"
              role="status"
              class="facts-muted"
            >
              Відкриваємо збережений текст…
            </p><p
              v-if="evidenceError"
              role="alert"
              class="facts-warning"
            >
              {{ evidenceError }}
            </p><template v-if="evidenceSnapshot">
              <Field class="facts-field">
                <FieldLabel for="evidence-fragment">
                  Уривок · Версія {{ evidenceSnapshot.sequence }}
                </FieldLabel><select
                  id="evidence-fragment"
                  v-model="fragmentId"
                  class="facts-input"
                  :disabled="busy"
                >
                  <option value="">
                    Оберіть точний уривок
                  </option><option
                    v-for="(fragment, index) in evidenceSnapshot.fragments"
                    :key="fragment.id"
                    :value="fragment.id"
                  >
                    Уривок {{ index + 1 }} — {{ evidenceSnapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset).slice(0, 70) }}
                  </option>
                </select>
              </Field><blockquote
                v-if="chosenFragment"
                class="evidence-preview"
              >
                {{ chosenQuote }}
              </blockquote>
              <p
                v-if="chosenQuote.length > 10000"
                class="facts-warning"
              >
                Уривок завеликий для одного доказу. Оберіть його частину до 10 000 символів.
              </p>
              <details
                v-if="chosenFragment"
                class="facts-details"
              >
                <summary>Обрати частину уривка</summary>
                <Field class="facts-field">
                  <FieldLabel for="evidence-select-text">
                    Виділіть точний текст у збереженому уривку
                  </FieldLabel><Textarea
                    id="evidence-select-text"
                    :model-value="fragmentQuote"
                    class="facts-input"
                    rows="5"
                    readonly
                  /><FieldDescription>Виділіть потрібну частину мишею або клавіатурою, потім використайте виділений текст. Саме джерело не змінюється.</FieldDescription>
                </Field>
                <div class="facts-actions">
                  <Button
                    class="facts-button"
                    variant="outline"
                    type="button"
                    :disabled="busy"
                    @click="chooseExcerpt"
                  >
                    Використати виділений текст
                  </Button><Button
                    v-if="excerptRange"
                    class="facts-button"
                    variant="ghost"
                    type="button"
                    :disabled="busy"
                    @click="excerptRange = null"
                  >
                    Використати весь уривок
                  </Button>
                </div>
              </details><Field class="facts-field">
                <FieldLabel for="evidence-relation">
                  Зв’язок із твердженням
                </FieldLabel><select
                  id="evidence-relation"
                  v-model="relation"
                  class="facts-input"
                >
                  <option value="SUPPORTS">
                    Підтверджує
                  </option><option value="CONTRADICTS">
                    Суперечить
                  </option>
                </select>
              </Field><Button
                class="facts-button"
                variant="outline"
                type="button"
                :disabled="busy || !chosenFragment || !chosenQuote.length || chosenQuote.length > 10000 || editorEvidence.length >= 10"
                @click="addEvidence"
              >
                Додати обраний доказ
              </Button>
            </template>
          </fieldset>
          <p
            v-if="editorError"
            role="alert"
            class="facts-warning"
          >
            {{ editorError }}
          </p><Button
            v-if="refreshRequired"
            class="facts-button"
            variant="outline"
            type="button"
            :disabled="busy"
            @click="refreshDraft"
          >
            Оновити версію, зберігши мій текст
          </Button><div class="facts-actions">
            <Button
              class="facts-button facts-primary"
              type="submit"
              :disabled="busy || !wording.trim() || !supportingDraft"
            >
              {{ busy ? 'Зберігаємо…' : 'Зберегти пропозицію' }}
            </Button><Button
              class="facts-button"
              variant="ghost"
              type="button"
              :disabled="busy"
              @click="editing = false; editorError = ''"
            >
              Скасувати редагування
            </Button>
          </div>
        </form>
        <template v-else-if="selected && displayed">
          <div class="facts-section-heading">
            <h3
              id="facts-reader-title"
              tabindex="-1"
            >
              Перегляд твердження
            </h3><div class="facts-actions">
              <span class="claim-status">{{ status(displayed) }}</span><Button
                class="facts-button"
                variant="ghost"
                :disabled="busy"
                @click="closeClaim"
              >
                До тверджень
              </Button>
            </div>
          </div><p class="claim-document">
            {{ displayed.wording }}
          </p><p
            v-if="!currentDisplayed"
            class="facts-muted"
          >
            Історична версія {{ displayed.number }}. Дії перегляду доступні для поточної версії.
          </p><p
            v-if="selectedHasConflict"
            class="facts-warning"
          >
            Є невирішена суперечність. Перегляньте її перед схваленням і використанням твердження.
          </p><div
            v-if="currentDisplayed && !archived"
            class="facts-actions"
          >
            <Button
              v-if="displayed.status === 'PROPOSED'"
              class="facts-button facts-primary"
              :disabled="busy || !canApprove"
              @click="review('approve')"
            >
              Схвалити твердження
            </Button><Button
              v-if="displayed.status === 'PROPOSED'"
              class="facts-button"
              variant="outline"
              :disabled="busy"
              @click="review('reject')"
            >
              Відхилити пропозицію
            </Button><Button
              class="facts-button"
              variant="ghost"
              :disabled="busy"
              @click="beginEdit(selected)"
            >
              Створити нову версію
            </Button><Button
              v-if="displayed.status === 'APPROVED' && !displayed.withdrawnAt"
              class="facts-button"
              variant="ghost"
              :disabled="busy"
              @click="beginReviewAction('withdraw')"
            >
              Відкликати схвалення
            </Button>
          </div>
          <form
            v-if="action"
            class="review-action"
            @submit.prevent="review(action)"
          >
            <Field class="facts-field">
              <FieldLabel for="review-reason">
                {{ action === 'withdraw' ? 'Причина відкликання (необов’язково)' : 'Чому доказ непридатний' }}
              </FieldLabel><Textarea
                id="review-reason"
                v-model="actionReason"
                rows="2"
                maxlength="2000"
                class="facts-input"
                :required="action === 'invalidate'"
                :disabled="busy"
              />
            </Field><div class="facts-actions">
              <Button
                class="facts-button"
                variant="outline"
                type="submit"
                :disabled="busy || (action === 'invalidate' && !actionReason.trim())"
              >
                {{ action === 'withdraw' ? 'Підтвердити відкликання' : 'Визнати доказ непридатним' }}
              </Button><Button
                class="facts-button"
                variant="ghost"
                type="button"
                :disabled="busy"
                @click="action = null"
              >
                Залишити без змін
              </Button>
            </div>
          </form>
          <div class="claim-evidence">
            <h4>Точні докази</h4><ul class="evidence-list">
              <li
                v-for="item in displayed.evidence"
                :key="item.id || item.fragmentId"
              >
                <p class="evidence-attribution">
                  {{ item.materialLabel || 'Фактичне джерело' }}<template v-if="item.snapshotSequence">
                    · Версія {{ item.snapshotSequence }}
                  </template> · {{ item.relation === 'SUPPORTS' ? 'Підтверджує' : 'Суперечить' }}
                </p><blockquote>{{ item.quote }}</blockquote><p
                  v-if="item.invalidatedAt"
                  class="facts-warning"
                >
                  Доказ визнано непридатним: {{ item.invalidationReason }}
                </p><details class="facts-details">
                  <summary>Деталі доказу</summary><dl><dt>Діапазон</dt><dd>{{ item.startOffset }}–{{ item.endOffset }}</dd><dt>Версія джерела</dt><dd>{{ item.snapshotId }}</dd><dt>Фрагмент</dt><dd>{{ item.fragmentId }}</dd><dt>SHA-256</dt><dd>{{ item.sha256 }}</dd></dl>
                  <Button
                    v-if="currentDisplayed && !item.invalidatedAt && !archived"
                    class="facts-button"
                    variant="ghost"
                    :disabled="busy"
                    @click="beginReviewAction('invalidate', item)"
                  >
                    Позначити доказ непридатним
                  </Button>
                </details>
              </li>
            </ul>
          </div>
          <details
            class="facts-details"
            @toggle="($event.target as HTMLDetailsElement).open ? loadHistory() : undefined"
          >
            <summary>Історія та схвалення</summary><dl>
              <dt>Версія</dt><dd>{{ displayed.number }}</dd><template v-if="displayed.approvedAt">
                <dt>Схвалено</dt><dd>{{ date(displayed.approvedAt) }} · {{ displayed.approvedByName || displayed.approvedBy }}</dd>
              </template><template v-if="displayed.rejectedAt">
                <dt>Відхилено</dt><dd>{{ date(displayed.rejectedAt) }} · {{ displayed.rejectedByName || displayed.rejectedBy }}</dd>
              </template><template v-if="displayed.withdrawnAt">
                <dt>Відкликано</dt><dd>{{ date(displayed.withdrawnAt) }} · {{ displayed.withdrawnByName || displayed.withdrawnBy }}<span v-if="displayed.withdrawalReason"> · {{ displayed.withdrawalReason }}</span></dd>
              </template>
            </dl><ul class="claim-history">
              <li
                v-for="revision in history"
                :key="revision.id"
              >
                <button
                  type="button"
                  :aria-current="displayed.id === revision.id ? 'true' : undefined"
                  :disabled="busy"
                  @click="displayed = revision; action = null"
                >
                  Версія {{ revision.number }} · {{ status(revision) }}{{ revision.id === selected.currentRevisionId ? ' · Поточна' : '' }}
                </button>
              </li>
            </ul>
          </details>
        </template>
      </section>
    </div>
    <section
      v-if="!loading"
      class="facts-conflicts"
      aria-labelledby="facts-conflicts-title"
    >
      <div class="facts-section-heading">
        <div>
          <h3 id="facts-conflicts-title">
            Суперечності
          </h3>
        </div><Button
          class="facts-button"
          variant="outline"
          :disabled="busy || editing || archived || claims.length < 2"
          @click="manualConflict = !manualConflict"
        >
          Позначити суперечність
        </Button>
      </div><p
        v-if="!activeConflicts.length"
        class="facts-muted"
      >
        Невирішених суперечностей немає.
      </p>
      <form
        v-if="manualConflict"
        class="conflict-form"
        @submit.prevent="createConflict"
      >
        <fieldset>
          <legend>Які твердження суперечать одне одному?</legend><label
            v-for="claim in claims"
            :key="claim.id"
            class="facts-check"
          ><input
            v-model="conflictSelection"
            type="checkbox"
            :value="claim.currentRevisionId"
            :disabled="busy"
          >{{ claim.currentRevision.wording }}</label>
        </fieldset><Field class="facts-field">
          <FieldLabel for="conflict-rationale">
            Пояснення суперечності
          </FieldLabel><Textarea
            id="conflict-rationale"
            v-model="conflictRationale"
            rows="3"
            class="facts-input"
            maxlength="2000"
            :disabled="busy"
            required
          />
        </Field><div class="facts-actions">
          <Button
            class="facts-button"
            variant="outline"
            type="submit"
            :disabled="busy || conflictSelection.length < 2 || !conflictRationale.trim()"
          >
            Записати суперечність
          </Button><Button
            class="facts-button"
            variant="ghost"
            type="button"
            :disabled="busy"
            @click="manualConflict = false"
          >
            Закрити форму
          </Button>
        </div>
      </form>
      <ul class="conflict-list">
        <li
          v-for="conflict in activeConflicts"
          :key="conflict.id"
        >
          <p class="facts-muted">
            {{ conflict.origin === 'DETECTED' ? 'Виявлена під час виділення' : 'Позначена вручну' }}
          </p><p>{{ conflict.rationale }}</p><ul>
            <li
              v-for="participant in conflict.participants"
              :key="participant.revisionId"
            >
              {{ participant.wording }}
            </li>
          </ul><Button
            class="facts-button"
            variant="outline"
            :disabled="busy || editing || archived"
            @click="beginResolve(conflict)"
          >
            Переглянути рішення
          </Button>
        </li>
      </ul>
      <form
        v-if="resolving"
        class="resolution-form"
        @submit.prevent="resolveConflict"
      >
        <h4>Вирішення суперечності</h4><Field class="facts-field">
          <FieldLabel for="resolution-revision">
            Обране формулювання
          </FieldLabel><select
            id="resolution-revision"
            v-model="resolutionId"
            class="facts-input"
            :disabled="busy"
          >
            <option value="">
              Оберіть збережену версію твердження
            </option><option
              v-for="participant in resolutionChoices"
              :key="participant.revisionId"
              :value="participant.revisionId"
            >
              {{ participant.wording }}
            </option>
          </select><FieldDescription>Для іншого формулювання спочатку створіть нову версію твердження.</FieldDescription>
        </Field><template v-if="resolutionRevision">
          <p class="claim-document">
            {{ resolutionRevision.wording }}
          </p><fieldset>
            <legend>Докази рішення</legend><label
              v-for="item in resolutionRevision.evidence.filter(item => item.relation === 'SUPPORTS' && !item.invalidatedAt)"
              :key="item.id"
              class="facts-check"
            ><input
              v-model="resolutionEvidence"
              type="checkbox"
              :value="item.id"
              :disabled="busy"
            ><span>{{ item.materialLabel || 'Джерело' }} · {{ item.quote }}</span></label>
          </fieldset>
        </template><Field class="facts-field">
          <FieldLabel for="resolution-rationale">
            Чому обрано це формулювання й докази
          </FieldLabel><Textarea
            id="resolution-rationale"
            v-model="resolutionRationale"
            rows="3"
            maxlength="2000"
            class="facts-input"
            :disabled="busy"
            required
          />
        </Field><div class="facts-actions">
          <Button
            class="facts-button"
            variant="outline"
            type="submit"
            :disabled="busy || !resolutionRevision || !resolutionEvidence.length || !resolutionRationale.trim()"
          >
            Записати рішення
          </Button><Button
            class="facts-button"
            variant="ghost"
            type="button"
            :disabled="busy"
            @click="resolving = null"
          >
            Закрити рішення
          </Button>
        </div>
      </form>
      <details
        v-if="conflicts.some(conflict => conflict.resolvedAt)"
        class="facts-details resolved-conflicts"
      >
        <summary>Вирішені суперечності</summary><ul class="conflict-list">
          <li
            v-for="conflict in conflicts.filter(conflict => conflict.resolvedAt)"
            :key="conflict.id"
          >
            <p>{{ conflict.formulation }}</p><p>{{ conflict.resolutionRationale }}</p><p class="facts-muted">
              {{ date(conflict.resolvedAt) }} · {{ conflict.resolvedBy }}
            </p><p
              v-if="conflict.supersededById"
              class="facts-muted"
            >
              Історичне рішення. Для цих тверджень записано новий перегляд.
            </p>
            <Button
              v-else
              class="facts-button"
              variant="outline"
              :disabled="busy || editing || archived"
              @click="beginReopen(conflict)"
            >
              Переглянути рішення
            </Button>
            <details class="facts-details">
              <summary>Записані докази рішення</summary><p>{{ conflict.selectedEvidenceIds.join(', ') }}</p>
            </details>
          </li>
        </ul>
      </details>
      <form
        v-if="reopening"
        class="resolution-form"
        @submit.prevent="reopenConflict"
      >
        <h4>Новий перегляд рішення</h4><p class="facts-muted">
          Поточні версії тверджень утворять нову суперечність. Попереднє рішення та його докази залишаться в історії.
        </p>
        <Field class="facts-field">
          <FieldLabel for="reopen-rationale">
            Чому рішення потрібно переглянути
          </FieldLabel><Textarea
            id="reopen-rationale"
            v-model="reopenRationale"
            class="facts-input"
            rows="3"
            maxlength="2000"
            :disabled="busy"
            required
          />
        </Field>
        <div class="facts-actions">
          <Button
            class="facts-button"
            variant="outline"
            type="submit"
            :disabled="busy || !reopenRationale.trim()"
          >
            Почати новий перегляд
          </Button><Button
            class="facts-button"
            variant="ghost"
            type="button"
            :disabled="busy"
            @click="reopening = null"
          >
            Залишити рішення без змін
          </Button>
        </div>
      </form>
    </section>
    <section
      v-if="basisResult && !loading"
      class="facts-basis"
      aria-labelledby="facts-basis-title"
    >
      <div class="facts-section-heading">
        <div>
          <h3 id="facts-basis-title">
            Схвалена основа
          </h3>
        </div><Field class="facts-mode">
          <FieldLabel for="basis-mode">
            Режим роботи з основою
          </FieldLabel><select
            id="basis-mode"
            v-model="mode"
            class="facts-input"
            :disabled="busy || editing"
            @change="changeMode"
          >
            <option value="FACTUAL">
              Фактичний
            </option><option value="CREATIVE">
              Творчий / авторський
            </option>
          </select>
        </Field>
      </div><p
        v-if="mode === 'CREATIVE' && basisResult.unverified"
        class="facts-warning"
      >
        Творчий / авторський режим · Без перевіреної фактичної основи.
      </p><p
        v-else-if="basisResult.missingBasis"
        class="facts-warning"
      >
        Немає схваленої фактичної основи. Перевірте докази, схваліть придатні твердження й збережіть основу перед фактичною роботою.
      </p><template v-if="basisResult.basis">
        <p class="facts-message">
          {{ basisResult.basis.valid ? 'Збережена фактична основа придатна до використання.' : 'Збережена основа потребує перевірки; її попередній склад збережено.' }}
        </p><details class="facts-details">
          <summary>Деталі збереженої основи</summary><dl><dt>Версія основи</dt><dd>{{ basisResult.basis.sequence }}</dd><dt>Ідентифікатор</dt><dd>{{ basisResult.basis.id }}</dd></dl><p
            v-for="reason in basisResult.basis.blockingReasons"
            :key="reason"
          >
            {{ blockingReason(reason) }}
          </p>
        </details>
      </template><form
        v-if="basisResult.eligibleClaims.length"
        class="basis-selection"
        @submit.prevent="freezeBasis"
      >
        <fieldset>
          <legend>Придатні схвалені твердження</legend><label
            v-for="claim in basisResult.eligibleClaims"
            :key="claim.id"
            class="facts-check"
          ><input
            v-model="selectedBasis"
            type="checkbox"
            :value="claim.currentRevisionId"
            :disabled="busy || editing || archived"
          ><span>{{ claim.currentRevision.wording }}</span></label>
        </fieldset><Button
          class="facts-button facts-primary"
          type="submit"
          :disabled="busy || editing || archived || !selectedBasis.length"
        >
          Зберегти фактичну основу
        </Button>
      </form><p
        v-for="reason in basisResult.blockingReasons"
        :key="reason"
        class="facts-muted"
      >
        {{ blockingReason(reason) }}
      </p>
    </section>
  </div>
</template>

<style scoped>
.facts-workspace { color: var(--ink); }
.facts-heading { margin-bottom: 26px; }
.facts-heading h1 { margin: 0; font-family: var(--serif); font-size: 39px; line-height: 1.2; font-weight: 550; letter-spacing: -.025em; }
.facts-lead { margin: 10px 0 0; max-width: 650px; font-size: 15px; line-height: 1.65; color: var(--muted); }
.facts-toolbar, .facts-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.facts-toolbar { padding-bottom: 22px; border-bottom: 1px solid var(--rule); }
.facts-button { min-height: 40px; border-radius: 3px; font-size: 13px; }
.facts-primary { background: var(--copper); color: var(--copper-foreground, #fff); }
.facts-muted { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 10px 0; }
.facts-message, .facts-warning { font-size: 13px; line-height: 1.6; margin: 12px 0; }
.facts-warning { color: var(--review, var(--copper)); }
.facts-alert { margin-bottom: 20px; }
.facts-alert a { display: inline-block; margin-top: 10px; text-decoration: underline; }
.facts-job, .facts-conflicts, .facts-basis { padding: 24px 0; border-bottom: 1px solid var(--rule); }
.facts-job > p, .conflict-list p { font-size: 13px; line-height: 1.6; margin: 10px 0; }
.facts-section-heading { display: flex; gap: 18px; align-items: baseline; justify-content: space-between; margin-bottom: 16px; }
.facts-section-heading h3, .facts-reader h3 { margin: 0; font-family: var(--serif); font-weight: 500; font-size: 23px; line-height: 1.3; }
.facts-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 32px; padding: 28px 0; border-bottom: 1px solid var(--rule); }
.facts-columns.with-reader { grid-template-columns: minmax(0, 1fr); }
.facts-list, .facts-reader { min-width: 0; }
.facts-reader { max-width: 78ch; border-top: 1px solid var(--rule); padding-top: 28px; scroll-margin-top: 24px; }
.claim-list, .evidence-list, .claim-history, .conflict-list { margin: 0; padding: 0; list-style: none; }
.claim-list > li { border-top: 1px solid var(--rule); padding: 28px 0; }
.claim-selected .claim-inline-evidence { max-width: 74ch; padding: 18px 0 0 28px; }
.claim-inline-excerpt { margin-bottom: 18px; }
.claim-inline-excerpt blockquote { margin: 8px 0; font-family: var(--serif); font-size: 20px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.claim-status { text-decoration: underline; text-underline-offset: 4px; }
.claim-open { display: grid; gap: 8px; width: 100%; padding: 0; border: 0; background: transparent; text-align: left; color: var(--ink); cursor: pointer; }
.claim-wording { font-family: var(--serif); font-size: 28px; line-height: 1.4; max-width: 72ch; overflow-wrap: anywhere; }
.claim-status { color: var(--muted); font-size: 12px; line-height: 1.5; }
.claim-approved { color: var(--approval, var(--evidence, var(--copper))); }
.claim-document { margin: 16px 0 22px; font-family: var(--serif); font-size: 22px; line-height: 1.55; overflow-wrap: anywhere; }
.claim-evidence { margin-top: 25px; }
.claim-evidence h4, .evidence-editor h4, .resolution-form h4 { margin: 0 0 13px; font-size: 13px; font-weight: 600; }
.evidence-list > li { border-top: 1px solid var(--rule); padding: 14px 0; }
.evidence-attribution { margin: 0 0 8px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.evidence-list blockquote, .evidence-preview { margin: 0 0 12px; padding: 0 0 0 18px; border-left: 1px solid var(--rule); font-family: var(--serif); font-size: 19px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 45vh; overflow-y: auto; }
.facts-details { border-top: 1px solid var(--rule); margin-top: 15px; font-size: 12px; }
.facts-details > summary { padding: 11px 0; cursor: pointer; font-weight: 600; }
.facts-details dl { display: grid; grid-template-columns: 115px minmax(0, 1fr); gap: 8px 12px; margin: 0 0 13px; font-size: 12px; }
.facts-details dt { color: var(--muted); }
.facts-details dd { margin: 0; overflow-wrap: anywhere; }
.claim-history button { width: 100%; padding: 10px 0; border: 0; border-top: 1px solid var(--rule); background: transparent; color: var(--ink); text-align: left; font: inherit; font-size: 12px; cursor: pointer; }
.claim-history button[aria-current="true"] { color: var(--copper); font-weight: 600; }
.claim-editor, .conflict-form, .resolution-form, .review-action { display: grid; gap: 18px; }
.claim-editor h3 { margin-bottom: 4px; }
.facts-field { display: grid; gap: 7px; }
.facts-field :deep([data-slot="field-label"]), .facts-mode :deep([data-slot="field-label"]) { color: var(--ink); font-size: 12px; font-weight: 600; }
.facts-field :deep([data-slot="field-description"]) { color: var(--muted); font-size: 12px; line-height: 1.5; }
.facts-input { width: 100%; min-height: 40px; padding: 10px 12px; border: 1px solid var(--field-rule, var(--rule)); border-radius: 3px; background: var(--document); color: var(--ink); font: inherit; font-size: 13px; line-height: 1.6; }
textarea.facts-input { resize: vertical; }
.evidence-picker, .conflict-form fieldset, .resolution-form fieldset, .basis-selection fieldset { display: grid; gap: 14px; border: 0; padding: 15px 0 0; margin: 0; border-top: 1px solid var(--rule); min-width: 0; }
legend { padding: 0 0 10px; font-size: 12px; font-weight: 600; }
.facts-check { display: flex; gap: 10px; align-items: flex-start; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.facts-check input { margin-top: 5px; accent-color: var(--copper); flex-shrink: 0; }
.conflict-list > li { padding: 15px 0; border-top: 1px solid var(--rule); }
.conflict-list li > ul { margin: 10px 0 15px; padding-left: 20px; font-family: var(--serif); font-size: 16px; line-height: 1.6; }
.resolution-form, .review-action { margin: 18px 0; padding: 16px 0; border-block: 1px solid var(--rule); }
.facts-mode { display: grid; gap: 5px; width: 260px; max-width: 100%; flex-shrink: 0; }
.basis-selection { display: grid; gap: 18px; margin-top: 20px; }
.basis-selection .facts-button { justify-self: start; }
.facts-input:focus-visible, .claim-open:focus-visible, .claim-history button:focus-visible, .facts-check input:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
@media (max-width: 900px) { .facts-columns, .facts-columns.with-reader { grid-template-columns: minmax(0, 1fr); gap: 25px; } .facts-reader { padding: 25px 0 0; border-left: 0; border-top: 1px solid var(--rule); } }
@media (max-width: 760px) { .facts-heading h1 { font-size: 32px; } .facts-section-heading { flex-wrap: wrap; align-items: flex-start; } .facts-mode { width: 100%; } .claim-document { font-size: 21px; } .claim-wording { font-size: 24px; } .claim-inline-evidence { padding-left: 16px; } .claim-inline-excerpt blockquote { font-size: 18px; } .facts-button, .claim-open, .claim-history button, .facts-details > summary { min-height: 44px; } .facts-input { min-height: 44px; font-size: 16px; } .facts-check { min-height: 44px; } }
</style>
