<script setup lang="ts">
import { defineComponent, h, type VNode } from 'vue'
import type { JSONContent } from '@tiptap/core'
defineProps<{ document: JSONContent }>()
const SafeNode = defineComponent({ props: { node: { type: Object, required: true } }, setup(props) {
  function render(node: JSONContent): VNode | string {
    if (node.type === 'text') { let result: VNode | string = node.text ?? ''; for (const mark of node.marks ?? []) { const tag = ({ bold: 'strong', italic: 'em', strike: 's', evidence: 'span' } as Record<string, string>)[mark.type]; if (tag) result = h(tag, mark.type === 'evidence' ? { class: 'preview-evidence' } : {}, [result]) }; return result }
    const tag = ({ doc: 'div', paragraph: 'p', heading: node.attrs?.level === 3 ? 'h3' : 'h2', bulletList: 'ul', orderedList: 'ol', listItem: 'li', blockquote: 'blockquote', hardBreak: 'br' } as Record<string, string>)[node.type ?? ''] ?? 'div'
    return h(tag, {}, (node.content ?? []).map(render))
  }
  return () => render(props.node as JSONContent)
} })
</script>
<template>
  <div class="article-preview">
    <SafeNode :node="document" />
  </div>
</template>
<style scoped>.article-preview{font-family:'Source Serif 4',serif;font-size:17px;line-height:1.6;overflow-wrap:anywhere}.article-preview :deep(p){margin:0 0 1em}.article-preview :deep(h2){font-size:24px}.article-preview :deep(ul),.article-preview :deep(ol){padding-left:24px}.article-preview :deep(.preview-evidence){border-bottom:1px solid var(--success)}</style>
