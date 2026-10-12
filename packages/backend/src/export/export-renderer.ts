import { articleContentSchema, type ArticleNode } from '../editorial/article-contracts.js';
import { telegramContentSchema, validateFormatContent, type AdaptationFormat } from '../editorial/telegram-contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { scriptContentSchema } from '../editorial/script-contracts.js';
import type { ExportManifest } from './export-contracts.js';

export type ExportFile = { name: string; bytes: Buffer; contentType: string };

const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
const CREATIVE_LABEL = '[Авторський текст · без перевіреної фактичної основи]';
export type ExportContentKind = 'ARTICLE' | 'TELEGRAM_POST' | 'LINKEDIN_TEXT' | 'LINKEDIN_COVER' | 'INSTAGRAM_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES' | 'LINKEDIN_CAROUSEL_SCRIPT' | 'INSTAGRAM_CAROUSEL_SCRIPT' | 'INSTAGRAM_STORIES_SCRIPT';
const formatOrder: Record<ExportContentKind, number> = { ARTICLE: 0, TELEGRAM_POST: 1, LINKEDIN_TEXT: 2, LINKEDIN_COVER: 3, INSTAGRAM_COVER: 4,
  LINKEDIN_CAROUSEL: 5, INSTAGRAM_CAROUSEL: 6, INSTAGRAM_STORIES: 7, LINKEDIN_CAROUSEL_SCRIPT: 8, INSTAGRAM_CAROUSEL_SCRIPT: 9, INSTAGRAM_STORIES_SCRIPT: 10 };
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

