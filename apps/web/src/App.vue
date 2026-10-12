<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import WorkspaceHub from './components/WorkspaceHub.vue'
import ProfileSettings from './components/ProfileSettings.vue'
import SiteFooter from './components/SiteFooter.vue'
import WorkspaceRecovery from './components/WorkspaceRecovery.vue'

interface User {
  id: string
  email: string
  displayName: string | null
}

interface SessionResponse {
  authenticated: boolean
  csrfToken: string
  user?: User
  reason?: 'expired'
  confirmationRequired?: boolean
  message?: string
}

type ViewState = 'loading' | 'signed-out' | 'signed-in' | 'unavailable'
type AuthMode = 'login' | 'register'
interface WorkspaceSummary {
  id: string
  name: string
  ownerId: string
  archivedAt: string | null
  trashedAt: string | null
  purgeAfter: string | null
  lifecycleRevision: number
  members?: { userId: string; displayName?: string | null; email?: string }[]
}

const state = ref<ViewState>('loading')
const profileOpen = ref(window.location.pathname === '/settings')
const selectedWorkspaceId = ref<string | null>(null)
const selectedWorkspace = ref<WorkspaceSummary | null>(null)
const workspaces = ref<WorkspaceSummary[]>([])
const workspaceRefreshEpoch = ref(0)
const accountMenu = ref<HTMLDetailsElement | null>(null)
let profileReturnPath = '/projects'
let profileReturnScroll = 0

function openProfile(hash = '') {
  if (!profileOpen.value) {
    profileReturnPath = window.location.pathname + window.location.search + window.location.hash
    profileReturnScroll = window.scrollY
  }
  accountMenu.value?.removeAttribute('open')
  window.history.pushState({}, '', `/settings${hash}`)
  profileOpen.value = true
  void nextTick(() => document.getElementById(hash.slice(1) || 'profile-heading')?.focus())
}

function returnToWork() {
  window.history.pushState({}, '', profileReturnPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
  void nextTick(() => window.scrollTo({ top: profileReturnScroll, behavior: 'instant' }))
}

function handleProfileLink(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  const url = new URL(link.href)
  if (url.origin === window.location.origin && url.pathname === '/settings') {
    event.preventDefault()
    openProfile(url.hash)
  }
}

function syncProfileRoute() {
  profileOpen.value = window.location.pathname === '/settings'
  accountMenu.value?.removeAttribute('open')
}

function onWorkspaceState(payload: { selected: WorkspaceSummary | null; workspaces: WorkspaceSummary[] }) {
  selectedWorkspace.value = payload.selected
  selectedWorkspaceId.value = payload.selected?.id ?? null
  workspaces.value = payload.workspaces
}

function onWorkspaceLifecycleChanged() {
  workspaceRefreshEpoch.value++
}

function closeAccountOutside(event: PointerEvent) {
  if (event.target instanceof Node && !accountMenu.value?.contains(event.target)) accountMenu.value?.removeAttribute('open')
}

watch([state, profileOpen], ([view, opened]) => {
  if (view === 'signed-in' && opened) void nextTick(() => document.getElementById(window.location.hash.slice(1) || 'profile-heading')?.focus())
})
const mode = ref<AuthMode>('login')
const user = ref<User | null>(null)
const csrfToken = ref('')
const email = ref('')
const password = ref('')
const displayName = ref('')
const busy = ref(false)
const message = ref('')
const messageKind = ref<'error' | 'success' | 'info'>('info')
const isRegistering = computed(() => mode.value === 'register')
const preferenceState = ref<'loading' | 'ready' | 'error'>('loading')
const savedIdleMinutes = ref<number | null>(null)
const draftIdleMinutes = ref<number | null>(null)
const preferenceMessage = ref('')
const preferenceSaving = ref(false)
const preferenceEditing = ref(false)
const formattedIdleTime = computed(() => {
  const minutes = savedIdleMinutes.value
  if (minutes === null) return ''
  if (minutes > 1440 && minutes % 1440 === 0) {
    const days = minutes / 1440
    return `${days} ${days === 2 || days === 3 || days === 4 ? 'доби' : 'діб'}`
  }
  if (minutes % 60 === 0) return `${minutes / 60} год`
  return `${minutes} хв`
})

// Every transition that replaces the auth state advances this generation. Responses
// from work started before logout or a newer session check cannot restore stale UI.
let generation = 0
let lastActivityAt = 0
let activityInFlight = false
let sessionCheckAbort: AbortController | undefined
let preferenceAbort: AbortController | undefined
let preferenceEpoch = 0
const activityEvents = ['pointerdown', 'keydown', 'input', 'touchstart'] as const

function clearPreferences() {
  preferenceEpoch++
  preferenceAbort?.abort()
  preferenceAbort = undefined
  preferenceState.value = 'loading'
  savedIdleMinutes.value = null
  draftIdleMinutes.value = null
  preferenceMessage.value = ''
  preferenceSaving.value = false
  preferenceEditing.value = false
}

function clearArticleRecovery() {
  window.dispatchEvent(new Event('cf:article-session-ended'))
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index)
      if (key?.startsWith('cf:article:') || key?.startsWith('cf:telegram:') || key?.startsWith('cf:channel:')) sessionStorage.removeItem(key)
    }
  } catch { /* Browser storage may be disabled; server-side saves remain canonical. */ }
}

