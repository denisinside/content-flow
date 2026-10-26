import { randomUUID } from 'node:crypto';
import { describe,it,expect } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { sourceWritingInputSchema,validateSourceWritingOutput } from './writing-contracts.js';
import { assembleSourceAdaptation,assembleSourceScript } from './writing-adaptation-content.js';

function fixture(format = 'TELEGRAM_POST') {
  const input = sourceWritingInputSchema.parse({ schemaVersion: 'source-writing-input-v1',requestId: randomUUID(),task: 'ADAPTATION',format,
    brief: { topic: 'Транзакції',audience: '',centralMessage: '',category: '',tone: '',targetLength: 100,cta: '',exclusions: [],notes: '' },
    style: { brandbook: '',tone: '',settings: {} },context: [],requiredClaims: [],
    passages: [{ id: randomUUID(),packetId: randomUUID(),snapshotId: randomUUID(),quote: 'Транзакція атомарна 😀.' }] });
  const paragraph = { id: randomUUID(),text: 'Атомарність транзакції 😀.',citations: [{ kind: 'source_passage',passageId: input.passages[0]!.id,quote: input.passages[0]!.quote,assertionText: 'Атомарність транзакції 😀.' }] };
  const frames = format.includes('CAROUSEL') || format === 'INSTAGRAM_STORIES'
    ? [{ ...paragraph,id: randomUUID(),purpose: 'Пояснення',visualHint: 'Схема',transition: format === 'INSTAGRAM_STORIES' ? 'Завершення' : '' }] : undefined;
  const output = { schemaVersion: 'source-writing-v1',requestId: input.requestId,inputHash: canonicalManifestHash(input),task: input.task,status: 'ready',
    content: { paragraphs: [paragraph],...(frames ? { frames } : {}),...(format.endsWith('COVER') ? { title: 'Атомарність',coverInstruction: 'Проста схема' } : {}) },
    review: { status: 'ready',issues: [],reasons: [],modelCalls: 2 } };
  return { input,output };
}
describe('source channel assembly',() => {
  it('appends the Telegram link placeholder without shifting exact cited UTF-16 ranges',() => {
    const { input,output } = fixture(),content = assembleSourceAdaptation(input,output,true);
    expect(content.text.endsWith('\n\n[ПОСИЛАННЯ]')).toBe(true);
    const mapping = content.sourceMappings![0]!;
    expect(content.text.slice(mapping.startOffset,mapping.endOffset)).toBe(output.content.paragraphs[0]!.text);
    expect(assembleSourceScript(input,output)).toBeNull();
  });
  it('keeps reviewed frame identities, story transitions and source passages in independent script content',() => {
    const { input,output } = fixture('INSTAGRAM_STORIES'),script = assembleSourceScript(input,output)!;
    expect(script.frames[0]).toMatchObject({ id: output.content.frames![0]!.id,transition: 'Завершення',sourceMappings: [{ passageId: input.passages[0]!.id,packetId: input.passages[0]!.packetId,quote: input.passages[0]!.quote }] });
    const missing = structuredClone(output); delete missing.content.frames;
    expect(() => validateSourceWritingOutput(missing,input)).toThrow();
    const forged = structuredClone(output); forged.content.frames![0]!.citations[0]!.passageId = randomUUID();
    expect(() => assembleSourceScript(input,forged)).toThrow();
  });
  it('requires cover instructions, rejects foreign script shapes and bounds Telegram before accepting a candidate',() => {
    const { input,output } = fixture('LINKEDIN_COVER');
    expect(assembleSourceAdaptation(input,output).cover).toEqual({ text: 'Атомарність',instruction: 'Проста схема' });
    const missing = structuredClone(output); delete missing.content.coverInstruction;
    expect(() => validateSourceWritingOutput(missing,input)).toThrow();
    const long = fixture(); long.output.content.paragraphs[0]!.text += ' х'.repeat(2100);
    expect(() => validateSourceWritingOutput(long.output,long.input)).toThrow();
  });
});
