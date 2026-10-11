<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'
import GoogleDocSync from './GoogleDocSync.vue'

type Connection = { id: string; displayName: string | null; status: 'connected' | 'disconnected' | 'needs_connection'; providerAccess: 'authorized' | 'verify_in_google_account' | 'reauthorize' }
type DocumentTab = { tabId: string; title: string | null }
type InspectedDocument = { documentId: string; title: string | null; revisionId: string; tabs: DocumentTab[] }
type Binding = { id: string; documentId: string; tabId: string; connectionId: string; createdAt: string; snapshot: { id: string; remoteRevision: string; contentHash: string; capturedAt: string; converted: { content: unknown; unsupported: unknown; inlineCoordinatesValid: boolean } } | null }
type CreateCommand = { id: string; commandKey: string; title: string; state: 'SUBMITTED' | 'UNKNOWN' | 'CREATED' | 'FAILED'; documentId: string | null; connectionId: string; createdAt: string; updatedAt: string }
type RequestError = Error & { status?: number }

const props = defineProps<{ projectId: string; csrfToken: string; userId: string; expectedArticleRevision: number; targetVersionId?: string | null; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; 'candidate-created': [versionId: string] }>()
const connections = ref<Connection[]>([])
const binding = ref<Binding | null>(null)
const createCommands = ref<CreateCommand[]>([])
const createTitle = ref('')
const documentInput = ref('')
const documentId = ref('')
const documentTitle = ref('')
const revisionId = ref('')
const tabs = ref<DocumentTab[]>([])
const tabId = ref('')
const connectionId = ref('')
const acknowledgeSharing = ref(false)
const loading = ref(false)
const inspecting = ref(false)
const busy = ref(false)
const error = ref('')
const pendingFingerprint = ref('')
const pendingCommandKey = ref('')
const pendingPayload = ref<Record<string, unknown> | null>(null)
const authorizationLink = ref('')
const createUnknown = ref(false)
const createConflict = ref(false)
const base = computed(() => `/api/v1/projects/${encodeURIComponent(props.projectId)}/google-docs`)
const activeConnections = computed(() => connections.value.filter(item => item.status === 'connected' && item.providerAccess === 'authorized'))
const unresolvedCreate = computed(() => createCommands.value.find(item => item.state === 'SUBMITTED' || item.state === 'UNKNOWN') ?? null)
const latestCreatedCommand = computed(() => createCommands.value.find(item => item.state === 'CREATED' && item.documentId) ?? null)
const snapshotWarnings = computed(() => Array.isArray(binding.value?.snapshot?.converted.unsupported) ? binding.value.snapshot.converted.unsupported.length : 0)
const bindingDocumentTitle = computed(() => {
  const title = (binding.value?.snapshot?.converted.content as { title?: unknown } | undefined)?.title
  return typeof title === 'string' && title.trim() ? title : null
})
let scopeEpoch = 0
let disposed = false
let oauthWindow: Window | null = null
let pendingCreateFingerprint = ''
let pendingCreateCommandKey = ''
let pendingCreatePayload: Record<string, unknown> | null = null

