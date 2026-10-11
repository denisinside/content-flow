<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'

type Loose = Record<string, unknown>
type Version = { id: string; number?: number; status?: string; origin?: string; plainText?: string; approvedAt?: string | null; withdrawnAt?: string | null; content?: { title?: string; document?: unknown }; contentHash?: string; sha256?: string }
type LocalAnnotation = { id: string; articleVersionId?: string; kind?: string; status?: string; quote?: string; body?: string; replacementText?: string | null; anchor?: { status?: string; start?: number | null; end?: number | null }; posts?: Array<{ id: string; body: string; action?: string; authorName?: string | null; createdBy?: string; createdAt?: string }> }
type Thread = { id: string; remoteId?: string; kind?: string; status?: string; payload?: unknown; quoteText?: string | null; ranges?: unknown[]; anchorStatus?: string; author?: unknown; localAnnotationId?: string | null; createdAt?: string; updatedAt?: string }
type Operation = { id: string; kind?: string; state?: string; status?: string; createdAt?: string; updatedAt?: string; outcome?: unknown; resultVersionId?: string | null; jobId?: string; job?: Loose }
type SyncStatus = { binding?: Loose | null; state?: Loose | null; threads: Thread[]; localAnnotations: LocalAnnotation[]; versions: Version[]; operations: Operation[]; baseline?: unknown; localPreview?: unknown; remotePreview?: unknown }
type Preview = { previewId: string; kind: string; sourceVersionId: string | null; remoteRevision: string; localContent: unknown; remoteContent: unknown; baselineContent: unknown; hasConflict: boolean; unsupported: unknown[]; writeMode: 'EDIT' | 'SUGGEST' | null; summary: string; expiresAt: string }
type Connection = { id: string; displayName?: string | null; status: string; providerAccess?: string }
const props = defineProps<{ projectId: string; csrfToken: string; userId: string; expectedArticleRevision: number; targetVersionId: string | null; connectionId?: string; anchor?: { start: number; end: number; quote: string } | null; readonly?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; 'candidate-created': [versionId: string] }>()
const status = ref<SyncStatus | null>(null)
const connections = ref<Connection[]>([])
const selectedVersionId = ref<string | null>(props.targetVersionId)
const preview = ref<Preview | null>(null)
const previewPayload = ref<Loose | null>(null)
const previewConfirming = ref(false)
const busy = ref(false)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const backgroundEnabled = ref(false)
const replyDrafts = ref<Record<string, string>>({})
const pullKey = ref('')
const confirmKey = ref('')
const base = computed(() => `/api/v1/projects/${encodeURIComponent(props.projectId)}/google-docs/sync`)
const usableConnection = computed(() => {
  return connections.value.find(connection => (!props.connectionId || connection.id === props.connectionId) && connection.status === 'connected' && connection.providerAccess === 'authorized')
})
const versions = computed(() => status.value?.versions ?? [])
const latestState = computed(() => status.value?.state ?? {})
const operations = computed(() => status.value?.operations ?? [])
const openThreads = computed(() => (status.value?.threads ?? []).filter(thread => !['RESOLVED', 'ACCEPTED', 'REJECTED', 'CLOSED'].includes(String(thread.status ?? '').toUpperCase())))
const closedThreads = computed(() => (status.value?.threads ?? []).filter(thread => !openThreads.value.includes(thread)))
const unresolvedOperation = computed(() => operations.value.find(operation => ['UNKNOWN', 'PARTIAL'].includes(String(operation.state ?? operation.status).toUpperCase())) ?? null)
const annotationThreads = computed(() => status.value?.localAnnotations ?? [])
let epoch = 0
let loadSequence = 0
let disposed = false
const deliveredCandidates = new Set<string>()
const operationStates = new Map<string, string>()
let pollTimer: ReturnType<typeof setInterval> | undefined
function contentText(value: unknown): string {
  const content = record(value)
  const walk = (node: unknown): string => {
    const item = record(node)
    if (typeof item.text === 'string') return item.text
    if (item.type === 'hardBreak') return '\n'
    return (Array.isArray(item.content) ? item.content.map(walk).join(['doc', 'bulletList', 'orderedList'].includes(String(item.type)) ? '\n\n' : '') : '')
  }
  return walk(content.document ?? content)
}
function record(value: unknown): Loose { return value && typeof value === 'object' && !Array.isArray(value) ? value as Loose : {} }
function text(value: unknown, fallback = ''): string { return typeof value === 'string' && value.trim() ? value : fallback }
function authorName(value: unknown): string {
  if (typeof value === 'string') return value
  const source = record(value)
  return text(source.displayName ?? source.name ?? source.email ?? source.authorName, 'Автор Google')
}
function posts(thread: Thread) {
  const payload = record(thread.payload)
  const rows = (Array.isArray(payload.posts) ? payload.posts : [...(payload.headPost ? [payload.headPost] : []), ...(Array.isArray(payload.replies) ? payload.replies : [])]) as unknown[]
  return rows.map((item, index) => {
    const post = record(item)
    return { id: text(post.postId ?? post.id, `post-${index}`), body: text(post.content ?? post.body ?? post.text), author: authorName(post.author ?? post), createdAt: text(post.createTime ?? post.createdAt ?? post.createdTime) }
  })
}
function unlinkedLocalReplies(thread: Thread) {
  if (thread.kind !== 'comment' || !thread.localAnnotationId) return []
  const annotation = annotationThreads.value.find(item => item.id === thread.localAnnotationId)
  if (!annotation || annotation.kind !== 'COMMENT') return []
  const links = record(record(thread.payload).localPostLinks)
  return (annotation.posts ?? []).filter(post => post.action === 'REPLY' && typeof links[post.id] !== 'string')
}
function threadBody(thread: Thread) {
  const payload = record(thread.payload)
  return text(payload.body ?? payload.content ?? record(payload.headPost).content)
}
function styleDescription(value: unknown): string {
  const labels: Record<string, string> = {
    weightedFontFamily: 'Шрифт', fontSize: 'Розмір', foregroundColor: 'Колір тексту', backgroundColor: 'Колір тла',
    bold: 'Жирний', italic: 'Курсив', underline: 'Підкреслення', strikethrough: 'Закреслення',
    namedStyleType: 'Стиль абзацу', alignment: 'Вирівнювання', lineSpacing: 'Міжрядковий інтервал',
    direction: 'Напрямок тексту', spacingAbove: 'Інтервал перед', spacingBelow: 'Інтервал після',
  }
  const render = (item: unknown): string => {
    if (item === null || typeof item !== 'object') return String(item)
    if (Array.isArray(item)) return item.map(render).join(', ')
    if (typeof (item as Loose).fontFamily === 'string' && Object.keys(item).length === 1) return String((item as Loose).fontFamily)
    return Object.entries(item as Loose).map(([key, nested]) => `${labels[key] ?? key}: ${render(nested)}`).join('; ')
  }
  return render(value)
}
function suggestionParts(thread: Thread) {
  const payload = record(thread.payload)
  const values = Array.isArray(payload.projectSuggestionParts) ? payload.projectSuggestionParts : Array.isArray(payload.suggestionParts) ? payload.suggestionParts : []
  return values.map((value, index) => {
    const part = record(value)
    const kind = String(part.type ?? '').toLowerCase()
    const textValue = text(part.text)
    const range = typeof part.startIndex === 'number' && typeof part.endIndex === 'number' ? ` · ${part.startIndex}–${part.endIndex}` : ''
    const styleText = part.style ? styleDescription(part.style) : ''
    const styleScope = part.scope === 'paragraph' ? 'абзацу' : 'тексту'
    const description = kind === 'insertion' ? `Додати: «${textValue}»` : kind === 'deletion' ? `Вилучити: «${textValue}»` : kind === 'style' ? `Змінити форматування ${styleScope}${textValue ? ` у «${textValue}»` : ''}${styleText ? `: ${styleText}` : ''}` : `Частина правки: ${textValue || 'тип невідомий'}`
    return { id: `${String(part.suggestionId ?? thread.remoteId ?? thread.id)}-${index}`, description: `${description}${range}`, supported: part.supported !== false && ['insertion', 'deletion', 'style'].includes(kind) }
  })
}
function canAcceptSuggestion(thread: Thread) {
  const parts = suggestionParts(thread)
  return thread.anchorStatus !== 'unanchored' && parts.length > 0 && parts.every(part => part.supported)
}
function displayStatus(value: unknown) {
  const stateValue = String(value ?? '').toUpperCase()
  return ({ READY: 'Готово до звірки', SYNCED: 'Зміни звірено', SUBMITTED: 'Очікує підтвердження Google', OPEN: 'Відкрито', UNRESOLVED: 'Відкрито', PENDING: 'Очікує рішення', RESOLVED: 'Закрито', ACCEPTED: 'Прийнято', REJECTED: 'Відхилено', QUEUED: 'У черзі', RUNNING: 'Виконується', SUCCEEDED: 'Завершено', FAILED: 'Не виконано', UNKNOWN: 'Потрібна перевірка', PARTIAL: 'Виконано частково', CANCELLED: 'Скасовано', UNSUPPORTED: 'Є непідтримані елементи', CONFLICT: 'Потрібно узгодити зміни', PUSH: 'Експорт статті', PULL: 'Отримання змін', RECONCILE: 'Перевірка результату', COMMENT_CREATE: 'Новий коментар', COMMENT_REPLY: 'Відповідь', COMMENT_RESOLVE: 'Закриття коментаря', COMMENT_REOPEN: 'Повторне відкриття', SUGGESTION_CREATE: 'Пропозиція правки', SUGGESTION_ACCEPT: 'Прийняття пропозиції', SUGGESTION_REJECT: 'Відхилення пропозиції' } as Record<string, string>)[stateValue] ?? text(value, 'Стан невідомий')
}
function formatDate(value: unknown) { const date = new Date(String(value ?? '')); return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(date) }
function operationLabel(operation: Operation) { return displayStatus(operation.state ?? operation.status) }
async function request(path: string, payload?: unknown, requestEpoch = epoch) {
  const response = await fetch(path.startsWith('/api/') ? path : `${base.value}${path}`, {
    credentials: 'same-origin', method: payload === undefined ? 'GET' : 'POST',
    ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(payload) }),
  })
  if (response.status === 401) { if (!disposed && requestEpoch === epoch) emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) throw new Error(response.status === 409 ? 'Стаття або Google Документ змінилися. Оновіть стан і перегляньте дію ще раз.' : response.status === 403 ? 'Перевірте Google-підключення та згоду на фонове читання.' : response.status === 503 ? 'Google Docs тимчасово недоступний. Дані статті збережено.' : 'Не вдалося виконати дію. Перевірте стан і повторіть спробу.')
  return response.json() as Promise<Loose>
}
function clearState() {
  loadSequence++
  status.value = null; connections.value = []; preview.value = null; previewPayload.value = null
  error.value = ''; notice.value = ''; backgroundEnabled.value = false; replyDrafts.value = {}
  pullKey.value = ''
  confirmKey.value = ''
  deliveredCandidates.clear(); operationStates.clear()
  loading.value = false; busy.value = false
}
async function load() {
  const current = epoch
  const sequence = ++loadSequence
  loading.value = true; error.value = ''; notice.value = ''
  try {
    const query = selectedVersionId.value ? `?targetVersionId=${encodeURIComponent(selectedVersionId.value)}` : ''
    const [result, connectionResult] = await Promise.all([request(`${base.value}${query}`, undefined, current), request('/api/v1/google-docs/connections', undefined, current)])
    if (disposed || current !== epoch || sequence !== loadSequence) return
    status.value = { ...result as SyncStatus, threads: Array.isArray(result.threads) ? result.threads as Thread[] : [], localAnnotations: Array.isArray(result.localAnnotations) ? result.localAnnotations as LocalAnnotation[] : [], versions: Array.isArray(result.versions) ? result.versions as Version[] : [], operations: Array.isArray(result.operations) ? result.operations as Operation[] : [] }
    connections.value = (connectionResult.connections as Connection[] | undefined) ?? []
    const syncState = record(status.value.state)
    backgroundEnabled.value = Boolean(syncState.backgroundGrantedAt ?? syncState.backgroundEnabled)
    for (const operation of status.value.operations) {
      const nextState = String(operation.state ?? operation.status ?? '')
      const previousState = operationStates.get(operation.id)
      operationStates.set(operation.id, nextState)
      if (previousState && previousState !== 'SUCCEEDED' && nextState === 'SUCCEEDED' && operation.resultVersionId && !deliveredCandidates.has(operation.resultVersionId)) {
        deliveredCandidates.add(operation.resultVersionId)
        emit('candidate-created', operation.resultVersionId)
      }
    }
  } catch (cause) { if (!disposed && current === epoch && sequence === loadSequence) error.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити синхронізацію.' }
  finally { if (!disposed && current === epoch && sequence === loadSequence) loading.value = false }
}
async function makePreview(kind: string, details: Loose = {}) {
  if (busy.value || props.readonly || !usableConnection.value || !selectedVersionId.value || unresolvedOperation.value) return
  const current = epoch
  busy.value = true; error.value = ''; notice.value = ''; preview.value = null; confirmKey.value = ''
  const payload = { connectionId: usableConnection.value.id, sourceVersionId: selectedVersionId.value, kind, expectedArticleRevision: props.expectedArticleRevision, ...details }
  try {
    const result = await request('/preview', payload, current)
    if (disposed || current !== epoch) return
    preview.value = result as unknown as Preview; previewPayload.value = payload
  } catch (cause) { if (!disposed && current === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося підготувати дію.' }
  finally { if (!disposed && current === epoch) busy.value = false }
}
async function confirmPreview() {
  if (!preview.value || !previewPayload.value || busy.value || props.readonly) return
  const current = epoch
  busy.value = true; previewConfirming.value = true; error.value = ''; notice.value = ''
  try {
    if (!confirmKey.value) confirmKey.value = crypto.randomUUID()
    const result = await request('/confirm', { previewId: preview.value.previewId, commandKey: confirmKey.value, expectedArticleRevision: props.expectedArticleRevision }, current)
    if (disposed || current !== epoch) return
    const operation = record(result.operation) as Operation
    preview.value = null; previewPayload.value = null
    await load()
    if (!disposed && current === epoch) notice.value = `Дію додано до черги: ${operationLabel(operation)}.`
  } catch (cause) { if (!disposed && current === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося підтвердити дію.' }
  finally { if (!disposed && current === epoch) { busy.value = false; previewConfirming.value = false } }
}
async function pull() {
  if (busy.value || props.readonly || !usableConnection.value || unresolvedOperation.value) return
  const current = epoch
  busy.value = true; error.value = ''; notice.value = ''
  if (!pullKey.value) pullKey.value = crypto.randomUUID()
  try {
    const result = await request('/pull', { connectionId: usableConnection.value.id, sourceVersionId: selectedVersionId.value, commandKey: pullKey.value, expectedArticleRevision: props.expectedArticleRevision }, current)
    if (disposed || current !== epoch) return
    const operation = record(result.operation) as Operation
    pullKey.value = ''
    await load()
    if (!disposed && current === epoch) notice.value = `Перевірку Google Документа додано до черги: ${operationLabel(operation)}.`
  } catch (cause) { if (!disposed && current === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося отримати зміни.' }
  finally { if (!disposed && current === epoch) busy.value = false }
}
async function reconcile(operation: Operation) {
  if (busy.value || !usableConnection.value) return
  const current = epoch
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await request(`/operations/${encodeURIComponent(operation.id)}/reconcile`, { connectionId: usableConnection.value.id, commandKey: crypto.randomUUID() }, current)
    if (disposed || current !== epoch) return
    await load()
    if (!disposed && current === epoch) notice.value = `Результат перевірки: ${operationLabel(record(result.operation) as Operation)}.`
  } catch (cause) { if (!disposed && current === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося перевірити результат.' }
  finally { if (!disposed && current === epoch) busy.value = false }
}
async function toggleBackground(event: Event) {
  if (busy.value || props.readonly) return
  const current = epoch
  const state = record(status.value?.state)
  const expectedGeneration = Number(state.backgroundGeneration ?? 0)
  const enabled = (event.target as HTMLInputElement).checked
  const connectionId = enabled ? usableConnection.value?.id : text(state.backgroundConnectionId) || usableConnection.value?.id
  if (!connectionId || (enabled && !usableConnection.value)) { backgroundEnabled.value = !enabled; return }
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const result = await request('/background', { connectionId, enabled, expectedGeneration }, current)
    if (disposed || current !== epoch) return
    backgroundEnabled.value = Boolean(record(result.state).backgroundGrantedAt ?? record(result.state).backgroundEnabled ?? enabled)
    await load()
    if (!disposed && current === epoch) notice.value = enabled ? 'Фонове читання увімкнено. Автоматична синхронізація лише читає документ.' : 'Фонове читання зупинено.'
  } catch (cause) { if (!disposed && current === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося змінити фонове читання.' }
  finally { if (!disposed && current === epoch) busy.value = false }
}
async function exportAnnotation(annotation: LocalAnnotation, kind: 'COMMENT_CREATE' | 'SUGGESTION_CREATE') {
  const start = annotation.anchor?.start, end = annotation.anchor?.end
  if (start == null || end == null || end <= start || !selectedVersionId.value) { error.value = 'Цей фрагмент не має точного місця в обраній версії, тому його не можна перенести.'; return }
  await makePreview(kind, { annotationId: annotation.id, rangeStart: start, rangeEnd: end, ...(kind === 'COMMENT_CREATE' ? { body: annotation.body } : {}) })
}
async function threadAction(thread: Thread, kind: 'COMMENT_REPLY' | 'COMMENT_RESOLVE' | 'COMMENT_REOPEN' | 'SUGGESTION_ACCEPT' | 'SUGGESTION_REJECT') {
  const local = annotationThreads.value.find(annotation => annotation.id === thread.localAnnotationId)
  if (kind === 'COMMENT_REPLY') {
    const body = replyDrafts.value[thread.id]?.trim()
    if (!body) return
    await makePreview(kind, { ...(local ? { annotationId: local.id } : {}), threadId: thread.id, body })
  } else await makePreview(kind, { ...(local ? { annotationId: local.id } : {}), threadId: thread.id })
}
async function exportLocalReply(thread: Thread, post: NonNullable<LocalAnnotation['posts']>[number]) {
  if (!thread.localAnnotationId || post.action !== 'REPLY') return
  await makePreview('COMMENT_REPLY', { threadId: thread.id, annotationId: thread.localAnnotationId, localPostId: post.id, body: post.body })
}
watch(() => [props.projectId, props.userId], () => { epoch++; clearState(); selectedVersionId.value = props.targetVersionId; void load() })
watch(selectedVersionId, () => { preview.value = null; previewPayload.value = null; void load() })
watch(() => props.targetVersionId, (value, previous) => { if (selectedVersionId.value === previous) selectedVersionId.value = value })
function endSession() { epoch++; clearState() }
onMounted(() => { window.addEventListener('cf:article-session-ended', endSession); void load(); pollTimer = setInterval(() => { if (!loading.value && !busy.value && operations.value.some(op => ['QUEUED', 'SUBMITTED'].includes(op.state ?? op.status ?? ''))) void load() }, 3000) })
onBeforeUnmount(() => { disposed = true; epoch++; if (pollTimer) clearInterval(pollTimer); window.removeEventListener('cf:article-session-ended', endSession) })
</script>

<template>
  <div
    class="google-sync"
    aria-label="Синхронізація Google Документів"
  >
    <div class="sync-heading-row">
      <div>
        <h3>Синхронізація</h3><p class="sync-muted">
          Стаття і Google Документ мають окремі версії. Перенесення тексту не закриває коментарі.
        </p>
      </div>
      <Button
        class="workspace-button"
        variant="ghost"
        :disabled="loading || busy"
        @click="load"
      >
        Оновити
      </Button>
    </div>
    <p
      v-if="loading"
      role="status"
    >
      Завантажуємо стан синхронізації…
    </p>
    <p
      v-else-if="!status?.binding"
      class="sync-muted"
    >
      Спершу прив’яжіть Google Документ у цьому розділі.
    </p>
    <template v-else>
      <div
        class="sync-state"
        aria-live="polite"
      >
        <span>Стан: {{ displayStatus(latestState.status ?? 'READY') }}</span>
        <span v-if="latestState.lastSuccessAt">Остання синхронізація: {{ formatDate(latestState.lastSuccessAt) }}</span>
        <span v-if="latestState.baselineSnapshotId">Базова версія збережена</span>
      </div>
      <p
        v-if="latestState.errorCategory"
        class="sync-warning"
      >
        Попередня дія потребує уваги: {{ displayStatus(latestState.errorCategory) }}.
      </p>
      <label for="sync-version">Версія статті</label>
      <select
        id="sync-version"
        v-model="selectedVersionId"
        :disabled="busy || !versions.length"
      >
        <option
          v-for="version in versions"
          :key="version.id"
          :value="version.id"
        >
          {{ version.content?.title || `Версія ${version.number ?? ''}` }} · {{ version.approvedAt ? 'погоджена' : version.origin === 'UNVERIFIED_IMPORTED' ? 'імпортована · не перевірена' : 'для перегляду' }}
        </option>
      </select>
      <p
        v-if="props.readonly"
        class="sync-warning"
      >
        Цей проєкт доступний лише для читання.
      </p>
      <p
        v-else-if="!usableConnection"
        class="sync-warning"
      >
        Підключіть власний Google-акаунт із доступом до цього документа.
      </p>
      <div class="sync-actions">
        <Button
          class="workspace-button workspace-button-primary"
          :disabled="busy || props.readonly || !usableConnection || !selectedVersionId || !!unresolvedOperation"
          @click="makePreview('PUSH')"
        >
          Переглянути експорт
        </Button>
        <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || props.readonly || !usableConnection || !!unresolvedOperation"
          @click="pull"
        >
          Отримати зміни
        </Button>
      </div>
      <p
        v-if="unresolvedOperation"
        class="sync-warning"
        role="status"
      >
        {{ unresolvedOperation.state === 'PARTIAL' ? 'Дію виконано частково.' : 'Google міг застосувати дію, але відповідь не підтверджена.' }} Нові записи й правки тимчасово заблоковані.
      </p>
      <Button
        v-if="unresolvedOperation"
        class="workspace-button"
        variant="outline"
        :disabled="busy || !usableConnection"
        @click="reconcile(unresolvedOperation)"
      >
        Перевірити результат у Google
      </Button>

      <section
        v-if="preview"
        class="sync-preview"
        aria-labelledby="sync-preview-heading"
      >
        <h4 id="sync-preview-heading">
          Перевірте дію перед відправленням
        </h4>
        <p>{{ preview.summary }}</p>
        <p v-if="preview.writeMode">
          Режим Google Docs: {{ preview.writeMode === 'EDIT' ? 'заміна тексту в порожньому документі' : 'пропозиції правок' }}.
        </p>
        <p
          v-if="preview.hasConflict"
          class="sync-warning"
        >
          Текст у редакторі та Google змінювався окремо. Перегляньте обидві версії, перш ніж продовжити.
        </p>
        <ul
          v-if="preview.unsupported?.length"
          class="sync-warning"
        >
          <li
            v-for="(item, index) in preview.unsupported"
            :key="index"
          >
            {{ typeof item === 'string' ? item : JSON.stringify(item) }}
          </li>
        </ul>
        <details><summary>Порівняти тексти</summary><h5>Стаття</h5><pre>{{ contentText(preview.localContent) }}</pre><h5>Google Документ</h5><pre>{{ contentText(preview.remoteContent) }}</pre><h5>Спільна базова версія</h5><pre>{{ contentText(preview.baselineContent) }}</pre></details>
        <div class="sync-actions">
          <Button
            class="workspace-button workspace-button-primary"
            :disabled="busy || props.readonly || preview.hasConflict || !!preview.unsupported?.length"
            @click="confirmPreview"
          >
            {{ previewConfirming ? 'Надсилаємо…' : 'Підтвердити й надіслати' }}
          </Button><Button
            class="workspace-button"
            variant="ghost"
            :disabled="busy"
            @click="preview = null; previewPayload = null"
          >
            Скасувати
          </Button>
        </div>
        <p class="sync-muted">
          Попередній перегляд діє до {{ formatDate(preview.expiresAt) }}. Після відправлення зміни можна буде звірити з новим знімком.
        </p>
      </section>

      <section
        class="sync-background"
        aria-labelledby="sync-background-heading"
      >
        <h4 id="sync-background-heading">
          Автоматична перевірка
        </h4>
        <label class="sync-toggle"><input
          type="checkbox"
          :checked="backgroundEnabled"
          :disabled="busy || props.readonly || (backgroundEnabled ? !(latestState.backgroundConnectionId || usableConnection) : !usableConnection)"
          @change="toggleBackground"
        ><span>Дозволити фонове читання Google Документа</span></label>
        <p class="sync-muted">
          Перевірка лише читає документ приблизно щохвилини. Її може зупинити будь-який учасник простору. Редагування завжди потребує вашого підтвердження.
        </p>
      </section>

      <section
        class="sync-local"
        aria-labelledby="sync-local-heading"
      >
        <h4 id="sync-local-heading">
          Коментарі з редактора
        </h4>
        <p class="sync-muted">
          Створюйте коментарі й пропозиції в панелі «Коментарі й правки». Тут можна перенести їх із вибраної збереженої версії до Google.
        </p>
        <article
          v-for="annotation in annotationThreads"
          :key="annotation.id"
          class="sync-annotation"
        >
          <p class="sync-muted">
            {{ annotation.kind === 'SUGGESTION' ? 'Пропозиція правки' : 'Коментар' }} · {{ displayStatus(annotation.status) }}
          </p>
          <blockquote>{{ annotation.quote }}</blockquote><p>{{ annotation.body }}</p><p v-if="annotation.replacementText">
            Запропоновано: {{ annotation.replacementText }}
          </p>
          <ol v-if="annotation.posts?.length">
            <li
              v-for="post in annotation.posts"
              :key="post.id"
            >
              <span>{{ post.authorName || post.createdBy || 'Учасник' }}<template v-if="post.createdAt"> · {{ formatDate(post.createdAt) }}</template></span><p>{{ post.body }}</p>
            </li>
          </ol>
          <Button
            v-if="annotation.kind === 'COMMENT' && !status?.threads.some(thread => thread.localAnnotationId === annotation.id)"
            class="workspace-button"
            variant="outline"
            :disabled="busy || props.readonly || !!unresolvedOperation"
            @click="exportAnnotation(annotation, 'COMMENT_CREATE')"
          >
            Створити коментар у Google Docs
          </Button>
          <Button
            v-if="annotation.kind === 'SUGGESTION' && !status?.threads.some(thread => thread.localAnnotationId === annotation.id)"
            class="workspace-button"
            variant="outline"
            :disabled="busy || props.readonly || !!unresolvedOperation"
            @click="exportAnnotation(annotation, 'SUGGESTION_CREATE')"
          >
            Створити пропозицію в Google Docs
          </Button>
        </article>
      </section>

      <section
        class="sync-threads"
        aria-labelledby="sync-threads-heading"
      >
        <h4 id="sync-threads-heading">
          Коментарі й пропозиції Google · {{ openThreads.length }} відкрито
        </h4>
        <p class="sync-muted">
          Ці гілки зберігаються окремо від погодження статті. Закриття версії не закриває коментарів і не приймає пропозицій.
        </p>
        <p
          v-if="!openThreads.length"
          class="sync-muted"
        >
          Відкритих гілок немає.
        </p>
        <article
          v-for="thread in openThreads"
          :key="thread.id"
          class="sync-thread"
        >
          <p class="sync-meta">
            {{ thread.kind === 'suggestion' ? 'Пропозиція правки' : 'Коментар' }} · {{ authorName(thread.author) }} · {{ displayStatus(thread.status) }}{{ thread.anchorStatus === 'unanchored' ? ' · місце не знайдено' : '' }}
          </p>
          <blockquote v-if="thread.quoteText">
            {{ thread.quoteText }}
          </blockquote><p
            v-else
            class="sync-warning"
          >
            Фрагмент не зіставлено з цією версією. Гілка збережена для ручного перегляду.
          </p>
          <p v-if="!posts(thread).length">
            {{ threadBody(thread) }}
          </p>
          <ul
            v-if="thread.kind === 'suggestion' && suggestionParts(thread).length"
            class="sync-suggestion-parts"
          >
            <li
              v-for="part in suggestionParts(thread)"
              :key="part.id"
              :class="{ 'sync-warning': !part.supported }"
            >
              {{ part.description }}<span v-if="!part.supported"> · цю частину не можна безпечно застосувати автоматично</span>
            </li>
          </ul>
          <p
            v-else-if="thread.kind === 'suggestion'"
            class="sync-warning"
          >
            Не вдалося точно зіставити частини пропозиції; перегляньте її в Google Документі.
          </p>
          <ol v-if="posts(thread).length">
            <li
              v-for="post in posts(thread)"
              :key="post.id"
            >
              <span>{{ post.author }}<template v-if="post.createdAt"> · {{ formatDate(post.createdAt) }}</template></span><p>{{ post.body }}</p>
            </li>
          </ol>
          <div
            v-if="unlinkedLocalReplies(thread).length"
            class="sync-local-replies"
          >
            <p class="sync-muted">
              Відповіді з редактора, які ще не перенесено
            </p>
            <article
              v-for="reply in unlinkedLocalReplies(thread)"
              :key="reply.id"
            >
              <blockquote>{{ reply.body }}</blockquote>
              <Button
                class="workspace-button"
                variant="outline"
                :disabled="busy || props.readonly || !!unresolvedOperation"
                @click="exportLocalReply(thread, reply)"
              >
                Перенести відповідь у Google
              </Button>
            </article>
          </div>
          <template v-if="thread.kind === 'comment'">
            <label :for="`google-reply-${thread.id}`">Відповісти</label><textarea
              :id="`google-reply-${thread.id}`"
              v-model="replyDrafts[thread.id]"
              rows="2"
              maxlength="2000"
              :disabled="busy || props.readonly || !!unresolvedOperation"
            /><Button
              class="workspace-button"
              variant="outline"
              :disabled="busy || !replyDrafts[thread.id]?.trim() || props.readonly || !!unresolvedOperation"
              @click="threadAction(thread, 'COMMENT_REPLY')"
            >
              Додати відповідь
            </Button>
            <Button
              class="workspace-button"
              variant="ghost"
              :disabled="busy || props.readonly || !!unresolvedOperation"
              @click="threadAction(thread, 'COMMENT_RESOLVE')"
            >
              Закрити коментар
            </Button>
          </template>
          <template v-else>
            <Button
              class="workspace-button sync-accept"
              variant="outline"
              :disabled="busy || !canAcceptSuggestion(thread) || props.readonly || !!unresolvedOperation"
              @click="threadAction(thread, 'SUGGESTION_ACCEPT')"
            >
              Прийняти всі частини
            </Button><Button
              class="workspace-button"
              variant="ghost"
              :disabled="busy || props.readonly || !!unresolvedOperation"
              @click="threadAction(thread, 'SUGGESTION_REJECT')"
            >
              Відхилити пропозицію
            </Button>
          </template>
        </article>
        <details v-if="closedThreads.length">
          <summary>Закриті гілки · {{ closedThreads.length }}</summary><article
            v-for="thread in closedThreads"
            :key="thread.id"
            class="sync-thread"
          >
            <p class="sync-meta">
              {{ thread.kind === 'suggestion' ? 'Пропозиція правки' : 'Коментар' }} · {{ authorName(thread.author) }} · {{ displayStatus(thread.status) }}
            </p><blockquote v-if="thread.quoteText">
              {{ thread.quoteText }}
            </blockquote><p>{{ threadBody(thread) }}</p><Button
              v-if="thread.kind === 'comment' && ['RESOLVED', 'CLOSED'].includes(String(thread.status).toUpperCase())"
              class="workspace-button"
              variant="outline"
              :disabled="busy || props.readonly || !!unresolvedOperation"
              @click="threadAction(thread, 'COMMENT_REOPEN')"
            >
              Відкрити знову
            </Button>
          </article>
        </details>
      </section>
      <section
        v-if="operations.length"
        class="sync-operations"
        aria-labelledby="sync-operations-heading"
      >
        <h4 id="sync-operations-heading">
          Останні дії
        </h4><ol>
          <li
            v-for="operation in operations.slice(0, 8)"
            :key="operation.id"
          >
            <span>{{ displayStatus(operation.kind) }} · {{ operationLabel(operation) }}<template v-if="operation.createdAt"> · {{ formatDate(operation.createdAt) }}</template></span><Button
              v-if="['UNKNOWN', 'PARTIAL'].includes(String(operation.state ?? operation.status).toUpperCase())"
              class="workspace-button"
              variant="outline"
              :disabled="busy || !usableConnection"
              @click="reconcile(operation)"
            >
              Перевірити в Google
            </Button><Button
              v-if="operation.resultVersionId"
              class="workspace-button"
              variant="ghost"
              @click="emit('candidate-created', operation.resultVersionId)"
            >
              Переглянути створену версію
            </Button>
          </li>
        </ol>
      </section>
    </template>
    <p
      v-if="notice"
      class="sync-success"
      role="status"
    >
      {{ notice }}
    </p><p
      v-if="error"
      class="article-error"
      role="alert"
    >
      {{ error }}
    </p>
  </div>
</template>

<style scoped>
.google-sync { display: flex; flex-direction: column; gap: 18px; min-width: 0; overflow-wrap: anywhere; }
.google-sync h3, .google-sync h4 { margin: 0 0 8px; font-size: 16px; font-weight: 550; }
.google-sync h4 { margin-top: 4px; }
.sync-heading-row, .sync-actions { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.sync-muted, .sync-meta { color: var(--muted); font-size: 13px; line-height: 1.55; }
.sync-state { display: flex; flex-wrap: wrap; gap: 6px 18px; padding-block: 12px; border-block: 1px solid var(--rule); font-size: 13px; }
.sync-warning { padding-block: 10px; border-block: 1px solid var(--rule); color: var(--review, #945000); font-size: 13px; line-height: 1.55; }
.sync-success { color: var(--approved, #32664b); font-size: 13px; line-height: 1.5; }
.google-sync label { display: block; margin: 8px 0 4px; font-size: 13px; }
.google-sync select, .google-sync textarea { width: 100%; min-height: 44px; border: 1px solid var(--field-rule, var(--rule)); border-radius: 3px; padding: 10px; background: var(--document); color: var(--ink); }
.google-sync textarea { resize: vertical; }
.google-sync section { padding-top: 16px; border-top: 1px solid var(--rule); }
.sync-preview, .sync-thread, .sync-annotation { padding: 14px 0; border-bottom: 1px solid var(--rule); }
.google-sync blockquote { margin: 10px 0; padding-left: 12px; border-left: 1px solid var(--rule); font-family: var(--serif); line-height: 1.5; }
.google-sync details summary { min-height: 44px; padding-block: 12px; cursor: pointer; }
.google-sync pre { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--selected); font-size: 12px; }
.sync-meta { margin: 0 0 8px; }
.sync-accept { max-width: 100%; height: auto; min-height: 44px; white-space: normal; text-align: left; }
.sync-thread li span { color: var(--muted); font-size: 13px; }
.sync-thread li p { line-height: 1.5; }
.sync-operations li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-block: 8px; }
.google-sync :is(button, select, textarea, summary):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
@media (max-width: 520px) { .sync-heading-row { align-items: flex-start; } .sync-actions { align-items: stretch; flex-direction: column; } .sync-actions button { width: 100%; } }
</style>
