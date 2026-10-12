<script setup lang="ts">
import { computed, ref } from 'vue'
import WorkspaceStyleEditor from './WorkspaceStyleEditor.vue'

interface Member { userId: string; displayName?: string | null; email?: string }
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

const props = defineProps<{
  csrfToken: string
  userId: string
  selectedWorkspaceId: string | null
  selectedWorkspace: Workspace | null
  workspaces: Workspace[]
}>()
const emit = defineEmits<{ 'session-expired': []; changed: [] }>()

const dirty = ref(false)
const busyId = ref<string | null>(null)
const error = ref('')
const notice = ref('')
const selected = computed(() => props.selectedWorkspaceId
  ? props.selectedWorkspace?.id === props.selectedWorkspaceId
    ? props.selectedWorkspace
    : props.workspaces.find(workspace => workspace.id === props.selectedWorkspaceId) ?? null
  : null)
const recoverable = computed(() => props.workspaces.filter(workspace => workspace.archivedAt || workspace.trashedAt))
const soleOwner = computed(() => selected.value?.ownerId === props.userId
  && selected.value.members?.filter(member => member.userId).length === 1)

function purgeAllowed(workspace: Workspace) {
  return workspace.ownerId === props.userId && !!workspace.trashedAt && !!workspace.purgeAfter
    && new Date(workspace.purgeAfter).getTime() <= Date.now()
}

function dateLabel(value: string | null) {
  if (!value || Number.isNaN(new Date(value).getTime())) return 'дату не визначено'
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(value))
}

function messageFor(status: number) {
  if (status === 403) return 'Ця дія доступна лише власнику простору.'
  if (status === 404) return 'Простір недоступний або його вже видалено.'
  if (status === 409) return 'Стан простору вже змінився. Список оновлено; повторіть дію.'
  return 'Не вдалося змінити стан простору. Спробуйте ще раз.'
}

async function act(workspace: Workspace, action: 'archive' | 'trash' | 'restore' | 'purge') {
  if (busyId.value) return
  if (dirty.value && !window.confirm('У брендбуку є незбережені зміни. Продовжити без їх збереження?')) return
  if (action === 'trash' && !window.confirm('Перемістити простір у кошик? Його можна відновити до остаточного видалення, доступного не раніше ніж через 30 днів.')) return
  if (action === 'purge') {
    if (!purgeAllowed(workspace)) return
    if (!window.confirm('Видалити простір і його приватні файли остаточно? Цю дію не можна скасувати.')) return
  }
  busyId.value = workspace.id
  error.value = ''
  notice.value = ''
  try {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/${action}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ expectedRevision: workspace.lifecycleRevision }),
    })
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) { error.value = messageFor(response.status); if (response.status === 409) emit('changed'); return }
    const result = await response.json().catch(() => null) as { cleanupPending?: boolean } | null
    if (action === 'purge' && result?.cleanupPending) notice.value = 'Простір видалено з доступу; очищення приватних файлів триває.'
    else notice.value = action === 'trash' ? 'Простір переміщено в кошик.' : action === 'archive' ? 'Простір архівовано.' : action === 'restore' ? 'Простір відновлено.' : 'Простір видалено остаточно.'
    if (action === 'trash') dirty.value = false
    emit('changed')
  } catch {
    error.value = 'Не вдалося зв’язатися із сервером. Спробуйте ще раз.'
  } finally {
    busyId.value = null
  }
}
</script>

