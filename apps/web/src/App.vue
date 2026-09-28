<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import WorkspaceHub from './components/WorkspaceHub.vue'
import ExternalProcessingNotice from './components/ExternalProcessingNotice.vue'

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

const state = ref<ViewState>('loading')
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
    const needsPreferences = user.value?.id !== result.user.id || state.value !== 'signed-in'
    if (needsPreferences) clearPreferences()
    user.value = result.user
    state.value = 'signed-in'
    message.value = ''
    if (needsPreferences) void loadPreferences()
  } else {
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
  sessionCheckAbort?.abort()
  preferenceAbort?.abort()
  document.removeEventListener('visibilitychange', onVisibilityChange)
  for (const eventName of activityEvents) window.removeEventListener(eventName, recordActivity)
})
</script>

<template>
  <div class="site-shell">
    <header class="site-header">
      <a
        class="wordmark"
        href="/"
        aria-label="ContextFlow — на початок"
      >
        <span
          class="wordmark-mark"
          aria-hidden="true"
        >C</span>
        <span>ContextFlow</span>
      </a>
      <span class="header-note">Редакційний робочий простір</span>
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
        <div class="signed-in-account">
          <div>
            <p class="eyebrow">
              Ваш обліковий запис
            </p>
            <p
              id="account-title"
              class="account-name"
            >
              {{ user?.displayName ? `Вітаємо, ${user.displayName}` : 'Ви увійшли' }}
            </p>
            <p class="account-email">
              {{ user?.email }}
            </p>
          </div>
          <button
            class="button button-secondary logout-button"
            type="button"
            :disabled="busy"
            @click="logout"
          >
            {{ busy ? 'Завершуємо…' : 'Вийти' }}
          </button>
        </div>
        <ExternalProcessingNotice
          :key="user?.id ?? ''"
          :csrf-token="csrfToken"
          :user-id="user?.id ?? ''"
          @session-expired="handleProjectSessionExpired"
        />
        <details class="session-settings">
          <summary>
            <span>Налаштування сесії</span>
            <span class="session-settings-current">
              {{ preferenceState === 'ready' ? `Бездіяльність: ${formattedIdleTime}` : preferenceState === 'loading' ? 'Завантаження…' : 'Не вдалося завантажити' }}
            </span>
          </summary>
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
        </details>
        <WorkspaceHub
          :key="user?.id ?? ''"
          :csrf-token="csrfToken"
          :user-id="user?.id ?? ''"
          @session-expired="handleProjectSessionExpired"
        />
      </section>
    </main>
    <footer class="site-footer">
      <span>Контент починається з довіри до джерел.</span>
    </footer>
  </div>
</template>
