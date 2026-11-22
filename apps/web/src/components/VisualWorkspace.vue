<script setup lang="ts">
import Konva from 'konva'
import VisualBackgroundPanel from './VisualBackgroundPanel.vue'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  DEFAULT_VISUAL_STYLE, FONT_CATALOG, TEMPLATE_CATALOG, makeFrame, renderVisualStage,
  type ImageRef, type VisualComposition, type VisualFrame, type VisualLayer, type VisualTextLayer,
} from '@contextflow/visuals'
import type { Stage } from 'konva/lib/Stage'

type Format = 'LINKEDIN_COVER' | 'INSTAGRAM_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES'
interface Parent { kind: 'ADAPTATION' | 'SCRIPT'; id: string; sha256: string; reviewCounter: number; content: unknown; staleReasons: string[]; blockingReasons: string[]; eligible: boolean }
interface VisualPreview { frameId: string; assetId: string; sha256: string; overflow: string[] }
interface Revision { id: string; number: number; content: VisualComposition; sha256: string; parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number; reviewCounter?: number; approvedBy?: string | null; approvedAt?: string | null; withdrawnBy?: string | null; withdrawnAt?: string | null; eligible?: boolean; staleReasons: string[]; blockingReasons: string[]; hasUnmapped?: boolean; previews?: VisualPreview[] }
interface Draft { counter: number; content: VisualComposition; sha256: string; parentKind: string; parentRevisionId: string; parentRevisionHash: string; parentReviewCounter: number; workspaceStyleRevision?: number }
interface State { format: Format; formatSelected: boolean; style: { revision: number; revisionId: string; defaults: { background: string; text: string; accent: string; font: VisualTextLayer['font']; logo: ImageRef | null } }; parent: Parent | null; composition: { id: string; revision: number; currentApprovedRevisionId?: string | null; draft: Draft | null; revisions: Revision[] } | null }
interface Props { projectId: string; workspaceId: string; userId: string; csrfToken: string; format: Format; formats: Format[]; archived?: boolean }
const props = defineProps<Props>()
const emit = defineEmits<{ 'session-expired': []; dirty: [value: boolean]; 'format-change': [value: Format]; 'open-source': [] }>()

const state = ref<State | null>(null)
const composition = ref<VisualComposition | null>(null)
const appliedStyleRevision = ref(0)
const pendingStyleRevision = ref<number | null>(null)
const baseline = ref('')
const selectedIndex = ref(0)
const selectedLayerId = ref('')
const stageHost = ref<HTMLDivElement | null>(null)
const stageWrap = ref<HTMLDivElement | null>(null)
const stage = ref<Stage | null>(null)
const overflow = ref<string[]>([])
const serverPreviewUrl = ref('')
const renderObjectUrls = new Map<number, string[]>()
const loading = ref(true)
const saving = ref(false)
const checkpointing = ref(false)
const previewing = ref(false)
const reviewing = ref(false)
const rebasing = ref(false)
const acknowledgeUnmapped = ref(false)
const uploading = ref(false)
const conflict = ref(false)
const error = ref('')
const renderError = ref('')
const notice = ref('')
const brandStyle = ref({ ...DEFAULT_VISUAL_STYLE })
let controller = new AbortController()
let epoch = 0
let autosave: ReturnType<typeof setTimeout> | undefined
let disposed = false
let hydrating = false
let renderVersion = 0
let activeRenderVersion = 0
let resizeObserver: ResizeObserver | null = null
const recoveryKey = computed(() => `cf:visual:${props.userId}:${props.projectId}:${props.format}`)
const dirty = computed(() => !!composition.value && serializeDraft() !== baseline.value)
const readOnly = computed(() => props.archived || !state.value?.formatSelected)
const frame = computed(() => composition.value?.frames[selectedIndex.value] ?? null)
const latestRevision = computed(() => state.value?.composition?.revisions[0] ?? null)
const revisionHasUnmapped = computed(() => !!latestRevision.value?.hasUnmapped)
const latestMatchesDraft = computed(() => !!latestRevision.value && !!state.value?.composition?.draft && latestRevision.value.sha256 === state.value.composition.draft.sha256)
const latestIsApproved = computed(() => {
  const revision = latestRevision.value
  return !!revision && state.value?.composition?.currentApprovedRevisionId === revision.id && !!revision.approvedBy && !revision.withdrawnBy && latestMatchesDraft.value
})
const approvedAndClean = computed(() => latestIsApproved.value && !dirty.value)
const canApproveVisual = computed(() => {
  const revision = latestRevision.value
  const parent = state.value?.parent
  return !!revision && latestMatchesDraft.value && !dirty.value && revision.eligible === true && !revision.staleReasons.length && !revision.blockingReasons.length
    && !!parent?.eligible && revision.parentRevisionId === parent.id && revision.parentRevisionHash === parent.sha256 && revision.parentReviewCounter === parent.reviewCounter
    && (!revision.hasUnmapped || acknowledgeUnmapped.value)
})
const canRefreshParent = computed(() => {
  const revision = latestRevision.value
  const parent = state.value?.parent
  return !!revision && !!parent?.eligible && (revision.parentRevisionId !== parent.id || revision.parentRevisionHash !== parent.sha256 || revision.parentReviewCounter !== parent.reviewCounter)
})
const selectedLayer = computed(() => frame.value?.layers.find(layer => layer.id === selectedLayerId.value) ?? null)
const selectedText = computed(() => selectedLayer.value?.type === 'text' ? selectedLayer.value : null)
const compositionStatus = computed(() => {
  if (approvedAndClean.value) return latestRevision.value?.eligible && state.value?.parent?.eligible
    ? `Погоджено · версія ${latestRevision.value.number}`
    : `Версія ${latestRevision.value?.number} · потребує перегляду`
  return state.value?.composition?.draft ? 'Чернетка' : state.value?.composition ? `Версія ${state.value.composition.revision}` : 'Ще не створено'
})
const canvasStyle = computed(() => composition.value ? { aspectRatio: `1080 / ${composition.value.height}` } : {})

