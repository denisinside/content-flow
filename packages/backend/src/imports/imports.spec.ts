import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_MAX_BYTES, validateDigitalDocument } from './document-validation.js';
import { ImportProviders, importProviderSettings, DOCLING_OPTIONS } from './providers.js';
import { normalizeImportUrl, publicAddress, validatePublicUrl } from './url-validation.js';

const policyDigest = 'a'.repeat(64);
const policy = { schemaVersion: 'contextflow-egress-v1', policyDigest, publicOnly: true, pinDns: true,
  validateEveryRedirect: true, validateSubresources: true, networkIsolation: true, maxRedirects: 5, maxRequests: 100, maxResponseBytes: 10485760 };
const settings = importProviderSettings({ FIRECRAWL_ENDPOINT: 'https://gateway.example.com', FIRECRAWL_EGRESS_POLICY_SHA256: policyDigest,
  DOCLING_ENDPOINT: 'https://docling.example.com', DOCLING_VERSION: '1.21.0' });
const publicDns = async () => ['93.184.216.34'];
const pdf = Buffer.from('%PDF-1.7\n1 0 obj <</Type /Catalog>> endobj\n%%EOF');

function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function docxFixture(entries: Array<[string, string]> = [
  ['[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
  ['word/document.xml', '<w:document><w:p>Український абзац</w:p></w:document>'],
]): Buffer {
  const localParts: Buffer[] = [], directoryParts: Buffer[] = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), content = Buffer.from(value), crc = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, content);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(content.length, 20); central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42); directoryParts.push(central, filename);
    offset += local.length + filename.length + content.length;
  }
  const directory = Buffer.concat(directoryParts), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

