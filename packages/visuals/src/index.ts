import { z } from 'zod';
import type KonvaType from 'konva';

export const RENDERER_VERSION = 'konva-10.7.1-visual-v1';
export const FONT_HASHES: Record<string, string> = {
  onest: '966c5c29b4755da84b6854d5c21dd4eaa2420225d0e9874de602de176d4a9f31',
  'source-serif': '97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b',
  lora: '822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7',
  'plex-sans': '3b031aa4216174205bd8471f88a49b91f093169e9e87bd5262242bc5967fe2e3',
  'plex-mono': '6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46',
};
export const FONT_CATALOG = [
  { id: 'onest', family: 'Onest', label: 'Onest', file: 'onest.ttf', license: 'Onest-OFL.txt' },
  { id: 'source-serif', family: 'SourceSerif', label: 'Source Serif 4', file: 'source-serif-4.ttf', license: 'SourceSerif4-OFL.txt' },
  { id: 'lora', family: 'Lora', label: 'Lora', file: 'lora.ttf', license: 'Lora-OFL.txt' },
  { id: 'plex-sans', family: 'PlexSans', label: 'IBM Plex Sans', file: 'plex-sans.ttf', license: 'PlexSans-OFL.txt' },
  { id: 'plex-mono', family: 'PlexMono', label: 'IBM Plex Mono', file: 'plex-mono.ttf', license: 'PlexMono-OFL.txt' },
] as const;
export const fontSchema = z.enum(['onest', 'source-serif', 'lora', 'plex-sans', 'plex-mono']);
export const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const imageRefSchema = z.object({ type: z.enum(['project', 'workspace']), id: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ImageRef = z.infer<typeof imageRefSchema>;
const bounds = { id: z.uuid(), x: z.number().int().min(0).max(1920), y: z.number().int().min(0).max(1920), width: z.number().int().min(16).max(1920), height: z.number().int().min(16).max(1920) };
export const mappingSchema = z.object({ startOffset: z.number().int().nonnegative(), endOffset: z.number().int().positive(), quote: z.string().max(3000), claimRevisionId: z.uuid(), evidenceId: z.uuid() }).strict();
export const textLayerSchema = z.object({ ...bounds, type: z.literal('text'), text: z.string().max(3000), font: fontSchema, fontSize: z.number().int().min(14).max(180), fontWeight: z.enum(['400', '600', '700']), color: colorSchema, align: z.enum(['left', 'center', 'right']), lineHeight: z.number().min(1).max(2), mappings: z.array(mappingSchema).max(100) }).strict();
const imageLayerSchema = z.object({ ...bounds, type: z.literal('image'), resource: imageRefSchema, fit: z.enum(['cover', 'contain']), role: z.enum(['background', 'graphic']).optional() }).strict();
const rectLayerSchema = z.object({ ...bounds, type: z.literal('rect'), color: colorSchema }).strict();
export const layerSchema = z.discriminatedUnion('type', [textLayerSchema, imageLayerSchema, rectLayerSchema]);
export const TEMPLATE_CATALOG = [
  { id: 'editorial', label: 'Редакційний', description: 'Виразний заголовок і спокійне біле поле' },
  { id: 'statement', label: 'Контрастна фраза', description: 'Великий текст на кольоровому тлі' },
  { id: 'photo-caption', label: 'Фото й підпис', description: 'Власне фото з окремим текстовим полем' },
  { id: 'fact', label: 'Картка факту', description: 'Чіткий акцент і простір для висновку' },
] as const;
export const frameSchema = z.object({ id: z.uuid(), sourceFrameId: z.uuid().nullable(), purpose: z.string().max(500), templateId: z.enum(['editorial', 'statement', 'photo-caption', 'fact']), background: colorSchema, layers: z.array(layerSchema).min(1).max(12) }).strict();
export const compositionSchema = z.object({ schemaVersion: z.literal('visual-v1'), rendererVersion: z.literal(RENDERER_VERSION), width: z.literal(1080), height: z.union([z.literal(1080), z.literal(1350), z.literal(1920)]), frames: z.array(frameSchema).min(1).max(30) }).strict().superRefine((composition, context) => {
  const ids = new Set<string>();
  let textLength = 0;
  for (const frame of composition.frames) {
    if (ids.has(frame.id)) context.addIssue({ code: 'custom', message: 'Duplicate frame ID' });
    ids.add(frame.id);
    const layers = new Set<string>();
    for (const layer of frame.layers) {
      if (layers.has(layer.id) || layer.x + layer.width > composition.width || layer.y + layer.height > composition.height) context.addIssue({ code: 'custom', message: 'Invalid layer geometry or ID' });
      layers.add(layer.id);
      if (layer.type === 'text') {
        textLength += layer.text.length;
        for (const mapping of layer.mappings) if (mapping.startOffset >= mapping.endOffset || layer.text.slice(mapping.startOffset, mapping.endOffset) !== mapping.quote) context.addIssue({ code: 'custom', message: 'Invalid evidence mapping' });
      }
    }
  }
  if (textLength > 30000) context.addIssue({ code: 'custom', message: 'Composition text limit exceeded' });
});
export type VisualComposition = z.infer<typeof compositionSchema>;
export type VisualFrame = z.infer<typeof frameSchema>;
export type VisualTextLayer = z.infer<typeof textLayerSchema>;
export type VisualLayer = z.infer<typeof layerSchema>;
export interface VisualDefaults { background: string; text: string; accent: string; font: VisualTextLayer['font']; logo: ImageRef | null }
export const DEFAULT_VISUAL_STYLE: VisualDefaults = { background: '#ffffff', text: '#20262b', accent: '#343a40', font: 'onest', logo: null };
export function makeFrame(input: { id: string; text: string; purpose: string; mappings?: VisualTextLayer['mappings'] }, height: VisualComposition['height'], templateId: VisualFrame['templateId'], style: VisualDefaults): VisualFrame {
  const top = templateId === 'photo-caption' ? Math.round(height * .66) : 110;
  const text: VisualTextLayer = { id: crypto.randomUUID(), type: 'text', x: 84, y: top, width: 912, height: height - top - 110, text: input.text, font: style.font, fontSize: templateId === 'statement' ? 72 : 56, fontWeight: '600', color: style.text, align: 'left', lineHeight: 1.2, mappings: JSON.parse(JSON.stringify(input.mappings ?? [])) as VisualTextLayer['mappings'] };
  const layers: VisualLayer[] = [];
  if (templateId === 'editorial' || templateId === 'fact') layers.push({ id: crypto.randomUUID(), type: 'rect', x: 84, y: 64, width: templateId === 'fact' ? 360 : 120, height: 16, color: style.accent });
  layers.push(text);
  if (style.logo) layers.push({ id: crypto.randomUUID(), type: 'image', x: 876, y: height - 88, width: 120, height: 48, resource: style.logo, fit: 'contain' });
  return { id: input.id, sourceFrameId: input.id, purpose: input.purpose, templateId, background: style.background, layers };
}
export function imageRefs(composition: VisualComposition): ImageRef[] {
  return composition.frames.flatMap(frame => frame.layers.flatMap(layer => layer.type === 'image' ? [layer.resource] : []));
}

/** The same function runs in the Vue editor and isolated server Chromium. Never deserialize Konva nodes. */
export async function renderVisualStage(K: typeof KonvaType, container: HTMLDivElement, composition: VisualComposition, frameId: string, resolveImage: (ref: ImageRef) => Promise<string>) {
  const frame = composition.frames.find(item => item.id === frameId);
  if (!frame) throw new Error('Frame not found');
  K.pixelRatio = 1;
  const stage = new K.Stage({ container, width: composition.width, height: composition.height });
  const canvas = new K.Layer();
  stage.add(canvas);
  canvas.add(new K.Rect({ x: 0, y: 0, width: composition.width, height: composition.height, fill: frame.background, listening: false }));
  const overflow: string[] = [];
  try {
    for (const layer of frame.layers) {
      if (layer.type === 'rect') canvas.add(new K.Rect({ ...layer, fill: layer.color, name: layer.id, listening: false }));
      if (layer.type === 'text') {
        const family = FONT_CATALOG.find(font => font.id === layer.font)!.family;
        await document.fonts.load(`${layer.fontWeight} ${layer.fontSize}px "${family}"`);
        const attrs = { ...layer, fontFamily: family, fontStyle: layer.fontWeight, fill: layer.color, wrap: 'word', padding: 0, name: layer.id };
        const probeAttrs: KonvaType.TextConfig = { ...attrs };
        delete probeAttrs.height;
        const probe = new K.Text(probeAttrs);
        if (probe.height() > layer.height) overflow.push(layer.id);
        probe.destroy();
        canvas.add(new K.Text(attrs));
      }
      if (layer.type === 'image') {
        const url = await resolveImage(layer.resource);
        const img = await new Promise<HTMLImageElement>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Image unavailable')); image.src = url; });
        const factor = layer.fit === 'cover' ? Math.max(layer.width / img.width, layer.height / img.height) : Math.min(layer.width / img.width, layer.height / img.height);
        const group = new K.Group({ x: layer.x, y: layer.y, clipX: 0, clipY: 0, clipWidth: layer.width, clipHeight: layer.height, name: layer.id });
        group.add(new K.Image({ image: img, x: (layer.width - img.width * factor) / 2, y: (layer.height - img.height * factor) / 2, width: img.width * factor, height: img.height * factor }));
        canvas.add(group);
      }
    }
    canvas.draw();
    return { stage, overflow };
  } catch (error) { stage.destroy(); throw error; }
}
