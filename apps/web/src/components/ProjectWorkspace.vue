<script setup lang="ts">
import { defineAsyncComponent, computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import SourceWorkspace from './SourceWorkspace.vue'
import EvidenceWorkspace from './EvidenceWorkspace.vue'
import BriefWorkspace from './BriefWorkspace.vue'
import EditorPresence from './EditorPresence.vue'
import ProjectLifecycle from './ProjectLifecycle.vue'
import { getProjectReadinessPreview, prefetchProjectReadiness, invalidateProjectReadiness } from '../lib/project-readiness'
const loadArticleWorkspace = () => import('./ArticleWorkspace.vue')
const ArticleWorkspace = defineAsyncComponent(loadArticleWorkspace)
function preloadArticleWorkspace() { void loadArticleWorkspace().catch(() => {}) }
const loadTelegramWorkspace = () => import('./TelegramWorkspace.vue')
const loadScriptWorkspace = () => import('./ScriptWorkspace.vue')
const TelegramWorkspace = defineAsyncComponent(loadTelegramWorkspace)
const ScriptWorkspace = defineAsyncComponent(loadScriptWorkspace)
function preloadChannels() {
  void loadTelegramWorkspace().catch(() => {})
  void loadScriptWorkspace().catch(() => {})
}
const loadExportWorkspace = () => import('./ExportWorkspace.vue')
const ExportWorkspace = defineAsyncComponent(loadExportWorkspace)
function preloadExportWorkspace(id: string) {
  void loadExportWorkspace().catch(() => {})
  prefetchProjectReadiness(id, props.userId)
}
const loadVisualWorkspace = () => import('./VisualWorkspace.vue')
const VisualWorkspace = defineAsyncComponent(loadVisualWorkspace)
function preloadVisuals() { void loadVisualWorkspace().catch(() => {}) }

type ChannelFormat = 'LINKEDIN_TEXT' | 'LINKEDIN_COVER' | 'INSTAGRAM_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES' | 'TELEGRAM_POST'
type ProjectFormat =
  | 'ARTICLE'
  | 'LINKEDIN_TEXT'
  | 'LINKEDIN_COVER'
  | 'LINKEDIN_CAROUSEL'
  | 'INSTAGRAM_COVER'
  | 'INSTAGRAM_CAROUSEL'
  | 'INSTAGRAM_STORIES'
  | 'TELEGRAM_POST'

type VisualFormat = 'LINKEDIN_COVER' | 'INSTAGRAM_COVER' | 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES'

interface Project {
  id: string
  workspaceId: string
  topic: string
  formats: ProjectFormat[]
  revision: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  trashedAt: string | null
  purgeAfter: string | null
  canPurge: boolean
}

interface Props {
  csrfToken: string
  userId: string
  workspaceId: string
}

const props = defineProps<Props>()
const emit = defineEmits<{ 'session-expired': []; 'project-workspace': [id: string] }>()

const formats: { id: ProjectFormat; label: string }[] = [
  { id: 'ARTICLE', label: 'Стаття' },
  { id: 'LINKEDIN_TEXT', label: 'Публікація у LinkedIn' },
  { id: 'LINKEDIN_COVER', label: 'Обкладинка LinkedIn' },
  { id: 'LINKEDIN_CAROUSEL', label: 'Карусель LinkedIn' },
  { id: 'INSTAGRAM_COVER', label: 'Обкладинка Instagram' },
  { id: 'INSTAGRAM_CAROUSEL', label: 'Карусель Instagram' },
  { id: 'INSTAGRAM_STORIES', label: 'Історії Instagram' },
  { id: 'TELEGRAM_POST', label: 'Допис у Telegram' },
]

const pathname = ref(window.location.pathname)
const search = ref(window.location.search)
const projects = ref<Project[]>([])
const listState = ref<'ACTIVE' | 'ARCHIVED' | 'TRASHED'>('ACTIVE')
const lifecycleNotice = ref('')
const nextCursor = ref<string | null>(null)
const currentProject = ref<Project | null>(null)
const scriptRefreshEpoch = ref(0)
const visualDirty = ref(false)
const historicalArticle = ref(false)
const listLoading = ref(true)
const detailLoading = ref(false)
const saving = ref(false)
const formOpen = ref(false)
const editing = ref(false)
const listError = ref('')
const detailError = ref('')
const formError = ref('')
const topic = ref('')
const selectedFormats = ref<ProjectFormat[]>([])
const conflict = ref(false)
let requestVersion = 0
let requestController: AbortController | null = null

const page = computed(() => pathname.value.match(/^\/projects\/([0-9a-f-]{36})(?:\/(?:sources|facts|brief|article|channels|telegram|visuals|export))?\/?$/i)?.[1] ?? null)
const isArticle = computed(() => /\/article\/?$/i.test(pathname.value))
const openArticleHistory = computed(() => new URLSearchParams(search.value).get('review') === '1')
const isChannels = computed(() => /\/(?:channels|telegram)\/?$/i.test(pathname.value))
const channelFormats = computed(() => (currentProject.value?.formats.filter((format): format is ChannelFormat => ['LINKEDIN_TEXT', 'LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES', 'TELEGRAM_POST'].includes(format)) ?? []))
const selectedChannelFormat = computed<ChannelFormat>(() => {
  const requested = new URLSearchParams(search.value).get('format')
  if (!requested && /\/telegram\/?$/i.test(pathname.value) && channelFormats.value.includes('TELEGRAM_POST')) return 'TELEGRAM_POST'
  return channelFormats.value.includes(requested as ChannelFormat) ? requested as ChannelFormat : channelFormats.value[0] ?? 'TELEGRAM_POST'
})
const selectedScriptFormat = computed(() => ['LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'].includes(selectedChannelFormat.value) ? selectedChannelFormat.value as 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES' : null)
const isExport = computed(() => /\/export\/?$/i.test(pathname.value))
const isVisuals = computed(() => /\/visuals\/?$/i.test(pathname.value))
const visualFormats = computed(() => (currentProject.value?.formats.filter((format): format is VisualFormat => ['LINKEDIN_COVER', 'INSTAGRAM_COVER', 'LINKEDIN_CAROUSEL', 'INSTAGRAM_CAROUSEL', 'INSTAGRAM_STORIES'].includes(format)) ?? []))
const selectedVisualFormat = computed<VisualFormat>(() => {
  const requested = new URLSearchParams(search.value).get('format')
  return visualFormats.value.includes(requested as VisualFormat) ? requested as VisualFormat : visualFormats.value[0] ?? 'LINKEDIN_COVER'
})
const isDetail = computed(() => page.value !== null)
const isProjectOverview = computed(() => /^\/projects\/[0-9a-f-]{36}\/?$/i.test(pathname.value))
type OverviewSection = 'sources' | 'facts' | 'brief' | 'article' | 'channels' | 'visuals' | 'export'
interface OverviewProgress {
  sources: { total: number; included: number } | null
  briefSaved: boolean | null
  outlineApproved: boolean | null
  items: Array<{ format: string; ready: boolean; revisionId: string | null }> | null
}
const freshOverviewProgress = (): OverviewProgress => ({ sources: null, briefSaved: null, outlineApproved: null, items: null })
const overviewProgress = ref<OverviewProgress>(freshOverviewProgress())
let overviewController: AbortController | null = null
let overviewEpoch = 0
let lastOverviewProjectId: string | null = null
const overviewSteps = computed(() => {
  const result: Array<{ id: OverviewSection; title: string }> = [
    { id: 'sources', title: 'Джерела' },
    { id: 'facts', title: 'Докази' },
    { id: 'brief', title: 'Бриф' },
  ]
  if (currentProject.value?.formats.includes('ARTICLE') || historicalArticle.value) result.push({ id: 'article', title: 'Стаття' })
  if (channelFormats.value.length) result.push({ id: 'channels', title: 'Канали' })
  if (visualFormats.value.length) result.push({ id: 'visuals', title: 'Візуали' })
  result.push({ id: 'export', title: 'Готовність і експорт' })
  return result
})
function overviewPath(section: OverviewSection) {
  const base = `/projects/${currentProject.value?.id ?? ''}`
  if (section === 'channels') return `${base}/channels?format=${selectedChannelFormat.value}`
  if (section === 'visuals') return `${base}/visuals?format=${selectedVisualFormat.value}`
  return `${base}/${section}`
}
function sourceNumberLabel(value: number) {
  const last = value % 10, lastTwo = value % 100
  const form = last === 1 && lastTwo !== 11 ? 'джерело'
    : last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14) ? 'джерела' : 'джерел'
  return `${value} ${form}`
}
function overviewStatus(section: OverviewSection) {
  const summary = overviewProgress.value
  if (section === 'sources') return summary.sources === null ? 'Перевіряємо…'
    : summary.sources.total ? sourceNumberLabel(summary.sources.total) : 'Не розпочато'
  if (section === 'facts') return summary.sources === null ? 'Перевіряємо…'
    : summary.sources.included ? `Обрано ${sourceNumberLabel(summary.sources.included)}` : 'Потрібні джерела'
  if (section === 'brief') return summary.briefSaved === null ? 'Перевіряємо…'
    : summary.outlineApproved ? 'Є погоджений план' : summary.briefSaved ? 'Бриф збережено' : 'Не розпочато'
  const items = summary.items
  if (!items) return 'Перевіряємо…'
  if (section === 'article') {
    const article = items.find(item => item.format === 'ARTICLE')
    return article?.ready ? 'Готово' : article?.revisionId ? 'Потребує перегляду' : 'Немає погодженої статті'
  }
  const formats: string[] = section === 'channels' ? channelFormats.value
    : section === 'visuals' ? visualFormats.value.map(format => `${format}_VISUAL`)
      : items.map(item => item.format)
  const relevant = items.filter(item => formats.includes(item.format))
  return `${relevant.filter(item => item.ready).length} з ${relevant.length} готово`
}
function stopOverviewProgress() { overviewEpoch++; overviewController?.abort(); overviewController = null }
function loadOverviewProgress(id: string) {
  stopOverviewProgress()
  if (lastOverviewProjectId !== id) {
    overviewProgress.value = freshOverviewProgress()
    lastOverviewProjectId = id
  }
  if (!isProjectOverview.value) return
  const current = overviewEpoch
  const controller = new AbortController()
  overviewController = controller
  const loadSection = async (path: string, update: (data: unknown) => void) => {
    try {
      const response = await fetch(`/api/v1/projects/${encodeURIComponent(id)}${path}`, { credentials: 'same-origin', signal: controller.signal })
      if (response.status === 401) { emit('session-expired'); return }
      if (!response.ok || current !== overviewEpoch) return
      const result: unknown = await response.json()
      if (current === overviewEpoch && !controller.signal.aborted) update(result)
    } catch { /* Project navigation remains usable if a summary endpoint is unavailable. */ }
  }
  void loadSection('/materials', data => {
    const materials = (data as { materials?: Array<{ included: boolean }> }).materials ?? []
    overviewProgress.value.sources = { total: materials.length, included: materials.filter(item => item.included).length }
  })
  void loadSection('/editorial', data => {
    const editorial = data as { brief?: { currentRevision?: unknown }; outline?: { currentApprovedRevisionId?: string | null } }
    overviewProgress.value.briefSaved = !!editorial.brief?.currentRevision
    overviewProgress.value.outlineApproved = !!editorial.outline?.currentApprovedRevisionId
  })
  void getProjectReadinessPreview<{ items: NonNullable<OverviewProgress['items']> }>(id, props.userId)
    .then(data => {
      if (current === overviewEpoch && !controller.signal.aborted) overviewProgress.value.items = data.items
    })
    .catch(cause => {
      if ((cause as { status?: number }).status === 401) emit('session-expired')
    })
}
const isTrashed = computed(() => Boolean(currentProject.value?.trashedAt))
const isSources = computed(() => /\/sources\/?$/i.test(pathname.value))
const isBrief = computed(() => /\/brief\/?$/i.test(pathname.value))
const isFacts = computed(() => /\/facts\/?$/i.test(pathname.value))
const presencePage = computed(() => {
  if (!currentProject.value || isTrashed.value || currentProject.value.archivedAt) return null
  if (isArticle.value) return 'article'
  if (isBrief.value) return 'brief'
  if (isSources.value || isFacts.value || isExport.value) return null
  if (isVisuals.value) return null
  if (isChannels.value) {
    return selectedChannelFormat.value === 'TELEGRAM_POST'
      ? 'telegram'
      : selectedChannelFormat.value.toLowerCase().replaceAll('_', '-')
  }
  return 'outline'
})
const canSave = computed(() => topic.value.trim().length > 0 && topic.value.trim().length <= 500 && selectedFormats.value.length > 0 && selectedFormats.value.length <= formats.length)
const hasChanges = computed(() => {
  if (!currentProject.value) return false
  return topic.value.trim() !== currentProject.value.topic || !sameFormats(selectedFormats.value, currentProject.value.formats)
})

function sameFormats(left: ProjectFormat[], right: ProjectFormat[]) {
  return left.length === right.length && left.every(format => right.includes(format))
}

function labelFor(format: ProjectFormat) {
  return formats.find(item => item.id === format)?.label ?? format
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Час оновлення недоступний'
  return new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
}

function routeTo(path: string, push = true) {
  if (`${pathname.value}${search.value}` === path && push) return
  if (isVisuals.value && visualDirty.value && !window.confirm('У візуалі є незбережені правки. Перейти далі? Правки можна буде відновити в цьому браузері.')) return
  if (saving.value) {
    requestController?.abort()
    requestVersion += 1
    saving.value = false
  }
  if (currentProject.value && !isProjectOverview.value && !isExport.value) {
    invalidateProjectReadiness(currentProject.value.id, props.userId)
  }
  closeForm(true)
  clearForm()
  conflict.value = false
  if (push) window.history.pushState({}, '', path)
  else window.history.replaceState({}, '', path)
  pathname.value = window.location.pathname
  search.value = window.location.search
  if (isDetail.value) {
    if (currentProject.value?.id !== page.value) void loadProject(page.value as string)
    else if (isProjectOverview.value) loadOverviewProgress(page.value as string)
    else stopOverviewProgress()
  } else {
    stopOverviewProgress()
    currentProject.value = null
    void loadProjects()
  }
}

function openExportMaterial(projectId: string, format: string) {
  const root = `/projects/${projectId}`
  if (format === 'FACTS') return routeTo(`${root}/facts`)
  if (format === 'SOURCES') return routeTo(`${root}/sources`)
  if (format === 'BRIEF') return routeTo(`${root}/brief`)
  if (format === 'ARTICLE') return routeTo(`${root}/article?review=1`)
  const visual = format.endsWith('_VISUAL')
  const channelFormat = format.replace(/_(VISUAL|SCRIPT)$/u, '')
  routeTo(`${root}/${visual ? 'visuals' : 'channels'}?format=${encodeURIComponent(channelFormat)}`)
}

function chooseListState(value: 'ACTIVE' | 'ARCHIVED' | 'TRASHED') {
  if (listState.value === value) return
  if (formOpen.value && !window.confirm('У формі є незбережені зміни. Перейти до іншого списку та закрити її?')) return
  formOpen.value = false
  editing.value = false
  clearForm()
  listState.value = value
  void loadProjects()
}

function onProjectLifecycleChanged(result: { action: 'archive' | 'trash' | 'restore' | 'purge'; state?: 'ACTIVE' | 'ARCHIVED' | 'TRASHED'; cleanupPending?: boolean }) {
  const { action } = result
  lifecycleNotice.value = action === 'purge'
    ? result.cleanupPending ? 'Проєкт видалено; очищення приватних файлів триває.' : 'Проєкт видалено остаточно.'
    : ''
  if (result.state) listState.value = result.state
  else if (action === 'archive') listState.value = 'ARCHIVED'
  else if (action === 'trash' || action === 'purge') listState.value = 'TRASHED'
  else if (action === 'restore') listState.value = 'ACTIVE'
  if (isDetail.value) {
    routeTo('/projects')
  } else {
    void loadProjects()
  }
}

function onPopState() {
  if (window.location.pathname === '/settings' || (window.location.pathname === pathname.value && window.location.search === search.value)) return
  if (isVisuals.value && visualDirty.value && !window.confirm('У візуалі є незбережені правки. Перейти далі? Правки можна буде відновити в цьому браузері.')) {
    window.history.pushState({}, '', `${pathname.value}${search.value}`)
    return
  }
  requestController?.abort()
  requestVersion += 1
  saving.value = false
  if (currentProject.value && !isProjectOverview.value && !isExport.value) {
    invalidateProjectReadiness(currentProject.value.id, props.userId)
  }
  closeForm(true)
  clearForm()
  conflict.value = false
  pathname.value = window.location.pathname
  search.value = window.location.search
  if (isDetail.value) {
    if (currentProject.value?.id !== page.value) void loadProject(page.value as string)
    else if (isProjectOverview.value) loadOverviewProgress(page.value as string)
    else stopOverviewProgress()
  } else {
    stopOverviewProgress()
    currentProject.value = null
    void loadProjects()
  }
}

function beginRequest() {
  requestController?.abort()
  requestController = new AbortController()
  return { controller: requestController, version: ++requestVersion }
}

function requestIsCurrent(version: number) {
  return version === requestVersion
}

function handleUnauthorized(response: Response) {
  if (response.status !== 401) return false
  emit('session-expired')
  return true
}

function apiError(status: number, action: 'load' | 'save' | 'create') {
  if (status === 503) return 'Сервіс проєктів тимчасово недоступний. Спробуйте ще раз за мить.'
  if (status === 404) return 'Проєкт недоступний або його більше не існує.'
  if (status === 409) return action === 'save'
    ? 'Проєкт змінився або був архівований. Оновіть дані перед збереженням.'
    : 'Не вдалося створити проєкт. Оновіть сторінку та спробуйте ще раз.'
  if (status === 400) return 'Перевірте тему та вибрані формати й повторіть спробу.'
  return 'Не вдалося виконати запит. Перевірте з’єднання та спробуйте ще раз.'
}

async function loadProjects(cursor?: string) {
  if (isDetail.value && !cursor) return
  const { controller, version } = beginRequest()
  if (!cursor) {
    listLoading.value = true
    listError.value = ''
    projects.value = []
    nextCursor.value = null
  } else {
    listError.value = ''
  }
  try {
    const query = new URLSearchParams({ workspaceId: props.workspaceId, state: listState.value })
    if (cursor) query.set('cursor', cursor)
    const response = await fetch(`/api/v1/projects?${query.toString()}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (!requestIsCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(apiError(response.status, 'load'))
    const result = await response.json() as { projects: Project[]; nextCursor: string | null }
    if (!requestIsCurrent(version)) return
    projects.value = cursor ? [...projects.value, ...result.projects] : result.projects
    nextCursor.value = result.nextCursor
  } catch (error) {
    if (!requestIsCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    listError.value = error instanceof Error ? error.message : 'Не вдалося завантажити проєкти.'
  } finally {
    if (requestIsCurrent(version) && !cursor) listLoading.value = false
  }
}

async function loadProject(id: string) {
  const { controller, version } = beginRequest()
  detailLoading.value = true
  detailError.value = ''
  currentProject.value = null
  historicalArticle.value = false
  editing.value = false
  conflict.value = false
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (!requestIsCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(apiError(response.status, 'load'))
    const result = await response.json() as { project: Project }
    if (!requestIsCurrent(version)) return
    currentProject.value = result.project
    emit('project-workspace', result.project.workspaceId)
    if (isProjectOverview.value) loadOverviewProgress(id)
    if (!result.project.formats.includes('ARTICLE')) {
      void fetch(`/api/v1/projects/${encodeURIComponent(id)}/article`, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
        if (!response.ok || !requestIsCurrent(version)) return
        const articleState = await response.json() as { article: unknown }
        if (requestIsCurrent(version)) historicalArticle.value = Boolean(articleState.article)
      }).catch(() => { /* Project navigation remains usable during optional history lookup. */ })
    }
  } catch (error) {
    if (!requestIsCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    detailError.value = error instanceof Error ? error.message : 'Не вдалося завантажити проєкт.'
  } finally {
    if (requestIsCurrent(version)) detailLoading.value = false
  }
}

function clearForm() {
  topic.value = ''
  selectedFormats.value = []
  formError.value = ''
}

function openCreateForm() {
  if (saving.value || listLoading.value) return
  clearForm()
  editing.value = false
  formOpen.value = true
  requestAnimationFrame(() => document.getElementById('project-topic')?.focus())
}

function openEditForm() {
  if (saving.value || !currentProject.value || currentProject.value.archivedAt) return
  topic.value = currentProject.value.topic
  selectedFormats.value = [...currentProject.value.formats]
  formError.value = ''
  editing.value = true
  formOpen.value = true
  requestAnimationFrame(() => document.getElementById('project-topic')?.focus())
}

function closeForm(force = false) {
  if (saving.value && !force) return
  formOpen.value = false
  editing.value = false
  formError.value = ''
}

async function submitProject() {
  if (saving.value || !canSave.value || (!editing.value && listLoading.value)) return
  const isEditing = editing.value && currentProject.value !== null
  saving.value = true
  formError.value = ''
  const { controller, version } = beginRequest()
  const payload: Record<string, unknown> = {}
  if (isEditing) {
    payload.expectedRevision = currentProject.value!.revision
    const nextTopic = topic.value.trim()
    if (nextTopic !== currentProject.value!.topic) payload.topic = nextTopic
    if (!sameFormats(selectedFormats.value, currentProject.value!.formats)) payload.formats = [...selectedFormats.value]
    if (Object.keys(payload).length === 1) {
      closeForm(true)
      saving.value = false
      return
    }
  } else {
    payload.workspaceId = props.workspaceId
    payload.topic = topic.value.trim()
    payload.formats = [...selectedFormats.value]
  }

  try {
    const response = await fetch(isEditing
      ? `/api/v1/projects/${encodeURIComponent(currentProject.value!.id)}`
      : '/api/v1/projects', {
      method: isEditing ? 'PATCH' : 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': props.csrfToken,
      },
      body: JSON.stringify(payload),
    })
    if (!requestIsCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) {
      if (response.status === 409 && isEditing) conflict.value = true
      throw new Error(apiError(response.status, isEditing ? 'save' : 'create'))
    }
    const result = await response.json() as { project: Project }
    if (!requestIsCurrent(version)) return
    if (isEditing) {
      currentProject.value = result.project
      closeForm(true)
    } else {
      formOpen.value = false
      currentProject.value = result.project
      routeTo(`/projects/${result.project.id}`)
    }
  } catch (error) {
    if (!requestIsCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    formError.value = error instanceof Error ? error.message : 'Не вдалося зберегти проєкт.'
  } finally {
    if (requestIsCurrent(version)) saving.value = false
  }
}

onMounted(() => {
  window.addEventListener('popstate', onPopState)
  if (isDetail.value) void loadProject(page.value as string)
  else {
    if (pathname.value === '/settings') {
      pathname.value = '/projects'
      void loadProjects()
      return
    }
    if (pathname.value !== '/projects' && pathname.value !== '/projects/') {
      window.history.replaceState({}, '', '/projects')
      pathname.value = '/projects'
    }
    void loadProjects()
  }
})

onBeforeUnmount(() => {
  stopOverviewProgress()
  requestController?.abort()
  requestVersion += 1
  window.removeEventListener('popstate', onPopState)
})
</script>

<template>
  <div
    class="workspace-main"
    :data-workspace-leave-risk="formOpen || saving"
  >
    <section
      v-if="!isDetail"
      id="workspace-task"
      aria-labelledby="projects-title"
      tabindex="-1"
      class="workspace-content"
    >
      <div class="workspace-heading">
        <div>
          <h1 id="projects-title">
            Ваші проєкти
          </h1>
          <p class="workspace-lead">
            Кожна тема має свій проєкт і набір матеріалів.
          </p>
        </div>
        <Button
          v-if="listState === 'ACTIVE'"
          class="workspace-button workspace-button-primary"
          :disabled="saving || listLoading"
          @click="openCreateForm"
        >
          Створити проєкт
        </Button>
      </div>

      <nav
        class="project-state-filter"
        aria-label="Стан проєктів"
      >
        <button
          type="button"
          :aria-current="listState === 'ACTIVE' ? 'page' : undefined"
          @click="chooseListState('ACTIVE')"
        >
          Активні
        </button>
        <button
          type="button"
          :aria-current="listState === 'ARCHIVED' ? 'page' : undefined"
          @click="chooseListState('ARCHIVED')"
        >
          Архів
        </button>
        <button
          type="button"
          :aria-current="listState === 'TRASHED' ? 'page' : undefined"
          @click="chooseListState('TRASHED')"
        >
          Кошик
        </button>
      </nav>
      <p
        v-if="lifecycleNotice"
        class="lifecycle-notice"
        role="status"
        aria-live="polite"
      >
        {{ lifecycleNotice }}
      </p>

      <form
        v-if="formOpen && listState === 'ACTIVE'"
        class="project-form"
        @submit.prevent="submitProject"
      >
        <div class="project-form-heading">
          <div>
            <p class="eyebrow">
              Новий проєкт
            </p>
            <h2>Про що ви працюватимете?</h2>
          </div>
          <Button
            class="workspace-button workspace-button-quiet"
            type="button"
            variant="ghost"
            :disabled="saving"
            @click="closeForm"
          >
            Скасувати
          </Button>
        </div>
        <FieldGroup class="workspace-field-group">
          <Field class="workspace-field">
            <FieldLabel
              for="project-topic"
              class="workspace-field-label"
            >
              Назва й тема проєкту
            </FieldLabel>
            <Textarea
              id="project-topic"
              v-model="topic"
              class="workspace-input workspace-topic-input"
              rows="3"
              maxlength="500"
              required
              placeholder="Наприклад, розвиток міської мобільності"
              :disabled="saving"
            />
            <FieldDescription class="field-hint">
              Коротко: про що готуємо матеріал. Це також назва у списку проєктів. Максимум 500 символів; можна змінити пізніше.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <FieldSet class="format-fieldset">
          <FieldLegend class="format-legend">
            Формати матеріалів
          </FieldLegend>
          <FieldDescription class="field-hint">
            Оберіть хоча б один формат. Стаття — за бажанням.
          </FieldDescription>
          <div class="format-options">
            <label
              v-for="format in formats"
              :key="format.id"
              class="format-option"
            >
              <input
                v-model="selectedFormats"
                type="checkbox"
                :value="format.id"
                :disabled="saving"
              >
              <span>{{ format.label }}</span>
            </label>
          </div>
        </FieldSet>
        <Alert
          v-if="formError"
          variant="destructive"
          class="workspace-alert"
        >
          <AlertTitle>Не вдалося зберегти</AlertTitle>
          <AlertDescription>{{ formError }}</AlertDescription>
        </Alert>
        <div class="form-actions">
          <Button
            class="workspace-button workspace-button-primary"
            type="submit"
            :disabled="saving || listLoading || !canSave"
          >
            {{ saving ? 'Зберігаємо…' : 'Створити проєкт' }}
          </Button>
        </div>
      </form>

      <div
        v-if="listLoading"
        class="workspace-state"
        role="status"
        aria-live="polite"
      >
        <p class="eyebrow">
          Проєкти
        </p>
        <h2>Завантажуємо ваші проєкти</h2>
        <Skeleton class="project-skeleton" />
        <Skeleton class="project-skeleton project-skeleton-short" />
      </div>

      <Alert
        v-else-if="listError"
        variant="destructive"
        class="workspace-alert"
        role="alert"
      >
        <AlertTitle>Не вдалося завантажити проєкти</AlertTitle>
        <AlertDescription>{{ listError }}</AlertDescription>
        <Button
          class="workspace-button workspace-button-quiet"
          variant="outline"
          @click="loadProjects()"
        >
          Спробувати ще раз
        </Button>
      </Alert>

      <div
        v-else-if="projects.length === 0 && !formOpen"
        class="workspace-empty"
      >
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{{ listState === 'TRASHED' ? 'У кошику поки порожньо' : listState === 'ARCHIVED' ? 'Архів порожній' : 'Проєктів поки немає' }}</EmptyTitle>
            <EmptyDescription>{{ listState === 'ACTIVE' ? 'Створіть перший проєкт, щоб зібрати роботу навколо однієї теми.' : 'Тут з’являться проєкти після зміни їхнього стану.' }}</EmptyDescription>
          </EmptyHeader>
          <Button
            v-if="listState === 'ACTIVE'"
            class="workspace-button workspace-button-primary"
            @click="openCreateForm"
          >
            Створити перший проєкт
          </Button>
        </Empty>
      </div>

      <div
        v-else-if="projects.length > 0"
        class="project-list"
        role="region"
        aria-label="Список проєктів"
      >
        <article
          v-for="project in projects"
          :key="project.id"
          class="project-row"
        >
          <div class="project-row-copy">
            <a
              v-if="listState !== 'TRASHED'"
              class="project-link"
              :href="`/projects/${project.id}`"
              @click.prevent="routeTo(`/projects/${project.id}`)"
            >
              {{ project.topic }}
            </a>
            <span
              v-else
              class="project-link"
            >{{ project.topic }}</span>
            <div
              class="project-formats"
              aria-label="Формати матеріалів"
            >
              <span
                v-for="format in project.formats"
                :key="format"
              >{{ labelFor(format) }}</span>
            </div>
            <p class="project-updated">
              {{ project.trashedAt ? `У кошику · видалення доступне після ${formatUpdatedAt(project.purgeAfter ?? '')}` : project.archivedAt ? 'Архівований' : 'Активний' }} (оновлено {{ formatUpdatedAt(project.updatedAt) }})
            </p>
          </div>
          <ProjectLifecycle
            :project-id="project.id"
            :revision="project.revision"
            :archived-at="project.archivedAt"
            :trashed-at="project.trashedAt"
            :purge-after="project.purgeAfter"
            :can-purge="project.canPurge"
            :csrf-token="csrfToken"
            compact
            @changed="onProjectLifecycleChanged"
            @session-expired="emit('session-expired')"
          />
        </article>
        <div
          v-if="nextCursor"
          class="list-more"
        >
          <Button
            class="workspace-button workspace-button-quiet"
            variant="outline"
            @click="loadProjects(nextCursor ?? undefined)"
          >
            Показати ще проєкти
          </Button>
        </div>
      </div>
    </section>

    <section
      v-else
      id="workspace-task"
      :aria-labelledby="currentProject ? (isTrashed ? 'project-trashed-title' : isSources ? 'sources-title' : isFacts ? 'evidence-title' : isBrief ? 'brief-title' : isArticle ? 'article-heading' : isChannels ? 'telegram-title' : isVisuals ? 'visual-heading' : isExport ? 'export-title' : 'project-detail-title') : undefined"
      class="workspace-content project-detail"
      tabindex="-1"
    >
      <aside
        class="project-navigation"
        aria-label="Навігація проєкту"
      >
        <Button
          class="workspace-button workspace-back"
          variant="ghost"
          :disabled="saving"
          @click="routeTo('/projects')"
        >
          <span aria-hidden="true">←</span>
          Усі проєкти
        </Button>

        <a
          v-if="currentProject && (isSources || isFacts || isBrief || isArticle || isChannels || isVisuals || isExport)"
          class="project-navigation-title"
          :href="`/projects/${currentProject.id}`"
          @click.prevent="routeTo(`/projects/${currentProject.id}`)"
        >{{ currentProject.topic }}</a>

        <nav
          v-if="currentProject && !isTrashed && !detailLoading && !detailError"
          class="editorial-navigation"
          aria-label="Робота над проєктом"
        >
          <a
            :href="`/projects/${currentProject.id}`"
            :aria-current="!isSources && !isFacts && !isBrief && !isArticle && !isChannels && !isVisuals && !isExport ? 'page' : undefined"
            @click.prevent="routeTo(`/projects/${currentProject.id}`)"
          >Огляд</a>
          <a
            :href="`/projects/${currentProject.id}/sources`"
            :aria-current="isSources ? 'page' : undefined"
            @click.prevent="routeTo(`/projects/${currentProject.id}/sources`)"
          >Джерела</a>
          <a
            :href="`/projects/${currentProject.id}/facts`"
            :aria-current="isFacts ? 'page' : undefined"
            @click.prevent="routeTo(`/projects/${currentProject.id}/facts`)"
          >Докази</a>
          <a
            :href="`/projects/${currentProject.id}/brief`"
            :aria-current="isBrief ? 'page' : undefined"
            @click.prevent="routeTo(`/projects/${currentProject.id}/brief`)"
          >Бриф</a>
          <a
            v-if="currentProject.formats.includes('ARTICLE') || historicalArticle || isArticle"
            :href="`/projects/${currentProject.id}/article`"
            :aria-current="isArticle ? 'page' : undefined"
            @pointerenter="preloadArticleWorkspace"
            @focus="preloadArticleWorkspace"
            @click.prevent="routeTo(`/projects/${currentProject.id}/article`)"
          >Стаття</a>
          <a
            v-if="channelFormats.length"
            :href="`/projects/${currentProject.id}/channels?format=${selectedChannelFormat}`"
            :aria-current="isChannels ? 'page' : undefined"
            @pointerenter="preloadChannels"
            @focus="preloadChannels"
            @click.prevent="routeTo(`/projects/${currentProject.id}/channels?format=${selectedChannelFormat}`)"
          >Канали</a>
          <a
            v-if="visualFormats.length"
            :href="`/projects/${currentProject.id}/visuals?format=${selectedVisualFormat}`"
            :aria-current="isVisuals ? 'page' : undefined"
            @pointerenter="preloadVisuals"
            @focus="preloadVisuals"
            @click.prevent="routeTo(`/projects/${currentProject.id}/visuals?format=${selectedVisualFormat}`)"
          >Візуали</a>
          <a
            :href="`/projects/${currentProject.id}/export`"
            :aria-current="isExport ? 'page' : undefined"
            @pointerenter="preloadExportWorkspace(currentProject.id)"
            @focus="preloadExportWorkspace(currentProject.id)"
            @click.prevent="routeTo(`/projects/${currentProject.id}/export`)"
          >Експорт</a>
        </nav>
      </aside>

      <EditorPresence
        v-if="currentProject && presencePage"
        :key="`${currentProject.id}:${presencePage}`"
        :project-id="currentProject.id"
        :csrf-token="csrfToken"
        :page="presencePage"
        @session-expired="emit('session-expired')"
      />

      <div
        v-if="detailLoading"
        class="workspace-state"
        role="status"
        aria-live="polite"
      >
        <p class="eyebrow">
          Проєкт
        </p>
        <h2>Відкриваємо проєкт</h2>
        <Skeleton class="project-skeleton" />
        <Skeleton class="project-skeleton project-skeleton-short" />
      </div>

      <Alert
        v-else-if="detailError"
        variant="destructive"
        class="workspace-alert"
        role="alert"
      >
        <AlertTitle>Не вдалося відкрити проєкт</AlertTitle>
        <AlertDescription>{{ detailError }}</AlertDescription>
        <Button
          class="workspace-button workspace-button-quiet"
          variant="outline"
          @click="loadProject(page as string)"
        >
          Спробувати ще раз
        </Button>
      </Alert>

      <template v-else-if="currentProject">
        <KeepAlive
          :key="`${userId}:${currentProject.id}:${isTrashed}:${Boolean(currentProject.archivedAt)}`"
          :max="1"
        >
          <ArticleWorkspace
            v-if="isArticle && !isTrashed"
            :project-id="currentProject.id"
            :project-topic="currentProject.topic"
            :csrf-token="csrfToken"
            :user-id="userId"
            :archived="Boolean(currentProject.archivedAt)"
            :open-history="openArticleHistory"
            @session-expired="emit('session-expired')"
            @open-brief="routeTo(`/projects/${currentProject.id}/brief`)"
          />
        </KeepAlive>
        <section
          v-if="isTrashed"
          class="project-trashed-state"
          aria-labelledby="project-trashed-title"
        >
          <p class="editorial-project-context">
            Кошик
          </p>
          <h1 id="project-trashed-title">
            {{ currentProject.topic }}
          </h1>
          <p class="project-detail-copy">
            Проєкт і пов’язана історія доступні для відновлення до остаточного видалення. Власнику воно стане доступне після {{ formatUpdatedAt(currentProject.purgeAfter ?? '') }}. Редагування та експорт призупинені.
          </p>
          <ProjectLifecycle
            :project-id="currentProject.id"
            :revision="currentProject.revision"
            :archived-at="currentProject.archivedAt"
            :trashed-at="currentProject.trashedAt"
            :purge-after="currentProject.purgeAfter"
            :can-purge="currentProject.canPurge"
            :csrf-token="csrfToken"
            @changed="onProjectLifecycleChanged"
            @session-expired="emit('session-expired')"
          />
        </section>
        <template v-else-if="isArticle">
          <!-- The retained editor is mounted above. -->
        </template>
        <template v-else-if="isChannels">
          <TelegramWorkspace
            :key="currentProject.id"
            :project-id="currentProject.id"
            :project-topic="currentProject.topic"
            :csrf-token="csrfToken"
            :user-id="userId"
            :formats="channelFormats"
            :initial-format="selectedChannelFormat"
            :archived="Boolean(currentProject.archivedAt)"
            @session-expired="emit('session-expired')"
            @format-change="routeTo(`/projects/${currentProject.id}/channels?format=${$event}`)"
            @review-article="routeTo(`/projects/${currentProject.id}/article?review=1`)"
            @caption-generated="scriptRefreshEpoch++"
          />
          <ScriptWorkspace
            v-if="selectedScriptFormat"
            :key="`${currentProject.id}:${selectedChannelFormat}:${scriptRefreshEpoch}`"
            :project-id="currentProject.id"
            :csrf-token="csrfToken"
            :user-id="userId"
            :format="selectedScriptFormat"
            :archived="Boolean(currentProject.archivedAt)"
            @session-expired="emit('session-expired')"
          />
        </template><template v-else-if="isVisuals">
          <VisualWorkspace
            :key="`${currentProject.id}:${selectedVisualFormat}`"
            :project-id="currentProject.id"
            :workspace-id="currentProject.workspaceId"
            :user-id="userId"
            :csrf-token="csrfToken"
            :format="selectedVisualFormat"
            :formats="visualFormats"
            :archived="Boolean(currentProject.archivedAt)"
            @session-expired="emit('session-expired')"
            @dirty="visualDirty = $event"
            @format-change="routeTo(`/projects/${currentProject.id}/visuals?format=${$event}`)"
            @open-source="routeTo(`/projects/${currentProject.id}/channels?format=${selectedVisualFormat}`)"
          />
        </template><template v-else-if="isExport">
          <ExportWorkspace
            :key="currentProject.id"
            :project-id="currentProject.id"
            :topic="currentProject.topic"
            :csrf-token="csrfToken"
            :user-id="userId"
            :archived="Boolean(currentProject.archivedAt)"
            @session-expired="emit('session-expired')"
            @open-material="openExportMaterial(currentProject.id, $event)"
          />
        </template><template v-else-if="isBrief">
          <BriefWorkspace
            :key="currentProject.id"
            :user-id="userId"
            :project-id="currentProject.id"
            :project-topic="currentProject.topic"
            :csrf-token="csrfToken"
            :archived="Boolean(currentProject.archivedAt)"
            @session-expired="emit('session-expired')"
          />
        </template><template v-else-if="isFacts">
          <EvidenceWorkspace
            :key="currentProject.id"
            :project-id="currentProject.id"
            :project-topic="currentProject.topic"
            :user-id="userId"
            :csrf-token="csrfToken"
            :archived="currentProject.archivedAt !== null"
            @session-expired="emit('session-expired')"
            @back="routeTo(`/projects/${currentProject.id}`)"
            @projects="routeTo('/projects')"
          />
        </template>
        <template v-else-if="isSources">
          <SourceWorkspace
            :key="currentProject.id"
            :project-id="currentProject.id"
            :project-title="currentProject.topic"
            :csrf-token="csrfToken"
            :archived="Boolean(currentProject.archivedAt)"
            @session-expired="emit('session-expired')"
          />
        </template>
        <template v-else>
          <div class="workspace-heading project-title-row">
            <div>
              <p class="editorial-project-context">
                {{ currentProject.archivedAt ? 'Архівований проєкт' : 'Проєкт' }}
              </p>
              <h1 id="project-detail-title">
                {{ currentProject.topic }}
              </h1>
            </div>
            <Button
              v-if="!currentProject.archivedAt && !isTrashed"
              class="workspace-button workspace-button-secondary"
              variant="outline"
              :disabled="saving"
              @click="openEditForm"
            >
              Редагувати проєкт
            </Button>
          </div>
          <ProjectLifecycle
            :project-id="currentProject.id"
            :revision="currentProject.revision"
            :archived-at="currentProject.archivedAt"
            :trashed-at="currentProject.trashedAt"
            :purge-after="currentProject.purgeAfter"
            :can-purge="currentProject.canPurge"
            :csrf-token="csrfToken"
            @changed="onProjectLifecycleChanged"
            @session-expired="emit('session-expired')"
          />

          <form
            v-if="formOpen && editing"
            class="project-form"
            @submit.prevent="submitProject"
          >
            <div class="project-form-heading">
              <div>
                <p class="eyebrow">
                  Налаштування
                </p>
                <h2>Тема та формати</h2>
              </div>
              <Button
                class="workspace-button workspace-button-quiet"
                type="button"
                variant="ghost"
                :disabled="saving"
                @click="closeForm"
              >
                Скасувати
              </Button>
            </div>
            <FieldGroup class="workspace-field-group">
              <Field class="workspace-field">
                <FieldLabel
                  for="project-topic"
                  class="workspace-field-label"
                >
                  Назва й тема проєкту
                </FieldLabel>
                <Textarea
                  id="project-topic"
                  v-model="topic"
                  class="workspace-input workspace-topic-input"
                  rows="3"
                  maxlength="500"
                  required
                  :disabled="saving"
                />
                <FieldDescription class="field-hint">
                  Коротко: про що готуємо матеріал. Це також назва у списку проєктів. Максимум 500 символів.
                </FieldDescription>
              </Field>
            </FieldGroup>
            <FieldSet class="format-fieldset">
              <FieldLegend class="format-legend">
                Формати матеріалів
              </FieldLegend>
              <FieldDescription class="field-hint">
                Оберіть хоча б один формат. Стаття — за бажанням.
              </FieldDescription>
              <div class="format-options">
                <label
                  v-for="format in formats"
                  :key="format.id"
                  class="format-option"
                >
                  <input
                    v-model="selectedFormats"
                    type="checkbox"
                    :value="format.id"
                    :disabled="saving"
                  >
                  <span>{{ format.label }}</span>
                </label>
              </div>
            </FieldSet>
            <Alert
              v-if="formError"
              variant="destructive"
              class="workspace-alert"
            >
              <AlertTitle>{{ conflict ? 'Є нові зміни' : 'Не вдалося зберегти' }}</AlertTitle>
              <AlertDescription>{{ formError }}</AlertDescription>
              <Button
                v-if="conflict"
                class="workspace-button workspace-button-quiet"
                variant="outline"
                type="button"
                @click="loadProject(page as string)"
              >
                Скинути мої зміни й оновити
              </Button>
            </Alert>
            <div class="form-actions">
              <Button
                class="workspace-button workspace-button-primary"
                type="submit"
                :disabled="saving || !canSave || !hasChanges"
              >
                {{ saving ? 'Зберігаємо…' : 'Зберегти зміни' }}
              </Button>
            </div>
          </form>

          <section
            v-else
            class="project-detail-body project-steps"
            aria-labelledby="overview-steps-title"
          >
            <h2 id="overview-steps-title">
              Етапи проєкту
            </h2>
            <div class="project-step-list">
              <button
                v-for="step in overviewSteps"
                :key="step.id"
                type="button"
                class="project-step-row"
                @click="routeTo(overviewPath(step.id))"
              >
                <span class="project-step-name">{{ step.title }}</span>
                <span
                  class="project-step-status"
                  :aria-label="step.title + ': ' + overviewStatus(step.id)"
                >
                  {{ overviewStatus(step.id) }}
                </span>
                <span
                  class="project-step-arrow"
                  aria-hidden="true"
                >→</span>
              </button>
            </div>
            <details class="project-format-details">
              <summary>Формати матеріалів · {{ currentProject.formats.length }}</summary>
              <ul class="format-list">
                <li
                  v-for="format in currentProject.formats"
                  :key="format"
                >
                  {{ labelFor(format) }}
                </li>
              </ul>
            </details>
            <Alert
              v-if="currentProject.archivedAt"
              class="workspace-alert archive-note"
            >
              <AlertTitle>Проєкт архівований</AlertTitle>
              <AlertDescription>Ви можете переглянути його налаштування, але змінити вже не можна.</AlertDescription>
            </Alert>
          </section>
        </template>
      </template>
    </section>
  </div>
</template>

<style scoped>
.project-steps { max-width:950px; margin-inline:auto; }
.project-steps > h2 { margin:0 0 14px; font:550 26px/1.35 var(--serif); }
.project-step-list { border-top:1px solid var(--rule); }
.project-step-row { width:100%; min-width:0; display:grid; grid-template-columns:minmax(0,1fr) auto 18px; align-items:center; gap:12px 20px; padding:16px 4px; border:0; border-bottom:1px solid var(--rule); background:transparent; color:var(--ink); text-align:left; cursor:pointer; }
.project-step-row:hover { background:var(--row-hover,#fafafa); }
.project-step-row:focus-visible { outline:2px solid var(--copper); outline-offset:2px; }
.project-step-name { font:550 20px/1.35 var(--serif); }
.project-step-status { font-size:12px; color:var(--muted); text-align:right; }
.project-step-arrow { font-size:18px; color:var(--muted); }
.project-format-details { margin:24px 0; padding:10px 0; border-top:1px solid var(--rule); }
.project-format-details > summary { font-size:13px; color:var(--muted); cursor:pointer; }
.project-format-details .format-list { margin-top:12px; }
@media(max-width:580px) {
 .project-step-row { grid-template-columns:minmax(0,1fr) 18px; gap:4px 10px; }
 .project-step-status { grid-column:1; text-align:left; }
 .project-step-arrow { grid-column:2; grid-row:1/3; }
}

.project-detail { width: 100%; display: block; }
.project-detail > * { min-width: 0; }
.project-state-filter { display: flex; gap: 24px; margin: 4px 0 20px; border-bottom: 1px solid var(--rule); }
.project-state-filter button { min-height: 44px; padding: 8px 0; border: 0; border-bottom: 1px solid transparent; background: transparent; color: var(--muted); font: inherit; font-size: 13px; cursor: pointer; }
.project-state-filter button[aria-current='page'] { border-bottom-color: var(--ink); color: var(--ink); }
.project-state-filter button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.lifecycle-notice { margin: 0 0 16px; color: var(--muted); font-size: 13px; }
.project-trashed-state { max-width: 760px; padding: 18px 0 40px; }
.project-trashed-state h1 { max-width: 24ch; margin: 0; font-family: var(--serif); font-size: 39px; font-weight: 550; line-height: 1.2; overflow-wrap: anywhere; }
.project-trashed-state > .project-detail-copy { max-width: 65ch; margin: 18px 0 0; color: var(--muted); line-height: 1.6; }
.project-navigation { display: flex; align-items: center; gap: 28px; min-height: 58px; margin: 0 0 36px; border-bottom: 1px solid var(--rule); }
.project-navigation > .workspace-back { padding-inline: 0; justify-content: flex-start; margin: 0; flex-shrink: 0; font-size: 13px; }
.project-navigation-title { color: var(--muted); font-size: 13px; text-decoration: none; overflow-wrap: anywhere; max-width: 46ch; }
.project-navigation-title:hover { color: var(--ink); text-decoration: underline; }
.editorial-navigation { display: flex; align-self: stretch; flex-direction: row; gap: 28px; padding: 0; margin: 0 0 0 auto; }
.editorial-navigation a { display: inline-flex; align-items: center; min-height: 44px; color: var(--muted); padding: 14px 0; text-decoration: none; font-size: 13px; border-bottom: 1px solid transparent; }
.editorial-navigation a:hover { color: var(--ink); }
.editorial-navigation a[aria-current] { color: var(--ink); border-bottom-color: var(--ink); }
.editorial-navigation a:focus-visible { outline: 2px solid var(--copper); outline-offset: 4px; }
@media (max-width: 1150px) {
  .project-navigation { flex-wrap: wrap; gap: 0 24px; padding-top: 8px; }
  .editorial-navigation { width: 100%; margin: 0; gap: 26px; }
}
@media (max-width: 760px) {
  .project-trashed-state h1 { font-size: 32px; }
  .project-navigation { margin-bottom: 28px; }
  .project-navigation-title { flex: 1; font-size: 12px; }
  .editorial-navigation { overflow-x: auto; scrollbar-width: thin; gap: 24px; }
  .editorial-navigation a { flex-shrink: 0; }
}
</style>