function clearPrivateState() {
  connections.value = []; binding.value = null; createCommands.value = []; createTitle.value = ''; createUnknown.value = false; createConflict.value = false; documentInput.value = ''; documentId.value = ''; documentTitle.value = ''
  revisionId.value = ''; tabs.value = []; tabId.value = ''; connectionId.value = ''; acknowledgeSharing.value = false
  error.value = ''; pendingFingerprint.value = ''; pendingCommandKey.value = ''; pendingPayload.value = null
  pendingCreateFingerprint = ''; pendingCreateCommandKey = ''; pendingCreatePayload = null
  authorizationLink.value = ''
  try { oauthWindow?.close() } catch { /* A closed or navigated OAuth window is harmless. */ }
  oauthWindow = null
  loading.value = false; inspecting.value = false; busy.value = false
}
function uuid() { return crypto.randomUUID() }
function csrfHeaders() { return { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken } }
async function request(url: string, payload?: unknown, epoch = scopeEpoch) {
  const response = await fetch(url, { credentials: 'same-origin', method: payload === undefined ? 'GET' : 'POST', ...(payload === undefined ? {} : { headers: csrfHeaders(), body: JSON.stringify(payload) }) })
  if (response.status === 401) { if (!disposed && epoch === scopeEpoch) emit('session-expired'); throw Object.assign(new Error('Сесію завершено.'), { status: 401 }) as RequestError }
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Перевірте посилання на документ і вибрану вкладку.',
      403: 'Немає доступу до документа або Google-підключення. Перевірте доступ і виберіть інше підключення.',
      409: url.includes('/create') ? 'Є інший незавершений запит на створення документа. Перевірте його результат перед новою спробою.' : 'Стаття або прив’язка змінилися. Оновіть стан і повторіть дію.',
      503: 'Google Docs тимчасово недоступний. Спробуйте пізніше.',
    }
    throw Object.assign(new Error(messages[response.status] ?? 'Не вдалося виконати дію. Дані форми збережено; спробуйте ще раз.'), { status: response.status }) as RequestError
  }
  return response.json() as Promise<Record<string, unknown>>
}
function showError(cause: unknown) { error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
function updateCreateCommand(command: CreateCommand) {
  createCommands.value = [command, ...createCommands.value.filter(row => row.id !== command.id)]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  if (command.commandKey === pendingCreateCommandKey) {
    if (command.state === 'FAILED' || command.state === 'CREATED') {
      createUnknown.value = false; pendingCreateFingerprint = ''; pendingCreateCommandKey = ''; pendingCreatePayload = null
      if (command.state === 'CREATED') createTitle.value = ''
    } else createUnknown.value = command.state === 'UNKNOWN'
  }
}
function createStateLabel(state: CreateCommand['state']) {
  return ({ SUBMITTED: 'Перевіряється', UNKNOWN: 'Потрібно перевірити', CREATED: 'Створено', FAILED: 'Не створено' } as const)[state]
}
async function load(preserveError = false) {
  const epoch = scopeEpoch
  loading.value = true; if (!preserveError) error.value = ''
  try {
    const [connectionData, bindingData, commandData] = await Promise.all([
      request('/api/v1/google-docs/connections', undefined, epoch), request(`${base.value}/binding`, undefined, epoch),
      request(`${base.value}/create-commands`, undefined, epoch),
    ])
    if (disposed || epoch !== scopeEpoch) return
    connections.value = (connectionData.connections as Connection[] | undefined) ?? []
    binding.value = (bindingData.binding as Binding | null | undefined) ?? null
    createCommands.value = (commandData.commands as CreateCommand[] | undefined) ?? []
    if (pendingCreateCommandKey && !createCommands.value.some(item => item.commandKey === pendingCreateCommandKey)) createUnknown.value = true
    else if (createCommands.value.some(item => item.commandKey === pendingCreateCommandKey && (item.state === 'FAILED' || item.state === 'CREATED'))) {
      createUnknown.value = false; pendingCreateFingerprint = ''; pendingCreateCommandKey = ''; pendingCreatePayload = null
    }
    if (!connectionId.value || !activeConnections.value.some(item => item.id === connectionId.value)) connectionId.value = activeConnections.value[0]?.id ?? ''
  } catch (cause) { if (!disposed && epoch === scopeEpoch) showError(cause) }
  finally { if (!disposed && epoch === scopeEpoch) loading.value = false }
}
function parseDocument(value: string) {
  const input = value.trim()
  if (!input) return null
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null
    const match = url.pathname.match(/^\/document\/d\/([A-Za-z0-9_-]+)(?:\/|$)/u)
    return match && match[1]!.length <= 1024 ? { documentId: match[1]!, tabId: url.searchParams.get('tab') ?? '' } : null
  } catch {
    return /^[A-Za-z0-9_-]{10,1024}$/u.test(input) ? { documentId: input, tabId: '' } : null
  }
}
function resetInspection() { documentId.value = ''; documentTitle.value = ''; revisionId.value = ''; tabs.value = []; tabId.value = '' }
watch(documentInput, resetInspection)
watch(connectionId, resetInspection)
async function inspect() {
  const parsed = parseDocument(documentInput.value)
  if (!parsed || !connectionId.value || inspecting.value) return
  const epoch = scopeEpoch
  resetInspection(); documentId.value = parsed.documentId; inspecting.value = true; error.value = ''
  try {
    const result = await request(`${base.value}/inspect`, { connectionId: connectionId.value, documentId: parsed.documentId }, epoch)
    if (disposed || epoch !== scopeEpoch) return
    const doc = result.document as InspectedDocument
    documentId.value = doc.documentId; documentTitle.value = doc.title ?? 'Без назви'; revisionId.value = doc.revisionId; tabs.value = doc.tabs
    // A tab from the pasted URL is only selected when Google confirmed that exact ID.
    tabId.value = parsed.tabId && doc.tabs.some(tab => tab.tabId === parsed.tabId) ? parsed.tabId : ''
  } catch (cause) { if (!disposed && epoch === scopeEpoch) showError(cause) }
  finally { if (!disposed && epoch === scopeEpoch) inspecting.value = false }
}
async function createDocument() {
  const titleValue = createTitle.value.trim()
  if (busy.value || props.archived || binding.value || unresolvedCreate.value || createUnknown.value || !connectionId.value || !titleValue || titleValue.length > 200) return
  const epoch = scopeEpoch
  const payload = { connectionId: connectionId.value, title: titleValue, expectedArticleRevision: props.expectedArticleRevision }
  const fingerprint = JSON.stringify({ connectionId: payload.connectionId, title: payload.title })
  if (fingerprint !== pendingCreateFingerprint || !pendingCreateCommandKey || !pendingCreatePayload) {
    pendingCreateFingerprint = fingerprint; pendingCreateCommandKey = uuid()
    pendingCreatePayload = { ...payload, commandKey: pendingCreateCommandKey }
  }
  busy.value = true; error.value = ''; createUnknown.value = false; createConflict.value = false
  try {
    const result = await request(`${base.value}/create`, pendingCreatePayload, epoch)
    if (disposed || epoch !== scopeEpoch) return
    updateCreateCommand(result.command as CreateCommand)
  } catch (cause) {
    if (!disposed && epoch === scopeEpoch) {
      const status = (cause as RequestError)?.status
      const definitiveFailure = [400, 403, 409].includes(status ?? 0)
      // Keep the key until the journal read tells us whether a provider-side
      // create already completed before a later fence/access error.
      createUnknown.value = !definitiveFailure
      showError(cause)
      await load(true)
      if (epoch === scopeEpoch && pendingCreateCommandKey) {
        const known = createCommands.value.find(row => row.commandKey === pendingCreateCommandKey)
        if (known && (known.state === 'CREATED' || known.state === 'FAILED')) updateCreateCommand(known)
        else if (definitiveFailure && !known) {
          pendingCreateFingerprint = ''; pendingCreateCommandKey = ''; pendingCreatePayload = null
          createUnknown.value = false
        }
      }
    }
  } finally { if (!disposed && epoch === scopeEpoch) busy.value = false }
}
async function checkCreateResult() {
  if (busy.value) return
  const epoch = scopeEpoch
  busy.value = true; error.value = ''
  try {
    const result = await request(`${base.value}/create-commands`, undefined, epoch)
    if (disposed || epoch !== scopeEpoch) return
    createCommands.value = (result.commands as CreateCommand[] | undefined) ?? []
    const match = (pendingCreateCommandKey ? createCommands.value.find(row => row.commandKey === pendingCreateCommandKey) : null)
      ?? unresolvedCreate.value
    if (!match) {
      createUnknown.value = true
      createConflict.value = false
      error.value = 'Результат ще не з’явився в історії. Перевірте його пізніше; новий документ не створювався.'
      return
    }
    updateCreateCommand(match)
    if (match.state === 'SUBMITTED' || match.state === 'UNKNOWN') {
      const reconciled = await request(`${base.value}/create-commands/${encodeURIComponent(match.id)}/reconcile`, { connectionId: connectionId.value }, epoch)
      if (disposed || epoch !== scopeEpoch) return
      updateCreateCommand(reconciled.command as CreateCommand)
      createConflict.value = reconciled.conflict === true || reconciled.matches === 0
    }
  } catch (cause) { if (!disposed && epoch === scopeEpoch) showError(cause) }
  finally { if (!disposed && epoch === scopeEpoch) busy.value = false }
}
async function chooseCreatedDocument(command: CreateCommand) {
  if (!command.documentId || busy.value) return
  connectionId.value = command.connectionId
  documentInput.value = command.documentId
  await nextTick()
  await inspect()
}
async function connectGoogle() {
  if (busy.value) return
  const epoch = scopeEpoch
  // Reserve a user-initiated tab before awaiting the API so the editor and its draft stay open.
  const reservedWindow = window.open('about:blank', '_blank')
  if (reservedWindow) { reservedWindow.opener = null; oauthWindow = reservedWindow }
  busy.value = true; error.value = ''
  try {
    const result = await request('/api/v1/google-docs/oauth/start', {}, epoch)
    if (disposed || epoch !== scopeEpoch) return
    const authorizationUrl = result.authorizationUrl
    let url: URL
    try { url = new URL(typeof authorizationUrl === 'string' ? authorizationUrl : '') } catch { throw new Error('Не отримано безпечне посилання для авторизації Google.') }
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password) throw new Error('Не отримано безпечне посилання для авторизації Google.')
    if (reservedWindow) { reservedWindow.location.replace(url.href); oauthWindow = null }
    else authorizationLink.value = url.href
  } catch (cause) {
    try { reservedWindow?.close() } catch { /* No action needed when the browser already closed it. */ }
    if (!disposed && epoch === scopeEpoch) showError(cause)
  }
  finally { if (!disposed && epoch === scopeEpoch) busy.value = false }
}
async function bind() {
  if (busy.value || !documentId.value || !tabId.value || !connectionId.value || !acknowledgeSharing.value || props.archived) return
  const epoch = scopeEpoch
  const payload = { connectionId: connectionId.value, documentId: documentId.value, tabId: tabId.value, acknowledgeWorkspaceSharing: true, expectedArticleRevision: props.expectedArticleRevision }
  // Article revision is deliberately excluded: after an unknown response, autosave
  // may advance the draft revision, while the same command still must be replayed.
  const fingerprint = JSON.stringify({ connectionId: payload.connectionId, documentId: payload.documentId, tabId: payload.tabId, acknowledgeWorkspaceSharing: true })
  if (fingerprint !== pendingFingerprint.value) {
    pendingFingerprint.value = fingerprint; pendingCommandKey.value = uuid()
    pendingPayload.value = { ...payload, commandKey: pendingCommandKey.value }
  }
  busy.value = true; error.value = ''
  try {
    const result = await request(`${base.value}/bind`, pendingPayload.value, epoch)
    if (disposed || epoch !== scopeEpoch) return
    binding.value = result.binding as Binding
    pendingFingerprint.value = ''; pendingCommandKey.value = ''; pendingPayload.value = null
  } catch (cause) {
    if (!disposed && epoch === scopeEpoch) {
      if ((cause as RequestError)?.status === 409) { pendingFingerprint.value = ''; pendingCommandKey.value = ''; pendingPayload.value = null }
      showError(cause)
    }
  }
  finally { if (!disposed && epoch === scopeEpoch) busy.value = false }
}
async function unbind() {
  const current = binding.value
  if (!current || busy.value || props.archived) return
  const epoch = scopeEpoch
  busy.value = true; error.value = ''
  try { await request(`${base.value}/unbind`, { expectedBindingId: current.id }, epoch); if (disposed || epoch !== scopeEpoch) return; binding.value = null }
  catch (cause) { if (!disposed && epoch === scopeEpoch) showError(cause) }
  finally { if (!disposed && epoch === scopeEpoch) busy.value = false }
}
function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'невідомо' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
watch(() => [props.projectId, props.userId], () => { scopeEpoch++; clearPrivateState(); void load() })
function endSession() { scopeEpoch++; clearPrivateState() }
onMounted(() => { window.addEventListener('cf:article-session-ended', endSession); void load() })
onBeforeUnmount(() => { disposed = true; scopeEpoch++; window.removeEventListener('cf:article-session-ended', endSession) })
</script>

