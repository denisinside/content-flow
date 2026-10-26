import { describe, expect, it } from 'vitest';
import { sha256Text } from './contracts.js';
import { buildSearchChunks, type EvidenceSnapshot, type FusedRank, type SearchChunk } from './retrieval.js';
import { selectEvidenceSpans, type EvidenceWindow } from './passage-selection.js';

function snapshot(id: string, textParts: readonly string[]): EvidenceSnapshot {
  const normalizedText = textParts.join('\n\n');
  let cursor = 0;
  const fragments = textParts.map((text, index) => {
    const startOffset = cursor, endOffset = cursor + text.length;
    cursor = endOffset + (index < textParts.length - 1 ? 2 : 0);
    return { id: `${id}-fragment-${index}`, startOffset, endOffset, sha256: sha256Text(text) };
  });
  return { id, projectId: 'project-a', normalizedText, sha256: sha256Text(normalizedText), fragments };
}

function chunksFor(source: EvidenceSnapshot): SearchChunk[] {
  return source.fragments.map(fragment => ({ id: `${source.id}-chunk-${fragment.id}`, projectId: source.projectId,
    snapshotId: source.id, snapshotSha256: source.sha256, startOffset: fragment.startOffset, endOffset: fragment.endOffset,
    text: source.normalizedText.slice(fragment.startOffset, fragment.endOffset), fragments: [fragment] }));
}

const windowFor = (source: EvidenceSnapshot): EvidenceWindow => ({ snapshotId: source.id, startOffset: 0, endOffset: source.normalizedText.length });
const rank = (chunks: readonly SearchChunk[]): FusedRank[] => chunks.map((chunk, index) => ({ id: chunk.id, score: 1 - index / 1000,
  semanticRank: index + 1, lexicalRank: null }));

