<script setup lang="ts">
import Konva from 'konva'
import {
  ArrowDown, ArrowUp, Copy, Eye, EyeOff, Group, Lock, Plus,
  Redo2, Trash2, Undo2, Ungroup, Unlock,
} from '@lucide/vue'
import { snapBounds } from './visual-editor-geometry'
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
const addLayerMenu = ref<HTMLDetailsElement | null>(null)
function closeAddLayerMenu() {
  if (addLayerMenu.value) addLayerMenu.value.open = false
}
function addLayerFromMenu(kind: 'text' | 'shape') {
  if (kind === 'text') addTextLayer()
  else addShapeLayer()
  closeAddLayerMenu()
}
function dismissAddLayerMenu(event: PointerEvent) {
  if (event.target instanceof Node && !addLayerMenu.value?.contains(event.target)) closeAddLayerMenu()
}
const selectedLayerIds = ref<string[]>([])
const zoomMode = ref<'fit' | number>('fit')
const currentZoom = ref(100)
const snapEnabled = ref(true)
const canDuplicateFrame = computed(() => !!composition.value && composition.value.frames.length < 30 && ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'].includes(props.format))
function setZoom(value: 'fit' | number) { zoomMode.value = value; fitStage() }
function adjustZoom(direction: -1 | 1) {
  const levels = [25, 50, 75, 100, 125, 150, 200]
  const current = currentZoom.value
  setZoom(direction > 0 ? levels.find(value => value > current) ?? 200 : [...levels].reverse().find(value => value < current) ?? 25)
}
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
let historySnapshot = ''
let dragInProgress = false
const canUndo = computed(() => !readOnly.value && undoStack.value.length > 0)
const canRedo = computed(() => !readOnly.value && redoStack.value.length > 0)
function snapshot() { return composition.value ? JSON.stringify({ composition: composition.value, styleRevision: appliedStyleRevision.value, pendingStyleRevision: pendingStyleRevision.value }) : '' }
function rememberCurrent() { historySnapshot = snapshot() }
function restoreSnapshot(value: string) {
  const restored = JSON.parse(value) as { composition: VisualComposition; styleRevision: number; pendingStyleRevision: number | null }
  composition.value = restored.composition
  appliedStyleRevision.value = restored.styleRevision
  pendingStyleRevision.value = restored.pendingStyleRevision
  selectedIndex.value = Math.min(selectedIndex.value, restored.composition.frames.length - 1)
  if (!frame.value?.layers.some(item => item.id === selectedLayerId.value)) selectedLayerId.value = frame.value?.layers[0]?.id ?? ''
  selectedLayerIds.value = selectedLayerId.value ? [selectedLayerId.value] : []
  rememberCurrent()
  changed()
}
function undo() {
  if (!canUndo.value) return
  const previous = undoStack.value.pop()
  if (!previous) return
  redoStack.value.push(snapshot())
  restoreSnapshot(previous)
}
function redo() {
  if (!canRedo.value) return
  const next = redoStack.value.pop()
  if (!next) return
  undoStack.value.push(snapshot())
  restoreSnapshot(next)
}
function editorKeydown(event: KeyboardEvent) {
  if (readOnly.value || event.altKey) return
  const target = event.target as HTMLElement
  const editing = !!target.closest('input,textarea,select,[contenteditable]')
  if ((event.ctrlKey || event.metaKey) && !editing && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo(); else undo()
    return
  }
  if ((event.ctrlKey || event.metaKey) && !editing && event.key.toLowerCase() === 'y') {
    event.preventDefault(); redo(); return
  }
  if (editing || event.ctrlKey || event.metaKey || !selectedLayer.value || !composition.value) return
  const steps: Record<string, [number,number]> = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }
  const direction = steps[event.key]
  if (!direction) return
  event.preventDefault()
  const distance = event.shiftKey ? 10 : 1
  const layer = selectedLayer.value
  const members = movableGroup(layer)
  if (members.some(item => item.locked)) return
  const minX = Math.min(...members.map(item => item.x))
  const minY = Math.min(...members.map(item => item.y))
  const maxX = Math.max(...members.map(item => item.x + item.width))
  const maxY = Math.max(...members.map(item => item.y + item.height))
  const dx = Math.max(-minX, Math.min(composition.value.width - maxX, direction[0] * distance))
  const dy = Math.max(-minY, Math.min(composition.value.height - maxY, direction[1] * distance))
  if (dx || dy) { members.forEach(item => { item.x += dx; item.y += dy }); changed() }
}
const stageHost = ref<HTMLDivElement | null>(null)
const stageWrap = ref<HTMLDivElement | null>(null)
const stage = ref<Stage | null>(null)
let editorTransformer: Konva.Transformer | null = null
let verticalGuide: Konva.Line | null = null
let horizontalGuide: Konva.Line | null = null
let dragOrigins: Map<string, {x: number; y: number}> | null = null
let dragBox: { x: number; y: number; width: number; height: number } | null = null
const overflow = ref<string[]>([])
const serverPreviewUrl = ref('')
const renderObjectUrls = new Map<number, string[]>()
const loading = ref(true)
const saving = ref(false)
const checkpointing = ref(false)
const previewing = ref(false)
const reviewing = ref(false)
const rebasing = ref(false)
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
  const fitScale = Math.min(width / currentComposition.width, maxHeight / currentComposition.height)
  const scale = zoomMode.value === 'fit' ? fitScale : zoomMode.value / 100
  if (!Number.isFinite(scale) || scale <= 0) return
  const fittedWidth = currentComposition.width * scale
  const fittedHeight = currentComposition.height * scale
  currentZoom.value = Math.round(scale * 100)
  host.style.width = `${fittedWidth}px`
  host.style.height = `${fittedHeight}px`
  wrap.style.height = `${Math.min(fittedHeight, maxHeight)}px`
  currentStage.size({ width: fittedWidth, height: fittedHeight })
  currentStage.scale({ x: scale, y: scale })
  currentStage.batchDraw()
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
function install(next: State, resetHistory = true) {
  hydrating = true
  state.value = next
  composition.value = structuredClone(next.composition?.draft?.content ?? next.composition?.revisions[0]?.content ?? null)
  appliedStyleRevision.value = next.composition?.draft?.workspaceStyleRevision ?? next.style.revision
  pendingStyleRevision.value = null
  brandStyle.value = { ...next.style.defaults }
  baseline.value = serializeDraft()
  selectedIndex.value = Math.min(selectedIndex.value, Math.max(0, (composition.value?.frames.length ?? 1) - 1))
  selectedLayerId.value = frame.value?.layers.find(layer => layer.type === 'text')?.id ?? frame.value?.layers[0]?.id ?? ''
  selectedLayerIds.value = selectedLayerId.value ? [selectedLayerId.value] : []
  conflict.value = false
  overflow.value = []
  hydrating = false
  if (resetHistory) { undoStack.value = []; redoStack.value = [] }
  rememberCurrent()
  publishDirty()
}
function acceptSavedState(next: State, dispatchedSnapshot: string, dispatchedStyleRevision: number) {
  const serverComposition = next.composition?.draft?.content ?? next.composition?.revisions[0]?.content ?? null
  const serverStyleRevision = next.composition?.draft?.workspaceStyleRevision ?? dispatchedStyleRevision
  if (serializeDraft() === dispatchedSnapshot) {
    install(next, false)
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
          rememberCurrent()
          publishDirty()
        }
      } catch { notice.value = 'Локальні правки не вдалося прочитати; серверна версія доступна.' }
    }
  } catch (cause) { if (!disposed && requestEpoch === epoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити візуал.' }
  finally { if (requestEpoch === epoch) loading.value = false }
}
function changed() {
  if (hydrating || disposed) return
  const current = snapshot()
  if (historySnapshot && current !== historySnapshot) {
    undoStack.value.push(historySnapshot)
    if (undoStack.value.length > 80) undoStack.value.shift()
    redoStack.value = []
  }
  historySnapshot = current
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
  selectedLayerIds.value = selectedLayerId.value ? [selectedLayerId.value] : []
}
function duplicateFrame() {
  if (!canDuplicateFrame.value || !composition.value || !frame.value || readOnly.value) return
  const copy = JSON.parse(JSON.stringify(frame.value)) as VisualFrame
  copy.id = crypto.randomUUID()
  copy.purpose = (copy.purpose.slice(0, 480) + ' · копія').slice(0, 500)
  copy.layers.forEach(layer => { layer.id = crypto.randomUUID() })
  composition.value.frames.splice(selectedIndex.value + 1, 0, copy)
  selectFrame(selectedIndex.value + 1)
  changed()
}

function setTemplate(templateId: VisualFrame['templateId']) {
  if (!composition.value || !frame.value || readOnly.value) return
  const old = frame.value
  if (old.templateId === templateId) return
  const textLayer = old.layers.find(layer => layer.type === 'text') as VisualTextLayer | undefined
  const replacement = makeFrame({ id: old.id, text: textLayer?.text ?? '', purpose: old.purpose, ...(textLayer ? { mappings: textLayer.mappings,...(textLayer.sourceMappings ? { sourceMappings: textLayer.sourceMappings } : {}) } : {}) }, composition.value.height, templateId, brandStyle.value)
  replacement.sourceFrameId = old.sourceFrameId
  const preservedLayers = old.layers.filter(layer => layer.type === 'image' || (layer.type === 'text' && layer.id !== textLayer?.id) || (layer.type === 'rect' && layer.role === 'custom'))
  const newPrimaryText = replacement.layers.find(layer => layer.type === 'text')
  const generatedAccents = replacement.layers.filter(layer => layer.type === 'rect')
  const generatedLogo = replacement.layers.find(layer => layer.type === 'image')
  const replacementText = replacement.layers.find(layer => layer.type === 'text')
  if (replacementText?.type === 'text' && textLayer) {
    replacementText.font = textLayer.font
    replacementText.fontSize = textLayer.fontSize
    replacementText.fontWeight = textLayer.fontWeight
    if (templateId === old.templateId) replacementText.color = textLayer.color
    replacementText.align = textLayer.align
    replacementText.lineHeight = textLayer.lineHeight
  }
  // Apply the new template palette; undo keeps the previous visual.
  const existingImageIds = new Set(preservedLayers.filter(layer => layer.type === 'image').map(layer => layer.type === 'image' ? layer.resource.id : ''))
  replacement.layers = [
    ...preservedLayers,
    ...generatedAccents,
    ...(generatedLogo?.type === 'image' && !existingImageIds.has(generatedLogo.resource.id) ? [generatedLogo] : []),
    ...(newPrimaryText ? [newPrimaryText] : []),
  ]
  composition.value.frames[selectedIndex.value] = replacement
  selectedLayerId.value = replacement.layers.find(layer => layer.type === 'text')?.id ?? ''
  selectedLayerIds.value = selectedLayerId.value ? [selectedLayerId.value] : []
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
    if (layer.locked) continue
    if (layer.type === 'text') { layer.color = brandStyle.value.text; layer.font = brandStyle.value.font }
    if (layer.type === 'rect') layer.color = brandStyle.value.accent
  }
  if (state.value?.style.defaults.logo) addLogo()
  changed()
}
function updateText(patch: Partial<VisualTextLayer>) {
  if (!selectedText.value || selectedText.value.locked || readOnly.value) return
  Object.assign(selectedText.value, patch); changed()
}
function editText(value: string) {
  const layer = selectedText.value
  if (!layer || layer.locked || readOnly.value) return
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
  if (!layer || !composition.value || layer.locked || readOnly.value) return
  const max = key === 'x' || key === 'width' ? composition.value.width : composition.value.height
  const min = key === 'width' || key === 'height' ? 16 : 0
  const available = key === 'x' ? composition.value.width - layer.width : key === 'y' ? composition.value.height - layer.height : max - (key === 'width' ? layer.x : layer.y)
  ;(layer as VisualLayer)[key] = Math.max(min, Math.min(available, Math.round(Number(value) || 0)))
  changed()
}
function updateFrameColor(value: string) { if (frame.value) { frame.value.background = value; changed() } }
function movableGroup(layer: VisualLayer): VisualLayer[] {
  if (!layer.groupId) return [layer]
  return frame.value?.layers.filter(item => item.groupId === layer.groupId) ?? [layer]
}
function selectLayer(id: string, additive = false) {
  const layer = frame.value?.layers.find(item => item.id === id)
  if (!layer) return
  if (additive) {
    selectedLayerIds.value = selectedLayerIds.value.includes(id)
      ? selectedLayerIds.value.filter(item => item !== id)
      : [...selectedLayerIds.value, id]
  } else {
    selectedLayerIds.value = layer.groupId ? movableGroup(layer).map(item => item.id) : [id]
  }
  selectedLayerId.value = selectedLayerIds.value.includes(id) ? id : selectedLayerIds.value[0] ?? ''
  updateTransformer()
}
function toggleLayerSelection(id: string, checked: boolean) {
  const next = selectedLayerIds.value.filter(item => item !== id)
  if (checked) next.push(id)
  selectedLayerIds.value = next
  selectedLayerId.value = checked ? id : next[0] ?? ''
  updateTransformer()
}
function duplicateLayer() {
  if (!frame.value || !composition.value || !selectedLayer.value || readOnly.value
    || frame.value.layers.length >= 12 || selectedLayer.value.locked) return
  const original = selectedLayer.value
  const copy = JSON.parse(JSON.stringify(original)) as VisualLayer
  copy.id = crypto.randomUUID()
  delete copy.groupId
  copy.x = Math.min(composition.value.width - copy.width, copy.x + 24)
  copy.y = Math.min(composition.value.height - copy.height, copy.y + 24)
  if (copy.type === 'image' && copy.role === 'background') copy.role = 'graphic'
  const index = frame.value.layers.findIndex(item => item.id === original.id)
  frame.value.layers.splice(index + 1, 0, copy)
  selectLayer(copy.id)
  changed()
}
function toggleLayerState(key: 'locked' | 'hidden') {
  if (!selectedLayer.value || !frame.value || readOnly.value) return
  selectedLayer.value[key] = !selectedLayer.value[key]
  changed()
}
function groupSelectedLayers() {
  const chosen = frame.value?.layers.filter(item => selectedLayerIds.value.includes(item.id)) ?? []
  if (readOnly.value || chosen.length < 2 || chosen.some(item => item.locked)) return
  const groupId = crypto.randomUUID()
  chosen.forEach(item => { item.groupId = groupId })
  changed()
}
function ungroupSelectedLayers() {
  if (!frame.value || readOnly.value || !selectedLayer.value?.groupId) return
  const groupId = selectedLayer.value.groupId
  frame.value.layers.filter(item => item.groupId === groupId).forEach(item => { delete item.groupId })
  selectedLayerIds.value = selectedLayerId.value ? [selectedLayerId.value] : []
  changed()
}
function addTextLayer() {
  if (readOnly.value || !frame.value || !composition.value || frame.value.layers.length >= 12) return
  const layer: VisualTextLayer = {
    id: crypto.randomUUID(), type: 'text', x: 84, y: Math.min(260, composition.value.height - 240),
    width: 912, height: 200, text: 'Новий текст', font: brandStyle.value.font, fontSize: 48,
    fontWeight: '600', color: brandStyle.value.text, align: 'left', lineHeight: 1.2, mappings: [],
  }
  frame.value.layers.push(layer); selectLayer(layer.id); changed()
}
function addShapeLayer() {
  if (readOnly.value || !frame.value || frame.value.layers.length >= 12) return
  const layer: VisualLayer = { id: crypto.randomUUID(), type: 'rect', x: 84, y: 84, width: 280, height: 120, color: brandStyle.value.accent, role: 'custom' }
  frame.value.layers.push(layer); selectLayer(layer.id); changed()
}
function removeSelectedLayer() {
  if (readOnly.value || !frame.value || frame.value.layers.length < 2 || !selectedLayer.value || selectedLayer.value.locked) return
  frame.value.layers = frame.value.layers.filter(layer => layer.id !== selectedLayerId.value)
  selectedLayerId.value = frame.value.layers.find(layer => layer.type === 'text')?.id ?? frame.value.layers[0]?.id ?? ''
  selectedLayerIds.value = selectedLayerId.value ? [selectedLayerId.value] : []
  changed()
}
function moveSelectedLayer(step: -1 | 1) {
  if (readOnly.value || !frame.value || selectedLayer.value?.locked) return
  const index = frame.value.layers.findIndex(layer => layer.id === selectedLayerId.value)
  const other = index + step
  if (index < 0 || other < 0 || other >= frame.value.layers.length) return
  const layers = frame.value.layers
  ;[layers[index], layers[other]] = [layers[other]!, layers[index]!]
  changed()
}
function updateTransformer() {
  const currentStage = stage.value
  const transformer = editorTransformer
  if (!currentStage || !transformer) return
  const node = selectedLayerId.value ? currentStage.findOne('.' + selectedLayerId.value) : null
  transformer.nodes(node && !readOnly.value && !selectedLayer.value?.locked
    && selectedLayerIds.value.length === 1 ? [node] : [])
  transformer.getLayer()?.batchDraw()
}
function updateLayerColor(value: string) {
  if (selectedLayer.value?.locked || readOnly.value) return
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
function showDragGuides(x: number | null, y: number | null) {
  if (!composition.value) return
  if (verticalGuide) {
    verticalGuide.visible(x !== null)
    if (x !== null) verticalGuide.points([x, 0, x, composition.value.height])
  }
  if (horizontalGuide) {
    horizontalGuide.visible(y !== null)
    if (y !== null) horizontalGuide.points([0, y, composition.value.width, y])
  }
  verticalGuide?.getLayer()?.batchDraw()
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
    editorTransformer = null
    verticalGuide = null
    horizontalGuide = null
    dragOrigins = null
    dragBox = null
    for (const layer of frame.value.layers) {
      const node = result.stage.findOne('.' + layer.id)
      if (!node) continue
      node.listening(true)
      node.draggable(!readOnly.value && !layer.locked && !movableGroup(layer).some(item => item.locked))
      node.on('click tap', (event) => {
        selectLayer(layer.id, !!(event.evt instanceof MouseEvent && event.evt.shiftKey))
      })
      node.on('dragstart', () => {
        dragInProgress = true
        selectLayer(layer.id)
        const members = movableGroup(layer)
        dragOrigins = new Map(members.map(item => [item.id, { x: item.x, y: item.y }]))
        const left = Math.min(...members.map(item => item.x))
        const top = Math.min(...members.map(item => item.y))
        dragBox = {
          x: left, y: top,
          width: Math.max(...members.map(item => item.x + item.width)) - left,
          height: Math.max(...members.map(item => item.y + item.height)) - top,
        }
      })
      node.on('dragmove', (event) => {
        const current = composition.value
        const original = dragOrigins?.get(layer.id)
        const box = dragBox
        if (!current || !original || !box || !frame.value) return
        const x = Math.max(0, Math.min(current.width - box.width, box.x + node.x() - original.x))
        const y = Math.max(0, Math.min(current.height - box.height, box.y + node.y() - original.y))
        const others = frame.value.layers.filter(item => !dragOrigins?.has(item.id))
        const snapped = snapEnabled.value && !event.evt.altKey
          ? snapBounds({ x, y, width: box.width, height: box.height }, others, current)
          : { x: Math.round(x), y: Math.round(y), guideX: null, guideY: null }
        const dx = snapped.x - box.x
        const dy = snapped.y - box.y
        for (const [id, origin] of dragOrigins ?? []) {
          const otherNode = result.stage.findOne('.' + id)
          otherNode?.position({ x: origin.x + dx, y: origin.y + dy })
        }
        showDragGuides(snapped.guideX, snapped.guideY)
      })
      node.on('dragend', () => {
        const original = dragOrigins?.get(layer.id)
        const dx = original ? Math.round(node.x() - original.x) : 0
        const dy = original ? Math.round(node.y() - original.y) : 0
        for (const [id, previous] of dragOrigins ?? []) {
          const member = frame.value?.layers.find(item => item.id === id)
          if (member) { member.x = previous.x + dx; member.y = previous.y + dy }
        }
        dragOrigins = null
        dragBox = null
        dragInProgress = false
        showDragGuides(null, null)
        if (dx || dy) changed()
      })
      if (layer.type === 'text') node.on('dblclick dbltap', () => document.getElementById('visual-copy')?.focus())
      node.on('transformend', () => {
        if (readOnly.value || !composition.value) return
        const width = Math.min(composition.value.width, Math.max(16, Math.round(layer.width * node.scaleX())))
        const height = Math.min(composition.value.height, Math.max(16, Math.round(layer.height * node.scaleY())))
        layer.x = Math.max(0, Math.min(composition.value.width - width, Math.round(node.x())))
        layer.y = Math.max(0, Math.min(composition.value.height - height, Math.round(node.y())))
        layer.width = Math.min(width, composition.value.width - layer.x)
        layer.height = Math.min(height, composition.value.height - layer.y)
        changed()
      })
    }
    const transformer = new Konva.Transformer({
      rotateEnabled: false, flipEnabled: false, borderStroke: '#343a40',
      anchorFill: '#ffffff', anchorStroke: '#343a40', anchorSize: 9,
      keepRatio: false, boundBoxFunc: (_old, next) => next.width < 16 || next.height < 16 ? _old : next,
    })
    const displayLayer = result.stage.getLayers()[0]
    verticalGuide = new Konva.Line({ points: [0, 0, 0, composition.value.height], stroke: '#95642b', strokeWidth: 1.5, dash: [8, 6], visible: false, listening: false })
    horizontalGuide = new Konva.Line({ points: [0, 0, composition.value.width, 0], stroke: '#95642b', strokeWidth: 1.5, dash: [8, 6], visible: false, listening: false })
    displayLayer?.add(verticalGuide)
    displayLayer?.add(horizontalGuide)
    displayLayer?.add(transformer)
    editorTransformer = transformer
    updateTransformer()
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
    frame.value.layers.unshift(imageLayer); selectLayer(imageLayer.id); changed(); notice.value = 'Фото додано до поточного кадру.'
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
  if (existing) { selectLayer(existing.id); return }
  const layer: VisualLayer = { id: crypto.randomUUID(), type: 'image', resource: logo, x: 876, y: composition.value.height - 88, width: 120, height: 48, fit: 'contain' }
  frame.value.layers.push(layer); selectLayer(layer.id); changed()
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
    notice.value = 'Усі кадри перевірено. Надсилаємо точну версію на погодження…'
    approvalDispatched = true
    const next = await request(`/revisions/${encodeURIComponent(current.id)}/approve`, {
      expectedRevision: owner.revision,
      expectedReviewCounter: current.reviewCounter ?? current.parentReviewCounter,
    }) as State
    if (!checkCurrent()) throw new Error('Відповідь надійшла після зміни композиції. Перевірте історію версій перед повтором.')
    install(next)
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
watch([composition, selectedIndex], () => { if (!dragInProgress) void nextTick(render) }, { deep: true })
watch(selectedLayerId, updateTransformer)
watch(dirty, publishDirty)
onMounted(() => {
  resizeObserver = new ResizeObserver(fitStage)
  if (stageWrap.value) resizeObserver.observe(stageWrap.value)
  window.addEventListener('resize', fitStage)
  window.addEventListener('pointerdown', dismissAddLayerMenu)
  void load()
})
onBeforeUnmount(() => { disposed = true; clearTimeout(autosave); controller.abort(); resizeObserver?.disconnect(); resizeObserver = null; window.removeEventListener('resize', fitStage); window.removeEventListener('pointerdown', dismissAddLayerMenu); renderVersion++; stage.value?.destroy(); renderObjectUrls.clear(); epoch++ })
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
          :disabled="readOnly || saving || checkpointing || reviewing || !composition"
          @click="saveCheckpoint"
        >
          Зберегти версію
        </button>
        <button
          v-if="!approvedAndClean"
          type="button"
          :disabled="reviewing || rebasing || readOnly || saving || checkpointing || !composition || conflict"
          @click="preparePreviewsAndApprove"
        >
          {{ reviewing ? 'Перевіряємо й погоджуємо…' : 'Зберегти й погодити' }}
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
      <div
        v-if="canDuplicateFrame"
        class="visual-frame-actions"
      >
        <button
          type="button"
          :disabled="readOnly"
          @click="duplicateFrame"
        >
          Дублювати кадр
        </button>
      </div>
      <details
        class="visual-template-gallery"
        open
      >
        <summary>Галерея макетів</summary>
        <div class="visual-template-grid">
          <button
            v-for="template in TEMPLATE_CATALOG"
            :key="template.id"
            type="button"
            class="visual-template-card"
            :aria-pressed="frame.templateId === template.id"
            :aria-label="`Шаблон: ${template.label}`"
            :disabled="readOnly"
            @click="setTemplate(template.id)"
          >
            <span
              class="template-thumb"
              :class="`template-thumb--${template.id}`"
              :style="{ '--preview-accent': brandStyle.accent, '--preview-ink': brandStyle.text }"
              aria-hidden="true"
            >
              <span class="template-thumb-accent" />
              <span class="template-thumb-photo" />
              <span class="template-thumb-copy"><i /><i /><i /></span>
            </span>
            <strong>{{ template.label }}</strong><small>{{ template.description }}</small>
          </button>
        </div>
      </details>
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
          <div class="visual-layer-header">
            <h2>Шари кадру</h2>
            <div
              class="visual-layer-primary"
              role="toolbar"
              aria-label="Основні дії із шарами"
            >
              <details
                ref="addLayerMenu"
                class="visual-add-layer"
                @keydown.esc.stop="closeAddLayerMenu"
              >
                <summary
                  class="visual-icon-button"
                  :aria-disabled="readOnly || frame.layers.length >= 12"
                  :aria-label="'Додати шар'"
                  title="Додати шар"
                  @click.prevent="(readOnly || frame.layers.length >= 12) ? closeAddLayerMenu() : (addLayerMenu!.open = !addLayerMenu!.open)"
                >
                  <Plus
                    :size="16"
                    aria-hidden="true"
                  />
                </summary>
                <div
                  class="visual-add-layer-menu"
                  aria-label="Тип нового шару"
                >
                  <button
                    type="button"
                    @click="addLayerFromMenu('text')"
                  >
                    Текст
                  </button>
                  <button
                    type="button"
                    @click="addLayerFromMenu('shape')"
                  >
                    Форма
                  </button>
                </div>
              </details>
              <button
                class="visual-icon-button"
                type="button"
                aria-label="Дублювати шар"
                title="Дублювати шар"
                :disabled="readOnly || !selectedLayer || selectedLayer.locked || frame.layers.length >= 12"
                @click="duplicateLayer"
              >
                <Copy
                  :size="16"
                  aria-hidden="true"
                />
              </button>
              <button
                class="visual-icon-button"
                type="button"
                aria-label="Видалити шар"
                title="Видалити шар"
                :disabled="readOnly || !selectedLayer || !!selectedLayer.locked || frame.layers.length <= 1"
                @click="removeSelectedLayer"
              >
                <Trash2
                  :size="16"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
          <div
            class="visual-layer-secondary"
            role="toolbar"
            aria-label="Порядок і стан шарів"
          >
            <button
              class="visual-icon-button"
              type="button"
              aria-label="Опустити шар"
              title="Опустити шар"
              :disabled="readOnly || !selectedLayer || !!selectedLayer.locked || frame.layers[0]?.id === selectedLayerId"
              @click="moveSelectedLayer(-1)"
            >
              <ArrowDown
                :size="16"
                aria-hidden="true"
              />
            </button>
            <button
              class="visual-icon-button"
              type="button"
              aria-label="Підняти шар"
              title="Підняти шар"
              :disabled="readOnly || !selectedLayer || !!selectedLayer.locked || frame.layers[frame.layers.length - 1]?.id === selectedLayerId"
              @click="moveSelectedLayer(1)"
            >
              <ArrowUp
                :size="16"
                aria-hidden="true"
              />
            </button>
            <button
              class="visual-icon-button"
              type="button"
              :aria-label="selectedLayer?.locked ? 'Розблокувати шар' : 'Заблокувати шар'"
              :title="selectedLayer?.locked ? 'Розблокувати шар' : 'Заблокувати шар'"
              :disabled="readOnly || !selectedLayer"
              @click="toggleLayerState('locked')"
            >
              <Unlock
                v-if="selectedLayer?.locked"
                :size="16"
                aria-hidden="true"
              />
              <Lock
                v-else
                :size="16"
                aria-hidden="true"
              />
            </button>
            <button
              class="visual-icon-button"
              type="button"
              :aria-label="selectedLayer?.hidden ? 'Показати шар' : 'Приховати шар'"
              :title="selectedLayer?.hidden ? 'Показати шар' : 'Приховати шар'"
              :disabled="readOnly || !selectedLayer"
              @click="toggleLayerState('hidden')"
            >
              <EyeOff
                v-if="selectedLayer?.hidden"
                :size="16"
                aria-hidden="true"
              />
              <Eye
                v-else
                :size="16"
                aria-hidden="true"
              />
            </button>
            <button
              class="visual-icon-button"
              type="button"
              :aria-label="selectedLayer?.groupId ? 'Розгрупувати шари' : 'Групувати шари'"
              :title="selectedLayer?.groupId ? 'Розгрупувати шари' : 'Групувати шари'"
              :disabled="readOnly || (selectedLayer?.groupId ? !selectedLayer : selectedLayerIds.length < 2)"
              @click="selectedLayer?.groupId ? ungroupSelectedLayers() : groupSelectedLayers()"
            >
              <Ungroup
                v-if="selectedLayer?.groupId"
                :size="16"
                aria-hidden="true"
              />
              <Group
                v-else
                :size="16"
                aria-hidden="true"
              />
            </button>
          </div>
          <div
            v-for="layer in frame.layers"
            :key="layer.id"
            class="visual-layer-row"
          >
            <input
              type="checkbox"
              :aria-label="'Вибрати для групування: ' + (layer.type === 'text' ? 'текст' : layer.type === 'image' ? 'зображення' : 'форма')"
              :checked="selectedLayerIds.includes(layer.id)"
              @change="toggleLayerSelection(layer.id, ($event.target as HTMLInputElement).checked)"
            >
            <button
              class="layer-choice"
              :aria-pressed="selectedLayerId === layer.id"
              type="button"
              @click="selectLayer(layer.id, ($event as MouseEvent).shiftKey)"
            >
              <span>{{ layer.type === 'text' ? 'Текст' : layer.type === 'image' ? 'Зображення' : 'Акцент' }}
                <em v-if="layer.locked">· Замкнено</em><em v-if="layer.hidden">· Приховано</em><em v-if="layer.groupId">· Група</em>
              </span>
              <small>{{ layer.type === 'text' ? layer.text.slice(0, 30) || 'Порожній текст' : layer.type === 'image' ? 'Власний файл' : 'Форма' }}</small>
            </button>
          </div>
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
            class="visual-zoom-bar"
            role="toolbar"
            aria-label="Керування полотном"
          >
            <label for="visual-zoom">Масштаб</label>
            <button
              type="button"
              aria-label="Зменшити"
              title="Зменшити масштаб"
              @click="adjustZoom(-1)"
            >
              −
            </button>
            <select
              id="visual-zoom"
              :value="zoomMode"
              @change="setZoom(($event.target as HTMLSelectElement).value === 'fit' ? 'fit' : Number(($event.target as HTMLSelectElement).value))"
            >
              <option value="fit">
                {{ currentZoom }}%
              </option>
              <option
                v-for="level in [25, 50, 75, 100, 125, 150, 200]"
                :key="level"
                :value="level"
              >
                {{ level }}%
              </option>
            </select>
            <button
              type="button"
              aria-label="Збільшити"
              title="Збільшити масштаб"
              @click="adjustZoom(1)"
            >
              +
            </button>
            <button
              type="button"
              @click="setZoom('fit')"
            >
              Умістити
            </button>
            <label class="visual-snap-toggle"><input
              v-model="snapEnabled"
              type="checkbox"
            > Прив’язка</label>
            <div
              class="visual-zoom-history"
              role="group"
              aria-label="Історія редагування"
            >
              <button
                type="button"
                :disabled="!canUndo"
                aria-label="Скасувати"
                title="Скасувати (Ctrl+Z)"
                @click="undo"
              >
                <Undo2
                  :size="16"
                  aria-hidden="true"
                />
              </button>
              <button
                type="button"
                :disabled="!canRedo"
                aria-label="Повторити"
                title="Повторити (Ctrl+Shift+Z)"
                @click="redo"
              >
                <Redo2
                  :size="16"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
          <div
            ref="stageWrap"
            class="visual-stage-wrap"
            tabindex="0"
            aria-label="Полотно редактора. Перетягніть шар або використовуйте стрілки для переміщення."
            @keydown="editorKeydown"
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
            <figcaption>Рендер сервера</figcaption><img
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
              :disabled="readOnly || selectedText.locked"
              rows="5"
              @input="editText(($event.target as HTMLTextAreaElement).value)"
            />
            <label for="visual-font">Шрифт</label><select
              id="visual-font"
              :value="selectedText.font"
              :disabled="readOnly || selectedText.locked"
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
              :disabled="readOnly || selectedText.locked"
              @input="updateText({ fontSize: Math.max(14, Math.min(180, Number(($event.target as HTMLInputElement).value) || 14)) })"
            >
            <label for="visual-weight">Насиченість</label><select
              id="visual-weight"
              :value="selectedText.fontWeight"
              :disabled="readOnly || selectedText.locked"
              @change="updateText({ fontWeight: ($event.target as HTMLSelectElement).value as VisualTextLayer['fontWeight'] })"
            >
              <option value="400">
                Звичайний · 400
              </option>
              <option value="600">
                Напівжирний · 600
              </option>
              <option value="700">
                Жирний · 700
              </option>
            </select>
            <label for="visual-line-height">Міжрядковий інтервал</label><input
              id="visual-line-height"
              type="number"
              min="1"
              max="2"
              step="0.05"
              :value="selectedText.lineHeight"
              :disabled="readOnly || selectedText.locked"
              @change="updateText({ lineHeight: Math.max(1, Math.min(2, Number(($event.target as HTMLInputElement).value) || 1.2)) })"
            >
            <p class="visual-layer-hint">
              Для різних стилів в одному кадрі додайте ще один текстовий шар.
            </p>
            <label for="visual-color">Колір тексту</label><input
              id="visual-color"
              type="color"
              :value="selectedText.color"
              :disabled="readOnly || !!selectedLayer?.locked"
              @input="updateLayerColor(($event.target as HTMLInputElement).value)"
            >
            <label for="visual-align">Вирівнювання</label><select
              id="visual-align"
              :value="selectedText.align"
              :disabled="readOnly || selectedText.locked"
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
              :disabled="readOnly || !!selectedLayer?.locked"
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
              :disabled="readOnly || !!selectedLayer?.locked"
              @input="updateLayerColor(($event.target as HTMLInputElement).value)"
            >
          </template>
          <details class="visual-coordinate-details">
            <summary>Позиція та розмір</summary>
            <fieldset
              class="visual-coordinates"
              :disabled="readOnly || !selectedLayer || !!selectedLayer.locked"
              aria-label="Позиція та розмір"
            >
              <label
                v-for="key in (['x', 'y', 'width', 'height'] as const)"
                :key="key"
              >
                {{ key === 'x' ? 'X' : key === 'y' ? 'Y' : key === 'width' ? 'Ширина' : 'Висота' }}
                <input
                  type="number"
                  min="0"
                  max="1920"
                  :value="selectedLayer?.[key] ?? 0"
                  @input="updateLayerBounds(key, ($event.target as HTMLInputElement).value)"
                >
              </label>
            </fieldset>
          </details>
          <label for="visual-background">Колір тла всього кадру</label><input
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
.visual-layer-header { display:flex; align-items:center; justify-content:space-between; gap:8px; min-width:0; }
.visual-layer-header h2 { margin:0; }
.visual-layer-primary,.visual-layer-secondary { display:flex; align-items:center; gap:4px; }
.visual-layer-primary { flex:none; }
.visual-layer-secondary { margin:0 0 4px; }
.visual-icon-button { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border:1px solid var(--rule); border-radius:3px; background:white; color:var(--ink); cursor:pointer; }
.visual-icon-button:hover:not(:disabled):not([aria-disabled=true]) { border-color:var(--ink); background:var(--paper); }
.visual-icon-button:disabled,.visual-icon-button[aria-disabled=true] { opacity:.38; cursor:not-allowed; }
.visual-icon-button:focus-visible { outline:2px solid var(--copper); outline-offset:2px; }
.visual-add-layer { position:relative; flex:none; }
.visual-add-layer summary { list-style:none; }
.visual-add-layer summary::-webkit-details-marker { display:none; }
.visual-add-layer-menu { position:absolute; z-index:5; top:calc(100% + 5px); left:0; display:grid; min-width:124px; padding:5px; border:1px solid var(--rule); background:white; box-shadow:0 6px 20px #00000013; }
.visual-add-layer-menu button { border:0; background:transparent; min-height:34px; padding:6px 10px; text-align:left; font:12px var(--font-sans,Onest,sans-serif); color:var(--ink); cursor:pointer; }
.visual-add-layer-menu button:hover,.visual-add-layer-menu button:focus-visible { background:var(--paper); }
.visual-frame-actions { display:flex; align-items:center; gap:12px; padding:0 0 12px; flex-wrap:wrap; }
.visual-frame-actions button { padding:6px 10px; min-height:34px; background:white; border:1px solid var(--rule); border-radius:3px; color:var(--ink); font:500 12px var(--font-sans,Onest,sans-serif); }
.visual-frame-actions button:disabled { opacity:.45; }
.visual-frame-actions small { color:var(--muted); font-size:11px; }
.visual-template-gallery { margin:0 0 16px; border-bottom:1px solid var(--rule); }
.visual-template-gallery summary { cursor:pointer; padding:8px 0 12px; font:600 13px var(--font-sans,Onest,sans-serif); }
.visual-template-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr)); gap:10px; padding:0 0 16px; }
.visual-template-card { display:grid; align-content:start; gap:4px; min-width:0; padding:8px; border:1px solid var(--rule); border-radius:3px; background:white; color:var(--ink); text-align:left; cursor:pointer; }
.visual-template-card[aria-pressed=true] { border-color:var(--ink); box-shadow:inset 0 0 0 1px var(--ink); background:var(--selected,#eff1f2); }
.visual-template-card strong { font-size:12px; font-weight:600; }
.visual-template-card small { color:var(--muted); font-size:10px; line-height:1.3; }
.template-thumb { position:relative; display:block; width:100%; aspect-ratio:4/3; background:#f5f3ef; overflow:hidden; border:1px solid var(--rule); }
.template-thumb-accent { position:absolute; top:12%; left:13%; width:25%; height:4%; background:var(--preview-accent); }
.template-thumb-copy { position:absolute; top:31%; left:13%; width:74%; display:grid; gap:5px; }
.template-thumb-copy i { display:block; height:7px; background:var(--preview-ink); border-radius:1px; opacity:.85; }
.template-thumb-copy i:nth-child(2) { width:85%; }.template-thumb-copy i:nth-child(3) { width:52%; opacity:.5; }
.template-thumb-photo { display:none; }
.template-thumb--statement { background:var(--preview-accent); }.template-thumb--statement .template-thumb-copy i { background:white; }.template-thumb--statement .template-thumb-accent { display:none; }
.template-thumb--photo-caption .template-thumb-photo { display:block; position:absolute; inset:0 0 37%; background:linear-gradient(135deg,#dadfdc 35%,#aeb9b4 36%,#aeb9b4 70%,#849993 71%); }
.template-thumb--photo-caption .template-thumb-copy { top:70%; }.template-thumb--photo-caption .template-thumb-accent { display:none; }
.template-thumb--fact .template-thumb-accent { width:42%; }.template-thumb--fact .template-thumb-copy { top:37%; }
.template-thumb--minimal .template-thumb-copy { top:42%; }.template-thumb--minimal .template-thumb-accent { top:auto; bottom:12%; width:74%; height:2%; }
.template-thumb--split .template-thumb-accent { top:0; left:0; height:100%; width:30%; }.template-thumb--split .template-thumb-copy { top:36%; left:40%; width:52%; }
.template-thumb--quote .template-thumb-copy { top:36%; left:18%; width:70%; }.template-thumb--quote .template-thumb-copy i { height:9px; }.template-thumb--quote .template-thumb-accent { left:18%; top:21%; }
.visual-zoom-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin:0 0 9px; font-size:11px; color:var(--muted); }
.visual-zoom-bar button,.visual-zoom-bar select { min-height:32px; padding:4px 8px; border:1px solid var(--rule); border-radius:3px; color:var(--ink); background:white; font:12px var(--font-sans,Onest,sans-serif); }
.visual-zoom-bar label { font-size:11px; }.visual-snap-toggle { display:flex; align-items:center; gap:4px; margin-left:2px; white-space:nowrap; }
.visual-zoom-history { display:flex; align-items:center; gap:4px; margin-left:auto; }
.visual-zoom-history button { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; padding:0; }
.visual-zoom-history button:disabled { opacity:.38; cursor:not-allowed; }
.visual-zoom-bar input { accent-color:var(--ink); }
.visual-stage-wrap:focus-visible { outline:2px solid var(--ink); outline-offset:3px; }
.visual-layout { display:grid; grid-template-columns:minmax(160px,205px) minmax(250px,1fr) minmax(195px,245px); align-items:start; gap:22px; }
.visual-tools,.visual-inspector { display:grid; align-content:start; gap:9px; min-width:0; }
.visual-tools label,.visual-inspector>label,.visual-inspector legend { color:var(--ink); font-size:12px; font-weight:600; }
.visual-tools select,.visual-inspector select,.visual-inspector input:not([type=color]),.visual-inspector textarea { width:100%; min-width:0; border:1px solid var(--rule); border-radius:3px; padding:8px; color:var(--ink); background:white; font:13px var(--font-sans,Onest,sans-serif); }
.visual-inspector input[type=color],.visual-tools input[type=color] { width:42px; height:34px; padding:2px; border:1px solid var(--rule); background:white; }
.visual-divider { height:1px; background:var(--rule); margin:8px 0; }.visual-tools h2,.visual-inspector h2 { margin:0 0 2px; font-size:13px; font-weight:600; }
.visual-layer-hint { margin:0 0 4px; color:var(--muted); font-size:11px; line-height:1.45; }
.visual-layer-row { display:grid; grid-template-columns:20px minmax(0,1fr); align-items:center; gap:4px; min-width:0; }
.visual-layer-row input { width:15px; height:15px; margin:0; accent-color:var(--ink); }
.visual-layer-row em { font-style:normal; font-weight:400; color:var(--muted); font-size:10px; }
.layer-choice { display:grid; gap:3px; padding:8px 9px; border:1px solid transparent; border-radius:2px; color:var(--ink); background:transparent; text-align:left; cursor:pointer; }
.layer-choice[aria-pressed="true"] { border-color:var(--rule); background:var(--paper); }.layer-choice span { font-size:12px; font-weight:600; }.layer-choice small { overflow:hidden; color:var(--muted); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.upload-control { display:grid; gap:6px; margin-top:8px; }.upload-control input { width:100%; font-size:11px; }.text-action { justify-self:start; padding:4px 0; border:0; color:var(--ink); background:transparent; font:500 12px var(--font-sans,Onest,sans-serif); text-decoration:underline; text-underline-offset:3px; cursor:pointer; }.text-action:disabled { opacity:.45; cursor:not-allowed; }
.visual-stage-column { min-width:0; }.visual-stage-wrap { display:flex; align-items:flex-start; justify-content:flex-start; width:100%; overflow:auto; background:#efede8; scrollbar-width:thin; }.visual-stage { margin:auto; touch-action:none; }.visual-stage { flex:0 0 auto; outline:1px solid var(--rule); background:#fff; }.visual-stage :deep(canvas) { display:block; }
.server-preview { width:min(100%,440px); margin:18px auto 0; }.server-preview figcaption { margin-bottom:8px; color:var(--muted); font-size:12px; text-align:center; }.server-preview img { display:block; width:100%; height:auto; }
.stage-caption { margin:9px 0 0; text-align:center; font-variant-numeric:tabular-nums; }
.visual-coordinate-details { border-top:1px solid var(--rule); padding-top:9px; }
.visual-coordinate-details summary { font:600 12px var(--font-sans,Onest,sans-serif); cursor:pointer; padding:3px 0; }
.visual-coordinates { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:7px 0; padding:10px 0; border:0; }.visual-coordinates label { display:grid; gap:4px; color:var(--muted); font-size:11px; }
.visual-small { margin:4px 0; line-height:1.45; }.visual-message { margin:14px 0; padding:10px 12px; background:var(--paper); color:var(--ink); font-size:13px; }.visual-error { color:#9a3025; }.visual-empty { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:18px; padding:32px 0; }.visual-empty h2 { margin:0 0 7px; font:500 24px/1.2 var(--font-serif,'Source Serif 4',serif); }.visual-empty p { max-width:58ch; margin:0; color:var(--muted); font-size:14px; line-height:1.5; }.visual-empty .visual-boundary { flex-basis:100%; font-size:12px; }
.visual-review { margin-top:34px; padding:20px 0 0; border-top:1px solid var(--ink); }.visual-review h2 { margin:0; font:500 25px/1.25 var(--font-serif,'Source Serif 4',serif); }.visual-review h3 { margin:24px 0 8px; font:500 19px/1.35 var(--font-serif,'Source Serif 4',serif); }.visual-review>p { max-width:68ch; margin:8px 0; color:var(--muted); font-size:13px; line-height:1.5; }.visual-review>button,.visual-review-history button { min-height:40px; padding:0 14px; border:1px solid var(--ink); border-radius:3px; background:var(--ink); color:white; font:500 13px var(--font-sans,Onest,sans-serif); cursor:pointer; }.visual-review>button:disabled,.visual-review-history button:disabled { opacity:.48; cursor:not-allowed; }.visual-review .visual-review-reasons { color:var(--review,#7d4700); }.visual-unmapped-ack { display:flex; align-items:flex-start; gap:9px; max-width:68ch; margin:14px 0; color:var(--ink); font-size:13px; line-height:1.5; cursor:pointer; }.visual-unmapped-ack input { flex:none; width:17px; height:17px; margin:1px 0 0; accent-color:var(--graphite,#343a40); }.visual-review-history { margin:0; padding:0; list-style:none; border-top:1px solid var(--rule); }.visual-review-history li { display:flex; align-items:center; justify-content:space-between; gap:14px; padding:12px 0; border-bottom:1px solid var(--rule); }.visual-review-history li>div { display:grid; gap:3px; min-width:0; font-size:12px; overflow-wrap:anywhere; }.visual-review-history li>div span { color:var(--muted); }
.visual-review>.visual-refresh-parent { margin:4px 0 10px; background:transparent; color:var(--ink); }
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible { outline:2px solid var(--copper); outline-offset:2px; }
@media(max-width:900px) { .visual-layout { grid-template-columns:minmax(145px,180px) minmax(220px,1fr); gap:18px; }.visual-inspector { grid-column:2; grid-row:2; grid-template-columns:1fr 1fr; }.visual-inspector h2,.visual-inspector fieldset,.visual-inspector .visual-coordinate-details,.visual-inspector .text-action,.visual-inspector .visual-small { grid-column:1/-1; } }
@media(max-width:600px) { .visual-template-grid { display:flex; overflow-x:auto; padding-bottom:12px; scroll-snap-type:x proximity; } .visual-template-card { flex:0 0 150px; scroll-snap-align:start; } .visual-heading { display:grid; align-items:start; }.visual-actions { justify-content:space-between; }.visual-layout { grid-template-columns:1fr; }.visual-stage-column { grid-row:1; }.visual-tools { grid-template-columns:1fr 1fr; }.visual-tools h2,.visual-tools .visual-layer-header,.visual-tools .visual-layer-secondary,.visual-tools .visual-divider,.visual-tools .visual-layer-row,.visual-tools .upload-control,.visual-tools .text-action { grid-column:1/-1; }.visual-inspector { grid-column:auto; grid-row:auto; grid-template-columns:1fr 1fr; }.visual-stage-wrap { max-height:72vh; }.visual-empty { align-items:flex-start; }.visual-review-history li { align-items:flex-start; flex-direction:column; }.visual-review>button { width:100%; } }
</style>
