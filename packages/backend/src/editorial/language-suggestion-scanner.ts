export type ExcludedRange = { start: number; end: number };
export type TypographyFinding = { start: number; end: number; originalText: string; replacementText: string; finding: string };

const urlPattern = /(?:https?:\/\/|www\.)[^\s<>]+/giu;
const quotePatterns = [/"[^"\n]*"/gu, /«[^»\n]*»/gu, /“[^”\n]*”/gu, /„[^“\n]*“/gu, /‟[^”\n]*”/gu];
const rules: readonly { pattern: RegExp; replacement: string; finding: string }[] = [
  { pattern: / {2,}/gu, replacement: ' ', finding: 'Приберіть повторні пробіли.' },
  { pattern: / +([,.;:!?])/gu, replacement: '$1', finding: 'Приберіть пробіл перед розділовим знаком.' },
];

/** Small, deterministic typography pass. Offsets use JavaScript UTF-16 indexing. */
export function findTypographySuggestions(text: string, excluded: readonly ExcludedRange[] = []): TypographyFinding[] {
  const urls: ExcludedRange[] = [];
  for (const match of text.matchAll(urlPattern)) {
    const start = match.index ?? 0;
    urls.push({ start, end: start + match[0].length });
  }
  const quotes: ExcludedRange[] = [];
  for (const pattern of quotePatterns) for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    quotes.push({ start, end: start + match[0].length });
  }
  const blocked = [...excluded, ...urls, ...quotes];
  const findings: TypographyFinding[] = [];
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index ?? 0, end = start + match[0].length;
      if (blocked.some(range => range.start < end && range.end > start)) continue;
      if (findings.some(row => row.start < end && row.end > start)) continue;
      const replacementText = match[0].replace(rule.pattern, rule.replacement);
      if (replacementText === match[0]) continue;
      findings.push({ start, end, originalText: match[0], replacementText, finding: rule.finding });
    }
  }
  return findings.sort((a, b) => a.start - b.start || a.end - b.end);
}