function serializeDraft() { return composition.value ? JSON.stringify({ composition: composition.value, workspaceStyleRevision: appliedStyleRevision.value }) : '' }
function publishDirty() { emit('dirty', dirty.value) }
function fitStage() {
  const currentStage = stage.value
  const wrap = stageWrap.value
  const host = stageHost.value
  const currentComposition = composition.value
  if (!currentStage || !wrap || !host || !currentComposition) return
  const width = wrap.clientWidth
  if (width <= 0) return
  const maxHeight = window.innerHeight * (window.innerWidth <= 600 ? 0.72 : 0.78)
  const scale = Math.min(width / currentComposition.width, maxHeight / currentComposition.height)
  if (!Number.isFinite(scale) || scale <= 0) return
  const fittedWidth = currentComposition.width * scale
  const fittedHeight = currentComposition.height * scale
  host.style.width = `${fittedWidth}px`
  host.style.height = `${fittedHeight}px`
  wrap.style.height = `${fittedHeight}px`
  currentStage.size({ width: fittedWidth, height: fittedHeight })
  currentStage.scale({ x: scale, y: scale })
  currentStage.draw()
}
function keepRecovery() {
  if (!dirty.value || hydrating || disposed || !state.value?.composition) return
  try { sessionStorage.setItem(recoveryKey.value, JSON.stringify({ composition: composition.value, workspaceStyleRevision: appliedStyleRevision.value, applyWorkspaceStyle: pendingStyleRevision.value !== null, revision: state.value.composition.revision, draftCounter: state.value.composition.draft?.counter ?? 0 })) } catch { /* The open editor still holds its current content. */ }
}
function apiUrl(path = '', query: Record<string, string> = {}) { const params = new URLSearchParams({ format: props.format, ...query }); return `/api/v1/projects/${encodeURIComponent(props.projectId)}/visuals${path}?${params}` }
async function request(path = '', body?: unknown, query: Record<string, string> = {}) {
  const requestEpoch = epoch
  const requestIdentity = `${props.projectId}:${props.format}`
  const response = await fetch(apiUrl(path, query), { credentials: 'same-origin', signal: controller.signal, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) }) })
  if (requestEpoch !== epoch || requestIdentity !== `${props.projectId}:${props.format}` || disposed) throw new Error('Редактор уже відкритий для іншого формату або проєкту.')
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено. Увійдіть знову.') }
  if (!response.ok) {
    if (response.status === 409 && requestEpoch === epoch) conflict.value = true
    throw new Error(response.status === 409 ? 'Версію змінив інший учасник. Ваші правки залишилися у цьому вікні.' : response.status === 404 ? 'Сценарій або проєкт недоступний.' : 'Не вдалося виконати дію. Перевірте з’єднання та повторіть спробу.')
  }
  if (response.status === 204) return null
  const result = await response.json()
  if (requestEpoch !== epoch || requestIdentity !== `${props.projectId}:${props.format}` || disposed) throw new Error('Редактор уже відкритий для іншого формату або проєкту.')
  return result
}
function install(next: State) {
  hydrating = true
  state.value = next
  composition.value = structuredClone(next.composition?.draft?.content ?? next.composition?.revisions[0]?.content ?? null)
  appliedStyleRevision.value = next.composition?.draft?.workspaceStyleRevision ?? next.style.revision
  pendingStyleRevision.value = null
  brandStyle.value = { ...next.style.defaults }
  baseline.value = serializeDraft()
  selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, (composition.value?.frames.length ?? 1) - 1))
  selectedLayerId.value = frame.value?.layers.find(layer => layer.type === 'text')?.id ?? frame.value?.layers[0]?.id ?? ''
  conflict.value = false
  overflow.value = []
  hydrating = false
  publishDirty()
}
function acceptSavedState(next: State, dispatchedSnapshot: string, dispatchedStyleRevision: number) {
  const serverComposition = next.composition?.draft?.content ?? next.composition?.revisions[0]?.content ?? null
  const serverStyleRevision = next.composition?.draft?.workspaceStyleRevision ?? dispatchedStyleRevision
  if (serializeDraft() === dispatchedSnapshot) {
    install(next)
    sessionStorage.removeItem(recoveryKey.value)
    return
  }
  state.value = next
  brandStyle.value = { ...next.style.defaults }
  baseline.value = serverComposition ? JSON.stringify({ composition: serverComposition, workspaceStyleRevision: serverStyleRevision }) : ''
  if (pendingStyleRevision.value === serverStyleRevision) pendingStyleRevision.value = null
  keepRecovery()
  publishDirty()
  clearTimeout(autosave)
  if (!readOnly.value && !conflict.value) autosave = setTimeout(() => void saveDraft(), 500)
}
async function load(reconcileLocal = true) {
  const requestEpoch = epoch
  loading.value = true; error.value = ''; notice.value = ''
  try {
    const next = await request() as State
    if (disposed || requestEpoch !== epoch) return
    install(next)
    if (reconcileLocal && next.composition) {
      const raw = sessionStorage.getItem(recoveryKey.value)
      if (raw) try {
        const local = JSON.parse(raw) as { composition: VisualComposition; workspaceStyleRevision?: number; applyWorkspaceStyle?: boolean; revision: number; draftCounter: number }
        if (local.revision === next.composition.revision && (JSON.stringify({ composition: local.composition, workspaceStyleRevision: local.workspaceStyleRevision ?? appliedStyleRevision.value }) !== baseline.value)) {
          composition.value = local.composition
          appliedStyleRevision.value = local.workspaceStyleRevision ?? appliedStyleRevision.value
          pendingStyleRevision.value = local.applyWorkspaceStyle ? appliedStyleRevision.value : null
          notice.value = 'Відновлено локальні правки. Збережіть їх у чернетку.'
          publishDirty()
        }
      } catch { notice.value = 'Локальні правки не вдалося прочитати; серверна версія доступна.' }
    }
  } catch (cause) { if (!disposed && requestEpoch === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити візуал.' }
  finally { if (requestEpoch === epoch) loading.value = false }
}
function changed() {
  if (hydrating || disposed) return
  serverPreviewUrl.value = ''
  publishDirty(); keepRecovery(); clearTimeout(autosave)
  if (!conflict.value && !readOnly.value) autosave = setTimeout(() => void saveDraft(), 650)
}
async function saveDraft(): Promise<boolean> {
  if (!dirty.value || !state.value?.composition || !composition.value || saving.value || checkpointing.value || readOnly.value || conflict.value) return !dirty.value
  clearTimeout(autosave); saving.value = true; error.value = ''
  const ownEpoch = epoch
  const ownIdentity = `${props.projectId}:${props.format}`
  const dispatchedComposition = JSON.parse(JSON.stringify(composition.value)) as VisualComposition
  const dispatchedStyleRevision = appliedStyleRevision.value
  const dispatchedSnapshot = serializeDraft()
  try {
    const next = await request('/draft', { expectedRevision: state.value.composition.revision, expectedDraftCounter: state.value.composition.draft?.counter ?? 0, composition: dispatchedComposition, ...(pendingStyleRevision.value === null ? {} : { workspaceStyleRevision: pendingStyleRevision.value }) }) as State
    if (disposed || ownEpoch !== epoch || ownIdentity !== `${props.projectId}:${props.format}`) return false
    acceptSavedState(next, dispatchedSnapshot, dispatchedStyleRevision)
    notice.value = serializeDraft() === dispatchedSnapshot ? 'Чернетку збережено.' : 'Чернетку збережено. Нові правки залишилися у редакторі.'
    return true
  } catch (cause) { if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) error.value = cause instanceof Error ? cause.message : 'Чернетку не збережено.' }
  finally { if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) saving.value = false; publishDirty() }
  return false
}
async function createComposition() {
  const parent = state.value?.parent
  if (!parent?.eligible || readOnly.value || saving.value) return
  saving.value = true; error.value = ''
  try { const next = await request('/initialize', { parentRevisionId: parent.id }) as State; install(next); notice.value = 'Візуальну чернетку створено зі схваленого матеріалу.' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося створити візуал.' }
  finally { saving.value = false }
}
async function saveCheckpoint() {
  if (dirty.value && !await saveDraft()) return
  if (dirty.value || !state.value?.composition || saving.value || conflict.value || readOnly.value) return
  checkpointing.value = true; error.value = ''
  const ownEpoch = epoch
  const ownIdentity = `${props.projectId}:${props.format}`
  const dispatchedStyleRevision = appliedStyleRevision.value
  const dispatchedSnapshot = serializeDraft()
  try {
    const next = await request('/checkpoint', { expectedRevision: state.value.composition.revision, expectedDraftCounter: state.value.composition.draft?.counter ?? 0 }) as State
    if (disposed || ownEpoch !== epoch || ownIdentity !== `${props.projectId}:${props.format}`) return
    acceptSavedState(next, dispatchedSnapshot, dispatchedStyleRevision)
    notice.value = serializeDraft() === dispatchedSnapshot ? 'Контрольну версію композиції збережено.' : 'Версію збережено. Нові правки залишилися у редакторі.'
  } catch (cause) { if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти контрольну версію.' }
  finally {
    if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) checkpointing.value = false
    if (dirty.value && !readOnly.value && !conflict.value) { clearTimeout(autosave); autosave = setTimeout(() => void saveDraft(), 500) }
  }
}
function selectFrame(index: number) {
  if (!composition.value || index < 0 || index >= composition.value.frames.length) return
  selectedIndex.value = index
  selectedLayerId.value = composition.value.frames[index]!.layers.find(layer => layer.type === 'text')?.id ?? composition.value.frames[index]!.layers[0]?.id ?? ''
}
function setTemplate(templateId: VisualFrame['templateId']) {
  if (!composition.value || !frame.value) return
  const old = frame.value
  const textLayer = old.layers.find(layer => layer.type === 'text') as VisualTextLayer | undefined
  const replacement = makeFrame({ id: old.id, text: textLayer?.text ?? '', purpose: old.purpose, ...(textLayer ? { mappings: textLayer.mappings,...(textLayer.sourceMappings ? { sourceMappings: textLayer.sourceMappings } : {}) } : {}) }, composition.value.height, templateId, brandStyle.value)
  replacement.sourceFrameId = old.sourceFrameId
  const preservedLayers = old.layers.filter(layer => layer.id !== textLayer?.id)
  const newPrimaryText = replacement.layers.find(layer => layer.type === 'text')
  const generatedAccents = replacement.layers.filter(layer => layer.type === 'rect')
  const generatedLogo = replacement.layers.find(layer => layer.type === 'image')
  const replacementText = replacement.layers.find(layer => layer.type === 'text')
  if (replacementText?.type === 'text' && textLayer) {
    replacementText.font = textLayer.font
    replacementText.fontSize = textLayer.fontSize
    replacementText.fontWeight = textLayer.fontWeight
    replacementText.color = textLayer.color
    replacementText.align = textLayer.align
    replacementText.lineHeight = textLayer.lineHeight
  }
  replacement.background = old.background
  const existingImageIds = new Set(preservedLayers.filter(layer => layer.type === 'image').map(layer => layer.type === 'image' ? layer.resource.id : ''))
  replacement.layers = [
    ...preservedLayers,
    ...(preservedLayers.some(layer => layer.type === 'rect') ? [] : generatedAccents),
    ...(generatedLogo?.type === 'image' && !existingImageIds.has(generatedLogo.resource.id) ? [generatedLogo] : []),
    ...(newPrimaryText ? [newPrimaryText] : []),
  ]
  composition.value.frames[selectedIndex.value] = replacement
  selectedLayerId.value = replacement.layers.find(layer => layer.type === 'text')?.id ?? ''
  changed()
}
function resizeComposition(height: number) {
  if (!composition.value || ![1080, 1350, 1920].includes(height)) return
  const previous = composition.value.height
  if (height === previous) return
  const scale = height / previous
  for (const item of composition.value.frames) {
    for (const layer of item.layers) {
      layer.y = Math.max(0, Math.min(height - 16, Math.round(layer.y * scale)))
      layer.height = Math.max(16, Math.min(height - layer.y, Math.round(layer.height * scale)))
    }
  }
  composition.value.height = height as VisualComposition['height']
  changed()
}
function applyWorkspaceStyle() {
  if (!composition.value || !frame.value) return
  const revision = state.value?.style.revision
  if (revision !== undefined) {
    appliedStyleRevision.value = revision
    pendingStyleRevision.value = revision === (state.value?.composition?.draft?.workspaceStyleRevision ?? revision) ? null : revision
  }
  frame.value.background = brandStyle.value.background
  for (const layer of frame.value.layers) {
    if (layer.type === 'text') { layer.color = brandStyle.value.text; layer.font = brandStyle.value.font }
    if (layer.type === 'rect') layer.color = brandStyle.value.accent
  }
  if (state.value?.style.defaults.logo) addLogo()
  changed()
}
function updateText(patch: Partial<VisualTextLayer>) {
  if (!selectedText.value) return
  Object.assign(selectedText.value, patch); changed()
}
function editText(value: string) {
  const layer = selectedText.value
  if (!layer) return
  const old = layer.text
  let prefix = 0
  while (prefix < old.length && prefix < value.length && old[prefix] === value[prefix]) prefix++
  let suffix = 0
  while (suffix < old.length - prefix && suffix < value.length - prefix && old[old.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++
  const changedEnd = old.length - suffix
  const delta = value.length - old.length
  layer.text = value
  if (layer.sourceMappings) layer.sourceMappings = layer.sourceMappings.flatMap(map => map.endOffset <= prefix ? [map] : map.startOffset >= changedEnd ? [{ ...map,startOffset: map.startOffset+delta,endOffset: map.endOffset+delta }] : [])
  layer.mappings = layer.mappings.flatMap(mapping => {
    if (mapping.endOffset <= prefix) return value.slice(mapping.startOffset, mapping.endOffset) === mapping.quote ? [mapping] : []
    if (mapping.startOffset >= changedEnd) {
      const shifted = { ...mapping, startOffset: mapping.startOffset + delta, endOffset: mapping.endOffset + delta }
      return value.slice(shifted.startOffset, shifted.endOffset) === shifted.quote ? [shifted] : []
    }
    return []
  })
  changed()
}
function updateLayerBounds(key: 'x' | 'y' | 'width' | 'height', value: string) {
  const layer = selectedLayer.value
  if (!layer || !composition.value) return
  const max = key === 'x' || key === 'width' ? composition.value.width : composition.value.height
  const min = key === 'width' || key === 'height' ? 16 : 0
  const available = key === 'x' ? composition.value.width - layer.width : key === 'y' ? composition.value.height - layer.height : max - (key === 'width' ? layer.x : layer.y)
  ;(layer as VisualLayer)[key] = Math.max(min, Math.min(available, Math.round(Number(value) || 0)))
  changed()
}
function updateFrameColor(value: string) { if (frame.value) { frame.value.background = value; changed() } }
function updateLayerColor(value: string) {
  if (selectedText.value) updateText({ color: value })
  else if (selectedLayer.value?.type === 'rect') { selectedLayer.value.color = value; changed() }
}
async function resolveImage(ref: ImageRef, objectUrls: string[]) {
  const scope = ref.type === 'workspace' ? 'WORKSPACE' : 'PROJECT'
  const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/visuals/assets/${encodeURIComponent(ref.id)}?scope=${scope}`, { credentials: 'same-origin', signal: controller.signal })
  if (!response.ok) throw new Error('Зображення недоступне.')
  const dataUrl = await verifiedImageDataUrl(await response.blob(), ref.sha256)
  objectUrls.push(dataUrl)
  return dataUrl
}
async function verifiedImageDataUrl(blob: Blob, expectedHash: string) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  if (actual !== expectedHash) throw new Error('Контрольна сума зображення не збігається з композицією.')
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Не вдалося підготувати перевірене зображення.'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}
async function render() {
  const host = stageHost.value
  if (!host || !composition.value || !frame.value) return
  renderError.value = ''
  const ownRender = ++renderVersion
  stage.value?.destroy(); stage.value = null; overflow.value = []
  renderObjectUrls.delete(activeRenderVersion)
  activeRenderVersion = 0
  const ownUrls: string[] = []
  renderObjectUrls.set(ownRender, ownUrls)
  try {
    const result = await renderVisualStage(Konva, host, composition.value, frame.value.id, ref => resolveImage(ref, ownUrls))
    if (disposed || ownRender !== renderVersion || host !== stageHost.value) { result.stage.destroy(); renderObjectUrls.delete(ownRender); return }
    stage.value = result.stage; overflow.value = result.overflow
    activeRenderVersion = ownRender
    fitStage()
  } catch (cause) {
    renderObjectUrls.delete(ownRender)
    if (!disposed && ownRender === renderVersion) renderError.value = cause instanceof Error ? cause.message : 'Не вдалося побудувати прев’ю.'
  }
}
async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || !composition.value || !frame.value || uploading.value) return
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { error.value = 'Виберіть PNG або JPEG до 5 МБ.'; input.value = ''; return }
  uploading.value = true; error.value = ''
  try {
    const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Не вдалося прочитати файл.')); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file) })
    const result = await request('/assets', { filename: file.name, mediaType: file.type, base64 }, { scope: 'PROJECT' }) as { ref: ImageRef }
    const imageLayer: VisualLayer = { id: crypto.randomUUID(), type: 'image', resource: result.ref, x: 84, y: 84, width: 912, height: Math.min(600, composition.value.height - 260), fit: 'cover' }
    frame.value.layers.unshift(imageLayer); selectedLayerId.value = imageLayer.id; changed(); notice.value = 'Фото додано до поточного кадру.'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося додати зображення.' }
  finally { uploading.value = false; input.value = '' }
}
async function uploadWorkspaceLogo(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file || uploading.value) return
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 5 * 1024 * 1024) { error.value = 'Виберіть PNG або JPEG до 5 МБ.'; input.value = ''; return }
  uploading.value = true; error.value = ''; notice.value = ''
  try {
    const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error('Не вдалося прочитати файл.')); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.readAsDataURL(file) })
    const uploaded = await request('/assets', { filename: file.name, mediaType: file.type, base64 }, { scope: 'WORKSPACE' }) as { id: string; ref: ImageRef }
    const current = await fetch(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/style`, { credentials: 'same-origin', signal: controller.signal })
    if (!current.ok) throw new Error('Не вдалося завантажити стиль простору для збереження логотипа.')
    const payload = await current.json() as { style: { revision: number; brandbook: string; tone: string; settings: Record<string, string | number | boolean> } }
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/style`, { method: 'PATCH', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify({ expectedRevision: payload.style.revision, brandbook: payload.style.brandbook, tone: payload.style.tone, settings: { ...payload.style.settings, visualLogoId: uploaded.id } }) })
    if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
    if (!response.ok) throw new Error(response.status === 409 ? 'Стиль простору змінився. Оновіть його й спробуйте ще раз.' : 'Не вдалося зберегти логотип у стилі простору.')
    const saved = await response.json() as { style: { revision: number } }
    if (state.value) { state.value.style.revision = saved.style.revision; state.value.style.defaults.logo = uploaded.ref }
    brandStyle.value.logo = uploaded.ref
    notice.value = 'Логотип збережено у стилі простору. Його можна додати до кадру вручну.'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти логотип.' }
  finally { uploading.value = false; input.value = '' }
}
function addLogo() {
  const logo = state.value?.style.defaults.logo
  if (!logo || !frame.value || !composition.value) return
  const existing = frame.value.layers.find(layer => layer.type === 'image' && layer.resource.id === logo.id)
  if (existing) { selectedLayerId.value = existing.id; return }
  const layer: VisualLayer = { id: crypto.randomUUID(), type: 'image', resource: logo, x: 876, y: composition.value.height - 88, width: 120, height: 48, fit: 'contain' }
  frame.value.layers.push(layer); selectedLayerId.value = layer.id; changed()
}
async function checkpointPreview() {
  if (!state.value?.composition || !frame.value || dirty.value || previewing.value) return
  previewing.value = true
  const ownEpoch = epoch
  const ownIdentity = `${props.projectId}:${props.format}`
  const frameId = frame.value.id
  const compositionSnapshot = serializeDraft()
  const stillCurrent = () => !disposed && ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}` && serializeDraft() === compositionSnapshot && frame.value?.id === frameId && !dirty.value
  error.value = ''; notice.value = 'Формуємо серверне прев’ю…'
  try {
    let revision = state.value.composition.revisions[0]
    if (!revision || state.value.composition.draft?.sha256 !== revision.sha256) {
      await saveCheckpoint()
      if (!stillCurrent()) return
      revision = state.value?.composition?.revisions[0]
    }
    if (!revision) throw new Error('Збережіть контрольну версію перед прев’ю.')
    if (state.value?.composition?.draft?.sha256 !== revision.sha256) throw new Error('Спершу збережіть поточну композицію у версію.')
    const result = await request(`/revisions/${encodeURIComponent(revision.id)}/preview`, { frameId }) as { assetId: string; sha256: string; overflow: string[] }
    if (!stillCurrent()) return
    overflow.value = result.overflow
    const response = await fetch(apiUrl(`/preview/${encodeURIComponent(result.assetId)}`), { credentials: 'same-origin', signal: controller.signal })
    if (!stillCurrent()) return
    if (!response.ok) throw new Error('Серверне прев’ю не вдалося завантажити.')
    const previewBlob = await response.blob()
    if (!stillCurrent()) return
    const nextPreviewUrl = await verifiedImageDataUrl(previewBlob, result.sha256)
    if (!stillCurrent()) return
    serverPreviewUrl.value = nextPreviewUrl
    notice.value = 'Серверне прев’ю готове. Перевірте кадр у тому самому розмірі.'
  } catch (cause) { if (stillCurrent()) error.value = cause instanceof Error ? cause.message : 'Не вдалося побудувати серверне прев’ю.' }
  finally { if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) previewing.value = false }
}
async function preparePreviewsAndApprove() {
  if (reviewing.value || readOnly.value || conflict.value || !state.value?.composition) return
  reviewing.value = true
  error.value = ''; notice.value = 'Зберігаємо точну версію перед перевіркою кадрів…'
  const ownEpoch = epoch
  const ownIdentity = `${props.projectId}:${props.format}`
  let approvalDispatched = false
  try {
    clearTimeout(autosave)
    if (dirty.value && !await saveDraft()) throw new Error('Не вдалося зберегти чернетку. Перевірте з’єднання та повторіть дію.')
    if (dirty.value || conflict.value || !state.value?.composition?.draft) throw new Error('Чернетка змінилася. Збережіть її та почніть перевірку знову.')
    if (!latestMatchesDraft.value) await saveCheckpoint()
    if (disposed || ownEpoch !== epoch || ownIdentity !== `${props.projectId}:${props.format}`) return
    const owner = state.value?.composition
    const revision = owner?.revisions[0]
    const frozen = revision ? JSON.stringify(revision.content) : ''
    if (!owner?.draft || !revision || revision.sha256 !== owner.draft.sha256 || !frozen || dirty.value) throw new Error('Спершу збережіть актуальну композицію як контрольну версію.')
    const frameIds = revision.content.frames.map(item => item.id)
    if (!frameIds.length) throw new Error('У версії немає кадрів для перевірки.')
    const checkCurrent = () => !disposed && ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`
      && !dirty.value && !conflict.value && JSON.stringify(latestRevision.value?.content) === frozen
      && state.value?.composition?.draft?.sha256 === revision.sha256
    for (let index = 0; index < frameIds.length; index++) {
      if (!checkCurrent()) throw new Error('Композиція змінилася під час перевірки. Ваші правки збережені; запустіть підготовку ще раз.')
      const frameId = frameIds[index]!
      notice.value = `Перевіряємо серверне прев’ю кадру ${index + 1} із ${frameIds.length}…`
      const result = await request(`/revisions/${encodeURIComponent(revision.id)}/preview`, { frameId }) as VisualPreview
      if (!checkCurrent()) throw new Error('Композиція змінилася під час перевірки. Ваші правки збережені; запустіть підготовку ще раз.')
      if (result.overflow.length) throw new Error(`Текст не вміщується в кадрі ${index + 1}. Виправте композицію перед погодженням.`)
      const response = await fetch(apiUrl(`/preview/${encodeURIComponent(result.assetId)}`), { credentials: 'same-origin', signal: controller.signal })
      if (!checkCurrent()) throw new Error('Композиція змінилася під час перевірки. Ваші правки збережені; запустіть підготовку ще раз.')
      if (!response.ok) throw new Error(`Не вдалося завантажити серверне прев’ю кадру ${index + 1}.`)
      await verifiedImageDataUrl(await response.blob(), result.sha256)
      if (!checkCurrent()) throw new Error('Композиція змінилася під час перевірки. Ваші правки збережені; запустіть підготовку ще раз.')
    }
    if (!checkCurrent()) throw new Error('Композиція змінилася під час перевірки. Ваші правки збережені; запустіть підготовку ще раз.')
    if (frameIds.some(frameId => !revision.previews?.some(preview => preview.frameId === frameId))) {
      const refreshed = await request() as State
      const refreshedOwner = refreshed.composition
      if (!checkCurrent() || refreshedOwner?.id !== owner.id || refreshedOwner.revision !== owner.revision
        || refreshedOwner.draft?.sha256 !== revision.sha256 || refreshedOwner.revisions[0]?.id !== revision.id) {
        throw new Error('Композиція змінилася під час перевірки. Ваші правки збережені; запустіть підготовку ще раз.')
      }
      state.value = refreshed
    }
    const current = latestRevision.value
    const parent = state.value?.parent
    if (!current || current.id !== revision.id || current.eligible !== true || !parent?.eligible
      || current.parentRevisionId !== parent.id || current.parentRevisionHash !== parent.sha256 || current.parentReviewCounter !== parent.reviewCounter
      || current.staleReasons.length || current.blockingReasons.length) {
      throw new Error('Версія або її погоджене джерело потребує перегляду. Оновіть матеріал перед погодженням.')
    }
    if (current.hasUnmapped && !acknowledgeUnmapped.value) throw new Error('Підтвердьте окремо, що текст без зіставлення не підтверджений джерелами.')
    notice.value = 'Усі кадри перевірено. Надсилаємо точну версію на погодження…'
    approvalDispatched = true
    const next = await request(`/revisions/${encodeURIComponent(current.id)}/approve`, {
      expectedRevision: owner.revision,
      expectedReviewCounter: current.reviewCounter ?? current.parentReviewCounter,
      acknowledgeUnmapped: current.hasUnmapped ? true : false,
    }) as State
    if (!checkCurrent()) throw new Error('Відповідь надійшла після зміни композиції. Перевірте історію версій перед повтором.')
    install(next)
    acknowledgeUnmapped.value = false
    notice.value = `Візуальну версію ${current.number} погоджено після перевірки всіх кадрів.`
  } catch (cause) {
    if (!disposed && ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) {
      const message = cause instanceof Error ? cause.message : 'Не вдалося підготувати візуал до погодження.'
      error.value = message
      if (approvalDispatched) await refreshReviewState()
    }
  } finally { if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) reviewing.value = false }
}
async function refreshParent() {
  if (rebasing.value || readOnly.value || conflict.value || !state.value?.composition) return
  rebasing.value = true; error.value = ''; notice.value = ''
  const ownEpoch = epoch
  const ownIdentity = `${props.projectId}:${props.format}`
  try {
    clearTimeout(autosave)
    if (dirty.value && !await saveDraft()) throw new Error('Чернетку не вдалося зберегти. Локальні правки залишилися у редакторі.')
    if (dirty.value || conflict.value || !state.value?.composition?.draft) throw new Error('Спершу збережіть актуальну чернетку.')
    const owner = state.value.composition
    const dispatchedSnapshot = serializeDraft()
    const dispatchedStyleRevision = appliedStyleRevision.value
    const next = await request('/parent/refresh', { expectedRevision: owner.revision }) as State
    if (disposed || ownEpoch !== epoch || ownIdentity !== `${props.projectId}:${props.format}`) return
    acceptSavedState(next, dispatchedSnapshot, dispatchedStyleRevision)
    notice.value = serializeDraft() === dispatchedSnapshot
      ? 'Композицію перенесено на поточне погоджене джерело. Перевірте й погодьте нову версію.'
      : 'Основу оновлено. Нові локальні правки залишилися у редакторі.'
  } catch (cause) {
    if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити погоджене джерело.'
  } finally { if (ownEpoch === epoch && ownIdentity === `${props.projectId}:${props.format}`) rebasing.value = false }
}
async function refreshReviewState() {
  const local = composition.value ? structuredClone(composition.value) : null
  const localBaseline = baseline.value
  const localWasDirty = dirty.value
  try {
    const next = await request() as State
    if (localWasDirty && local) {
      state.value = next
      composition.value = local
      baseline.value = localBaseline
      keepRecovery(); publishDirty()
      if (next.composition?.currentApprovedRevisionId === latestRevision.value?.id) notice.value = 'Погодження збережено. Локальні незбережені правки залишилися у редакторі.'
      return
    }
    install(next)
    notice.value = 'Стан версій оновлено.'
  } catch { /* Keep the current editor and its recovery copy if reconciliation is unavailable. */ }
}
async function withdrawApproval(revision: Revision) {
  const owner = state.value?.composition
  if (reviewing.value || dirty.value || !owner || revision.id !== owner.currentApprovedRevisionId || !revision.approvedBy || revision.withdrawnBy) return
  reviewing.value = true; error.value = ''; notice.value = ''
  try {
    const next = await request(`/revisions/${encodeURIComponent(revision.id)}/withdraw`, {
      expectedRevision: owner.revision,
      expectedReviewCounter: revision.reviewCounter ?? revision.parentReviewCounter,
      acknowledgeUnmapped: false,
    }) as State
    if (dirty.value) throw new Error('Чернетка змінилася. Погодження відкликано; локальні правки залишилися у редакторі.')
    state.value = next
    notice.value = `Погодження версії ${revision.number} відкликано. Її вміст збережено в історії.`
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Не вдалося відкликати погодження.'
    await refreshReviewState()
  }
  finally { reviewing.value = false }
}
function reviewReason(reason: string) {
  const value = reason.toLowerCase()
  if (value.includes('overflow')) return 'Текст виходить за межі кадру.'
  if (value.includes('parent') || value.includes('source')) return 'Потрібно переглянути вихідний матеріал.'
  if (value.includes('preview') || value.includes('render')) return 'Потрібні серверні прев’ю всіх кадрів.'
  if (value.includes('unmapped') || value.includes('evidence')) return 'Є текст без зіставлення з джерелами.'
  if (value.includes('stale') || value.includes('review') || value.includes('changed')) return 'Залежності змінилися — потрібен новий перегляд.'
  return 'Версія поки не готова до погодження.'
}
function reviewDate(value: string | null | undefined) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
async function prepareBackground() {
  const target=frame.value?.id
  if (!target||readOnly.value) return null
  clearTimeout(autosave)
  if (dirty.value && !await saveDraft()) return null
  if (dirty.value||frame.value?.id!==target) return null
  if (state.value?.composition?.revisions[0]?.sha256!==state.value?.composition?.draft?.sha256) await saveCheckpoint()
  const owner=state.value?.composition,revision=owner?.revisions[0]
  if (!owner?.draft||!revision||dirty.value||revision.sha256!==owner.draft.sha256||frame.value?.id!==target) return null
  return {expectedRevision:owner.revision,expectedDraftCounter:owner.draft.counter,compositionRevisionId:revision.id,frameId:target}
}
async function applyGeneratedBackground(candidateId:string,targetFrameId:string) {
  clearTimeout(autosave)
  if (dirty.value && !await saveDraft()) return false
  const owner=state.value?.composition
  if (!owner?.draft||dirty.value||conflict.value) return false
  const dispatched=serializeDraft(),ownEpoch=epoch
  const pendingKey=`${recoveryKey.value}:background-apply:${candidateId}`
  let body: {expectedRevision:number;expectedDraftCounter:number;commandKey:string;acknowledgeBackgroundReview:true}
  const stored=sessionStorage.getItem(pendingKey)
  if (stored) body=JSON.parse(stored) as typeof body
  else {body={expectedRevision:owner.revision,expectedDraftCounter:owner.draft.counter,commandKey:crypto.randomUUID(),acknowledgeBackgroundReview:true};sessionStorage.setItem(pendingKey,JSON.stringify(body))}
  const result=await request(`/backgrounds/candidates/${candidateId}/apply`,body) as {state:State}
  if (disposed||ownEpoch!==epoch) return false
  sessionStorage.removeItem(pendingKey)
  if (serializeDraft()===dispatched) install(result.state)
  else {
    const server=result.state.composition?.draft
    for (const serverFrame of server?.content.frames.filter(row=>row.id===targetFrameId)??[]) {
      const local=composition.value?.frames.find(row=>row.id===serverFrame.id)
      const background=serverFrame.layers.find(row=>row.type==='image'&&row.role==='background')
      if (local&&background&&composition.value?.height===server?.content.height) local.layers=[JSON.parse(JSON.stringify(background)) as VisualLayer,...local.layers.filter(row=>row.type!=='image'||row.role!=='background')]
    }
    state.value=result.state
    baseline.value=JSON.stringify({composition:server?.content,workspaceStyleRevision:server?.workspaceStyleRevision??appliedStyleRevision.value})
    changed()
  }
  notice.value='Фон застосовано. Текст і власні зображення збережені.'
  return true
}
watch([composition, selectedIndex], () => { void nextTick(render) }, { deep: true })
watch(dirty, publishDirty)
onMounted(() => {
  resizeObserver = new ResizeObserver(fitStage)
  if (stageWrap.value) resizeObserver.observe(stageWrap.value)
  window.addEventListener('resize', fitStage)
  void load()
})
onBeforeUnmount(() => { disposed = true; clearTimeout(autosave); controller.abort(); resizeObserver?.disconnect(); resizeObserver = null; window.removeEventListener('resize', fitStage); renderVersion++; stage.value?.destroy(); renderObjectUrls.clear(); epoch++ })
</script>

<template>
  <section
    class="visual-workspace"
    aria-labelledby="visual-heading"
  >
    <header class="visual-heading">
      <div>
        <label
          class="visual-format-label"
          for="visual-format"
        >Формат</label><select
          id="visual-format"
          :value="format"
          @change="emit('format-change', ($event.target as HTMLSelectElement).value as Format)"
        >
          <option
            v-for="item in formats"
            :key="item"
            :value="item"
          >
            {{ item === 'INSTAGRAM_STORIES' ? 'Історії Instagram' : item === 'LINKEDIN_CAROUSEL' ? 'Карусель LinkedIn' : item === 'INSTAGRAM_CAROUSEL' ? 'Карусель Instagram' : item === 'LINKEDIN_COVER' ? 'Обкладинка LinkedIn' : 'Обкладинка Instagram' }}
          </option>
        </select><h1 id="visual-heading">
          Візуали
        </h1>
      </div>
      <div class="visual-actions">
        <span
          class="visual-status"
          role="status"
        >{{ saving ? 'Зберігаємо…' : compositionStatus }}</span><button
          type="button"
          :disabled="readOnly || saving || checkpointing || !composition"
          @click="saveCheckpoint"
        >
          Зберегти версію
        </button>
      </div>
    </header>
    <p
      v-if="loading"
      class="visual-message"
      role="status"
    >
      Завантажуємо матеріал і стиль простору…
    </p>
    <div
      v-else-if="error && !composition"
      class="visual-message visual-error"
      role="alert"
    >
      <p>{{ error }}</p><button
        type="button"
        @click="load(false)"
      >
        Повторити
      </button>
    </div>
    <section
      v-else-if="!composition"
      class="visual-empty"
      aria-labelledby="visual-empty-title"
    >
      <div>
        <h2 id="visual-empty-title">
          {{ state?.parent?.eligible ? 'Почніть із перевіреного матеріалу' : 'Немає готового джерела для композиції' }}
        </h2><p v-if="state?.parent?.eligible">
          Буде створено редагований візуал на основі {{ state.parent.kind === 'SCRIPT' ? 'сценарію' : 'обкладинки' }}. Текст не запікається у фон.
        </p><p v-else>
          Спершу потрібен актуальний погоджений сценарій або обкладинка для цього формату.
        </p>
      </div>
      <button
        v-if="state?.parent?.eligible"
        type="button"
        :disabled="readOnly || saving"
        @click="createComposition"
      >
        Створити візуал
      </button>
      <p
        v-if="state && !state.parent?.eligible"
        class="visual-error"
      >
        Спочатку погодьте актуальний текст або сценарій у вкладці «Канали».
      </p>
      <Button
        v-if="state && !state.parent?.eligible"
        class="workspace-button"
        variant="outline"
        @click="emit('open-source')"
      >
        Відкрити матеріал у каналах
      </Button>
      <p class="visual-boundary">
        Погодження й експорт відкриються після підготовки візуалу.
      </p>
    </section>
    <template v-else-if="composition && frame">
      <nav
        class="visual-frames"
        aria-label="Кадри"
      >
        <button
          v-for="(item, index) in composition.frames"
          :key="item.id"
          type="button"
          :aria-pressed="selectedIndex === index"
          @click="selectFrame(index)"
        >
          <span>Кадр {{ String(index + 1).padStart(2, '0') }}</span><small>{{ item.purpose || 'Без назви' }}</small>
        </button>
      </nav>
      <div class="visual-layout">
        <aside
          class="visual-tools"
          aria-label="Шари й вигляд"
        >
          <label for="visual-template">Макет</label><select
            id="visual-template"
            :value="frame.templateId"
            :disabled="readOnly"
            @change="setTemplate(($event.target as HTMLSelectElement).value as VisualFrame['templateId'])"
          >
            <option
              v-for="template in TEMPLATE_CATALOG"
              :key="template.id"
              :value="template.id"
            >
              {{ template.label }}
            </option>
          </select>
          <label for="visual-size">Розмір</label><select
            id="visual-size"
            :value="composition.height"
            :disabled="readOnly"
            @change="resizeComposition(Number(($event.target as HTMLSelectElement).value))"
          >
            <option :value="1080">
              Квадрат · 1080 × 1080
            </option><option :value="1350">
              Публікація · 1080 × 1350
            </option><option :value="1920">
              Історія · 1080 × 1920
            </option>
          </select>
          <div class="visual-divider" />
          <h2>Шари кадру</h2><button
            v-for="layer in frame.layers"
            :key="layer.id"
            class="layer-choice"
            :aria-pressed="selectedLayerId === layer.id"
            type="button"
            @click="selectedLayerId = layer.id"
          >
            <span>{{ layer.type === 'text' ? 'Текст' : layer.type === 'image' ? 'Зображення' : 'Акцент' }}</span><small>{{ layer.type === 'text' ? layer.text.slice(0, 30) || 'Порожній текст' : layer.type === 'image' ? 'Власний файл' : 'Форма' }}</small>
          </button>
          <label class="upload-control">Додати власне фото<input
            type="file"
            accept="image/png,image/jpeg"
            :disabled="readOnly || uploading"
            @change="uploadImage"
          ></label>
          <label class="upload-control">Зберегти лого у просторі<input
            type="file"
            accept="image/png,image/jpeg"
            :disabled="readOnly || uploading"
            @change="uploadWorkspaceLogo"
          ></label>
          <button
            v-if="state?.style.defaults.logo"
            class="text-action"
            type="button"
            :disabled="readOnly"
            @click="addLogo"
          >
            Додати лого простору в кадр
          </button>
        </aside>
        <section
          class="visual-stage-column"
          aria-label="Прев’ю кадру"
        >
          <div
            ref="stageWrap"
            class="visual-stage-wrap"
            :style="canvasStyle"
          >
            <div
              ref="stageHost"
              class="visual-stage"
            />
          </div>
          <VisualBackgroundPanel
            v-if="frame"
            :key="`${projectId}:${format}`"
            :project-id="projectId"
            :format="format"
            :frame-id="frame.id"
            :csrf-token="csrfToken"
            :disabled="!!readOnly"
            :prepare="prepareBackground"
            :apply="applyGeneratedBackground"
            @session-expired="emit('session-expired')"
          />
          <p
            v-if="renderError"
            class="visual-error"
            role="alert"
          >
            {{ renderError }}
          </p>
          <figure
            v-if="serverPreviewUrl"
            class="server-preview"
          >
            <figcaption>Рендер сервера · той самий кадр і розмір</figcaption><img
              :src="serverPreviewUrl"
              alt="Серверне прев’ю вибраного кадру"
            >
          </figure>
          <p
            v-if="overflow.length"
            class="visual-error"
            role="alert"
          >
            Текст не вміщується у вибрану область. Змініть розмір шрифту або висоту текстового шару.
          </p>
          <p class="stage-caption">
            {{ composition.width }} × {{ composition.height }} px · {{ frame.purpose || `Кадр ${selectedIndex + 1}` }}
          </p>
        </section>
        <aside
          class="visual-inspector"
          aria-label="Властивості шару"
        >
          <h2>Властивості</h2>
          <template v-if="selectedText">
            <label for="visual-copy">Текст</label><textarea
              id="visual-copy"
              :value="selectedText.text"
              :disabled="readOnly"
              rows="5"
              @input="editText(($event.target as HTMLTextAreaElement).value)"
            />
            <label for="visual-font">Шрифт</label><select
              id="visual-font"
              :value="selectedText.font"
              :disabled="readOnly"
              @change="updateText({ font: ($event.target as HTMLSelectElement).value as VisualTextLayer['font'] })"
            >
              <option
                v-for="font in FONT_CATALOG"
                :key="font.id"
                :value="font.id"
              >
                {{ font.label }}
              </option>
            </select>
            <label for="visual-font-size">Розмір шрифту</label><input
              id="visual-font-size"
              type="number"
              min="14"
              max="180"
              :value="selectedText.fontSize"
              :disabled="readOnly"
              @input="updateText({ fontSize: Math.max(14, Math.min(180, Number(($event.target as HTMLInputElement).value) || 14)) })"
            >
            <label for="visual-color">Колір тексту</label><input
              id="visual-color"
              type="color"
              :value="selectedText.color"
              :disabled="readOnly"
              @input="updateLayerColor(($event.target as HTMLInputElement).value)"
            >
            <label for="visual-align">Вирівнювання</label><select
              id="visual-align"
              :value="selectedText.align"
              :disabled="readOnly"
              @change="updateText({ align: ($event.target as HTMLSelectElement).value as VisualTextLayer['align'] })"
            >
              <option value="left">
                Ліворуч
              </option><option value="center">
                По центру
              </option><option value="right">
                Праворуч
              </option>
            </select>
          </template>
          <template v-else-if="selectedLayer">
            <p>{{ selectedLayer.type === 'image' ? 'Растрове зображення' : 'Акцентна форма' }}</p>
            <label
              v-if="selectedLayer.type === 'image'"
              for="visual-fit"
            >Масштабування</label><select
              v-if="selectedLayer.type === 'image'"
              id="visual-fit"
              v-model="selectedLayer.fit"
              :disabled="readOnly"
              @change="changed"
            >
              <option value="cover">
                Заповнити область
              </option><option value="contain">
                Вмістити цілком
              </option>
            </select>
            <label
              v-if="selectedLayer.type === 'rect'"
              for="visual-color"
            >Колір</label><input
              v-if="selectedLayer.type === 'rect'"
              id="visual-color"
              type="color"
              :value="selectedLayer.color"
              :disabled="readOnly"
              @input="updateLayerColor(($event.target as HTMLInputElement).value)"
            >
          </template>
          <fieldset
            class="visual-coordinates"
            :disabled="readOnly || !selectedLayer"
          >
            <legend>Позиція та розмір</legend><label
              v-for="key in (['x', 'y', 'width', 'height'] as const)"
              :key="key"
            >{{ key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? 'Ширина' : 'Висота' }}<input
              type="number"
              min="0"
              max="1920"
              :value="selectedLayer?.[key] ?? 0"
              @input="updateLayerBounds(key, ($event.target as HTMLInputElement).value)"
            ></label>
          </fieldset>
          <label for="visual-background">Тло кадру</label><input
            id="visual-background"
            type="color"
            :value="frame.background"
            :disabled="readOnly"
            @input="updateFrameColor(($event.target as HTMLInputElement).value)"
          >
          <button
            class="text-action"
            type="button"
            :disabled="readOnly"
            @click="applyWorkspaceStyle"
          >
            Застосувати стиль простору до кадру
          </button>
          <button
            class="text-action"
            type="button"
            :disabled="dirty || previewing || checkpointing || saving"
            @click="checkpointPreview"
          >
            {{ previewing ? 'Формуємо прев’ю…' : 'Перевірити серверне прев’ю' }}
          </button>
          <p class="visual-small">
            Зміни стилю простору не переписують поточну композицію автоматично.
          </p>
        </aside>
      </div>
    </template>
    <section
      v-if="composition && state?.composition"
      class="visual-review"
      aria-labelledby="visual-review-title"
    >
      <h2 id="visual-review-title">
        Погодження візуалу
      </h2>
      <p v-if="state.composition.currentApprovedRevisionId">
        {{ state.parent?.eligible ? 'Погоджена версія' : 'Раніше погоджена версія' }} · {{ state.composition.revisions.find(item => item.id === state?.composition?.currentApprovedRevisionId)?.number ?? '—' }}.
      </p>
      <p
        v-if="state && !state.parent?.eligible"
        role="status"
      >
        Для експорту візуалу потрібен актуальний погоджений текст або сценарій.
        <Button
          variant="outline"
          class="workspace-button"
          @click="emit('open-source')"
        >
          Відкрити матеріал у каналах
        </Button>
      </p>
      <p v-else>
        Погодження зберігається окремо від сценарію чи обкладинки й стосується лише цієї контрольної версії.
      </p>
      <p
        v-if="canRefreshParent"
        class="visual-review-reasons"
      >
        Вихідний погоджений матеріал оновився. Перенесіть композицію на його актуальну версію перед новим погодженням.
      </p>
      <button
        v-if="canRefreshParent"
        class="visual-refresh-parent"
        type="button"
        :disabled="rebasing || reviewing || readOnly || conflict"
        @click="refreshParent"
      >
        {{ rebasing ? 'Оновлюємо джерело…' : 'Оновити погоджене джерело' }}
      </button>
      <label
        v-if="revisionHasUnmapped && !latestIsApproved"
        class="visual-unmapped-ack"
      >
        <input
          v-model="acknowledgeUnmapped"
          type="checkbox"
          :disabled="reviewing || rebasing || readOnly"
        >
        Я перевірив текст без зіставлення з джерелами; він не підтверджений ними.
      </label>
      <p
        v-if="latestRevision && !canApproveVisual && !approvedAndClean"
        class="visual-review-reasons"
      >
        {{ [...latestRevision.staleReasons, ...latestRevision.blockingReasons].length
          ? [...new Set([...latestRevision.staleReasons, ...latestRevision.blockingReasons].map(reviewReason))].join(' ')
          : dirty ? 'Збережіть зміни та створіть контрольну версію.'
            : !latestMatchesDraft ? 'Остання контрольна версія має відповідати збереженій чернетці.'
              : !state?.parent?.eligible ? 'Погоджене джерело змінилося або потребує перегляду.'
                : 'Підготовка серверних прев’ю перевірить повну готовність версії.' }}
      </p>
      <button
        v-if="!approvedAndClean"
        type="button"
        :disabled="reviewing || rebasing || readOnly || !latestRevision || conflict"
        @click="preparePreviewsAndApprove"
      >
        {{ reviewing ? 'Перевіряємо й погоджуємо…' : 'Підготувати прев’ю всіх кадрів і погодити' }}
      </button>
      <p class="visual-small">
        Погодження виконається лише після збереження версії, перевірки серверного прев’ю кожного кадру та підтвердження незмінності джерела.
      </p>
      <h3>Історія версій</h3>
      <ul class="visual-review-history">
        <li
          v-for="revision in state.composition.revisions"
          :key="revision.id"
        >
          <div>
            <strong>Версія {{ revision.number }}</strong>
            <span>{{ revision.id === state?.composition?.currentApprovedRevisionId ? `Погоджено · ${reviewDate(revision.approvedAt)}` : revision.withdrawnAt ? `Погодження відкликано · ${reviewDate(revision.withdrawnAt)}` : 'Не погоджено' }}</span>
            <span v-if="revision.previews?.length">Прев’ю кадрів: {{ revision.previews.length }} із {{ revision.content.frames.length }}</span>
          </div>
          <button
            v-if="revision.id === state.composition.currentApprovedRevisionId && revision.approvedBy && !revision.withdrawnBy"
            type="button"
            :disabled="reviewing || dirty || readOnly"
            @click="withdrawApproval(revision)"
          >
            Відкликати погодження
          </button>
        </li>
      </ul>
    </section>
    <p
      v-if="error && composition"
      class="visual-message visual-error"
      role="alert"
    >
      {{ error }}
    </p><p
      v-if="notice"
      class="visual-message"
      role="status"
    >
      {{ notice }}
    </p>
  </section>
</template>

<style scoped>
@font-face { font-family: Onest; src: url('/fonts/onest.ttf') format('truetype'); font-weight:100 900; font-display:swap; }
@font-face { font-family: SourceSerif; src: url('/fonts/source-serif-4.ttf') format('truetype'); font-weight:200 900; font-display:swap; }
@font-face { font-family: Lora; src: url('/fonts/lora.ttf') format('truetype'); font-weight:100 900; font-display:swap; }
@font-face { font-family: PlexSans; src: url('/fonts/plex-sans.ttf') format('truetype'); font-weight:100 900; font-display:swap; }
@font-face { font-family: PlexMono; src: url('/fonts/plex-mono.ttf') format('truetype'); font-weight:100 900; font-display:swap; }
.visual-workspace { color: var(--ink); min-width: 0; }
.visual-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; padding: 0 0 22px; border-bottom:1px solid var(--rule); }
.visual-heading h1 { margin:5px 0 7px; font: 500 clamp(27px,3vw,38px)/1.12 var(--font-serif, 'Source Serif 4', serif); letter-spacing:-.025em; }
.visual-heading p { margin:0; color:var(--muted); font-size:14px; line-height:1.5; }
.visual-heading .visual-context { color:var(--ink); font-size:13px; }
.visual-format-label { display:block; margin-bottom:5px; color:var(--muted); font-size:12px; }.visual-heading select { max-width:280px; min-height:34px; border:1px solid var(--rule); border-radius:3px; padding:0 9px; color:var(--ink); background:white; font:13px var(--font-sans,Onest,sans-serif); }
.visual-actions { display:flex; align-items:center; gap:14px; flex-shrink:0; }
.visual-actions button,.visual-empty>button,.visual-message button { min-height:40px; padding:0 16px; border:1px solid var(--ink); border-radius:3px; background:var(--ink); color:white; font:500 13px var(--font-sans,Onest,sans-serif); cursor:pointer; }
.visual-actions button:disabled,.visual-empty>button:disabled { opacity:.48; cursor:not-allowed; }
.visual-status,.stage-caption,.visual-small { color:var(--muted); font-size:12px; }
.visual-frames { display:flex; gap:8px; overflow-x:auto; padding:14px 0; scrollbar-width:thin; }
.visual-frames button { min-width:150px; max-width:200px; padding:9px 12px; border:1px solid var(--rule); border-radius:3px; background:var(--paper); text-align:left; color:var(--ink); cursor:pointer; }
.visual-frames button[aria-pressed="true"] { border-color:var(--ink); }
.visual-frames span,.visual-frames small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.visual-frames span { font-size:12px; font-weight:600; }.visual-frames small { margin-top:4px; color:var(--muted); font-size:11px; }
.visual-layout { display:grid; grid-template-columns:minmax(160px,205px) minmax(250px,1fr) minmax(195px,245px); align-items:start; gap:22px; }
.visual-tools,.visual-inspector { display:grid; align-content:start; gap:9px; min-width:0; }
.visual-tools label,.visual-inspector>label,.visual-inspector legend { color:var(--ink); font-size:12px; font-weight:600; }
.visual-tools select,.visual-inspector select,.visual-inspector input:not([type=color]),.visual-inspector textarea { width:100%; min-width:0; border:1px solid var(--rule); border-radius:3px; padding:8px; color:var(--ink); background:white; font:13px var(--font-sans,Onest,sans-serif); }
.visual-inspector input[type=color],.visual-tools input[type=color] { width:42px; height:34px; padding:2px; border:1px solid var(--rule); background:white; }
.visual-divider { height:1px; background:var(--rule); margin:8px 0; }.visual-tools h2,.visual-inspector h2 { margin:0 0 2px; font-size:13px; font-weight:600; }
.layer-choice { display:grid; gap:3px; padding:8px 9px; border:1px solid transparent; border-radius:2px; color:var(--ink); background:transparent; text-align:left; cursor:pointer; }
.layer-choice[aria-pressed="true"] { border-color:var(--rule); background:var(--paper); }.layer-choice span { font-size:12px; font-weight:600; }.layer-choice small { overflow:hidden; color:var(--muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.upload-control { display:grid; gap:6px; margin-top:8px; }.upload-control input { width:100%; font-size:11px; }.text-action { justify-self:start; padding:4px 0; border:0; color:var(--ink); background:transparent; font:500 12px var(--font-sans,Onest,sans-serif); text-decoration:underline; text-underline-offset:3px; cursor:pointer; }.text-action:disabled { opacity:.45; cursor:not-allowed; }
.visual-stage-column { min-width:0; }.visual-stage-wrap { display:flex; align-items:center; justify-content:center; width:100%; max-height:78vh; overflow:hidden; background:#efede8; }.visual-stage { flex:0 0 auto; outline:1px solid var(--rule); background:#fff; }.visual-stage :deep(canvas) { display:block; }
.server-preview { width:min(100%,440px); margin:18px auto 0; }.server-preview figcaption { margin-bottom:8px; color:var(--muted); font-size:12px; text-align:center; }.server-preview img { display:block; width:100%; height:auto; }
.stage-caption { margin:9px 0 0; text-align:center; font-variant-numeric:tabular-nums; }
.visual-coordinates { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:7px 0; padding:10px; border:1px solid var(--rule); }.visual-coordinates legend { padding:0 4px; }.visual-coordinates label { display:grid; gap:4px; color:var(--muted); font-size:11px; }
.visual-small { margin:4px 0; line-height:1.45; }.visual-message { margin:14px 0; padding:10px 12px; background:var(--paper); color:var(--ink); font-size:13px; }.visual-error { color:#9a3025; }.visual-empty { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:18px; padding:32px 0; }.visual-empty h2 { margin:0 0 7px; font:500 24px/1.2 var(--font-serif,'Source Serif 4',serif); }.visual-empty p { max-width:58ch; margin:0; color:var(--muted); font-size:14px; line-height:1.5; }.visual-empty .visual-boundary { flex-basis:100%; font-size:12px; }
.visual-review { margin-top:34px; padding:20px 0 0; border-top:1px solid var(--ink); }.visual-review h2 { margin:0; font:500 25px/1.25 var(--font-serif,'Source Serif 4',serif); }.visual-review h3 { margin:24px 0 8px; font:500 19px/1.35 var(--font-serif,'Source Serif 4',serif); }.visual-review>p { max-width:68ch; margin:8px 0; color:var(--muted); font-size:13px; line-height:1.5; }.visual-review>button,.visual-review-history button { min-height:40px; padding:0 14px; border:1px solid var(--ink); border-radius:3px; background:var(--ink); color:white; font:500 13px var(--font-sans,Onest,sans-serif); cursor:pointer; }.visual-review>button:disabled,.visual-review-history button:disabled { opacity:.48; cursor:not-allowed; }.visual-review .visual-review-reasons { color:var(--review,#7d4700); }.visual-unmapped-ack { display:flex; align-items:flex-start; gap:9px; max-width:68ch; margin:14px 0; color:var(--ink); font-size:13px; line-height:1.5; cursor:pointer; }.visual-unmapped-ack input { flex:none; width:17px; height:17px; margin:1px 0 0; accent-color:var(--graphite,#343a40); }.visual-review-history { margin:0; padding:0; list-style:none; border-top:1px solid var(--rule); }.visual-review-history li { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:12px 0; border-bottom:1px solid var(--rule); }.visual-review-history li>div { display:grid; gap:3px; min-width:0; font-size:12px; overflow-wrap:anywhere; }.visual-review-history li>div span { color:var(--muted); }
.visual-review>.visual-refresh-parent { margin:4px 0 10px; background:transparent; color:var(--ink); }
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--copper); outline-offset:2px; }
@media(max-width:900px) { .visual-layout { grid-template-columns:minmax(145px,180px) minmax(220px,1fr); gap:18px; }.visual-inspector { grid-column:2; grid-row:2; grid-template-columns:1fr 1fr; }.visual-inspector h2,.visual-inspector fieldset,.visual-inspector .text-action,.visual-inspector .visual-small { grid-column:1/-1; } }
@media(max-width:600px) { .visual-heading { display:grid; align-items:start; }.visual-actions { justify-content:space-between; }.visual-layout { grid-template-columns:1fr; }.visual-stage-column { grid-row:1; }.visual-tools { grid-template-columns:1fr 1fr; }.visual-tools h2,.visual-tools .visual-divider,.visual-tools .layer-choice,.visual-tools .upload-control,.visual-tools .text-action { grid-column:1/-1; }.visual-inspector { grid-column:auto; grid-row:auto; grid-template-columns:1fr 1fr; }.visual-stage-wrap { max-height:72vh; }.visual-empty { align-items:flex-start; }.visual-review-history li { align-items:flex-start; flex-direction:column; }.visual-review>button { width:100%; } }
</style>
