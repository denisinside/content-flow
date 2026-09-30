<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'

interface Job {
  id: string
  operation: string
  status: string
  progressStage: string
  attemptCount: number
  maxAttempts: number
  errorCategory: string | null
  providerOutcome: string
  retryAllowed: boolean
  inputSummary?: { materialId?: string; label?: string; sourceUrl?: string; originalAssetId?: string; originalFilename?: string }
  resultRefs: { materialId?: string; snapshotId?: string } | null
  createdAt: string
  updatedAt: string
}

const props = defineProps<{ projectId: string; csrfToken: string; archived?: boolean; disabled?: boolean; revision: number; materials: { id: string; label: string }[] }>()
const emit = defineEmits<{ 'session-expired': []; completed: [materialId: string]; open: [materialId: string]; fallback: [materialId: string]; restart: [materialId: string] }>()
const jobs = ref<Job[]>([])
const error = ref('')
const pending = ref<string | null>(null)
const confirmation = ref<string | null>(null)
const ready = ref(false)
const actionable = computed(() => jobs.value.filter(job => !['SUCCEEDED', 'CANCELLED'].includes(job.status)))
const history = computed(() => jobs.value.filter(job => ['SUCCEEDED', 'CANCELLED'].includes(job.status)))
const seen = new Map<string, string>()
let timer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | null = null
let disposed = false
let epoch = 0

function materialId(job: Job) { return job.inputSummary?.materialId ?? job.resultRefs?.materialId ?? null }
function title(job: Job) { return props.materials.find(material => material.id === materialId(job))?.label ?? job.inputSummary?.label ?? 'Імпорт джерела' }
function stateLabel(status: string) {
  return ({ QUEUED: 'Очікує обробки', RUNNING: 'Імпортуємо', RETRY_WAIT: 'Очікує повторної спроби', SUCCEEDED: 'Текст збережено', FAILED: 'Імпорт не завершено', CANCELLED: 'Скасовано', OUTCOME_UNKNOWN: 'Результат зовнішньої обробки невідомий' } as Record<string, string>)[status] ?? 'Обробка джерела'
}
function stageLabel(stage: string) {
  return ({ WAITING: 'Очікування', PREPARING: 'Підготовка імпорту', VALIDATING_INPUT: 'Перевірка джерела', PROCESSING: 'Виділення тексту', RETRY_WAIT: 'Очікування повторної спроби', COMPLETE: 'Готово', FAILED: 'Обробка завершилася з помилкою', CANCELLED: 'Обробку скасовано' } as Record<string, string>)[stage] ?? 'Обробка джерела'
}
function failureLabel(job: Job) {
  if (job.status === 'OUTCOME_UNKNOWN') return 'Попередній запит міг продовжити обробку. Пізній результат не буде збережено. Новий запуск може спричинити повторну оплату.'
  const messages: Record<string, string> = {
    NO_TEXT: 'У документі немає доступного тексту. Введіть його вручну; оригінал залишиться пов’язаним із джерелом.',
    INVALID_CONTRACT: 'Сервіс повернув непридатний текст. Введіть текст вручну або перевірте оригінал.',
    INVALID_INPUT: 'Джерело не вдалося обробити. Перевірте оригінал або введіть текст вручну.',
    ACCESS_DENIED: 'Сторінка недоступна. Перевірте посилання або введіть текст вручну.',
    TIMEOUT: 'Обробка перевищила дозволений час. Попередні збережені версії доступні.',
    TRANSIENT_TRANSPORT: 'Сервіс тимчасово недоступний. Можна повторити спробу з тим самим джерелом.',
    ENGINE_UNAVAILABLE: 'Сервіс тимчасово недоступний. Можна повторити спробу з тим самим джерелом.',
    RATE_LIMIT: 'Сервіс обмежив кількість запитів. Дочекайтеся повторної спроби або перевірте ліміт обробки.',
    PROVIDER_5XX: 'Сервіс тимчасово недоступний. Можна повторити спробу з тим самим джерелом.',
    CONTRACT: 'Сервіс повернув непридатний текст. Введіть текст вручну або перевірте оригінал.',
    CONFIG: 'Сервіс імпорту ще не налаштовано для цього середовища. Можна ввести текст вручну.',
    QUOTA: 'Ліміт зовнішньої обробки вичерпано. Перевірте ліміт або введіть текст вручну.',
    AUTH: 'Сервіс імпорту відмовив у доступі. Перевірте налаштування обробки або введіть текст вручну.',
    INVALID_URL: 'Посилання не вдалося безпечно завантажити. Перевірте сторінку або введіть текст вручну.',
    SOURCE_CHANGED: 'Джерело змінилося під час імпорту. Попередні версії збережено; запустіть новий імпорт актуального джерела.',
  }
  return messages[job.errorCategory ?? ''] ?? 'Не вдалося завершити імпорт. Попередні версії збережено; можна ввести текст вручну.'
}
function retryable(job: Job) { return job.retryAllowed === true }
function active(job: Job) { return ['QUEUED', 'RUNNING', 'RETRY_WAIT'].includes(job.status) }