<template>
  <section
    class="workspace-recovery"
    :data-workspace-leave-risk="dirty ? 'true' : 'false'"
    :data-dirty="dirty"
    aria-labelledby="workspace-settings-heading"
  >
    <div class="settings-heading">
      <h2 id="workspace-settings-heading">
        Простір і брендбук
      </h2>
      <p v-if="selected">
        Спільні налаштування: {{ selected.name }}
      </p>
      <p v-else>
        Оберіть або створіть робочий простір, щоб налаштувати спільний брендбук.
      </p>
    </div>

    <template v-if="selected && selectedWorkspaceId">
      <p
        v-if="selected.trashedAt"
        class="recovery-prompt"
      >
        Відновіть простір, щоб відкрити брендбук.
      </p>
      <WorkspaceStyleEditor
        v-else
        :workspace-id="selectedWorkspaceId"
        :csrf-token="csrfToken"
        :disabled="Boolean(selected.archivedAt)"
        @dirty="dirty = $event"
        @saved="notice = 'Налаштування простору збережено.'"
      />
      <div
        v-if="!selected.archivedAt && !selected.trashedAt && soleOwner"
        class="selected-workspace-lifecycle"
      >
        <p>Власник може перемістити цей простір у кошик, якщо тут більше немає учасників.</p>
        <button
          type="button"
          :disabled="busyId === selected.id"
          @click="act(selected, 'trash')"
        >
          Перемістити простір у кошик
        </button>
      </div>
    </template>

    <section
      v-if="recoverable.length"
      class="recovery-list"
      aria-labelledby="recovery-heading"
    >
      <h3 id="recovery-heading">
        Архів і кошик
      </h3>
      <p>Власник може відновити простір до остаточного видалення. Воно стає доступним не раніше ніж через 30 днів і не запускається автоматично.</p>
      <article
        v-for="workspace in recoverable"
        :key="workspace.id"
        class="recovery-row"
      >
        <div>
          <h4>{{ workspace.name }}</h4>
          <p>{{ workspace.trashedAt ? `У кошику · видалення доступне після ${dateLabel(workspace.purgeAfter)}` : 'В архіві' }}</p>
        </div>
        <div class="recovery-actions">
          <button
            v-if="workspace.ownerId === userId"
            type="button"
            :disabled="busyId === workspace.id"
            @click="act(workspace, 'restore')"
          >
            Відновити
          </button>
          <button
            v-if="purgeAllowed(workspace)"
            type="button"
            class="recovery-danger"
            :disabled="busyId === workspace.id"
            @click="act(workspace, 'purge')"
          >
            Видалити остаточно
          </button>
          <span
            v-else-if="workspace.trashedAt && workspace.ownerId === userId"
            class="recovery-retention"
          >Видалення стане доступним {{ dateLabel(workspace.purgeAfter) }}</span>
        </div>
      </article>
    </section>

    <p
      v-if="notice"
      class="recovery-notice"
      role="status"
      aria-live="polite"
    >
      {{ notice }}
    </p>
    <p
      v-if="error"
      class="recovery-error"
      role="alert"
    >
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.workspace-recovery { max-width: 780px; padding-block: 20px 48px; margin-inline: auto; }
.settings-heading { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 28px; padding-block: 28px; border-top: 1px solid var(--rule); }
.settings-heading h2, .recovery-list h3 { margin: 0; font-family: var(--sans); font-size: 18px; font-weight: 550; }
.settings-heading p, .recovery-list > p, .selected-workspace-lifecycle p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
.recovery-prompt { padding: 16px 0; color: var(--muted); font-size: 14px; line-height: 1.55; }
.selected-workspace-lifecycle { padding: 20px 0; border-top: 1px solid var(--rule); }
.selected-workspace-lifecycle button, .recovery-actions button { min-height: 40px; padding: 7px 0; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 13px; text-decoration: underline; text-decoration-color: var(--rule); text-underline-offset: 4px; cursor: pointer; }
.selected-workspace-lifecycle button { margin-top: 8px; }
.recovery-list { padding-top: 28px; border-top: 1px solid var(--rule); }
.recovery-list > p { margin-top: 8px; }
.recovery-row { display: flex; justify-content: space-between; align-items: start; gap: 20px; padding: 18px 0; border-bottom: 1px solid var(--rule); }
.recovery-row h4 { margin: 0; font-size: 15px; font-weight: 550; overflow-wrap: anywhere; }
.recovery-row p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.recovery-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; }
.recovery-actions button:disabled, .selected-workspace-lifecycle button:disabled { color: var(--muted); cursor: not-allowed; }
.recovery-actions .recovery-danger { color: #8f332f; }
.recovery-retention { color: var(--muted); font-size: 12px; }
.recovery-notice, .recovery-error { margin: 14px 0 0; font-size: 13px; }
.recovery-error { color: var(--review, #945000); }
.workspace-recovery button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (max-width: 760px) { .settings-heading { grid-template-columns: 1fr; gap: 12px; } .recovery-row { flex-direction: column; } }
</style>
