import { articleContentSchema, type ArticleContent, type ArticleMark, type ArticleNode } from '../editorial/article-contracts.js';
import { createHash } from 'node:crypto';
import { outlineContentSchema } from '../editorial/contracts.js';
import { sourceSectionBodySchema, validateSourceWritingOutput, type SourceWritingInput } from './writing-contracts.js';

export function sourceOutlineSections(outlineId: string, raw: unknown, targetLength: number) {
  const content = outlineContentSchema.parse(raw);
  const allocated = content.sections.every(section => section.targetWords !== undefined);
  if (targetLength < 20 * content.sections.length) throw new Error('Article target is too short for this outline');
  const sections = content.sections.map((section,index) => {
    const bytes = createHash('sha256').update(`source-section:${outlineId}:${index}`).digest().subarray(0,16);
    bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString('hex'), stableId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
    return { id: section.id ?? stableId, title: section.title, purpose: section.purpose,
      targetWords: allocated ? section.targetWords! : Math.floor(targetLength/content.sections.length) + (index < targetLength % content.sections.length ? 1 : 0) };
  });
  if (new Set(sections.map(section => section.id)).size !== sections.length || sections.some(section => section.targetWords < 20)
    || sections.reduce((sum,section) => sum+section.targetWords,0) !== targetLength) throw new Error('Article outline word allocation is invalid');
  return { title: content.title, sections };
}

/** Preserve every assertion and citation; ambiguous overlapping marks fail closed. */
export function assembleSourceArticle(title: string, sections: readonly { input: SourceWritingInput; output: unknown }[]): ArticleContent {
  if (!sections.length || sections.length > 30 || new Set(sections.map(section => section.input.section?.id)).size !== sections.length) {
    throw new Error('Article requires distinct reviewed sections');
  }
  const blocks: ArticleNode[] = [];
  for (const section of sections) {
    if (section.input.task !== 'SECTION' || !section.input.section) throw new Error('Article section task mismatch');
    const output = validateSourceWritingOutput(section.output, section.input);
    if (output.status !== 'ready') throw new Error('Article contains an unresolved section');
    const content = sourceSectionBodySchema.parse(output.content);
    blocks.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: section.input.section.title }] });
    for (const paragraph of content.paragraphs) {
      const spans = paragraph.citations.map(citation => {
        const start = paragraph.text.indexOf(citation.assertionText), end = start + citation.assertionText.length;
        let mark: ArticleMark;
        if (citation.kind === 'source_passage') {
          const passage = section.input.passages.find(row => row.id === citation.passageId);
          if (!passage) throw new Error('Section citation source is missing');
          mark = { type: 'source_evidence', attrs: { passageId: passage.id, packetId: passage.packetId, quote: citation.quote } };
        } else mark = { type: 'evidence', attrs: { claimRevisionId: citation.claimRevisionId, evidenceId: citation.evidenceId, quote: citation.quote } };
        return { start, end, mark };
      }).sort((a,b) => a.start-b.start);
      const children: ArticleNode[] = []; let cursor = 0;
      for (const span of spans) {
        if (span.start < cursor) throw new Error('Section citation ranges overlap');
        if (span.start > cursor) children.push({ type: 'text', text: paragraph.text.slice(cursor,span.start) });
        children.push({ type: 'text', text: paragraph.text.slice(span.start,span.end), marks: [span.mark] });
        cursor = span.end;
      }
      if (cursor < paragraph.text.length) children.push({ type: 'text', text: paragraph.text.slice(cursor) });
      blocks.push({ type: 'paragraph', content: children });
    }
  }
  return articleContentSchema.parse({ title, document: { type: 'doc', content: blocks } });
}
