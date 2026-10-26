import { MAX_EMBEDDING_TEXT_BYTES, MAX_EMBEDDING_TEXT_CHARACTERS, sha256Text } from './contracts.js';

/** Search-time view of an immutable source snapshot and its imported paragraph spans. */
export type EvidenceFragment = Readonly<{ id: string; startOffset: number; endOffset: number; sha256: string }>;
export type EvidenceSnapshot = Readonly<{
  id: string;
  projectId: string;
  normalizedText: string;
  sha256: string;
  fragments: readonly EvidenceFragment[];
}>;

export type SearchChunk = Readonly<{
  id: string;
  projectId: string;
  snapshotId: string;
  snapshotSha256: string;
  startOffset: number;
  endOffset: number;
  text: string;
  fragments: readonly Readonly<{ id: string; startOffset: number; endOffset: number; sha256: string }>[];
}>;

const DEFAULT_CHUNK_LIMIT = MAX_EMBEDDING_TEXT_CHARACTERS;
const DEFAULT_UTF8_BYTE_LIMIT = MAX_EMBEDDING_TEXT_BYTES;
const HASH = /^[a-f0-9]{64}$/u;

export function sha256(value: string): string {
  return sha256Text(value);
}

function assertBoundary(text: string, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new TypeError('Invalid UTF-16 source offset');
  if (offset > 0 && offset < text.length) {
    const previous = text.charCodeAt(offset - 1), current = text.charCodeAt(offset);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      throw new TypeError('Source range splits a Unicode surrogate pair');
    }
  }
}

function codePointLength(value: string): number { return [...value].length; }

function codePointEnd(text: string, start: number, maximum: number, maxUtf8Bytes: number): number {
  let index = start, count = 0;
  let bytes = 0;
  while (index < text.length && count < maximum) {
    const point = text.codePointAt(index)!;
    const width = point > 0xffff ? 2 : 1;
    const utf8Bytes = Buffer.byteLength(String.fromCodePoint(point), 'utf8');
    if (bytes + utf8Bytes > maxUtf8Bytes) break;
    index += width;
    count += 1;
    bytes += utf8Bytes;
  }
  return index;
}

function stableChunkId(snapshotId: string, startOffset: number, endOffset: number, version: string): string {
  return sha256(`${version}\0${snapshotId}\0${startOffset}\0${endOffset}`);
}

function validateSnapshot(snapshot: EvidenceSnapshot): void {
  if (!snapshot.id || !snapshot.projectId || !snapshot.normalizedText.trim()
    || Buffer.from(snapshot.normalizedText, 'utf8').toString('utf8') !== snapshot.normalizedText
    || !HASH.test(snapshot.sha256) || sha256(snapshot.normalizedText) !== snapshot.sha256) {
    throw new TypeError('Snapshot identity or SHA-256 does not match its text');
  }
  if (!snapshot.fragments.length) throw new TypeError('Snapshot has no source fragments');
  const ids = new Set<string>();
  let previousEnd = 0;
  snapshot.fragments.forEach((fragment, index) => {
    if (!fragment.id || ids.has(fragment.id)) throw new TypeError('Snapshot contains a missing or duplicate fragment id');
    ids.add(fragment.id);
    if (!HASH.test(fragment.sha256) || !Number.isSafeInteger(fragment.startOffset) || !Number.isSafeInteger(fragment.endOffset)
      || fragment.startOffset < 0 || fragment.endOffset <= fragment.startOffset || fragment.endOffset > snapshot.normalizedText.length
      || (index > 0 && fragment.startOffset < previousEnd)) throw new TypeError('Snapshot contains an invalid or overlapping fragment range');
    assertBoundary(snapshot.normalizedText, fragment.startOffset);
    assertBoundary(snapshot.normalizedText, fragment.endOffset);
    if (sha256(snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset)) !== fragment.sha256) {
      throw new TypeError('Fragment SHA-256 does not match its snapshot range');
    }
    if (index === 0 && snapshot.normalizedText.slice(0, fragment.startOffset).trim() !== '') throw new TypeError('Source fragments do not cover the start of the snapshot');
    if (index > 0 && snapshot.normalizedText.slice(previousEnd, fragment.startOffset).trim() !== '') {
      throw new TypeError('Unindexed non-whitespace text exists between source fragments');
    }
    previousEnd = fragment.endOffset;
  });
  if (snapshot.normalizedText.slice(previousEnd).trim() !== '') throw new TypeError('Source fragments do not cover the end of the snapshot');
}

