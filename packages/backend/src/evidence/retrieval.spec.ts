import { describe, expect, it } from 'vitest';
import { buildSearchChunks, reciprocalRankFusion, selectDiversePassages, sha256, validateExactCitation, validateGeneratedCitation,
  type EvidenceSnapshot } from './retrieval.js';

function makeSnapshot(paragraphs: readonly string[], id = 'snapshot-a', projectId = 'project-a'): EvidenceSnapshot {
  const normalizedText = paragraphs.join('\n\n');
  let cursor = 0;
  const fragments = paragraphs.map((paragraph, index) => {
    const startOffset = cursor, endOffset = startOffset + paragraph.length;
    cursor = endOffset + (index < paragraphs.length - 1 ? 2 : 0);
    return { id: `fragment-${index + 1}`, startOffset, endOffset, sha256: sha256(paragraph) };
  });
  return { id, projectId, normalizedText, sha256: sha256(normalizedText), fragments };
}

describe('source evidence retrieval core', () => {
  it('losslessly chunks Cyrillic and emoji at Unicode-safe UTF-16 boundaries under character and byte caps', () => {
    const snapshot = makeSnapshot(['Заголовок 😀', 'Їжак — ' + 'б'.repeat(2_000)]);
    const chunks = buildSearchChunks(snapshot);

    expect(chunks.map(chunk => chunk.text).join('')).toBe(snapshot.normalizedText);
    expect(chunks.every(chunk => [...chunk.text].length <= 4_000)).toBe(true);
    expect(chunks.every(chunk => Buffer.byteLength(chunk.text, 'utf8') <= 1_536)).toBe(true);
    for (const chunk of chunks) {
      expect(snapshot.normalizedText.slice(chunk.startOffset, chunk.endOffset)).toBe(chunk.text);
      expect(chunk.startOffset === 0 || !(snapshot.normalizedText.charCodeAt(chunk.startOffset - 1) >= 0xd800
        && snapshot.normalizedText.charCodeAt(chunk.startOffset - 1) <= 0xdbff)).toBe(true);
    }
    expect(chunks.map(chunk => chunk.id)).toEqual(buildSearchChunks(snapshot).map(chunk => chunk.id));
  });

  it('keeps adjacent headings and table rows together as source text when they fit', () => {
    const snapshot = makeSnapshot(['Параметри сховища', 'Тип | Розмір', 'pgvector | 768 вимірів']);
    const [chunk] = buildSearchChunks(snapshot);

    expect(chunk?.text).toBe(snapshot.normalizedText);
    expect(chunk?.fragments.map(fragment => fragment.id)).toEqual(['fragment-1', 'fragment-2', 'fragment-3']);
    expect(chunk?.text).toContain('Параметри сховища\n\nТип | Розмір\n\npgvector | 768 вимірів');
  });

  it('rejects duplicate, missing-coverage, overlapping and forged-hash fragments', () => {
    const snapshot = makeSnapshot(['first', 'second']);
    expect(() => buildSearchChunks({ ...snapshot, fragments: [snapshot.fragments[0]!, snapshot.fragments[0]!] })).toThrow(/duplicate/u);
    expect(() => buildSearchChunks({ ...snapshot, fragments: snapshot.fragments.slice(1) })).toThrow(/cover the start/u);
    expect(() => buildSearchChunks({ ...snapshot, fragments: [snapshot.fragments[0]!,
      { ...snapshot.fragments[1]!, startOffset: snapshot.fragments[0]!.endOffset - 1 }] })).toThrow(/overlapping/u);
    expect(() => buildSearchChunks({ ...snapshot, fragments: [{ ...snapshot.fragments[0]!, sha256: '0'.repeat(64) }, snapshot.fragments[1]!] }))
      .toThrow(/Fragment SHA-256/u);
    expect(() => buildSearchChunks({ ...snapshot, sha256: '0'.repeat(64) })).toThrow(/Snapshot identity/u);
  });

  it('marks which retrieval channels actually contributed and rejects invalid scores', () => {
    const fused = reciprocalRankFusion({ semantic: [{ id: 'a', score: 0.8 }, { id: 'b', score: 0.2 }],
      lexical: [{ id: 'b', score: 9 }, { id: 'c', score: 3 }] });
    expect(fused.channels).toEqual(['semantic', 'lexical']);
    expect(fused.results[0]?.id).toBe('b');
    const semanticOnly = reciprocalRankFusion({ semantic: [{ id: 'a', score: 0.5 }] });
    expect(semanticOnly.channels).toEqual(['semantic']);
    expect(() => reciprocalRankFusion({ lexical: [{ id: 'a', score: Number.NaN }] })).toThrow(/ranking/u);
    expect(() => reciprocalRankFusion({})).toThrow(/At least one/u);
  });

  it('selects across sources, includes adjacent context only within UTF-8 budget, and reports omitted candidates', () => {
    const a = buildSearchChunks(makeSnapshot(['Title A', 'Evidence A', 'Context A'], 'a'), { maxUtf8Bytes: 18 });
    const b = buildSearchChunks(makeSnapshot(['Title B', 'Evidence B'], 'b'), { maxUtf8Bytes: 18 });
    const chunks = [...a, ...b];
    const ranking = [a[1]!, a[0]!, a[2]!, b[1]!].map((chunk, index) => ({ id: chunk.id, score: 4 - index }));
    const budget = Buffer.byteLength('\n\nEvidence A', 'utf8') + Buffer.byteLength('\n\nEvidence B', 'utf8');
    const selection = selectDiversePassages({ chunks, ranking, byteBudget: budget, maxPassages: 5, adjacentContextChunks: 0 });
    const contextual = selectDiversePassages({ chunks: a, ranking: [{ id: a[1]!.id, score: 1 }],
      byteBudget: Buffer.byteLength('Title A\n\nEvidence A\n\n', 'utf8'), maxPassages: 1, adjacentContextChunks: 1 });

    expect(new Set(selection.passages.map(passage => passage.snapshotId))).toEqual(new Set(['a', 'b']));
    expect(selection.usedBytes).toBeLessThanOrEqual(budget);
    expect(selection.candidateCount).toBe(4);
    expect(selection.hasMore).toBe(true);
    expect(contextual.passages[0]?.text).toBe('Title A\n\nEvidence A\n\n');
    expect(() => selectDiversePassages({ chunks, ranking, byteBudget: 0 })).toThrow(/budget/u);
  });

  it('validates citations against frozen canonical text and rejects forged quotes and split surrogate pairs', () => {
    const snapshot = makeSnapshot(['Підтвердження 😀 є тут']);
    const quote = '😀 є';
    const startOffset = snapshot.normalizedText.indexOf(quote), endOffset = startOffset + quote.length;
    const citation = { snapshotId: snapshot.id, fragmentId: snapshot.fragments[0]!.id, startOffset, endOffset,
      quote, sha256: sha256(quote) };

    expect(validateExactCitation(snapshot, citation)).toMatchObject({ projectId: snapshot.projectId, quote,
      locator: `${snapshot.id} · ${startOffset}–${endOffset} UTF-16 · ${snapshot.fragments[0]!.id}` });
    expect(() => validateExactCitation(snapshot, { ...citation, quote: 'інший текст' })).toThrow(/quote or SHA/u);
    expect(() => validateExactCitation(snapshot, { ...citation, startOffset: startOffset + 1 })).toThrow(/surrogate pair/u);
  });

  it('rejects cross-project and unknown search results rather than mixing evidence scopes', () => {
    const chunks = buildSearchChunks(makeSnapshot(['a source']));
    expect(() => selectDiversePassages({ chunks, ranking: [{ id: 'foreign', score: 1 }], byteBudget: 100 }))
      .toThrow(/outside/u);
    const foreign = buildSearchChunks(makeSnapshot(['another source'], 'foreign', 'another-project'));
    expect(() => selectDiversePassages({ chunks: [...chunks, ...foreign], ranking: [], byteBudget: 100 }))
      .toThrow(/project/u);
  });

  it('binds output text to allowed exact source ranges and rejects stale edits or invented citations', () => {
    const snapshot = makeSnapshot(['Підтвердження 😀 є тут']);
    const source = { snapshotId: snapshot.id, fragmentId: snapshot.fragments[0]!.id, startOffset: 0,
      endOffset: snapshot.normalizedText.length, quote: snapshot.normalizedText, sha256: snapshot.sha256 };
    const outputText = 'Результат 😀 підтверджено.';
    const locator = { startOffset: 0, endOffset: outputText.length, text: outputText, sha256: sha256(outputText) };
    const input = { projectId: snapshot.projectId, snapshot, source, permittedRanges: [{ snapshotId: snapshot.id,
      snapshotSha256: snapshot.sha256, startOffset: 0, endOffset: snapshot.normalizedText.length }],
      outputText, outputSha256: sha256(outputText), locator };
    expect(validateGeneratedCitation(input).source.snapshotSha256).toBe(snapshot.sha256);
    expect(() => validateGeneratedCitation({ ...input, permittedRanges: [] })).toThrow(/frozen/u);
    expect(() => validateGeneratedCitation({ ...input, projectId: 'foreign' })).toThrow(/project/u);
    expect(() => validateGeneratedCitation({ ...input, outputText: outputText + ' Зміна.' })).toThrow(/identity/u);
    expect(() => validateGeneratedCitation({ ...input, locator: { ...locator, text: 'новий текст' } })).toThrow(/stale/u);
    const emojiStart = outputText.indexOf('😀');
    expect(() => validateGeneratedCitation({ ...input, locator: { ...locator, startOffset: emojiStart + 1 } })).toThrow(/surrogate/u);
  });

  it('merges a bridge across previously selected ranges without duplicate bytes', () => {
    const chunks = buildSearchChunks(makeSnapshot(['aaaa', 'bbbb', 'cccc', 'dddd', 'eeee']), { maxUtf8Bytes: 6 });
    const source = chunks.map(chunk => chunk.text).join('');
    const rank = [chunks[0]!, chunks[4]!, chunks[2]!].map((chunk, index) => ({ id: chunk.id, score: 10 - index }));
    const result = selectDiversePassages({ chunks, ranking: rank, byteBudget: 1000, maxPassages: 10, adjacentContextChunks: 1 });
    expect(result.passages).toHaveLength(1);
    expect(result.passages[0]!.text).toBe(source);
    expect(result.usedBytes).toBe(Buffer.byteLength(source));
    expect(result.hasMore).toBe(false);
  });

  it('preserves leading/trailing separators and oversized paragraph text without invalid Unicode', () => {
    const original = makeSnapshot(['a'.repeat(1536)]);
    const snapshot = { ...original, normalizedText: '\n\n' + original.normalizedText + '\n\n',
      sha256: sha256('\n\n' + original.normalizedText + '\n\n'),
      fragments: original.fragments.map(row => ({ ...row, startOffset: row.startOffset + 2, endOffset: row.endOffset + 2 })) };
    const chunks = buildSearchChunks(snapshot);
    expect(chunks.map(chunk => chunk.text).join('')).toBe(snapshot.normalizedText);
    expect(chunks.filter(chunk => chunk.text.trim()).every(chunk => Buffer.byteLength(chunk.text) <= 1536)).toBe(true);
    expect(() => buildSearchChunks({ ...original, normalizedText: '\ud800', sha256: sha256('\ud800') })).toThrow(/Snapshot/u);
  });
});
