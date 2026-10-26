import { MAX_EMBEDDING_TEXT_BYTES, sha256Text } from './contracts.js';
import { validateExactCitation, type EvidenceSnapshot, type FusedRank, type SearchChunk } from './retrieval.js';

export type EvidenceWindow = Readonly<{ snapshotId: string; startOffset: number; endOffset: number }>;
export type EvidenceSpan = Readonly<{ snapshotId: string; fragmentId: string; startOffset: number; endOffset: number;
  quote: string; sha256: string; snapshotSha256: string }>;

const anchorOnly = (text: string): boolean => text.trim().split('\n').every(line => !line.trim()
  || /^\s*(?:[-*]\s+)?\[[\s\S]+\]\(\s*#[\s\S]+\)\s*$/u.test(line));

/** Recognizes an explicit contents block; documents without one keep their opening text. */
function contentsBlock(snapshot: EvidenceSnapshot): Readonly<{ start: number; end: number; cover: boolean }> | null {
  const ordered = [...snapshot.fragments].sort((a, b) => a.startOffset - b.startOffset);
  for (let index = 0; index < ordered.length; index++) {
    const fragment = ordered[index]!;
    if (fragment.startOffset > 12_000) break;
    const title = snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset).replace(/[*_#]/gu, '').trim().toLowerCase();
    if (!['зміст', 'contents', 'table of contents'].includes(title)) continue;
    let links = 0, end = fragment.endOffset;
    for (const next of ordered.slice(index + 1)) {
      const text = snapshot.normalizedText.slice(next.startOffset, next.endOffset);
      if (!isMeaningful(text)) continue;
      if (!anchorOnly(text)) break;
      links++; end = next.endOffset;
    }
    if (links >= 2) return { start: fragment.startOffset, end,
      cover: /(?:практична робота|з дисципліни|виконали студенти|\bcover\b)/iu.test(snapshot.normalizedText.slice(0, fragment.startOffset)) };
  }
  return null;
}

export function substantiveEvidenceRanges(snapshot: EvidenceSnapshot): readonly Readonly<{ startOffset: number; endOffset: number }>[] {
  const contents = contentsBlock(snapshot);
  return snapshot.fragments.filter(fragment => {
    const text = snapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset);
    const coverText = text.replace(/[*_]/gu, '').trim();
    const withinContents = contents && fragment.startOffset >= contents.start && fragment.startOffset < contents.end;
    const coverLine = contents?.cover && fragment.endOffset <= contents.start
      && (/^\s*(?:(?:практична робота|з дисципліни|на тему|виконали студенти|спеціальності)(?:\s|$)|cover\b)/iu.test(coverText)
        || /^\s*\p{Lu}[\p{L}’'ʼ-]+(?:\s+\p{Lu}[\p{L}’'ʼ-]+){1,2}\s*$/u.test(coverText)
        || /^(?:\\?\[)?Ім[’'ʼ]я\s+прізвище(?:\s+\d+)?(?:\\?\])?$/iu.test(coverText));
    return !withinContents && !coverLine && isMeaningful(text) && !anchorOnly(text)
      && !text.trim().split('\n').every(line => !line.trim() || /^\s*#{1,6}\s+\S/u.test(line));
  }).map(fragment => ({ startOffset: fragment.startOffset, endOffset: fragment.endOffset }));
}

type Candidate = EvidenceSpan & Readonly<{ projectId: string; rank: number; overlap: number; length: number }>;

function isMeaningful(quote: string): boolean {
  const visible = quote
    .replace(/&(?:nbsp|#160|#x0*a0);/giu, '')
    .replace(/<\/?(?:br|span)\b[^>]*>/giu, '')
    .replace(/<[^>]*>/gu, '');
  return /[\p{L}\p{N}]/u.test(visible);
}

function queryTerms(query: string): Set<string> {
  return new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

function termOverlap(quote: string, terms: ReadonlySet<string>): number {
  if (!terms.size) return 0;
  const words = new Set(quote.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  let count = 0;
  for (const term of terms) if (words.has(term)) count++;
  return count;
}

function isUnicodeBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function mergeRanges(ranges: readonly EvidenceWindow[]): EvidenceWindow[] {
  const sorted = [...ranges].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  const merged: EvidenceWindow[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.startOffset <= previous.endOffset) {
      merged[merged.length - 1] = { ...previous, endOffset: Math.max(previous.endOffset, range.endOffset) };
    } else merged.push(range);
  }
  return merged;
}

/** Selects exact, meaningful citation spans from retrieved windows under a bounded packet policy. */
export function selectEvidenceSpans(input: Readonly<{
  snapshots: readonly EvidenceSnapshot[];
  chunks: readonly SearchChunk[];
  ranking: readonly FusedRank[];
  windows: readonly EvidenceWindow[];
  query: string;
  maxPassages: number;
  byteBudget: number;
  excludeStructural?: boolean;
  /** Keep ranking order for broad candidate collection; defaults to source round-robin. */
  sourceDiversity?: boolean;
}>): Readonly<{ passages: readonly EvidenceSpan[]; candidateCount: number; hasMore: boolean }> {
  if (!Number.isSafeInteger(input.maxPassages) || input.maxPassages < 1
    || !Number.isSafeInteger(input.byteBudget) || input.byteBudget < 1 || typeof input.query !== 'string') {
    throw new TypeError('Invalid evidence span selection policy');
  }
  const snapshots = new Map(input.snapshots.map(snapshot => [snapshot.id, snapshot]));
  if (snapshots.size !== input.snapshots.length || input.snapshots.some(snapshot => !snapshot.id || !snapshot.projectId)) {
    throw new TypeError('Invalid or duplicate evidence snapshot');
  }
  if (new Set(input.snapshots.map(snapshot => snapshot.projectId)).size > 1) throw new TypeError('Evidence selection cannot mix project scopes');
  const chunks = new Map(input.chunks.map(chunk => [chunk.id, chunk]));
  if (chunks.size !== input.chunks.length || input.chunks.some(chunk => !snapshots.has(chunk.snapshotId)
    || snapshots.get(chunk.snapshotId)!.projectId !== chunk.projectId
    || snapshots.get(chunk.snapshotId)!.sha256 !== chunk.snapshotSha256
    || !Number.isSafeInteger(chunk.startOffset) || !Number.isSafeInteger(chunk.endOffset)
    || chunk.startOffset < 0 || chunk.endOffset <= chunk.startOffset
    || Buffer.byteLength(chunk.text, 'utf8') > MAX_EMBEDDING_TEXT_BYTES
    || !isUnicodeBoundary(snapshots.get(chunk.snapshotId)!.normalizedText, chunk.startOffset)
    || !isUnicodeBoundary(snapshots.get(chunk.snapshotId)!.normalizedText, chunk.endOffset)
    || snapshots.get(chunk.snapshotId)!.normalizedText.slice(chunk.startOffset, chunk.endOffset) !== chunk.text)) {
    throw new TypeError('Search chunk is outside the supplied snapshot set');
  }
  const ranks = new Map<string, number>();
  input.ranking.forEach((row, index) => {
    if (!chunks.has(row.id) || ranks.has(row.id) || !Number.isFinite(row.score)) throw new TypeError('Invalid or out-of-scope retrieval ranking');
    ranks.set(row.id, index);
  });
  const perSnapshotChunks = new Map<string, SearchChunk[]>();
  for (const chunk of input.chunks) {
    const list = perSnapshotChunks.get(chunk.snapshotId) ?? [];
    list.push(chunk);
    perSnapshotChunks.set(chunk.snapshotId, list);
  }
  const windowsBySnapshot = new Map<string, EvidenceWindow[]>();
  for (const window of input.windows) {
    const snapshot = snapshots.get(window.snapshotId);
    if (!snapshot || !Number.isSafeInteger(window.startOffset) || !Number.isSafeInteger(window.endOffset)
      || window.startOffset < 0 || window.endOffset <= window.startOffset || window.endOffset > snapshot.normalizedText.length) {
      throw new TypeError('Evidence window is outside the supplied snapshot set');
    }
    if (!isUnicodeBoundary(snapshot.normalizedText, window.startOffset) || !isUnicodeBoundary(snapshot.normalizedText, window.endOffset)) {
      throw new TypeError('Evidence window splits a Unicode surrogate pair');
    }
    const list = windowsBySnapshot.get(window.snapshotId) ?? [];
    list.push(window);
    windowsBySnapshot.set(window.snapshotId, list);
  }
  const mergedWindows = new Map([...windowsBySnapshot].map(([id, ranges]) => [id, mergeRanges(ranges)]));
  const terms = queryTerms(input.query);
  const candidates: Candidate[] = [];
  const validatedSnapshots = new Set<string>();
  for (const [snapshotId, windows] of mergedWindows) {
    const snapshot = snapshots.get(snapshotId)!;
    const sourceChunks = perSnapshotChunks.get(snapshotId) ?? [];
    const allowed = input.excludeStructural ? new Set(substantiveEvidenceRanges(snapshot).map(range => range.startOffset)) : null;
    for (const fragment of snapshot.fragments) {
      if (allowed && !allowed.has(fragment.startOffset)) continue;
      for (const window of windows) {
        for (const chunk of sourceChunks) {
          const startOffset = Math.max(fragment.startOffset, window.startOffset, chunk.startOffset);
          const endOffset = Math.min(fragment.endOffset, window.endOffset, chunk.endOffset);
          if (endOffset <= startOffset) continue;
          const quote = snapshot.normalizedText.slice(startOffset, endOffset);
          if (!isMeaningful(quote)) continue;
          const citation = { snapshotId, fragmentId: fragment.id, startOffset, endOffset, quote, sha256: sha256Text(quote) };
          if (!validatedSnapshots.has(snapshotId)) {
            validateExactCitation(snapshot, citation);
            validatedSnapshots.add(snapshotId);
          }
          candidates.push({ snapshotId, fragmentId: fragment.id, startOffset, endOffset, quote, sha256: citation.sha256,
            snapshotSha256: snapshot.sha256, projectId: snapshot.projectId, rank: ranks.get(chunk.id) ?? Number.MAX_SAFE_INTEGER,
            overlap: termOverlap(quote, terms), length: [...quote].length });
        }
      }
    }
  }
  candidates.sort((a, b) => a.rank - b.rank || b.overlap - a.overlap || b.length - a.length
    || (a.snapshotId < b.snapshotId ? -1 : a.snapshotId > b.snapshotId ? 1 : 0)
    || (a.startOffset - b.startOffset) || (a.fragmentId < b.fragmentId ? -1 : a.fragmentId > b.fragmentId ? 1 : 0));
  const deduplicated: Candidate[] = [];
  for (const candidate of candidates) {
    if (deduplicated.some(item => item.snapshotId === candidate.snapshotId && item.fragmentId === candidate.fragmentId
      && item.startOffset < candidate.endOffset && item.endOffset > candidate.startOffset)) continue;
    deduplicated.push(candidate);
  }

  // Round-robin source queues retain global rank precedence while avoiding one-source monopolies.
  // Broad candidate collection deliberately disables this so the relevance model sees
  // the strongest exact matches across the complete corpus before source balancing.
  if (input.sourceDiversity === false) {
    const passages: EvidenceSpan[] = [];
    let usedBytes = 0;
    for (const candidate of deduplicated) {
      if (passages.length >= input.maxPassages) break;
      const bytes = Buffer.byteLength(candidate.quote, 'utf8');
      if (bytes > input.byteBudget - usedBytes) continue;
      const passage: EvidenceSpan = { snapshotId: candidate.snapshotId, fragmentId: candidate.fragmentId,
        startOffset: candidate.startOffset, endOffset: candidate.endOffset, quote: candidate.quote,
        sha256: candidate.sha256, snapshotSha256: candidate.snapshotSha256 };
      validateExactCitation(snapshots.get(candidate.snapshotId)!, passage);
      passages.push(Object.freeze(passage));
      usedBytes += bytes;
    }
    return Object.freeze({ passages: Object.freeze(passages), candidateCount: deduplicated.length,
      hasMore: passages.length < deduplicated.length });
  }

  const queues = new Map<string, Candidate[]>();
  for (const candidate of deduplicated) {
    const queue = queues.get(candidate.snapshotId) ?? [];
    queue.push(candidate);
    queues.set(candidate.snapshotId, queue);
  }
  const sourceIds = [...queues.keys()].sort((a, b) => queues.get(a)![0]!.rank - queues.get(b)![0]!.rank
    || (a < b ? -1 : a > b ? 1 : 0));
  const passages: EvidenceSpan[] = [];
  const selected = new Set<Candidate>();
  let usedBytes = 0;
  let progressed = true;
  while (progressed && passages.length < input.maxPassages) {
    progressed = false;
    for (const snapshotId of sourceIds) {
      if (passages.length >= input.maxPassages) break;
      const candidate = queues.get(snapshotId)!.shift();
      if (!candidate) continue;
      progressed = true;
      const duplicate = passages.some(passage => passage.snapshotId === candidate.snapshotId && passage.fragmentId === candidate.fragmentId
        && passage.startOffset < candidate.endOffset && passage.endOffset > candidate.startOffset);
      if (duplicate) continue;
      const bytes = Buffer.byteLength(candidate.quote, 'utf8');
      if (bytes > input.byteBudget - usedBytes) continue;
      const passage: EvidenceSpan = {
        snapshotId: candidate.snapshotId, fragmentId: candidate.fragmentId,
        startOffset: candidate.startOffset, endOffset: candidate.endOffset,
        quote: candidate.quote, sha256: candidate.sha256, snapshotSha256: candidate.snapshotSha256,
      };
      validateExactCitation(snapshots.get(snapshotId)!, passage);
      passages.push(Object.freeze(passage));
      selected.add(candidate);
      usedBytes += bytes;
    }
  }
  return Object.freeze({ passages: Object.freeze(passages), candidateCount: deduplicated.length, hasMore: selected.size < deduplicated.length });
}
