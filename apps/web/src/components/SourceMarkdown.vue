<script lang="ts">
import { computed, defineComponent, h, type VNode, useId } from 'vue'
import { hasExactHighlightCoverage, highlightedParts, isSafeSourceLink, parseSourceMarkdown, sourceAnchorIdFromLink, type SourceHighlight, type SourceMarkdownNode } from '@/lib/source-markdown'

export default defineComponent({
  name: 'SourceMarkdown',
  props: {
    text: { type: String, required: true },
    highlight: { type: Object as () => SourceHighlight | undefined, default: undefined },
    compact: { type: Boolean, default: false },
  },
  setup(props) {
    const nodes = computed(() => parseSourceMarkdown(props.text))
    const anchorPrefix = `source-${useId()}`
    let headingDomIds = new Map<SourceMarkdownNode, string>()
    let anchorTargets = new Map<string, string>()

    function renderText(value: string, sourceMap: SourceMarkdownNode['sourceMap']): string | VNode[] {
      const parts = highlightedParts(value, sourceMap, props.highlight)
      if (!parts.some(part => part.highlighted)) return value
      return parts.map((part, index) => part.highlighted
        ? h('mark', { class: 'source-markdown__mark', key: index }, part.text)
        : h('span', { key: index }, part.text))
    }

    function renderChildren(items: SourceMarkdownNode[], key: string): Array<string | VNode> {
      return items.flatMap((child, index) => {
        const rendered = renderNode(child, `${key}-${index}`)
        return Array.isArray(rendered) ? rendered : [rendered]
      })
    }

    function renderNode(node: SourceMarkdownNode, key: string): string | VNode | VNode[] {
      if (node.type === 'text') return renderText(node.value ?? '', node.sourceMap)
      if (node.type === 'image') return h('span', { class: 'source-markdown__image-alt', key }, node.value ? `[${node.value}]` : '[зображення]')
      if (node.type === 'html') return h('code', { class: 'source-markdown__literal-html', key }, node.value ?? '')
      const children = renderChildren(node.children ?? [], key)
      if (node.type === 'table') {
        const tableChildren = (node.children ?? []).map((row, rowIndex) => {
          const cells = (row.children ?? []).map((cell, cellIndex) => h(rowIndex === 0 ? 'th' : 'td', { key: `${key}-${rowIndex}-${cellIndex}` }, renderChildren(cell.children ?? [], `${key}-${rowIndex}-${cellIndex}`)))
          return h('tr', { key: `${key}-row-${rowIndex}` }, cells)
        })
        return h('div', { class: 'source-markdown__table-wrap', key }, [h('table', { class: 'source-markdown__table' }, [h('tbody', tableChildren)])])
      }
      if (node.type === 'orderedList') return h('ol', { key, ...(node.value ? { start: Number(node.value) } : {}) }, children)
      if (node.type === 'listItem') {
        const isTask = typeof node.checked === 'boolean'
        const itemChildren = isTask ? [h('input', { type: 'checkbox', checked: node.checked === true, disabled: true, tabindex: -1, 'aria-label': node.checked ? 'Виконано' : 'Не виконано' }), ...children] : children
        return h('li', { key, class: isTask ? 'source-markdown__task' : undefined }, itemChildren)
      }
      if (node.type === 'link') {
        const originalHref = node.href?.trim() ?? ''
        const localAnchorId = sourceAnchorIdFromLink(originalHref)
        if (localAnchorId !== null) {
          const target = anchorTargets.get(localAnchorId)
          return target ? h('a', { key, href: `#${target}` }, children) : h('span', { key, class: 'source-markdown__link-text' }, children)
        }
        if (!isSafeSourceLink(originalHref)) return h('span', { key, class: 'source-markdown__link-text' }, children)
        const href = originalHref
        const external = /^https?:/iu.test(href)
        return h('a', { key, href, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, children)
      }
      if (node.type === 'thematicBreak') return h('hr', { key })
      if (node.type === 'break') return h('br', { key })
      const tag = node.type.startsWith('heading') ? node.type.replace('heading', 'h')
        : ({ paragraph: 'p', blockquote: 'blockquote', list: 'ul', emphasis: 'em', strong: 'strong', delete: 'del', inlineCode: 'code', code: 'pre' } as Record<string, string>)[node.type]
      if (!tag) return h('span', { key }, children)
      if (node.type === 'inlineCode' || node.type === 'code') return h(tag, { key }, renderText(node.value ?? '', node.sourceMap))
      const id = node.anchorId ? headingDomIds.get(node) : undefined
      return h(tag, { key, ...(id ? { id } : {}) }, children)
    }

    return () => {
      const parsed = nodes.value
      headingDomIds = new Map()
      anchorTargets = new Map()
      const indexAnchors = (items: SourceMarkdownNode[]): void => {
        for (const node of items) {
          if (node.anchorId) {
            // Ordinal DOM IDs cannot collide with a supplied ID that happens to
            // match a duplicate suffix (for example x, x, and x--2).
            const domId = `${anchorPrefix}-heading-${headingDomIds.size + 1}`
            headingDomIds.set(node, domId)
            if (!anchorTargets.has(node.anchorId)) anchorTargets.set(node.anchorId, domId)
          }
          if (node.children) indexAnchors(node.children)
        }
      }
      indexAnchors(parsed)
      const exact = props.highlight && !hasExactHighlightCoverage(parsed, props.highlight) && props.highlight.startOffset >= 0 && props.highlight.endOffset > props.highlight.startOffset && props.highlight.endOffset <= props.text.length
        ? props.text.slice(props.highlight.startOffset, props.highlight.endOffset)
        : ''
      return h('div', { class: ['source-markdown', props.compact && 'source-markdown--compact'], 'data-source-markdown': '' }, [
        h('div', { class: 'source-markdown__body' }, renderChildren(parsed, 'source')),
        ...(exact ? [h('details', { class: 'source-markdown__fallback' }, [h('summary', 'Точний фрагмент у джерелі'), h('code', exact)])] : []),
      ])
    }
  },
})
</script>

<style scoped>
.source-markdown { min-width: 0; color: var(--ink, #20262b); font-family: var(--serif, Georgia, serif); font-size: inherit; line-height: inherit; overflow-wrap: anywhere; }
.source-markdown__body :deep(p) { margin: 0 0 1em; }
.source-markdown__body :deep(h1), .source-markdown__body :deep(h2), .source-markdown__body :deep(h3), .source-markdown__body :deep(h4), .source-markdown__body :deep(h5), .source-markdown__body :deep(h6) { margin: 1.25em 0 .45em; font-family: var(--serif, Georgia, serif); font-weight: 600; line-height: 1.3; }
.source-markdown__body :deep(h1) { font-size: 1.7em; }
.source-markdown__body :deep(h2) { font-size: 1.45em; }
.source-markdown__body :deep(h3) { font-size: 1.25em; }
.source-markdown__body :deep(blockquote) { margin: 1em 0; padding: .1em 0 .1em 1em; border-left: 1px solid var(--rule, #e2e3e4); color: var(--muted, #606469); }
.source-markdown__body :deep(ul), .source-markdown__body :deep(ol) { margin: .5em 0 1em; padding-left: 1.5em; }
.source-markdown__body :deep(ul) { list-style-type: disc; }
.source-markdown__body :deep(ol) { list-style-type: decimal; }
.source-markdown__body :deep(li) { padding-left: .15em; }
.source-markdown__body :deep(li + li) { margin-top: .25em; }
.source-markdown__body :deep(.source-markdown__task) { list-style: none; margin-left: -1.25em; }
.source-markdown__body :deep(.source-markdown__task input) { margin: 0 .55em 0 0; accent-color: var(--graphite, #343a40); }
.source-markdown__body :deep(a) { color: inherit; text-decoration: underline; text-decoration-color: var(--muted, #606469); text-underline-offset: .15em; }
.source-markdown__body :deep(code), .source-markdown__fallback code { padding: .08em .3em; background: var(--selected, #eff1f2); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .88em; white-space: pre-wrap; }
.source-markdown__body :deep(pre) { margin: 1em 0; padding: .85em 1em; overflow: auto; background: var(--selected, #eff1f2); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .88em; line-height: 1.55; white-space: pre; }
.source-markdown__body :deep(pre code) { padding: 0; background: transparent; }
.source-markdown__table-wrap { max-width: 100%; margin: 1em 0; overflow-x: auto; border: 1px solid var(--rule, #e2e3e4); }
.source-markdown__table { width: 100%; border-collapse: collapse; font-family: inherit; font-size: .9em; }
.source-markdown__table :deep(th), .source-markdown__table :deep(td) { min-width: 7em; padding: .5em .7em; border: 1px solid var(--rule, #e2e3e4); text-align: left; vertical-align: top; }
.source-markdown__table :deep(th) { background: var(--selected, #eff1f2); font-weight: 600; }
.source-markdown__body :deep(hr) { margin: 1.5em 0; border: 0; border-top: 1px solid var(--rule, #e2e3e4); }
.source-markdown__body :deep(.source-markdown__literal-html) { white-space: pre-wrap; overflow-wrap: anywhere; }
.source-markdown__body :deep(.source-markdown__image-alt) { color: var(--muted, #606469); font-style: italic; }
.source-markdown__body :deep(.source-markdown__mark) { background: var(--source-highlight, #edece7); color: inherit; }
.source-markdown__fallback { margin: 1em 0 0; padding: .55em .75em; border-left: 1px solid var(--source-highlight, #edece7); color: var(--muted, #606469); font: 12px/1.5 var(--sans, sans-serif); }
.source-markdown__fallback summary { cursor: pointer; }
.source-markdown__fallback code { display: block; margin-top: .45em; color: var(--ink, #20262b); }
.source-markdown--compact .source-markdown__body :deep(p) { margin-bottom: .6em; }
.source-markdown--compact .source-markdown__table :deep(th), .source-markdown--compact .source-markdown__table :deep(td) { min-width: 5em; padding: .35em .5em; }

</style>
