import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { decodeString } from 'micromark-util-decode-string'

export interface SourceSpan { startOffset: number; endOffset: number }
export type SourceHighlight = SourceSpan

export interface SourceMarkdownNode {
  type: string
  value?: string
  href?: string
  anchorId?: string
  checked?: boolean | null
  children?: SourceMarkdownNode[]
  sourceMap?: SourceSpan[]
}

interface Position { start: { offset?: number }; end: { offset?: number } }
interface ParsedNode {
  type: string
  value?: string
  url?: string
  alt?: string | null
  checked?: boolean | null
  children?: ParsedNode[]
  position?: Position
  align?: Array<'left' | 'right' | 'center' | null>
  raw?: string
}

const parserExtensions = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }

function sourceOffsets(node: ParsedNode, source: string): SourceSpan | null {
  const startOffset = node.position?.start.offset
  const endOffset = node.position?.end.offset
  if (typeof startOffset !== 'number' || typeof endOffset !== 'number' || startOffset < 0 || endOffset < startOffset || endOffset > source.length) return null
  return { startOffset, endOffset }
}

function appendMapped(out: string[], map: SourceSpan[], value: string, span: SourceSpan): void {
  const readable = value.replace(/\u00a0/gu, ' ')
  out.push(readable)
  for (let index = 0; index < readable.length; index += 1) map.push(span)
}

/** Maps decoded text leaf characters back to the exact UTF-16 ranges in Markdown source. */
function mapTextLeaf(raw: string, startOffset: number): { value: string; map: SourceSpan[] } {
  const out: string[] = []
  const map: SourceSpan[] = []
  for (let index = 0; index < raw.length;) {
    const absolute = startOffset + index
    if (raw[index] === '\\' && index + 1 < raw.length && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u.test(raw[index + 1] ?? '')) {
      appendMapped(out, map, raw[index + 1] ?? '', { startOffset: absolute, endOffset: absolute + 2 })
      index += 2
      continue
    }
    if (raw[index] === '&') {
      const semi = raw.indexOf(';', index + 1)
      if (semi > index && semi - index <= 40) {
        const token = raw.slice(index, semi + 1)
        const decoded = decodeString(token)
        if (decoded !== token) {
          appendMapped(out, map, decoded, { startOffset: absolute, endOffset: startOffset + semi + 1 })
          index = semi + 1
          continue
        }
      }
    }
    const codePoint = raw.codePointAt(index)
    if (codePoint === undefined) break
    const char = String.fromCodePoint(codePoint)
    appendMapped(out, map, char, { startOffset: absolute, endOffset: absolute + char.length })
    index += char.length
  }
  return { value: out.join(''), map }
}

function mapPlainValue(value: string, startOffset: number): SourceSpan[] {
  const result: SourceSpan[] = []
  for (let index = 0; index < value.length; index += 1) result.push({ startOffset: startOffset + index, endOffset: startOffset + index + 1 })
  return result
}

function mappedLiteral(value: string, raw: string, span: SourceSpan): SourceMarkdownNode {
  const mapped = mapTextLeaf(raw, span.startOffset)
  const readable = value.replace(/\u00a0/gu, ' ')
  if (mapped.value === readable && mapped.map.length === readable.length) return { type: 'text', value: readable, sourceMap: mapped.map }
  // Source offsets are only exposed when the parser's rendered leaf agrees character-for-character.
  return { type: 'text', value: readable }
}

