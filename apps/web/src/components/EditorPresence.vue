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
    if ([401, 403, 404].includes(response.status)) return stop(response.status)
    if (!response.ok) people.value = []
  } catch {
    if (version === epoch) people.value = []
  }
}

async function refresh(page: string, version: number) {
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/presence?page=${encodeURIComponent(page)}`, {
      credentials: 'same-origin',
    })
    if (version !== epoch || activePage !== page) return
    if ([401, 403, 404].includes(response.status)) return stop(response.status)
    if (!response.ok) { people.value = []; return }
    const result = await response.json() as { people?: Person[] }
    if (version !== epoch || activePage !== page) return
    people.value = Array.isArray(result.people) ? result.people.filter(person => person.userId && person.displayName) : []
  } catch {
    if (version === epoch) people.value = []
  }
}

async function enter(page: string | null) {
  const previous = activePage
  const version = ++epoch
  stopped = false
  clearTimers()
  activePage = null
  people.value = []
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
    v-if="people.length"
    class="editor-presence"
    role="status"
    aria-live="polite"
  >
    Також тут: {{ people.map(person => person.displayName).join(', ') }}
  </p>
</template>

<style scoped>
.editor-presence { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
</style>
