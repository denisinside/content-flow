<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ProjectWorkspace from './ProjectWorkspace.vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

interface Member {
  userId: string
  email?: string
  displayName?: string | null
}

interface Workspace {
  id: string
  name: string
  ownerId: string
  archivedAt: string | null
  members?: Member[]
}

const props = defineProps<{ csrfToken: string; userId: string }>()
const emit = defineEmits<{ 'session-expired': [] }>()

const workspaces = ref<Workspace[]>([])
const selectedId = ref<string | null>(null)
const selectedDetail = ref<Workspace | null>(null)
const loading = ref(true)
const detailLoading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const actionError = ref('')
const createOpen = ref(false)
const name = ref('')
const inviteEmail = ref('')
const inviteToken = ref('')
const createdInviteUrl = ref('')
const transferTo = ref('')
const confirmAction = ref<'leave' | 'archive' | null>(null)
const managementOpen = ref(false)
const acceptOpen = ref(false)
let selectionVersion = 0
let listVersion = 0

const selected = computed(() => workspaces.value.find(workspace => workspace.id === selectedId.value) ?? null)
const isOwner = computed(() => selected.value?.ownerId === props.userId)
const members = computed(() => selectedDetail.value?.members ?? [])
const otherMembers = computed(() => members.value.filter(member => member.userId !== props.userId))
const storageKey = `contextflow.workspace.${props.userId}`

function readableError(status: number) {
  if (status === 404) return 'Простір недоступний або його більше не існує.'
  if (status === 409) return 'Стан простору змінився. Оновіть дані та спробуйте ще раз.'
  if (status === 400) return 'Перевірте введені дані та спробуйте ще раз.'
  if (status === 403) return 'Ця дія зараз недоступна для вашого облікового запису.'
  return 'Не вдалося виконати запит. Перевірте з’єднання та спробуйте ще раз.'
}

async function request<T>(url: string, method = 'GET', body?: object): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: 'same-origin',
  }
  if (body) {
    init.headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }
    init.body = JSON.stringify(body)
  }
  const response = await fetch(url, init)
  if (response.status === 401) {
    emit('session-expired')
    throw new Error('Сесію завершено. Увійдіть знову.')
  }
  if (!response.ok) throw new Error(readableError(response.status))
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

async function loadWorkspaces(preferredId = selectedId.value) {
  const version = ++listVersion
  loading.value = true
  error.value = ''
  try {
    const all: Workspace[] = []
    let cursor: string | null = null
    do {
      const query: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
      const result: { workspaces: Workspace[]; nextCursor: string | null } = await request(`/api/v1/workspaces${query}`)
      if (version !== listVersion) return
      all.push(...result.workspaces)
      cursor = result.nextCursor
    } while (cursor)
    workspaces.value = all
    const remembered = preferredId ?? window.localStorage.getItem(storageKey)
    const next = all.some(workspace => workspace.id === remembered)
      ? remembered
      : all.find(workspace => !workspace.archivedAt)?.id ?? all[0]?.id ?? null
    if (next === selectedId.value && next) void loadWorkspaceDetail(next)
    else selectWorkspace(next)
  } catch (cause) {
    if (version !== listVersion) return
    error.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити простори.'
  } finally {
    if (version === listVersion) loading.value = false
  }
}

function selectWorkspace(id: string | null) {
  if (selectedId.value === id) return
  selectedId.value = id
  selectedDetail.value = null
  actionError.value = ''
  notice.value = ''
  createdInviteUrl.value = ''
  managementOpen.value = false
  confirmAction.value = null
  if (id) {
    window.localStorage.setItem(storageKey, id)
    void loadWorkspaceDetail(id)
  } else {
    selectionVersion += 1
    window.localStorage.removeItem(storageKey)
  }
}

async function loadWorkspaceDetail(id: string) {
  const version = ++selectionVersion
  detailLoading.value = true
  try {
    const result = await request<{ workspace: Workspace }>(`/api/v1/workspaces/${encodeURIComponent(id)}`)
    if (version === selectionVersion && selectedId.value === id) selectedDetail.value = result.workspace
  } catch (cause) {
    if (version === selectionVersion) actionError.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити учасників.'
  } finally {
    if (version === selectionVersion) detailLoading.value = false
  }
}