<template>
  <div
    class="google-docs-panel"
    aria-label="Прив’язка Google Документа"
  >
    <p class="google-docs-note">
      Прив’язка зберігає вибраний документ і його стан. Експорт і отримання змін виконуються окремими підтвердженими діями.
    </p>

    <section
      v-if="binding"
      class="google-docs-current"
      aria-labelledby="google-docs-current-heading"
    >
      <h3 id="google-docs-current-heading">
        Прив’язаний документ
      </h3>
      <p>
        <a
          :href="`https://docs.google.com/document/d/${encodeURIComponent(binding.documentId)}/edit?tab=${encodeURIComponent(binding.tabId)}`"
          target="_blank"
          rel="noopener noreferrer"
        >{{ bindingDocumentTitle || 'Відкрити Google документ' }}</a>
      </p>
      <p class="google-docs-note">
        ID: <code>{{ binding.documentId }}</code>
      </p>
      <p>Вкладка: <code>{{ binding.tabId }}</code></p>
      <template v-if="binding.snapshot">
        <p>Останній знімок: {{ formatDate(binding.snapshot.capturedAt) }}</p>
        <p
          v-if="snapshotWarnings || !binding.snapshot.converted.inlineCoordinatesValid"
          class="google-docs-warning"
        >
          Є непідтримані елементи або непевні координати. Коментарі й правки можуть вимагати ручної перевірки.
        </p>
      </template>
      <p
        v-else
        class="google-docs-warning"
      >
        Для цієї прив’язки ще немає знімка.
      </p>
      <Button
        class="workspace-button"
        variant="outline"
        :disabled="busy || archived"
        @click="unbind"
      >
        Від’єднати документ
      </Button>
      <p class="google-docs-note">
        Історія попередніх прив’язок і знімків зберігається.
      </p>
    </section>

    <GoogleDocSync
      v-if="binding"
      :project-id="projectId"
      :csrf-token="csrfToken"
      :user-id="userId"
      :expected-article-revision="expectedArticleRevision"
      :target-version-id="targetVersionId ?? null"
      :connection-id="connectionId"
      :readonly="!!archived"
      @session-expired="emit('session-expired')"
      @candidate-created="emit('candidate-created', $event)"
    />
    <section aria-labelledby="google-docs-connect-heading">
      <h3 id="google-docs-connect-heading">
        Google-підключення
      </h3>
      <p v-if="!activeConnections.length">
        Підключіть свій обліковий запис Google, щоб вибрати доступний документ.
      </p>
      <label
        v-else
        for="google-docs-connection"
      >Обліковий запис</label>
      <select
        v-if="activeConnections.length"
        id="google-docs-connection"
        v-model="connectionId"
        :disabled="busy || inspecting"
      >
        <option
          v-for="item in activeConnections"
          :key="item.id"
          :value="item.id"
        >
          {{ item.displayName || 'Підключений обліковий запис' }}
        </option>
      </select>
      <div class="google-docs-actions">
        <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || archived"
          @click="connectGoogle"
        >
          {{ activeConnections.length ? 'Додати підключення' : 'Підключити Google' }}
        </Button>
        <Button
          class="workspace-button"
          variant="ghost"
          :disabled="loading || busy"
          @click="load"
        >
          Оновити підключення
        </Button>
      </div>
      <p
        v-if="authorizationLink"
        class="google-docs-note"
      >
        <a
          :href="authorizationLink"
          target="_blank"
          rel="noopener noreferrer"
        >Продовжити до Google</a>
      </p>
      <p class="google-docs-note">
        Після авторизації поверніться до редактора й оновіть підключення. Доступ Google залишається особистим.
      </p>
    </section>

    <section
      v-if="!binding && (activeConnections.length || unresolvedCreate || createUnknown)"
      aria-labelledby="google-docs-create-heading"
    >
      <h3 id="google-docs-create-heading">
        Створити новий документ
      </h3>
      <p class="google-docs-note">
        Створюється порожній Google Документ. Стаття не експортується й не змінюється. Після створення ви окремо виберете документ, вкладку та підтвердите прив’язку.
      </p>
      <template v-if="unresolvedCreate || createUnknown">
        <p
          class="google-docs-create-pending"
          role="status"
        >
          {{ createConflict ? 'Знайдено кілька документів. Потрібно перевірити результат вручну.' : unresolvedCreate?.state === 'SUBMITTED' ? 'Результат створення перевіряється.' : 'Google міг створити документ. Перевірте результат.' }}
        </p>
        <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || loading"
          @click="checkCreateResult"
        >
          {{ busy ? 'Перевіряємо…' : 'Перевірити результат' }}
        </Button>
      </template>
      <template v-else-if="activeConnections.length">
        <label for="google-docs-create-title">Назва документа</label>
        <input
          id="google-docs-create-title"
          v-model="createTitle"
          type="text"
          maxlength="200"
          autocomplete="off"
          placeholder="Наприклад, Чернетка статті"
          :disabled="busy || archived"
        >
        <Button
          class="workspace-button workspace-button-primary"
          :disabled="busy || archived || !connectionId || !createTitle.trim() || createTitle.trim().length > 200"
          @click="createDocument"
        >
          {{ busy ? 'Створюємо…' : 'Створити порожній документ' }}
        </Button>
      </template>
    </section>

    <section
      v-if="!binding && latestCreatedCommand"
      class="google-docs-created-result"
      aria-label="Створений Google документ"
    >
      <p><strong>{{ latestCreatedCommand.title }}</strong> · Документ створено.</p>
      <Button
        class="workspace-button"
        variant="outline"
        :disabled="busy || archived || !activeConnections.some(item => item.id === latestCreatedCommand?.connectionId)"
        @click="chooseCreatedDocument(latestCreatedCommand)"
      >
        {{ busy && documentInput === latestCreatedCommand.documentId ? 'Перевіряємо…' : 'Вибрати створений документ' }}
      </Button>
      <p class="google-docs-note">
        Це лише вибір для подальшої перевірки. Документ ще не прив’язано.
      </p>
    </section>

    <details
      v-if="createCommands.length"
      class="google-docs-history"
    >
      <summary>Історія нових документів ({{ createCommands.length }})</summary>
      <ul>
        <li
          v-for="command in createCommands"
          :key="command.id"
          class="google-docs-history-item"
        >
          <div>
            <strong>{{ command.title }}</strong>
            <span class="google-docs-note">{{ createStateLabel(command.state) }} · {{ formatDate(command.updatedAt) }}</span>
          </div>
          <Button
            v-if="command.state === 'CREATED' && command.documentId && !binding && command.id !== latestCreatedCommand?.id"
            class="workspace-button"
            variant="outline"
            :disabled="busy || archived"
            @click="chooseCreatedDocument(command)"
          >
            Вибрати «{{ command.title }}»
          </Button>
        </li>
      </ul>
    </details>

    <section
      v-if="activeConnections.length && !binding"
      aria-labelledby="google-docs-select-heading"
    >
      <h3 id="google-docs-select-heading">
        Вибрати наявний документ
      </h3>
      <label for="google-docs-url">Посилання або ID документа</label>
      <input
        id="google-docs-url"
        v-model="documentInput"
        type="url"
        autocomplete="off"
        placeholder="https://docs.google.com/document/d/…/edit"
        :disabled="busy || inspecting"
      >
      <Button
        class="workspace-button"
        variant="outline"
        :disabled="busy || archived || inspecting || !connectionId || !parseDocument(documentInput)"
        @click="inspect"
      >
        {{ inspecting ? 'Перевіряємо…' : 'Перевірити документ' }}
      </Button>
      <template v-if="documentId && documentTitle">
        <p class="google-docs-document-title">
          {{ documentTitle }}
        </p>
        <label for="google-docs-tab">Вкладка документа</label>
        <select
          id="google-docs-tab"
          v-model="tabId"
          :disabled="busy || archived || inspecting"
        >
          <option
            value=""
            disabled
          >
            Виберіть вкладку
          </option>
          <option
            v-for="tab in tabs"
            :key="tab.tabId"
            :value="tab.tabId"
          >
            {{ tab.title || 'Без назви' }} · {{ tab.tabId }}
          </option>
        </select>
        <p class="google-docs-note">
          Вкладку не вибрано автоматично. Перевірте її назву перед прив’язкою.
        </p>
        <label
          class="google-docs-sharing"
          for="google-docs-sharing"
        >
          <input
            id="google-docs-sharing"
            v-model="acknowledgeSharing"
            type="checkbox"
            :disabled="busy || archived"
          >
          <span>Підтверджую: текст, коментарі та доступні дані авторів будуть видимі учасникам цього робочого простору.</span>
        </label>
        <Button
          class="workspace-button workspace-button-primary"
          :disabled="busy || archived || !tabId || !acknowledgeSharing"
          @click="bind"
        >
          Прив’язати документ
        </Button>
      </template>
    </section>

    <p
      v-if="error"
      class="google-docs-error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="loading"
      class="google-docs-note"
      role="status"
    >
      Завантажуємо стан Google-підключення…
    </p>
  </div>
