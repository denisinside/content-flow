import { describe, expect, it } from 'vitest'
import { hasExactHighlightCoverage, highlightedParts, isSafeSourceLink, parseSourceMarkdown, sourceAnchorIdFromLink, type SourceMarkdownNode } from './source-markdown.js'

function walk(nodes: SourceMarkdownNode[]): SourceMarkdownNode[] {
  return nodes.flatMap(node => [node, ...(node.children ? walk(node.children) : [])])
}

describe('source markdown rendering model', () => {
  it('parses GFM tables, lists and nested emphasis as structured nodes', () => {
    const nodes = parseSourceMarkdown('| Name | Value |\n| --- | ---: |\n| **alpha _one_** | 2 |\n\n- outer\n  - inner\n')
    const all = walk(nodes)
    expect(all.map(node => node.type)).toContain('table')
    expect(all.map(node => node.type)).toContain('tableCell')
    expect(all.map(node => node.type)).toContain('strong')
    expect(all.map(node => node.type)).toContain('emphasis')
    expect(all.filter(node => node.type === 'list')).toHaveLength(2)
  })

  it('maps a selected escaped/entity-decoded Unicode leaf to only its exact rendered characters', () => {
    const source = 'Before **&amp;Привіт** and \\* after'
    const nodes = walk(parseSourceMarkdown(source))
    const text = nodes.find(node => node.type === 'text' && node.value === '&Привіт')
    expect(text?.sourceMap).toHaveLength('&Привіт'.length)
    const start = source.indexOf('&amp;')
    const end = source.indexOf('**', start)
    expect(highlightedParts(text?.value ?? '', text?.sourceMap, { startOffset: start, endOffset: end })).toEqual([
      { text: '&Привіт', highlighted: true },
    ])
    const escaped = nodes.find(node => node.type === 'text' && node.value === ' and * after')
    const escapedStart = source.indexOf('\\*')
    const escapedIndex = escaped?.value?.indexOf('*') ?? -1
    expect(escaped?.sourceMap?.[escapedIndex]).toEqual({ startOffset: escapedStart, endOffset: escapedStart + 2 })
  })

  it('hides valid Unicode Pandoc heading IDs and keeps exact text-to-source offsets', () => {
    const source = '# 1. Вступ {#1.-вступ}'
    const heading = parseSourceMarkdown(source)[0]
    const text = heading?.children?.find(node => node.type === 'text')
    expect(heading?.anchorId).toBe('1.-вступ')
    expect(text?.value).toBe('1. Вступ')
    expect(text?.sourceMap?.map(span => source.slice(span.startOffset, span.endOffset)).join('')).toBe('1. Вступ')
    expect(hasExactHighlightCoverage([heading!], { startOffset: source.indexOf('1.'), endOffset: source.indexOf(' {#') })).toBe(true)
    expect(hasExactHighlightCoverage([heading!], { startOffset: source.indexOf('1.'), endOffset: source.length })).toBe(false)
  })

  it('retains escaped heading text and ignores malformed or unsafe explicit IDs', () => {
    const escapedSource = '# Назва \\*із зіркою\\* {#розділ-2}'
    const escaped = parseSourceMarkdown(escapedSource)[0]
    expect(escaped?.anchorId).toBe('розділ-2')
    expect(escaped?.children?.[0]?.value).toBe('Назва *із зіркою*')
    expect(escaped?.children?.[0]?.sourceMap).toHaveLength('Назва *із зіркою*'.length)

    for (const source of ['# Heading {#bad id}', '# Heading {#bad/segment}', '# Heading {#"><img src=x>}']) {
      const heading = parseSourceMarkdown(source)[0]
      expect(heading?.anchorId).toBeUndefined()
      expect(heading?.children?.some(node => (node.value ?? '').includes('{#'))).toBe(true)
    }
  })

  it('normalizes non-breaking spacing in ordinary text while retaining source coordinates', () => {
    const source = 'A&nbsp;B &#160; C'
    const text = walk(parseSourceMarkdown(source)).find(node => node.type === 'text')
    expect(text?.value).toBe('A B   C')
    const entityStart = source.indexOf('&nbsp;')
    expect(text?.sourceMap?.[1]).toEqual({ startOffset: entityStart, endOffset: entityStart + '&nbsp;'.length })
  })

  it('keeps code literal and reports no false source mapping when parser normalization differs', () => {
    const inlineSource = '` &amp; `'
    const inline = walk(parseSourceMarkdown(inlineSource)).find(node => node.type === 'inlineCode')
    expect(inline?.value).toBe('&amp;')
    expect(inline?.sourceMap).toBeUndefined()
    const fence = '```txt\n&amp;\n```'
    const block = walk(parseSourceMarkdown(fence)).find(node => node.type === 'code')
    expect(block?.value).toBe('&amp;')
    expect(block?.sourceMap?.length).toBe(block?.value?.length)
  })

  it('represents raw HTML and images as inert text/alt nodes and rejects unsafe links', () => {
    const nodes = walk(parseSourceMarkdown('<img src=x onerror=alert(1)> [unsafe](javascript:alert(1)) ![chart](https://example.test/chart.png)'))
    expect(nodes.some(node => node.type === 'html' && node.value?.includes('onerror'))).toBe(true)
    expect(nodes.some(node => node.type === 'image' && node.value === 'chart')).toBe(true)
    const link = nodes.find(node => node.type === 'link')
    expect(link?.href).toBe('javascript:alert(1)')
    expect(isSafeSourceLink(link?.href ?? '')).toBe(false)
    expect(isSafeSourceLink('https://example.test')).toBe(true)
    expect(isSafeSourceLink('mailto:editor@example.test')).toBe(true)
    expect(sourceAnchorIdFromLink('#1.-вступ')).toBe('1.-вступ')
    expect(sourceAnchorIdFromLink('#%D1%80%D0%BE%D0%B7%D0%B4%D1%96%D0%BB-2')).toBe('розділ-2')
    expect(isSafeSourceLink('#розділ-2')).toBe(true)
    expect(isSafeSourceLink('#bad%2Fsegment')).toBe(false)
    expect(isSafeSourceLink('#id with spaces')).toBe(false)
    expect(isSafeSourceLink('#')).toBe(false)
  })

  it('drops legacy empty layout HTML but keeps meaningful raw HTML visible as literal content', () => {
    const nodes = walk(parseSourceMarkdown('<p>&nbsp;</p>\n\n<div>Keep this</div>'))
    expect(nodes.some(node => node.type === 'html' && node.value?.includes('Keep this'))).toBe(true)
    expect(nodes.some(node => node.type === 'html' && node.value?.includes('&nbsp;'))).toBe(false)
  })

  it('falls back to an unmarked exact source slice when the selected range has no verified text map', () => {
    const source = 'A ` code ` phrase'
    const code = walk(parseSourceMarkdown(source)).find(node => node.type === 'inlineCode')
    const start = source.indexOf('`')
    const end = source.indexOf('`', start + 1) + 1
    expect(highlightedParts(code?.value ?? '', code?.sourceMap, { startOffset: start, endOffset: end })).toEqual([
      { text: 'code', highlighted: false },
    ])
    expect(source.slice(start, end)).toBe('` code `')
    const compactSource = '`code`'
    const compactCode = walk(parseSourceMarkdown(compactSource)).find(node => node.type === 'inlineCode')
    expect(highlightedParts(compactCode?.value ?? '', compactCode?.sourceMap, { startOffset: 0, endOffset: 1 })).toEqual([
      { text: 'code', highlighted: false },
    ])
  })

  it('requires the whole selected raw range to map before suppressing the exact-quote fallback', () => {
    const source = '[label](https://example.test)'
    const nodes = parseSourceMarkdown(source)
    expect(hasExactHighlightCoverage(nodes, { startOffset: 1, endOffset: 6 })).toBe(true)
    expect(hasExactHighlightCoverage(nodes, { startOffset: 0, endOffset: source.length })).toBe(false)
  })

  it('checks a highlight in a maximum-size single paragraph without exceeding argument limits', () => {
    const source = 'x'.repeat(200_000)
    expect(hasExactHighlightCoverage(parseSourceMarkdown(source), { startOffset: 199_990, endOffset: 200_000 })).toBe(true)
  })
})