/**
 * Produces a lossless, deterministic search partition. Imported paragraph boundaries
 * are preferred when they fit; long paragraphs are split at Unicode code-point
 * boundaries. Blank-line separators stay attached to the preceding search range.
 */
export function buildSearchChunks(
  snapshot: EvidenceSnapshot,
  options: Readonly<{ maxUnicodeChars?: number; maxUtf8Bytes?: number; chunkerVersion?: string }> = {},
): SearchChunk[] {
  validateSnapshot(snapshot);
  const limit = options.maxUnicodeChars ?? DEFAULT_CHUNK_LIMIT;
  const byteLimit = options.maxUtf8Bytes ?? DEFAULT_UTF8_BYTE_LIMIT;
  const version = options.chunkerVersion ?? 'paragraph-window-v1';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_CHUNK_LIMIT
    || !Number.isSafeInteger(byteLimit) || byteLimit < 4 || byteLimit > DEFAULT_UTF8_BYTE_LIMIT || !version.trim()) {
    throw new TypeError('Invalid chunking policy');
  }

  const boundaries = new Set<number>([0, snapshot.normalizedText.length]);
  for (const fragment of snapshot.fragments) {
    boundaries.add(fragment.startOffset);
    boundaries.add(fragment.endOffset);
  }
  const ordered = [...boundaries].sort((a, b) => a - b);
  const preferredEnds = new Set(ordered.slice(1));
  const chunks: SearchChunk[] = [];
  let start = 0;
  while (start < snapshot.normalizedText.length) {
    const hardEnd = codePointEnd(snapshot.normalizedText, start, limit, byteLimit);
    let end = hardEnd;
    // Prefer an imported paragraph boundary, while keeping chunks within their cap.
    for (const candidate of ordered) {
      if (candidate > start && candidate <= hardEnd && preferredEnds.has(candidate)) end = candidate;
    }
    if (end <= start) end = hardEnd;
    assertBoundary(snapshot.normalizedText, start);
    assertBoundary(snapshot.normalizedText, end);
    const chunkText = snapshot.normalizedText.slice(start, end);
    if (codePointLength(chunkText) > limit || Buffer.byteLength(chunkText, 'utf8') > byteLimit) {
      throw new TypeError('Chunk exceeds its character or UTF-8 byte limit');
    }
    const spans = snapshot.fragments.filter(fragment => fragment.startOffset < end && fragment.endOffset > start)
      .map(fragment => ({ id: fragment.id, startOffset: Math.max(start, fragment.startOffset),
        endOffset: Math.min(end, fragment.endOffset), sha256: fragment.sha256 }));
    chunks.push(Object.freeze({ id: stableChunkId(snapshot.id, start, end, version), projectId: snapshot.projectId,
      snapshotId: snapshot.id, snapshotSha256: snapshot.sha256, startOffset: start, endOffset: end, text: chunkText,
      fragments: Object.freeze(spans) }));
    start = end;
  }
  if (chunks.map(chunk => chunk.text).join('') !== snapshot.normalizedText) throw new TypeError('Chunking omitted or reordered source text');
  return chunks;
}

export type RankedId = Readonly<{ id: string; score: number }>;
export type FusedRank = Readonly<{ id: string; score: number; semanticRank: number | null; lexicalRank: number | null }>;

