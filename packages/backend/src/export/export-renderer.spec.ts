import { describe, expect, it } from 'vitest';
import { canonicalManifestHash } from '../jobs/job-service.js';
import type { ExportManifest } from './export-contracts.js';
import { renderExportFiles, zipExportFiles, type ExportFile } from './export-renderer.js';

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
});
