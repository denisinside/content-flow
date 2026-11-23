<script setup lang="ts">
import { computed, ref } from 'vue'
import { Archive, Trash2 } from '@lucide/vue'

const props = defineProps<{
  projectId: string
  revision: number
  archivedAt: string | null
  trashedAt: string | null
  purgeAfter: string | null
  canPurge: boolean
  csrfToken: string
  compact?: boolean
}>()
const emit = defineEmits<{ changed: [result: { action: 'archive' | 'trash' | 'restore' | 'purge'; state?: 'ACTIVE' | 'ARCHIVED' | 'TRASHED'; cleanupPending?: boolean }]; 'session-expired': [] }>()

const busy = ref(false)
const message = ref('')
const error = ref(false)
const state = computed(() => props.trashedAt ? 'TRASHED' : props.archivedAt ? 'ARCHIVED' : 'ACTIVE')
const purgeDate = computed(() => props.purgeAfter ? new Date(props.purgeAfter) : null)
const canPurgeNow = computed(() => props.canPurge && state.value === 'TRASHED' && purgeDate.value !== null && purgeDate.value.getTime() <= Date.now())
const purgeLabel = computed(() => {
  if (!purgeDate.value || Number.isNaN(purgeDate.value.getTime())) return 'Строк видалення не визначено'
  const date = new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }).format(purgeDate.value)
  return canPurgeNow.value ? `Можна видалити остаточно · ${date}` : `Видалення доступне після ${date}`
})

async function act(action: 'archive' | 'trash' | 'restore' | 'purge') {
  if (busy.value) return
  if (action === 'purge') {
    if (!canPurgeNow.value) return
    if (!window.confirm('Видалити проєкт і його приватні файли остаточно? Цю дію не можна скасувати.')) return
  }
  if (action === 'trash' && !window.confirm('Перемістити проєкт у кошик? Його можна відновити до остаточного видалення, доступного не раніше ніж через 30 днів.')) return
  busy.value = true
  message.value = ''
  error.value = false
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ expectedRevision: props.revision }),
    })
    if (response.status === 401) {
      emit('session-expired')
      return
    }
    if (!response.ok) {
      error.value = true
      message.value = response.status === 409
        ? 'Проєкт уже змінився. Оновіть дані й повторіть дію.'
        : response.status === 403
          ? 'Ця дія доступна лише власнику простору.'
          : response.status === 404
            ? 'Проєкт недоступний або вже видалений.'
            : 'Не вдалося змінити стан проєкту. Спробуйте ще раз.'
      return
    }
    const result = await response.json().catch(() => null) as {
      cleanupPending?: boolean
      project?: { archivedAt?: string | null; trashedAt?: string | null }
    } | null
    if (action === 'purge') message.value = result?.cleanupPending ? 'Проєкт видалено; очищення приватних файлів триває.' : 'Проєкт видалено остаточно.'
    const state = result?.project?.trashedAt ? 'TRASHED' : result?.project?.archivedAt ? 'ARCHIVED' : result?.project ? 'ACTIVE' : undefined
    emit('changed', {
      action,
      ...(state ? { state } : {}),
      ...(result?.cleanupPending === undefined ? {} : { cleanupPending: result.cleanupPending }),
    })
  } catch {
    error.value = true
    message.value = 'Не вдалося зв’язатися із сервером. Спробуйте ще раз.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div
    class="project-lifecycle"
    :class="{ 'project-lifecycle-compact': compact }"
  >
    <template v-if="state === 'TRASHED'">
      <button
        type="button"
        :disabled="busy"
        @click="act('restore')"
      >
        Відновити
      </button>
      <button
        v-if="canPurge"
        type="button"
        class="project-lifecycle-danger"
        :disabled="busy || !canPurgeNow"
        :title="purgeLabel"
        @click="act('purge')"
      >
        Видалити остаточно
      </button>
      <span
        v-if="canPurge"
        class="project-lifecycle-date"
      >{{ purgeLabel }}</span>
    </template>
    <template v-else-if="state === 'ARCHIVED'">
      <button
        type="button"
        :disabled="busy"
        @click="act('restore')"
      >
        Відновити з архіву
      </button>
      <button
        type="button"
        class="project-lifecycle-quiet"
        :disabled="busy"
        @click="act('trash')"
      >
        Перемістити в кошик
      </button>
    </template>
    <template v-else>
      <button
        type="button"
        class="project-lifecycle-quiet"
        :disabled="busy"
        :aria-label="compact ? 'До архіву' : undefined"
        :title="compact ? 'До архіву' : undefined"
        @click="act('archive')"
      >
        <Archive
          v-if="compact"
          aria-hidden="true"
          :size="18"
        /><template v-else>
          До архіву
        </template>
      </button>
      <button
        type="button"
        class="project-lifecycle-quiet"
        :disabled="busy"
        :aria-label="compact ? 'У кошик' : undefined"
        :title="compact ? 'У кошик' : undefined"
        @click="act('trash')"
      >
        <Trash2
          v-if="compact"
          aria-hidden="true"
          :size="18"
        /><template v-else>
          У кошик
        </template>
      </button>
    </template>
    <span
      v-if="message"
      class="project-lifecycle-message"
      :class="{ 'is-error': error }"
      role="status"
      aria-live="polite"
    >{{ message }}</span>
  </div>
</template>

<style scoped>
.project-lifecycle { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-top: 16px; }
.project-lifecycle button { min-height: 40px; padding: 7px 0; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 13px; text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 4px; cursor: pointer; }
.project-lifecycle button:hover:not(:disabled) { text-decoration-color: currentColor; }
.project-lifecycle button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.project-lifecycle button:disabled { color: var(--muted); cursor: not-allowed; }
.project-lifecycle .project-lifecycle-quiet { color: var(--muted); }
.project-lifecycle .project-lifecycle-danger { color: #8f332f; }
.project-lifecycle-date, .project-lifecycle-message { color: var(--muted); font-size: 12px; line-height: 1.5; }
.project-lifecycle-message { flex-basis: 100%; }
.project-lifecycle-message.is-error { color: var(--review, #945000); }
.project-lifecycle-compact { margin-top: 8px; gap: 4px 12px; }
.project-lifecycle-compact .project-lifecycle-quiet { display: inline-flex; align-items: center; justify-content: center; width: 40px; padding: 0; border-radius: 3px; }
.project-lifecycle-compact .project-lifecycle-quiet:hover:not(:disabled) { color: var(--ink); background: var(--paper); }
@media (max-width: 760px) { .project-lifecycle { align-items: flex-start; gap: 4px 12px; } }
</style>
