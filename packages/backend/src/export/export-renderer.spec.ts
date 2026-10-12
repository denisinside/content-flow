import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { createExportInput, type ExportManifest } from './export-contracts.js';
import { renderExportFiles, renderVisualExportFiles, zipExportFiles, type ExportFile } from './export-renderer.js';

const article = {
  title: 'Історія міста',
  document: { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Початок' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Місто ', marks: [{ type: 'bold' }] }, { type: 'text', text: 'росте.' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Перший факт' }] }] }] },
    { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Цитата' }] }] },
  ] },
};
const telegram = { text: 'Короткий допис українською', mappings: [] };

function manifest(format: 'TXT' | 'MARKDOWN' | 'ZIP', contentMode: 'FACTUAL' | 'CREATIVE' = 'FACTUAL'): ExportManifest {
  return {
    schemaVersion: 'export-manifest-v1', projectId: 'project-1', projectRevision: 8,
    formats: ['ARTICLE', 'TELEGRAM_POST'], format, frozenAt: '2026-10-10T10:00:00.000Z',
    items: [
      { format: 'TELEGRAM_POST', revisionId: 'telegram-1', number: 2, sha256: canonicalManifestHash(telegram), contentMode, provenance: {} },
      { format: 'ARTICLE', revisionId: 'article-1', number: 3, sha256: canonicalManifestHash(article), contentMode, provenance: {} },
    ], sources: [{ sourceId: 'source-1', title: 'Джерело' }],
  } as unknown as ExportManifest;
}

function contents() {
  return new Map<string, { kind: 'ARTICLE' | 'TELEGRAM_POST'; content: unknown }>([
    ['article-1', { kind: 'ARTICLE', content: article }],
    ['telegram-1', { kind: 'TELEGRAM_POST', content: telegram }],
  ]);
}