describe('digital document trust boundary', () => {
  const file = (bytes: Buffer, name = 'source.docx', mime = 'application/octet-stream') => ({ originalname: name, mimetype: mime, buffer: bytes, size: bytes.length });
  it('accepts actual bounded PDF and DOCX bytes and Unicode filenames', () => {
    expect(validateDigitalDocument(file(pdf, 'джерело.pdf', 'application/pdf')).format).toBe('pdf');
    expect(validateDigitalDocument(file(docxFixture())).format).toBe('docx');
  });
  it('rejects mislabelling, incomplete/encrypted PDFs, invalid paths and oversize bytes', () => {
    for (const input of [file(pdf), file(Buffer.from('%PDF-1.7'), 'incomplete.pdf'), file(Buffer.concat([pdf, Buffer.from('/Encrypt')]), 'encrypted.pdf'),
      file(docxFixture(), '../source.docx'), file(docxFixture(), 'source.docx', 'application/pdf'), file(Buffer.alloc(DOCUMENT_MAX_BYTES + 1), 'large.pdf')]) {
      expect(() => validateDigitalDocument(input)).toThrow();
    }
  });
  it('rejects archive traversal, missing DOCX identity, duplicates, corruption, XML entities and external references', () => {
    for (const bytes of [docxFixture([['../evil', 'bad']]), docxFixture([['word/document.xml', 'plain']]),
      docxFixture([['word/document.xml', 'one'], ['word/document.xml', 'two']]),
      docxFixture([['[Content_Types].xml', '<!DOCTYPE foo>']]), docxFixture([['word/_rels/document.xml.rels', '<Relationship TargetMode="External"/>']])]) {
      expect(() => validateDigitalDocument(file(bytes))).toThrow();
    }
    const corrupt = docxFixture(); corrupt[50] = corrupt[50]! ^ 1;
    expect(() => validateDigitalDocument(file(corrupt))).toThrow();
  });
  it('rejects decoded external relationships in otherwise valid DOCX packages', () => {
    const identity: Array<[string, string]> = [
      ['[Content_Types].xml', '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
      ['word/document.xml', '<w:document><w:p>Український абзац</w:p></w:document>'],
    ];
    for (const relation of [
      '<Relationship TargetMode="External" Target="http://127.0.0.1/internal"/>',
      '<Relationship TargetMode="Ex&#116;ernal" Target="http://127.0.0.1/internal"/>',
      '<Relationship TargetMode="Ex&#x74;ernal" Target="http://127.0.0.1/internal"/>',
      '<Relationship TargetMode=" External " Target="http://127.0.0.1/internal"/>',
      '<Relationship Target="http://127.0.0.1/internal"/>',
      '<Relationship Target="//127.0.0.1/internal"/>',
      '<Relationship TargetMode="External"/>'.split('').join('\u0000'),
    ]) {
      expect(() => validateDigitalDocument(file(docxFixture([...identity, ['word/_rels/document.xml.rels', relation]]))))
        .toThrow('DOCX external resources and XML entities are unsupported');
    }
    expect(validateDigitalDocument(file(docxFixture([...identity,
      ['word/_rels/document.xml.rels', '<Relationship TargetMode="Internal" Target="media/image1.png"/>']]))).format).toBe('docx');
  });
});

describe('URL local and remote trust boundaries', () => {
  it('rejects literal/private/reserved/protocol addresses regardless of alternate representation', async () => {
    for (const url of ['file:///etc/passwd', 'https://user:pass@example.com', 'http://localhost', 'http://service.local', 'http://127.1',
      'http://2130706433', 'http://0x7f000001', 'http://192.168.0.1', 'http://[::ffff:7f00:1]', 'http://[2001:0db8::1]', 'http://[2001:0000::1]', 'https://example.com:444']) {
      expect(() => normalizeImportUrl(url)).toThrow();
    }
    for (const address of ['0.0.0.0', '100.64.0.1', '169.254.169.254', '198.18.0.1', '192.88.99.1', '2001:0000::1', '2001:0db8::1', '2001:020::1', '3fff:000::1']) expect(publicAddress(address)).toBe(false);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    await expect(validatePublicUrl('https://example.com', async () => ['93.184.216.34', '10.0.0.1'])).rejects.toThrow();
  });
  it('pins normalized Unicode URLs and rejects DNS rebinding before sending selected input', async () => {
    expect(normalizeImportUrl('https://приклад.com/#fragment').href).toMatch(/^https:\/\/xn--/u);
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(policy)));
    const dns = vi.fn().mockResolvedValueOnce(['93.184.216.34']).mockResolvedValueOnce(['1.1.1.1']);
    const adapter = new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, transport, dns);
    await expect(adapter.web('https://example.com', settings, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('isolates TEST provider configuration and refuses to inherit DEV provider secrets/endpoints', async () => {
    const isolated = importProviderSettings({ NODE_ENV: 'test', FIRECRAWL_ENDPOINT: 'https://live.example.com', DOCLING_ENDPOINT: 'https://live-docling.example.com', FIRECRAWL_EGRESS_POLICY_SHA256: policyDigest });
    expect(isolated.firecrawlEndpoint).toBe(''); expect(isolated.doclingEndpoint).toBe('');
    const transport = vi.fn<typeof fetch>();
    await expect(new ImportProviders({ NODE_ENV: 'test', FIRECRAWL_API_KEY: 'dev-secret' }, transport, publicDns)
      .web('https://example.com', settings, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'CONFIG' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('requires proven pinned gateway controls and rejects remote private redirect/subresource evidence', async () => {
    const unprotected = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...policy, pinDns: false })));
    await expect(new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, unprotected, publicDns).web('https://example.com', settings, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'CONFIG' });
    const remote = { success: true, data: { markdown: 'text', metadata: { statusCode: 200 }, remoteFetch: { policyDigest, requests: [
      { url: 'https://example.com/', addresses: ['10.0.0.1'], connectedAddress: '10.0.0.1', responseBytes: 10, redirect: true }] } } };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(policy))).mockResolvedValueOnce(new Response(JSON.stringify(remote)));
    await expect(new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, transport, publicDns).web('https://example.com', settings, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'CONTRACT' });
  });
  it('uses the regular Firecrawl Cloud API without the custom gateway digest and records the provider-managed boundary', async () => {
    const cloudSettings = importProviderSettings({ FIRECRAWL_ENDPOINT: 'https://api.firecrawl.dev', FIRECRAWL_VERSION: 'v2' });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      markdown: '# Example Domain', metadata: { statusCode: 200, sourceURL: 'https://example.com/', title: 'Example Domain' },
    } })));
    const beforeSubmit = vi.fn().mockResolvedValue(undefined);
    const result = await new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, transport, publicDns)
      .web('https://example.com/', cloudSettings, new AbortController().signal, beforeSubmit);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0]).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toMatchObject({ url: 'https://example.com/' });
    expect(String(transport.mock.calls[0]?.[1]?.body)).not.toContain('contextflowEgress');
    expect(result).toMatchObject({ text: '# Example Domain', metadata: { provider: 'firecrawl', egressMode: 'firecrawl-cloud', finalUrl: 'https://example.com/' } });
    expect(result.metadata['policyDigest']).toBeUndefined();
    expect(beforeSubmit).toHaveBeenCalledTimes(1);
  });
  it('does not persist a Firecrawl Cloud result whose reported final URL is private', async () => {
    const cloudSettings = importProviderSettings({ FIRECRAWL_ENDPOINT: 'https://api.firecrawl.dev', FIRECRAWL_VERSION: 'v2' });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      markdown: 'untrusted response', metadata: { statusCode: 200, url: 'http://127.0.0.1/internal' },
    } })));
    await expect(new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, transport, publicDns)
      .web('https://example.com/', cloudSettings, new AbortController().signal, vi.fn()))
      .rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('saves exact source metadata from a single bounded request with no browser cookies or alternate provider', async () => {
    const remote = { success: true, data: { markdown: 'Український абзац.\r\n\r\n| А | Б |\n|---|---|\n| 1 | 2 |',
      metadata: { statusCode: 200, title: 'Synthetic fixture', url: 'https://example.com/' }, remoteFetch: { policyDigest, requests: [
        { url: 'https://example.com/', addresses: ['93.184.216.34'], connectedAddress: '93.184.216.34', responseBytes: 100, redirect: false }] } } };
    const transport = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify(policy))).mockResolvedValueOnce(new Response(JSON.stringify(remote)));
    const before = vi.fn().mockResolvedValue(undefined);
    const result = await new ImportProviders({ FIRECRAWL_API_KEY: 'synthetic' }, transport, publicDns).web('https://example.com#fragment', settings, new AbortController().signal, before);
    expect(result.text).toContain('Український абзац.\n\n| А | Б |');
    expect(result.metadata).toMatchObject({ provider: 'firecrawl', policyDigest, requestedUrl: 'https://example.com/', finalUrl: 'https://example.com/' });
    expect(before).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(transport.mock.calls[1]?.[1]?.body));
    expect(body).toMatchObject({ maxAge: 0, skipTlsVerification: false, contextflowEgress: { pinnedAddresses: ['93.184.216.34'] }, headers: {}, actions: [], parsers: [] });
  });
});