async function loadPreferences() {
  preferenceAbort?.abort()
  const controller = new AbortController()
  const subjectUserId = user.value?.id
  const requestEpoch = preferenceEpoch
  preferenceAbort = controller
  preferenceState.value = 'loading'
  preferenceMessage.value = ''
  try {
    const response = await fetch('/api/auth/preferences', {
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (requestEpoch !== preferenceEpoch || preferenceAbort !== controller || subjectUserId !== user.value?.id || state.value !== 'signed-in') return
    if (response.status === 401) {
      await checkSession()
      if (requestEpoch === preferenceEpoch && state.value === 'signed-in') {
        preferenceState.value = 'error'
        preferenceMessage.value = 'Не вдалося перевірити сесію. Спробуйте ще раз.'
      }
      return
    }
    if (!response.ok) throw new Error('Preferences unavailable')
    const result = await response.json() as { preferences?: { idleTimeoutMinutes?: number } }
    if (requestEpoch !== preferenceEpoch || preferenceAbort !== controller || subjectUserId !== user.value?.id || state.value !== 'signed-in') return
    const minutes = result.preferences?.idleTimeoutMinutes
    if (!Number.isInteger(minutes) || minutes === undefined || minutes < 1 || minutes > 10080) {
      throw new Error('Invalid preferences')
    }
    savedIdleMinutes.value = minutes
    draftIdleMinutes.value = minutes
    preferenceState.value = 'ready'
  } catch {
    if (requestEpoch === preferenceEpoch && preferenceAbort === controller && subjectUserId === user.value?.id && state.value === 'signed-in' && !controller.signal.aborted) {
      preferenceState.value = 'error'
      preferenceMessage.value = 'Не вдалося завантажити налаштування сесії.'
    }
  } finally {
    if (preferenceAbort === controller) preferenceAbort = undefined
  }
}

async function savePreferences() {
  const minutes = Number(draftIdleMinutes.value)
  if (preferenceSaving.value || preferenceState.value !== 'ready') return
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
    preferenceMessage.value = 'Вкажіть цілу кількість хвилин від 1 до 10 080.'
    return
  }
  preferenceSaving.value = true
  preferenceMessage.value = ''
  const subjectUserId = user.value?.id
  const requestEpoch = preferenceEpoch
  try {
    const response = await fetch('/api/auth/preferences', {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken.value },
      body: JSON.stringify({ idleTimeoutMinutes: minutes }),
    })
    if (requestEpoch !== preferenceEpoch || subjectUserId !== user.value?.id || state.value !== 'signed-in') return
    if (response.status === 401) {
      await checkSession()
      if (requestEpoch === preferenceEpoch && state.value === 'signed-in') {
        preferenceMessage.value = 'Не вдалося перевірити сесію. Спробуйте зберегти ще раз.'
      }
      return
    }
    if (!response.ok) throw new Error('Preferences not saved')
    const result = await response.json() as { preferences?: { idleTimeoutMinutes?: number } }
    if (requestEpoch !== preferenceEpoch || subjectUserId !== user.value?.id || state.value !== 'signed-in') return
    const updatedMinutes = result.preferences?.idleTimeoutMinutes
    if (!Number.isInteger(updatedMinutes) || updatedMinutes === undefined) throw new Error('Invalid preferences')
    savedIdleMinutes.value = updatedMinutes
    draftIdleMinutes.value = updatedMinutes
    preferenceEditing.value = false
    preferenceMessage.value = 'Налаштування збережено.'
  } catch {
    if (requestEpoch === preferenceEpoch && subjectUserId === user.value?.id && state.value === 'signed-in') {
      preferenceMessage.value = 'Не вдалося зберегти. Спробуйте ще раз.'
    }
  } finally {
    if (requestEpoch === preferenceEpoch && subjectUserId === user.value?.id) preferenceSaving.value = false
  }
}

