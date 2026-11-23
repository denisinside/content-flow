<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getProjectReadinessPreview, invalidateProjectReadiness } from '../lib/project-readiness'

type OutputFormat = 'ARTICLE' | 'TELEGRAM_POST' | 'LINKEDIN_TEXT' | 'LINKEDIN_COVER' | 'INSTAGRAM_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES' | 'LINKEDIN_CAROUSEL_SCRIPT' | 'INSTAGRAM_CAROUSEL_SCRIPT' | 'INSTAGRAM_STORIES_SCRIPT' | 'LINKEDIN_COVER_VISUAL' | 'INSTAGRAM_COVER_VISUAL' | 'LINKEDIN_CAROUSEL_VISUAL' | 'INSTAGRAM_CAROUSEL_VISUAL' | 'INSTAGRAM_STORIES_VISUAL'
type PackageFormat = 'TXT' | 'MARKDOWN' | 'JSON' | 'PNG' | 'PDF' | 'ZIP'
type ExportStatus = 'REQUESTED' | 'BUILDING' | 'READY' | 'FAILED' | 'CANCELLED' | 'OBSOLETE'
interface ReadinessItem {
  format: string
  title: string
  revisionId: string | null
  number: number | null
  reviewCounter: number | null
  contentMode: 'FACTUAL' | 'CREATIVE' | null
  ready: boolean
  reasons: string[]
}
interface ExportRecord {
  id: string
  format: PackageFormat
  status: ExportStatus
  createdAt: string
  jobId: string
  retryAllowed: boolean
  errorCategory: string | null
  filename: string | null
}
interface Readiness {
  projectRevision: number
  ready: boolean
  items: ReadinessItem[]
  exports: ExportRecord[]
}
interface Selection {
  format: OutputFormat
  revisionId: string
  reviewCounter: number
  title: string
  number: number
  contentMode: 'FACTUAL' | 'CREATIVE' | null
}
const props = defineProps<{ projectId: string; topic: string; csrfToken: string; userId: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; 'open-material': [format: string] }>()
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}/exports`
const projectBase = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
const state = ref<Readiness | null>(null)
const selected = ref<Selection[]>([])
const packageFormat = ref<PackageFormat>('TXT')
const loading = ref(true)
const historyLoading = ref(false)
const historyError = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
let disposed = false
let sessionEnded = false
let controller = new AbortController()
let pollTimer: ReturnType<typeof setTimeout> | undefined
const objectUrls = new Set<string>()
let pendingCommand: { key: string; identity: string } | null = null

const pendingExports = computed(() => (state.value?.exports ?? []).some(item => ['REQUESTED', 'BUILDING'].includes(item.status)))
const selectedMatchesReadiness = computed(() => selected.value.length > 0 && selected.value.every(selection => {
  const item = state.value?.items.find(candidate => candidate.format === selection.format)
  return !!item && item.ready && item.revisionId === selection.revisionId && item.reviewCounter === selection.reviewCounter
}))
const canBuild = computed(() => {
  if (props.archived || busy.value || !selectedMatchesReadiness.value) return false
  if (packageFormat.value === 'ZIP') return selected.value.length >= 1 && selected.value.length <= 16
  if (selected.value.length !== 1) return false
  const format = selected.value[0]!.format
  const script = format.endsWith('_SCRIPT')
  const visual = format.endsWith('_VISUAL')
  const coverVisual = ['LINKEDIN_COVER_VISUAL', 'INSTAGRAM_COVER_VISUAL'].includes(format)
  const carouselVisual = ['LINKEDIN_CAROUSEL_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL'].includes(format)
  if (packageFormat.value === 'JSON') return script
  if (packageFormat.value === 'PNG') return coverVisual
  if (packageFormat.value === 'PDF') return carouselVisual
  if (visual) return false
  return packageFormat.value === 'TXT' ? !script : true
})
const readyCount = computed(() => state.value?.items.filter(item => item.ready).length ?? 0)
const readinessFilter = ref<'ALL' | 'READY' | 'BLOCKED'>('ALL')
const visibleReadinessItems = computed(() => {
  const all = state.value?.items ?? []
  return all.filter(item => readinessFilter.value === 'ALL'
    || (readinessFilter.value === 'READY' ? item.ready && supported(item) : !item.ready || !supported(item)))
    .sort((a, b) => Number(b.ready && supported(b)) - Number(a.ready && supported(a)))
})
function isExportable(item: ReadinessItem) { return item.ready && supported(item) }
function isGroupStart(index: number, item: ReadinessItem) {
  return index === 0 || isExportable(visibleReadinessItems.value[index - 1]!) !== isExportable(item)
}
function visibleReasons(item: ReadinessItem) {
  const reasons = item.reasons.filter(reason => reason !== 'INPUTS_CHANGED' || item.reasons.length === 1)
  return [...new Set((reasons.length ? reasons : ['APPROVAL_REQUIRED']).map(reasonLabel))]
}
function nextStep(item: ReadinessItem): { label: string; target: string } {
  if (item.reasons.some(reason => reason.startsWith('SOURCE_EVIDENCE') || reason.includes('CITATION') || reason.includes('EVIDENCE') || reason.includes('UNSEALED'))) {
    return { label: 'Перевірити докази', target: 'FACTS' }
  }
  if (item.reasons.some(reason => reason.includes('BRIEF'))) {
    return { label: 'Перевірити бриф', target: 'BRIEF' }
  }
  if (item.reasons.some(reason => reason.includes('PARENT')) && item.format.endsWith('_VISUAL')) {
    const source = item.format.slice(0, -7)
    return { label: 'Перевірити вихідний матеріал', target: /_(CAROUSEL|STORIES)$/.test(source) ? `${source}_SCRIPT` : source }
  }
  if (item.format.endsWith('_VISUAL')) return { label: 'Відкрити редактор візуалу', target: item.format }
  if (item.format === 'ARTICLE') return { label: 'Перевірити версію статті', target: item.format }
  return { label: item.revisionId ? 'Перевірити погодження' : 'Підготувати та погодити', target: item.format }
}

function supported(item: ReadinessItem): item is ReadinessItem & { format: OutputFormat; revisionId: string; number: number; reviewCounter: number } {
  return ['ARTICLE', 'TELEGRAM_POST', 'LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'LINKEDIN_CAROUSEL_SCRIPT', 'INSTAGRAM_CAROUSEL_SCRIPT', 'INSTAGRAM_STORIES_SCRIPT', 'LINKEDIN_COVER_VISUAL', 'INSTAGRAM_COVER_VISUAL', 'LINKEDIN_CAROUSEL_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL', 'INSTAGRAM_STORIES_VISUAL'].includes(item.format) && !!item.revisionId && item.number !== null && item.reviewCounter !== null
}
function isSelected(item: ReadinessItem) {
  return supported(item) && selected.value.some(row => row.format === item.format && row.revisionId === item.revisionId && row.reviewCounter === item.reviewCounter)
}
function toggle(item: ReadinessItem) {
  if (!supported(item) || !item.ready || busy.value) return
  const existing = selected.value.findIndex(row => row.format === item.format)
  const same = existing >= 0 && selected.value[existing]?.revisionId === item.revisionId && selected.value[existing]?.reviewCounter === item.reviewCounter
  if (same) selected.value.splice(existing, 1)
  else {
    if (existing >= 0) selected.value.splice(existing, 1)
    selected.value.push({ format: item.format, revisionId: item.revisionId, reviewCounter: item.reviewCounter, title: item.title, number: item.number, contentMode: item.contentMode })
  }
  pendingCommand = null
  if (selected.value.length > 1) packageFormat.value = 'ZIP'
  else if (selected.value.length === 1) packageFormat.value = defaultPackageFormat(selected.value[0]!.format)
}
function removeSelection(item: Selection) {
  selected.value = selected.value.filter(row => row.format !== item.format || row.revisionId !== item.revisionId || row.reviewCounter !== item.reviewCounter)
  pendingCommand = null
  if (selected.value.length === 1) packageFormat.value = defaultPackageFormat(selected.value[0]!.format)
  else if (selected.value.length > 1) packageFormat.value = 'ZIP'
}
function reasonLabel(reason: string) {
  const specific: Record<string, string> = {
    APPROVAL_REQUIRED: 'Ще немає актуальної погодженої версії.',
    PARENT_NOT_APPROVED: 'Спочатку погодьте матеріал, на якому засновано цей формат.',
    PARENT_REVIEW_CHANGED: 'Після зміни погодження вихідного матеріалу перевірте цей формат повторно.',
    SOURCE_CITATION_INTEGRITY: 'Посилання на джерела в сценарії потребують перевірки.',
    UNSEALED_EVIDENCE: 'Потрібно перевірити прив’язки до доказів.',
    BRIEF_CHANGED: 'Після погодження змінився бриф.',
    OUTLINE_CHANGED: 'Після погодження змінився план статті.',
    WORKSPACE_STYLE_CHANGED: 'Після погодження змінився стиль простору.',
    SOURCE_ARTICLE_CHANGED: 'Змінилася погоджена версія статті, на якій ґрунтується матеріал.',
    SOURCE_ARTICLE_NEEDS_REVIEW: 'Погоджена стаття потребує перегляду.',
    PARENT_CHANGED: 'Змінився текст або сценарій, з якого створено візуал.',
    PARENT_UNAVAILABLE: 'Погодьте актуальний текст або сценарій для цього візуалу.',
    PARENT_NOT_ELIGIBLE: 'Текст або сценарій візуалу потребує перегляду.',
    PARENT_INTEGRITY: 'Оновіть зв’язок візуалу з погодженим текстом або сценарієм.',
  }
  if (specific[reason]) return specific[reason]
  const value = reason.toLowerCase()
  if (value.includes('visual') && (value.includes('approval') || value.includes('unapproved') || value.includes('not_approved'))) return 'Потрібне окреме погодження візуальної версії.'
  if (value.includes('visual') && (value.includes('stale') || value.includes('review') || value.includes('changed'))) return 'Візуал або його сценарій змінилися — перегляньте версію.'
  if (value.includes('approval') || value.includes('not_approved') || value.includes('unapproved')) return 'Потрібне погодження редактора.'
  if (value.includes('stale') || value.includes('review') || value.includes('changed')) return 'Залежності змінилися — перегляньте матеріал.'
  if (value.includes('invalid') || value.includes('withdraw') || value.includes('evidence') || value.includes('conflict')) return 'Потрібно перевірити джерельні посилання або узгодити зміни.'
  if (value.includes('unimplemented') || value.includes('not_implemented') || value.includes('unsupported') || value.includes('not_available')) return 'Цей формат ще не можна експортувати.'
  if (value.includes('preview') || value.includes('render') || value.includes('overflow')) return 'Потрібно підготувати коректне серверне прев’ю всіх кадрів.'
  if (value.includes('asset') || value.includes('frame')) return 'Не готове потрібне зображення або кадр.'
  if (value.includes('missing') || value.includes('required')) return 'Не готові потрібні для цього матеріалу дані.'
  return 'Матеріал поки не готовий до експорту.'
}
function formatLabel(format: string) {
  if (format === 'ARTICLE') return 'Стаття'
  if (format === 'TELEGRAM_POST') return 'Допис у Telegram'
  if (format === 'LINKEDIN_TEXT') return 'Публікація у LinkedIn'
  if (format === 'LINKEDIN_COVER') return 'Обкладинка LinkedIn'
  if (format === 'INSTAGRAM_COVER') return 'Обкладинка Instagram'
  if (format === 'LINKEDIN_CAROUSEL') return 'Карусель LinkedIn'
  if (format === 'INSTAGRAM_CAROUSEL') return 'Карусель Instagram'
  if (format === 'INSTAGRAM_STORIES') return 'Історії Instagram'
  if (format === 'LINKEDIN_CAROUSEL_SCRIPT') return 'Сценарій каруселі LinkedIn'
  if (format === 'INSTAGRAM_CAROUSEL_SCRIPT') return 'Сценарій каруселі Instagram'
  if (format === 'INSTAGRAM_STORIES_SCRIPT') return 'Сценарій історій Instagram'
  if (format === 'LINKEDIN_COVER_VISUAL') return 'Готова обкладинка LinkedIn'
  if (format === 'INSTAGRAM_COVER_VISUAL') return 'Готова обкладинка Instagram'
  if (format === 'LINKEDIN_CAROUSEL_VISUAL') return 'Готова карусель LinkedIn'
  if (format === 'INSTAGRAM_CAROUSEL_VISUAL') return 'Готова карусель Instagram'
  if (format === 'INSTAGRAM_STORIES_VISUAL') return 'Готові історії Instagram'
  return 'Інший вибраний формат'
}
function defaultPackageFormat(format: OutputFormat): PackageFormat {
  if (format.endsWith('_SCRIPT')) return 'MARKDOWN'
  if (format.endsWith('_COVER_VISUAL')) return 'PNG'
  if (format.endsWith('_CAROUSEL_VISUAL')) return 'PDF'
  if (format === 'INSTAGRAM_STORIES_VISUAL') return 'ZIP'
  return 'TXT'
}
function statusLabel(status: ExportStatus) {
  return ({ REQUESTED: 'У черзі', BUILDING: 'Готуємо файл', READY: 'Готовий', FAILED: 'Не вдалося підготувати', CANCELLED: 'Скасований', OBSOLETE: 'Входи змінилися' } satisfies Record<ExportStatus, string>)[status]
}
function safeError(category: string | null) {
  if (!category) return 'Спробуйте повторити або створити новий файл.'
  const value = category.toLowerCase()
  if (value.includes('stale') || value.includes('obsolete') || value.includes('conflict') || value.includes('changed')) return 'Поки файл готувався, вибрані матеріали змінилися. Перевірте готовність і створіть новий файл.'
  if (value.includes('denied') || value.includes('invalid') || value.includes('eligib')) return 'Перевірте погодження та готовність вибраних матеріалів.'
  return 'Сталася помилка підготовки. Попередні погоджені матеріали залишилися доступними.'
}
function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Час недоступний' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function exportError(status: number) {
  if (status === 409) return 'Матеріали змінилися. Вибір збережено; оновлено перевірку готовності.'
  if (status === 403) return 'Завантаження недоступне для цього облікового запису.'
  if (status === 404) return 'Файл більше недоступний. Оновіть історію експорту.'
  return 'Не вдалося виконати запит. Спробуйте ще раз.'
}

async function readState(url: string): Promise<Readiness | null> {
  if (url === `${base}?view=items`) {
    try { return await getProjectReadinessPreview<Readiness>(props.projectId, props.userId) }
    catch (cause) {
      const status = (cause as { status?: number }).status ?? 0
      if (status === 401) { sessionEnded = true; emit('session-expired'); return null }
      throw new Error(exportError(status))
    }
  }
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
  if (response.status === 401) { sessionEnded = true; emit('session-expired'); return null }
  if (!response.ok) throw new Error(exportError(response.status))
  return await response.json() as Readiness
}
async function getState(firstLoad = false): Promise<boolean> {
  const result = await readState(firstLoad ? `${base}?view=items` : base)
  if (!result || disposed) return false
  state.value = result
  historyError.value = false
  if (firstLoad) {
    const initialState = state.value
    loading.value = false
    historyLoading.value = true
    try {
      const history = await readState(`${base}?view=history`)
      if (!history || disposed) return false
      if (state.value === initialState) state.value = { ...result, exports: history.exports }
    } catch {
      if (!disposed && !sessionEnded && state.value === initialState) historyError.value = true
    } finally { historyLoading.value = false }
  }
  return true
}
async function refresh(force = false) {
  if (force) invalidateProjectReadiness(props.projectId, props.userId)
  try {
    if (await getState(loading.value && !state.value)) {
      error.value = ''
      if (pendingExports.value) schedulePoll(1800)
      else clearTimeout(pollTimer)
    }
  } catch (cause) {
    if (!disposed && !sessionEnded) {
      error.value = cause instanceof Error ? cause.message : 'Не вдалося перевірити готовність.'
      if (pendingExports.value) schedulePoll(3500)
    }
  } finally { loading.value = false }
}
function schedulePoll(delay: number) {
  clearTimeout(pollTimer)
  if (!disposed && !sessionEnded) pollTimer = setTimeout(() => void refresh(true), delay)
}
function commandKeyFor(identity: string) {
  if (pendingCommand?.identity !== identity) pendingCommand = { key: crypto.randomUUID(), identity }
  return pendingCommand.key
}
async function createExport() {
  if (!canBuild.value || !state.value) return
  const payload = { expectedProjectRevision: state.value.projectRevision, format: packageFormat.value, items: selected.value.map(({ format, revisionId, reviewCounter }) => ({ format, revisionId, reviewCounter })) }
  const identity = JSON.stringify(payload)
  busy.value = true; error.value = ''; notice.value = ''
  try {
    const response = await fetch(base, { credentials: 'same-origin', signal: controller.signal, method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify({ ...payload, commandKey: commandKeyFor(identity) }) })
    if (response.status === 401) { sessionEnded = true; emit('session-expired'); return }
    if (!response.ok) {
      if (response.status === 409) await getState()
      throw new Error(exportError(response.status))
    }
    await response.json() as { exportId: string; jobId: string }
    pendingCommand = null
    invalidateProjectReadiness(props.projectId, props.userId)
    notice.value = 'Файл додано до черги. Матеріали можна й далі переглядати.'
    await refresh()
    schedulePoll(700)
  } catch (cause) {
    if (!disposed && !sessionEnded) error.value = cause instanceof Error ? cause.message : 'Не вдалося створити файл.'
  } finally { busy.value = false }
}
function contentDispositionFilename(value: string | null, fallback: string) {
  if (!value) return fallback
  const extended = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1]
  let name = fallback
  try { if (extended) name = decodeURIComponent(extended); else if (plain) name = plain } catch { if (plain) name = plain }
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+$/, 'export') || fallback
}
async function download(item: ExportRecord) {
  if (busy.value || item.status !== 'READY') return
  busy.value = true; error.value = ''
  try {
    const response = await fetch(`${base}/${encodeURIComponent(item.id)}/download`, { credentials: 'same-origin', signal: controller.signal })
    if (response.status === 401) { sessionEnded = true; emit('session-expired'); return }
    if (!response.ok) throw new Error(exportError(response.status))
    const blob = await response.blob()
    const url = URL.createObjectURL(blob); objectUrls.add(url)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = contentDispositionFilename(response.headers.get('Content-Disposition'), item.filename || `export-${item.id}.${item.format.toLowerCase()}`)
    anchor.hidden = true
    document.body.append(anchor); anchor.click(); anchor.remove()
    window.setTimeout(() => { URL.revokeObjectURL(url); objectUrls.delete(url) }, 0)
    notice.value = 'Завантаження розпочато.'
  } catch (cause) { if (!disposed && !sessionEnded) error.value = cause instanceof Error ? cause.message : 'Файл не вдалося завантажити.' }
  finally { busy.value = false }
}
async function jobAction(item: ExportRecord, action: 'retry' | 'cancel') {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    const response = await fetch(`${projectBase}/jobs/${encodeURIComponent(item.jobId)}/${action}`, { credentials: 'same-origin', method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: '{}' })
    if (response.status === 401) { sessionEnded = true; emit('session-expired'); return }
    if (!response.ok) throw new Error(exportError(response.status))
    await refresh()
    notice.value = action === 'retry' ? 'Повторну підготовку поставлено в чергу.' : 'Скасування передано завданню.'
  } catch (cause) { if (!disposed && !sessionEnded) error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { busy.value = false }
}
function retry(item: ExportRecord) { return jobAction(item, 'retry') }
function cancel(item: ExportRecord) { return jobAction(item, 'cancel') }

onMounted(() => { void refresh() })
onBeforeUnmount(() => {
  disposed = true
  controller.abort()
  clearTimeout(pollTimer)
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls.clear()
})
</script>

<template>
  <section
    class="export-workspace"
    aria-labelledby="export-title"
  >
    <header class="export-heading">
      <div>
        <h1 id="export-title">
          Готовність і експорт
        </h1>
        <p class="export-lead">
          Оберіть матеріали для завантаження. Обкладинки доступні у PNG, каруселі — у PDF, а кілька матеріалів можна зібрати в ZIP.
        </p>
      </div>
    </header>

    <section
      v-if="loading"
      class="export-loading"
      aria-label="Перевіряємо готовність матеріалів"
      role="status"
    >
      <Skeleton class="export-skeleton" />
      <Skeleton class="export-skeleton export-skeleton-short" />
    </section>

    <template v-else-if="state">
      <p
        class="export-readiness"
        role="status"
        aria-live="polite"
      >
        Готові матеріали: {{ readyCount }} із {{ state.items.length }} форматів у проєкті.
      </p>

      <section
        class="export-items"
        aria-labelledby="export-items-title"
      >
        <div class="export-section-heading">
          <h2 id="export-items-title">
            Матеріали проєкту
          </h2>
          <Button
            variant="outline"
            class="workspace-button"
            :disabled="busy"
            @click="refresh(true)"
          >
            Оновити перевірку
          </Button>
        </div>
        <div
          v-if="state.items.length"
          class="export-readiness-filters"
          role="group"
          aria-label="Фільтр готовності"
        >
          <button
            type="button"
            :aria-pressed="readinessFilter === 'ALL'"
            @click="readinessFilter = 'ALL'"
          >
            Усі ({{ state.items.length }})
          </button>
          <button
            type="button"
            :aria-pressed="readinessFilter === 'READY'"
            @click="readinessFilter = 'READY'"
          >
            Готові ({{ readyCount }})
          </button>
          <button
            type="button"
            :aria-pressed="readinessFilter === 'BLOCKED'"
            @click="readinessFilter = 'BLOCKED'"
          >
            Потребують дій ({{ state.items.length - readyCount }})
          </button>
        </div>
        <p
          v-if="!state.items.length"
          class="export-empty"
        >
          У проєкті поки немає матеріалів для експорту.
        </p>
        <p
          v-else-if="!visibleReadinessItems.length"
          class="export-empty"
        >
          Немає матеріалів у цій категорії.
        </p>
        <template
          v-for="(item, index) in visibleReadinessItems"
          :key="item.format"
        >
          <h3
            v-if="isGroupStart(index, item)"
            class="export-group-title"
          >
            {{ isExportable(item) ? 'Готові до експорту' : 'Потрібні дії' }}
          </h3>
          <article class="export-item">
            <label class="export-choice">
              <input
                type="checkbox"
                :aria-label="`Вибрати ${formatLabel(item.format)}`"
                :checked="isSelected(item)"
                :disabled="!supported(item) || !item.ready || busy || props.archived"
                @change="toggle(item)"
              >
              <span class="export-item-title">{{ formatLabel(item.format) }}</span>
            </label>
            <p
              class="export-item-state"
              :class="{ 'export-item-state-pending': !isExportable(item) }"
            >
              <span>{{ isExportable(item) ? 'Готово' : item.revisionId ? 'Потребує перевірки' : 'Немає погодженої версії' }}</span>
              <span
                v-if="item.contentMode === 'CREATIVE'"
                class="export-unverified"
              >Авторський текст · без перевірки в джерелах</span>
            </p>
            <ul
              v-if="!isExportable(item)"
              class="export-reasons-list"
            >
              <li
                v-for="reason in visibleReasons(item)"
                :key="reason"
              >
                {{ reason }}
              </li>
            </ul>
            <Button
              v-if="!isExportable(item) && !item.reasons.some(reason => reason.includes('NOT_IMPLEMENTED') || reason.includes('UNSUPPORTED'))"
              variant="outline"
              class="workspace-button export-next-step"
              @click="emit('open-material', nextStep(item).target)"
            >
              {{ nextStep(item).label }}
            </Button>
            <details
              v-if="item.revisionId"
              class="export-provenance"
            >
              <summary>Версія й перегляд</summary>
              <dl><dt>Версія матеріалу</dt><dd>{{ item.number ?? '—' }}</dd><dt>Перегляди залежностей</dt><dd>{{ item.reviewCounter ?? '—' }}</dd><dt>Ідентифікатор версії</dt><dd>{{ item.revisionId }}</dd></dl>
            </details>
          </article>
        </template>
      </section>

      <section
        class="export-builder"
        aria-labelledby="export-builder-title"
      >
        <h2 id="export-builder-title">
          Створити файл
        </h2>
        <p
          v-if="props.archived"
          class="export-reasons"
        >
          Архівований проєкт доступний для перегляду, але новий файл створити не можна.
        </p>
        <p
          v-else-if="!selected.length"
          class="export-muted"
        >
          Спочатку виберіть готовий матеріал.
        </p>
        <div
          v-else
          class="export-selected"
          aria-label="Вибрані матеріали"
        >
          <div
            v-for="item in selected"
            :key="`${item.format}:${item.revisionId}:${item.reviewCounter}`"
            class="export-selected-row"
          >
            <span>{{ formatLabel(item.format) }} (версія {{ item.number }})<span v-if="item.contentMode === 'CREATIVE'">, авторський текст</span></span>
            <span
              v-if="!selectedMatchesReadiness"
              class="export-stale-choice"
            >Потрібно вибрати актуальну версію</span>
            <Button
              variant="ghost"
              class="workspace-button"
              :disabled="busy"
              @click="removeSelection(item)"
            >
              Прибрати
            </Button>
          </div>
        </div>
        <fieldset
          class="export-formats"
          :disabled="busy || props.archived || !selected.length"
        >
          <legend>Формат файлу</legend>
          <label v-if="!selected.length || (selected.length === 1 && !selected[0]?.format.endsWith('_SCRIPT') && !selected[0]?.format.endsWith('_VISUAL'))"><input
            v-model="packageFormat"
            type="radio"
            value="TXT"
          > Текст TXT</label>
          <label v-if="!selected.length || (selected.length === 1 && !selected[0]?.format.endsWith('_VISUAL'))"><input
            v-model="packageFormat"
            type="radio"
            value="MARKDOWN"
          > Markdown</label>
          <label v-if="!selected.length || (selected.length === 1 && selected[0]?.format.endsWith('_SCRIPT'))">
            <input
              v-model="packageFormat"
              type="radio"
              value="JSON"
              :disabled="selected.length !== 1 || !selected[0]?.format.endsWith('_SCRIPT')"
            >
            JSON сценарію
          </label>
          <label v-if="!selected.length || (selected.length === 1 && ['LINKEDIN_COVER_VISUAL', 'INSTAGRAM_COVER_VISUAL'].includes(selected[0]?.format ?? ''))">
            <input
              v-model="packageFormat"
              type="radio"
              value="PNG"
              :disabled="selected.length !== 1 || !['LINKEDIN_COVER_VISUAL', 'INSTAGRAM_COVER_VISUAL'].includes(selected[0]?.format ?? '')"
            >
            PNG обкладинки
          </label>
          <label v-if="!selected.length || (selected.length === 1 && ['LINKEDIN_CAROUSEL_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL'].includes(selected[0]?.format ?? ''))">
            <input
              v-model="packageFormat"
              type="radio"
              value="PDF"
              :disabled="selected.length !== 1 || !['LINKEDIN_CAROUSEL_VISUAL', 'INSTAGRAM_CAROUSEL_VISUAL'].includes(selected[0]?.format ?? '')"
            >
            PDF каруселі
          </label>
          <label><input
            v-model="packageFormat"
            type="radio"
            value="ZIP"
          > ZIP-архів</label>
          <p
            v-if="packageFormat === 'JSON' && selected.length === 1 && !selected[0]?.format.endsWith('_SCRIPT')"
            class="export-muted"
          >
            JSON доступний для погодженого сценарію кадрів.
          </p>
          <p
            v-if="packageFormat === 'TXT' && selected.some(item => item.format.endsWith('_SCRIPT'))"
            class="export-muted"
          >
            Сценарії доступні як JSON, читабельний Markdown або пакет ZIP.
          </p>
          <p
            v-if="packageFormat === 'PNG' && selected.length === 1 && !selected[0]?.format.endsWith('_COVER_VISUAL')"
            class="export-muted"
          >
            PNG доступний для однієї погодженої обкладинки.
          </p>
          <p
            v-if="packageFormat === 'PDF' && selected.length === 1 && !selected[0]?.format.endsWith('_CAROUSEL_VISUAL')"
            class="export-muted"
          >
            PDF доступний для однієї погодженої каруселі; історії залишаються набором PNG у ZIP.
          </p>
          <p
            v-if="packageFormat === 'ZIP' && selected.length > 16"
            class="export-reasons"
          >
            ZIP підтримує до шістнадцяти вибраних матеріалів.
          </p>
        </fieldset>
        <Button
          class="workspace-button workspace-button-primary"
          :disabled="!canBuild"
          @click="createExport"
        >
          {{ busy ? 'Виконуємо…' : 'Підготувати файл' }}
        </Button>
      </section>

      <section
        class="export-history"
        aria-labelledby="export-history-title"
      >
        <h2 id="export-history-title">
          Файли й завдання
        </h2>
        <p
          v-if="pendingExports"
          class="export-muted"
          role="status"
          aria-live="polite"
        >
          Оновлюємо стан підготовки, поки файл у черзі.
        </p>
        <p
          v-if="historyLoading"
          role="status"
          class="export-muted"
        >
          Завантажуємо історію файлів…
        </p>
        <p
          v-if="!historyLoading && !historyError && !state.exports.length"
          class="export-muted"
        >
          Створені файли з’являться тут.
        </p>
        <p
          v-if="historyError"
          role="alert"
        >
          Не вдалося завантажити історію файлів.
          <Button
            variant="outline"
            class="workspace-button"
            :disabled="busy"
            @click="refresh"
          >
            Повторити перевірку
          </Button>
        </p>
        <article
          v-for="item in state.exports"
          :key="item.id"
          class="export-history-row"
        >
          <div>
            <h3>{{ item.filename || `${item.format} · ${dateLabel(item.createdAt)}` }}</h3>
            <p>{{ statusLabel(item.status) }} · {{ dateLabel(item.createdAt) }}</p>
            <p
              v-if="item.status === 'FAILED' || item.status === 'OBSOLETE'"
              class="export-reasons"
            >
              {{ safeError(item.status === 'OBSOLETE' ? 'OBSOLETE' : item.errorCategory) }}
            </p>
          </div>
          <div class="export-history-actions">
            <Button
              v-if="item.status === 'READY'"
              variant="outline"
              class="workspace-button"
              :disabled="busy"
              @click="download(item)"
            >
              Завантажити
            </Button>
            <Button
              v-if="item.status === 'FAILED' && item.retryAllowed"
              variant="outline"
              class="workspace-button"
              :disabled="busy || props.archived"
              @click="retry(item)"
            >
              Повторити
            </Button>
            <Button
              v-if="['REQUESTED', 'BUILDING'].includes(item.status)"
              variant="ghost"
              class="workspace-button"
              :disabled="busy"
              @click="cancel(item)"
            >
              Скасувати
            </Button>
            <details class="export-job-details">
              <summary>Докладніше</summary><p>Завдання {{ item.jobId }} · {{ item.errorCategory ? safeError(item.errorCategory) : 'Технічний стан збережено в історії.' }}</p>
            </details>
          </div>
        </article>
      </section>
    </template>

    <p
      v-if="error"
      class="export-error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-else-if="notice"
      class="export-notice"
      role="status"
      aria-live="polite"
    >
      {{ notice }}
    </p>
  </section>
</template>

<style scoped>
.export-workspace { width: 100%; max-width: 1220px; min-width: 0; margin-inline: auto; color: var(--ink); }
.export-heading { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin: 0 0 22px; }
.export-heading h1 { max-width: 18ch; margin: 0; font: 550 39px/1.2 SourceSerif, Georgia, serif; letter-spacing: -.025em; }
.export-context { max-width: 60ch; margin: 0 0 7px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.export-lead { max-width: 70ch; margin: 10px 0 0; color: var(--lead-ink, #555a60); font: 17px/1.55 SourceSerif, Georgia, serif; }
.export-readiness { margin: 0; padding: 12px 0; border-block: 1px solid var(--rule); color: var(--muted); font-size: 13px; }
.export-items, .export-builder, .export-history { margin-top: 32px; }
.export-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.export-workspace h2 { margin: 0; font: 550 25px/1.3 SourceSerif, Georgia, serif; }
.export-item { min-width: 0; padding: 16px 0; border-top: 1px solid var(--rule); }
.export-readiness-filters { display:flex; flex-wrap:wrap; align-items:center; gap:16px; margin:16px 0; border-bottom:1px solid var(--rule); }
.export-readiness-filters button { min-height:40px; border:0; border-bottom:2px solid transparent; padding:8px 0; background:transparent; color:var(--muted); font:500 12px var(--sans); cursor:pointer; }
.export-readiness-filters button[aria-pressed='true'] { border-color:var(--ink); color:var(--ink); }
.export-group-title { font:550 18px/1.4 SourceSerif,Georgia,serif; margin:20px 0 10px; }
.export-item:first-of-type { margin-top: 12px; }
.export-item-state-pending { color:var(--review, #945000); }
.export-reasons-list { margin:8px 0 10px 29px; padding-left:18px; font-size:13px; color:var(--review,#945000); line-height:1.55; }
.export-reasons-list li+li { margin-top:3px; }
.export-next-step { margin:4px 0 4px 29px; }
.export-choice { display: flex; align-items: flex-start; gap: 12px; min-height: 36px; cursor: pointer; }
.export-choice input, .export-formats input { flex: none; width: 17px; height: 17px; margin: 3px 0 0; accent-color: var(--graphite, #343a40); }
.export-item-title { font: 550 21px/1.35 SourceSerif, Georgia, serif; overflow-wrap: anywhere; }
.export-item-state { display: flex; flex-wrap: wrap; gap: 5px 14px; margin: 5px 0 0 29px; color: var(--approved, #32664b); font-size: 13px; }
.export-unverified { color: var(--review, #945000); }
.export-reasons { margin: 8px 0 0 29px; color: var(--review, #945000); font-size: 13px; line-height: 1.5; }
.export-provenance { margin: 8px 0 0 29px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.export-provenance summary, .export-job-details summary { min-height: 36px; display: inline-flex; align-items: center; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.export-provenance dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 6px 0 0; }
.export-provenance dt { color: var(--muted); }
.export-provenance dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.export-builder { padding: 22px 0; border-block: 1px solid var(--rule); }
.export-selected { margin-top: 10px; border-top: 1px solid var(--rule); }
.export-selected-row { display: flex; align-items: center; gap: 8px 16px; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--rule); font-size: 14px; overflow-wrap: anywhere; }
.export-stale-choice { color: var(--review, #945000); }
.export-formats { display: flex; flex-wrap: wrap; gap: 8px 20px; margin: 18px 0; padding: 0; border: 0; }
.export-formats legend { width: 100%; margin-bottom: 8px; color: var(--muted); font-size: 13px; }
.export-formats label { display: inline-flex; align-items: flex-start; gap: 8px; min-height: 36px; color: var(--ink); font-size: 14px; cursor: pointer; }
.export-muted, .export-empty { margin: 10px 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.export-empty { padding: 18px 0; border-block: 1px solid var(--rule); }
.export-history { border-top: 1px solid var(--ink); }
.export-history > h2 { padding: 18px 0; }
.export-history-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 16px 0; border-top: 1px solid var(--rule); }
.export-history-row h3 { margin: 0; font: 550 19px/1.4 SourceSerif, Georgia, serif; overflow-wrap: anywhere; }
.export-history-row p { margin: 5px 0; color: var(--muted); font-size: 13px; }
.export-history-row .export-reasons { margin-left: 0; color: var(--review, #945000); }
.export-history-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px 12px; }
.export-job-details { width: 100%; color: var(--muted); font-size: 12px; text-align: right; }
.export-job-details p { max-width: 55ch; overflow-wrap: anywhere; }
.export-error, .export-notice { margin: 14px 0; padding: 12px 0; border-block: 1px solid var(--rule); color: var(--review, #945000); font-size: 13px; line-height: 1.5; }
.export-notice { color: var(--approved, #32664b); }
.export-loading { display: grid; gap: 12px; padding-block: 18px; }
.export-skeleton { width: 100%; height: 44px; }
.export-skeleton-short { width: 60%; }
.export-workspace :deep(button:focus-visible), .export-workspace summary:focus-visible, .export-workspace input:focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
@media (max-width: 760px) {
  .export-heading { align-items: start; margin-bottom: 18px; }
  .export-heading h1 { font-size: 34px; }
  .export-lead { font-size: 16px; }
  .export-history-row { flex-direction: column; }
  .export-history-actions { justify-content: flex-start; }
  .export-job-details { text-align: left; }
}
@media (max-width: 480px) {
  .export-section-heading { align-items: flex-start; flex-direction: column; }
  .export-selected-row { align-items: flex-start; flex-direction: column; }
  .export-formats { align-items: flex-start; flex-direction: column; }
  .export-builder > .workspace-button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .export-workspace *, .export-workspace *::before, .export-workspace *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
</style>