function switchWorkspace(id: string) {
  if (id === selectedId.value) return
  if (window.location.pathname.startsWith('/projects/')) {
    window.history.pushState({}, '', '/projects')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  selectWorkspace(id)
}

function onProjectWorkspace(id: string) {
  if (id !== selectedId.value && workspaces.value.some(workspace => workspace.id === id)) selectWorkspace(id)
}

async function createWorkspace() {
  const trimmed = name.value.trim()
  if (!trimmed || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    const result = await request<{ workspace: Workspace }>('/api/v1/workspaces', 'POST', { name: trimmed })
    name.value = ''
    createOpen.value = false
    await loadWorkspaces(result.workspace.id)
    notice.value = 'Робочий простір створено.'
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'Не вдалося створити простір.'
  } finally {
    busy.value = false
  }
}

async function invite() {
  const email = inviteEmail.value.trim()
  if (!selected.value || !email || busy.value) return
  busy.value = true
  actionError.value = ''
  notice.value = ''
  try {
    const result = await request<{ invite: { token: string } }>(`/api/v1/workspaces/${encodeURIComponent(selected.value.id)}/invites`, 'POST', { email })
    inviteEmail.value = ''
    createdInviteUrl.value = `${window.location.origin}/projects#invite=${encodeURIComponent(result.invite.token)}`
    notice.value = `Запрошення для ${email} створено. Передайте посилання саме цій людині.`
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'Не вдалося створити запрошення.'
  } finally {
    busy.value = false
  }
}

async function acceptInvite() {
  const token = inviteToken.value.trim()
  if (!token || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    const result = await request<{ workspace: Workspace }>('/api/v1/workspace-invites/accept', 'POST', { token })
    inviteToken.value = ''
    await loadWorkspaces(result.workspace.id)
    notice.value = 'Запрошення прийнято. Ви можете працювати в цьому просторі.'
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'Не вдалося прийняти запрошення.'
  } finally {
    busy.value = false
  }
}

async function transfer() {
  if (!selected.value || !transferTo.value || busy.value) return
  busy.value = true
  actionError.value = ''
  try {
    await request(`/api/v1/workspaces/${encodeURIComponent(selected.value.id)}/transfer`, 'POST', { userId: transferTo.value })
    await loadWorkspaces(selected.value.id)
    notice.value = 'Право власності передано.'
    transferTo.value = ''
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'Не вдалося передати право власності.'
  } finally {
    busy.value = false
  }
}

async function finishLifecycle(action: 'leave' | 'archive' | 'restore') {
  if (!selected.value || busy.value) return
  const id = selected.value.id
  busy.value = true
  actionError.value = ''
  try {
    await request(`/api/v1/workspaces/${encodeURIComponent(id)}/${action}`, 'POST', {})
    confirmAction.value = null
    await loadWorkspaces(action === 'restore' ? id : null)
    notice.value = action === 'leave' ? 'Ви вийшли з робочого простору.' : action === 'archive' ? 'Простір архівовано.' : 'Простір відновлено.'
  } catch (cause) {
    actionError.value = cause instanceof Error ? cause.message : 'Не вдалося змінити стан простору.'
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  const url = new URL(window.location.href)
  const fragment = new URLSearchParams(url.hash.slice(1))
  const token = fragment.get('invite')
  if (token) {
    inviteToken.value = token
    acceptOpen.value = true
    fragment.delete('invite')
    const remainingFragment = fragment.toString()
    window.history.replaceState({}, '', url.pathname + url.search + (remainingFragment ? `#${remainingFragment}` : ''))
  }
  void loadWorkspaces()
})
</script>

<template>
  <div class="workspace-hub">
    <section
      class="workspace-switcher"
      aria-labelledby="workspace-switcher-title"
    >
      <div class="workspace-switcher-heading">
        <div>
          <p class="eyebrow">
            Команда та спільні налаштування
          </p>
          <h1
            v-if="!selected"
            id="workspace-switcher-title"
            class="workspace-switcher-title"
          >
            Робочі простори
          </h1>
          <p
            v-else
            id="workspace-switcher-title"
            class="workspace-switcher-title"
          >
            Робочі простори
          </p>
        </div>
        <Button
          class="workspace-button workspace-button-quiet"
          variant="outline"
          :disabled="busy"
          @click="createOpen = !createOpen"
        >
          {{ createOpen ? 'Скасувати' : 'Новий простір' }}
        </Button>
      </div>

      <div
        v-if="loading"
        class="workspace-switcher-loading"
        role="status"
        aria-live="polite"
      >
        <Skeleton class="workspace-switcher-skeleton" />
        <span>Завантажуємо простори…</span>
      </div>
      <div
        v-else-if="error"
        class="workspace-inline-error"
        role="alert"
      >
        {{ error }}
        <Button
          class="workspace-button workspace-button-quiet"
          variant="outline"
          @click="loadWorkspaces()"
        >
          Спробувати ще раз
        </Button>
      </div>
      <template v-else>
        <div
          v-if="workspaces.length"
          class="workspace-choice"
        >
          <label for="workspace-choice">Поточний простір</label>
          <select
            id="workspace-choice"
            :value="selectedId ?? ''"
            :disabled="busy"
            @change="switchWorkspace(($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="workspace in workspaces"
              :key="workspace.id"
              :value="workspace.id"
            >
              {{ workspace.name }}{{ workspace.archivedAt ? ' · Архів' : '' }}
            </option>
          </select>
          <span
            v-if="selected?.archivedAt"
            class="workspace-archive-label"
          >Архівований</span>
        </div>
        <p
          v-else
          class="workspace-inline-empty"
        >
          Створіть простір для команди та її проєктів або прийміть запрошення.
        </p>
      </template>

      <form
        v-if="createOpen"
        class="workspace-inline-form"
        @submit.prevent="createWorkspace"
      >
        <label for="workspace-name">Назва простору</label>
        <div class="workspace-inline-controls">
          <input
            id="workspace-name"
            v-model="name"
            class="workspace-text-input"
            type="text"
            maxlength="120"
            required
            placeholder="Наприклад, Редакція"
            :disabled="busy"
          >
          <Button
            type="submit"
            class="workspace-button workspace-button-primary"
            :disabled="busy || !name.trim()"
          >
            Створити простір
          </Button>
        </div>
      </form>
      <details
        class="workspace-accept"
        :open="acceptOpen"
        @toggle="acceptOpen = ($event.target as HTMLDetailsElement).open"
      >
        <summary>Маєте запрошення?</summary>
        <form
          class="workspace-inline-form"
          @submit.prevent="acceptInvite"
        >
          <label for="workspace-invite-token">Код запрошення</label>
          <div class="workspace-inline-controls">
            <input
              id="workspace-invite-token"
              v-model="inviteToken"
              class="workspace-text-input"
              type="text"
              required
              autocomplete="off"
              :disabled="busy"
            >
            <Button
              type="submit"
              class="workspace-button workspace-button-secondary"
              variant="outline"
              :disabled="busy || !inviteToken.trim()"
            >
              Приєднатися
            </Button>
          </div>
        </form>
      </details>
      <p
        v-if="notice"
        class="workspace-inline-notice"
        role="status"
      >
        {{ notice }}
      </p>
      <p
        v-if="actionError"
        class="workspace-inline-error"
        role="alert"
      >
        {{ actionError }}
      </p>
    </section>

    <details
      v-if="selected && !selected.archivedAt"
      class="workspace-management"
      :open="managementOpen"
      @toggle="managementOpen = ($event.target as HTMLDetailsElement).open"
    >
      <summary>Учасники та керування простором</summary>
      <div class="workspace-management-content">
        <p
          v-if="detailLoading"
          role="status"
        >
          Завантажуємо учасників…
        </p>
        <template v-else>
          <p
            v-if="members.length"
            class="workspace-member-heading"
          >
            Учасники
          </p>
          <ul
            v-if="members.length"
            class="workspace-member-list"
          >
            <li
              v-for="member in members"
              :key="member.userId"
            >
              {{ member.displayName || member.email || member.userId }}<span v-if="member.userId === selected.ownerId"> · Власник</span>
            </li>
          </ul>
          <form
            class="workspace-inline-form"
            @submit.prevent="invite"
          >
            <label for="workspace-invite-email">Запросити людину</label>
            <div class="workspace-inline-controls">
              <input
                id="workspace-invite-email"
                v-model="inviteEmail"
                class="workspace-text-input"
                type="email"
                maxlength="254"
                required
                autocomplete="email"
                placeholder="Адреса електронної пошти"
                :disabled="busy"
              >
              <Button
                type="submit"
                class="workspace-button workspace-button-secondary"
                variant="outline"
                :disabled="busy || !inviteEmail.trim()"
              >
                Запросити
              </Button>
            </div>
          </form>
          <div
            v-if="createdInviteUrl"
            class="workspace-invite-link"
          >
            <label for="created-invite-link">Посилання для запрошеної людини</label>
            <input
              id="created-invite-link"
              class="workspace-text-input"
              type="text"
              readonly
              :value="createdInviteUrl"
              @focus="($event.target as HTMLInputElement).select()"
            >
          </div>
          <form
            v-if="isOwner && otherMembers.length"
            class="workspace-inline-form"
            @submit.prevent="transfer"
          >
            <label for="workspace-transfer">Передати право власності</label>
            <div class="workspace-inline-controls">
              <select
                id="workspace-transfer"
                v-model="transferTo"
                :disabled="busy"
                required
              >
                <option value="">
                  Оберіть учасника
                </option>
                <option
                  v-for="member in otherMembers"
                  :key="member.userId"
                  :value="member.userId"
                >
                  {{ member.displayName || member.email || member.userId }}
                </option>
              </select>
              <Button
                type="submit"
                class="workspace-button workspace-button-secondary"
                variant="outline"
                :disabled="busy || !transferTo"
              >
                Передати
              </Button>
            </div>
          </form>
          <div class="workspace-lifecycle">
            <template v-if="confirmAction">
              <p>{{ confirmAction === 'leave' ? 'Після виходу ви втратите доступ до всіх проєктів цього простору. Продовжити?' : 'Архівувати цей простір та його проєкти?' }}</p>
              <Button
                class="workspace-button workspace-button-secondary"
                variant="outline"
                :disabled="busy"
                @click="finishLifecycle(confirmAction)"
              >
                Підтвердити
              </Button>
              <Button
                class="workspace-button workspace-button-quiet"
                variant="ghost"
                :disabled="busy"
                @click="confirmAction = null"
              >
                Скасувати
              </Button>
            </template>
            <Button
              v-else-if="isOwner && selectedDetail && otherMembers.length === 0"
              class="workspace-button workspace-button-quiet"
              variant="ghost"
              :disabled="busy || detailLoading"
              @click="confirmAction = 'archive'"
            >
              Архівувати простір
            </Button>
            <Button
              v-else-if="!isOwner"
              class="workspace-button workspace-button-quiet"
              variant="ghost"
              :disabled="busy"
              @click="confirmAction = 'leave'"
            >
              Вийти з простору
            </Button>
            <p
              v-else
              class="workspace-lifecycle-hint"
            >
              Щоб вийти, спочатку передайте право власності іншому учаснику.
            </p>
          </div>
        </template>
      </div>
    </details>
    <div
      v-else-if="selected?.archivedAt"
      class="workspace-archived-note"
    >
      <p>Цей робочий простір архівовано. Його проєкти поки недоступні для роботи.</p>
      <Button
        v-if="isOwner"
        class="workspace-button workspace-button-secondary"
        variant="outline"
        :disabled="busy"
        @click="finishLifecycle('restore')"
      >
        Відновити простір
      </Button>
    </div>

    <ProjectWorkspace
      v-if="selected && !selected.archivedAt"
      :key="selected.id"
      :csrf-token="csrfToken"
      :workspace-id="selected.id"
      @session-expired="emit('session-expired')"
      @project-workspace="onProjectWorkspace"
    />
  </div>
</template>
