import { telegramContentSchema,validateFormatContent,type AdaptationFormat,type TelegramContent } from '../editorial/telegram-contracts.js';
import { sourceAdaptationBodySchema,validateSourceWritingOutput,type SourceWritingInput } from './writing-contracts.js';
import { scriptContentSchema,type ScriptContent } from '../editorial/script-contracts.js';

export function assembleSourceAdaptation(input: SourceWritingInput,raw: unknown,includeLink = false): TelegramContent {
  if (input.task !== 'ADAPTATION' || !input.format) throw new Error('Channel task identity is invalid');
  const output = validateSourceWritingOutput(raw,input);
  if (output.status !== 'ready') throw new Error('Channel review is unresolved');
  const content = sourceAdaptationBodySchema.parse(output.content), paragraphs = content.paragraphs;
  let text = paragraphs.map(paragraph => paragraph.text).join('\n\n');
  if (includeLink) {
    if (input.format !== 'TELEGRAM_POST') throw new Error('Only Telegram supports a link placeholder');
    if (!text.includes('[ПОСИЛАННЯ]')) text += '\n\n[ПОСИЛАННЯ]';
  }
  const mappings: TelegramContent['mappings'] = [],sourceMappings: NonNullable<TelegramContent['sourceMappings']> = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    for (const citation of paragraph.citations) {
      const startOffset = cursor+paragraph.text.indexOf(citation.assertionText),endOffset = startOffset+citation.assertionText.length;
      if (citation.kind === 'source_passage') {
        const passage = input.passages.find(row => row.id === citation.passageId);
        if (!passage) throw new Error('Channel passage is missing');
        sourceMappings.push({ startOffset,endOffset,quote: citation.quote,passageId: passage.id,packetId: passage.packetId });
      } else mappings.push({ startOffset,endOffset,quote: citation.quote,claimRevisionId: citation.claimRevisionId,evidenceId: citation.evidenceId });
    }
    cursor += paragraph.text.length+2;
  }
  const cover = input.format.includes('COVER') ? { text: content.title ?? '',instruction: content.coverInstruction ?? '' } : undefined;
  return validateFormatContent(input.format as AdaptationFormat,telegramContentSchema.parse({ text,mappings,sourceMappings,...(cover ? { cover } : {}) }));
}

/** Frames and caption share the reviewed result and exact evidence set, with independent human approvals. */
export function assembleSourceScript(input: SourceWritingInput,raw: unknown): ScriptContent | null {
  const output = validateSourceWritingOutput(raw,input);
  if (input.task !== 'ADAPTATION' || output.status !== 'ready') throw new Error('Script needs a reviewed channel candidate');
  const content = sourceAdaptationBodySchema.parse(output.content);
  if (!content.frames) return null;
  return scriptContentSchema.parse({ frames: content.frames.map(frame => {
    const mappings: ScriptContent['frames'][number]['mappings'] = [],sourceMappings: NonNullable<ScriptContent['frames'][number]['sourceMappings']> = [];
    for (const citation of frame.citations) {
      const startOffset = frame.text.indexOf(citation.assertionText),endOffset = startOffset+citation.assertionText.length;
      if (citation.kind === 'source_passage') {
        const passage = input.passages.find(row => row.id === citation.passageId)!;
        sourceMappings.push({ startOffset,endOffset,quote: citation.quote,passageId: passage.id,packetId: passage.packetId });
      } else mappings.push({ startOffset,endOffset,quote: citation.quote,claimRevisionId: citation.claimRevisionId,evidenceId: citation.evidenceId });
    }
    return { id: frame.id,purpose: frame.purpose,text: frame.text,visualHint: frame.visualHint,transition: frame.transition,mappings,sourceMappings };
  }) });
}
