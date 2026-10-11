import { articleContentSchema, type ArticleNode } from '../editorial/article-contracts.js';
import { telegramContentSchema } from '../editorial/telegram-contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import type { ExportManifest } from './export-contracts.js';

export type ExportFile = { name: string; bytes: Buffer; contentType: string };

const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const CREATIVE_LABEL = '[Авторський текст · без перевіреної фактичної основи]';
const utf8 = (value: string) => Buffer.from(value, 'utf8');
const escapeMarkdown = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/([\\`*_{}\[\]()#+.!|~-])/gu, '\\$1');

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new Error('Export JSON contains an unsupported value');
}

function ensureSize(files: ExportFile[]): void {
  if (files.reduce((total, file) => total + file.bytes.length, 0) > MAX_EXPORT_BYTES) throw new Error('Export exceeds the 10 MiB limit');
}

function inline(node: ArticleNode, markdown: boolean): string {
  if (node.type === 'hardBreak') return '\n';
  if (node.type !== 'text') throw new Error('Invalid article inline node');
  let text = node.text ?? '';
  if (!markdown) return text;
  text = escapeMarkdown(text);
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') text = `**${text}**`;
    else if (mark.type === 'italic') text = `_${text}_`;
    else if (mark.type === 'strike') text = `~~${text}~~`;
    // Evidence metadata is provenance, not inline formatting.
  }
  return text;
}

function renderArticle(content: unknown, markdown: boolean): string {
  const article = articleContentSchema.parse(content);
  const blocks: string[] = [markdown ? `# ${escapeMarkdown(article.title)}` : article.title];
  const renderBlock = (node: ArticleNode, depth = 0): string[] => {
    switch (node.type) {
      case 'paragraph': return [(node.content ?? []).map(child => inline(child, markdown)).join('')];
      case 'heading': return [`${markdown ? '#'.repeat(node.attrs?.level ?? 2) + ' ' : ''}${(node.content ?? []).map(child => inline(child, markdown)).join('')}`];
      case 'blockquote': return (node.content ?? []).flatMap(child => renderBlock(child, depth + 1)).map(line => markdown ? `> ${line}` : line);
      case 'bulletList':
      case 'orderedList': {
        let index = 0;
        return (node.content ?? []).flatMap(item => {
          index++;
          const itemBlocks = (item.content ?? []).flatMap(child => renderBlock(child, depth + 1));
          return itemBlocks.map((line, lineIndex) => markdown
            ? `${'  '.repeat(depth)}${lineIndex === 0 ? node.type === 'bulletList' ? '- ' : `${index}. ` : '  '}${line}`
            : `${'  '.repeat(depth)}${lineIndex === 0 ? node.type === 'bulletList' ? '• ' : `${index}. ` : '  '}${line}`);
        });
      }
      case 'listItem': return (node.content ?? []).flatMap(child => renderBlock(child, depth));
      case 'doc': return (node.content ?? []).flatMap(child => renderBlock(child, depth));
      default: throw new Error(`Invalid article block node: ${node.type}`);
    }
  };
  blocks.push(...renderBlock(article.document));
  return blocks.filter((block, index) => block.length > 0 || index === 0).join('\n\n');
}

function itemBody(item: ExportManifest['items'][number], content: unknown, markdown: boolean): string {
  const rendered = item.format === 'ARTICLE' ? renderArticle(content, markdown) : (() => {
    const text = telegramContentSchema.parse(content).text;
    return markdown ? escapeMarkdown(text) : text;
  })();
  return item.contentMode === 'CREATIVE' ? `${CREATIVE_LABEL}\n\n${rendered}` : rendered;
}

function renderedFile(item: ExportManifest['items'][number], content: unknown, format: 'TXT' | 'MARKDOWN'): ExportFile {
  const ext = format === 'TXT' ? 'txt' : 'md';
  const isArticle = item.format === 'ARTICLE';
  const rendered = itemBody(item, content, format === 'MARKDOWN');
  return {
    // Names are chosen from a closed set; no caller-controlled path is used.
    name: `${isArticle ? 'article' : 'telegram'}.${ext}`,
    bytes: utf8(`${rendered}\n`),
    contentType: format === 'TXT' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
  };
}

export function renderExportFiles(manifest: ExportManifest, contents: Map<string, { kind: 'ARTICLE' | 'TELEGRAM_POST'; content: unknown }>): ExportFile[] {
  const ordered = [...manifest.items].sort((a, b) => (a.format === 'ARTICLE' ? 0 : 1) - (b.format === 'ARTICLE' ? 0 : 1));
  if (new Set(ordered.map(item => item.format)).size !== ordered.length) throw new Error('Export manifest contains duplicate item formats');
  const formats: Array<'TXT' | 'MARKDOWN'> = manifest.format === 'ZIP' ? ['TXT', 'MARKDOWN'] : [manifest.format];
  const files: ExportFile[] = [];
  for (const format of formats) {
    for (const item of ordered) {
      const stored = contents.get(item.revisionId);
      if (!stored || stored.kind !== item.format) throw new Error('Export content does not match the frozen manifest');
      if (canonicalManifestHash(stored.content) !== item.sha256) throw new Error('Export content hash does not match the frozen manifest');
      files.push(renderedFile(item, stored.content, format));
    }
  }
  if (manifest.format === 'ZIP') {
    files.push({ name: 'manifest.json', bytes: utf8(`${canonicalJson(manifest)}\n`), contentType: 'application/json; charset=utf-8' });
    files.push({ name: 'sources.json', bytes: utf8(`${canonicalJson(manifest.sources)}\n`), contentType: 'application/json; charset=utf-8' });
  }
  ensureSize(files);
  return files;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validateArchiveName(name: string): Buffer {
  if (!name || name.includes('/') || name.includes('\\') || name.includes(':') || name === '.' || name === '..' || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error('Unsafe ZIP entry name');
  }
  const encoded = utf8(name);
  if (encoded.length > 0xffff) throw new Error('ZIP entry name is too long');
  return encoded;
}

export function zipExportFiles(files: ExportFile[]): Buffer {
  ensureSize(files);
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const seenNames = new Set<string>();
  for (const file of files) {
    if (seenNames.has(file.name)) throw new Error('Duplicate ZIP entry name');
    seenNames.add(file.name);
    const name = validateArchiveName(file.name);
    const data = Buffer.from(file.bytes);
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 names and content.
    header.writeUInt16LE(0, 8); // STORE, no compression.
    header.writeUInt16LE(0, 10); // Fixed 1980-01-01 time.
    header.writeUInt16LE(0x0021, 12); // Fixed 1980-01-01 date.
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, data);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  if (files.length > 0xffff || offset > 0xffffffff || centralSize > 0xffffffff || offset + centralSize + 22 > MAX_EXPORT_BYTES) {
    throw new Error('Export exceeds the 10 MiB limit');
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, end]);
}