async function load() {
  if (disposed) return
  clearTimeout(timer)
  controller?.abort()
  controller = new AbortController()
  const version = ++epoch
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/jobs`, { credentials: 'same-origin', signal: controller.signal })
    if (disposed || version !== epoch) return
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) throw new Error('Не вдалося оновити стан імпорту. Перевірте його ще раз.')
    const result = await response.json() as { jobs: Job[] }
    if (disposed || version !== epoch) return
    jobs.value = result.jobs.filter(job => ['WEB_IMPORT', 'DOCUMENT_IMPORT'].includes(job.operation))
    for (const job of jobs.value) {
      const previous = seen.get(job.id)
      seen.set(job.id, job.status)
      if (job.status === 'SUCCEEDED' && previous !== 'SUCCEEDED' && materialId(job)) emit('completed', materialId(job)!)
    }
    ready.value = true
    error.value = ''
  } catch (cause) {
    if (!disposed && version === epoch && !(cause instanceof DOMException && cause.name === 'AbortError')) error.value = cause instanceof Error ? cause.message : 'Стан імпорту тимчасово недоступний.'
  } finally {
    if (!disposed && version === epoch) timer = setTimeout(() => void load(), jobs.value.some(active) || !ready.value ? 2000 : 5000)
  }
}

async function act(job: Job, action: 'retry' | 'cancel') {
  if (pending.value || props.archived || props.disabled) return
  clearTimeout(timer)
  epoch += 1
  controller?.abort()
  pending.value = job.id
  error.value = ''
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/jobs/${encodeURIComponent(job.id)}/${action}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': props.csrfToken },
    })
    if (disposed) return
    if (response.status === 401) { emit('session-expired'); return }
    if (!response.ok) throw new Error('Стан імпорту змінився або ця дія недоступна. Оновіть стан і спробуйте ще раз.')
    const result = await response.json() as { job: Job }
    jobs.value = jobs.value.map(item => item.id === job.id ? result.job : item)
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { pending.value = null; if (!disposed) void load() }
}

function restart(job: Job) {
  const id = materialId(job)
  if (!id || props.disabled || props.archived) return
  if (confirmation.value !== job.id) { confirmation.value = job.id; return }
  confirmation.value = null
  emit('restart', id)
}
function refresh() { clearTimeout(timer); controller?.abort(); void load() }
watch(() => props.revision, () => void load())
onMounted(() => void load())
onBeforeUnmount(() => { disposed = true; epoch += 1; clearTimeout(timer); controller?.abort() })
</script>

<template>
  <section
    v-if="jobs.length || error"
    class="import-jobs"
    aria-labelledby="import-jobs-title"
  >
    <div class="import-heading">
      <h3 id="import-jobs-title">
        Імпорт джерел
      </h3>
      <Button
        variant="ghost"
        class="import-button"
        type="button"
        @click="refresh"
      >
        Оновити стан
      </Button>
    </div>
    <p
      v-if="error"
      class="import-error"
      role="alert"
    >
      {{ error }}
    </p>
    <ul
      v-if="actionable.length"
      class="import-list"
    >
      <li
        v-for="job in actionable"
        :key="job.id"
      >
        <div class="import-summary">
          <strong>{{ title(job) }}</strong><span role="status">{{ stateLabel(job.status) }}</span>
        </div>
        <p
          v-if="active(job)"
          class="import-stage"
        >
          {{ stageLabel(job.progressStage) }}<template v-if="job.status === 'RETRY_WAIT'">
            · Спроба {{ job.attemptCount }} із {{ job.maxAttempts }}
          </template>
        </p>
        <p
          v-if="['FAILED', 'OUTCOME_UNKNOWN'].includes(job.status)"
          class="import-message"
        >
          {{ failureLabel(job) }}
        </p>
        <div class="import-actions">
          <Button
            v-if="active(job)"
            variant="outline"
            class="import-button"
            :disabled="archived || disabled || !!pending"
            @click="act(job, 'cancel')"
          >
            {{ pending === job.id ? 'Виконуємо…' : 'Скасувати імпорт' }}
          </Button>
          <Button
            v-if="retryable(job)"
            variant="outline"
            class="import-button"
            :disabled="archived || disabled || !!pending"
            @click="act(job, 'retry')"
          >
            Повторити спробу
          </Button>
          <Button
            v-if="['FAILED', 'OUTCOME_UNKNOWN'].includes(job.status) && materialId(job)"
            variant="outline"
            class="import-button"
            :disabled="archived || disabled || !!pending"
            @click="emit('fallback', materialId(job)!)"
          >
            Ввести текст вручну
          </Button>
          <Button
            v-if="['OUTCOME_UNKNOWN', 'CANCELLED'].includes(job.status) && materialId(job)"
            variant="outline"
            class="import-button"
            :disabled="archived || disabled || !!pending"
            @click="restart(job)"
          >
            {{ confirmation === job.id ? 'Підтвердити новий запуск' : 'Запустити знову' }}
          </Button>
          <Button
            v-if="confirmation === job.id"
            variant="ghost"
            class="import-button"
            @click="confirmation = null"
          >
            Залишити без змін
          </Button>
        </div>
        <p
          v-if="active(job)"
          class="import-hint"
        >
          Скасування зупиняє збереження результату. Зовнішня обробка й витрати можуть продовжитися.
        </p>
        <details class="import-details">
          <summary>Деталі імпорту</summary><dl><dt>Етап</dt><dd>{{ stageLabel(job.progressStage) }}</dd><dt>Спроби</dt><dd>{{ job.attemptCount }} / {{ job.maxAttempts }}</dd><dt>Ідентифікатор</dt><dd>{{ job.id }}</dd><dt>Оновлено</dt><dd>{{ new Date(job.updatedAt).toLocaleString('uk-UA') }}</dd></dl>
        </details>
      </li>
    </ul>
    <details
      v-if="history.length"
      class="import-history"
    >
      <summary>Завершені імпорти</summary>
      <ul class="import-list">
        <li
          v-for="job in history"
          :key="job.id"
        >
          <div class="import-summary">
            <strong>{{ title(job) }}</strong><span>{{ stateLabel(job.status) }}</span>
          </div><Button
            v-if="job.status === 'SUCCEEDED' && materialId(job)"
            variant="ghost"
            class="import-button"
            :disabled="disabled"
            @click="emit('open', materialId(job)!)"
          >
            Переглянути збережений текст
          </Button><Button
            v-if="job.status === 'CANCELLED' && materialId(job)"
            variant="ghost"
            class="import-button"
            :disabled="disabled || archived"
            @click="restart(job)"
          >
            {{ confirmation === job.id ? 'Підтвердити новий запуск' : 'Запустити знову' }}
          </Button><p
            v-if="confirmation === job.id"
            class="import-message"
          >
            Новий запуск може спричинити повторні витрати.
          </p>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.import-jobs { margin-top: 24px; padding-bottom: 22px; border-bottom: 1px solid var(--rule); }
.import-heading, .import-summary { display: flex; justify-content: space-between; gap: 18px; align-items: baseline; }
.import-heading h3 { margin: 0; font-family: var(--serif); font-size: 22px; font-weight: 500; }
.import-list { margin: 0; padding: 0; list-style: none; }
.import-list li { padding: 16px 0; border-top: 1px solid var(--rule); }
.import-summary strong { font-family: var(--serif); font-size: 17px; font-weight: 500; overflow-wrap: anywhere; }
.import-summary span, .import-stage { color: var(--muted); font-size: 12px; line-height: 1.5; }
.import-stage { margin: 6px 0; }
.import-message, .import-error { margin: 8px 0 12px; font-size: 13px; line-height: 1.6; max-width: 760px; }
.import-error { color: var(--error); }
.import-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.import-button { min-height: 36px; border-radius: 2px; font-size: 12px; }
.import-hint { margin: 8px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.import-details, .import-history { margin-top: 10px; font-size: 12px; }
.import-details summary, .import-history > summary { padding: 6px 0; cursor: pointer; color: var(--muted); }
.import-details dl { display: grid; grid-template-columns: 100px minmax(0, 1fr); gap: 6px 10px; font-size: 11px; }
.import-details dt { color: var(--muted); }
.import-details dd { margin: 0; overflow-wrap: anywhere; }
@media (max-width: 520px) { .import-summary { flex-direction: column; gap: 4px; } }
</style>
