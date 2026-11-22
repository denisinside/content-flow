<script setup lang="ts">
import { defineComponent, h, type VNode } from 'vue'
import type { JSONContent } from '@tiptap/core'
const previewProps = defineProps<{ document: JSONContent; activeCitation?: string | null }>()
const emit = defineEmits<{ 'source-citation': [passageId: string, packetId: string, citationId: string] }>()
const SafeNode = defineComponent({ props: { node: { type: Object, required: true } }, setup(props) {
  function render(node: JSONContent, path = '0'): VNode | string {
    if (node.type === 'text') {
      let result: VNode | string = node.text ?? ''
      for (const mark of node.marks ?? []) {
        if (mark.type === 'source_evidence') result = h('button',{ type: 'button',class: ['preview-source-evidence', { 'is-active': previewProps.activeCitation === path }],
          'aria-pressed': previewProps.activeCitation === path, 'aria-label': 'Переглянути уривок джерела',title: 'Відкрити доказ у джерелі',
          onClick: () => emit('source-citation',String(mark.attrs?.passageId ?? ''),String(mark.attrs?.packetId ?? ''), path) },[result])
        else { const tag = ({ bold: 'strong',italic: 'em',strike: 's',evidence: 'span' } as Record<string,string>)[mark.type]; if (tag) result = h(tag,mark.type === 'evidence' ? { class: 'preview-evidence' } : {},[result]) }
      }
      return result
    }
    const tag = ({ doc: 'div', paragraph: 'p', heading: node.attrs?.level === 3 ? 'h3' : 'h2', bulletList: 'ul', orderedList: 'ol', listItem: 'li', blockquote: 'blockquote', hardBreak: 'br' } as Record<string, string>)[node.type ?? ''] ?? 'div'
    return h(tag, {}, (node.content ?? []).map((child, index) => render(child, `${path}.${index}`)))
  }
  return () => render(props.node as JSONContent)
} })
</script>
<template>
  <div class="article-preview">
    <SafeNode :node="document" />
  </div>
</template>
<style scoped>.article-preview :deep(.preview-source-evidence){font:inherit;color:inherit;background:transparent;border:0;border-bottom:1px solid var(--success);padding:0;text-align:inherit;cursor:pointer}.article-preview :deep(.preview-source-evidence.is-active){background:color-mix(in srgb, var(--success) 20%, transparent);border-bottom:3px solid var(--success)}.article-preview :deep(.preview-source-evidence:focus-visible){outline:2px solid var(--graphite);outline-offset:3px}</style>
<style scoped>.article-preview{font-family:'Source Serif 4',serif;font-size:17px;line-height:1.6;overflow-wrap:anywhere}.article-preview :deep(p){margin:0 0 1em}.article-preview :deep(h2){font-size:24px}.article-preview :deep(ul),.article-preview :deep(ol){padding-left:24px}.article-preview :deep(.preview-evidence){border-bottom:1px solid var(--success)}</style>