describe('pinned Docling file upload', () => {
  it('submits original bytes with OCR off and exposes no invented page locators', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ status: 'success', document: { md_content: 'Український текст\n\n| A | B |' }, processing_time: 1.2 })));
    const document = validateDigitalDocument({ originalname: 'original.pdf', mimetype: 'application/pdf', buffer: pdf, size: pdf.length });
    const result = await new ImportProviders({}, transport).document(document, settings, new AbortController().signal, vi.fn());
    expect(String(transport.mock.calls[0]?.[0])).toBe('https://docling.example.com/v1/convert/file');
    const form = transport.mock.calls[0]?.[1]?.body as FormData;
    for (const [name, value] of Object.entries(DOCLING_OPTIONS)) expect(form.get(name)).toBe(value);
    expect(Buffer.from(await (form.get('files') as File).arrayBuffer())).toEqual(pdf);
    expect([...form.keys()]).not.toContain('http_sources');
    expect(result.metadata).toMatchObject({ provider: 'docling', version: '1.21.0', locatorType: 'normalized-text-offsets' });
    expect(result.metadata['pages']).toBeUndefined();
  });
  it('makes no-text and partial/malformed results visible and treats transport ambiguity as unknown outcome', async () => {
    const document = validateDigitalDocument({ originalname: 'scan.pdf', mimetype: 'application/pdf', buffer: pdf, size: pdf.length });
    for (const [raw, code] of [[{ status: 'success', document: { md_content: '' } }, 'NO_TEXT'], [{ status: 'partial_success', document: { md_content: 'partial' } }, 'CONTRACT']] as const) {
      await expect(new ImportProviders({}, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(raw)))).document(document, settings, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code });
    }
    await expect(new ImportProviders({}, vi.fn<typeof fetch>().mockRejectedValue(new Error('secret transport detail'))).document(document, settings, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: 'UNKNOWN_OUTCOME', message: 'The converter outcome is unknown. Start an explicit new import.' });
  });
});
