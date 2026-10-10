<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'

type InputMode = 'DIRECT' | 'ARTICLE_DERIVED'
type ContentMode = 'FACTUAL' | 'CREATIVE'
interface Mapping { startOffset: number; endOffset: number; quote: string; claimRevisionId: string; evidenceId: string }
interface Content { text: string; mappings: Mapping[] }
interface Inputs { inputMode: InputMode; contentMode: ContentMode; includeLink: boolean; briefRevisionId: string; basisRevisionId: string | null; sourceArticleVersionId: string | null; workspaceId: string; workspaceStyleRevision: number }
interface Draft extends Inputs { content: Content; baseRevisionId: string | null }
interface RevisionClaim { evidenceId: string; claimRevisionId: string; quote: string; linkedText: string; evidence?: { quote: string; relation: string; invalidatedAt: string | null; snapshotId: string; snapshot: { material: { label: string } } }; claimRevision?: { wording: string } }
interface Revision extends Inputs { id: string; number: number; content: Content; claims?: RevisionClaim[]; hasUnmapped: boolean; status: 'PROPOSED' | 'APPROVED' | 'WITHDRAWN'; origin: string; reviewCounter: number; approvedAt: string | null; approvedBy: string | null; withdrawnAt: string | null; withdrawalReason: string | null; reviewedBriefRevisionId: string | null; reviewedBasisRevisionId: string | null; reviewedSourceArticleVersionId: string | null; reviewedWorkspaceStyleRevision: number | null; reviewedBy: string | null; reviewedAt: string | null; acknowledgedUnmapped: boolean; staleReasons: string[]; blockingReasons: string[] }
interface Evidence { claimRevisionId: string; evidenceId: string; wording: string; quote: string; snapshotId: string; materialTitle: string }
interface Job { id: string; status: string; operation: string; retryAllowed: boolean; failureCode?: string | null; safeMessage?: string | null }
interface State { adaptation: { id: string; revision: number; draft: Draft | null; currentApprovedRevisionId: string | null; revisions: Revision[] } | null; telegramSelected: boolean; brief: { id: string; revision: number; currentRevision: { id: string; contentMode: ContentMode } | null; history: unknown[] } | null; style: { revision: number }; prerequisites: { blockingReasons: string[]; missingBasis?: boolean; unverified?: boolean }; approvedArticle: { id: string; number: number; contentMode: ContentMode; title?: string; approvedAt?: string; inspection?: { eligible?: boolean; staleReasons?: string[]; blockingReasons: string[] } } | null; eligibleEvidence: Evidence[]; staleReasons: string[]; mappingIssues: { locator: string; reason: string }[]; hasUnmapped: boolean; blockingReasons: string[] }
const props = defineProps<{ projectId: string; projectTopic: string; csrfToken: string; userId: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}/telegram`
const projectBase = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
const recoveryKey = `cf:telegram:${props.userId}:${props.projectId}`
const state = ref<State | null>(null)
const text = ref('')
const inputMode = ref<InputMode>('DIRECT')
const contentMode = ref<ContentMode>('CREATIVE')
const includeLink = ref(false)
const expectedRevision = ref(0)
const baseline = ref('')
const saving = ref(false)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const conflict = ref(false)
const recovered = ref<{ content: Content; inputMode: InputMode; contentMode: ContentMode; includeLink: boolean; expectedRevision: number } | null>(null)
const historyOpen = ref(false)
const reviewAcknowledgements = ref<Record<string, boolean>>({})
const editor = ref<HTMLTextAreaElement | null>(null)
const selection = ref<{ start: number; end: number } | null>(null)
const dirty = computed(() => baseline.value !== serialize())
const readonly = computed(() => props.archived || !state.value?.telegramSelected)
const selectedArticle = computed(() => state.value?.approvedArticle)
const articleSourceNeedsReview = computed(() => inputMode.value === 'ARTICLE_DERIVED' && !!selectedArticle.value && (selectedArticle.value.inspection?.eligible !== true || !!selectedArticle.value.inspection?.staleReasons?.length))
const activeApproval = computed(() => state.value?.adaptation?.revisions.find(row => row.id === state.value?.adaptation?.currentApprovedRevisionId) ?? null)
const localMappingIssues = computed(() => mappings.value.filter(item => text.value.slice(item.startOffset, item.endOffset) !== item.quote))
const mappings = ref<Mapping[]>([])
const jobs = ref<Job[]>([])
const jobMessage = ref('')
const saveStatus = computed(() => saving.value ? 'Зберігаємо…' : conflict.value ? 'Потрібно узгодити зміни' : error.value && dirty.value ? 'Не збережено' : dirty.value ? 'Є незбережені зміни' : 'Збережено')
let timer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let hydration = false
let sessionEnded = false
let inFlight: Promise<boolean> | null = null
let commandKey: string | null = null
let controller = new AbortController()
const activeJob = computed(() => jobs.value.some(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)))

function content(): Content { return { text: text.value, mappings: [...mappings.value].sort((a, b) => a.startOffset - b.startOffset) } }
function serialize() { return JSON.stringify({ content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value }) }
function retain() { if (sessionEnded || !props.userId || hydration || !dirty.value) return; try { sessionStorage.setItem(recoveryKey, JSON.stringify({ content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value, expectedRevision: expectedRevision.value })) } catch { /* Live text remains available if session storage is full. */ } }
function changed() { if (hydration || disposed) return; retain(); clearTimeout(timer); if (!conflict.value && !recovered.value) timer = setTimeout(() => void save(), 700) }
function populate(draft?: Draft | null) {
  hydration = true
  text.value = draft?.content.text ?? ''
  mappings.value = draft?.content.mappings ?? []
  inputMode.value = draft?.inputMode ?? 'DIRECT'
  contentMode.value = draft?.contentMode ?? state.value?.brief?.currentRevision?.contentMode ?? 'CREATIVE'
  includeLink.value = draft?.includeLink ?? false
  expectedRevision.value = state.value?.adaptation?.revision ?? 0
  baseline.value = serialize()
  hydration = false
}
async function request(path = '', body?: unknown) {
  const response = await fetch(`${base}${path}`, { credentials: 'same-origin', signal: controller.signal, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    if (response.status === 409) conflict.value = true
    throw new Error(response.status === 409 ? 'Telegram або редакційні залежності змінилися. Ваш текст збережено в цьому вікні.' : response.status === 503 ? 'AI-генерація тимчасово недоступна. Ви можете продовжувати редагування.' : response.status === 400 ? 'Перевірте текст і посилання на факти.' : 'Не вдалося виконати дію. Ваш текст залишився в редакторі; повторіть спробу.')
  }
  return response.json()
}
async function load(reset = false) { state.value = await request() as State; if (reset) populate(state.value.adaptation?.draft); }
async function save(): Promise<boolean> {
  clearTimeout(timer)
  if (inFlight) { const ok = await inFlight; return ok && dirty.value ? save() : ok }
  if (!dirty.value) return true
  if (readonly.value || conflict.value || recovered.value) return false
  const submitted = serialize(); saving.value = true; error.value = ''
  inFlight = (async () => {
    try {
      state.value = await request('/draft', { expectedRevision: expectedRevision.value, content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value }) as State
      if (disposed) return false
      expectedRevision.value = state.value.adaptation?.revision ?? expectedRevision.value
      baseline.value = submitted
      if (!dirty.value) sessionStorage.removeItem(recoveryKey); else retain()
      return true
    } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти.'; return false }
    finally { saving.value = false; inFlight = null }
  })()
  const ok = await inFlight
  return ok && dirty.value && !disposed ? save() : ok
}
async function command(path: string, extra: Record<string, unknown> = {}, replace = false) {
  if (busy.value || readonly.value || !await save()) return
  busy.value = true; error.value = ''
  try { state.value = await request(path, { expectedRevision: expectedRevision.value, ...extra }) as State; expectedRevision.value = state.value.adaptation?.revision ?? expectedRevision.value; if (replace) populate(state.value.adaptation?.draft); else reviewAcknowledgements.value = {} }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { busy.value = false }
}
async function checkpoint() { await command('/checkpoint') }
async function refreshInputs() {
  if (!await save()) return
  await command('/draft', { content: content(), inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value, refreshInputs: true }, true)
}
async function generate() {
  if (busy.value || readonly.value || !await save()) return
  commandKey ??= crypto.randomUUID(); busy.value = true; error.value = ''
  try {
    const result = await request('/generate', { expectedRevision: expectedRevision.value, commandKey, inputMode: inputMode.value, contentMode: contentMode.value, includeLink: includeLink.value }) as { job: Job }
    commandKey = null
    jobs.value = [result.job, ...jobs.value.filter(job => job.id !== result.job.id)]
    jobMessage.value = 'Створюємо пропозицію. Чернетка залишиться доступною для редагування.'
    void pollJobs()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося створити пропозицію.' }
  finally { busy.value = false }
}
async function pollJobs() {
  clearTimeout(pollTimer)
  if (disposed) return
  try {
    const response = await fetch(`${projectBase}/jobs`, { credentials: 'same-origin', signal: controller.signal })
    if (response.status === 401) { emit('session-expired'); return }
    if (response.ok) {
      const result = await response.json() as { jobs: Job[] }
      jobs.value = result.jobs.filter(job => job.operation === 'TELEGRAM_GENERATION')
      const latest = jobs.value[0]
      if (latest?.status === 'SUCCEEDED') { jobMessage.value = 'Пропозицію додано до історії. Вона не замінила ваш текст.'; await load() }
      else if (latest && ['FAILED', 'CANCELLED'].includes(latest.status)) jobMessage.value = latest.safeMessage || 'Не вдалося створити пропозицію. Чернетка збережена.'
    }
  } catch { /* The editor and its saved text remain usable during status polling errors. */ }
  if (!disposed) pollTimer = setTimeout(() => void pollJobs(), activeJob.value ? 2000 : 7000)
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
function linkEvidence(item: Evidence) {
  const range = selection.value
  if (!range || range.end <= range.start) { error.value = 'Виділіть точне формулювання в дописі, до якого прив’язати факт.'; return }
  const quote = text.value.slice(range.start, range.end)
  const next: Mapping = { startOffset: range.start, endOffset: range.end, quote, claimRevisionId: item.claimRevisionId, evidenceId: item.evidenceId }
  mappings.value = [...mappings.value.filter(row => row.endOffset <= range.start || row.startOffset >= range.end), next].sort((a, b) => a.startOffset - b.startOffset)
  error.value = ''; changed()
}
function removeMapping(mapping: Mapping) { mappings.value = mappings.value.filter(row => row !== mapping); changed() }
function editText(event: Event) {
  updateText((event.target as HTMLTextAreaElement).value)
}
function updateText(next: string) {
  const previous = text.value
  let start = 0, oldEnd = previous.length, newEnd = next.length
  while (start < oldEnd && start < newEnd && previous[start] === next[start]) start++
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd-- }
  const delta = next.length - previous.length
  const adjusted = mappings.value.map(row => {
    if (row.endOffset <= start) return row
    if (row.startOffset >= oldEnd) return { ...row, startOffset: row.startOffset + delta, endOffset: row.endOffset + delta }
    return { ...row, startOffset: Math.min(row.startOffset, start), endOffset: row.endOffset > oldEnd ? row.endOffset + delta : newEnd }
  }).filter(row => row.endOffset > row.startOffset)
  // A replacement spanning several citations has no unique surviving range.
  // Remove only overlapping links; retained quotes require explicit relinking.
  mappings.value = adjusted.filter((row, index) => !adjusted.some((other, otherIndex) => otherIndex !== index && row.startOffset < other.endOffset && other.startOffset < row.endOffset))
  text.value = next; selection.value = null; changed()
}
function insertPlaceholder() {
  const el = editor.value
  if (!el) { updateText(`${text.value}${text.value && !text.value.endsWith('\n') ? '\n' : ''}[ПОСИЛАННЯ]`); return }
  const start = el.selectionStart, end = el.selectionEnd, token = '[ПОСИЛАННЯ]'
  updateText(`${text.value.slice(0, start)}${token}${text.value.slice(end)}`)
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
}
function inputFreshness(reasons: string[]) {
  const labels: Record<string, string> = { BRIEF_CHANGED: 'змінився бриф', WORKSPACE_STYLE_CHANGED: 'змінився стиль простору', FACTUAL_BASIS_CHANGED: 'змінилася фактична основа', MISSING_FACTUAL_BASIS: 'немає придатної фактичної основи', INVALID_ORIGINAL_FACTUAL_BASIS: 'початкова фактична основа втратила придатність', SOURCE_ARTICLE_CHANGED: 'змінилася погоджена стаття', INVALID_ORIGINAL_SOURCE_ARTICLE: 'початкова стаття більше не погоджена', INVALID_ORIGINAL_SOURCE_EVIDENCE: 'докази початкової статті потребують перегляду' }
  return reasons.map(reason => labels[reason] ?? 'змінилися редакційні залежності').join('; ')
}
function hasUnresolvedReviewBlock(revision: Revision) {
  return revision.blockingReasons.some(reason => reason !== 'UNMAPPED_NOT_ACKNOWLEDGED' || !reviewAcknowledgements.value[revision.id])
}
function formatDate(value?: string | null) { return value ? new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—' }
function restoreLocal() {
  const item = recovered.value
  if (!item) return
  hydration = true; text.value = item.content.text; mappings.value = item.content.mappings; inputMode.value = item.inputMode; contentMode.value = item.contentMode; includeLink.value = item.includeLink
  recovered.value = null; expectedRevision.value = item.expectedRevision; hydration = false; conflict.value = expectedRevision.value !== (state.value?.adaptation?.revision ?? 0); baseline.value = ''; retain(); if (!conflict.value) void save()
}
function discardLocal() { recovered.value = null; sessionStorage.removeItem(recoveryKey) }
async function reconcile(useLocal: boolean) {
  try { await load(!useLocal); expectedRevision.value = state.value?.adaptation?.revision ?? 0; conflict.value = false; error.value = ''; recovered.value = null; if (useLocal) { baseline.value = ''; await save() } else sessionStorage.removeItem(recoveryKey) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити.' }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { retain(); event.preventDefault(); event.returnValue = '' } }
function endSession() { sessionEnded = true; disposed = true; controller.abort(); clearTimeout(timer); clearTimeout(pollTimer); hydration = true; text.value = ''; mappings.value = []; recovered.value = null; state.value = null; jobs.value = []; sessionStorage.removeItem(recoveryKey) }
watch([text, inputMode, contentMode, includeLink], changed)
watch(() => props.userId, () => { controller.abort(); endSession() })
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('cf:article-session-ended', endSession)
  try {
    await load(true)
    const stored = sessionStorage.getItem(recoveryKey)
    if (stored) { const value = JSON.parse(stored) as NonNullable<typeof recovered.value>; if (JSON.stringify({ content: value.content, inputMode: value.inputMode, contentMode: value.contentMode, includeLink: value.includeLink }) !== baseline.value) recovered.value = value; else sessionStorage.removeItem(recoveryKey) }
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити Telegram.' }
  finally { loading.value = false; if (!disposed) void pollJobs() }
})
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('cf:article-session-ended', endSession); if (!disposed) { retain(); disposed = true } controller.abort(); clearTimeout(timer); clearTimeout(pollTimer) })
</script>

<template>
  <div class="telegram-workspace">
    <header class="telegram-heading">
      <div>
        <p class="telegram-context">
          {{ projectTopic }}
        </p>
        <h1 id="telegram-title">
          Допис у Telegram
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
      Відкриваємо Telegram…
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
        {{ props.archived ? 'Архівований проєкт доступний лише для перегляду.' : 'Допис у Telegram не вибрано серед форматів цього проєкту.' }}
      </p>
      <div
        v-if="state.staleReasons.length"
        class="telegram-notice telegram-stale"
        role="status"
      >
        <p>Входи чернетки потребують перегляду: {{ inputFreshness(state.staleReasons) }}. Оновлення збереже текст; погоджені версії залишаться в історії.</p>
        <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || readonly || conflict || !!recovered || state.brief?.currentRevision?.contentMode !== contentMode || (contentMode === 'FACTUAL' && !!state.prerequisites?.blockingReasons?.length) || (inputMode === 'ARTICLE_DERIVED' && (!selectedArticle || articleSourceNeedsReview))"
          @click="refreshInputs"
        >
          Оновити входи чернетки
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
        <label class="telegram-select">Джерело допису
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
            <option value="FACTUAL">На перевірених фактах</option>
            <option value="CREATIVE">Авторський · без перевіреної основи</option>
          </select>
        </label>
        <label class="telegram-link-toggle"><input
          v-model="includeLink"
          type="checkbox"
          :disabled="readonly || busy"
        > Передбачити місце для посилання</label>
      </div>
      <p
        v-if="contentMode === 'CREATIVE'"
        class="telegram-unverified"
      >
        Авторський режим · Текст не підтверджений фактичною основою. Погодження підтверджує редакторський перегляд, а не перевірку кожного твердження.
      </p>
      <p
        v-if="inputMode === 'DIRECT'"
        class="telegram-source-note"
      >
        Самостійний допис працює без статті та структури. Він залежить від брифу, стилю простору та вибраної фактичної основи.
      </p>
      <p
        v-else
        class="telegram-source-note"
      >
        Джерело: {{ selectedArticle?.title || `погоджена стаття · версія ${selectedArticle?.number ?? ''}` }}. Зміни чернетки статті не змінюють цю адаптацію.
      </p>
      <p
        v-if="articleSourceNeedsReview"
        class="telegram-stale"
        role="status"
      >
        Погоджену статтю потрібно переглянути, перш ніж використовувати її для нової пропозиції.
      </p>
      <p
        v-if="state.brief?.currentRevision?.contentMode !== contentMode"
        class="telegram-notice"
      >
        Збережіть бриф у вибраному режимі, перш ніж редагувати чи створювати допис.
      </p>
      <p
        v-if="contentMode === 'FACTUAL' && state.prerequisites?.blockingReasons?.length"
        class="telegram-notice"
      >
        Фактичний режим недоступний: немає придатної затвердженої основи. Перейдіть до «Фактів» і погодьте докази.
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

      <div class="telegram-layout">
        <section
          class="telegram-paper"
          aria-label="Редактор допису"
        >
          <div class="telegram-paper-heading">
            <p>Текст допису</p><span>{{ text.length }} / 4096</span>
          </div>
          <label
            class="sr-only"
            for="telegram-manuscript"
          >Текст допису у Telegram</label>
          <textarea
            id="telegram-manuscript"
            ref="editor"
            :value="text"
            class="telegram-manuscript"
            maxlength="4096"
            rows="12"
            :readonly="readonly || busy"
            aria-describedby="telegram-save-state"
            @select="chooseSelection"
            @input="editText"
            @keyup="chooseSelection"
            @mouseup="chooseSelection"
          />
          <p
            id="telegram-save-state"
            class="telegram-save-state"
            role="status"
            aria-live="polite"
          >
            {{ saveStatus }}<span v-if="dirty && !saving"> · зміни збережуться автоматично</span>
          </p>
          <div class="telegram-actions">
            <Button
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
              :disabled="readonly || busy || activeJob || conflict || !!recovered || state.brief?.currentRevision?.contentMode !== contentMode || (contentMode === 'FACTUAL' && !!state.prerequisites?.blockingReasons?.length) || (inputMode === 'ARTICLE_DERIVED' && (!selectedArticle || articleSourceNeedsReview || !!selectedArticle.inspection?.blockingReasons.length))"
              @click="generate"
            >
              Запропонувати допис
            </Button>
            <Button
              class="workspace-button workspace-button-primary"
              :disabled="readonly || busy || conflict || !!recovered || !text.trim() || text.length > 4096"
              @click="checkpoint"
            >
              Зберегти версію
            </Button>
          </div>
          <div
            v-if="localMappingIssues.length || state.mappingIssues.length"
            class="telegram-mapping-warning"
            role="status"
          >
            Є посилання на твердження, що не відповідають поточному тексту. Видаліть їх або виділіть точні слова й прив’яжіть знову.
          </div>
          <div
            v-if="mappings.length"
            class="telegram-mapping-list"
            aria-label="Посилання на докази"
          >
            <div
              v-for="mapping in mappings"
              :key="`${mapping.evidenceId}:${mapping.startOffset}`"
              class="telegram-mapping-row"
            >
              <span>«{{ mapping.quote }}»</span><Button
                class="workspace-button"
                variant="ghost"
                :disabled="readonly || busy"
                @click="removeMapping(mapping)"
              >
                Прибрати посилання
              </Button>
            </div>
          </div>
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
              Поточне погодження · версія {{ activeApproval.number }}
            </p>
          </div>
        </section>

        <aside
          class="telegram-evidence"
          aria-labelledby="telegram-evidence-heading"
        >
          <h2 id="telegram-evidence-heading">
            Факти для допису
          </h2>
          <p>Виділіть точні слова в тексті, а потім прив’яжіть їх до доказу.</p>
          <p
            v-if="!state.eligibleEvidence.length"
            class="telegram-empty-evidence"
          >
            Придатних доказів поки немає. Фактичне погодження буде заблоковано, доки основу не відновлено.
          </p>
          <article
            v-for="item in state.eligibleEvidence"
            :key="item.evidenceId"
            class="telegram-evidence-item"
          >
            <h3>{{ item.wording }}</h3><p>{{ item.materialTitle }}</p><blockquote>{{ item.quote }}</blockquote>
            <Button
              class="workspace-button"
              variant="outline"
              :disabled="readonly || busy || contentMode !== 'FACTUAL'"
              @click="linkEvidence(item)"
            >
              Прив’язати виділення
            </Button>
          </article>
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
            <h3>Версія {{ revision.number }}</h3><p>{{ revision.status === 'APPROVED' ? 'Погоджено' : revision.status === 'WITHDRAWN' ? 'Відкликано' : revision.origin === 'AI' ? 'Пропозиція AI · не застосовано' : 'Очікує перегляду' }} · {{ revision.inputMode === 'DIRECT' ? 'Самостійний допис' : 'За статтею' }} · {{ revision.contentMode === 'FACTUAL' ? 'Фактичний режим' : 'Авторський · неперевірено' }}</p>
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
          <details>
            <summary>Початкові входи й квитанція перегляду</summary>
            <dl class="telegram-inputs">
              <dt>Бриф</dt><dd>{{ revision.briefRevisionId }}</dd><dt>Стиль простору</dt><dd>Версія {{ revision.workspaceStyleRevision }}</dd><dt>Фактична основа</dt><dd>{{ revision.basisRevisionId || 'Не використовувалася' }}</dd><dt>Стаття-джерело</dt><dd>{{ revision.sourceArticleVersionId || 'Немає · прямий шлях' }}</dd><dt>Посилання</dt><dd>{{ revision.includeLink ? 'Передбачалося місце' : 'Не передбачалося' }}</dd><dt>Погоджено</dt><dd>{{ formatDate(revision.approvedAt) }}{{ revision.approvedBy ? ` · ${revision.approvedBy}` : '' }}</dd><dt>Останній перегляд</dt><dd>{{ formatDate(revision.reviewedAt) }}{{ revision.reviewedBy ? ` · ${revision.reviewedBy}` : '' }}</dd><dt>Переглянуті залежності</dt><dd>Бриф {{ revision.reviewedBriefRevisionId || '—' }}; основа {{ revision.reviewedBasisRevisionId || '—' }}; стиль {{ revision.reviewedWorkspaceStyleRevision ?? '—' }}; стаття {{ revision.reviewedSourceArticleVersionId || '—' }}</dd>
            </dl>
            <p v-if="revision.acknowledgedUnmapped">
              Редактор підтвердив перегляд тверджень без прив’язки до доказів.
            </p>
            <p v-if="revision.withdrawalReason">
              Причина відкликання: {{ revision.withdrawalReason }}
            </p>
            <ul v-if="revision.content.mappings.length">
              <li
                v-for="map in revision.content.mappings"
                :key="`${map.evidenceId}:${map.startOffset}`"
              >
                «{{ map.quote }}» — {{ revision.claims?.find(row => row.evidenceId === map.evidenceId)?.evidence?.snapshot.material.label || 'Збережений доказ' }}<details v-if="revision.claims?.find(row => row.evidenceId === map.evidenceId)">
                  <summary>Точний доказ і твердження</summary><p>{{ revision.claims.find(row => row.evidenceId === map.evidenceId)?.claimRevision?.wording }}</p><blockquote>{{ revision.claims.find(row => row.evidenceId === map.evidenceId)?.evidence?.quote }}</blockquote><p>Фрагмент {{ revision.claims.find(row => row.evidenceId === map.evidenceId)?.evidence?.snapshotId }} · доказ {{ map.evidenceId }} · твердження {{ map.claimRevisionId }}</p>
                </details>
              </li>
            </ul>
          </details>
          <div class="telegram-history-actions">
            <Button
              v-if="revision.origin === 'AI' && revision.status === 'PROPOSED'"
              class="workspace-button"
              variant="outline"
              :disabled="busy || readonly || dirty"
              @click="command(`/${revision.id}/apply`, {}, true)"
            >
              Застосувати до чернетки
            </Button>
            <label v-if="revision.hasUnmapped && ((revision.status === 'PROPOSED' && revision.id === state.adaptation?.draft?.baseRevisionId) || (revision.status === 'APPROVED' && revision.id === state.adaptation?.currentApprovedRevisionId && revision.staleReasons.length))"><input
              v-model="reviewAcknowledgements[revision.id]"
              type="checkbox"
            > Я переглянув непов’язані твердження</label>
            <template v-if="revision.status === 'PROPOSED' && revision.id === (state.adaptation?.draft?.baseRevisionId ?? null)">
              <Button
                class="workspace-button workspace-button-primary"
                :disabled="busy || readonly || dirty || conflict || hasUnresolvedReviewBlock(revision) || (revision.hasUnmapped && !reviewAcknowledgements[revision.id])"
                @click="command(`/${revision.id}/approve`, { expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: reviewAcknowledgements[revision.id] === true })"
              >
                Погодити версію
              </Button>
            </template>
            <Button
              v-if="revision.status === 'APPROVED' && revision.id === state.adaptation?.currentApprovedRevisionId && revision.staleReasons.length"
              class="workspace-button workspace-button-primary"
              :disabled="busy || readonly || dirty || conflict || hasUnresolvedReviewBlock(revision) || (revision.hasUnmapped && !reviewAcknowledgements[revision.id])"
              @click="command(`/${revision.id}/rereview`, { expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: reviewAcknowledgements[revision.id] === true })"
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
.telegram-paper-heading span, .telegram-save-state { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.telegram-manuscript { box-sizing: border-box; display: block; width: 100%; min-height: 320px; resize: vertical; padding: 24px clamp(20px, 4vw, 48px); border: 1px solid var(--rule); border-radius: 0; background: var(--paper); color: var(--ink); font: 400 20px/1.65 SourceSerif, Georgia, serif; overflow-wrap: anywhere; }
.telegram-manuscript::selection { color: #20262b; background: #edece7; }
.telegram-manuscript:focus-visible, .telegram-select select:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
.telegram-save-state { min-height: 18px; margin: 8px 0; }
.telegram-actions, .telegram-history-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.telegram-review-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--rule); font-size: 13px; }
.telegram-review-controls p { margin: 0; color: var(--approved, #32664b); }
.telegram-evidence { min-width: 0; }
.telegram-evidence h2, .telegram-history h2 { margin: 0; font: 550 25px/1.3 SourceSerif, Georgia, serif; }
.telegram-evidence > p { color: var(--muted); font-size: 13px; line-height: 1.55; }
.telegram-evidence-item { padding: 16px 0; border-top: 1px solid var(--rule); }
.telegram-evidence-item h3 { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.45; }
.telegram-evidence-item p { margin: 7px 0; color: var(--muted); font-size: 12px; }
.telegram-evidence-item blockquote { margin: 10px 0 12px; padding: 0 0 0 12px; border-left: 1px solid var(--rule); color: var(--lead-ink); font: 15px/1.5 SourceSerif, Georgia, serif; }
.telegram-empty-evidence { padding-block: 14px; border-top: 1px solid var(--rule); }
.telegram-mapping-warning, .telegram-recovery, .telegram-error { margin: 12px 0; padding: 12px 0; border-block: 1px solid var(--rule); color: var(--review, #945000); font-size: 13px; line-height: 1.5; }
.telegram-job-state { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; margin: 12px 0; padding: 10px 0; border-bottom: 1px solid var(--rule); color: var(--muted); font-size: 13px; }
.telegram-job-state p { margin: 0 auto 0 0; }
.telegram-recovery { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.telegram-recovery p { margin: 0 auto 0 0; }
.telegram-mapping-list { margin-top: 14px; border-top: 1px solid var(--rule); }
.telegram-mapping-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--rule); font: 14px/1.45 SourceSerif, Georgia, serif; }
.telegram-link-note { margin: 14px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
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
@media (max-width: 900px) { .telegram-layout { grid-template-columns: minmax(0, 1fr); gap: 32px; } .telegram-evidence { border-top: 1px solid var(--rule); padding-top: 20px; } .telegram-evidence-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 16px; } .telegram-evidence-item blockquote { grid-column: 1; } .telegram-evidence-item button { grid-column: 2; grid-row: 2 / span 2; align-self: center; } }
@media (max-width: 600px) { .telegram-heading { align-items: start; flex-direction: column; gap: 8px; margin-bottom: 20px; } .telegram-heading h1 { font-size: 34px; } .telegram-controls { align-items: stretch; flex-direction: column; gap: 14px; } .telegram-select select { width: 100%; min-width: 0; } .telegram-manuscript { min-height: 280px; padding: 18px 16px; font-size: 18px; } .telegram-actions { align-items: stretch; flex-direction: column; } .telegram-actions > * { width: 100%; } .telegram-recovery { align-items: stretch; flex-direction: column; } .telegram-recovery > * { width: 100%; } .telegram-evidence-item { display: block; } .telegram-inputs { grid-template-columns: minmax(0, 1fr); gap: 2px; } .telegram-inputs dd { margin-bottom: 8px; } }
@media (prefers-reduced-motion: reduce) { .telegram-workspace *, .telegram-workspace *::before, .telegram-workspace *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }
</style>
