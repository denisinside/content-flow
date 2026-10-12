import { ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { FONT_CATALOG, FONT_HASHES, RENDERER_VERSION, compositionSchema, renderVisualStage, imageRefs, type VisualComposition, type ImageRef } from '@contextflow/visuals';

export interface VisualRenderResource { ref: ImageRef; bytes: Buffer; mediaType: string }
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fontsRoot = fileURLToPath(new URL('../../../visuals/assets/fonts/', import.meta.url));
const konvaFile = resolve(dirname(fileURLToPath(import.meta.resolve('@contextflow/visuals'))), '..', 'node_modules', 'konva', 'konva.min.js');
function rasterDimensions(bytes: Buffer, png: boolean): { width: number; height: number } | null {
  if (png) return bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR' ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : null;
  let position = 2;
  while (position + 4 <= bytes.length) {
    if (bytes[position] !== 255) return null;
    while (bytes[position] === 255) position++;
    const marker = bytes[position++]!;
    if (marker === 217 || marker === 218) return null;
    if (marker === 1 || marker >= 208 && marker <= 215) continue;
    if (position + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(position);
    if (length < 2 || position + length > bytes.length) return null;
    if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
      return length >= 7 ? { width: bytes.readUInt16BE(position + 5), height: bytes.readUInt16BE(position + 3) } : null;
    }
    position += length;
  }
  return null;
}

/** Offline Chromium renders the exact shared Konva function; external URLs and executable node JSON never enter it. */
export class VisualRenderer {
  private browserPromise: Promise<Browser> | undefined;
  private active = false;
  private async context(): Promise<BrowserContext> {
    if (this.active) throw new ServiceUnavailableException('Visual renderer is busy; retry shortly');
    this.active = true;
    try {
      this.browserPromise ??= chromium.launch({ headless: true, ...(process.env['VISUAL_BROWSER_CHANNEL'] === 'chrome' ? { channel: 'chrome' } : {}) });
      const browser = await this.browserPromise;
      const context = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1, javaScriptEnabled: true, serviceWorkers: 'block' });
      await context.route('**/*', route => route.abort());
      return context;
    } catch {
      this.browserPromise = undefined;
      this.active = false;
      throw new ServiceUnavailableException('Visual renderer unavailable; provision the pinned Chromium runtime');
    }
  }
  async onModuleDestroy() { if (this.browserPromise) await (await this.browserPromise).close(); }
  async render(raw: VisualComposition, frameId: string, resources: VisualRenderResource[]) {
    const parsed = compositionSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.frames.some(frame => frame.id === frameId)) throw new BadRequestException('Invalid visual composition');
    const composition = parsed.data;
    const resourceMap: Record<string, string> = {};
    for (const ref of imageRefs(composition)) {
      const resource = resources.find(row => row.ref.type === ref.type && row.ref.id === ref.id);
      if (!resource || hash(resource.bytes) !== ref.sha256 || !['image/png', 'image/jpeg'].includes(resource.mediaType) || resource.bytes.length > 5 * 1024 * 1024) throw new BadRequestException('Visual resource integrity check failed');
      resourceMap[`${ref.type}:${ref.id}`] = `data:${resource.mediaType};base64,${resource.bytes.toString('base64')}`;
    }
    const fonts = await Promise.all(FONT_CATALOG.map(async font => ({ ...font, bytes: await readFile(resolve(fontsRoot, font.file)) })));
    const fontHashes = Object.fromEntries(fonts.map(font => [font.id, hash(font.bytes)]));
    if (fonts.some(font => fontHashes[font.id] !== FONT_HASHES[font.id])) throw new ServiceUnavailableException('Pinned visual font integrity check failed');
    const context = await this.context();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.setContent('<!doctype html><html><head></head><body style="margin:0"><div id="canvas"></div></body></html>');
      await page.addScriptTag({ content: await readFile(konvaFile, 'utf8') });
      await page.evaluate(async entries => {
        for (const font of entries) {
          const face = new FontFace(font.family, `url(data:font/ttf;base64,${font.base64})`, { weight: '100 900' });
          await face.load(); document.fonts.add(face);
        }
      }, fonts.map(font => ({ family: font.family, base64: font.bytes.toString('base64') })));
      // Only trusted compiled source is evaluated. All user text and resources travel as structured arguments.
      await page.addScriptTag({ content: `window.FONT_CATALOG=${JSON.stringify(FONT_CATALOG)};window.drawVisual=${renderVisualStage.toString()};` });
      const result = await page.evaluate(async input => {
        const runtime = window as unknown as { Konva: Parameters<typeof renderVisualStage>[0]; drawVisual: typeof renderVisualStage };
        const rendered = await Promise.race([runtime.drawVisual(runtime.Konva, document.getElementById('canvas') as HTMLDivElement, input.composition, input.frameId, async ref => {
          const url = input.resources[`${ref.type}:${ref.id}`];
          if (!url) throw new Error('Image unavailable');
          return url;
        }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Render timeout')), 15000))]);
        return { data: rendered.stage.toDataURL({ pixelRatio: 1 }), overflow: rendered.overflow };
      }, { composition, frameId, resources: resourceMap });
      const bytes = Buffer.from(result.data.split(',')[1]!, 'base64');
      if (bytes.length > 10 * 1024 * 1024) throw new BadRequestException('Rendered preview exceeds file limit');
      return { bytes, overflow: result.overflow, sha256: hash(bytes), rendererVersion: `${RENDERER_VERSION};chromium-${(await this.browserPromise!).version()}`, fontHashes };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Visual preview could not be rendered; saved composition is preserved');
    } finally { await context.close(); this.active = false; }
  }
  async normalizeImage(bytes: Buffer, mediaType: 'image/png' | 'image/jpeg') {
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (bytes.length > 5 * 1024 * 1024 || (mediaType === 'image/png' ? !png : !jpeg)) throw new BadRequestException('Choose a PNG or JPEG up to 5 MB');
    const dimensions = rasterDimensions(bytes, png);
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 12000000) throw new BadRequestException('Choose a raster within 4096 px and 12 megapixels');
    const context = await this.context();
    try {
      const page = await context.newPage();
      const result = await page.evaluate(async input => {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => { const img = new Image(); const timer = setTimeout(() => reject(new Error('Image timeout')), 10000); img.onload = () => { clearTimeout(timer); resolve(img); }; img.onerror = () => { clearTimeout(timer); reject(new Error('Invalid image')); }; img.src = input; });
        if (image.width > 4096 || image.height > 4096 || image.width * image.height > 12000000) throw new Error('Image dimensions too large');
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height, data: canvas.toDataURL('image/png') };
      }, `data:${mediaType};base64,${bytes.toString('base64')}`);
      const canonical = Buffer.from(result.data.split(',')[1]!, 'base64');
      if (canonical.length > 5 * 1024 * 1024) throw new BadRequestException('Decoded image exceeds 5 MB');
      return { bytes: canonical, mediaType: 'image/png' as const, width: result.width, height: result.height, sha256: hash(canonical) };
    } catch { throw new BadRequestException('Image cannot be read; use a PNG/JPEG within 4096 px and 12 megapixels'); }
    finally { await context.close(); this.active = false; }
  }
}
