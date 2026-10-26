import type { RelevanceCandidate, RelevanceOutput } from './relevance-contracts.js';

/** Applies the model's usefulness gate before deterministic source round-robin and packet limits. */
export function selectRelevantCandidates(input: Readonly<{ candidates: readonly RelevanceCandidate[];
  output: RelevanceOutput; maxPassages: number; byteBudget: number }>) {
  if (!Number.isSafeInteger(input.maxPassages) || input.maxPassages < 0
    || !Number.isSafeInteger(input.byteBudget) || input.byteBudget < 0) throw new TypeError('Invalid relevance selection bounds');
  const byId = new Map(input.candidates.map(candidate => [candidate.id, candidate]));
  if (byId.size !== input.candidates.length || input.output.rankedIds.some(id => !byId.has(id))) {
    throw new TypeError('Relevance ranking is outside the candidate set');
  }
  const ranked = input.output.rankedIds.map((id, index) => ({ candidate: byId.get(id)!, rank: index }));
  const grouped = new Map<string, typeof ranked>();
  for (const row of ranked) {
    const queue = grouped.get(row.candidate.snapshotId) ?? [];
    queue.push(row);
    grouped.set(row.candidate.snapshotId, queue);
  }
  const sources = [...grouped.keys()].sort((a, b) => grouped.get(a)![0]!.rank - grouped.get(b)![0]!.rank || a.localeCompare(b));
  const selected: RelevanceCandidate[] = [];
  let usedBytes = 0, progressed = true;
  while (progressed && selected.length < input.maxPassages) {
    progressed = false;
    for (const sourceId of sources) {
      if (selected.length >= input.maxPassages) break;
      const next = grouped.get(sourceId)!.shift();
      if (!next) continue;
      progressed = true;
      const bytes = Buffer.byteLength(next.candidate.quote, 'utf8');
      if (bytes > input.byteBudget - usedBytes) continue;
      selected.push(next.candidate);
      usedBytes += bytes;
    }
  }
  return Object.freeze({ candidates: Object.freeze(selected), hasMore: selected.length < ranked.length,
    usefulCount: ranked.length, usedBytes });
}