/** Reciprocal-rank fusion. The result records which channels actually contributed. */
export function reciprocalRankFusion(input: Readonly<{
  semantic?: readonly RankedId[];
  lexical?: readonly RankedId[];
  rankConstant?: number;
}>): Readonly<{ channels: readonly ('semantic' | 'lexical')[]; results: readonly FusedRank[] }> {
  const channels = (['semantic', 'lexical'] as const).filter(channel => input[channel] !== undefined);
  if (!channels.length) throw new TypeError('At least one retrieval ranking is required');
  const constant = input.rankConstant ?? 60;
  if (!Number.isSafeInteger(constant) || constant < 1) throw new TypeError('Invalid reciprocal-rank constant');
  const rows = new Map<string, { score: number; semanticRank: number | null; lexicalRank: number | null }>();
  for (const channel of channels) {
    const list = input[channel]!;
    const seen = new Set<string>();
    list.forEach((item, index) => {
      if (!item.id || seen.has(item.id) || !Number.isFinite(item.score)) throw new TypeError(`Invalid ${channel} ranking`);
      seen.add(item.id);
      const row = rows.get(item.id) ?? { score: 0, semanticRank: null, lexicalRank: null };
      row.score += 1 / (constant + index + 1);
      if (channel === 'semantic') row.semanticRank = index + 1;
      else row.lexicalRank = index + 1;
      rows.set(item.id, row);
    });
  }
  const results = [...rows].map(([id, value]) => ({ id, ...value }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze({ channels: Object.freeze([...channels]), results: Object.freeze(results.map(row => Object.freeze(row))) });
}

export type SelectedPassage = Readonly<{
  snapshotId: string;
  projectId: string;
  snapshotSha256: string;
  startOffset: number;
  endOffset: number;
  text: string;
  chunkIds: readonly string[];
  rankScore: number;
}>;

/**
 * Selects relevant chunks with source diversity under a UTF-8 budget. Adjacent
 * context is included only when it fits; omitted candidates remain explicitly
 * measurable through `hasMore` and `candidateCount`.
 */
export function selectDiversePassages(input: Readonly<{
  chunks: readonly SearchChunk[];
  ranking: readonly FusedRank[];
  byteBudget: number;
  maxPassages?: number;
  adjacentContextChunks?: number;
}>): Readonly<{ passages: readonly SelectedPassage[]; usedBytes: number; candidateCount: number; hasMore: boolean }> {
  if (!Number.isSafeInteger(input.byteBudget) || input.byteBudget < 1) throw new TypeError('Invalid UTF-8 passage budget');
  const maxPassages = input.maxPassages ?? 20, context = input.adjacentContextChunks ?? 1;
  if (!Number.isSafeInteger(maxPassages) || maxPassages < 1 || !Number.isSafeInteger(context) || context < 0 || context > 3) {
    throw new TypeError('Invalid passage-selection policy');
  }
  const chunksById = new Map<string, SearchChunk>();
  const projectIds = new Set(input.chunks.map(chunk => chunk.projectId));
  if (projectIds.size > 1) throw new TypeError('Retrieval cannot mix project scopes');
  input.chunks.forEach(chunk => {
    if (chunksById.has(chunk.id)) throw new TypeError('Duplicate search chunk id');
    chunksById.set(chunk.id, chunk);
  });
  if (input.ranking.some(row => !chunksById.has(row.id))) throw new TypeError('Retrieval result is outside the supplied chunk set');
  const ranking = input.ranking;
  if (ranking.some(row => !Number.isFinite(row.score)) || new Set(ranking.map(row => row.id)).size !== ranking.length) {
    throw new TypeError('Invalid or duplicate retrieval result');
  }
  const perSnapshot = new Map<string, SearchChunk[]>();
  input.chunks.forEach(chunk => {
    const list = perSnapshot.get(chunk.snapshotId) ?? [];
    list.push(chunk);
    perSnapshot.set(chunk.snapshotId, list);
  });
  perSnapshot.forEach(list => list.sort((a, b) => a.startOffset - b.startOffset || a.id.localeCompare(b.id)));
  const candidateChunks = [...ranking].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rankByChunkId = new Set(candidateChunks.map(row => row.id));
  const chosen: SelectedPassage[] = [];
  const seen = new Set<string>();
  let usedBytes = 0;

  const queues = new Map<string, typeof candidateChunks>();
  candidateChunks.forEach(row => {
    const snapshotId = chunksById.get(row.id)!.snapshotId;
    const queue = queues.get(snapshotId) ?? [];
    queue.push(row);
    queues.set(snapshotId, queue);
  });
  const sourceIds = [...queues.keys()].sort((a, b) => queues.get(b)![0]!.score - queues.get(a)![0]!.score
    || (a < b ? -1 : a > b ? 1 : 0));
  let progressed = true;
  while (progressed && chosen.length < maxPassages) {
    progressed = false;
    for (const snapshotId of sourceIds) {
      const candidate = queues.get(snapshotId)!.shift();
      if (!candidate) continue;
      progressed = true;
      if (seen.has(candidate.id)) continue;
      const center = chunksById.get(candidate.id)!;
      const siblings = perSnapshot.get(snapshotId)!;
      const centerIndex = siblings.findIndex(chunk => chunk.id === center.id);
      const window = siblings.slice(Math.max(0, centerIndex - context), centerIndex + context + 1);
      let startOffset = center.startOffset, endOffset = center.endOffset;
      // Grow around the hit, nearest neighbor first, only while the exact UTF-8 budget allows.
      const neighbors = window.filter(chunk => chunk.id !== center.id).sort((a, b) =>
        Math.abs(a.startOffset - center.startOffset) - Math.abs(b.startOffset - center.startOffset) || a.startOffset - b.startOffset);
      for (const neighbor of neighbors) {
        const nextStart = Math.min(startOffset, neighbor.startOffset), nextEnd = Math.max(endOffset, neighbor.endOffset);
        const bytes = Buffer.byteLength(
          // Snapshot text is reconstructed from all sibling ranges; adjacent chunks partition it.
          siblings.filter(chunk => chunk.startOffset < nextEnd && chunk.endOffset > nextStart)
            .sort((a, b) => a.startOffset - b.startOffset).map(chunk => chunk.text).join(''), 'utf8');
        if (bytes <= input.byteBudget - usedBytes) { startOffset = nextStart; endOffset = nextEnd; }
      }
      const selectedChunks = siblings.filter(chunk => chunk.startOffset < endOffset && chunk.endOffset > startOffset)
        .sort((a, b) => a.startOffset - b.startOffset);
      const text = selectedChunks.map(chunk => chunk.text).join('');
      // Overlapping/adjacent selected context is deduplicated by merging source ranges.
      const overlaps = chosen.filter(passage => passage.snapshotId === snapshotId && passage.startOffset <= endOffset && passage.endOffset >= startOffset);
      if (overlaps.length) {
        const mergedStart = Math.min(startOffset, ...overlaps.map(passage => passage.startOffset));
        const mergedEnd = Math.max(endOffset, ...overlaps.map(passage => passage.endOffset));
        const mergedChunks = siblings.filter(chunk => chunk.startOffset < mergedEnd && chunk.endOffset > mergedStart).sort((a, b) => a.startOffset - b.startOffset);
        const mergedText = mergedChunks.map(chunk => chunk.text).join('');
        const delta = Buffer.byteLength(mergedText, 'utf8') - overlaps.reduce((sum, passage) => sum + Buffer.byteLength(passage.text, 'utf8'), 0);
        if (delta <= input.byteBudget - usedBytes) {
          usedBytes += delta;
          const first = overlaps[0]!;
          for (let index = chosen.length - 1; index >= 0; index--) if (overlaps.includes(chosen[index]!)) chosen.splice(index, 1);
          chosen.push(Object.freeze({ ...first, startOffset: mergedStart, endOffset: mergedEnd, text: mergedText,
            chunkIds: Object.freeze(mergedChunks.map(chunk => chunk.id)),
            rankScore: Math.max(candidate.score, ...overlaps.map(passage => passage.rankScore)) }));
          seen.add(candidate.id);
          mergedChunks.forEach(chunk => { if (rankByChunkId.has(chunk.id)) seen.add(chunk.id); });
        }
        continue;
      }
      if (chosen.length >= maxPassages) continue;
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > input.byteBudget - usedBytes) continue;
      chosen.push(Object.freeze({ snapshotId, projectId: center.projectId, snapshotSha256: center.snapshotSha256,
        startOffset, endOffset, text, chunkIds: Object.freeze(selectedChunks.map(chunk => chunk.id)), rankScore: candidate.score }));
      usedBytes += bytes;
      selectedChunks.forEach(chunk => { if (rankByChunkId.has(chunk.id)) seen.add(chunk.id); });
    }
  }
  return Object.freeze({ passages: Object.freeze(chosen), usedBytes, candidateCount: candidateChunks.length,
    hasMore: candidateChunks.some(row => !seen.has(row.id)) });
}

export type ExactCitationInput = Readonly<{
  snapshotId: string;
  fragmentId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  sha256: string;
}>;

export type VerifiedCitation = Readonly<ExactCitationInput & Readonly<{
  projectId: string;
  snapshotSha256: string;
  locator: string;
}>>;

/** Validates an exact citation against the frozen canonical snapshot and fragment. */
export function validateExactCitation(snapshot: EvidenceSnapshot, citation: ExactCitationInput): VerifiedCitation {
  validateSnapshot(snapshot);
  const fragment = snapshot.fragments.find(item => item.id === citation.fragmentId);
  if (!fragment || citation.snapshotId !== snapshot.id || !HASH.test(citation.sha256)
    || !Number.isSafeInteger(citation.startOffset) || !Number.isSafeInteger(citation.endOffset)
    || citation.startOffset < fragment.startOffset || citation.endOffset > fragment.endOffset
    || citation.endOffset <= citation.startOffset) throw new TypeError('Citation does not address a valid frozen source range');
  assertBoundary(snapshot.normalizedText, citation.startOffset);
  assertBoundary(snapshot.normalizedText, citation.endOffset);
  const quote = snapshot.normalizedText.slice(citation.startOffset, citation.endOffset);
  if (quote !== citation.quote || sha256(quote) !== citation.sha256) throw new TypeError('Citation quote or SHA-256 does not match the frozen source text');
  return Object.freeze({ ...citation, projectId: snapshot.projectId, snapshotSha256: snapshot.sha256,
    locator: `${snapshot.id} · ${citation.startOffset}–${citation.endOffset} UTF-16 · ${citation.fragmentId}` });
}

export type GeneratedTextLocator = Readonly<{ startOffset: number; endOffset: number; text: string; sha256: string }>;

/** Exact output binding is independent of whether source text entails the assertion. */
export function validateGeneratedCitation(input: Readonly<{
  projectId: string;
  snapshot: EvidenceSnapshot;
  source: ExactCitationInput;
  permittedRanges: readonly Readonly<{ snapshotId: string; snapshotSha256: string; startOffset: number; endOffset: number }>[];
  outputText: string;
  outputSha256: string;
  locator: GeneratedTextLocator;
}>): Readonly<{ source: VerifiedCitation; locator: GeneratedTextLocator; outputSha256: string }> {
  if (input.snapshot.projectId !== input.projectId || !input.projectId
    || sha256(input.outputText) !== input.outputSha256 || !HASH.test(input.outputSha256)
    || Buffer.from(input.outputText, 'utf8').toString('utf8') !== input.outputText) {
    throw new TypeError('Generated citation has an invalid project or output identity');
  }
  const source = validateExactCitation(input.snapshot, input.source);
  if (!input.permittedRanges.some(range => range.snapshotId === source.snapshotId
    && range.snapshotSha256 === source.snapshotSha256 && range.startOffset <= source.startOffset
    && range.endOffset >= source.endOffset)) throw new TypeError('Citation is outside the frozen evidence packet');
  const locator = input.locator;
  assertBoundary(input.outputText, locator.startOffset);
  assertBoundary(input.outputText, locator.endOffset);
  if (locator.endOffset <= locator.startOffset || !locator.text.trim() || !HASH.test(locator.sha256)
    || input.outputText.slice(locator.startOffset, locator.endOffset) !== locator.text
    || sha256(locator.text) !== locator.sha256) throw new TypeError('Generated citation output locator is stale or invalid');
  return Object.freeze({ source, locator: Object.freeze({ ...locator }), outputSha256: input.outputSha256 });
}
