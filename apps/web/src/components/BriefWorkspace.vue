<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Button } from '@/components/ui/button'
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert'
import { Textarea } from '@/components/ui/textarea'

interface Claim { currentRevisionId: string; currentRevision: { wording: string } }
interface BriefRevision { id: string; number: number; contentMode: 'FACTUAL' | 'CREATIVE'; topic: string; audience: string; centralMessage: string; category: string; tone: string; targetLength: number; cta: string; exclusions: string[]; notes: string; requiredClaimRevisionIds?: string[]; requiredClaims?: { claimRevisionId: string }[]; style?: { revision: number; tone: string; brandbook: string }; workspaceStyleRevision?: number; contextSnapshots?: unknown; createdAt?: string }
interface Section { title: string; purpose: string; claimRevisionIds: string[] }
interface OutlineRevision { id: string; number: number; briefRevisionId: string; origin: string; status: string; content: { title: string; sections: Section[] }; createdAt?: string; approvedAt?: string; withdrawnAt?: string }
interface State { brief: { revision: number; currentRevision: BriefRevision; history: BriefRevision[] } | null; outline: { revision: number; currentRevision: OutlineRevision | null; currentApprovedRevisionId: string | null; revisions: OutlineRevision[] } | null; style: { revision: number; tone: string; brandbook: string; settings: unknown }; articleSelected: boolean; prerequisites: { eligibleClaims: Claim[]; missingBasis: boolean; unverified: boolean; blockingReasons: string[] } }
interface Job { id: string; operation: string; status: string; retryAllowed: boolean; errorCategory?: string; progressStage: string }
const props = defineProps<{ projectId: string; projectTopic: string; csrfToken: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()
const state = ref<State | null>(null)
const loading = ref(true)
const busy = ref(false)
const error = ref('')
const conflict = ref(false)
const saved = ref('')
const baseline = ref('')
const outlineBaseline = ref('')
const briefExpectedRevision = ref(0)
const outlineExpectedRevision = ref(0)
const loadedBriefId = ref<string | null>(null)
const loadedOutlineId = ref<string | null>(null)
const form = reactive({ contentMode: 'FACTUAL' as 'FACTUAL' | 'CREATIVE', topic: props.projectTopic, audience: '', centralMessage: '', category: '', tone: '', targetLength: 600, cta: '', exclusions: '', notes: '', requiredClaimRevisionIds: [] as string[] })
const outline = reactive({ title: '', sections: [] as Section[] })
const jobs = ref<Job[]>([])
const jobError = ref('')
const base = `/api/v1/projects/${encodeURIComponent(props.projectId)}`
const dirty = computed(() => JSON.stringify(form) !== baseline.value)
const outlineDirty = computed(() => JSON.stringify(outline) !== outlineBaseline.value)
const valid = computed(() => form.topic.trim() && form.audience.trim() && form.centralMessage.trim() && Number.isInteger(Number(form.targetLength)) && Number(form.targetLength) >= 50 && Number(form.targetLength) <= 20000)
const currentOutline = computed(() => state.value?.outline?.currentRevision)
const candidates = computed(() => state.value?.outline?.revisions.filter(item => item.origin === 'AI' && item.id !== currentOutline.value?.id && item.status === 'PROPOSED') ?? [])
const activeJob = computed(() => jobs.value.some(job => ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)))
const styleChanged = computed(() => !!state.value?.brief?.currentRevision.workspaceStyleRevision && state.value.brief.currentRevision.workspaceStyleRevision !== state.value.style.revision)
const outdatedOutline = computed(() => !!currentOutline.value && currentOutline.value.briefRevisionId !== state.value?.brief?.currentRevision.id)
const remoteBriefChanged = computed(() => loadedBriefId.value !== (state.value?.brief?.currentRevision.id ?? null))
const remoteOutlineChanged = computed(() => loadedOutlineId.value !== (currentOutline.value?.id ?? null))
const generationBlocked = computed(() => !state.value?.brief || dirty.value || styleChanged.value || remoteBriefChanged.value || (form.contentMode === 'FACTUAL' && state.value.prerequisites.missingBasis))
let disposed = false
let timer: ReturnType<typeof setTimeout> | undefined
const controller = new AbortController()
let commandKey: string | null = null
const seenJobs = new Map<string, string>()
function populate() {
  const revision = state.value?.brief?.currentRevision
  if (revision) Object.assign(form, revision, { exclusions: revision.exclusions.join('\n'), requiredClaimRevisionIds: [...(revision.requiredClaimRevisionIds ?? revision.requiredClaims?.map(row => row.claimRevisionId) ?? [])] })
  else Object.assign(form, { tone: state.value?.style.tone ?? '', topic: props.projectTopic })
  // Only editable fields participate in save/dirty state.
  for (const key of Object.keys(form)) if (!['contentMode', 'topic', 'audience', 'centralMessage', 'category', 'tone', 'targetLength', 'cta', 'exclusions', 'notes', 'requiredClaimRevisionIds'].includes(key)) delete (form as unknown as Record<string, unknown>)[key]
  baseline.value = JSON.stringify(form)
  briefExpectedRevision.value = state.value?.brief?.revision ?? 0
  loadedBriefId.value = state.value?.brief?.currentRevision.id ?? null
  populateOutline()
}
function populateOutline() {
  const content = currentOutline.value?.content
  outline.title = content?.title ?? form.topic
  outline.sections = content ? JSON.parse(JSON.stringify(content.sections)) as Section[] : []
  outlineBaseline.value = JSON.stringify(outline)
  outlineExpectedRevision.value = state.value?.outline?.revision ?? 0
  loadedOutlineId.value = currentOutline.value?.id ?? null
}
async function request(path: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, { method: payload === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(payload) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    if (response.status === 409) conflict.value = true
    if (response.status === 503 && path === '/outline/generate') throw new Error('AI-генерація ще не налаштована. Створіть структуру вручну.')
    throw new Error(response.status === 409 ? 'Матеріал змінився. Ваш текст збережено у формі. Оновіть дані перед повторною дією.' : response.status === 400 ? 'Перевірте заповнення брифу та актуальність фактичної основи.' : 'Дія тимчасово недоступна. Перевірте з’єднання й повторіть спробу.')
  }
  return response.json()
}
async function load(reset = false) {
  try { state.value = await request('/editorial') as State; if (!disposed && reset) { populate(); conflict.value = false; error.value = '' } }
  catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити бриф.' }
  finally { if (!disposed) loading.value = false }
}
async function mutate(path: string, payload: unknown, kind: 'brief' | 'outline' | 'other' = 'other') {
  if (busy.value || props.archived) return
  busy.value = true; error.value = ''; saved.value = ''
  try {
    const result = await request(path, payload) as Partial<State>
    if (disposed) return
    if (result.prerequisites) state.value = result as State
    else await load()
    if (kind === 'brief') { const draft = JSON.parse(JSON.stringify(outline)) as typeof outline; const previousBaseline = outlineBaseline.value; const previousExpectedRevision = outlineExpectedRevision.value; const previousOutlineId = loadedOutlineId.value; const keepOutline = outlineDirty.value; populate(); if (keepOutline) { Object.assign(outline, draft); outlineBaseline.value = previousBaseline; outlineExpectedRevision.value = previousExpectedRevision; loadedOutlineId.value = previousOutlineId } saved.value = 'Бриф збережено' }
    if (kind === 'outline') { populateOutline(); saved.value = 'Структуру збережено' }
    if (path.includes('/outline/') && kind === 'other') outlineExpectedRevision.value = state.value?.outline?.revision ?? outlineExpectedRevision.value
    conflict.value = false
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти.' }
  finally { if (!disposed) busy.value = false }
}
function saveBrief() { return mutate('/brief', { ...form, targetLength: Number(form.targetLength), exclusions: form.exclusions.split('\n').map(line => line.trim()).filter(Boolean), requiredClaimRevisionIds: form.contentMode === 'FACTUAL' ? form.requiredClaimRevisionIds : [], expectedRevision: briefExpectedRevision.value }, 'brief') }
function saveOutline() { return mutate('/outline/manual', { expectedRevision: outlineExpectedRevision.value, briefRevisionId: state.value?.brief?.currentRevision.id, content: JSON.parse(JSON.stringify(outline)) }, 'outline') }
async function generate() {
  commandKey ??= crypto.randomUUID()
  await mutate('/outline/generate', { commandKey })
  if (!error.value) commandKey = null
  await loadJobs()
}
async function jobAction(job: Job, action: string) { await mutate(`/jobs/${job.id}/${action}`, {}); await loadJobs() }
async function loadJobs() {
  clearTimeout(timer)
  if (disposed || !state.value?.articleSelected) return
  try {
    const result = await request('/jobs') as { jobs: Job[] }
    if (disposed) return
    jobs.value = result.jobs.filter(job => job.operation === 'OUTLINE_GENERATION')
    for (const job of jobs.value) {
      if (job.status === 'SUCCEEDED' && seenJobs.get(job.id) !== 'SUCCEEDED') await load()
      seenJobs.set(job.id, job.status)
    }
    jobError.value = ''
  } catch { if (!disposed) jobError.value = 'Не вдалося оновити стан генерації.' }
  finally { if (!disposed) timer = setTimeout(() => void loadJobs(), activeJob.value ? 2000 : 5000) }
}
function jobLabel(job: Job) { return ({ QUEUED: 'Очікує обробки', RUNNING: 'Створюємо структуру', RETRY_WAIT: 'Очікує повторної спроби', SUCCEEDED: 'Пропозиція готова', FAILED: 'Не вдалося створити структуру', CANCELLED: 'Генерацію скасовано', OUTCOME_UNKNOWN: 'Результат зовнішньої обробки невідомий' } as Record<string, string>)[job.status] ?? 'Обробка' }
onMounted(async () => { await load(true); await loadJobs() })
onBeforeUnmount(() => { disposed = true; controller.abort(); clearTimeout(timer) })
</script>

<template>
  <section
    class="brief-workspace author-desk-task"
    :data-workspace-leave-risk="!loading && (dirty || outlineDirty || busy)"
    aria-labelledby="brief-title"
  >
    <header class="brief-heading">
      <div>
        <h1 id="brief-title">
          Бриф
        </h1><p class="brief-lead">
          Задум, читач і межі матеріалу.
        </p>
      </div>
      <div
        v-if="state && !loading"
        class="brief-heading-actions"
      >
        <span role="status">{{ dirty ? 'Є незбережені зміни' : saved || (state.brief ? 'Бриф збережено' : '') }}</span>
        <Button
          type="submit"
          form="brief-form"
          class="workspace-button workspace-button-primary"
          :disabled="busy || archived || !valid || (!dirty && !styleChanged)"
        >
          {{ busy ? 'Зберігаємо…' : 'Зберегти бриф' }}
        </Button>
      </div>
    </header>
    <p
      v-if="loading"
      role="status"
    >
      Завантажуємо бриф…
    </p>
    <Alert
      v-if="error"
      variant="destructive"
      class="workspace-alert"
      role="alert"
    >
      <AlertTitle>{{ conflict ? 'Є нові зміни' : 'Не вдалося виконати дію' }}</AlertTitle><AlertDescription>{{ error }}</AlertDescription><Button
        v-if="conflict || !state"
        variant="outline"
        class="workspace-button"
        @click="load(true)"
      >
        {{ conflict ? 'Скинути мої зміни й оновити' : 'Спробувати ще раз' }}
      </Button>
    </Alert>
    <template v-if="state && !loading">
      <p
        v-if="remoteBriefChanged || remoteOutlineChanged"
        class="brief-review"
        role="status"
      >
        Інший редактор зберіг нову версію. Ваш текст залишається у формі. <Button
          variant="outline"
          class="workspace-button"
          :disabled="busy"
          @click="load(true)"
        >
          Скинути мої зміни й оновити
        </Button>
      </p>
      <p
        v-if="styleChanged"
        class="brief-review"
        role="status"
      >
        Стиль простору змінився. Збережіть нову версію брифу перед роботою зі структурою.
      </p>
      <div class="brief-layout">
        <form
          id="brief-form"
          class="brief-document"
          @submit.prevent="saveBrief"
        >
          <fieldset
            class="brief-fields"
            :disabled="busy || archived"
          >
            <legend class="sr-only">
              Зміст брифу
            </legend>
            <label
              class="brief-field brief-wide"
              for="brief-topic"
            >Тема<Textarea
              id="brief-topic"
              v-model="form.topic"
              rows="2"
              required
              maxlength="500"
              class="workspace-input"
            /></label>
            <label
              class="brief-field brief-wide"
              for="brief-audience"
            >Аудиторія<Textarea
              id="brief-audience"
              v-model="form.audience"
              rows="2"
              required
              maxlength="2000"
              class="workspace-input"
            /></label>
            <label
              class="brief-field brief-wide"
              for="brief-message"
            >Головне повідомлення<Textarea
              id="brief-message"
              v-model="form.centralMessage"
              rows="2"
              required
              maxlength="4000"
              class="workspace-input"
            /></label>
            <label
              class="brief-field"
              for="brief-category"
            >Категорія<input
              id="brief-category"
              v-model="form.category"
              maxlength="120"
              class="workspace-input"
            ></label>
            <label
              class="brief-field"
              for="brief-tone"
            >Тон<input
              id="brief-tone"
              v-model="form.tone"
              maxlength="10000"
              class="workspace-input"
            ></label>
            <label
              class="brief-field"
              for="brief-length"
            >Бажаний обсяг, слів<input
              id="brief-length"
              v-model.number="form.targetLength"
              type="number"
              min="50"
              max="20000"
              step="1"
              required
              class="workspace-input"
            ></label>
            <label
              class="brief-field"
              for="brief-cta"
            >Заклик до дії<input
              id="brief-cta"
              v-model="form.cta"
              maxlength="2000"
              class="workspace-input"
            ></label>
            <label
              class="brief-field brief-wide"
              for="brief-exclusions"
            >Чого уникати<Textarea
              id="brief-exclusions"
              v-model="form.exclusions"
              rows="2"
              class="workspace-input"
            /><span class="field-hint">Кожне виключення — з нового рядка.</span></label>
            <label
              class="brief-field brief-wide"
              for="brief-notes"
            >Авторські нотатки<Textarea
              id="brief-notes"
              v-model="form.notes"
              rows="4"
              maxlength="10000"
              class="workspace-input"
            /></label>
          </fieldset>
        </form>
        <aside
          class="brief-context"
          aria-labelledby="brief-context-title"
        >
          <h2 id="brief-context-title">
            Основа матеріалу
          </h2>
          <fieldset
            class="brief-modes"
            :disabled="archived || busy"
          >
            <legend>Як працюємо з темою</legend><label><input
              v-model="form.contentMode"
              type="radio"
              value="FACTUAL"
            > На перевірених фактах</label><label><input
              v-model="form.contentMode"
              type="radio"
              value="CREATIVE"
            > Творчий матеріал</label>
          </fieldset>
          <p
            v-if="form.contentMode === 'CREATIVE'"
            class="brief-review"
            role="status"
          >
            Без перевіреної фактологічної основи. Працюємо з темою та авторськими нотатками.
          </p>
          <p
            v-else-if="state.prerequisites.missingBasis"
            class="brief-review"
            role="status"
          >
            Немає придатної затвердженої фактичної основи. Збережіть бриф, а перед генерацією перевірте факти.
          </p>
          <p
            v-else
            class="brief-evidence"
          >
            Затверджена фактична основа доступна.
          </p>
          <fieldset
            v-if="form.contentMode === 'FACTUAL' && state.prerequisites.eligibleClaims.length"
            class="brief-claims"
            :disabled="busy || archived"
          >
            <legend>Обов’язкові факти</legend><label
              v-for="claim in state.prerequisites.eligibleClaims"
              :key="claim.currentRevisionId"
            ><input
              v-model="form.requiredClaimRevisionIds"
              type="checkbox"
              :value="claim.currentRevisionId"
            ><span>{{ claim.currentRevision.wording }}</span></label>
          </fieldset>
        </aside>
      </div>
      <details
        v-if="state.brief"
        class="brief-details"
      >
        <summary>Історія та контекст брифу</summary><p>Поточна версія {{ state.brief.currentRevision.number }}. Стиль і фактична основа зберігаються разом із кожною версією.</p><div
          v-for="revision in state.brief.history"
          :key="revision.id"
          class="brief-history"
        >
          <h3>Версія {{ revision.number }} · {{ revision.topic }}</h3><p>{{ revision.centralMessage }}</p><p>{{ revision.contentMode === 'CREATIVE' ? 'Творчий матеріал' : 'На перевірених фактах' }} · {{ revision.tone }}</p><details>
            <summary>Збережений контекст</summary><p v-if="revision.style">
              Стиль простору · Версія {{ revision.style.revision }} · {{ revision.style.tone }}
            </p><pre>{{ JSON.stringify(revision.contextSnapshots, null, 2) }}</pre>
          </details>
        </div>
      </details>
      <section
        v-if="state.articleSelected"
        class="brief-outline"
        aria-labelledby="outline-title"
      >
        <div class="brief-section-heading">
          <div>
            <h2 id="outline-title">
              План статті
            </h2>
          </div><Button
            class="workspace-button"
            variant="outline"
            :disabled="busy || archived || generationBlocked || activeJob"
            @click="generate"
          >
            Запропонувати структуру
          </Button>
        </div>
        <p
          v-if="!state.brief || dirty"
          class="field-hint"
        >
          Збережіть бриф, щоб працювати зі структурою.
        </p>
        <p
          v-if="jobError"
          role="alert"
        >
          {{ jobError }} <button
            type="button"
            @click="loadJobs"
          >
            Оновити стан
          </button>
        </p>
        <div
          v-for="job in jobs.filter(item => item.status !== 'SUCCEEDED')"
          :key="job.id"
          class="brief-job"
        >
          <p role="status">
            {{ jobLabel(job) }}
          </p><p
            v-if="['FAILED', 'OUTCOME_UNKNOWN'].includes(job.status)"
            class="field-hint"
          >
            Попередня робота збережена. Можна відредагувати структуру вручну. <template v-if="job.status === 'OUTCOME_UNKNOWN'">
              Пізній результат не буде застосовано. Новий запуск може спричинити повторну оплату.
            </template>
          </p><Button
            v-if="['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status)"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived"
            @click="jobAction(job, 'cancel')"
          >
            Скасувати генерацію
          </Button><Button
            v-if="job.retryAllowed"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived"
            @click="jobAction(job, 'retry')"
          >
            Повторити спробу
          </Button>
        </div>
        <details
          v-for="candidate in candidates"
          :key="candidate.id"
          class="brief-candidate"
        >
          <summary>Пропозиція AI · Не застосовано</summary><h3>{{ candidate.content.title }}</h3><ol>
            <li
              v-for="(section, index) in candidate.content.sections"
              :key="index"
            >
              <strong>{{ section.title }}</strong><p>{{ section.purpose }}</p>
            </li>
          </ol><Button
            class="workspace-button"
            variant="outline"
            :disabled="busy || archived || dirty || outlineDirty || remoteOutlineChanged || remoteBriefChanged"
            @click="mutate(`/outline/${candidate.id}/apply`, { expectedRevision: state.outline?.revision ?? 0 }, 'outline')"
          >
            Застосувати структуру
          </Button><p
            v-if="outlineDirty"
            class="field-hint"
          >
            Спочатку збережіть ручні зміни структури.
          </p>
        </details>
        <h3
          v-if="currentOutline"
          class="outline-reading-title"
        >
          {{ currentOutline.content.title }}
        </h3>
        <ol
          v-if="currentOutline"
          class="outline-reading"
        >
          <li
            v-for="(section, index) in currentOutline.content.sections"
            :key="index"
          >
            <h3>{{ section.title }}</h3>
            <p>{{ section.purpose }}</p>
          </li>
        </ol>
        <details
          v-if="state.brief"
          class="outline-edit"
          :open="!currentOutline || outlineDirty"
        >
          <summary>{{ currentOutline ? 'Редагувати план' : 'Створити план вручну' }}</summary>
          <form
            v-if="state.brief"
            @submit.prevent="saveOutline"
          >
            <fieldset
              class="brief-fields"
              :disabled="busy || archived"
            >
              <legend class="sr-only">
                Редагування структури
              </legend><label
                class="brief-field brief-wide"
                for="outline-heading"
              >Заголовок статті<input
                id="outline-heading"
                v-model="outline.title"
                required
                maxlength="500"
                class="workspace-input"
                data-slot="input"
              ></label><div
                v-for="(section, index) in outline.sections"
                :key="index"
                class="outline-section brief-wide"
              >
                <div class="brief-section-heading">
                  <h3>Розділ {{ index + 1 }}</h3><Button
                    type="button"
                    variant="ghost"
                    class="workspace-button"
                    :aria-label="`Видалити розділ ${index + 1}`"
                    @click="outline.sections.splice(index, 1)"
                  >
                    Видалити
                  </Button>
                </div><label
                  class="brief-field"
                  :for="`outline-title-${index}`"
                >Назва розділу<input
                  :id="`outline-title-${index}`"
                  v-model="section.title"
                  required
                  maxlength="300"
                  class="workspace-input"
                ></label><label
                  class="brief-field"
                  :for="`outline-purpose-${index}`"
                >Про що цей розділ<Textarea
                  :id="`outline-purpose-${index}`"
                  v-model="section.purpose"
                  rows="2"
                  maxlength="2000"
                  required
                  class="workspace-input"
                /></label><fieldset
                  v-if="form.contentMode === 'FACTUAL' && state.prerequisites.eligibleClaims.length"
                  class="brief-claims"
                >
                  <legend>Факти розділу</legend><label
                    v-for="claim in state.prerequisites.eligibleClaims"
                    :key="claim.currentRevisionId"
                  ><input
                    v-model="section.claimRevisionIds"
                    type="checkbox"
                    :value="claim.currentRevisionId"
                  ><span>{{ claim.currentRevision.wording }}</span></label>
                </fieldset>
              </div>
            </fieldset><div class="brief-actions">
              <Button
                type="button"
                variant="outline"
                class="workspace-button"
                :disabled="busy || archived || outline.sections.length >= 30"
                @click="outline.sections.push({ title: '', purpose: '', claimRevisionIds: [] })"
              >
                Додати розділ
              </Button><Button
                type="submit"
                class="workspace-button workspace-button-primary"
                :disabled="busy || archived || dirty || (!outlineDirty && !outdatedOutline) || !outline.title.trim() || !outline.sections.length || outline.sections.some(section => !section.title.trim() || !section.purpose.trim())"
              >
                Зберегти структуру
              </Button>
            </div>
          </form>
        </details>
        <p
          v-if="outdatedOutline"
          class="brief-review"
        >
          Бриф змінився після створення цієї структури. Збережіть нову редакцію структури для поточного брифу.
        </p><div
          v-if="currentOutline"
          class="brief-actions"
        >
          <span role="status">{{ outlineDirty ? 'Є незбережені зміни структури' : currentOutline.status === 'APPROVED' ? 'Структуру схвалено' : currentOutline.status === 'WITHDRAWN' ? 'Схвалення відкликано' : 'Структура потребує перегляду' }}</span><Button
            v-if="currentOutline.status === 'PROPOSED'"
            variant="outline"
            class="workspace-button"
            :disabled="busy || archived || dirty || outlineDirty || generationBlocked || outdatedOutline || remoteOutlineChanged"
            @click="mutate(`/outline/${currentOutline.id}/approve`, { expectedRevision: state.outline?.revision ?? 0 })"
          >
            Схвалити структуру
          </Button>
        </div>
        <details
          v-if="state.outline?.revisions.length"
          class="brief-details"
        >
          <summary>Історія структури</summary><article
            v-for="revision in state.outline.revisions"
            :key="revision.id"
            class="brief-history"
          >
            <h3>Версія {{ revision.number }} · {{ revision.content.title }}</h3><p>{{ revision.origin === 'AI' ? 'Пропозиція AI' : 'Ручна редакція' }} · {{ revision.status === 'APPROVED' ? 'Схвалено' : revision.status === 'WITHDRAWN' ? 'Схвалення відкликано' : 'Потребує перегляду' }}</p><ol>
              <li
                v-for="(section, index) in revision.content.sections"
                :key="index"
              >
                {{ section.title }} — {{ section.purpose }}
              </li>
            </ol>
          </article>
        </details>
      </section>
    </template>
  </section>
</template>

<style scoped>
.brief-workspace { margin-bottom: 40px; color: var(--ink); }
.brief-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 64px; align-items: start; }
.brief-context { min-width: 0; border-top: 1px solid var(--rule); padding-top: 18px; }
.brief-context h2 { font-size: 23px; margin: 0 0 24px; }
.brief-heading { display: flex; align-items: start; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
.brief-heading-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 12px; }
.brief-heading-actions span { color: var(--muted); font-size: 12px; }
.brief-heading h1 { font-family: var(--serif); font-size: 39px; line-height: 1.2; font-weight: 550; letter-spacing: -.025em; margin: 0; }
.brief-lead { font-size: 15px; line-height: 1.65; color: var(--muted); max-width: 650px; margin: 10px 0 0; }
.brief-document { min-width: 0; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
.brief-modes { display: grid; gap: 14px; }
legend { font-weight: 500; font-size: 13px; margin-bottom: 12px; }
.brief-modes label, .brief-claims label { display: flex; align-items: flex-start; gap: 10px; line-height: 1.5; }
input[type='checkbox'], input[type='radio'] { margin-top: 4px; accent-color: var(--copper); flex: 0 0 auto; }
.brief-review, .brief-evidence { line-height: 1.55; padding: 12px 0; font-size: 14px; }
.brief-review { color: var(--review, #93602c); }
.brief-evidence { color: var(--evidence, #2c6660); }
.brief-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 28px 24px; margin-top: 0; }
.brief-field { display: flex; flex-direction: column; gap: 8px; min-width: 0; font-weight: 400; font-size: 13px; }
.brief-wide { grid-column: 1 / -1; }
.brief-field input, .brief-field textarea { min-height: 44px; width: 100%; padding: 10px 0; border: 0; border-bottom: 1px solid var(--field-rule, #bec1c4); border-radius: 0; background: var(--document); color: var(--ink); font-family: var(--serif); font-size: 20px; font-weight: 400; box-shadow: none; line-height: 1.55; }
.brief-field input:hover { border-color: var(--ink); }
.brief-field textarea { resize: vertical; }
.brief-claims { margin-top: 24px; }
.brief-claims label { margin: 12px 0; font-weight: 400; }
.brief-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 24px; }
.brief-actions span { font-size: 13px; color: var(--muted); }
.brief-details { padding: 20px 0; border-bottom: 1px solid var(--rule); font-size: 14px; line-height: 1.6; }
summary { cursor: pointer; font-weight: 500; padding: 12px 0; min-height: 44px; }
.brief-history { padding: 12px 0; border-top: 1px solid var(--rule); }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.brief-outline { margin-top: 40px; border-top: 1px solid var(--rule); padding-top: 24px; }
.outline-reading { max-width: 78ch; padding-left: 24px; margin: 24px 0; }
.outline-reading-title { margin: 24px 0 0; font-size: 25px; font-weight: 550; }
.outline-reading li { padding: 4px 0 18px 8px; }
.outline-reading h3 { margin: 0 0 6px; font-size: 21px; }
.outline-reading p { margin: 0; line-height: 1.6; color: var(--muted); }
.outline-edit { border-top: 1px solid var(--rule); }
.outline-edit > summary { margin-bottom: 12px; }
.brief-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
h2 { font-family: var(--serif); font-size: 28px; font-weight: 600; margin: 8px 0; }
h3 { font-family: var(--serif); font-size: 21px; font-weight: 600; }
.outline-section { padding: 16px 0; border-top: 1px solid var(--rule); display: grid; gap: 16px; }
.brief-candidate, .brief-job { margin: 20px 0; padding: 16px 0; border-top: 1px solid var(--rule); }
.brief-candidate summary { color: var(--proposal, #725078); }
:where(input, textarea, summary, button):focus-visible { outline: 2px solid var(--copper); outline-offset: 3px; }
@media (max-width: 900px) { .brief-layout { grid-template-columns: minmax(0, 1fr) 240px; gap: 32px; } }
@media (max-width: 760px) { .brief-heading { flex-direction: column; } .brief-heading-actions { justify-content: flex-start; } .brief-layout { grid-template-columns: minmax(0, 1fr); gap: 32px; } .brief-field input, .brief-field textarea { font-size: 18px; } .brief-fields { grid-template-columns: minmax(0, 1fr); } .brief-section-heading { align-items: flex-start; flex-direction: column; } .brief-heading h1 { font-size: 32px; } }
</style>