describe('selectEvidenceSpans', () => {
  it('omits explicit cover/contents, standalone headings and anchor navigation without deleting substantive definitions or links', () => {
    const source = snapshot('structure', ['**Cover author and course**', '**Марія Приклад**', '[Ім’я прізвище 1]', 'Voltage is 12V', 'A short substantive finding.', '**Зміст**', '&nbsp;', '[First](#first-(detail))', '<br>', '[Second](#second)',
      '## First', 'Thermal derating means reducing output as temperature rises.', '[Official result](https://example.test/result)', '0']);
    const chunks = chunksFor(source);
    const result = selectEvidenceSpans({ snapshots: [source], chunks, ranking: rank(chunks), windows: [windowFor(source)],
      query: 'thermal derating', maxPassages: 20, byteBudget: 30_000, excludeStructural: true });
    expect(result.passages.map(item => item.quote)).toEqual(['Voltage is 12V', 'A short substantive finding.', 'Thermal derating means reducing output as temperature rises.',
      '[Official result](https://example.test/result)', '0']);
    const prior = selectEvidenceSpans({ snapshots: [source], chunks, ranking: rank(chunks), windows: [windowFor(source)],
      query: 'thermal derating', maxPassages: 20, byteBudget: 30_000 });
    expect(prior.passages.some(item => item.quote === '**Cover author and course**')).toBe(true);
    expect(() => selectEvidenceSpans({ snapshots: [{ ...source, fragments: [...source.fragments].reverse() }], chunks, ranking: rank(chunks),
      windows: [windowFor(source)], query: 'thermal derating', maxPassages: 20, byteBudget: 30_000, excludeStructural: true })).toThrow(/Source fragments/u);
    const withoutContents = snapshot('plain', ['A compact source title', 'A meaningful short definition.']);
    expect(selectEvidenceSpans({ snapshots: [withoutContents], chunks: chunksFor(withoutContents), ranking: rank(chunksFor(withoutContents)),
      windows: [windowFor(withoutContents)], query: 'definition', maxPassages: 20, byteBudget: 30_000, excludeStructural: true }).passages).toHaveLength(2);
  });
  it('skips hundreds of layout-only fragments, ranks useful matches, and keeps source diversity within 20 spans', () => {
    const noisy = snapshot('a', [...Array.from({ length: 220 }, () => '&nbsp;'), 'A low relevance appendix.',
      ...Array.from({ length: 24 }, (_, index) => `Battery record ${index + 1} contains a distinct technical value.`),
      'Battery voltage is 12 volts.', 'Battery capacity is 5000 mAh.', 'Battery safety requires a fuse.']);
    const second = snapshot('b', ['Battery voltage is 9 volts in the alternate model.']);
    const chunks = [...chunksFor(noisy), ...chunksFor(second)];
    const relevant = chunks.filter(chunk => /Battery/u.test(chunk.text));
    const ranks = [...rank([...relevant].reverse()), ...rank(chunks.filter(chunk => !relevant.includes(chunk)))];
    const result = selectEvidenceSpans({ snapshots: [noisy, second], chunks, ranking: ranks,
      windows: [windowFor(noisy), windowFor(second)], query: 'battery voltage', maxPassages: 20, byteBudget: 30_000 });

    expect(result.candidateCount).toBe(29);
    expect(result.passages).toHaveLength(20);
    expect(result.passages[0]?.quote).toBe('Battery voltage is 9 volts in the alternate model.');
    expect(result.passages.some(passage => passage.quote === '&nbsp;')).toBe(false);
    expect(new Set(result.passages.map(passage => passage.snapshotId))).toEqual(new Set(['a', 'b']));
    expect(result.hasMore).toBe(true);
  });

  it('caps spans and UTF-8 bytes without splitting a surrogate pair or rewriting exact text', () => {
    const source = snapshot('emoji', ['Preface.', `Target 😀 ${'Ї'.repeat(12)}`, 'Another target 😀.']);
    const chunks = chunksFor(source);
    const result = selectEvidenceSpans({ snapshots: [source], chunks, ranking: rank(chunks), windows: [windowFor(source)],
      query: 'target', maxPassages: 20, byteBudget: Buffer.byteLength('Preface.', 'utf8') + Buffer.byteLength(`Target 😀 ${'Ї'.repeat(12)}`, 'utf8') });

    expect(result.passages).toHaveLength(2);
    expect(result.passages.map(item => item.quote)).toEqual(['Preface.', `Target 😀 ${'Ї'.repeat(12)}`]);
    expect(result.hasMore).toBe(true);
    for (const item of result.passages) {
      expect(source.normalizedText.slice(item.startOffset, item.endOffset)).toBe(item.quote);
      expect(item.sha256).toBe(sha256Text(item.quote));
      expect(item.endOffset === source.normalizedText.length
        || !(source.normalizedText.charCodeAt(item.endOffset - 1) >= 0xd800 && source.normalizedText.charCodeAt(item.endOffset - 1) <= 0xdbff)).toBe(true);
    }
  });

  it('splits a long source fragment at ranked chunk boundaries and ranks a later match first', () => {
    const text = `${'Звичайний технічний опис 😀 '.repeat(260)} distinctiveTarget підтверджений параметр.`;
    const source = snapshot('long', [text]);
    const chunks = buildSearchChunks(source);
    const target = chunks.find(chunk => chunk.text.includes('distinctiveTarget'))!;
    const ranking = [target, ...chunks.filter(chunk => chunk.id !== target.id)].map((chunk, index) => ({ id: chunk.id,
      score: 1 - index / 100, semanticRank: index + 1, lexicalRank: null }));
    const result = selectEvidenceSpans({ snapshots: [source], chunks, ranking, windows: [windowFor(source)], query: 'distinctiveTarget',
      maxPassages: 20, byteBudget: 30_000 });

    expect(target).toBeDefined();
    expect(result.passages[0]?.quote).toBe(target.text);
    expect(result.passages.every(item => Buffer.byteLength(item.quote, 'utf8') <= 1_536)).toBe(true);
    const sourceOrder = [...result.passages].sort((a, b) => a.startOffset - b.startOffset);
    expect(sourceOrder[0]?.startOffset).toBe(0);
    expect(sourceOrder.map(item => item.quote).join('')).toBe(text.slice(0, sourceOrder.at(-1)!.endOffset));
    for (const item of result.passages) {
      expect(item.startOffset).toBeGreaterThanOrEqual(source.fragments[0]!.startOffset);
      expect(item.endOffset).toBeLessThanOrEqual(source.fragments[0]!.endOffset);
      expect(source.normalizedText.slice(item.startOffset, item.endOffset)).toBe(item.quote);
    }
  });

  it('keeps queried glossary definitions and numeric-only evidence while deduplicating overlapping windows', () => {
    const source = snapshot('glossary', ['Thermal derating means reducing output as temperature rises.', '0']);
    const chunks = chunksFor(source);
    const first = source.fragments[0]!;
    const result = selectEvidenceSpans({ snapshots: [source], chunks, ranking: rank(chunks), windows: [
      { snapshotId: source.id, startOffset: 0, endOffset: first.endOffset },
      { snapshotId: source.id, startOffset: first.startOffset + 8, endOffset: source.normalizedText.length },
    ], query: 'thermal derating definition', maxPassages: 20, byteBudget: 30_000 });

    expect(result.passages.map(item => item.quote)).toEqual(['Thermal derating means reducing output as temperature rises.', '0']);
    expect(result.candidateCount).toBe(2);
  });

  it('rejects forged windows, chunks and cross-project snapshots', () => {
    const source = snapshot('safe', ['Evidence text.']);
    const chunks = chunksFor(source);
    const base = { snapshots: [source], chunks, ranking: rank(chunks), windows: [windowFor(source)], query: 'evidence', maxPassages: 20, byteBudget: 100 };
    expect(() => selectEvidenceSpans({ ...base, windows: [{ ...windowFor(source), endOffset: source.normalizedText.length + 1 }] })).toThrow(/window/u);
    expect(() => selectEvidenceSpans({ ...base, chunks: [{ ...chunks[0]!, snapshotId: 'foreign' }] })).toThrow(/chunk/u);
    expect(() => selectEvidenceSpans({ ...base, snapshots: [{ ...source, projectId: 'foreign' }] })).toThrow(/chunk/u);
    expect(() => selectEvidenceSpans({ ...base, snapshots: [source, { ...snapshot('other', ['Separate project.']), projectId: 'foreign' }] }))
      .toThrow(/project scopes/u);
  });

  it('rejects a later candidate window that splits an emoji even after an earlier valid range', () => {
    const source = snapshot('unicode-boundary', ['First valid evidence.', 'Emoji 😀 evidence.']);
    const chunks = chunksFor(source);
    const first = source.fragments[0]!;
    const second = source.fragments[1]!;
    const emoji = source.normalizedText.indexOf('😀');

    expect(() => selectEvidenceSpans({ snapshots: [source], chunks, ranking: rank(chunks), query: 'evidence', maxPassages: 20,
      byteBudget: 30_000, windows: [
        { snapshotId: source.id, startOffset: first.startOffset, endOffset: first.endOffset },
        { snapshotId: source.id, startOffset: emoji + 1, endOffset: second.endOffset },
      ] })).toThrow(/surrogate pair/u);
  });
});