function cancelPreferenceEdit() {
  draftIdleMinutes.value = savedIdleMinutes.value
  preferenceEditing.value = false
  preferenceMessage.value = ''
}

function applySession(result: SessionResponse) {
  csrfToken.value = result.csrfToken
  if (result.authenticated && result.user) {
    if (user.value && user.value.id !== result.user.id) clearArticleRecovery()
    const needsPreferences = user.value?.id !== result.user.id || state.value !== 'signed-in'
    if (needsPreferences) clearPreferences()
    user.value = result.user
    state.value = 'signed-in'
    message.value = ''
    if (needsPreferences) void loadPreferences()
  } else {
    clearArticleRecovery()
    clearPreferences()
    user.value = null
    state.value = 'signed-out'
    if (result.reason === 'expired') {
      messageKind.value = 'info'
      message.value = 'Термін дії сесії завершився. Увійдіть, щоб продовжити.'
    }
  }
}

async function checkSession() {
  if (busy.value) return
  sessionCheckAbort?.abort()
  const controller = new AbortController()
  sessionCheckAbort = controller
  const requestGeneration = ++generation
  busy.value = false
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
    if (requestGeneration !== generation) return
    if (!response.ok) {
      if (response.status === 401) {
        clearArticleRecovery()
        clearPreferences()
        state.value = 'signed-out'
        user.value = null
        return
      }
      throw new Error('Session unavailable')
    }
    const result = await response.json() as SessionResponse
    if (requestGeneration !== generation) return
    applySession(result)
  } catch {
    if (requestGeneration !== generation) return
    state.value = 'unavailable'
  } finally {
    if (sessionCheckAbort === controller) sessionCheckAbort = undefined
  }
}

async function handleProjectSessionExpired() {
  await checkSession()
  if (state.value === 'signed-out') {
    messageKind.value = 'info'
    message.value = 'Сесію завершено. Увійдіть, щоб продовжити роботу.'
  }
}

