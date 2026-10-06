<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { Mark, type JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Button } from '@/components/ui/button'
import ArticlePreview from './ArticlePreview.vue'

interface Content { title: string; document: JSONContent }
interface Version { id: string; number: number; content: Content; contentMode: 'FACTUAL' | 'CREATIVE'; origin: string; status: string; sourceArticleRevision: number; approvedAt?: string; withdrawnAt?: string }
interface Draft { baseVersionId?: string | null; content: Content; contentMode: 'FACTUAL' | 'CREATIVE'; origin: string }
interface Evidence { claimRevisionId: string; evidenceId: string; wording: string; quote: string; snapshotId: string; materialTitle: string }
interface State { article: { id: string; revision: number; draft: Draft | null; currentApprovedVersionId: string | null; versions: Version[] } | null; articleSelected: boolean; eligibleEvidence: Evidence[]; mappingIssues: { locator: string; reason: string }[]; staleReasons: string[]; hasUnmapped: boolean; editorial: { brief: { currentRevision: { contentMode: string } } | null; outline: { currentApprovedRevisionId: string | null } | null } }
interface Job { id: string; status: string; operation: string; retryAllowed: boolean }
const props = defineProps<{ projectId: string; projectTopic: string; csrfToken: string; userId: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()
const state = ref<State | null>(null)
const title = ref(props.projectTopic)
const contentMode = ref<'FACTUAL' | 'CREATIVE'>('CREATIVE')
const baseline = ref('')
const expectedRevision = ref(0)
const editEpoch = ref(0)
const saving = ref(false)
const busy = ref(false)
const loading = ref(true)
const error = ref('')
const conflict = ref(false)
const inspector = ref<'history' | 'evidence' | 'proposal' | 'import' | null>(null)
const candidate = ref<Version | null>(null)
const selectedEvidence = ref<Evidence | null>(null)
const linkedWording = ref('')
const importedText = ref('')
const acknowledgeUnmapped = ref(false)
const recovered = ref<{ content: Content; contentMode: 'FACTUAL' | 'CREATIVE'; expectedRevision: number } | null>(null)
const jobs = ref<Job[]>([])
const recoveryKey = `cf:article:${props.userId}:${props.projectId}`
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
let disposed = false
let hydration = false
let sessionEnded = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
let inFlight: Promise<boolean> | null = null
let commandKey: string | null = null
const controller = new AbortController()
const evidenceMark = Mark.create({ name: 'evidence', inclusive: false, addAttributes: () => ({ claimRevisionId: { default: null }, evidenceId: { default: null }, quote: { default: null } }), parseHTML: () => [], renderHTML: ({ HTMLAttributes }) => ['span', { class: 'article-evidence', 'data-evidence-id': HTMLAttributes.evidenceId, 'data-linked-wording': HTMLAttributes.quote, tabindex: 0, role: 'button', 'aria-label': 'Переглянути доказ для цього речення' }, 0] })
const editor = useEditor({ injectCSS: false, extensions: [StarterKit.configure({ heading: { levels: [2, 3] }, code: false, codeBlock: false, horizontalRule: false, link: false, underline: false, trailingNode: false }), evidenceMark], content: { type: 'doc', content: [{ type: 'paragraph' }] }, editorProps: { attributes: { 'aria-label': 'Текст статті', role: 'textbox', 'aria-multiline': 'true' }, handleDOMEvents: { click: (_view, event) => inspectEvidence(event), keydown: (_view, event) => (event.key === 'Enter' || event.key === ' ') && inspectEvidence(event) } }, onUpdate: () => changed() })
function canonicalNode(node: JSONContent): JSONContent {
  return { type: node.type ?? 'doc', ...(node.type === 'heading' ? { attrs: { level: node.attrs?.level } } : {}), ...(node.text === undefined ? {} : { text: node.text }), ...(node.marks ? { marks: node.marks.map(mark => ({ type: mark.type, ...(mark.type === 'evidence' ? { attrs: { claimRevisionId: mark.attrs?.claimRevisionId, evidenceId: mark.attrs?.evidenceId, quote: mark.attrs?.quote } } : {}) })) } : {}), ...(node.content ? { content: node.content.map(canonicalNode) } : {}) }
}
function payload() { return { content: { title: title.value, document: canonicalNode(editor.value?.getJSON() ?? { type: 'doc', content: [{ type: 'paragraph' }] }) }, contentMode: contentMode.value } }
const serialized = computed(() => { void editEpoch.value; return JSON.stringify(payload()) })
const dirty = computed(() => baseline.value !== serialized.value)
const readonly = computed(() => !!props.archived || !state.value?.articleSelected)
const activeJob = computed(() => jobs.value.some(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)))
const proposals = computed(() => state.value?.article?.versions.filter(version => version.origin === 'AI' && version.status === 'PROPOSED' && version.id !== state.value?.article?.draft?.baseVersionId) ?? [])
const saveStatus = computed(() => saving.value ? 'Зберігаємо…' : conflict.value ? 'Потрібно узгодити зміни' : error.value && dirty.value ? 'Не збережено' : dirty.value ? 'Є незбережені зміни' : 'Збережено')
const approval = computed(() => state.value?.article?.versions.find(version => version.id === state.value?.article?.currentApprovedVersionId))
watch(readonly, value => editor.value?.setEditable(!value))
watch([title, contentMode], () => changed())
function retain() { if (sessionEnded || !props.userId || hydration || !dirty.value) return; try { sessionStorage.setItem(recoveryKey, JSON.stringify({ ...payload(), expectedRevision: expectedRevision.value })) } catch { /* Browser quota does not discard the live editor. */ } }
function changed() { if (hydration || disposed) return; editEpoch.value++; retain(); clearTimeout(saveTimer); if (!conflict.value && !recovered.value) saveTimer = setTimeout(() => void save(), 700) }
function populate(draft?: Draft | null) {
  hydration = true
  title.value = draft?.content.title ?? props.projectTopic
  contentMode.value = draft?.contentMode ?? 'CREATIVE'
  editor.value?.commands.setContent(draft?.content.document ?? { type: 'doc', content: [{ type: 'paragraph' }] }, { emitUpdate: false })
  editEpoch.value++; baseline.value = serialized.value; expectedRevision.value = state.value?.article?.revision ?? 0; hydration = false
}
async function request(path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { credentials: 'same-origin', signal: controller.signal, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    if (response.status === 409) conflict.value = true
    throw new Error(response.status === 409 ? 'Є нові зміни або змінилися редакційні залежності. Ваш текст залишився в редакторі.' : response.status === 503 ? 'AI-генерація тимчасово недоступна. Ви можете продовжувати редагування.' : response.status === 400 ? 'Перевірте текст, посилання на факти та актуальність брифу.' : 'Не вдалося виконати дію. Ваш текст залишився в редакторі; повторіть спробу.')
  }
  return response.json()
}
async function load(reset = false) { state.value = await request('/article') as State; if (reset) populate(state.value.article?.draft); editor.value?.setEditable(!readonly.value) }
async function save(): Promise<boolean> {
  clearTimeout(saveTimer)
  if (inFlight) { const ok = await inFlight; return ok && dirty.value ? save() : ok }
  if (!dirty.value) return true
  if (readonly.value || conflict.value || recovered.value || !title.value.trim()) return false
  const submitted = payload(); const submittedBytes = JSON.stringify(submitted)
  saving.value = true; error.value = ''
  inFlight = (async () => {
    try {
      const result = await request('/article/draft', { ...submitted, expectedRevision: expectedRevision.value }) as State
      if (disposed) return false
      state.value = result; expectedRevision.value = result.article?.revision ?? expectedRevision.value; baseline.value = submittedBytes
      if (!dirty.value) sessionStorage.removeItem(recoveryKey); else retain()
      return true
    } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти.'; return false }
    finally { saving.value = false; inFlight = null }
  })()
  const ok = await inFlight
  return ok && dirty.value && !disposed ? save() : ok
}
async function action(path: string, extra: object = {}, replace = false) {
  if (busy.value || readonly.value || !await save()) return
  busy.value = true; error.value = ''; if (replace) editor.value?.setEditable(false)
  try { state.value = await request(path, { expectedRevision: expectedRevision.value, ...extra }) as State; expectedRevision.value = state.value.article?.revision ?? expectedRevision.value; if (replace) populate(state.value.article?.draft) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { busy.value = false; editor.value?.setEditable(!readonly.value) }
}
async function refreshInputs() { if (!await save()) return; const submittedBytes = serialized.value; busy.value = true; try { state.value = await request('/article/draft', { ...payload(), expectedRevision: expectedRevision.value, refreshInputs: true }) as State; expectedRevision.value = state.value.article?.revision ?? expectedRevision.value; baseline.value = submittedBytes; error.value = ''; if (dirty.value) changed() } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Контекст недоступний.' } finally { busy.value = false } }
async function reconcile(useLocal: boolean) {
  clearTimeout(saveTimer)
  try { await load(!useLocal); expectedRevision.value = state.value?.article?.revision ?? 0; conflict.value = false; error.value = ''; recovered.value = null; if (useLocal) { baseline.value = ''; await save() } else sessionStorage.removeItem(recoveryKey) }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити.' }
}
function discardRecovery() { recovered.value = null; sessionStorage.removeItem(recoveryKey) }
function restore() { const data = recovered.value; if (!data) return; hydration = true; title.value = data.content.title; contentMode.value = data.contentMode; editor.value?.commands.setContent(data.content.document, { emitUpdate: false }); editEpoch.value++; hydration = false; recovered.value = null; expectedRevision.value = data.expectedRevision; conflict.value = expectedRevision.value !== (state.value?.article?.revision ?? 0); retain(); if (!conflict.value) void save() }
function closeInspector() { inspector.value = null; editor.value?.commands.focus() }
function format(kind: string) { const chain = editor.value?.chain().focus(); if (!chain) return; if (kind === 'bold') chain.toggleBold().run(); if (kind === 'italic') chain.toggleItalic().run(); if (kind === 'heading') chain.toggleHeading({ level: 2 }).run(); if (kind === 'list') chain.toggleBulletList().run() }
function inspectEvidence(event: Event) { const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-evidence-id]'); if (!target) return false; const item = state.value?.eligibleEvidence.find(row => row.evidenceId === target.dataset.evidenceId); if (!item) return false; event.preventDefault(); selectedEvidence.value = item; linkedWording.value = target.dataset.linkedWording ?? ''; inspector.value = 'evidence'; return true }
function linkEvidence(item: Evidence) { const current = editor.value; if (!current) return; const { from, to } = current.state.selection; const quote = current.state.doc.textBetween(from, to, '\n'); if (!quote.trim()) { error.value = 'Спочатку виділіть речення, яке підтверджує цей факт.'; return }; current.chain().focus().unsetMark('evidence').setMark('evidence', { claimRevisionId: item.claimRevisionId, evidenceId: item.evidenceId, quote }).run(); selectedEvidence.value = item }
async function generate() { if (!await save()) return; commandKey ??= crypto.randomUUID(); busy.value = true; try { await request('/article/generate', { expectedRevision: expectedRevision.value, commandKey }); commandKey = null; await poll() } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося створити пропозицію.' } finally { busy.value = false } }
async function importReady() { if (!importedText.value.trim() || busy.value) return; busy.value = true; try { const content: Content = { title: title.value || props.projectTopic, document: { type: 'doc', content: importedText.value.split(/\n\s*\n/).filter(Boolean).map(text => ({ type: 'paragraph', content: [{ type: 'text', text }] })) } }; state.value = await request('/article/import', { expectedRevision: expectedRevision.value, contentMode: contentMode.value, content }) as State; populate(state.value.article?.draft); sessionStorage.removeItem(recoveryKey); importedText.value = ''; inspector.value = null } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося додати статтю.' } finally { busy.value = false } }
async function poll() { clearTimeout(pollTimer); if (disposed) return; try { const result = await request('/jobs') as { jobs: Job[] }; jobs.value = result.jobs.filter(job => job.operation === 'ARTICLE_GENERATION'); await load() } catch { /* Saving errors remain the primary action boundary. */ } finally { if (!disposed) pollTimer = setTimeout(() => void poll(), activeJob.value ? 2000 : 5000) } }
async function jobAction(job: Job, kind: 'retry' | 'cancel') { try { await request(`/jobs/${job.id}/${kind}`, {}); await poll() } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Дія недоступна.' } }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { retain(); event.preventDefault(); event.returnValue = '' } }
function endSession() { sessionEnded = true; disposed = true; controller.abort(); clearTimeout(saveTimer); clearTimeout(pollTimer); hydration = true; title.value = ''; editor.value?.commands.clearContent(false); recovered.value = null; state.value = null }
onMounted(async () => { window.addEventListener('cf:article-session-ended', endSession); try { await load(true); const saved = sessionStorage.getItem(recoveryKey); if (saved) recovered.value = JSON.parse(saved) as typeof recovered.value; await poll() } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити статтю.' } finally { loading.value = false }; window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => { retain(); disposed = true; controller.abort(); clearTimeout(saveTimer); clearTimeout(pollTimer); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('cf:article-session-ended', endSession); editor.value?.destroy() })
</script>

<template>
  <section
    class="article-workspace"
    aria-labelledby="article-heading"
  >
    <header class="article-boundary">
      <div>
        <p class="eyebrow">
          Стаття
        </p><h1 id="article-heading">
          Редактор
        </h1>
      </div><span
        role="status"
        aria-live="polite"
      >{{ saveStatus }}</span>
    </header>
    <p
      v-if="loading"
      role="status"
    >
      Відкриваємо статтю…
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
      <p>Оновіть дані та виберіть, який текст продовжувати редагувати.</p><Button
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
        class="workspace-button"
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
        Готова стаття · Не перевірено. Перегляньте текст і підтвердіть посилання на факти перед погодженням.
      </p>
      <p
        v-if="state.staleReasons.length"
        class="article-notice"
      >
        Потребує перегляду: {{ state.staleReasons.map(reason => ({ WORKSPACE_STYLE_CHANGED: 'змінився стиль простору', BRIEF_CHANGED: 'змінився бриф', MISSING_FACTUAL_BASIS: 'немає придатної фактичної основи', INVALID_FACTUAL_BASIS: 'попередня фактична основа втратила придатність', FACTUAL_BASIS_CHANGED: 'змінилася фактична основа', OUTLINE_CHANGED: 'змінилася погоджена структура' } as Record<string, string>)[reason] ?? 'змінився контекст статті').join('; ') }}. Перевірте текст перед оновленням контексту. <Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || conflict || readonly"
          @click="refreshInputs"
        >
          Оновити контекст чернетки
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
        </Button><Button
          class="workspace-button"
          variant="outline"
          :disabled="busy || conflict || activeJob || !state.editorial.outline?.currentApprovedRevisionId"
          @click="generate"
        >
          Запропонувати статтю
        </Button><Button
          class="workspace-button"
          variant="ghost"
          @click="inspector = inspector === 'history' ? null : 'history'"
        >
          Історія версій
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
        </Button>
      </div>
      <div
        v-if="state.article || state.articleSelected"
        class="article-layout"
        :class="{ 'with-inspector': inspector }"
      >
        <main class="article-paper">
          <label
            class="sr-only"
            for="article-title"
          >Заголовок статті</label><textarea
            id="article-title"
            v-model="title"
            maxlength="500"
            rows="2"
            :readonly="readonly || busy"
            class="article-title"
          />
          <div
            v-if="!readonly"
            class="article-toolbar"
            role="toolbar"
            aria-label="Форматування тексту"
          >
            <button
              type="button"
              :aria-pressed="editor?.isActive('bold')"
              aria-label="Жирний"
              @click="format('bold')"
            >
              <strong>Ж</strong>
            </button><button
              type="button"
              :aria-pressed="editor?.isActive('italic')"
              aria-label="Курсив"
              @click="format('italic')"
            >
              <em>К</em>
            </button><button
              type="button"
              :aria-pressed="editor?.isActive('heading')"
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
          </div>
          <EditorContent
            v-if="editor"
            :editor="editor"
            class="article-writing"
          />
          <footer class="article-review">
            <p v-if="approval">
              Погоджено · Версія {{ approval.number }}. Нові правки зберігаються окремою чернеткою.
            </p><p v-if="state.mappingIssues.length">
              Посилання потребують перегляду. Видаліть або повторно прив’яжіть змінене речення до доказу.
            </p><div v-if="!readonly">
              <label class="article-mode"><input
                v-model="contentMode"
                type="checkbox"
                true-value="FACTUAL"
                false-value="CREATIVE"
              > Матеріал на перевірених фактах</label><Button
                class="workspace-button"
                :disabled="busy || saving || conflict || !!recovered || !title.trim()"
                @click="action('/article/checkpoint')"
              >
                Зберегти версію
              </Button>
            </div>
          </footer>
        </main>
        <aside
          v-if="inspector"
          class="article-inspector"
          aria-label="Контекст статті"
          @keydown.esc="closeInspector"
        >
          <header>
            <h2>{{ inspector === 'history' ? 'Версії статті' : inspector === 'evidence' ? 'Докази' : inspector === 'import' ? 'Готова стаття' : 'Пропозиція AI' }}</h2><button
              type="button"
              aria-label="Закрити контекст"
              @click="closeInspector"
            >
              ×
            </button>
          </header>
          <template v-if="inspector === 'import'">
            <p>Вставте готовий текст. Він стане непогодженою чернеткою; структура не потрібна.</p><label for="article-import">Готовий текст</label><textarea
              id="article-import"
              v-model="importedText"
              rows="12"
            /><Button
              class="workspace-button"
              :disabled="busy || dirty || !importedText.trim() || conflict"
              @click="importReady"
            >
              Додати як чернетку
            </Button>
          </template>
          <template v-if="inspector === 'evidence'">
            <p>Виділіть речення в статті та виберіть факт. Повторне прив’язування означає, що ви переглянули саме ці слова.</p><p v-if="!state.eligibleEvidence.length">
              Немає придатних перевірених доказів. Перейдіть до фактів, щоб сформувати основу.
            </p><section
              v-for="item in state.eligibleEvidence"
              :key="item.evidenceId"
              class="article-evidence-item"
            >
              <h3>{{ item.materialTitle }}</h3><p>{{ item.wording }}</p><blockquote>{{ item.quote }}</blockquote><Button
                class="workspace-button"
                variant="outline"
                :disabled="readonly || contentMode !== 'FACTUAL'"
                @click="linkEvidence(item)"
              >
                Прив’язати виділення
              </Button>
            </section><p v-if="selectedEvidence">
              Прив’язано до «{{ selectedEvidence.materialTitle }}». <span v-if="linkedWording">Спочатку прив’язане речення: «{{ linkedWording }}».</span>
            </p><Button
              class="workspace-button"
              variant="ghost"
              :disabled="readonly"
              @click="editor?.chain().focus().unsetMark('evidence').run()"
            >
              Прибрати посилання з виділення
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
              <h3>Версія {{ version.number }}</h3><p>{{ version.origin === 'AI' ? (version.id === state.article?.draft?.baseVersionId ? 'Створено AI · Застосовано до чернетки' : 'Пропозиція AI · Не застосовано') : version.origin === 'UNVERIFIED_IMPORTED' ? 'Готова стаття · Не перевірено' : 'Редакторська версія' }} · {{ version.status === 'APPROVED' ? 'Погоджено' : version.status === 'WITHDRAWN' ? 'Відкликано' : 'Очікує перегляду' }}</p><p>{{ version.content.title }}</p><details><summary>Переглянути текст версії</summary><ArticlePreview :document="version.content.document" /></details><template v-if="version.status === 'PROPOSED' && version.id === state.article?.draft?.baseVersionId && !readonly">
                <label v-if="state.hasUnmapped"><input
                  v-model="acknowledgeUnmapped"
                  type="checkbox"
                > Переглянув твердження без посилань</label><Button
                  class="workspace-button"
                  :disabled="busy || dirty || conflict || !!state.mappingIssues.length || (state.hasUnmapped && !acknowledgeUnmapped)"
                  @click="action(`/article/${version.id}/approve`, { acknowledgeUnmapped })"
                >
                  Погодити версію {{ version.number }}
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
                v-if="version.status === 'PROPOSED' && version.origin === 'AI' && version.id !== state.article?.draft?.baseVersionId"
                class="workspace-button"
                variant="outline"
                @click="candidate = version; inspector = 'proposal'"
              >
                Переглянути пропозицію
              </Button>
            </section>
          </template>
          <template v-if="inspector === 'proposal' && candidate">
            <p>Пропозиція AI · Не застосовано</p><h3>{{ candidate.content.title }}</h3><h4>Поточний текст</h4><ArticlePreview :document="payload().content.document" /><h4>Запропонований текст</h4><ArticlePreview :document="candidate.content.document" /><p v-if="candidate.sourceArticleRevision !== expectedRevision || dirty">
              Чернетка змінилася після запуску. Цю пропозицію не можна застосувати до поточного тексту.
            </p><Button
              class="workspace-button"
              :disabled="busy || dirty || conflict || readonly || candidate.sourceArticleRevision !== expectedRevision"
              @click="action(`/article/${candidate.id}/apply`, {}, true)"
            >
              Застосувати до чернетки
            </Button>
          </template>
        </aside>
      </div>
      <div
        v-if="proposals.length && inspector !== 'history' && inspector !== 'proposal'"
        class="article-proposals"
      >
        <Button
          class="workspace-button"
          variant="outline"
          @click="candidate = proposals[0] ?? null; inspector = 'proposal'"
        >
          Переглянути пропозицію AI · Не застосовано
        </Button>
      </div>
      <div
        v-for="job in jobs"
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
    </template>
  </section>
</template>

<style scoped>
.article-workspace{max-width:1160px;margin:0 auto}.article-boundary,.article-actions,.article-toolbar,.article-inspector>header,.article-review>div,.article-job{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.article-boundary{justify-content:space-between;margin:24px 0}.article-boundary h1{font-size:24px;margin:2px 0}.article-boundary>span{font-size:13px;color:var(--muted)}.article-actions{margin:0 0 18px}.article-layout{display:grid;grid-template-columns:minmax(0,840px);justify-content:center}.article-layout.with-inspector{grid-template-columns:minmax(0,1fr) 300px;gap:20px}.article-paper{background:var(--document);border:1px solid var(--rule);padding:44px 54px;min-width:0}.article-title{width:100%;resize:none;border:0;background:transparent;color:var(--ink);font-family:'Source Serif 4',serif;font-weight:500;font-size:42px;line-height:1.12;padding:0;outline-offset:5px}.article-toolbar{border-bottom:1px solid var(--rule);padding:12px 0;margin:12px 0 28px;gap:4px}.article-toolbar button{font-size:13px;padding:8px;min-height:38px;border-radius:4px}.article-toolbar button[aria-pressed=true]{background:var(--paper)}.article-writing :deep(.tiptap){font-family:'Source Serif 4',serif;font-size:19px;line-height:1.65;min-height:330px;outline-offset:8px;white-space:pre-wrap;overflow-wrap:anywhere}.article-writing :deep(p){margin:0 0 1em}.article-writing :deep(h2){font-size:28px;line-height:1.3;margin:1.4em 0 .6em}.article-writing :deep(ul),.article-writing :deep(ol){padding-left:26px}.article-writing :deep(.article-evidence){border-bottom:2px solid var(--success);background:color-mix(in srgb,var(--success) 8%,transparent)}.article-review{margin-top:34px;padding-top:18px;border-top:1px solid var(--rule);font-size:13px;color:var(--muted)}.article-mode{display:flex;gap:7px;align-items:center}.article-review>div{justify-content:space-between}.article-inspector{min-width:0;border-left:1px solid var(--rule);padding-left:20px;font-size:14px}.article-inspector>header{justify-content:space-between}.article-inspector h2{font-size:18px}.article-inspector>header button{font-size:26px;min-width:40px;min-height:40px}.article-inspector textarea{width:100%;border:1px solid var(--rule);padding:10px;background:var(--document);margin:10px 0}.article-version,.article-evidence-item{padding:18px 0;border-bottom:1px solid var(--rule)}.article-version h3,.article-evidence-item h3{font-size:15px;margin:0}.article-version p,.article-inspector p{line-height:1.55;margin:10px 0}.article-inspector blockquote{border-left:2px solid var(--rule);padding-left:12px;font-family:'Source Serif 4',serif}.article-inspector pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:380px;overflow:auto}.article-notice,.article-error{padding:14px 0;line-height:1.6;border-top:1px solid var(--rule)}.article-error{color:var(--error)}.article-proposals,.article-job{margin-top:18px;font-size:14px}.article-version label{display:block;margin:12px 0;line-height:1.5}
@media(max-width:1050px){.article-layout.with-inspector{grid-template-columns:minmax(0,1fr)}.article-inspector{border-left:0;border-top:1px solid var(--rule);padding:20px 0}.article-paper{padding:36px}}
@media(max-width:600px){.article-paper{padding:22px 18px}.article-title{font-size:32px}.article-writing :deep(.tiptap){font-size:18px}.article-actions{gap:8px}.article-boundary{align-items:flex-start}.article-toolbar{gap:0}.article-toolbar button{padding:7px}.article-review>div{align-items:flex-start}}
</style>
