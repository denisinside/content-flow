<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

interface Person {
  userId: string
  displayName: string | null
}

const props = defineProps<{
  projectId: string
  csrfToken: string
  page: string
}>()
const emit = defineEmits<{ 'session-expired': [] }>()

const people = ref<Person[]>([])
const error = ref(false)
const clientId = crypto.randomUUID()
let activePage: string | null = null
let epoch = 0
let heartbeatTimer: number | undefined
let pollTimer: number | undefined
let stopped = false

function clearTimers() {
  if (heartbeatTimer !== undefined) window.clearInterval(heartbeatTimer)
  if (pollTimer !== undefined) window.clearInterval(pollTimer)
  heartbeatTimer = undefined
  pollTimer = undefined
}

async function leave(page: string) {
  try {
    await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/presence`, {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ page, clientId }),
      keepalive: true,
    })
  } catch { /* The short server TTL clears a tab that closes while offline. */ }
}

function stop(status?: number) {
  stopped = true
  clearTimers()
  people.value = []
  if (status === 401) emit('session-expired')
  if (status !== 401 && status !== 404) error.value = true
}

async function heartbeat(page: string, version: number) {
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/presence`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ page, clientId }),
    })
    if (version !== epoch || activePage !== page) return
    if (response.status === 401 || response.status === 404) return stop(response.status)
    if (!response.ok) return stop(response.status)
    error.value = false
  } catch {
    if (version === epoch) error.value = true
  }
}

async function refresh(page: string, version: number) {
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/presence?page=${encodeURIComponent(page)}`, {
      credentials: 'same-origin',
    })
    if (version !== epoch || activePage !== page) return
    if (response.status === 401 || response.status === 404) return stop(response.status)
    if (!response.ok) return stop(response.status)
    const result = await response.json() as { people?: Person[] }
    if (version !== epoch || activePage !== page) return
    people.value = Array.isArray(result.people) ? result.people.filter(person => person.userId && person.displayName) : []
    error.value = false
  } catch {
    if (version === epoch) error.value = true
  }
}

async function enter(page: string | null) {
  const previous = activePage
  const version = ++epoch
  stopped = false
  clearTimers()
  activePage = null
  people.value = []
  error.value = false
  if (previous) await leave(previous)
  if (!page || document.visibilityState !== 'visible' || version !== epoch) return
  activePage = page
  await heartbeat(page, version)
  if (version !== epoch || stopped) return
  await refresh(page, version)
  if (version !== epoch || stopped) return
  heartbeatTimer = window.setInterval(() => void heartbeat(page, version), 20_000)
  pollTimer = window.setInterval(() => void refresh(page, version), 20_000)
}

function onVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    const previous = activePage
    epoch++
    clearTimers()
    activePage = null
    people.value = []
    if (previous) void leave(previous)
  } else if (!stopped) {
    void enter(props.page)
  }
}

watch(() => props.page, page => { void enter(page) }, { immediate: true })
document.addEventListener('visibilitychange', onVisibilityChange)

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange)
  epoch++
  clearTimers()
  const previous = activePage
  activePage = null
  if (previous) void leave(previous)
})
</script>

<template>
  <p
    v-if="people.length || error"
    class="editor-presence"
    :class="{ 'editor-presence-error': error }"
    role="status"
    aria-live="polite"
  >
    {{ error ? 'Не вдалося оновити присутність.' : `Також тут: ${people.map(person => person.displayName).join(', ')}` }}
  </p>
</template>

<style scoped>
.editor-presence { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.editor-presence-error { color: var(--review, #945000); }
</style>
