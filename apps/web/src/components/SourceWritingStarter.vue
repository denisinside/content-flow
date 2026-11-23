<script setup lang="ts">
import { ref } from 'vue'
import { Button } from '@/components/ui/button'
import type { SourceWritingStarter } from '@/source-writing-feedback'

const props = defineProps<{ starter: SourceWritingStarter }>()
const copyMessage = ref('')

function excerptText(excerpt: typeof props.starter.excerpts[number]) {
  return `«${excerpt.text}${excerpt.truncated ? '…' : ''}»`
}

async function copyStarter() {
  const lines = props.starter.excerpts.map(row => `${row.label}\n${excerptText(row)}`)
  try {
    await navigator.clipboard.writeText([props.starter.topic, ...lines].join('\n\n'))
    copyMessage.value = 'Заготовку скопійовано.'
  } catch {
    copyMessage.value = 'Виділіть і скопіюйте текст вручну.'
  }
}
</script>

<template>
  <section
    class="source-writing-starter"
    aria-label="Робоча заготовка з джерел"
  >
    <details open>
    <summary><h3>Робоча заготовка з джерел</h3></summary>
    <p>Готовий текст потребує доопрацювання. Ці уривки можна використати для власної чернетки.</p>
    <p><strong>{{ starter.topic }}</strong></p>
    <div
      v-for="(excerpt, index) in starter.excerpts"
      :key="index"
    >
      <p>{{ excerpt.label }}</p>
      <blockquote>{{ excerptText(excerpt) }}</blockquote>
    </div>
    <Button
      class="workspace-button"
      variant="outline"
      @click="copyStarter"
    >
      Скопіювати заготовку
    </Button>
    <p
      v-if="copyMessage"
      role="status"
    >
      {{ copyMessage }}
    </p>
    </details>
  </section>
</template>

<style scoped>
.source-writing-starter { margin: 20px 0; padding: 14px 16px; border-inline-start: 2px solid var(--rule); }
.source-writing-starter h3 { margin: 0 0 8px; font-size: 17px; }
.source-writing-starter summary { cursor: pointer; }
.source-writing-starter summary h3 { display: inline; }
.source-writing-starter summary:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.source-writing-starter blockquote { margin: 4px 0 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
