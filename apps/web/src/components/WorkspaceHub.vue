<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import {
  DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle,
  SelectContent, SelectItem, SelectItemIndicator, SelectItemText, SelectPortal, SelectRoot, SelectTrigger, SelectValue, SelectViewport,
} from 'reka-ui'
import ProjectWorkspace from './ProjectWorkspace.vue'
import { Button } from '@/components/ui/button'

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
  trashedAt: string | null
  purgeAfter: string | null
  lifecycleRevision: number
  members?: Member[]
}

const props = defineProps<{ csrfToken: string; userId: string; refreshEpoch?: number }>()
const emit = defineEmits<{
  'session-expired': []
  'workspace-changed': []
  'workspace-state': [state: { selected: Workspace | null; workspaces: Workspace[] }]
}>()

const workspaces = ref<Workspace[]>([])
const selectedId = ref<string | null>(null)
const selectedDetail = ref<Workspace | null>(null)
const loading = ref(true)
const detailLoading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const actionError = ref('')
const name = ref('')
const inviteEmail = ref('')
const inviteToken = ref('')
const createdInviteUrl = ref('')
const transferTo = ref('')
const confirmAction = ref<'leave' | 'archive' | null>(null)
const dialogMode = ref<'choose' | 'create' | 'join' | 'manage' | null>(null)
const dialogOpen = computed({
  get: () => dialogMode.value !== null,
  set: (open: boolean) => { if (!open) dialogMode.value = null },
})
const dialogTitle = computed(() => dialogMode.value === 'create' ? 'Новий простір' : dialogMode.value === 'join' ? 'Приєднатися до простору' : dialogMode.value === 'manage' ? 'Керування простором' : 'Додати простір')
let dialogOpener: HTMLElement | null = null

function openDialog(mode: NonNullable<typeof dialogMode.value>, event?: MouseEvent) {
  dialogOpener = event?.currentTarget instanceof HTMLElement ? event.currentTarget : null
  actionError.value = ''
  notice.value = ''
  dialogMode.value = mode
}

function restoreDialogFocus(event: Event) {
  event.preventDefault()
  requestAnimationFrame(() => (dialogOpener ?? document.getElementById('workspace-new-action'))?.focus())
}

function onWorkspaceChange(value: unknown) {
  if (typeof value === 'string') switchWorkspace(value)
}

async function chooseWorkspaceAction(value: 'create' | 'join') {
  dialogMode.value = value
  await nextTick()
  document.getElementById(value === 'create' ? 'workspace-name' : 'workspace-invite-token')?.focus()
}
let selectionVersion = 0
let listVersion = 0

const selected = computed(() => workspaces.value.find(workspace => workspace.id === selectedId.value) ?? null)
function publishWorkspaceState() {
  const active = selectedDetail.value?.id === selectedId.value ? selectedDetail.value : selected.value
  emit('workspace-state', { selected: active ?? null, workspaces: workspaces.value })
}
const isOwner = computed(() => selected.value?.ownerId === props.userId)
const selectedLifecycleHint = computed(() => {
  if (!selected.value?.trashedAt) return 'Простір архівовано.'
  const date = selected.value.purgeAfter ? new Date(selected.value.purgeAfter) : null
  const label = date && !Number.isNaN(date.getTime())
    ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
    : 'дату не визначено'
  return `Простір у кошику. Його можна відновити до остаточного видалення; власнику воно доступне після ${label}.`
})
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
    publishWorkspaceState()
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
  if (dialogMode.value === 'manage') dialogMode.value = null
  confirmAction.value = null
  if (id) {
    window.localStorage.setItem(storageKey, id)
    void loadWorkspaceDetail(id)
  } else {
    selectionVersion += 1
    window.localStorage.removeItem(storageKey)
  }
  publishWorkspaceState()
}

async function loadWorkspaceDetail(id: string) {
  const version = ++selectionVersion
  detailLoading.value = true
  try {
    const result = await request<{ workspace: Workspace }>(`/api/v1/workspaces/${encodeURIComponent(id)}`)
    if (version === selectionVersion && selectedId.value === id) {
      selectedDetail.value = result.workspace
      publishWorkspaceState()
    }
  } catch (cause) {
    if (version === selectionVersion) actionError.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити учасників.'
  } finally {
    if (version === selectionVersion) detailLoading.value = false
  }
}