function isLayoutHtml(raw: string): boolean {
  const withoutTags = raw.replace(/<\/?(?:p|div|span|br|hr|section|article|strong|em|b|i)\b[^>]*>/giu, '')
  const withoutEntities = withoutTags.replace(/&(?:nbsp|#160|#x0*a0);/giu, '').replace(/[\s\u00a0]/gu, '')
  return withoutEntities.length === 0 && /<\/?(?:p|div|span|br|hr|section|article|strong|em|b|i)\b/iu.test(raw)
}

const tagByType: Record<string, string> = {
  paragraph: 'p', heading: 'h', blockquote: 'blockquote', list: 'ul', listItem: 'li',
  orderedList: 'ol',
  emphasis: 'em', strong: 'strong', delete: 'del', inlineCode: 'code', code: 'pre',
  break: 'br', thematicBreak: 'hr', table: 'table', tableRow: 'tr', tableCell: 'td',
  link: 'a', image: 'span', html: 'span', definition: '', footnoteDefinition: '',
}

function convertNode(node: ParsedNode, source: string): SourceMarkdownNode[] {
  const span = sourceOffsets(node, source)
  if (node.type === 'text') {
    if (typeof node.value !== 'string' || !span) return [{ type: 'text', value: node.value ?? '' }]
    return [mappedLiteral(node.value, source.slice(span.startOffset, span.endOffset), span)]
  }
  if (node.type === 'html') {
    const raw = span ? source.slice(span.startOffset, span.endOffset) : node.value ?? ''
    if (isLayoutHtml(raw)) return []
    return [{ type: 'html', value: raw }]
  }
  if (node.type === 'image') return [{ type: 'image', value: node.alt ?? '' }]
  if (node.type === 'inlineCode' || node.type === 'code') {
    const value = node.value ?? ''
    let sourceMap: SourceSpan[] | undefined
    if (span) {
      const raw = source.slice(span.startOffset, span.endOffset)
      if (node.type === 'inlineCode') {
        const opening = raw.match(/^(`+)/u)?.[0].length ?? 0
        const closing = raw.match(/(`+)$/u)?.[0].length ?? 0
        const payload = raw.slice(opening, raw.length - closing)
        if (payload === value) sourceMap = mapPlainValue(value, span.startOffset + opening)
      } else {
        const firstNewline = raw.indexOf('\n')
        if (firstNewline >= 0) {
          const bodyStart = span.startOffset + firstNewline + 1
          const body = source.slice(bodyStart, bodyStart + value.length)
          if (body === value) sourceMap = mapPlainValue(value, bodyStart)
        }
      }
    }
    return [{ type: node.type, value, ...(sourceMap ? { sourceMap } : {}) }]
  }

  const children = (node.children ?? []).flatMap(child => convertNode(child, source))
  if (node.type === 'definition' || node.type === 'footnoteDefinition') return []
  if (node.type === 'link') {
    const href = node.url ?? ''
    return [{ type: 'link', href, children }]
  }
  if (node.type === 'list') {
    const ordered = (node as ParsedNode & { ordered?: boolean }).ordered
    const start = (node as ParsedNode & { start?: number | null }).start
    return [{ type: ordered ? 'orderedList' : 'list', ...(typeof start === 'number' ? { value: String(start) } : {}), children }]
  }
  if (node.type === 'listItem') {
    const checked = (node as ParsedNode & { checked?: boolean | null }).checked
    return [{ type: 'listItem', ...(checked === undefined ? {} : { checked }), children }]
  }
  if (node.type === 'heading') {
    const depth = (node as ParsedNode & { depth?: number }).depth ?? 2
    const raw = span ? source.slice(span.startOffset, span.endOffset) : ''
    const attribute = raw.match(/[\t ]+\{#([\p{L}\p{N}_.:-]{1,128})\}[\t ]*$/u)
    const anchorId = attribute?.[1]
    if (attribute && span && anchorId) {
      const boundary = span.startOffset + attribute.index!
      trimHeadingAttribute(children, boundary, attribute[0])
    }
    return [{ type: `heading${Math.min(6, Math.max(1, depth))}`, ...(anchorId ? { anchorId } : {}), children }]
  }
  if (node.type === 'table') {
    const align = (node as ParsedNode & { align?: Array<'left' | 'right' | 'center' | null> }).align
    return [{ type: 'table', ...(align ? { value: JSON.stringify(align) } : {}), children }]
  }
  if (node.type in tagByType) {
    if (node.type === 'paragraph' && children.every(child => !(child.value ?? '').trim() && !child.children?.length)) return []
    return [{ type: node.type, children }]
  }
  // Unknown nodes are flattened to safe child content; their source markup is never interpreted.
  return children
}

/** Hide a validated Pandoc heading attribute while preserving source coordinates for visible text. */
function trimHeadingAttribute(nodes: SourceMarkdownNode[], boundary: number, rawSuffix: string): void {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index]
    if (!node) continue
    if (node.children) {
      trimHeadingAttribute(node.children, boundary, rawSuffix)
      if (node.children.length > 0) return
      if (node.type !== 'text') continue
    }
    if (node.type !== 'text' || typeof node.value !== 'string') continue
    if (node.sourceMap && node.sourceMap.length === node.value.length) {
      let keepLength = node.sourceMap.length
      while (keepLength > 0 && (node.sourceMap[keepLength - 1]?.startOffset ?? 0) >= boundary) keepLength -= 1
      if (keepLength < node.value.length) {
        node.value = node.value.slice(0, keepLength)
        node.sourceMap = node.sourceMap.slice(0, keepLength)
        if (!node.value) nodes.splice(index, 1)
        return
      }
    } else if (node.value.endsWith(rawSuffix)) {
      node.value = node.value.slice(0, -rawSuffix.length)
      if (!node.value) nodes.splice(index, 1)
      return
    }
  }
}

export function parseSourceMarkdown(source: string): SourceMarkdownNode[] {
  const ast = fromMarkdown(source, parserExtensions) as unknown as ParsedNode
  return convertNode(ast, source)
}

export function isSafeSourceLink(href: string): boolean {
  const trimmed = href.trim()
  if (/^(?:https?:|mailto:)/iu.test(trimmed)) return true
  return sourceAnchorIdFromLink(trimmed) !== null
}

const safeAnchorIdPattern = /^[\p{L}\p{N}_.:-]{1,128}$/u

/** Decode a local Markdown anchor only when its final ID is safe to use as a DOM target. */
export function sourceAnchorIdFromLink(href: string): string | null {
  if (!href.startsWith('#') || href.length < 2) return null
  let id = href.slice(1)
  try { id = decodeURIComponent(id) } catch { return null }
  return safeAnchorIdPattern.test(id) ? id : null
}

export function highlightedParts(value: string, sourceMap: SourceSpan[] | undefined, highlight: SourceHighlight | undefined): Array<{ text: string; highlighted: boolean }> {
  if (!highlight || !sourceMap || sourceMap.length !== value.length || highlight.endOffset <= highlight.startOffset) return [{ text: value, highlighted: false }]
  const parts: Array<{ text: string; highlighted: boolean }> = []
  let current = ''
  let marked: boolean | null = null
  for (let index = 0; index < value.length; index += 1) {
    const span = sourceMap[index]
    const isMarked = span !== undefined && span.startOffset >= highlight.startOffset && span.endOffset <= highlight.endOffset
    if (marked !== null && marked !== isMarked) {
      parts.push({ text: current, highlighted: marked })
      current = ''
    }
    current += value[index] ?? ''
    marked = isMarked
  }
  if (current) parts.push({ text: current, highlighted: marked ?? false })
  return parts
}

export function hasExactHighlightCoverage(nodes: SourceMarkdownNode[], highlight: SourceHighlight | undefined): boolean {
  if (!highlight || highlight.startOffset < 0 || highlight.endOffset <= highlight.startOffset) return false
  const spans: SourceSpan[] = []
  const collect = (items: SourceMarkdownNode[]): void => {
    for (const item of items) {
      // A valid source can contain one 200k-character leaf. Avoid spreading it
      // into function arguments, which exceeds browser engine argument limits.
      for (const span of item.sourceMap ?? []) spans.push(span)
      if (item.children) collect(item.children)
    }
  }
  collect(nodes)
  const intervals = spans
    .filter(span => span.startOffset < highlight.endOffset && span.endOffset > highlight.startOffset)
    .map(span => ({ startOffset: Math.max(span.startOffset, highlight.startOffset), endOffset: Math.min(span.endOffset, highlight.endOffset) }))
    .sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset)
  let coveredUntil = highlight.startOffset
  for (const interval of intervals) {
    if (interval.startOffset > coveredUntil) return false
    coveredUntil = Math.max(coveredUntil, interval.endOffset)
    if (coveredUntil >= highlight.endOffset) return true
  }
  return false
}

