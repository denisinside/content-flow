<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import SourceMarkdown from './SourceMarkdown.vue'

interface Copy { id: string; sequence: number; normalizedText: string; createdAt: string }
const props = defineProps<{ projectId: string; materialId: string; snapshots: { id: string; sequence: number }[]; currentSnapshotId: string | null }>()
const emit = defineEmits<{ close: []; 'session-expired': [] }>()
const leftId = ref(props.snapshots.find(snapshot => snapshot.id !== props.currentSnapshotId)?.id ?? '')
const rightId = ref(props.currentSnapshotId ?? props.snapshots[0]?.id ?? '')
const result = ref<{ left: Copy; right: Copy; identical: boolean } | null>(null)
const error = ref('')
const busy = ref(false)
let controller: AbortController | null = null
let epoch = 0

async function compare() {
  if (!leftId.value || !rightId.value) return
  controller?.abort()
  controller = new AbortController()
  const version = ++epoch
  busy.value = true
  error.value = ''
  result.value = null
  try {
    const query = new URLSearchParams({ left: leftId.value, right: rightId.value })
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(props.materialId)}/compare?${query}`, { credentials: 'same-origin', signal: controller.signal })
    if (version !== epoch) return
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) throw new Error('Не вдалося відкрити порівняння. Попередні версії доступні в історії; спробуйте ще раз.')
    const body = await response.json() as { left: Copy; right: Copy; identical: boolean }
    if (version === epoch) result.value = body
  } catch (cause) {
    if (version === epoch && !(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Порівняння тимчасово недоступне.'
  } finally { if (version === epoch) busy.value = false }
}
onMounted(() => void compare())
onBeforeUnmount(() => { epoch += 1; controller?.abort() })
</script>

<template>
  <section
    class="comparison"
    aria-labelledby="source-comparison-title"
    @keydown.esc.stop="emit('close')"
  >
    <div class="comparison-heading">
      <h4 id="source-comparison-title">
        Порівняння версій
      </h4><Button
        variant="ghost"
        class="comparison-button"
        @click="emit('close')"
      >
        Закрити порівняння
      </Button>
    </div>
    <form
      class="comparison-controls"
      @submit.prevent="compare"
    >
      <label>Попередня копія<select v-model="leftId"><option
        v-for="snapshot in snapshots"
        :key="snapshot.id"
        :value="snapshot.id"
      >Версія {{ snapshot.sequence }}</option></select></label>
      <label>Інша копія<select v-model="rightId"><option
        v-for="snapshot in snapshots"
        :key="snapshot.id"
        :value="snapshot.id"
      >Версія {{ snapshot.sequence }}{{ snapshot.id === currentSnapshotId ? ' · Поточна' : '' }}</option></select></label>
      <Button
        variant="outline"
        class="comparison-button"
        type="submit"
        :disabled="busy || !leftId || !rightId"
      >
        Порівняти
      </Button>
    </form>
    <p
      v-if="busy"
      role="status"
      class="comparison-message"
    >
      Відкриваємо збережені копії…
    </p>
    <p
      v-else-if="error"
      role="alert"
      class="comparison-message"
    >
      {{ error }}
    </p>
    <template v-else-if="result">
      <p
        class="comparison-message"
        role="status"
      >
        {{ result.identical ? 'Текст обох копій однаковий. Кожна версія збережена окремо.' : 'Текст копій відрізняється. Перегляньте обидві збережені версії.' }}
      </p>
      <div class="comparison-copies">
        <div>
          <h5>Версія {{ result.left.sequence }}</h5><SourceMarkdown
            class="comparison-copy"
            :text="result.left.normalizedText"
          />
        </div><div>
          <h5>Версія {{ result.right.sequence }}</h5><SourceMarkdown
            class="comparison-copy"
            :text="result.right.normalizedText"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.comparison { padding: 18px 0; margin: 16px 0; border-block: 1px solid var(--rule); }
.comparison-heading { display: flex; gap: 12px; justify-content: space-between; align-items: baseline; }
.comparison-heading h4 { margin: 0; font-family: var(--serif); font-size: 21px; font-weight: 500; }
.comparison-controls { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; margin-top: 14px; }
.comparison-controls label { display: grid; gap: 6px; font-size: 12px; }
.comparison-controls select { min-height: 38px; padding: 8px 10px; border: 1px solid var(--rule); border-radius: 2px; background: var(--document); color: var(--ink); font: inherit; }
.comparison-button { min-height: 36px; font-size: 12px; border-radius: 2px; }
.comparison-message { margin: 12px 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.comparison-copies { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.comparison-copies h5 { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.comparison-copy { margin: 0; padding: 13px; max-height: 55vh; overflow: auto; background: var(--document); border: 1px solid var(--rule); font-size: 14px; line-height: 1.65; }
.comparison-controls select:focus-visible { outline: 2px solid var(--copper); outline-offset: 2px; }
@media (max-width: 900px) { .comparison-copies { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 520px) { .comparison-heading { flex-direction: column; gap: 4px; } }
</style>