</template>

<style scoped>
.google-docs-panel { display: grid; gap: 24px; min-width: 0; font-size: 14px; }
.google-docs-panel section { padding-block: 4px 18px; border-bottom: 1px solid var(--rule); }
.google-docs-panel .google-docs-created-result { padding: 12px; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface-subtle, var(--document)); }
.google-docs-panel h3 { margin: 0 0 10px; font-size: 15px; font-weight: 550; }
.google-docs-panel p { line-height: 1.55; margin: 8px 0; overflow-wrap: anywhere; }
.google-docs-panel label:not(.google-docs-sharing) { display: block; margin: 12px 0 6px; }
.google-docs-panel input:not([type=checkbox]), .google-docs-panel select { width: 100%; min-height: 44px; border: 1px solid var(--field-rule, var(--rule)); border-radius: 3px; background: var(--document); color: var(--ink); padding: 9px 10px; margin-bottom: 10px; }
.google-docs-panel input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--ink); flex: 0 0 auto; }
.google-docs-sharing { display: flex; gap: 10px; align-items: flex-start; margin: 14px 0; line-height: 1.5; }
.google-docs-note { color: var(--muted); font-size: 13px; }
.google-docs-warning, .google-docs-error { color: var(--error); }
.google-docs-document-title { font-family: var(--serif); font-size: 18px; }
.google-docs-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-block: 8px; }
.google-docs-panel code { overflow-wrap: anywhere; }
.google-docs-panel :is(button, a, select, input):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
</style>