async function postAuth(path: 'login' | 'register', body: Record<string, string>) {
  sessionCheckAbort?.abort()
  const requestGeneration = ++generation
  busy.value = true
  message.value = ''
  try {
    const response = await fetch(`/api/auth/${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken.value },
      body: JSON.stringify(body),
    })
    const result = await response.json() as SessionResponse
    if (requestGeneration !== generation) return
    if (response.status === 401) {
      messageKind.value = 'error'
      message.value = 'Не вдалося увійти. Перевірте адресу й пароль та спробуйте ще раз.'
      busy.value = false
      await checkSession()
      return
    }
    if (response.status === 403) {
      busy.value = false
      await checkSession()
      messageKind.value = 'info'
      message.value = 'Перевірку запиту оновлено. Введіть пароль і спробуйте ще раз.'
      return
    }
    if (!response.ok) throw new Error('Authentication failed')
    if (result.confirmationRequired) {
      csrfToken.value = result.csrfToken
      messageKind.value = 'success'
      message.value = result.message || 'Перевірте пошту, щоб підтвердити адресу. Після підтвердження можна буде увійти.'
      return
    }
    if (!result.authenticated || !result.user) throw new Error('Unexpected authentication response')
    applySession(result)
  } catch {
    if (requestGeneration === generation) {
      messageKind.value = 'error'
      message.value = 'Не вдалося виконати запит. Перевірте з’єднання та спробуйте ще раз.'
    }
  } finally {
    if (requestGeneration === generation) busy.value = false
  }
}

async function submitAuth() {
  if (busy.value || state.value !== 'signed-out') return
  const submittedPassword = password.value
  const submittedEmail = email.value.trim()
  const submittedName = displayName.value.trim()
  password.value = ''
  const path = isRegistering.value ? 'register' : 'login'
  const body: Record<string, string> = { email: submittedEmail, password: submittedPassword }
  if (path === 'register' && submittedName) body.displayName = submittedName
  await postAuth(path, body)
}

function selectMode(next: AuthMode) {
  if (busy.value || mode.value === next) return
  mode.value = next
  message.value = ''
  password.value = ''
}

async function logout() {
  if (busy.value || state.value !== 'signed-in') return
  sessionCheckAbort?.abort()
  const logoutGeneration = ++generation
  const token = csrfToken.value
  clearArticleRecovery()
  clearPreferences()
  state.value = 'loading'
  busy.value = true
  message.value = ''
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
      body: JSON.stringify({}),
    })
    const result = await response.json() as SessionResponse
    if (logoutGeneration !== generation) return
    if (!response.ok) throw new Error('Logout failed')
    applySession({ authenticated: false, csrfToken: result.csrfToken })
  } catch {
    if (logoutGeneration === generation) {
      // The server may have invalidated the cookie despite a lost response. Re-check
      // without extending activity before presenting any authenticated state again.
      busy.value = false
      await checkSession()
    }
  } finally {
    if (logoutGeneration === generation) busy.value = false
  }
}

async function recordActivity(event: Event) {
  if (!event.isTrusted || state.value !== 'signed-in' || !csrfToken.value || activityInFlight) return
  const now = Date.now()
  if (now - lastActivityAt < 30_000) return
  lastActivityAt = now
  activityInFlight = true
  const requestGeneration = generation
  try {
    const response = await fetch('/api/auth/activity', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken.value },
      body: JSON.stringify({}),
    })
    if (requestGeneration !== generation) return
    if (response.status === 401) {
      user.value = null
      clearArticleRecovery()
      state.value = 'signed-out'
      await checkSession()
    }
  } catch {
    // A transient activity failure should not interrupt the current task. The server
    // still enforces its idle limit on the next protected request.
  } finally {
    activityInFlight = false
  }
}

function onVisibilityChange() {
  if (document.visibilityState === 'visible' && state.value !== 'loading') void checkSession()
}

onMounted(() => {
  window.addEventListener('popstate', syncProfileRoute)
  document.addEventListener('pointerdown', closeAccountOutside)
  // Email confirmation uses provider PKCE. We sign in with the password afterward;
  // the one-time code is not exchanged or retained by this browser.
  const confirmationUrl = new URL(window.location.href)
  if (confirmationUrl.searchParams.has('code')) {
    confirmationUrl.searchParams.delete('code')
    window.history.replaceState(null, '', confirmationUrl.pathname + confirmationUrl.search + confirmationUrl.hash)
    messageKind.value = 'info'
    message.value = 'Адресу підтверджено. Увійдіть зі своєю поштою та паролем.'
  }
  void checkSession()
  document.addEventListener('visibilitychange', onVisibilityChange)
  for (const eventName of activityEvents) window.addEventListener(eventName, recordActivity, { passive: true })
})

onUnmounted(() => {
  window.removeEventListener('popstate', syncProfileRoute)
  document.removeEventListener('pointerdown', closeAccountOutside)
  sessionCheckAbort?.abort()
  preferenceAbort?.abort()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  for (const eventName of activityEvents) window.removeEventListener(eventName, recordActivity)
})
</script>

<template>
  <div
    class="app-frame"
    @click="handleProfileLink"
  >
    <div
      class="site-shell"
      :class="{ 'author-desk-app': state === 'signed-in' }"
    >
      <header class="site-header">
        <a
          v-if="state === 'signed-in'"
          class="skip-link"
          href="#workspace-task"
        >До робочої області</a>
        <a
          class="wordmark"
          href="/"
          aria-label="ContextFlow — на початок"
        >
          <span>ContextFlow</span>
        </a>
        <span
          v-if="state !== 'signed-in'"
          class="header-note"
        >Редакційний робочий простір</span>
        <div
          v-if="state === 'signed-in'"
          id="workspace-header-controls"
        />
        <details
          v-if="state === 'signed-in'"
          ref="accountMenu"
          class="account-details workspace-utilities"
          @keydown.esc="($event.currentTarget as HTMLDetailsElement).open = false; ($event.currentTarget as HTMLDetailsElement).querySelector('summary')?.focus()"
        >
          <summary
            id="account-title"
            class="account-name"
          >
            {{ user?.displayName || 'Обліковий запис' }}
          </summary>
          <div class="workspace-utilities-menu">
            <p class="account-email">
              {{ user?.email }}
            </p>
            <a
              class="account-icon-action"
              href="/settings"
              aria-label="Налаштування профілю"
              title="Налаштування профілю"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path d="m9.4 3-.6 2.4-2 .9-2.1-.7-2.1 3.6 1.6 1.7-.2 2.2-1.7 1.6 2.1 3.6 2.3-.5 1.8 1.3.5 2.9h4.2l.6-2.4 2-.9 2.1.7 2.1-3.6-1.6-1.7.2-2.2 1.7-1.6-2.1-3.6-2.3.5-1.8-1.3-.5-2.9Z" /><circle
                cx="12"
                cy="12"
                r="3"
              /></svg>
            </a>
            <button
              class="account-icon-action"
              type="button"
              :disabled="busy"
              :aria-label="busy ? 'Завершуємо сесію' : 'Вийти'"
              title="Вийти"
              @click="logout"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="1.7"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              ><path d="M10 4H4v16h6M10 12h11m-4-4 4 4-4 4" /></svg>
            </button>
          </div>
        </details>
      </header>

      <main
        id="main-content"
        class="auth-layout"
        :class="{ 'signed-in-layout': state === 'signed-in' }"
      >
        <section
          v-if="state !== 'signed-in'"
          class="intro"
          aria-labelledby="welcome-title"
        >
          <p class="eyebrow">
            Дослідження · Редактура · Публікація
          </p>
          <h1 id="welcome-title">
            Від джерел — до змістовних матеріалів.
          </h1>
          <p class="intro-copy">
            ContextFlow допомагає зібрати важливе з ваших джерел і перетворити його
            на продумані матеріали для кожного каналу.
          </p>
          <div
            class="intro-rule"
            aria-hidden="true"
          />
          <p class="quiet-note">
            Усе необхідне для уважної редакційної роботи — в одному просторі.
          </p>
        </section>

        <section
          v-if="state === 'loading'"
          class="auth-panel status-panel"
          aria-live="polite"
        >
          <p class="eyebrow">
            Ваш простір
          </p>
          <h2>Перевіряємо сесію</h2>
          <p class="panel-copy">
            Це займе лише мить.
          </p>
          <span
            class="loading-mark"
            aria-hidden="true"
          />
        </section>

        <section
          v-else-if="state === 'unavailable'"
          class="auth-panel"
          aria-labelledby="unavailable-title"
        >
          <p class="eyebrow">
            З’єднання
          </p>
          <h2 id="unavailable-title">
            Сервіс тимчасово недоступний
          </h2>
          <p class="panel-copy">
            Не вдалося перевірити вашу сесію. Спробуйте ще раз за мить.
          </p>
          <button
            class="button button-primary"
            type="button"
            @click="checkSession"
          >
            Спробувати ще раз
          </button>
        </section>

        <section
          v-else-if="state === 'signed-out'"
          class="auth-panel"
          aria-labelledby="auth-title"
        >
          <p class="eyebrow">
            Ваш простір
          </p>
          <div
            class="auth-heading-row"
            :class="{ 'register-heading': isRegistering }"
          >
            <h2 id="auth-title">
              {{ isRegistering ? 'Створіть обліковий запис' : 'Раді вас бачити' }}
            </h2>
            <div
              class="mode-switch"
              role="group"
              aria-label="Дія з обліковим записом"
            >
              <button
                type="button"
                :aria-pressed="mode === 'login'"
                @click="selectMode('login')"
              >
                Вхід
              </button>
              <button
                type="button"
                :aria-pressed="mode === 'register'"
                @click="selectMode('register')"
              >
                Реєстрація
              </button>
            </div>
          </div>
          <p class="panel-copy">
            {{ isRegistering ? 'Почніть з особистого робочого простору.' : 'Увійдіть, щоб продовжити редакційну роботу.' }}
          </p>

          <form
            class="auth-form"
            @submit.prevent="submitAuth"
          >
            <label
              v-if="isRegistering"
              class="field"
            >
              <span>Ваше ім’я <span class="optional">необов’язково</span></span>
              <input
                v-model="displayName"
                autocomplete="name"
                name="displayName"
                type="text"
                maxlength="80"
                :disabled="busy"
              >
            </label>
            <label class="field">
              <span>Електронна пошта</span>
              <input
                v-model="email"
                autocomplete="email"
                name="email"
                type="email"
                required
                maxlength="254"
                :disabled="busy"
              >
            </label>
            <label class="field">
              <span>Пароль</span>
              <input
                v-model="password"
                :autocomplete="isRegistering ? 'new-password' : 'current-password'"
                name="password"
                type="password"
                required
                :minlength="isRegistering ? 8 : 1"
                maxlength="128"
                :disabled="busy"
              >
            </label>
            <p
              v-if="message"
              class="form-message"
              :class="`message-${messageKind}`"
              role="status"
              aria-live="polite"
            >
              {{ message }}
            </p>
            <button
              class="button button-primary submit-button"
              type="submit"
              :disabled="busy || !csrfToken"
            >
              <span
                v-if="busy"
                class="button-spinner"
                aria-hidden="true"
              />
              {{ busy ? 'Зачекайте…' : isRegistering ? 'Створити обліковий запис' : 'Увійти' }}
            </button>
          </form>
          <p class="privacy-note">
            За замовчуванням сесія завершується після 24 годин бездіяльності. Особистий ліміт можна змінити після входу.
          </p>
        </section>

        <section
          v-else
          class="signed-in-workspace"
          aria-labelledby="account-title"
        >
          <ProfileSettings
            v-show="profileOpen"
            :email="user?.email ?? ''"
            :display-name="user?.displayName ?? null"
            :csrf-token="csrfToken"
            :user-id="user?.id ?? ''"
            @back="returnToWork"
            @session-expired="handleProjectSessionExpired"
          >
            <template #session>
              <p class="profile-current-limit">
                {{ preferenceState === 'ready' ? `Після бездіяльності: ${formattedIdleTime}` : preferenceState === 'loading' ? 'Завантаження…' : 'Не вдалося завантажити' }}
              </p>
              <div class="session-settings-body">
                <p class="session-settings-explanation">
                  Сесія завершується після обраного часу бездіяльності. Після входу вона в будь-якому разі діє не довше 7 діб.
                </p>
                <p
                  v-if="preferenceState === 'loading'"
                  class="session-settings-status"
                  role="status"
                >
                  Завантажуємо ваші налаштування…
                </p>
                <div v-else-if="preferenceState === 'error'">
                  <p
                    class="session-settings-error"
                    role="alert"
                  >
                    {{ preferenceMessage }}
                  </p>
                  <button
                    class="button button-secondary session-settings-action"
                    type="button"
                    @click="loadPreferences()"
                  >
                    Спробувати ще раз
                  </button>
                </div>
                <form
                  v-else-if="preferenceEditing"
                  class="session-settings-form"
                  @submit.prevent="savePreferences"
                >
                  <label
                    class="field"
                    for="idle-timeout-minutes"
                  >
                    <span>Завершувати після бездіяльності, хвилин</span>
                    <input
                      id="idle-timeout-minutes"
                      v-model.number="draftIdleMinutes"
                      type="number"
                      inputmode="numeric"
                      min="1"
                      max="10080"
                      step="1"
                      required
                      :disabled="preferenceSaving"
                      aria-describedby="idle-timeout-help"
                    >
                  </label>
                  <p
                    id="idle-timeout-help"
                    class="session-settings-hint"
                  >
                    Від 1 хвилини до 7 діб. 24 години — 1440 хвилин.
                  </p>
                  <div class="session-settings-actions">
                    <button
                      class="button button-primary"
                      type="submit"
                      :disabled="preferenceSaving"
                    >
                      {{ preferenceSaving ? 'Зберігаємо…' : 'Зберегти' }}
                    </button>
                    <button
                      class="button button-secondary"
                      type="button"
                      :disabled="preferenceSaving"
                      @click="cancelPreferenceEdit"
                    >
                      Скасувати
                    </button>
                  </div>
                </form>
                <button
                  v-else
                  class="button button-secondary session-settings-action"
                  type="button"
                  @click="preferenceEditing = true; preferenceMessage = ''"
                >
                  Змінити ліміт
                </button>
                <p
                  v-if="preferenceState === 'ready' && preferenceMessage"
                  class="session-settings-status"
                  :class="{ 'session-settings-error': preferenceEditing }"
                  role="status"
                  aria-live="polite"
                >
                  {{ preferenceMessage }}
                </p>
              </div>
            </template>
          </ProfileSettings>
          <WorkspaceRecovery
            v-show="profileOpen"
            :csrf-token="csrfToken"
            :user-id="user?.id ?? ''"
            :selected-workspace-id="selectedWorkspaceId"
            :selected-workspace="selectedWorkspace"
            :workspaces="workspaces"
            @session-expired="handleProjectSessionExpired"
            @changed="onWorkspaceLifecycleChanged"
          />
          <WorkspaceHub
            v-show="!profileOpen"
            :key="user?.id ?? ''"
            :csrf-token="csrfToken"
            :user-id="user?.id ?? ''"
            :refresh-epoch="workspaceRefreshEpoch"
            @session-expired="handleProjectSessionExpired"
            @workspace-changed="profileReturnPath = '/projects'; profileReturnScroll = 0"
            @workspace-state="onWorkspaceState"
          />
        </section>
      </main>
      <footer
        v-if="state !== 'signed-in'"
        class="site-footer"
      >
        <span>Контент починається з довіри до джерел.</span>
      </footer>
    </div>
    <SiteFooter v-if="state === 'signed-in'" />
  </div>
</template>
