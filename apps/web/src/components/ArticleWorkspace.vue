<script setup lang="ts">
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Extension, Mark, type JSONContent } from '@tiptap/core'
import type { Node as EditorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { Button } from '@/components/ui/button'
import ArticlePreview from './ArticlePreview.vue'
import ArticleAnnotations from './ArticleAnnotations.vue'
import GoogleDocsBinding from './GoogleDocsBinding.vue'
import SourceMarkdown from './SourceMarkdown.vue'

interface Content { title: string; document: JSONContent }
interface Version { id: string; number: number; content: Content; contentMode: 'FACTUAL' | 'CREATIVE'; origin: string; status: string; sourceArticleRevision: number; sha256?: string; approvedAt?: string; withdrawnAt?: string; reviewCounter?: number; staleReasons?: string[]; blockingReasons?: string[]; eligible?: boolean; hasUnmapped?: boolean }
interface Draft { baseVersionId?: string | null; sha256?: string; content: Content; contentMode: 'FACTUAL' | 'CREATIVE'; origin: string }
interface SourcePassage { passageId: string; packetId: string; snapshotId: string; fragmentId: string; startOffset: number; endOffset: number; quote: string; materialId: string; materialTitle: string }
interface SourceRequest { id: string; stage: string; errorCategory: string | null; resultRefs?: { articleVersionId?: string }; partialArticle?: { content: Content; reviewedSectionCount: number } }
interface State { editorOnly?: boolean; article: { id: string; revision: number; draft: Draft | null; currentApprovedVersionId: string | null; versions: Version[] } | null; articleSelected: boolean; eligibleSourcePassages?: SourcePassage[]; mappingIssues: { locator: string; reason: string }[]; staleReasons: string[]; hasUnmapped: boolean; editorial: { brief: { currentRevision: { id?: string; contentMode: string } | null } | null; outline: { currentApprovedRevisionId: string | null; currentRevision?: { id?: string; briefRevisionId?: string; sourceEvidenceSetId?: string | null } | null } | null } }
interface LanguageSuggestion { id: string; targetType: 'ARTICLE' | 'ADAPTATION'; sourceRevisionId: string; contentHash: string; locator: { field: 'TITLE' | 'BODY' | 'COVER_TEXT'; start: number; end: number }; originalText: string; replacementText: string; finding: string; status: 'OPEN' | 'ACCEPTED' | 'REJECTED'; stale: boolean; resultVersionId?: string | null }
interface Job { id: string; status: string; operation: string; retryAllowed: boolean; resultRefs?: { articleVersionId?: string } | null }
const props = defineProps<{ projectId: string; projectTopic: string; csrfToken: string; userId: string; archived?: boolean; openHistory?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; 'open-brief': [] }>()
const state = ref<State | null>(null)
const title = ref(props.projectTopic)
const titleInput = ref<HTMLTextAreaElement | null>(null)
let titleObserver: ResizeObserver | undefined
let titleObservedWidth = 0
const contentMode = ref<'FACTUAL' | 'CREATIVE'>('CREATIVE')
const baseline = ref('')
const expectedRevision = ref(0)
const editEpoch = ref(0)
const saving = ref(false)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const savedCheckpoint = ref(false)
const conflict = ref(false)
const generationPrerequisiteError = ref('')
const inspector = ref<'history' | 'evidence' | 'proposal' | 'import' | 'annotations' | 'google-docs' | null>(null)
const googleDocsVisited = ref(false)
const inspectorHeading = ref<HTMLHeadingElement | null>(null)
const contentsOpen = ref(false)
const showEvidenceMarks = ref(true)
let contentsViewport: MediaQueryList | undefined
let inspectorOpener: HTMLElement | null = null
let inspectorReadingPosition = { left: 0, top: 0 }
const candidate = ref<Version | null>(null)
const proposalView = ref<'suggested' | 'current'>('suggested')
const proposalEvidenceOpen = ref(false)
const activeProposalCitation = ref<string | null>(null)
const proposalEvidenceLoading = ref(false)
const proposalEvidenceHeading = ref<HTMLHeadingElement | null>(null)
let proposalEvidenceOpener: HTMLElement | null = null
const selectedPassage = ref<SourcePassage | null>(null)
const sourceRequest = ref<SourceRequest | null>(null)
const passageOptions = ref<SourcePassage[]>([])
const sourceText = ref('')
const sourceError = ref('')
let sourcePassageRequest = 0
const sourceActive = computed(() => !!sourceRequest.value && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(sourceRequest.value.stage))
const sourceProgress = computed(() => {
  const request = sourceRequest.value
  if (!request) return ''
  if (request.partialArticle) return request.partialArticle.reviewedSectionCount
    ? 'Збережено частковий результат. Розділи, які треба дописати, позначено в тексті.'
    : 'Жоден розділ не пройшов перевірку. Нижче залишився план для ручного написання.'
  if (request.stage === 'FAILED') {
    if (request.errorCategory === 'NO_RELEVANT_SOURCE_EVIDENCE' || request.errorCategory === 'INSUFFICIENT_EVIDENCE') {
      return 'Для одного з розділів бракує доказів. Уточніть план або додайте джерела. Попередній текст збережено.'
    }
    if (request.errorCategory === 'SECTION_DRAFT_INVALID' || request.errorCategory === 'NEEDS_HUMAN') {
      return 'Один із розділів не пройшов перевірку тексту й посилань. Попередній текст збережено.'
    }
  }
  return ({ INDEXING: 'Готуємо джерела до пошуку…', SEARCHING: 'Добираємо докази для розділів…', READY: 'Докази готові. Починаємо написання…', GENERATING: 'Пишемо й перевіряємо розділи статті…', SUCCEEDED: 'Пропозиція статті готова до перегляду.', FAILED: 'Не вдалося підготувати статтю. Попередній текст збережено.', CANCELLED: 'Підготовку статті скасовано.' } as Record<string,string>)[request.stage] ?? ''
})
const annotationAnchor = ref<{ start: number; end: number; quote: string } | null>(null)
const importedText = ref('')
const recovered = ref<{ content: Content; contentMode: 'FACTUAL' | 'CREATIVE'; expectedRevision: number } | null>(null)
const jobs = ref<Job[]>([])
const languageSuggestions = ref<LanguageSuggestion[]>([])
const selectedLanguageIds = ref<string[]>([])
const languageMessage = ref('')
const languageBusy = ref(false)
const recoveryKey = `cf:article:${props.userId}:${props.projectId}`
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
let disposed = false
let hydration = false
let sessionEnded = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let polling = false
let loadedJobResults = ''
let sourceResultPending = false
let requestedArticleJobId: string | null = null
let inFlight: Promise<boolean> | null = null
let commandKey: string | null = null
let languageRequest = 0
const controller = new AbortController()
function articleSections(document: EditorNode) {
  const sections: { id: string; title: string; level: number; position: number; size: number }[] = []
  document.descendants((node, position) => {
    if (node.type.name !== 'heading' || ![2, 3].includes(Number(node.attrs.level))) return
    sections.push({ id: `article-section-${sections.length + 1}`, title: node.textContent.trim() || 'Без назви', level: Number(node.attrs.level), position, size: node.nodeSize })
  })
  return sections
}
const navigationKey = new PluginKey<DecorationSet>('articleNavigation')
function sectionDecorations(document: EditorNode) {
  return DecorationSet.create(document, articleSections(document).map(section => Decoration.node(section.position, section.position + section.size, { id: section.id })))
}
// Navigation anchors belong to the editor view, never the persisted manuscript.
const articleNavigation = Extension.create({
  name: 'articleNavigation',
  addProseMirrorPlugins: () => [new Plugin<DecorationSet>({
    key: navigationKey,
    state: { init: (_, state) => sectionDecorations(state.doc), apply: (transaction, current) => transaction.docChanged ? sectionDecorations(transaction.doc) : current },
    props: { decorations: state => navigationKey.getState(state) },
  })],
})
const evidenceMark = Mark.create({ name: 'evidence', inclusive: false, addAttributes: () => ({ claimRevisionId: { default: null }, evidenceId: { default: null }, quote: { default: null } }), parseHTML: () => [], renderHTML: ({ HTMLAttributes }) => ['span', { class: 'article-evidence', 'data-evidence-id': HTMLAttributes.evidenceId, 'data-linked-wording': HTMLAttributes.quote, tabindex: 0, role: 'button', 'aria-label': 'Переглянути доказ для цього речення' }, 0] })
const sourceEvidenceMark = Mark.create({ name: 'source_evidence', inclusive: false, excludes: 'evidence source_evidence',
  addAttributes: () => ({ passageId: { default: null }, packetId: { default: null }, quote: { default: null } }), parseHTML: () => [],
  renderHTML: ({ HTMLAttributes }) => ['span', { class: 'article-evidence', 'data-passage-id': HTMLAttributes.passageId,
    'data-packet-id': HTMLAttributes.packetId, 'data-source-quote': HTMLAttributes.quote, tabindex: 0, role: 'button', 'aria-label': 'Переглянути уривок джерела' }, 0] })
const editor = useEditor({ injectCSS: false, extensions: [StarterKit.configure({ heading: { levels: [2, 3] }, code: false, codeBlock: false, horizontalRule: false, link: false, underline: false, trailingNode: false }), evidenceMark, sourceEvidenceMark, articleNavigation], content: { type: 'doc', content: [{ type: 'paragraph' }] }, editorProps: { attributes: { 'aria-label': 'Текст статті', role: 'textbox', 'aria-multiline': 'true' }, handleDOMEvents: { click: (_view, event) => inspectEvidence(event), keydown: (_view, event) => (event.key === 'Enter' || event.key === ' ') && inspectEvidence(event) } }, onUpdate: () => changed() })
const sections = computed(() => { void editEpoch.value; return editor.value ? articleSections(editor.value.state.doc) : [] })
function canonicalNode(node: JSONContent): JSONContent {
  return { type: node.type ?? 'doc', ...(node.type === 'heading' ? { attrs: { level: node.attrs?.level } } : {}), ...(node.text === undefined ? {} : { text: node.text }), ...(node.marks ? { marks: node.marks.map(mark => ({ type: mark.type, ...(mark.type === 'evidence' ? { attrs: { claimRevisionId: mark.attrs?.claimRevisionId, evidenceId: mark.attrs?.evidenceId, quote: mark.attrs?.quote } } : mark.type === 'source_evidence' ? { attrs: { passageId: mark.attrs?.passageId, packetId: mark.attrs?.packetId, quote: mark.attrs?.quote } } : {}) })) } : {}), ...(node.content ? { content: node.content.map(canonicalNode) } : {}) }
}
function payload() { return { content: { title: title.value, document: canonicalNode(editor.value?.getJSON() ?? { type: 'doc', content: [{ type: 'paragraph' }] }) }, contentMode: contentMode.value } }
const serialized = computed(() => { void editEpoch.value; return JSON.stringify(payload()) })
const dirty = computed(() => baseline.value !== serialized.value)
const readonly = computed(() => !!props.archived || !state.value?.articleSelected)
const activeJob = computed(() => sourceActive.value || jobs.value.some(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)))
const approvePlanMessage = 'Схваліть поточний план статті, щоб створити пропозицію.'
const generationPrerequisite = computed(() => {
  const editorial = state.value?.editorial
  if (!editorial?.brief?.currentRevision) return 'Спочатку збережіть бриф.'
  const { outline } = editorial
  if (outline?.currentRevision?.briefRevisionId && editorial.brief.currentRevision.id
    && outline.currentRevision.briefRevisionId !== editorial.brief.currentRevision.id) {
    return 'Бриф змінився. Оновіть і схваліть план для поточного брифу.'
  }
  if (!outline?.currentApprovedRevisionId || outline.currentRevision === null
    || (outline.currentRevision?.id && outline.currentRevision.id !== outline.currentApprovedRevisionId)) return approvePlanMessage
  return generationPrerequisiteError.value
})
const generateUnavailableReason = computed(() => busy.value ? 'Зачекайте, поки завершиться поточна дія.'
  : conflict.value ? 'Узгодьте зміни статті перед створенням пропозиції.'
    : recovered.value ? 'Спочатку виберіть, чи відновити незбережену чернетку.'
      : activeJob.value ? 'Зачекайте завершення поточної генерації.' : generationPrerequisite.value)