function sourcesForItem(manifest: ExportManifest, revisionId: string): Array<Record<string, unknown>> {
  return manifest.sources.filter(source => {
    const usedBy = source.usedBy;
    return Array.isArray(usedBy) && usedBy.some(usage => !!usage && typeof usage === 'object' && (usage as Record<string, unknown>).revisionId === revisionId);
  });
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

function adaptationText(format: AdaptationFormat, content: unknown): { text: string; cover?: { text: string; instruction: string } } {
  const parsed = validateFormatContent(format, telegramContentSchema.parse(content));
  return { text: parsed.text, ...(parsed.cover ? { cover: parsed.cover } : {}) };
}

function itemBody(item: ExportManifest['items'][number], content: unknown, markdown: boolean): string {
  if (item.format.endsWith('_SCRIPT')) {
    const script = scriptContentSchema.parse(content);
    const provenance = item.provenance as Record<string, unknown>;
    const parentCaption = typeof provenance.parentCaption === 'string' ? provenance.parentCaption : null;
    const usedSources = Array.isArray(provenance.usedSources) ? provenance.usedSources.filter((source): source is Record<string, unknown> => !!source && typeof source === 'object' && !Array.isArray(source)) : [];
    const sourceSection = markdown && usedSources.length ? `\n\n## Використані джерела\n\n${usedSources.map(source => {
      const label = typeof source.materialLabel === 'string' ? escapeMarkdown(source.materialLabel) : 'Джерело';
      const snapshot = typeof source.snapshotId === 'string' ? ` · ${escapeMarkdown(source.snapshotId)}` : '';
      const quote = typeof source.quote === 'string' ? escapeMarkdown(source.quote) : '';
      const link = typeof source.sourceUrl === 'string' ? ` · <${source.sourceUrl.replace(/[<>\r\n]/gu, '')}>` : '';
      const roles = Array.isArray(source.usedBy) ? source.usedBy.map(usage => usage && typeof usage === 'object' ? (usage as Record<string, unknown>).role : null)
        .filter((role): role is string => typeof role === 'string') : [];
      const usage = roles.length ? ` (${[...new Set(roles)].map(escapeMarkdown).join(', ')})` : '';
      const locations = Array.isArray(source.frameLocators) ? source.frameLocators.map(locator => {
        if (!locator || typeof locator !== 'object') return '';
        const row = locator as Record<string, unknown>;
        const frame = typeof row.frameOrdinal === 'number' ? `кадр ${row.frameOrdinal}` : typeof row.frameId === 'string' ? `кадр ${row.frameId}` : '';
        return frame && typeof row.startOffset === 'number' && typeof row.endOffset === 'number' ? `${frame}, символи ${row.startOffset}–${row.endOffset}` : frame;
      }).filter(Boolean).join(', ') : '';
      return `- ${locations ? `${locations}: ` : ''}${label}${usage}${snapshot}${link}${quote ? ` — “${quote}”` : ''}`;
    }).join('\n')}` : '';
    const lines = script.frames.map((frame, index) => [
      markdown ? `## Кадр ${index + 1} · ${escapeMarkdown(frame.purpose)}` : `Кадр ${index + 1} · ${frame.purpose}`,
      markdown ? escapeMarkdown(frame.text) : frame.text,
      ...(frame.visualHint ? [`\n${markdown ? '**Візуальна підказка:**' : 'Візуальна підказка:'} ${markdown ? escapeMarkdown(frame.visualHint) : frame.visualHint}`] : []),
      ...(frame.transition ? [`\n${markdown ? '**Перехід:**' : 'Перехід:'} ${markdown ? escapeMarkdown(frame.transition) : frame.transition}`] : []),
    ].join('\n\n'));
    const label = item.contentMode === 'CREATIVE' ? `${CREATIVE_LABEL}\n\n` : '';
    return `${label}${markdown ? `# ${escapeMarkdown(item.format.replace('_SCRIPT', ''))}\n\n` : ''}${parentCaption
      ? `${markdown ? `## Підпис\n\n${escapeMarkdown(parentCaption)}\n\n` : `Підпис\n${parentCaption}\n\n`}` : ''}${lines.join('\n\n')}${sourceSection}`;
  }
  const rendered = item.format === 'ARTICLE' ? renderArticle(content, markdown) : item.format === 'TELEGRAM_POST'
    ? (() => { const text = telegramContentSchema.parse(content).text; return markdown ? escapeMarkdown(text) : text; })()
    : (() => {
      const adaptation = adaptationText(item.format as AdaptationFormat, content);
      const text = markdown ? escapeMarkdown(adaptation.text) : adaptation.text;
      if (item.format === 'LINKEDIN_COVER' || item.format === 'INSTAGRAM_COVER') {
        if (!adaptation.cover) throw new Error('Cover export is missing cover text and instruction');
        const coverText = markdown ? escapeMarkdown(adaptation.cover.text) : adaptation.cover.text;
        const instruction = markdown ? escapeMarkdown(adaptation.cover.instruction) : adaptation.cover.instruction;
        return `${text}\n\n${markdown ? '## ' : ''}Текст обкладинки\n${coverText}\n\n${markdown ? '## ' : ''}Завдання для дизайнера\n${instruction}`;
      }
      return text;
    })();
  return item.contentMode === 'CREATIVE' ? `${CREATIVE_LABEL}\n\n${rendered}` : rendered;
}

function renderedFile(item: ExportManifest['items'][number], content: unknown, format: 'TXT' | 'MARKDOWN'): ExportFile {
  const ext = format === 'TXT' ? 'txt' : 'md';
  if (item.format.endsWith('_SCRIPT') && format === 'TXT') throw new Error('Script TXT export is not supported');
  const filename = ({ ARTICLE: 'article', TELEGRAM_POST: 'telegram', LINKEDIN_TEXT: 'linkedin-text',
    LINKEDIN_COVER: 'linkedin-cover', INSTAGRAM_COVER: 'instagram-cover', LINKEDIN_CAROUSEL: 'linkedin-carousel',
    INSTAGRAM_CAROUSEL: 'instagram-carousel', INSTAGRAM_STORIES: 'instagram-stories', LINKEDIN_CAROUSEL_SCRIPT: 'linkedin-carousel-script',
    INSTAGRAM_CAROUSEL_SCRIPT: 'instagram-carousel-script', INSTAGRAM_STORIES_SCRIPT: 'instagram-stories-script' } as const)[item.format];
  const rendered = itemBody(item, content, format === 'MARKDOWN');
  return {
    // Names are chosen from a closed set; no caller-controlled path is used.
    name: `${filename}.${ext}`,
    bytes: utf8(`${rendered}\n`),
    contentType: format === 'TXT' ? 'text/plain; charset=utf-8' : 'text/markdown; charset=utf-8',
  };
}

export function renderExportFiles(manifest: ExportManifest, contents: Map<string, { kind: ExportContentKind; content: unknown }>): ExportFile[] {
  const ordered = [...manifest.items].sort((a, b) => formatOrder[a.format as ExportContentKind] - formatOrder[b.format as ExportContentKind]);
  if (new Set(ordered.map(item => item.format)).size !== ordered.length) throw new Error('Export manifest contains duplicate item formats');
  if (manifest.format === 'JSON' && (ordered.length !== 1 || !ordered[0]!.format.endsWith('_SCRIPT'))) throw new Error('JSON export requires exactly one script');
  if (manifest.format === 'TXT' && ordered.some(item => item.format.endsWith('_SCRIPT'))) throw new Error('Script export requires JSON, Markdown or ZIP');
  const formats: Array<'TXT' | 'MARKDOWN'> = manifest.format === 'ZIP' ? ['TXT', 'MARKDOWN'] : manifest.format === 'JSON' ? [] : [manifest.format];
  const files: ExportFile[] = [];
  for (const format of formats) {
    for (const item of ordered.filter(row => !row.format.endsWith('_SCRIPT') || manifest.format === 'MARKDOWN')) {
      const stored = contents.get(item.revisionId);
      if (!stored || stored.kind !== item.format) throw new Error('Export content does not match the frozen manifest');
      if (canonicalManifestHash(stored.content) !== item.sha256) throw new Error('Export content hash does not match the frozen manifest');
      files.push(renderedFile(item, stored.content, format));
    }
  }
  if (manifest.format === 'JSON') {
    const item = ordered[0]!;
    const stored = contents.get(item.revisionId);
    if (!stored || stored.kind !== item.format || canonicalManifestHash(stored.content) !== item.sha256) throw new Error('Export content does not match the frozen manifest');
    const script = scriptContentSchema.parse(stored.content);
    files.push({ name: `${item.format.toLowerCase().replaceAll('_', '-')}.json`,
      bytes: utf8(`${canonicalJson({ schemaVersion: 'contextflow-script-v1', format: item.format, revisionId: item.revisionId, number: item.number,
        sha256: item.sha256, contentMode: item.contentMode, verificationLabel: item.contentMode === 'CREATIVE' ? CREATIVE_LABEL : null,
        provenance: item.provenance, frames: script.frames, sources: sourcesForItem(manifest, item.revisionId) })}\n`),
      contentType: 'application/json; charset=utf-8' });
  }
  if (manifest.format === 'ZIP') {
    for (const item of ordered.filter(row => row.format.endsWith('_SCRIPT'))) {
      const stored = contents.get(item.revisionId);
      if (!stored || stored.kind !== item.format || canonicalManifestHash(stored.content) !== item.sha256) throw new Error('Export content does not match the frozen manifest');
      const script = scriptContentSchema.parse(stored.content);
      files.push({ name: `${item.format.toLowerCase().replaceAll('_', '-')}.json`,
        bytes: utf8(`${canonicalJson({ schemaVersion: 'contextflow-script-v1', format: item.format, revisionId: item.revisionId, number: item.number,
          sha256: item.sha256, contentMode: item.contentMode, verificationLabel: item.contentMode === 'CREATIVE' ? CREATIVE_LABEL : null,
          provenance: item.provenance, frames: script.frames, sources: sourcesForItem(manifest, item.revisionId) })}\n`), contentType: 'application/json; charset=utf-8' });
      files.push(renderedFile(item, stored.content, 'MARKDOWN'));
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