function unzipStored(zip: Buffer): Map<string, { bytes: Buffer; flags: number; method: number; date: number; time: number; crc: number }> {
  const result = new Map<string, { bytes: Buffer; flags: number; method: number; date: number; time: number; crc: number }>();
  let cursor = 0;
  while (zip.readUInt32LE(cursor) === 0x04034b50) {
    const flags = zip.readUInt16LE(cursor + 6);
    const method = zip.readUInt16LE(cursor + 8);
    const time = zip.readUInt16LE(cursor + 10);
    const date = zip.readUInt16LE(cursor + 12);
    const crc = zip.readUInt32LE(cursor + 14);
    const size = zip.readUInt32LE(cursor + 18);
    const nameLength = zip.readUInt16LE(cursor + 26);
    const extraLength = zip.readUInt16LE(cursor + 28);
    const nameStart = cursor + 30;
    const name = zip.subarray(nameStart, nameStart + nameLength).toString('utf8');
    const dataStart = nameStart + nameLength + extraLength;
    result.set(name, { bytes: zip.subarray(dataStart, dataStart + size), flags, method, date, time, crc });
    cursor = dataStart + size;
  }
  return result;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe('deterministic export renderer', () => {
  it('renders article structure and stable article-before-channel order as UTF-8 Markdown', () => {
    const files = renderExportFiles(manifest('MARKDOWN'), contents());
    expect(files.map(file => file.name)).toEqual(['article.md', 'telegram.md']);
    expect(files[0]!.contentType).toBe('text/markdown; charset=utf-8');
    const text = files[0]!.bytes.toString('utf8');
    expect(text).toContain('# Історія міста\n\n## Початок');
    expect(text).toContain('**Місто **росте\\.');
    expect(text).toContain('- Перший факт');
    expect(text).toContain('> Цитата');
    expect(files[1]!.bytes.toString('utf8')).toBe('Короткий допис українською\n');
  });

  it('keeps plain text unmarked and escapes article/channel markup in Markdown', () => {
    const content = { ...article, title: 'Назва <script>' };
    const rows = manifest('TXT');
    rows.items = rows.items.filter(item => item.format === 'ARTICLE');
    rows.items[0]!.sha256 = canonicalManifestHash(content);
    const plain = renderExportFiles(rows, new Map([
      ['article-1', { kind: 'ARTICLE' as const, content }],
      ['telegram-1', { kind: 'TELEGRAM_POST' as const, content: telegram }],
    ]));
    expect(plain[0]!.bytes.toString('utf8')).toMatch(/^Назва <script>/u);
    const markdownRows = manifest('MARKDOWN');
    markdownRows.items = markdownRows.items.filter(item => item.format === 'ARTICLE');
    markdownRows.items[0]!.sha256 = canonicalManifestHash(content);
    const markdownArticle = renderExportFiles(markdownRows, new Map([
      ['article-1', { kind: 'ARTICLE' as const, content }],
    ]));
    expect(markdownArticle[0]!.bytes.toString('utf8')).toContain('# Назва &lt;script&gt;');
    const markdownTelegram = manifest('MARKDOWN');
    markdownTelegram.items = markdownTelegram.items.filter(item => item.format === 'TELEGRAM_POST');
    const unsafeTelegram = { text: '<b>текст</b>', mappings: [] };
    markdownTelegram.items[0]!.sha256 = canonicalManifestHash(unsafeTelegram);
    const markdownPost = renderExportFiles(markdownTelegram, new Map([
      ['telegram-1', { kind: 'TELEGRAM_POST' as const, content: unsafeTelegram }],
    ]));
    expect(markdownPost[0]!.bytes.toString('utf8')).toContain('&lt;b&gt;текст&lt;/b&gt;');
  });

  it('keeps the creative basis label and validates content hashes before rendering', () => {
    const files = renderExportFiles(manifest('TXT', 'CREATIVE'), contents());
    expect(files[0]!.bytes.toString('utf8')).toContain('[Авторський текст · без перевіреної фактичної основи]');
    const altered = contents();
    altered.set('article-1', { kind: 'ARTICLE', content: { ...article, title: 'Підміна' } });
    expect(() => renderExportFiles(manifest('TXT'), altered)).toThrow(/hash/i);
  });

  it('exports both approved cover fields under distinct closed filenames', () => {
    const body = { text: 'Текст публікації', mappings: [], cover: { text: 'Заголовок обкладинки', instruction: 'Світлий фон, без логотипів' } };
    const rows = {
      schemaVersion: 'export-manifest-v1', projectId: 'project-1', projectRevision: 8, formats: ['LINKEDIN_COVER', 'INSTAGRAM_COVER'],
      format: 'ZIP', frozenAt: '2026-10-10T10:00:00.000Z', sources: [],
      items: ['LINKEDIN_COVER', 'INSTAGRAM_COVER'].map((format, index) => ({ format, revisionId: `cover-${index}`, number: 1,
        sha256: canonicalManifestHash(body), contentMode: 'FACTUAL', reviewCounter: 0, provenance: {} })),
    } as unknown as ExportManifest;
    const files = renderExportFiles(rows, new Map([
      ['cover-0', { kind: 'LINKEDIN_COVER' as const, content: body }],
      ['cover-1', { kind: 'INSTAGRAM_COVER' as const, content: body }],
    ]));
    expect(files.map(file => file.name)).toEqual([
      'linkedin-cover.txt', 'instagram-cover.txt', 'linkedin-cover.md', 'instagram-cover.md', 'manifest.json', 'sources.json',
    ]);
    expect(files[0]!.bytes.toString('utf8')).toContain('Заголовок обкладинки\n\nЗавдання для дизайнера\nСвітлий фон, без логотипів');
    expect(files[2]!.bytes.toString('utf8')).toContain('## Текст обкладинки\nЗаголовок обкладинки');
    const malformed = { text: 'x', mappings: [] };
    const missingCover = { ...rows, items: rows.items.map((item, index) => index === 0 ? { ...item, sha256: canonicalManifestHash(malformed) } : item) };
    expect(() => renderExportFiles(missingCover, new Map([
      ['cover-0', { kind: 'LINKEDIN_COVER' as const, content: malformed }],
      ['cover-1', { kind: 'INSTAGRAM_COVER' as const, content: body }],
    ]))).toThrow(/cover/i);
  });

  it('exports ordered script frames as JSON and readable Markdown beside captions in ZIP', () => {
    const frames = { frames: [
      { id: '11111111-1111-4111-8111-111111111111', purpose: 'Теза', text: 'Перша картка', visualHint: 'Великий заголовок', transition: 'З’являється поступово', mappings: [] },
      { id: '22222222-2222-4222-8222-222222222222', purpose: 'Висновок', text: 'Друга картка', visualHint: 'Схема', transition: '', mappings: [] },
    ] };
    const caption = { text: 'Підпис каруселі', mappings: [] };
    const sources = [{ materialLabel: 'Міське дослідження', snapshotId: 'snapshot-1', quote: 'Перевірене твердження',
      usedBy: [{ revisionId: 'script-rev', role: 'SELECTED_SCRIPT' }], frameLocators: [{ frameId: '11111111-1111-4111-8111-111111111111', frameOrdinal: 1, startOffset: 0, endOffset: 12, quote: 'Перша картка' }] }];
    const items = [
      { format: 'LINKEDIN_CAROUSEL', revisionId: 'caption-rev', number: 2, sha256: canonicalManifestHash(caption), contentMode: 'FACTUAL', reviewCounter: 0, provenance: {} },
      { format: 'LINKEDIN_CAROUSEL_SCRIPT', revisionId: 'script-rev', number: 1, sha256: canonicalManifestHash(frames), contentMode: 'FACTUAL', reviewCounter: 0,
        provenance: { parentAdaptationRevisionId: 'caption-rev', parentAdaptationRevisionHash: canonicalManifestHash(caption), parentCaption: caption.text, usedSources: sources } },
    ];
    const makeManifest = (format: 'JSON' | 'MARKDOWN' | 'ZIP') => ({ schemaVersion: 'export-manifest-v1', projectId: 'project-1', projectRevision: 8,
      formats: items.map(item => item.format), format, frozenAt: '2026-10-10T10:00:00.000Z', sources,
      items: format === 'ZIP' ? items : [items[1]] }) as unknown as ExportManifest;
    const contentMap = new Map([
      ['caption-rev', { kind: 'LINKEDIN_CAROUSEL' as const, content: caption }],
      ['script-rev', { kind: 'LINKEDIN_CAROUSEL_SCRIPT' as const, content: frames }],
    ]);
    const jsonFiles = renderExportFiles(makeManifest('JSON'), contentMap);
    expect(jsonFiles.map(file => file.name)).toEqual(['linkedin-carousel-script.json']);
    const json = JSON.parse(jsonFiles[0]!.bytes.toString('utf8')) as { frames: typeof frames.frames; provenance: { parentCaption: string }; sources: typeof sources };
    expect(json.frames.map(frame => frame.text)).toEqual(['Перша картка', 'Друга картка']);
    expect(json.provenance.parentCaption).toBe('Підпис каруселі');
    expect(json.sources.map(source => source.materialLabel)).toEqual(['Міське дослідження']);

    const markdownManifest = makeManifest('MARKDOWN');
    const markdownFile = renderExportFiles(markdownManifest, contentMap)[0]!;
    expect(markdownFile.bytes.toString('utf8')).toContain('## Використані джерела');
    expect(markdownFile.bytes.toString('utf8')).toContain('кадр 1, символи 0–12');
    const creativeManifest = { ...markdownManifest, items: markdownManifest.items.map(item => ({ ...item, contentMode: 'CREATIVE' as const })) };
    expect(renderExportFiles(creativeManifest, contentMap)[0]!.bytes.toString('utf8')).toContain('[Авторський текст · без перевіреної фактичної основи]');

    const zipFiles = renderExportFiles(makeManifest('ZIP'), contentMap);
    expect(zipFiles.map(file => file.name)).toEqual([
      'linkedin-carousel.txt', 'linkedin-carousel.md', 'linkedin-carousel-script.json', 'linkedin-carousel-script.md', 'manifest.json', 'sources.json',
    ]);
    expect(zipFiles[3]!.bytes.toString('utf8')).toContain('## Кадр 2 · Висновок\n\nДруга картка');
    expect(new Set(zipFiles.map(file => file.name)).size).toBe(zipFiles.length);
  });

  it('builds a stable UTF-8 STORE ZIP with CRCs, fixed timestamp and manifest/source lists', () => {
    const files = renderExportFiles(manifest('ZIP'), contents());
    expect(files.map(file => file.name)).toEqual(['article.txt', 'telegram.txt', 'article.md', 'telegram.md', 'manifest.json', 'sources.json']);
    const first = zipExportFiles(files);
    expect(zipExportFiles(files).equals(first)).toBe(true);
    const entries = unzipStored(first);
    expect([...entries.keys()]).toEqual(files.map(file => file.name));
    for (const entry of entries.values()) {
      expect(entry.flags & 0x0800).toBeTruthy();
      expect(entry.method).toBe(0);
      expect(entry.time).toBe(0);
      expect(entry.date).toBe(0x0021);
      expect(entry.crc).toBe(crc32(entry.bytes));
    }
    const endOffset = first.length - 22;
    expect(first.readUInt32LE(endOffset)).toBe(0x06054b50);
    expect(first.readUInt16LE(endOffset + 10)).toBe(files.length);
    let centralOffset = first.readUInt32LE(endOffset + 16);
    for (const expected of files) {
      expect(first.readUInt32LE(centralOffset)).toBe(0x02014b50);
      expect(first.readUInt16LE(centralOffset + 8) & 0x0800).toBeTruthy();
      expect(first.readUInt16LE(centralOffset + 10)).toBe(0);
      expect(first.readUInt16LE(centralOffset + 14)).toBe(0x0021);
      const nameLength = first.readUInt16LE(centralOffset + 28);
      expect(first.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8')).toBe(expected.name);
      centralOffset += 46 + nameLength + first.readUInt16LE(centralOffset + 30) + first.readUInt16LE(centralOffset + 32);
    }
    expect(entries.get('article.md')!.bytes.toString('utf8')).toContain('Історія міста');
    expect(entries.get('sources.json')!.bytes.toString('utf8')).toContain('Джерело');
  });

  it('rejects unsafe and duplicate ZIP names and packages over the 10 MiB cap', () => {
    const file = (name: string, bytes = Buffer.from('x')): ExportFile => ({ name, bytes, contentType: 'text/plain' });
    expect(() => zipExportFiles([file('../escape.txt')])).toThrow(/unsafe/i);
    expect(() => zipExportFiles([file('C:escape.txt')])).toThrow(/unsafe/i);
    expect(() => zipExportFiles([file('same.txt'), file('same.txt')])).toThrow(/duplicate/i);
    expect(() => zipExportFiles([file('large.txt', Buffer.alloc(10 * 1024 * 1024 + 1))])).toThrow(/10 MiB/i);
    expect(() => zipExportFiles([file('файл.txt')])).not.toThrow();
  });

  it('exports the exact approved cover preview PNG bytes', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zOQAAAAASUVORK5CYII=', 'base64');
    const digest = createHash('sha256').update(png).digest('hex');
    const frameId = '11111111-1111-4111-8111-111111111111';
    const revisionId = '22222222-2222-4222-8222-222222222222';
    const previewAssetId = '33333333-3333-4333-8333-333333333333';
    const visualManifest = { schemaVersion: 'export-manifest-v1', projectId: '44444444-4444-4444-8444-444444444444', projectRevision: 1,
      formats: ['LINKEDIN_COVER_VISUAL'], format: 'PNG', frozenAt: '2026-10-13T10:00:00.000Z', sources: [], items: [{
        format: 'LINKEDIN_COVER_VISUAL', revisionId, number: 1, sha256: 'a'.repeat(64), contentMode: 'FACTUAL', reviewCounter: 1, provenance: {},
        visual: { compositionHash: 'a'.repeat(64), width: 1, height: 1, templateIds: ['editorial'], resourceManifest: [], rendererVersion: 'renderer-v1', frames: [
          { frameId, ordinal: 1, width: 1, height: 1, previewAssetId, sha256: digest, rendererVersion: 'renderer-v1', fontHashes: { onest: 'b'.repeat(64) } },
        ] },
      }] } as unknown as ExportManifest;
    const files = await renderVisualExportFiles(visualManifest, new Map([[revisionId, { frames: [{ frameId, ordinal: 1, bytes: png }] }]]));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ name: 'linkedin-cover.png', contentType: 'image/png' });
    expect(files[0]!.bytes.equals(png)).toBe(true);
  });

  it('writes carousel pages in approved order and adds only visual frame PNGs plus PDF to ZIP', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zOQAAAAASUVORK5CYII=', 'base64');
    const digest = createHash('sha256').update(png).digest('hex');
    const revisionId = '22222222-2222-4222-8222-222222222222';
    const frameIds = ['11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555'];
    const frames = frameIds.map((frameId, index) => ({ frameId, ordinal: index + 1, width: 1, height: 1, previewAssetId: `33333333-3333-4333-8333-33333333333${index}`,
      sha256: digest, rendererVersion: 'renderer-v1', fontHashes: { onest: 'b'.repeat(64) } }));
    const visual = { compositionHash: 'a'.repeat(64), width: 1, height: 1, templateIds: ['editorial'], resourceManifest: [], rendererVersion: 'renderer-v1', frames };
    const visualManifest = { schemaVersion: 'export-manifest-v1', projectId: '44444444-4444-4444-8444-444444444444', projectRevision: 1,
      formats: ['LINKEDIN_CAROUSEL_VISUAL'], format: 'PDF', frozenAt: '2026-10-13T10:00:00.000Z', sources: [], items: [{ format: 'LINKEDIN_CAROUSEL_VISUAL',
        revisionId, number: 1, sha256: 'a'.repeat(64), contentMode: 'FACTUAL', reviewCounter: 1, provenance: {}, visual }] } as unknown as ExportManifest;
    const visualAssets = new Map([[revisionId, { frames: frameIds.map((frameId, index) => ({ frameId, ordinal: index + 1, bytes: png })) }]]);
    const [pdfFile] = await renderVisualExportFiles(visualManifest, visualAssets);
    const pdf = await PDFDocument.load(pdfFile!.bytes);
    expect(pdf.getPages()).toHaveLength(2);
    expect(pdf.getPages()[0]!.getSize()).toEqual({ width: 1, height: 1 });

    const zipManifest = { ...visualManifest, format: 'ZIP' as const };
    const textFiles = renderExportFiles(zipManifest, new Map());
    const visualFiles = await renderVisualExportFiles(zipManifest, visualAssets);
    const files = [...textFiles.slice(0, -2), ...visualFiles, ...textFiles.slice(-2)];
    expect(files.map(file => file.name)).toEqual(['linkedin-carousel-01.png', 'linkedin-carousel-02.png', 'linkedin-carousel.pdf', 'manifest.json', 'sources.json']);
    const entries = unzipStored(zipExportFiles(files));
    expect([...entries.keys()]).toEqual(files.map(file => file.name));
    expect(entries.get('linkedin-carousel-01.png')!.bytes.equals(png)).toBe(true);
    expect(entries.get('sources.json')!.bytes.toString('utf8')).toBe('[]\n');
  });

  it('accepts bounded mixed ZIPs and rejects non-cover PNG or stories PDF selections', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const all = ['ARTICLE', 'TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL',
      'INSTAGRAM_STORIES', 'LINKEDIN_CAROUSEL_SCRIPT', 'INSTAGRAM_CAROUSEL_SCRIPT', 'INSTAGRAM_STORIES_SCRIPT', 'LINKEDIN_COVER_VISUAL',
      'INSTAGRAM_COVER_VISUAL', 'LINKEDIN_CAROUSEL_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL', 'INSTAGRAM_STORIES_VISUAL'] as const;
    expect(createExportInput.safeParse({ expectedProjectRevision: 1, commandKey: 'mixed', format: 'ZIP',
      items: all.map(format => ({ format, revisionId: id, reviewCounter: 1 })) }).success).toBe(true);
    expect(createExportInput.safeParse({ expectedProjectRevision: 1, commandKey: 'cover', format: 'PNG',
      items: [{ format: 'INSTAGRAM_COVER_VISUAL', revisionId: id, reviewCounter: 1 }] }).success).toBe(true);
    expect(createExportInput.safeParse({ expectedProjectRevision: 1, commandKey: 'stories', format: 'PDF',
      items: [{ format: 'INSTAGRAM_STORIES_VISUAL', revisionId: id, reviewCounter: 1 }] }).success).toBe(false);
    expect(createExportInput.safeParse({ expectedProjectRevision: 1, commandKey: 'visual-text', format: 'MARKDOWN',
      items: [{ format: 'LINKEDIN_COVER_VISUAL', revisionId: id, reviewCounter: 1 }] }).success).toBe(false);
  });
});
