import { basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export class ImportValidationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export type DigitalDocument = { bytes: Buffer; filename: string; mediaType: string; format: 'pdf' | 'docx' };

export function originalFilename(value: string): string {
  let name = value;
  if ([...name].every(character => character.codePointAt(0)! <= 0xff)) {
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(name, 'latin1')); }
    catch { /* Legacy Latin-1 names remain valid if not encoded UTF-8. */ }
  }
  if (name !== basename(name.replaceAll('\\', '/')) || !name || name.length > 255 || name !== name.trim()
    || /[\u0000-\u001F\u007F]/u.test(name)) throw new ImportValidationError('INVALID_FILE', 'Invalid document filename');
  return name;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function docxEntries(bytes: Buffer): Map<string, Buffer> {
  // Reject ZIP64, multi-volume, encrypted and ambiguous archives rather than asking
  // the converter to interpret them differently from the validator.
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  const bad = () => new ImportValidationError('INVALID_FILE', 'DOCX archive is invalid or exceeds safe decompression limits');
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw bad();
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16);
  if (!count || count > 1000 || count !== bytes.readUInt16LE(end + 8) || directoryStart + directorySize !== end) throw bad();
  const result = new Map<string, Buffer>();
  let cursor = directoryStart, expanded = 0;
  const ranges: Array<[number, number]> = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw bad();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const local = bytes.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & ~0x0808) || ![0, 8].includes(method) || size > 20 * 1024 * 1024
      || size > Math.max(1, compressed) * 100 || (expanded += size) > 40 * 1024 * 1024
      || bytes.readUInt16LE(cursor + 34) || (bytes.readUInt32LE(cursor + 38) >>> 16 & 0xf000) === 0xa000) throw bad();
    let name: string;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { throw bad(); }
    if (!name || name.length > 500 || name.startsWith('/') || name.includes('\\') || name.includes(':')
      || name.split('/').some(part => part === '..' || part === '.') || /[\u0000-\u001F]/u.test(name)
      || result.has(name) || /(?:vbaProject\.bin|\.(?:zip|docm|exe|dll))$/iu.test(name)) throw bad();
    if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50
      || flags !== bytes.readUInt16LE(local + 6) || method !== bytes.readUInt16LE(local + 8)) throw bad();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const data = local + 30 + localNameLength + localExtraLength, dataEnd = data + compressed;
    if (dataEnd > directoryStart || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
      || ranges.some(([start, finish]) => local < finish && dataEnd > start)) throw bad();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(cursor + 16)
      || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) throw bad();
    let recordEnd = dataEnd;
    if (flags & 8) {
      const descriptor = dataEnd + (dataEnd + 4 <= directoryStart && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
      if (descriptor + 12 > directoryStart || bytes.readUInt32LE(descriptor) !== bytes.readUInt32LE(cursor + 16)
        || bytes.readUInt32LE(descriptor + 4) !== compressed || bytes.readUInt32LE(descriptor + 8) !== size) throw bad();
      recordEnd = descriptor + 12;
      if (ranges.some(([start, finish]) => local < finish && recordEnd > start)) throw bad();
    }
    ranges.push([local, recordEnd]);
    let content: Buffer;
    try { content = method === 0 ? bytes.subarray(data, dataEnd) : inflateRawSync(bytes.subarray(data, dataEnd), { maxOutputLength: Math.max(1, size) }); }
    catch { throw bad(); }
    if (content.length !== size || crc32(content) !== bytes.readUInt32LE(cursor + 16)) throw bad();
    if (/\.(?:xml|rels)$/iu.test(name)) {
      let xml: string;
      try { xml = new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { throw bad(); }
      // Relationship attributes must have the same meaning for this validator
      // and the converter. Conservatively reject encoded attributes rather than
      // interpreting XML with a second, potentially different entity policy.
      const relationships = /\.rels$/iu.test(name);
      if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(xml)
        || /encoding\s*=\s*["'](?!utf-8["'])[^"']+["']/iu.test(xml)
        || /<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml)
        || (relationships && xml.includes('&'))
        || /TargetMode\s*=\s*["']\s*External\s*["']/iu.test(xml)
        || (relationships && /Target\s*=\s*["']\s*(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/iu.test(xml))) {
        throw new ImportValidationError('INVALID_FILE', 'DOCX external resources and XML entities are unsupported');
      }
    }
    result.set(name, content); cursor = next;
  }
  if (cursor !== end || !result.has('[Content_Types].xml') || !result.has('word/document.xml')) throw bad();
  const types = result.get('[Content_Types].xml')!.toString('utf8');
  if (!types.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') || /macroEnabled/iu.test(types)) throw bad();
  return result;
}

export function validateDigitalDocument(file: { originalname: string; mimetype: string; buffer: Buffer; size: number }): DigitalDocument {
  if (!file.size || file.size !== file.buffer.length || file.size > DOCUMENT_MAX_BYTES) {
    throw new ImportValidationError('INVALID_FILE', 'Digital documents must be no larger than 10 MiB');
  }
  const filename = originalFilename(file.originalname), extension = filename.toLowerCase().split('.').at(-1);
  const format = extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'docx' : undefined;
  const mediaType = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (!format || ![mediaType, 'application/octet-stream'].includes(file.mimetype)) throw new ImportValidationError('INVALID_FILE', 'Only matching PDF and DOCX documents are supported');
  if (format === 'pdf') {
    if (!/^%PDF-[12]\.\d/u.test(file.buffer.subarray(0, 9).toString('ascii')) || !file.buffer.subarray(-1024).toString('latin1').includes('%%EOF')) {
      throw new ImportValidationError('INVALID_FILE', 'File does not contain a complete PDF');
    }
    if (/\/Encrypt\b/u.test(file.buffer.toString('latin1'))) throw new ImportValidationError('INVALID_FILE', 'Encrypted PDF documents are unsupported');
  } else docxEntries(file.buffer);
  return { bytes: Buffer.from(file.buffer), filename, format, mediaType };
}
