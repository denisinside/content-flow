<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import SourceWorkspace from './SourceWorkspace.vue'

type ProjectFormat =
  | 'ARTICLE'
  | 'LINKEDIN_TEXT'
  | 'LINKEDIN_COVER'
  | 'LINKEDIN_CAROUSEL'
  | 'INSTAGRAM_COVER'
  | 'INSTAGRAM_CAROUSEL'
  | 'INSTAGRAM_STORIES'
  | 'TELEGRAM_POST'

interface Project {
  id: string
  workspaceId: string
  topic: string
  formats: ProjectFormat[]
  revision: number
  createdAt: string
  updatedAt: string
  archivedAt: string | null
}

interface Props {
  csrfToken: string
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
const projects = ref<Project[]>([])
const nextCursor = ref<string | null>(null)
const currentProject = ref<Project | null>(null)
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

const page = computed(() => pathname.value.match(/^\/projects\/([0-9a-f-]{36})(?:\/sources)?\/?$/i)?.[1] ?? null)
const isDetail = computed(() => page.value !== null)
const isSources = computed(() => /\/sources\/?$/i.test(pathname.value))
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
  if (path === pathname.value && push) return
  if (saving.value) {
    requestController?.abort()
    requestVersion += 1
    saving.value = false
  }
  closeForm(true)
  clearForm()
  conflict.value = false
  if (push) window.history.pushState({}, '', path)
  else window.history.replaceState({}, '', path)
  pathname.value = window.location.pathname
  if (isDetail.value) {
    if (currentProject.value?.id !== page.value) void loadProject(page.value as string)
  } else {
    currentProject.value = null
    void loadProjects()
  }
}

function onPopState() {
  requestController?.abort()
  requestVersion += 1
  saving.value = false
  closeForm(true)
  clearForm()
  conflict.value = false
  pathname.value = window.location.pathname
  if (isDetail.value) void loadProject(page.value as string)
  else {
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
    const query = new URLSearchParams({ workspaceId: props.workspaceId })
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
    if (pathname.value !== '/projects' && pathname.value !== '/projects/') {
      window.history.replaceState({}, '', '/projects')
      pathname.value = '/projects'
    }
    void loadProjects()
  }
})

onBeforeUnmount(() => {
  requestController?.abort()
  requestVersion += 1
  window.removeEventListener('popstate', onPopState)
})
</script>

<template>
  <div class="workspace-main">
    <section
      v-if="!isDetail"
      aria-labelledby="projects-title"
      class="workspace-content"
    >
      <div class="workspace-heading">
        <div>
          <p class="eyebrow">
            Проєкти простору
          </p>
          <h1 id="projects-title">
            Ваші проєкти
          </h1>
          <p class="workspace-lead">
            Кожна тема має свій проєкт і набір матеріалів.
          </p>
        </div>
        <Button
          class="workspace-button workspace-button-primary"
          :disabled="saving || listLoading"
          @click="openCreateForm"
        >
          Створити проєкт
        </Button>
      </div>

      <form
        v-if="formOpen"
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
              Тема проєкту
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
              До 500 символів. Тему можна змінити пізніше.
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
            <EmptyTitle>Проєктів поки немає</EmptyTitle>
            <EmptyDescription>Створіть перший проєкт, щоб зібрати роботу навколо однієї теми.</EmptyDescription>
          </EmptyHeader>
          <Button
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
              class="project-link"
              :href="`/projects/${project.id}`"
              @click.prevent="routeTo(`/projects/${project.id}`)"
            >
              {{ project.topic }}
            </a>
            <p class="project-formats">
              {{ project.formats.map(labelFor).join(' · ') }}
            </p>
            <p class="project-updated">
              {{ project.archivedAt ? 'Архівований' : 'Новий' }} · Оновлено {{ formatUpdatedAt(project.updatedAt) }}
            </p>
          </div>
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
      aria-labelledby="project-detail-title"
      class="workspace-content project-detail"
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
        <template v-if="isSources">
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
              <p class="eyebrow">
                {{ currentProject.archivedAt ? 'Архівований проєкт' : 'Проєкт' }}
              </p>
              <h1 id="project-detail-title">
                {{ currentProject.topic }}
              </h1>
            </div>
            <Button
              v-if="!currentProject.archivedAt"
              class="workspace-button workspace-button-secondary"
              variant="outline"
              :disabled="saving"
              @click="openEditForm"
            >
              Редагувати проєкт
            </Button>
          </div>

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
                  Тема проєкту
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
                  До 500 символів.
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
            class="project-detail-body"
            aria-labelledby="formats-title"
          >
            <p class="project-detail-copy">
              Матеріали цього проєкту стосуються теми вище.
            </p>
            <div class="project-sources-entry">
              <div>
                <p class="eyebrow">
                  Дослідження
                </p>
                <h2>Джерела</h2>
                <p class="project-detail-copy">
                  Додавайте тексти й документи та переглядайте збережені версії.
                </p>
              </div>
              <Button
                class="workspace-button workspace-button-secondary"
                variant="outline"
                @click="routeTo(`/projects/${currentProject.id}/sources`)"
              >
                Відкрити джерела
              </Button>
            </div>
            <div
              class="detail-rule"
              aria-hidden="true"
            />
            <h2 id="formats-title">
              Формати матеріалів
            </h2>
            <ul class="format-list">
              <li
                v-for="format in currentProject.formats"
                :key="format"
              >
                {{ labelFor(format) }}
              </li>
            </ul>
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