function switchWorkspace(id: string) {
  if (id === selectedId.value) return
  if (!allowWorkspaceChange()) return
  if (window.location.pathname.startsWith('/projects/')) {
    window.history.pushState({}, '', '/projects')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  selectWorkspace(id)
  emit('workspace-changed')
}

function allowWorkspaceChange() {
  const hasDraft = !!document.querySelector('.workspace-hub [data-workspace-leave-risk="true"]')
    || !!document.querySelector('.workspace-recovery [data-workspace-leave-risk="true"]')
    || Array.from(document.querySelectorAll<HTMLInputElement>('.workspace-hub input[type="file"]')).some(input => input.files?.length)
  return !hasDraft || window.confirm('У поточному проєкті є незбережені зміни. Зміна простору закриє їх. Залишити цей проєкт?')
}

function onProjectWorkspace(id: string) {
  if (id !== selectedId.value && workspaces.value.some(workspace => workspace.id === id)) selectWorkspace(id)
}

async function createWorkspace() {
  const trimmed = name.value.trim()
  if (!trimmed || busy.value) return
  if (!allowWorkspaceChange()) return
  busy.value = true
  actionError.value = ''
  try {
    const result = await request<{ workspace: Workspace }>('/api/v1/workspaces', 'POST', { name: trimmed })
    name.value = ''
    await loadWorkspaces(result.workspace.id)
    dialogMode.value = null
    emit('workspace-changed')
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
  if (!allowWorkspaceChange()) return
  busy.value = true
  actionError.value = ''
  try {
    const result = await request<{ workspace: Workspace }>('/api/v1/workspace-invites/accept', 'POST', { token })
    inviteToken.value = ''
    await loadWorkspaces(result.workspace.id)
    dialogMode.value = null
    emit('workspace-changed')
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
  if (action !== 'restore' && !allowWorkspaceChange()) return
  const id = selected.value.id
  busy.value = true
  actionError.value = ''
  try {
    const body = action === 'leave' ? {} : { expectedRevision: selected.value.lifecycleRevision }
    await request(`/api/v1/workspaces/${encodeURIComponent(id)}/${action}`, 'POST', body)
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
    dialogMode.value = 'join'
    fragment.delete('invite')
    const remainingFragment = fragment.toString()
    window.history.replaceState({}, '', url.pathname + url.search + (remainingFragment ? `#${remainingFragment}` : ''))
  }
  void loadWorkspaces()
})

watch(() => props.refreshEpoch, (next, previous) => {
  if (next !== previous) void loadWorkspaces()
})
</script>

<template>
  <div class="workspace-hub workspace-header-hub">
    <Teleport to="#workspace-header-controls">
      <div
        class="workspace-header-controls"
        aria-label="Робочий простір"
      >
        <span
          v-if="loading"
          class="workspace-header-loading"
          role="status"
        >Завантаження…</span>
        <button
          v-else-if="error"
          type="button"
          class="workspace-header-action"
          @click="loadWorkspaces()"
        >
          Повторити завантаження
        </button>
        <SelectRoot
          v-else-if="workspaces.length"
          :model-value="selectedId ?? ''"
          :disabled="busy"
          @update:model-value="onWorkspaceChange"
        >
          <SelectTrigger
            id="workspace-choice"
            class="workspace-header-select"
            aria-label="Поточний простір"
            :title="selected?.name"
          >
            <svg
              class="workspace-context-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            ><path d="M4 5h16v15H4zM8 5V3m8 2V3M4 10h16" /></svg>
            <span class="workspace-selected-name"><SelectValue placeholder="Оберіть простір" /></span>
            <svg
              class="workspace-chevron"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              aria-hidden="true"
            ><path d="m7 10 5 5 5-5" /></svg>
          </SelectTrigger>
          <SelectPortal>
            <SelectContent
              class="workspace-select-menu"
              position="popper"
              align="end"
              :side-offset="8"
              :avoid-collisions="true"
              :collision-padding="20"
            >
              <SelectViewport>
                <SelectItem
                  v-for="workspace in workspaces"
                  :key="workspace.id"
                  :value="workspace.id"
                  class="workspace-select-option"
                >
                  <SelectItemText>{{ workspace.name }}{{ workspace.trashedAt ? ' · Кошик' : workspace.archivedAt ? ' · Архів' : '' }}</SelectItemText>
                  <SelectItemIndicator class="workspace-option-check">
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.5"
                      aria-hidden="true"
                    ><path d="m5 12 4 4L19 6" /></svg>
                  </SelectItemIndicator>
                </SelectItem>
              </SelectViewport>
            </SelectContent>
          </SelectPortal>
        </SelectRoot>
        <button
          id="workspace-new-action"
          type="button"
          class="workspace-header-action"
          :disabled="busy"
          @click="openDialog('choose', $event)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          ><path d="M12 5v14M5 12h14" /></svg>
          <span>Новий простір</span>
        </button>
        <button
          v-if="selected"
          type="button"
          class="workspace-header-icon"
          aria-label="Керування простором"
          title="Керування простором"
          :disabled="busy"
          @click="openDialog('manage', $event)"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            aria-hidden="true"
          ><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3a4 4 0 0 1 0 8" /><circle
            cx="9"
            cy="7"
            r="4"
          /></svg>
        </button>
      </div>
    </Teleport>

    <DialogRoot v-model:open="dialogOpen">
      <DialogPortal>
        <DialogOverlay class="workspace-dialog-overlay" />
        <DialogContent
          class="workspace-dialog"
          @close-auto-focus="restoreDialogFocus"
          @escape-key-down="busy && $event.preventDefault()"
          @pointer-down-outside="busy && $event.preventDefault()"
        >
          <div class="workspace-dialog-heading">
            <DialogTitle class="workspace-dialog-title">
              {{ dialogTitle }}
            </DialogTitle>
            <DialogClose
              class="workspace-header-icon"
              aria-label="Закрити"
              :disabled="busy"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              ><path d="m6 6 12 12M18 6 6 18" /></svg>
            </DialogClose>
          </div>
          <DialogDescription class="workspace-dialog-description">
            {{ dialogMode === 'manage' ? selected?.name : dialogMode === 'join' ? 'Введіть код із запрошення.' : dialogMode === 'create' ? 'Простір об’єднує ваші проєкти та команду.' : 'Створіть свій простір або приєднайтеся за запрошенням.' }}
          </DialogDescription>
          <div
            v-show="dialogMode === 'choose'"
            class="workspace-action-choice"
          >
            <button
              type="button"
              class="workspace-choice-button"
              :disabled="busy"
              @click="chooseWorkspaceAction('create')"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              ><path d="M12 5v14M5 12h14" /></svg>
              Створити новий простір
            </button>
            <button
              type="button"
              class="workspace-choice-button"
              :disabled="busy"
              @click="chooseWorkspaceAction('join')"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              ><path d="M4 5h16v14H4zM4 6l8 6 8-6" /></svg>
              Прийняти запрошення
            </button>
          </div>
          <form
            v-show="dialogMode === 'create'"
            class="workspace-inline-form"
            @submit.prevent="createWorkspace"
          >
            <label for="workspace-name">Назва простору</label>
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
            <div class="workspace-dialog-actions">
              <Button
                type="submit"
                class="workspace-button workspace-button-primary"
                :disabled="busy || !name.trim()"
              >
                {{ busy ? 'Створюємо…' : 'Створити простір' }}
              </Button>
            </div>
          </form>
          <form
            v-show="dialogMode === 'join'"
            class="workspace-inline-form"
            @submit.prevent="acceptInvite"
          >
            <label for="workspace-invite-token">Код запрошення</label>
            <input
              id="workspace-invite-token"
              v-model="inviteToken"
              class="workspace-text-input"
              type="text"
              required
              autocomplete="off"
              :disabled="busy"
            >
            <div class="workspace-dialog-actions">
              <Button
                type="submit"
                class="workspace-button workspace-button-primary"
                :disabled="busy || !inviteToken.trim()"
              >
                {{ busy ? 'Приєднуємося…' : 'Приєднатися' }}
              </Button>
            </div>
          </form>
          <template v-if="dialogMode === 'manage' && selected">
            <div
              v-if="selected.archivedAt"
              class="workspace-archived-dialog"
            >
              <p>Цей простір архівовано. Його проєкти поки недоступні для роботи.</p>
              <Button
                v-if="isOwner"
                class="workspace-button workspace-button-primary"
                :disabled="busy"
                @click="finishLifecycle('restore')"
              >
                Відновити простір
              </Button>
            </div>
            <template v-else>
              <div class="workspace-management-content">
                <p
                  v-if="detailLoading"
                  role="status"
                >
                  Завантажуємо учасників…
                </p>
                <template v-else-if="selectedDetail">
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

              <Button
                v-if="!detailLoading && !selectedDetail"
                class="workspace-button workspace-button-secondary"
                variant="outline"
                @click="loadWorkspaceDetail(selected.id)"
              >
                Завантажити учасників ще раз
              </Button>
            </template>
          </template>
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
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <div
      v-if="error"
      class="workspace-header-status"
      role="alert"
    >
      {{ error }}
    </div>
    <p
      v-if="notice && !dialogOpen"
      class="workspace-header-status"
      role="status"
    >
      {{ notice }}
    </p>
    <p
      v-if="actionError && !dialogOpen"
      class="workspace-header-status"
      role="alert"
    >
      {{ actionError }}
    </p>
    <section
      v-if="!loading && !error && !selected"
      class="workspace-empty-state"
      aria-labelledby="workspace-empty-title"
    >
      <h1 id="workspace-empty-title">
        Робочі простори
      </h1>
      <p>Створіть простір для своїх проєктів або прийміть запрошення.</p>
      <Button
        class="workspace-button workspace-button-primary"
        @click="openDialog('choose', $event)"
      >
        Додати простір
      </Button>
    </section>
    <section
      v-else-if="selected?.archivedAt || selected?.trashedAt"
      class="workspace-empty-state"
      aria-labelledby="workspace-archived-title"
    >
      <h1 id="workspace-archived-title">
        {{ selected.name }}
      </h1>
      <p>{{ selectedLifecycleHint }}</p>
      <Button
        v-if="isOwner"
        class="workspace-button workspace-button-primary"
        :disabled="busy"
        @click="finishLifecycle('restore')"
      >
        Відновити простір
      </Button>
    </section>
    <ProjectWorkspace
      v-if="selected && !selected.archivedAt && !selected.trashedAt"
      :key="selected.id"
      :csrf-token="csrfToken"
      :workspace-id="selected.id"
      :user-id="userId"
      @session-expired="emit('session-expired')"
      @project-workspace="onProjectWorkspace"
    />
  </div>
</template>

<style scoped>
.workspace-header-hub { display: block; padding-top: 0; }
.workspace-header-controls { display: flex; align-items: center; gap: 4px; min-width: 0; }
.workspace-header-select, .workspace-header-action, .workspace-header-icon { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 40px; border: 0; border-radius: 3px; background: transparent; color: var(--ink); font: inherit; font-size: 13px; cursor: pointer; }
.workspace-header-select { max-width: clamp(160px, 24vw, 320px); padding: 8px 10px; }
.workspace-selected-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.workspace-header-action { padding: 8px 10px; white-space: nowrap; }
.workspace-header-icon { width: 40px; padding: 10px; flex: 0 0 auto; }
.workspace-header-select svg, .workspace-header-action svg, .workspace-header-icon svg, .workspace-option-check svg { width: 18px; height: 18px; flex: 0 0 auto; }
.workspace-header-select .workspace-chevron { width: 14px; height: 14px; color: var(--muted); }
.workspace-context-icon { color: var(--muted); }
.workspace-header-select:hover, .workspace-header-action:hover, .workspace-header-icon:hover { background: color-mix(in srgb, var(--ink) 4%, var(--document)); }
.workspace-header-select:focus-visible, .workspace-header-action:focus-visible, .workspace-header-icon:focus-visible, .workspace-choice-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.workspace-header-controls :disabled, .workspace-dialog :disabled { cursor: default; opacity: .55; }
.workspace-header-loading { color: var(--muted); font-size: 13px; padding: 10px; }
/* SelectContent forwards through several primitive roots; its portal has no Vue scope attribute. */
:global(.workspace-select-menu) { z-index: 60; width: min(360px, calc(100vw - 40px)); max-width: calc(100vw - 40px); max-height: min(var(--reka-select-content-available-height), 360px); overflow: auto; border: 1px solid var(--rule); background: var(--document); color: var(--ink); padding: 5px; font-family: var(--sans); font-size: 13px; }
:global(.workspace-select-menu [data-reka-select-viewport]) { width: 100%; min-width: 0; }
.workspace-select-option :deep(span) { white-space: normal; overflow-wrap: anywhere; }
.workspace-select-option { position: relative; min-height: 44px; padding: 12px 34px 12px 12px; overflow-wrap: anywhere; cursor: pointer; outline: none; }
.workspace-select-option[data-highlighted] { background: color-mix(in srgb, var(--ink) 4%, var(--document)); }
.workspace-select-option[data-state='checked'] { font-weight: 600; }
.workspace-option-check { position: absolute; right: 10px; top: 13px; }
.workspace-dialog-overlay { position: fixed; z-index: 70; inset: 0; background: rgb(32 38 43 / .28); }
.workspace-dialog { position: fixed; z-index: 71; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100vw - 40px)); max-height: calc(100dvh - 40px); overflow-y: auto; overscroll-behavior: contain; padding: 28px; background: var(--document); color: var(--ink); font-family: var(--sans); }
.workspace-dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.workspace-dialog-title { margin: 0; font-family: var(--serif); font-size: 29px; font-weight: 550; line-height: 1.2; }
.workspace-dialog-description { margin: 8px 0 24px; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.workspace-action-choice { display: grid; gap: 10px; }
.workspace-choice-button { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 12px 16px; background: var(--document); color: var(--ink); border: 1px solid var(--field-rule); border-radius: 3px; font: inherit; font-size: 14px; text-align: left; cursor: pointer; }
.workspace-choice-button svg { width: 18px; height: 18px; flex: 0 0 auto; }
.workspace-choice-button:hover { background: var(--selected); border-color: var(--ink); }
.workspace-dialog .workspace-inline-form { margin-top: 20px; }
.workspace-dialog .workspace-text-input { width: 100%; min-width: 0; }
.workspace-dialog-actions { display: flex; justify-content: flex-end; margin-top: 16px; }
.workspace-dialog .workspace-management-content { width: 100%; max-width: none; margin: 0; padding: 0; border: 0; }
.workspace-dialog .workspace-inline-controls { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
.workspace-dialog .workspace-inline-controls input { min-height: 44px; height: 44px; }
.workspace-dialog .workspace-inline-controls .workspace-text-input, .workspace-dialog .workspace-inline-controls select { flex: 1; min-width: 160px; }
.workspace-dialog .workspace-inline-controls .workspace-button { width: auto; }
.workspace-dialog .workspace-member-list { margin-bottom: 24px; }
.workspace-dialog .workspace-lifecycle { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--rule); }
.workspace-dialog .workspace-inline-error, .workspace-dialog .workspace-inline-notice { margin-top: 16px; }
.workspace-header-status { margin: 20px 0 0; font-size: 13px; }
.workspace-empty-state { padding-top: 52px; }
.workspace-empty-state h1 { font-family: var(--serif); font-size: 39px; font-weight: 550; }
.workspace-empty-state p { margin: 16px 0 24px; color: var(--muted); }
@media (max-width: 760px) {
  .workspace-header-controls { flex-wrap: wrap; gap: 0; }
  .workspace-header-select { max-width: min(100%, 260px); min-height: 44px; }
  .workspace-header-icon, .workspace-header-action { min-height: 44px; }
  .workspace-header-icon { width: 44px; }
  .workspace-context-icon { display: none; }
  .workspace-dialog { padding: 20px; }
  .workspace-dialog-title { font-size: 27px; }
  .workspace-dialog .workspace-inline-controls { grid-template-columns: minmax(0, 1fr); }
  .workspace-dialog .workspace-inline-controls .workspace-text-input, .workspace-dialog .workspace-inline-controls select { flex-basis: 100%; }
}
</style>
