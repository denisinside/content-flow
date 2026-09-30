import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ImportValidationError } from './document-validation.js';

export type ResolveAddresses = (hostname: string) => Promise<string[]>;
export const resolveAddresses: ResolveAddresses = async hostname => (await lookup(hostname, { all: true, verbatim: true })).map(answer => answer.address);

export function publicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = value.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127
      || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2 || b === 88 && c === 99)
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const lowered = value.toLowerCase();
    const [left = '', right] = lowered.split('::');
    const firstParts = left.split(':').filter(Boolean), lastParts = (right ?? '').split(':').filter(Boolean);
    const parts = right === undefined ? firstParts : [...firstParts, ...Array<string>(8 - firstParts.length - lastParts.length).fill('0'), ...lastParts];
    const numbers = parts.map(part => Number.parseInt(part, 16));
    // Only native globally routable unicast is allowed. Exclude transition,
    // embedded IPv4, documentation and protocol-assignment ranges.
    return numbers.length === 8 && (numbers[0]! & 0xe000) === 0x2000 && !lowered.includes('.')
      && !(numbers[0] === 0x2001 && (numbers[1]! < 0x200 || numbers[1] === 0xdb8)) && numbers[0] !== 0x2002
      && !(numbers[0] === 0x3fff && numbers[1]! < 0x1000);
  }
  return false;
}

export function normalizeImportUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ImportValidationError('INVALID_URL', 'Enter a complete public HTTP or HTTPS URL'); }
  const hostname = url.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || value.length > 2048
    || hostname.endsWith('.') || /\.(?:localhost|local|internal|home|lan|test|invalid)$/u.test(hostname)
    || (!isIP(hostname) && (!hostname.includes('.') || !/^[a-z0-9.-]+$/u.test(hostname)))
    || isIP(hostname) && !publicAddress(hostname)) throw new ImportValidationError('INVALID_URL', 'Only public HTTP or HTTPS URLs on standard ports are supported');
  url.hash = '';
  return url;
}

export async function validatePublicUrl(value: string, resolver: ResolveAddresses = resolveAddresses): Promise<{ url: string; addresses: string[] }> {
  const url = normalizeImportUrl(value), hostname = url.hostname.replace(/^\[|\]$/gu, '');
  let addresses: string[];
  try { addresses = isIP(hostname) ? [hostname] : await resolver(hostname); }
  catch { throw new ImportValidationError('INVALID_URL', 'The URL hostname could not be resolved'); }
  if (!addresses.length || addresses.length > 32 || addresses.some(address => !publicAddress(address))) {
    throw new ImportValidationError('INVALID_URL', 'The URL resolves to a non-public or unsupported address');
  }
  return { url: url.href, addresses: [...new Set(addresses)].sort() };
}
