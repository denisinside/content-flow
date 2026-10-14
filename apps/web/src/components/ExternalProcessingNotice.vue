<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

interface NoticeResponse {
  notice: { version: string; text: string }
  accepted: boolean
  acceptedAt: string | null
}

const props = defineProps<{ csrfToken: string; userId: string; expanded?: boolean; hideAccepted?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()

const state = ref<'loading' | 'ready' | 'error'>('loading')
const notice = ref<NoticeResponse['notice'] | null>(null)
const accepted = ref(false)
const checked = ref(false)
const acceptedAt = ref<string | null>(null)
const busy = ref(false)
const errorMessage = ref('')
let controller: AbortController | null = null
let generation = 0

function readableDate(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'long', timeStyle: 'short' }).format(date)
}

async function loadNotice() {
  checked.value = false
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  const current = ++generation
  state.value = 'loading'
  errorMessage.value = ''
  try {
    const response = await fetch('/api/auth/external-processing', { credentials: 'same-origin', signal })
    if (current !== generation) return
    if (response.status === 401) {
      emit('session-expired')
      return
    }
    if (!response.ok) throw new Error('Не вдалося завантажити повідомлення про зовнішню обробку.')
    const result = await response.json() as NoticeResponse
    if (current !== generation) return
    notice.value = result.notice
    accepted.value = result.accepted
    acceptedAt.value = result.acceptedAt
    state.value = 'ready'
  } catch (error) {
    if (current !== generation || (error instanceof DOMException && error.name === 'AbortError')) return
    state.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : 'Не вдалося перевірити згоду.'
  }
}

async function acceptNotice() {
  if (!checked.value || accepted.value || busy.value || !notice.value) return
  const current = generation
  busy.value = true
  errorMessage.value = ''
  try {
    const response = await fetch('/api/auth/external-processing', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ noticeVersion: notice.value.version }),
    })
    if (current !== generation) return
    if (response.status === 401) {
      emit('session-expired')
      return
    }
    if (!response.ok) {
      checked.value = false
      throw new Error('Не вдалося зберегти згоду. Оновіть повідомлення та підтвердьте його знову.')
    }
    const result = await response.json() as NoticeResponse
    if (current !== generation) return
    notice.value = result.notice
    accepted.value = result.accepted
    acceptedAt.value = result.acceptedAt
  } catch (error) {
    if (current !== generation) return
    errorMessage.value = error instanceof Error ? error.message : 'Не вдалося зберегти згоду.'
  } finally {
    if (current === generation) busy.value = false
  }
}

onMounted(() => void loadNotice())
onBeforeUnmount(() => {
  controller?.abort()
  generation += 1
})
</script>

<template>
  <section
    v-if="!(hideAccepted && state === 'ready' && accepted)"
    id="external-processing-notice"
    tabindex="-1"
    class="external-notice"
    :class="{ 'external-notice-profile': expanded }"
    aria-label="Повідомлення про зовнішню обробку"
    aria-live="polite"
  >
    <div
      v-if="expanded || !(state === 'ready' && accepted)"
      class="external-notice-heading"
    >
      <div>
        <h2 id="external-notice-title">
          Зовнішня обробка матеріалів
        </h2>
      </div>
    </div>
    <p
      v-if="state === 'loading'"
      class="external-notice-copy"
      role="status"
    >
      Перевіряємо налаштування зовнішньої обробки…
    </p>
    <div
      v-else-if="state === 'error'"
      class="external-notice-error"
      role="alert"
    >
      <p>{{ errorMessage }}</p>
      <button
        class="external-notice-button"
        type="button"
        @click="loadNotice"
      >
        Спробувати ще раз
      </button>
    </div>
    <details
      v-else-if="notice && accepted"
      class="external-notice-disclosure"
      :open="expanded"
    >
      <summary>Зовнішня обробка · Згоду збережено</summary>
      <p class="external-notice-accepted">
        Версія {{ notice.version }}<span v-if="readableDate(acceptedAt)"> · {{ readableDate(acceptedAt) }}</span>
      </p>
      <p class="external-notice-copy">
        {{ notice.text }}
      </p>
    </details>
    <template v-else-if="notice">
      <p class="external-notice-copy">
        Перед імпортом посилань і використанням зовнішніх сервісів підтвердьте згоду. Вона збережеться у вашому обліковому записі.
      </p>
      <p class="external-notice-copy">
        {{ notice.text }}
      </p>
      <label class="external-notice-checkbox">
        <input
          v-model="checked"
          type="checkbox"
          :disabled="busy"
        >
        <span>Я прочитав(-ла) повідомлення й погоджуюся на зовнішню обробку матеріалів.</span>
      </label>
      <div class="external-notice-footer">
        <button
          class="external-notice-button external-notice-accept"
          type="button"
          :disabled="busy || !checked"
          @click="acceptNotice"
        >
          {{ busy ? 'Зберігаємо…' : 'Погодитися на зовнішню обробку' }}
        </button>
      </div>
      <p
        v-if="errorMessage"
        class="external-notice-error"
        role="alert"
      >
        {{ errorMessage }}
      </p>
      <button
        v-if="errorMessage"
        class="external-notice-button"
        type="button"
        :disabled="busy"
        @click="loadNotice"
      >
        Оновити повідомлення
      </button>
    </template>
  </section>
</template>

<style scoped>
.external-notice { margin: 0 0 28px; padding: 17px 19px; border: 1px solid var(--rule); background: var(--document); }
.external-notice-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; }
.external-notice-heading .eyebrow { margin: 0 0 4px; }
.external-notice-heading h2 { margin: 0; font-family: var(--serif); font-size: 20px; font-weight: 500; }
.external-notice-copy, .external-notice-error, .external-notice-accepted { margin: 10px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; white-space: pre-line; }
.external-notice-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 12px; }
.external-notice-checkbox { display: flex; align-items: flex-start; gap: 10px; margin-top: 14px; color: var(--ink); font-size: 13px; line-height: 1.6; cursor: pointer; }
.external-notice-checkbox input { flex: none; width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--ink); }
.external-notice-checkbox input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.external-notice-button:disabled { opacity: .5; cursor: not-allowed; }
.external-notice-disclosure summary { color: var(--evidence, #2c6660); font-size: 12px; cursor: pointer; }
.external-notice-button { min-height: 36px; padding: 7px 11px; border: 1px solid var(--rule); border-radius: 2px; background: transparent; color: var(--ink); font: inherit; font-size: 12px; cursor: pointer; }
.external-notice-accept { border-color: var(--copper); background: var(--copper); color: var(--copper-foreground, #fff); }
.external-notice-error { color: var(--error); }
.external-notice-error p { margin: 0 0 8px; }
.external-notice-profile { margin: 0; padding: 28px 0; border: 0; border-top: 1px solid var(--rule); }
.external-notice-profile .external-notice-heading h2 { font-family: var(--sans); font-size: 18px; font-weight: 550; }
.external-notice-profile .external-notice-copy { font-size: 14px; line-height: 1.7; max-width: 70ch; }
.external-notice-profile .external-notice-disclosure { margin-top: 16px; }
.external-notice-profile .external-notice-disclosure summary { min-height: 44px; display: flex; align-items: center; font-size: 13px; color: var(--muted); }
.external-notice-profile .external-notice-button { min-height: 44px; font-size: 14px; }
.external-notice-button:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
@media (max-width: 520px) {
  .external-notice { padding: 15px; }
  .external-notice-heading { flex-direction: column; gap: 7px; }
  .external-notice-footer { align-items: stretch; flex-direction: column; }
  .external-notice-button { width: 100%; }
}
</style>