const actionableJobs = computed(() => jobs.value.filter(job => !['SUCCEEDED', 'CANCELLED'].includes(job.status)))
const completedJobs = computed(() => jobs.value.filter(job => ['SUCCEEDED', 'CANCELLED'].includes(job.status)))
const proposals = computed(() => state.value?.article?.versions.filter(version => version.origin === 'AI' && version.status === 'PROPOSED' && version.id !== state.value?.article?.draft?.baseVersionId) ?? [])
const languageCandidates = computed(() => [...new Set(languageSuggestions.value.map(item => item.resultVersionId).filter((id): id is string => !!id))].map(id => state.value?.article?.versions.find(version => version.id === id)).filter((item): item is Version => !!item))
const importedCandidates = computed(() => state.value?.article?.versions.filter(version => version.origin === 'UNVERIFIED_IMPORTED' && version.status === 'PROPOSED' && version.id !== state.value?.article?.draft?.baseVersionId) ?? [])
const saveStatus = computed(() => saving.value ? 'Зберігаємо…' : conflict.value ? 'Потрібно узгодити зміни' : error.value && dirty.value ? 'Не збережено' : dirty.value ? 'Є незбережені зміни' : 'Збережено')
const approval = computed(() => state.value?.article?.versions.find(version => version.id === state.value?.article?.currentApprovedVersionId))
const annotationVersion = computed(() => {
  const article = state.value?.article
  const versionId = article?.draft?.baseVersionId ?? article?.currentApprovedVersionId ?? article?.versions[0]?.id ?? null
  const version = article?.versions.find(row => row.id === versionId)
  return { id: versionId, contentHash: article?.draft?.baseVersionId === versionId ? article.draft.sha256 ?? version?.sha256 ?? null : version?.sha256 ?? null }
})
const languageSourceCurrent = computed(() => {
  const draft = state.value?.article?.draft
  const source = state.value?.article?.versions.find(row => row.id === annotationVersion.value.id)
  return !dirty.value && !!draft && !!source?.sha256 && draft.baseVersionId === source.id && draft.sha256 === source.sha256
})
async function loadLanguageSuggestions() {
  const sourceRevisionId = annotationVersion.value.id
  const requestId = ++languageRequest
  if (!sourceRevisionId) { languageSuggestions.value = []; return }
  try {
    const params = new URLSearchParams({ targetType: 'ARTICLE', sourceRevisionId })
    const response = await fetch(`${base}/language-suggestions?${params}`, { credentials: 'same-origin', signal: controller.signal })
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) return
    const result = (await response.json() as { suggestions: LanguageSuggestion[] }).suggestions
    if (!Array.isArray(result)) return
    if (requestId !== languageRequest || annotationVersion.value.id !== sourceRevisionId) return
    languageSuggestions.value = result
    selectedLanguageIds.value = selectedLanguageIds.value.filter(id => languageSuggestions.value.some(item => item.id === id && item.status === 'OPEN' && !item.stale))
  } catch { /* Language review is secondary; saved article content remains available. */ }
}
async function reviewLanguage() {
  if (languageBusy.value || readonly.value) return
  languageBusy.value = true; languageMessage.value = ''; error.value = ''
  try {
    if (!await save()) return
    const draft = state.value?.article?.draft
    const baseVersion = state.value?.article?.versions.find(item => item.id === draft?.baseVersionId)
    if (dirty.value || !annotationVersion.value.id || !baseVersion || draft?.sha256 !== baseVersion.sha256) await action('/article/checkpoint')
    const sourceRevisionId = annotationVersion.value.id
    const exactVersion = state.value?.article?.versions.find(item => item.id === sourceRevisionId)
    if (dirty.value || !sourceRevisionId || !exactVersion?.sha256 || !state.value?.article?.draft?.sha256 || state.value.article.draft.sha256 !== exactVersion.sha256) throw new Error('Збережіть версію статті перед мовною перевіркою.')
    const requestId = ++languageRequest
    const response = await fetch(`${base}/language-suggestions/review`, { credentials: 'same-origin', signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify({ targetType: 'ARTICLE', sourceRevisionId, expectedRevision: state.value?.article?.revision }) })
    if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
    if (!response.ok) throw new Error(response.status === 409 ? 'Поточна версія змінилася. Оновіть статтю й повторіть перевірку.' : 'Не вдалося перевірити пробіли.')
    const suggestions = (await response.json() as { suggestions: LanguageSuggestion[] }).suggestions
    if (disposed || requestId !== languageRequest || annotationVersion.value.id !== sourceRevisionId) return
    languageSuggestions.value = suggestions
    selectedLanguageIds.value = languageSuggestions.value.filter(item => item.status === 'OPEN' && !item.stale).map(item => item.id)
    languageMessage.value = languageSuggestions.value.length ? 'Виберіть, які виправлення застосувати.' : 'Зайвих пробілів не знайдено.'
  } catch (cause) { if (!disposed) languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося перевірити пробіли.' }
  finally { languageBusy.value = false }
}
async function mutateLanguage(path: string, body: unknown) {
  if (languageBusy.value || readonly.value || dirty.value || !languageSourceCurrent.value || !state.value?.article) return
  const mutationSource = annotationVersion.value.id
  languageBusy.value = true; languageMessage.value = ''
  try {
    const response = await fetch(`${base}/language-suggestions${path}`, { credentials: 'same-origin', signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) })
    if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
    if (!response.ok) throw new Error(response.status === 409 ? 'Поточна версія змінилася. Повторіть перевірку перед застосуванням виправлень.' : 'Не вдалося оновити виправлення.')
    if (disposed || annotationVersion.value.id !== mutationSource) return
    if (path === '/accept') {
      const result = await response.json() as { candidateVersionId?: string }
      await load()
      selectedLanguageIds.value = []
      candidate.value = result.candidateVersionId ? state.value?.article?.versions.find(version => version.id === result.candidateVersionId) ?? null : null
      if (candidate.value) inspector.value = 'proposal'
      languageMessage.value = candidate.value ? 'Створено непогоджену версію. Перегляньте її та застосуйте явно.' : 'Створено непогоджену версію. Знайдіть її в історії та застосуйте явно.'
    }
    await loadLanguageSuggestions()
  } catch (cause) { if (!disposed) languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося оновити мовні пропозиції.' }
  finally { languageBusy.value = false }
}
function acceptLanguage() {
  const first = languageSuggestions.value.find(item => selectedLanguageIds.value.includes(item.id) && item.status === 'OPEN' && !item.stale)
  if (!first || !selectedLanguageIds.value.length || !languageSourceCurrent.value) return
  void mutateLanguage('/accept', { targetType: 'ARTICLE', sourceRevisionId: first.sourceRevisionId, expectedRevision: state.value?.article?.revision, suggestionIds: [...selectedLanguageIds.value] })
}
function rejectLanguage(item: LanguageSuggestion) { if (!languageSourceCurrent.value) return; void mutateLanguage(`/${encodeURIComponent(item.id)}/reject`, { expectedRevision: state.value?.article?.revision }) }
watch(() => annotationVersion.value.id, () => { void loadLanguageSuggestions() })
function dependencyStatus(reasons: string[]) {
  const labels: Record<string, string> = { WORKSPACE_STYLE_CHANGED: 'змінився стиль простору', BRIEF_CHANGED: 'змінився бриф', OUTLINE_CHANGED: 'змінилася погоджена структура', INVALID_ORIGINAL_EVIDENCE: 'початкові докази статті втратили придатність' }
  return reasons.map(reason => labels[reason] ?? 'змінилися редакційні залежності').join('; ')
}
watch([readonly, languageBusy], ([isReadonly, reviewing]) => editor.value?.setEditable(!isReadonly && !reviewing))
watch([title, contentMode], () => changed())
function resizeTitle() {
  const input = titleInput.value
  if (!input) return
  input.style.height = 'auto'
  input.style.height = `${Math.ceil(input.scrollHeight) + 2}px`
}
watch(titleInput, input => {
  titleObserver?.disconnect()
  titleObservedWidth = 0
  if (!input) return
  titleObserver ??= new ResizeObserver(entries => {
    const width = entries[0]?.contentRect.width ?? 0
    if (Math.abs(width - titleObservedWidth) < 0.5) return
    titleObservedWidth = width
    resizeTitle()
  })
  titleObserver.observe(input)
})
watch([title, titleInput, inspector], () => { void nextTick(resizeTitle) })
function resetContents(event: MediaQueryListEvent) { contentsOpen.value = event.matches }
function navigateArticle(id: string) { document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' }) }
watch(inspector, async (value, previous) => {
  if (previous === 'proposal' && value !== 'proposal') { proposalEvidenceOpen.value = false; sourcePassageRequest++ }
  if (value === 'proposal' && previous !== 'proposal') proposalView.value = 'suggested'
  if (value && !previous) {
    inspectorOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    inspectorReadingPosition = { left: window.scrollX, top: window.scrollY }
  }
  await nextTick()
  if (disposed) return
  if (value) {
    inspectorHeading.value?.focus({ preventScroll: true })
    if (!contentsViewport?.matches) inspectorHeading.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  else if (previous) {
    if (inspectorOpener?.isConnected) inspectorOpener.focus({ preventScroll: true })
    else editor.value?.view.dom.focus({ preventScroll: true })
    window.scrollTo({ ...inspectorReadingPosition, behavior: 'instant' })
  }
})
watch(proposalView, () => { if (proposalEvidenceOpen.value) { proposalEvidenceOpen.value = false; sourcePassageRequest++ } })
onMounted(() => {
  contentsViewport = window.matchMedia('(min-width: 901px)')
  contentsOpen.value = contentsViewport.matches
  contentsViewport.addEventListener('change', resetContents)
  window.addEventListener('resize', resizeTitle)
  void document.fonts.ready.then(() => { if (!disposed) resizeTitle() })
})
onBeforeUnmount(() => { titleObserver?.disconnect(); window.removeEventListener('resize', resizeTitle); contentsViewport?.removeEventListener('change', resetContents) })
function retain() { if (sessionEnded || !props.userId || hydration || !dirty.value) return; try { sessionStorage.setItem(recoveryKey, JSON.stringify({ ...payload(), expectedRevision: expectedRevision.value })) } catch { /* Browser quota does not discard the live editor. */ } }
function changed() { if (hydration || disposed) return; savedCheckpoint.value = false; editEpoch.value++; retain(); clearTimeout(saveTimer); if (!conflict.value && !recovered.value) saveTimer = setTimeout(() => void save(), 700) }
function populate(draft?: Draft | null) {
  hydration = true
  savedCheckpoint.value = false
  title.value = draft?.content.title ?? props.projectTopic
  contentMode.value = draft?.contentMode ?? (state.value?.editorial.brief?.currentRevision?.contentMode === 'FACTUAL' ? 'FACTUAL' : 'CREATIVE')
  editor.value?.commands.setContent(draft?.content.document ?? { type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false })
  editEpoch.value++; baseline.value = serialized.value; expectedRevision.value = state.value?.article?.revision ?? 0; hydration = false
}
async function request(path: string, body?: unknown, editorOnly = false) {
  const headers = new Headers(editorOnly ? { 'X-ContextFlow-View': 'editor' } : {})
  if (body !== undefined) { headers.set('Content-Type', 'application/json'); headers.set('X-CSRF-Token', props.csrfToken) }
  const response = await fetch(`${base}${path}`, { credentials: 'same-origin', signal: controller.signal, headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    if (body === undefined && path === '/article' && (response.status === 403 || response.status === 404)) {
      state.value = null
      passageOptions.value = []
      closeInspector()
      retain()
      editor.value?.setEditable(false)
    }
    if (body === undefined && path === '/article') throw new Error('Не вдалося завантажити статтю. Спробуйте ще раз.')
    if (response.status === 409) {
      const problem = await response.json().catch(() => null) as { message?: unknown; error?: string } | null
      const message = problem?.message
      if (problem?.error === 'REVISION_CONFLICT' || message === 'Article changed; retain local text and reload before saving'
        || message === 'Article changed; reload before generating' || message === 'Article changed; reload before generation') {
        conflict.value = true
        throw new Error('З’явилася новіша версія чернетки. Ваш текст залишився в редакторі.')
      }
      if (path === '/article/source-prepare' || path === '/article/generate') {
        if (message === 'Approve the current factual outline before preparing a source article'
          || message === 'Generate from the latest brief and current approved outline') throw new GenerationPrerequisiteError(approvePlanMessage)
        if (message === 'Brief or workspace style changed; save a new brief revision'
          || message === 'Save a factual brief before preparing a source article') throw new GenerationPrerequisiteError('Збережіть актуальний бриф і схваліть його план.')
        if (message === 'Add at least one included factual source') throw new Error('Додайте й включіть у бриф хоча б одне готове джерело.')
        if (message === 'Accept the current external-processing notice before preparing a source article') throw new Error('Підтвердьте умови обробки даних проєкту перед генерацією.')
        throw new Error('Не вдалося запустити генерацію. Перевірте бриф, план і джерела.')
      }
      if (message === 'Article changed after generation; preserve local work') throw new Error('Чернетка змінилася після генерації. Створіть нову пропозицію для поточного тексту.')
      throw new Error('Дія недоступна для поточної версії. Перевірте її стан і передумови.')
    }
    throw new Error(response.status === 503 ? 'AI-генерація тимчасово недоступна. Ви можете продовжувати редагування.' : response.status === 400 ? 'Перевірте текст, посилання на уривки джерел та актуальність брифу.' : 'Не вдалося виконати дію. Ваш текст залишився в редакторі, повторіть спробу.')
  }
  return response.json()
}
const detailsLoading = ref(false)
const detailsError = ref('')
const openingError = ref('')
let active = true
async function load(reset = false) {
  const previous = state.value
  const latest = await request('/article', undefined, true) as State
  if (disposed || (!reset && (state.value !== previous || saving.value || (latest.article?.revision ?? 0) < expectedRevision.value))) return false
  state.value = latest
  generationPrerequisiteError.value = ''
  passageOptions.value = state.value.eligibleSourcePassages ?? []
  if (reset) populate(state.value.article?.draft)
  editor.value?.setEditable(!readonly.value)
  if (inspector.value === 'history' || inspector.value === 'evidence') void loadDetails()
  return true
}
async function loadDetails() {
  const previous = state.value
  if (detailsLoading.value || !previous || !active) return
  detailsLoading.value = true; detailsError.value = ''
  let retry = false
  try {
    const detail = await request('/article') as State
    if (active && state.value && (detail.article?.revision ?? 0) === expectedRevision.value) {
      state.value = detail; passageOptions.value = detail.eligibleSourcePassages ?? []
    } else if (state.value && state.value !== previous) retry = true
    else if (active) detailsError.value = 'Стаття змінилася. Оновіть редактор, щоб відкрити актуальні версії та джерела.'
  } catch { if (active) detailsError.value = 'Не вдалося завантажити версії та джерела.' }
  finally {
    detailsLoading.value = false
    if (retry && (inspector.value === 'history' || inspector.value === 'evidence')) void loadDetails()
  }
}
watch(inspector, value => { if (value === 'history' || value === 'evidence') void loadDetails() })
async function save(): Promise<boolean> {
  clearTimeout(saveTimer)
  if (inFlight) { const ok = await inFlight; return ok && dirty.value ? save() : ok }
  if (!dirty.value) return true
  if (readonly.value || conflict.value || recovered.value || !title.value.trim()) return false
  const submitted = payload(); const submittedBytes = JSON.stringify(submitted)
  saving.value = true; error.value = ''
  inFlight = (async () => {
    try {
      const result = await request('/article/draft', { ...submitted, expectedRevision: expectedRevision.value }, inspector.value !== 'history' && inspector.value !== 'evidence') as State
      if (disposed) return false
      state.value = result; expectedRevision.value = result.article?.revision ?? expectedRevision.value; baseline.value = submittedBytes
      generationPrerequisiteError.value = ''
      if (!dirty.value) sessionStorage.removeItem(recoveryKey); else retain()
      return true
    } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти.'; return false }
    finally { saving.value = false; inFlight = null }
  })()
  const ok = await inFlight
  return ok && dirty.value && !disposed ? save() : ok
}
async function action(path: string, extra: object = {}, replace = false, approve = false) {
  if (busy.value || readonly.value || !await save() || busy.value || disposed) return
  busy.value = true; error.value = ''; if (replace || approve) editor.value?.setEditable(false, false)
  try {
    const checkpoint = path === '/article/checkpoint'
    if (checkpoint) savedCheckpoint.value = false
    state.value = await request(path, { expectedRevision: expectedRevision.value, ...extra }, checkpoint) as State
    expectedRevision.value = state.value.article?.revision ?? expectedRevision.value
    if (checkpoint) {
      savedCheckpoint.value = !dirty.value
      const article = state.value.article
      const versionId = article?.draft?.baseVersionId
      if (approve && versionId && article.currentApprovedVersionId !== versionId && !dirty.value && !disposed) {
        state.value = await request(`/article/${versionId}/approve`, { expectedRevision: expectedRevision.value }) as State
        expectedRevision.value = state.value.article?.revision ?? expectedRevision.value
        savedCheckpoint.value = false
      }
      if (inspector.value === 'history' || inspector.value === 'evidence') void loadDetails()
    }
    if (replace) { populate(state.value.article?.draft); closeInspector(); candidate.value = null }
  }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { busy.value = false; if (replace || approve) editor.value?.setEditable(!readonly.value, false) }
}
async function refreshInputs() { if (!await save()) return; const submittedBytes = serialized.value; busy.value = true; try { state.value = await request('/article/draft', { ...payload(), expectedRevision: expectedRevision.value, refreshInputs: true }) as State; expectedRevision.value = state.value.article?.revision ?? expectedRevision.value; baseline.value = submittedBytes; error.value = ''; if (dirty.value) changed() } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Контекст недоступний.' } finally { busy.value = false } }
async function reconcile(useLocal: boolean) {
  clearTimeout(saveTimer)
  try { await load(!useLocal); expectedRevision.value = state.value?.article?.revision ?? 0; conflict.value = false; error.value = ''; recovered.value = null; if (useLocal) { baseline.value = ''; await save() } else sessionStorage.removeItem(recoveryKey) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити.' }
}
function discardRecovery() { recovered.value = null; sessionStorage.removeItem(recoveryKey) }
function restore() { const data = recovered.value; if (!data) return; hydration = true; title.value = data.content.title; contentMode.value = data.contentMode; editor.value?.commands.setContent(data.content.document, { emitUpdate: false }); editEpoch.value++; hydration = false; recovered.value = null; expectedRevision.value = data.expectedRevision; conflict.value = expectedRevision.value !== (state.value?.article?.revision ?? 0); retain(); if (!conflict.value) void save() }
function closeInspector() { sourcePassageRequest++; inspector.value = null }
function openGoogleDocs() { googleDocsVisited.value = true; inspector.value = inspector.value === 'google-docs' ? null : 'google-docs' }
function selectionAnchor() {
  const current = editor.value
  if (!current || current.state.selection.empty) return null
  const { selection } = current.state
  const from = selection.$from, to = selection.$to
  if (!from.parent.isTextblock || from.parent !== to.parent || from.before() !== to.before()) return null
  const blocks: { position: number; start: number; text: string }[] = []
  let offset = 0
  current.state.doc.descendants((node, position) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return
    if (blocks.length) offset += 2
    const start = offset
    let text = ''
    node.forEach(child => { text += child.type.name === 'hardBreak' ? '\n' : child.text ?? '' })
    blocks.push({ position, start, text })
    offset += text.length
  })
  const entry = blocks.find(row => row.position === from.before())
  if (!entry) return null
  const start = entry.start + from.parentOffset
  const end = entry.start + to.parentOffset
  if (end <= start || end > entry.start + entry.text.length) return null
  const quote = entry.text.slice(from.parentOffset, to.parentOffset)
  const actual = current.state.doc.textBetween(selection.from, selection.to, '\n')
  return quote && quote === actual ? { start, end, quote } : null
}
async function openAnnotations() {
  if (inspector.value === 'annotations') { inspector.value = null; return }
  annotationAnchor.value = selectionAnchor()
  if (annotationAnchor.value && !readonly.value) {
    if (!await save()) { error.value = error.value || 'Збережіть чернетку, щоб додати коментар до її версії.'; return }
    try {
      const checkpoint = await request('/article/checkpoint', { expectedRevision: expectedRevision.value }, true) as State
      state.value = checkpoint
      expectedRevision.value = checkpoint.article?.revision ?? expectedRevision.value
    } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося зафіксувати версію статті.'; return }
  }
  inspector.value = 'annotations'
}
async function annotationCandidateCreated(versionId: string) {
  try {
    const refreshed = await request('/article') as State
    state.value = refreshed
    expectedRevision.value = refreshed.article?.revision ?? expectedRevision.value
    candidate.value = refreshed.article?.versions.find(version => version.id === versionId) ?? null
    if (candidate.value) inspector.value = 'proposal'
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити версію статті.' }
}
async function closeProposalEvidence() {
  sourcePassageRequest++
  proposalEvidenceOpen.value = false
  await nextTick()
  if (proposalEvidenceOpener?.isConnected) proposalEvidenceOpener.focus({ preventScroll: true })
}
async function openSourcePassage(passageId: string, packetId: string, versionId?: string, citationId?: string) {
  const fromProposal = inspector.value === 'proposal'
  const requestId = ++sourcePassageRequest
  if (fromProposal) {
    activeProposalCitation.value = citationId ?? null
    proposalEvidenceOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    selectedPassage.value = null
    proposalEvidenceLoading.value = true
    proposalEvidenceOpen.value = true
    void nextTick(() => proposalEvidenceHeading.value?.focus({ preventScroll: true }))
  }
  let requestPanel = inspector.value
  sourceError.value = ''; sourceText.value = ''
  try {
    let passage = passageOptions.value.find(row => row.passageId === passageId && row.packetId === packetId)
    const sourceVersionId = versionId ?? state.value?.article?.draft?.baseVersionId
    if (!passage && sourceVersionId) {
      const result = await request(`/article/${sourceVersionId}/source-passages`) as { passages: SourcePassage[] }
      passage = result.passages.find(row => row.passageId === passageId && row.packetId === packetId)
    }
    if (!passage && !versionId) {
      const detail = await request('/article') as State
      passage = detail.eligibleSourcePassages?.find(row => row.passageId === passageId && row.packetId === packetId)
    }
    if (requestId !== sourcePassageRequest || requestPanel !== inspector.value) return
    if (!passage) throw new Error('Уривок недоступний у цій версії статті.')
    selectedPassage.value = passage
    if (!fromProposal) { inspector.value = 'evidence'; requestPanel = 'evidence' }
    const result = await request(`/materials/${passage.materialId}/snapshots/${passage.snapshotId}`) as { snapshot: { normalizedText: string } }
    if (requestId !== sourcePassageRequest || requestPanel !== inspector.value) return
    if (result.snapshot.normalizedText.slice(passage.startOffset,passage.endOffset) !== passage.quote) throw new Error('Посилання не відповідає збереженому джерелу.')
    sourceText.value = result.snapshot.normalizedText
  } catch (cause) {
    if (requestId === sourcePassageRequest && requestPanel === inspector.value) sourceError.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити джерело.'
  } finally {
    if (requestId === sourcePassageRequest) proposalEvidenceLoading.value = false
  }
}
function linkSourcePassage(item: SourcePassage) {
  const current = editor.value
  if (!current || current.state.selection.empty) { error.value = 'Спочатку виділіть речення в статті.'; return }
  current.chain().focus().unsetMark('evidence').unsetMark('source_evidence')
    .setMark('source_evidence',{ passageId: item.passageId,packetId: item.packetId,quote: item.quote }).run()
  sourcePassageRequest++
  sourceText.value = ''
  sourceError.value = ''
  selectedPassage.value = item
}
class GenerationPrerequisiteError extends Error {}
async function generate() {
  if (generateUnavailableReason.value || !await save() || generateUnavailableReason.value) return
  commandKey ??= crypto.randomUUID()
  busy.value = true
  error.value = ''
  try {
    const input = { expectedRevision: expectedRevision.value, commandKey }
    if (state.value?.editorial.brief?.currentRevision?.contentMode === 'FACTUAL') {
      sourceRequest.value = (await request('/article/source-prepare', input) as { request: SourceRequest }).request
      sessionStorage.setItem(`${recoveryKey}:source-request`, sourceRequest.value.id)
    } else {
      const result = await request('/article/generate', input) as { job: Job }
      requestedArticleJobId = result.job.id
      sessionStorage.setItem(`${recoveryKey}:article-job`, result.job.id)
    }
    commandKey = null
    await poll()
  } catch (cause) {
    if (cause instanceof GenerationPrerequisiteError) generationPrerequisiteError.value = cause.message
    else error.value = cause instanceof Error ? cause.message : 'Не вдалося створити пропозицію.'
  }
  finally { busy.value = false }
}
async function cancelSourceRequest() {
  if (!sourceRequest.value || busy.value) return
  busy.value = true
  try { sourceRequest.value = (await request(`/source-writing/${sourceRequest.value.id}/cancel`,{}) as { request: SourceRequest }).request; sessionStorage.removeItem(`${recoveryKey}:source-request`) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося скасувати підготовку.' }
  finally { busy.value = false }
}
function format(kind: string) { const chain = editor.value?.chain().focus(); if (!chain) return; if (kind === 'bold') chain.toggleBold().run(); if (kind === 'italic') chain.toggleItalic().run(); if (kind === 'heading') chain.toggleHeading({ level: 2 }).run(); if (kind === 'list') chain.toggleBulletList().run() }
function inspectEvidence(event: Event) { if (!showEvidenceMarks.value) return false; const source = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-passage-id]'); if (source?.dataset.passageId && source.dataset.packetId) { event.preventDefault(); void openSourcePassage(source.dataset.passageId, source.dataset.packetId); return true }; return false }
watch(showEvidenceMarks, enabled => { if (!enabled) sourcePassageRequest++ })
async function importReady() { if (!importedText.value.trim() || busy.value) return; busy.value = true; try { const content: Content = { title: title.value || props.projectTopic, document: { type: 'doc', content: importedText.value.split(/\n\s*\n/).filter(Boolean).map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) } }; state.value = await request('/article/import', { expectedRevision: expectedRevision.value, contentMode: contentMode.value, content }) as State; populate(state.value.article?.draft); sessionStorage.removeItem(recoveryKey); importedText.value = ''; inspector.value = null } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося додати статтю.' } finally { busy.value = false } }
async function poll() {
  clearTimeout(pollTimer)
  if (disposed || !active || document.hidden || polling) return
  polling = true
  try {
    if (sourceActive.value && sourceRequest.value) {
      sourceRequest.value = (await request(`/source-writing/${sourceRequest.value.id}`) as { request: SourceRequest }).request
      sourceResultPending = sourceRequest.value.stage === 'SUCCEEDED'
      if (!sourceActive.value && !sourceResultPending && !sourceRequest.value.partialArticle) sessionStorage.removeItem(`${recoveryKey}:source-request`)
    }
    const result = await request('/jobs') as { jobs: Job[] }
    jobs.value = result.jobs.filter(job => job.operation === 'ARTICLE_GENERATION')
    const completed = jobs.value.filter(job => job.status === 'SUCCEEDED').map(job => job.id).join(',')
    if (sourceResultPending || completed !== loadedJobResults) {
      if (!await load()) return
      loadedJobResults = completed
      const requestedJob = jobs.value.find(job => job.id === requestedArticleJobId)
      const versionId = (sourceResultPending ? sourceRequest.value?.resultRefs?.articleVersionId : undefined) ?? (requestedJob?.status === 'SUCCEEDED' ? requestedJob.resultRefs?.articleVersionId : undefined)
      const proposal = state.value?.article?.versions.find(version => version.id === versionId && version.origin === 'AI' && version.status === 'PROPOSED')
      if (proposal) { candidate.value = proposal; inspector.value = 'proposal' }
      if (requestedJob && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(requestedJob.status)) { requestedArticleJobId = null; sessionStorage.removeItem(`${recoveryKey}:article-job`) }
      if (sourceResultPending) {
        sourceResultPending = false
        sessionStorage.removeItem(`${recoveryKey}:source-request`)
      }
    }
  } catch { /* Retry the lightweight status check without replacing the editor. */ }
  finally {
    polling = false
    if (!disposed && active && !document.hidden) {
      pollTimer = setTimeout(() => void poll(), activeJob.value || sourceResultPending ? 2000 : 60_000)
    }
  }
}
function refreshVisibleArticle() {
  if (document.hidden) clearTimeout(pollTimer)
  else void poll()
}
async function jobAction(job: Job, kind: 'retry' | 'cancel') { try { await request(`/jobs/${job.id}/${kind}`, {}); await poll() } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Дія недоступна.' } }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { retain(); event.preventDefault(); event.returnValue = '' } }
function endSession() { sessionEnded = true; disposed = true; controller.abort(); clearTimeout(saveTimer); clearTimeout(pollTimer); hydration = true; title.value = ''; editor.value?.commands.clearContent(false); recovered.value = null; state.value = null }
async function openArticle() {
  openingError.value = ''
  try {
    await load(true)
    const pending = sessionStorage.getItem(`${recoveryKey}:source-request`)
    if (pending) sourceRequest.value = { id: pending, stage: 'GENERATING', errorCategory: null }
    requestedArticleJobId = sessionStorage.getItem(`${recoveryKey}:article-job`)
    const saved = sessionStorage.getItem(recoveryKey)
    if (saved) recovered.value = JSON.parse(saved) as typeof recovered.value
    void poll()
  } catch { if (!disposed) openingError.value = 'Не вдалося відкрити статтю.' }
  finally { loading.value = false }
}
onMounted(() => {
  window.addEventListener('cf:article-session-ended', endSession)
  window.addEventListener('beforeunload', beforeUnload)
  document.addEventListener('visibilitychange', refreshVisibleArticle)
  void openArticle()
})
onDeactivated(() => { active = false; clearTimeout(pollTimer) })
onActivated(async () => {
  const returning = !active
  active = true
  if (!returning || disposed) return
  if (!state.value) { await openArticle(); return }
  const previous = state.value
  try {
    const latest = await request('/article', undefined, true) as State
    if (active && !disposed && state.value === previous) {
      openingError.value = ''
      generationPrerequisiteError.value = ''
      if (dirty.value || saving.value || busy.value || conflict.value || recovered.value) previous.editorial = latest.editorial
      else {
        const changedRevision = (latest.article?.revision ?? 0) !== expectedRevision.value
        state.value = latest; passageOptions.value = latest.eligibleSourcePassages ?? []
        if (changedRevision) populate(latest.article?.draft)
        if (inspector.value === 'history' || inspector.value === 'evidence') void loadDetails()
      }
    }
  } catch { if (active && !disposed) openingError.value = 'Не вдалося оновити статтю.' }
  void poll()
})
watch(() => props.openHistory, open => { if (open) inspector.value = 'history' }, { immediate: true })
onBeforeUnmount(() => { retain(); disposed = true; controller.abort(); clearTimeout(saveTimer); clearTimeout(pollTimer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('cf:article-session-ended', endSession); document.removeEventListener('visibilitychange', refreshVisibleArticle); editor.value?.destroy() })
</script>

<template>
  <section
    class="article-workspace"
    :data-workspace-leave-risk="!loading && (dirty || saving || busy || !!recovered)"
    aria-labelledby="article-heading"
  >
    <header class="article-boundary">
      <div class="article-title-status">
        <h1 id="article-heading">
          Стаття
        </h1>
        <p
          v-if="approval"
          class="article-approved"
        >
          Погоджено, версія {{ approval.number }}
        </p>
      </div><span
        role="status"
        aria-live="polite"
      ><span v-if="!loading">{{ readonly ? 'Перегляд' : 'Чернетка' }} </span><span>{{ loading ? 'Відкриваємо…' : saveStatus }}</span></span>
    </header>
    <p
      v-if="loading"
      role="status"
    >
      Відкриваємо статтю…
    </p>
    <p
      v-if="openingError"
      role="alert"
      class="article-error"
    >
      {{ openingError }}
      <Button
        v-if="!state"
        variant="outline"
        @click="openArticle"
      >
        Відкрити ще раз
      </Button>
    </p>
    <p
      v-if="error"
      role="alert"
      class="article-error"
    >
      {{ error }} <Button
        v-if="!conflict && dirty"
        class="workspace-button"
        variant="outline"
        :disabled="saving"
        @click="save"
      >
        Повторити збереження
      </Button>
    </p>
    <div
      v-if="conflict"
      class="article-notice"
    >
      <p>Виберіть, з яким текстом продовжити.</p><Button
        class="workspace-button"
        variant="outline"
        @click="reconcile(true)"
      >
        Зберегти мій текст як нову чернетку
      </Button><Button
        class="workspace-button"
        variant="ghost"
        @click="reconcile(false)"
      >
        Відкрити збережений текст
      </Button>
    </div>
    <div
      v-if="recovered"
      class="article-notice"
    >
      <p>Залишилася незбережена чернетка з попереднього відвідування.</p><Button
        class="workspace-button workspace-button-primary"
        @click="restore"
      >
        Відновити мою чернетку
      </Button><Button
        class="workspace-button"
        variant="ghost"
        @click="discardRecovery"
      >
        Залишити серверний текст
      </Button>
    </div>
    <template v-if="state && !loading">
      <p
        v-if="readonly"
        class="article-notice"
      >
        {{ archived ? 'Архівована стаття доступна для перегляду.' : 'Статтю не вибрано серед результатів проєкту. Історія залишається доступною.' }}
      </p>
      <p
        v-if="state.article?.draft?.origin === 'UNVERIFIED_IMPORTED'"
        class="article-notice"
      >
        Готова стаття · Не перевірено. Перегляньте текст і перевірте посилання на уривки джерел перед погодженням.
      </p>
      <p
        v-if="state.staleReasons.length"
        class="article-notice"
      >
        Потребує перегляду: {{ dependencyStatus(state.staleReasons) }}. Перевірте текст перед оновленням контексту. <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || conflict || readonly"
          @click="refreshInputs"
        >
          Оновити контекст чернетки
        </Button>
      </p>
      <p
        v-if="!readonly && generationPrerequisite"
        class="article-notice"
        role="status"
      >
        {{ generationPrerequisite }}
        <Button
          class="workspace-button"
          variant="ghost"
          @click="emit('open-brief')"
        >
          Відкрити бриф і план
        </Button>
      </p>
      <div
        v-if="!readonly"
        class="article-actions"
      >
        <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || conflict || !!recovered"
          @click="inspector = inspector === 'import' ? null : 'import'"
        >
          Додати готову статтю
        </Button><span
          class="article-generate-wrap"
          :tabindex="generateUnavailableReason ? 0 : undefined"
          :aria-describedby="generateUnavailableReason ? 'article-generate-reason' : undefined"
        ><Button
          class="workspace-button"
          variant="outline"
          :disabled="!!generateUnavailableReason"
          @click="generate"
        >Запропонувати статтю</Button><span
          v-if="generateUnavailableReason"
          id="article-generate-reason"
          class="article-generate-tooltip"
          role="tooltip"
        >{{ generateUnavailableReason }}</span></span><Button
          class="workspace-button"
          variant="ghost"
          @click="inspector = inspector === 'history' ? null : 'history'"
        >
          Історія версій
        </Button><Button
          class="workspace-button"
          variant="ghost"
          @click="openAnnotations"
        >
          Коментарі й правки
        </Button><Button
          class="workspace-button"
          variant="ghost"
          @click="openGoogleDocs"
        >
          Google Документи
        </Button>
      </div>
      <div
        v-else
        class="article-actions"
      >
        <Button
          class="workspace-button"
          variant="ghost"
          @click="inspector = 'history'"
        >
          Історія версій
        </Button><Button
          class="workspace-button"
          variant="ghost"
          @click="openAnnotations"
        >
          Коментарі й правки
        </Button><Button
          class="workspace-button"
          variant="ghost"
          @click="openGoogleDocs"
        >
          Google Документи
        </Button>
      </div>
      <p
        v-if="sourceRequest"
        role="status"
      >
        {{ sourceProgress }} <Button
          v-if="sourceActive"
          variant="ghost"
          :disabled="busy"
          @click="cancelSourceRequest"
        >
          Скасувати підготовку статті
        </Button>
      </p>
      <details
        v-if="sourceRequest?.partialArticle"
        class="article-notice"
      >
        <summary>Переглянути частковий результат</summary>
        <h2>{{ sourceRequest.partialArticle.content.title }}</h2>
        <ArticlePreview
          :document="sourceRequest.partialArticle.content.document"
          :static-citations="true"
        />
      </details>
      <div
        v-if="state.article || state.articleSelected"
        class="article-layout"
        :class="{ 'with-inspector': inspector, 'with-proposal': inspector === 'proposal', 'with-proposal-evidence': inspector === 'proposal' && proposalEvidenceOpen }"
      >
        <aside
          v-show="!inspector"
          class="article-contents"
        >
          <details
            :open="contentsOpen"
            @toggle="contentsOpen = ($event.target as HTMLDetailsElement).open"
          >
            <summary>
              Зміст <svg
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              ><path d="m6 9 6 6 6-6" /></svg>
            </summary>
            <nav aria-label="Зміст статті">
              <a
                href="#article-start"
                @mousedown.prevent
                @click.prevent="navigateArticle('article-start')"
              >Вступ</a>
              <a
                v-for="section in sections"
                :key="section.id"
                :href="`#${section.id}`"
                :class="{ subsection: section.level === 3 }"
                @mousedown.prevent
                @click.prevent="navigateArticle(section.id)"
              >{{ section.title }}</a>
            </nav>
          </details>
        </aside>
        <article
          v-show="inspector !== 'proposal'"
          id="article-start"
          class="article-paper"
          aria-label="Рукопис статті"
        >
          <label
            class="sr-only"
            for="article-title"
          >Заголовок статті</label><textarea
            id="article-title"
            ref="titleInput"
            v-model="title"
            maxlength="500"
            rows="2"
            :readonly="readonly || busy || languageBusy"
            class="article-title"
          />
          <div
            class="article-toolbar"
            role="toolbar"
            aria-label="Інструменти тексту"
          >
            <template v-if="!readonly">
              <button
                type="button"
                :aria-pressed="editor?.isActive('bold')"
                aria-label="Жирний"
                @click="format('bold')"
              >
                <strong aria-hidden="true">Ж</strong>
              </button><button
                type="button"
                :aria-pressed="editor?.isActive('italic')"
                aria-label="Курсив"
                @click="format('italic')"
              >
                <em aria-hidden="true">К</em>
              </button><button
                type="button"
                :aria-pressed="editor?.isActive('heading', { level: 2 })"
                @click="format('heading')"
              >
                Підзаголовок
              </button><button
                type="button"
                :aria-pressed="editor?.isActive('bulletList')"
                @click="format('list')"
              >
                Список
              </button><button
                type="button"
                @click="inspector = inspector === 'evidence' ? null : 'evidence'"
              >
                Доказ
              </button>
            </template>
            <button
              type="button"
              :aria-pressed="showEvidenceMarks"
              @click="showEvidenceMarks = !showEvidenceMarks"
            >
              Підкреслення доказів
            </button>
          </div>
          <EditorContent
            v-if="editor"
            :editor="editor"
            class="article-writing"
            :class="{ 'show-evidence-marks': showEvidenceMarks }"
          />
          <footer class="article-review">
            <p v-if="state.mappingIssues.length">
              Посилання потребують перегляду. Видаліть або повторно прив’яжіть змінене речення до доказу.
            </p><div v-if="!readonly">
              <label class="article-mode"><input
                v-model="contentMode"
                type="checkbox"
                true-value="FACTUAL"
                false-value="CREATIVE"
              > На основі джерел</label>
              <div class="article-save-actions">
                <Button
                  class="workspace-button"
                  variant="outline"
                  :disabled="busy || saving || conflict || !!recovered || !title.trim()"
                  @click="action('/article/checkpoint')"
                >
                  Зберегти версію
                </Button>
                <Button
                  class="workspace-button workspace-button-primary"
                  :disabled="busy || saving || conflict || !!recovered || !title.trim()"
                  @click="action('/article/checkpoint', {}, false, true)"
                >
                  Зберегти й погодити
                </Button>
              </div>
              <span
                v-if="savedCheckpoint"
                role="status"
              >Версію збережено.</span>
            </div>
          </footer>
          <section
            v-if="!readonly"
            class="article-language"
            aria-labelledby="article-language-heading"
          >
            <div class="article-language-heading">
              <h2 id="article-language-heading">
                Пробіли й пунктуація
              </h2>
              <Button
                class="workspace-button"
                variant="outline"
                :disabled="busy || saving || languageBusy || conflict || !!recovered"
                @click="reviewLanguage"
              >
                {{ languageBusy ? 'Перевіряємо…' : 'Перевірити' }}
              </Button>
            </div>
            <p>Шукає повторні пробіли та пробіли перед розділовими знаками.</p>
            <p
              v-if="languageMessage"
              role="status"
            >
              {{ languageMessage }}
            </p>
            <p
              v-if="languageSuggestions.length && !languageSourceCurrent"
              class="article-notice"
            >
              Збережіть і зафіксуйте поточний текст, щоб працювати з цими пропозиціями.
            </p>
            <article
              v-for="suggestion in languageSuggestions"
              :key="suggestion.id"
              class="article-language-item"
            >
              <p>{{ suggestion.finding }}</p>
              <p class="article-language-change">
                <del>{{ suggestion.originalText }}</del> → <ins>{{ suggestion.replacementText }}</ins>
              </p>
              <p
                v-if="suggestion.stale"
                class="article-notice"
              >
                Ця пропозиція стосується старішої версії.
              </p>
              <label
                v-else-if="suggestion.status === 'OPEN'"
                class="article-language-select"
              ><input
                v-model="selectedLanguageIds"
                type="checkbox"
                :value="suggestion.id"
                :disabled="languageBusy || !languageSourceCurrent"
              > Застосувати цю правку</label>
              <p v-else>
                {{ suggestion.status === 'ACCEPTED' ? 'Застосовано' : 'Відхилено' }}
              </p>
              <Button
                v-if="suggestion.status === 'OPEN' && !suggestion.stale"
                class="workspace-button"
                variant="ghost"
                :disabled="languageBusy || !languageSourceCurrent"
                @click="rejectLanguage(suggestion)"
              >
                Відхилити
              </Button>
            </article>
            <Button
              v-if="selectedLanguageIds.length"
              class="workspace-button workspace-button-primary"
              :disabled="languageBusy || !languageSourceCurrent"
              @click="acceptLanguage"
            >
              Створити версію з вибраними правками
            </Button>
            <Button
              v-for="version in languageCandidates"
              :key="version.id"
              class="workspace-button"
              variant="outline"
              :disabled="languageBusy"
              @click="candidate = version; inspector = 'proposal'"
            >
              Переглянути версію {{ version.number }} з мовними правками
            </Button>
          </section>
        </article>
        <aside
          v-show="!!inspector"
          class="article-inspector"
          :class="{ 'article-proposal': inspector === 'proposal' }"
          aria-labelledby="article-inspector-heading"
          @keydown.esc.stop="closeInspector"
        >
          <header>
            <h2
              id="article-inspector-heading"
              ref="inspectorHeading"
              tabindex="-1"
            >
              {{ inspector === 'history' ? 'Версії статті' : inspector === 'evidence' ? 'Джерела для чернетки' : inspector === 'import' ? 'Готова стаття' : inspector === 'annotations' ? 'Коментарі й правки' : inspector === 'google-docs' ? 'Google Документи' : candidate?.origin === 'AI' ? 'Пропозиція AI' : candidate?.origin === 'UNVERIFIED_IMPORTED' ? 'Імпортована версія' : 'Пропозиція правки' }}
            </h2><button
              type="button"
              aria-label="Закрити контекст"
              @click="closeInspector"
            >
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                aria-hidden="true"
              ><path d="m6 6 12 12M6 18 18 6" /></svg>
            </button>
          </header>
          <template v-if="inspector === 'import'">
            <p>Вставте готовий текст. Він стане непогодженою чернеткою; структура не потрібна.</p><label for="article-import">Готовий текст</label><textarea
              id="article-import"
              v-model="importedText"
              rows="12"
            /><Button
              class="workspace-button workspace-button-primary"
              :disabled="busy || dirty || !importedText.trim() || conflict"
              @click="importReady"
            >
              Додати як чернетку
            </Button>
          </template>
          <ArticleAnnotations
            v-if="inspector === 'annotations'"
            :project-id="projectId"
            :csrf-token="csrfToken"
            :user-id="userId"
            :target-version-id="annotationVersion.id"
            :content-hash="annotationVersion.contentHash"
            :expected-article-revision="expectedRevision"
            :anchor="annotationAnchor"
            :readonly="readonly"
            @session-expired="emit('session-expired')"
            @candidate-created="annotationCandidateCreated"
          />
          <GoogleDocsBinding
            v-if="googleDocsVisited"
            v-show="inspector === 'google-docs'"
            :project-id="projectId"
            :csrf-token="csrfToken"
            :user-id="userId"
            :expected-article-revision="expectedRevision"
            :target-version-id="annotationVersion?.id ?? null"
            :archived="!!archived"
            @session-expired="emit('session-expired')"
            @candidate-created="annotationCandidateCreated"
          />
          <p
            v-if="(inspector === 'history' || inspector === 'evidence') && detailsLoading"
            role="status"
          >
            Завантажуємо версії та джерела…
          </p>
          <p
            v-if="(inspector === 'history' || inspector === 'evidence') && detailsError"
            role="alert"
          >
            {{ detailsError }}
            <Button
              variant="outline"
              @click="loadDetails"
            >
              Спробувати ще раз
            </Button>
          </p>
          <template v-if="inspector === 'evidence'">
            <section
              v-if="selectedPassage"
              class="article-selected-evidence"
              aria-label="Уривок джерела"
            >
              <h3>{{ selectedPassage.materialTitle }}</h3><blockquote>
                <SourceMarkdown
                  :text="selectedPassage.quote"
                  compact
                />
              </blockquote>
              <p
                v-if="sourceError"
                role="alert"
              >
                {{ sourceError }}
              </p>
              <details v-if="sourceText">
                <summary>Точне місце в джерелі</summary><div class="source-full-text">
                  <SourceMarkdown
                    :text="sourceText"
                    :highlight="{ startOffset: selectedPassage.startOffset, endOffset: selectedPassage.endOffset }"
                  />
                </div>
              </details>
            </section>
            <p>Щоб додати посилання, виділіть текст у чернетці та виберіть уривок нижче.</p>
            <h3 v-if="passageOptions.length">
              Доступні уривки
            </h3>
            <section
              v-for="item in passageOptions"
              :key="item.passageId"
              class="article-evidence-item"
            >
              <h3>{{ item.materialTitle }}</h3><blockquote>
                <SourceMarkdown
                  :text="item.quote"
                  compact
                />
              </blockquote>
              <Button
                variant="outline"
                :disabled="readonly || contentMode !== 'FACTUAL'"
                @mousedown.prevent
                @click="linkSourcePassage(item)"
              >
                Прив’язати виділений текст
              </Button>
              <Button
                variant="ghost"
                @click="openSourcePassage(item.passageId,item.packetId)"
              >
                Відкрити джерело
              </Button>
            </section>
            <Button
              class="workspace-button"
              variant="ghost"
              :disabled="readonly"
              @click="editor?.chain().focus().unsetMark('source_evidence').run()"
            >
              Прибрати посилання на джерело
            </Button>
          </template>
          <template v-if="inspector === 'history'">
            <p v-if="!state.article?.versions.length">
              Збережіть версію, щоб зафіксувати цей текст для перегляду.
            </p><section
              v-for="version in state.article?.versions"
              :key="version.id"
              class="article-version"
            >
              <h3>Версія {{ version.number }}</h3><p>{{ version.origin === 'AI' ? (version.id === state.article?.draft?.baseVersionId ? 'Створено AI · Застосовано до чернетки' : 'Пропозиція AI') : version.origin === 'UNVERIFIED_IMPORTED' ? 'Готова стаття · Не перевірено' : 'Редакторська версія' }} · {{ version.status === 'APPROVED' ? 'Погоджено' : version.status === 'WITHDRAWN' ? 'Відкликано' : 'Очікує перегляду' }}</p><p
                v-if="version.staleReasons?.length"
                class="article-notice"
              >
                Потребує перегляду: {{ dependencyStatus(version.staleReasons) }}.
              </p><p
                v-if="version.blockingReasons?.length"
                class="article-notice"
              >
                Не можна погодити: {{ dependencyStatus(version.blockingReasons) }}.
              </p><p>{{ version.content.title }}</p><details><summary>Переглянути текст версії</summary><ArticlePreview :document="version.content.document" /></details><template v-if="version.status === 'PROPOSED' && version.id === state.article?.draft?.baseVersionId && !readonly">
                <Button
                  class="workspace-button workspace-button-primary"
                  :disabled="state.editorOnly || detailsLoading || busy || dirty || conflict || !!version.blockingReasons?.length || !!state.mappingIssues.length"
                  @click="action(`/article/${version.id}/approve`)"
                >
                  Погодити версію {{ version.number }}
                </Button>
              </template><template v-if="version.status === 'APPROVED' && version.id === state.article?.currentApprovedVersionId && version.staleReasons?.length && !readonly">
                <Button
                  class="workspace-button workspace-button-primary"
                  :disabled="busy || dirty || conflict || !!version.blockingReasons?.length"
                  @click="action(`/article/${version.id}/rereview`, { expectedReviewCounter: version.reviewCounter ?? 0 })"
                >
                  Переглянути без зміни тексту
                </Button>
              </template><Button
                v-if="version.status === 'APPROVED' && !readonly"
                class="workspace-button"
                variant="ghost"
                :disabled="busy || dirty"
                @click="action(`/article/${version.id}/withdraw`)"
              >
                Відкликати погодження
              </Button><Button
                v-if="version.status === 'PROPOSED' && version.origin !== 'UNVERIFIED_IMPORTED' && version.id !== state.article?.draft?.baseVersionId"
                class="workspace-button"
                variant="outline"
                @click="candidate = version; inspector = 'proposal'"
              >
                Переглянути пропозицію
              </Button>
            </section>
          </template>
          <template v-if="inspector === 'proposal' && candidate">
            <div
              class="proposal-tabs"
              role="group"
              aria-label="Перегляд тексту"
            >
              <Button
                class="workspace-button"
                :variant="proposalView === 'suggested' ? 'default' : 'outline'"
                :aria-pressed="proposalView === 'suggested'"
                @click="proposalView = 'suggested'"
              >
                Пропозиція
              </Button>
              <Button
                class="workspace-button"
                :variant="proposalView === 'current' ? 'default' : 'outline'"
                :aria-pressed="proposalView === 'current'"
                @click="proposalView = 'current'"
              >
                Поточна чернетка
              </Button>
            </div>
            <div class="proposal-manuscript">
              <h3>{{ proposalView === 'suggested' ? candidate.content.title : title }}</h3>
              <ArticlePreview
                v-if="proposalView === 'suggested'"
                :document="candidate.content.document"
                :active-citation="proposalEvidenceOpen ? activeProposalCitation : null"
                @source-citation="(passageId, packetId, citationId) => openSourcePassage(passageId, packetId, candidate?.id, citationId)"
              />
              <ArticlePreview
                v-else
                :document="payload().content.document"
                :active-citation="proposalEvidenceOpen ? activeProposalCitation : null"
                @source-citation="(passageId, packetId, citationId) => openSourcePassage(passageId, packetId, undefined, citationId)"
              />
            </div>
            <p v-if="(candidate.origin === 'AI' && candidate.sourceArticleRevision !== expectedRevision) || dirty">
              Чернетка змінилася після запуску. Цю пропозицію не можна застосувати до поточного тексту.
            </p><Button
              class="workspace-button workspace-button-primary"
              :disabled="busy || dirty || conflict || readonly || (candidate.origin === 'AI' && candidate.sourceArticleRevision !== expectedRevision)"
              @click="action(`/article/${candidate.id}/apply`, {}, true)"
            >
              Застосувати до чернетки
            </Button>
          </template>
        </aside>
        <aside
          v-if="inspector === 'proposal' && proposalEvidenceOpen"
          class="article-inspector proposal-evidence"
          aria-labelledby="proposal-evidence-heading"
          @keydown.esc.stop="closeProposalEvidence"
        >
          <header>
            <h2
              id="proposal-evidence-heading"
              ref="proposalEvidenceHeading"
              tabindex="-1"
            >
              Джерело цього тексту
            </h2>
            <button
              type="button"
              aria-label="Закрити джерело"
              @click="closeProposalEvidence"
            >
              ×
            </button>
          </header>
          <p
            v-if="proposalEvidenceLoading"
            role="status"
          >
            Завантажуємо джерело…
          </p>
          <p
            v-if="sourceError"
            role="alert"
          >
            {{ sourceError }}
          </p>
          <section
            v-if="selectedPassage"
            class="article-selected-evidence"
          >
            <h3>{{ selectedPassage.materialTitle }}</h3>
            <blockquote>
              <SourceMarkdown
                :text="selectedPassage.quote"
                compact
              />
            </blockquote>
            <details v-if="sourceText">
              <summary>Точне місце в джерелі</summary>
              <div class="source-full-text">
                <SourceMarkdown
                  :text="sourceText"
                  :highlight="{ startOffset: selectedPassage.startOffset, endOffset: selectedPassage.endOffset }"
                />
              </div>
            </details>
          </section>
        </aside>
      </div>
      <div
        v-if="(proposals.length || importedCandidates.length) && inspector !== 'history' && inspector !== 'proposal'"
        class="article-proposals"
      >
        <Button
          v-for="version in importedCandidates"
          :key="version.id"
          class="workspace-button"
          variant="outline"
          @click="candidate = version; inspector = 'proposal'"
        >
          Переглянути імпортовану версію {{ version.number }}
        </Button><Button
          v-if="proposals.length"
          class="workspace-button"
          variant="outline"
          @click="candidate = proposals[0] ?? null; inspector = 'proposal'"
        >
          Переглянути пропозицію AI · Не застосовано
        </Button>
      </div>
      <div
        v-for="job in actionableJobs"
        :key="job.id"
        class="article-job"
      >
        <span>{{ ({ QUEUED: 'Генерація очікує обробки', RUNNING: 'Створюємо статтю', SUCCEEDED: 'Пропозиція готова', FAILED: 'Не вдалося створити статтю', CANCELLED: 'Генерацію скасовано', OUTCOME_UNKNOWN: 'Результат зовнішньої обробки невідомий', RETRY_WAIT: 'Очікує повторної спроби' } as Record<string, string>)[job.status] }}</span><Button
          v-if="['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)"
          class="workspace-button"
          variant="ghost"
          @click="jobAction(job, 'cancel')"
        >
          Скасувати генерацію
        </Button><Button
          v-if="job.retryAllowed"
          class="workspace-button"
          variant="outline"
          @click="jobAction(job, 'retry')"
        >
          Повторити генерацію
        </Button>
      </div>
      <details
        v-if="completedJobs.length"
        class="article-job-history"
      >
        <summary>Історія генерації</summary>
        <ul>
          <li
            v-for="job in completedJobs"
            :key="job.id"
          >
            {{ job.status === 'SUCCEEDED' ? 'Пропозицію створено' : 'Генерацію скасовано' }}
          </li>
        </ul>
      </details>
    </template>
  </section>
</template>

<style scoped>
.article-generate-wrap { position: relative; display: inline-flex; }
.article-generate-tooltip { visibility: hidden; opacity: 0; position: absolute; top: calc(100% + 8px); left: 0; z-index: 20; width: max-content; max-width: min(300px, 75vw); padding: 9px 12px; background: var(--ink); color: white; font-size: 14px; line-height: 1.4; white-space: normal; }
.article-generate-wrap:hover .article-generate-tooltip, .article-generate-wrap:focus-visible .article-generate-tooltip { visibility: visible; opacity: 1; }
.article-workspace { max-width: 1352px; margin: 0 auto; }
.article-boundary, .article-actions, .article-toolbar, .article-inspector > header, .article-review > div, .article-job { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.article-boundary { justify-content: space-between; margin-bottom: 24px; }
.article-boundary h1 { font-family: var(--serif); font-weight: 550; font-size: 39px; line-height: 1.2; letter-spacing: -.025em; margin: 0; }
.article-title-status { display: flex; align-items: baseline; flex-wrap: wrap; gap: 12px; }
.article-approved { margin: 0; color: var(--muted); font: 13px var(--sans); }
.article-boundary > span { display: flex; gap: 8px; font-size: 12px; color: var(--muted); }
.article-actions { margin-bottom: 0; padding-bottom: 20px; border-bottom: 1px solid var(--rule); }
.article-layout { display: grid; grid-template-columns: 190px minmax(0, 1fr); gap: 40px; align-items: start; }
.article-layout.with-inspector { grid-template-columns: minmax(0, 1fr) 280px; gap: 40px; }
.article-contents { position: sticky; top: 24px; padding-top: 60px; min-width: 0; font-size: 13px; }
.article-contents summary { display: flex; align-items: center; justify-content: space-between; min-height: 44px; list-style: none; margin-bottom: 8px; font-weight: 500; cursor: pointer; }
.article-contents summary::-webkit-details-marker { display: none; }
.article-contents summary svg { display: none; }
.article-contents nav a { display: block; padding: 10px 0; line-height: 1.6; color: var(--muted); text-decoration: none; overflow-wrap: anywhere; }
.article-contents nav a:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
.article-contents nav a.subsection { padding-left: 14px; }
.article-paper { width: 100%; max-width: 72ch; margin-inline: auto; min-width: 0; padding: 60px 55px 42px; font-family: var(--serif); font-size: 20px; background: var(--document); scroll-margin-top: 24px; }
.article-title { width: 100%; min-height: 2.24em; overflow: hidden; resize: none; border: 0; background: transparent; color: var(--ink); font-family: var(--serif); font-weight: 550; font-size: 48px; line-height: 1.12; letter-spacing: -.025em; padding: 0; border-radius: 0; }
.article-toolbar { font-family: var(--sans); border-bottom: 1px solid var(--rule); padding: 12px 0; margin: 12px 0 28px; gap: 4px; }
.article-toolbar button { font-size: 13px; padding: 7px 10px; min-height: 34px; border-radius: 3px; }
.article-toolbar button[aria-pressed=true] { background: var(--paper); }
.article-writing :deep(.tiptap) { font-family: var(--serif); font-size: 20px; line-height: 1.7; min-height: 330px; outline-offset: 8px; white-space: pre-wrap; overflow-wrap: anywhere; caret-color: var(--ink); }
.article-writing :deep(p) { line-height: 1.65; margin: 0 0 1em; }
.article-writing :deep(.tiptap > p:first-child) { font-size: 25px; line-height: 1.5; margin-bottom: 36px; color: var(--lead-ink, var(--muted)); }
.article-writing :deep(h2) { font-size: 30px; font-weight: 600; line-height: 1.35; margin: 1.4em 0 .6em; scroll-margin-top: 24px; }
.article-writing :deep(h3) { font-size: 24px; font-weight: 600; line-height: 1.4; margin: 1.4em 0 .6em; scroll-margin-top: 24px; }
.article-writing :deep(ul), .article-writing :deep(ol) { padding-left: 26px; }
.article-writing :deep(blockquote) { border-left: 1px solid var(--rule); padding-left: 20px; margin: 32px 0; font-size: 29px; line-height: 1.5; }
.article-writing :deep(.article-evidence) { pointer-events: none; }
.article-writing.show-evidence-marks :deep(.article-evidence) { pointer-events: auto; cursor: pointer; border-bottom: 1px solid var(--success); background: color-mix(in srgb, var(--success) 8%, transparent); }
.article-review { margin-top: 34px; padding-top: 18px; border-top: 1px solid var(--rule); font-family: var(--sans); font-size: 13px; color: var(--muted); }
.article-language { margin-top: 26px; padding-top: 16px; border-top: 1px solid var(--rule); }
.article-language-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.article-language-heading h2 { margin: 0; font: 550 21px/1.3 SourceSerif, Georgia, serif; }
.article-language > p, .article-language-item > p { color: var(--muted); font-size: 13px; line-height: 1.5; }
.article-language-item { padding: 12px 0; border-top: 1px solid var(--rule); }
.article-language-change { font: 17px/1.5 SourceSerif, Georgia, serif !important; overflow-wrap: anywhere; }
.article-language-change del { color: var(--review, #945000); }
.article-language-change ins { color: var(--approved, #32664b); text-decoration-thickness: 1px; }
.article-language-select { display: inline-flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 13px; }
.article-mode { display: flex; gap: 7px; align-items: center; min-height: 44px; color: var(--ink); }
.article-review > div { justify-content: space-between; }
.article-save-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-left: auto; }
.article-inspector { min-width: 0; margin-top: 48px; border-left: 1px solid var(--rule); padding-left: 20px; font-size: 14px; overflow-wrap: anywhere; }
.article-layout.with-proposal { display: block; }
.article-layout.with-proposal-evidence { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 320px); gap: 32px; }
.proposal-evidence { position: sticky; top: 20px; max-height: calc(100vh - 40px); overflow: auto; }
.proposal-citation-hint { color: var(--muted); font-size: 13px; }
.article-proposal { max-width: 820px; margin: 40px auto 0; padding: 0; border: 0; }
.proposal-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 30px; }
.proposal-tabs button[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: var(--document); }
.proposal-tabs button[aria-pressed="false"] { background: transparent; border-color: var(--rule); color: var(--ink); }
.proposal-manuscript h3 { margin: 0 0 30px; font: 550 42px/1.15 var(--serif); overflow-wrap: anywhere; }
.proposal-manuscript :deep(.article-preview) { font-size: 20px; line-height: 1.7; }
.article-inspector > header { justify-content: space-between; flex-wrap: nowrap; }
.article-inspector h2 { font-size: 18px; font-weight: 550; margin: 0; scroll-margin-top: 24px; }
.article-inspector > header button { display: inline-flex; justify-content: center; align-items: center; min-width: 44px; min-height: 44px; flex-shrink: 0; }
.article-inspector textarea { width: 100%; border: 1px solid var(--field-rule, var(--rule)); border-radius: 3px; padding: 10px; background: var(--document); margin: 10px 0; }
.article-version, .article-evidence-item { padding: 18px 0; border-bottom: 1px solid var(--rule); }
.article-version h3, .article-evidence-item h3 { font-size: 15px; margin: 0; }
.article-version p, .article-inspector p { line-height: 1.55; margin: 10px 0; }
.article-inspector blockquote { border-left: 1px solid var(--rule); margin-inline: 0; padding-left: 12px; font-family: var(--serif); font-size: 19px; line-height: 1.55; }
.article-inspector pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; max-height: 380px; overflow: auto; }
.article-inspector details summary { cursor: pointer; min-height: 44px; padding-block: 12px; }
.source-full-text { max-height: 55vh; overflow: auto; overflow-wrap: anywhere; }
.article-notice, .article-error { padding: 14px 0; line-height: 1.6; border-top: 1px solid var(--rule); }
.article-error { color: var(--error); }
.article-proposals, .article-job { margin-top: 18px; font-size: 14px; }
.article-version label { display: block; margin: 12px 0; line-height: 1.5; }
.article-selected-evidence { margin: 18px 0; padding: 18px 0; border-block: 1px solid var(--rule); }
.article-selected-evidence h3 { font-family: var(--serif); font-size: 21px; font-weight: 550; margin: 0; }
.article-job-history { margin-top: 24px; padding-block: 12px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 13px; }
.article-job-history summary { min-height: 44px; padding-block: 12px; cursor: pointer; color: var(--ink); }
.article-job-history li { padding-block: 6px; }
.with-inspector .article-paper { padding: 48px 22px 42px; font-size: 19px; }
.with-inspector .article-title { font-size: 42px; }
.with-inspector .article-writing :deep(.tiptap) { font-size: 19px; }
.with-inspector .article-writing :deep(.tiptap > p:first-child) { font-size: 23px; }
.article-workspace :is(button, a, summary, textarea):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.article-writing :deep(.article-evidence:focus-visible) { outline: 2px solid var(--ink); outline-offset: 3px; }
@media (max-width: 1150px) {
  .article-layout { grid-template-columns: 160px minmax(0, 1fr); gap: 24px; }
  .article-layout.with-inspector { grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; }
}
@media (max-width: 900px) {
  .article-layout, .article-layout.with-inspector { display: block; }
  .article-contents { position: static; padding-top: 16px; border-bottom: 1px solid var(--rule); }
  .article-contents summary { margin: 0; }
  .article-contents summary svg { display: block; }
  .article-contents details[open] summary svg { transform: rotate(180deg); }
  .article-contents nav { padding-bottom: 14px; }
  .article-contents nav a { min-height: 44px; }
  .article-paper, .with-inspector .article-paper { padding: 36px 24px 28px; }
  .article-inspector { border-left: 0; border-top: 1px solid var(--rule); margin-top: 24px; padding: 20px 0; }
  .article-proposal { border: 0; padding: 0; }
  .article-layout.with-proposal-evidence { display: block; }
  .proposal-evidence { position: fixed; inset: auto 0 0; z-index: 30; max-height: 70vh; margin: 0; padding: 16px 24px; background: var(--document); border-top: 1px solid var(--rule); box-shadow: 0 -6px 24px rgb(0 0 0 / 12%); }
}
@media (max-width: 760px) {
  .article-boundary { align-items: flex-start; gap: 12px; }
  .article-boundary h1 { font-size: 32px; }
  .article-paper, .with-inspector .article-paper { padding: 36px 0 24px; }
  .article-title, .with-inspector .article-title { font-size: 35px; line-height: 1.16; }
  .proposal-manuscript h3 { font-size: 35px; }
  .proposal-manuscript :deep(.article-preview) { font-size: 18px; }
  .article-writing :deep(.tiptap), .with-inspector .article-writing :deep(.tiptap) { font-size: 18px; }
  .article-writing :deep(.tiptap > p:first-child), .with-inspector .article-writing :deep(.tiptap > p:first-child) { font-size: 21px; }
  .article-writing :deep(h2) { font-size: 27px; }
  .article-writing :deep(h3) { font-size: 23px; }
  .article-writing :deep(blockquote) { font-size: 25px; }
  .article-toolbar button { min-height: 44px; }
  .article-actions { gap: 8px; }
  .article-review > div { align-items: flex-start; }
}
</style>
