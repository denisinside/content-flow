<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'

const TEXT_LIMIT = 200_000
const FILE_LIMIT = 1_048_576

type Purpose = 'FACTUAL_SOURCE' | 'NOTES' | 'SUPPLIED_ARTICLE' | 'BRANDBOOK' | 'STYLE_SAMPLE'

interface Material {
  id: string
  projectId: string
  kind: 'TEXT' | 'FILE' | 'URL'
  purpose: Purpose
  label: string
  included: boolean
  revision: number
  currentSnapshotId: string | null
  createdAt: string
  updatedAt: string
}

interface SnapshotSummary {
  id: string
  sequence: number
  origin: string
  createdAt: string
  createdBy?: string | null
  originalAssetId?: string | null
  originalFilename?: string | null
}

interface Snapshot extends SnapshotSummary {
  projectId: string
  materialId: string
  normalizedText: string
  sha256: string
  bytes: number
  previousSnapshotId: string | null
  fragments: { id: string; ordinal: number; startOffset: number; endOffset: number; sha256: string }[]
}

interface MaterialDetail {
  material: Material
  snapshots: SnapshotSummary[]
}

const props = defineProps<{ projectId: string; projectTitle: string; csrfToken: string; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()

const purposes: { id: Purpose; label: string }[] = [
  { id: 'FACTUAL_SOURCE', label: 'Фактичне джерело' },
  { id: 'NOTES', label: 'Нотатки' },
  { id: 'SUPPLIED_ARTICLE', label: 'Надана стаття' },
  { id: 'BRANDBOOK', label: 'Брендбук' },
  { id: 'STYLE_SAMPLE', label: 'Зразок стилю' },
]

const materials = ref<Material[]>([])
const selectedMaterial = ref<Material | null>(null)
const snapshots = ref<SnapshotSummary[]>([])
const selectedSnapshot = ref<Snapshot | null>(null)
const listState = ref<'loading' | 'ready' | 'error'>('loading')
const detailState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
const errorMessage = ref('')
const mode = ref<'text' | 'upload'>('text')
const label = ref('')
const purpose = ref<Purpose>('FACTUAL_SOURCE')
const text = ref('')
const busy = ref(false)
const editing = ref(false)
const editorText = ref('')
const editorMessage = ref('')
const refreshAvailable = ref(false)
const externalNoticeRequired = ref(false)
const includeBusyId = ref<string | null>(null)
const textCount = computed(() => text.value.length)
const editorCount = computed(() => editorText.value.length)
const canAdd = computed(() => listState.value === 'ready' && !busy.value && !editing.value && label.value.trim().length > 0 && (mode.value === 'upload' || (textCount.value > 0 && textCount.value <= TEXT_LIMIT)))

let epoch = 0
let controller: AbortController | null = null

function purposeLabel(value: Purpose) {
  return purposes.find(item => item.id === value)?.label ?? value
}

function originLabel(value: string) {
  const labels: Record<string, string> = {
    MANUAL_TEXT: 'Введено вручну',
    LOCAL_FILE: 'Завантажено файлом',
    MANUAL: 'Введено вручну',
    MANUAL_EDIT: 'Нова версія вручну',
    UPLOAD: 'Завантажено файлом',
    FILE_UPLOAD: 'Завантажено файлом',
  }
  return labels[value] ?? value
}

function dateLabel(value?: string) {
  if (!value) return 'Немає даних'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Немає даних' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function startRequest() {
  controller?.abort()
  controller = new AbortController()
  return { signal: controller.signal, version: ++epoch }
}

function stillCurrent(version: number) {
  return version === epoch
}

function handleUnauthorized(response: Response) {
  if (response.status !== 401) return false
  emit('session-expired')
  return true
}

function readableError(status: number, operation: 'load' | 'write') {
  if (status === 403) return 'Доступ до цієї дії не дозволено. Перевірте повідомлення про зовнішню обробку та потрібну згоду.'
  if (status === 409) return 'Джерело вже змінилося в іншій вкладці. Ваш текст збережено тут; оновіть джерело перед новою спробою.'
  if (status === 413) return 'Файл або текст завеликий для цього джерела.'
  if (status === 415 || status === 400) return 'Перевірте формат і розмір. Підтримуються UTF-8 TXT і Markdown до 1 МБ.'
  if (status === 404) return 'Проєкт або джерело більше недоступні.'
  if (status === 503) return 'Сервіс джерел тимчасово недоступний. Спробуйте ще раз.'
  return operation === 'load'
    ? 'Не вдалося завантажити джерела. Спробуйте ще раз.'
    : 'Не вдалося зберегти зміни. Ваш текст залишився у формі.'
}

async function loadMaterials() {
  const { signal, version } = startRequest()
  listState.value = 'loading'
  errorMessage.value = ''
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials`, { credentials: 'same-origin', signal })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(readableError(response.status, 'load'))
    const result = await response.json() as { materials: Material[] }
    if (!stillCurrent(version)) return
    materials.value = result.materials
    listState.value = 'ready'
    if (selectedMaterial.value) {
      const next = materials.value.find(item => item.id === selectedMaterial.value?.id)
      if (!next) {
        selectedMaterial.value = null
        selectedSnapshot.value = null
        snapshots.value = []
      } else {
        selectedMaterial.value = next
      }
    }
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    listState.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : readableError(0, 'load')
  }
}

async function loadMaterial(materialId: string, snapshotId?: string) {
  const { signal, version } = startRequest()
  selectedMaterial.value = materials.value.find(item => item.id === materialId) ?? null
  selectedSnapshot.value = null
  snapshots.value = []
  editing.value = false
  detailState.value = 'loading'
  errorMessage.value = ''
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(materialId)}`, { credentials: 'same-origin', signal })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(readableError(response.status, 'load'))
    const result = await response.json() as MaterialDetail
    if (!stillCurrent(version)) return
    selectedMaterial.value = result.material
    snapshots.value = result.snapshots
    const selectedId = snapshotId ?? result.material.currentSnapshotId ?? result.snapshots[0]?.id
    if (!selectedId) {
      detailState.value = 'ready'
      return
    }
    await loadSnapshot(selectedId, version, signal)
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    detailState.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : readableError(0, 'load')
  }
}

async function loadSnapshot(snapshotId: string, ownerVersion?: number, ownerSignal?: AbortSignal) {
  const version = ownerVersion ?? startRequest().version
  const signal = ownerSignal ?? controller?.signal
  if (!selectedMaterial.value || !signal) return
  detailState.value = 'loading'
  try {
    const url = `/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(selectedMaterial.value.id)}/snapshots/${encodeURIComponent(snapshotId)}`
    const response = await fetch(url, { credentials: 'same-origin', signal })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(readableError(response.status, 'load'))
    const result = await response.json() as { snapshot: Snapshot }
    if (!stillCurrent(version)) return
    selectedSnapshot.value = result.snapshot
    detailState.value = 'ready'
    editing.value = false
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    detailState.value = 'error'
    errorMessage.value = error instanceof Error ? error.message : readableError(0, 'load')
  }
}

async function reloadSources() {
  if (busy.value || editing.value) return
  busy.value = true
  try {
    await loadMaterials()
    if (listState.value === 'ready' && selectedMaterial.value) await loadMaterial(selectedMaterial.value.id)
  } finally {
    busy.value = false
  }
}

function clearCreateForm() {
  label.value = ''
  text.value = ''
  purpose.value = 'FACTUAL_SOURCE'
  const input = document.getElementById('source-file') as HTMLInputElement | null
  if (input) input.value = ''
}

async function addMaterial() {
  if (!canAdd.value || props.archived) return
  busy.value = true
  errorMessage.value = ''
  externalNoticeRequired.value = false
  const { signal, version } = startRequest()
  try {
    let response: Response
    if (mode.value === 'text') {
      response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials`, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
        body: JSON.stringify({ label: label.value.trim(), purpose: purpose.value, text: text.value }),
      })
    } else {
      const input = document.getElementById('source-file') as HTMLInputElement | null
      const file = input?.files?.[0]
      if (!file) throw new Error('Оберіть TXT або Markdown файл.')
      if (file.size > FILE_LIMIT) throw new Error('Файл має бути не більшим за 1 МБ.')
      const form = new FormData()
      form.set('file', file)
      form.set('label', label.value.trim())
      form.set('purpose', purpose.value)
      response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/upload`, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'X-CSRF-Token': props.csrfToken }, body: form,
      })
    }
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) {
      if (mode.value === 'upload' && response.status === 403) externalNoticeRequired.value = true
      throw new Error(readableError(response.status, 'write'))
    }
    const result = await response.json() as { material: Material; snapshot: SnapshotSummary }
    if (!stillCurrent(version)) return
    clearCreateForm()
    await loadMaterials()
    await loadMaterial(result.material.id, result.snapshot.id)
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    errorMessage.value = error instanceof Error ? error.message : readableError(0, 'write')
  } finally {
    busy.value = false
  }
}

async function toggleIncluded(material: Material) {
  if (props.archived || busy.value || detailState.value === 'loading' || includeBusyId.value || (editing.value && selectedMaterial.value?.id === material.id)) return
  const { signal, version } = startRequest()
  includeBusyId.value = material.id
  busy.value = true
  errorMessage.value = ''
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(material.id)}`, {
      method: 'PATCH', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ expectedRevision: material.revision, included: !material.included }),
    })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(readableError(response.status, 'write'))
    const result = await response.json() as { material: Material }
    if (!stillCurrent(version)) return
    materials.value = materials.value.map(item => item.id === material.id ? result.material : item)
    if (selectedMaterial.value?.id === material.id) selectedMaterial.value = result.material
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    errorMessage.value = error instanceof Error ? error.message : readableError(0, 'write')
  } finally {
    includeBusyId.value = null
    busy.value = false
  }
}

function beginEdit() {
  if (!selectedMaterial.value || !selectedSnapshot.value || props.archived || busy.value) return
  editorText.value = selectedSnapshot.value.normalizedText
  editorMessage.value = ''
  refreshAvailable.value = false
  editing.value = true
}

async function saveSnapshot() {
  const material = selectedMaterial.value
  if (!material || !editing.value || busy.value) return
  if (!editorText.value.length || editorText.value.length > TEXT_LIMIT) {
    editorMessage.value = `Текст має містити від 1 до ${TEXT_LIMIT.toLocaleString('uk-UA')} символів.`
    return
  }
  const typedText = editorText.value
  busy.value = true
  editorMessage.value = ''
  const { signal, version } = startRequest()
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(material.id)}/snapshots`, {
      method: 'POST', credentials: 'same-origin', signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ expectedRevision: material.revision, text: typedText }),
    })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) {
      if (response.status === 409) refreshAvailable.value = true
      throw new Error(readableError(response.status, 'write'))
    }
    const result = await response.json() as { material: Material; snapshot: SnapshotSummary }
    if (!stillCurrent(version)) return
    editing.value = false
    editorMessage.value = ''
    refreshAvailable.value = false
    await loadMaterials()
    await loadMaterial(result.material.id, result.snapshot.id)
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    // Keep the exact draft in the editor, including after an optimistic concurrency conflict.
    editorText.value = typedText
    editorMessage.value = error instanceof Error ? error.message : readableError(0, 'write')
  } finally {
    busy.value = false
  }
}

async function refreshLatestAndKeepDraft() {
  const material = selectedMaterial.value
  const localText = editorText.value
  if (!material || busy.value || !refreshAvailable.value) return
  const { signal, version } = startRequest()
  busy.value = true
  editorMessage.value = ''
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(material.id)}`, { credentials: 'same-origin', signal })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(readableError(response.status, 'load'))
    const result = await response.json() as MaterialDetail
    if (!stillCurrent(version)) return
    let latestSnapshot: Snapshot | null = null
    if (result.material.currentSnapshotId) {
      const snapshotUrl = `/api/v1/projects/${encodeURIComponent(props.projectId)}/materials/${encodeURIComponent(material.id)}/snapshots/${encodeURIComponent(result.material.currentSnapshotId)}`
      const snapshotResponse = await fetch(snapshotUrl, { credentials: 'same-origin', signal })
      if (!stillCurrent(version)) return
      if (handleUnauthorized(snapshotResponse)) return
      if (!snapshotResponse.ok) throw new Error(readableError(snapshotResponse.status, 'load'))
      const snapshotResult = await snapshotResponse.json() as { snapshot: Snapshot }
      if (!stillCurrent(version)) return
      latestSnapshot = snapshotResult.snapshot
    }
    selectedMaterial.value = result.material
    snapshots.value = result.snapshots
    selectedSnapshot.value = latestSnapshot
    detailState.value = 'ready'
    editorText.value = localText
    editing.value = true
    refreshAvailable.value = false
    editorMessage.value = 'Завантажено актуальну версію. Ваш текст залишився у полі редагування.'
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    editorText.value = localText
    editing.value = true
    refreshAvailable.value = true
    editorMessage.value = `Не вдалося завантажити актуальну версію. Ваш текст залишився у полі редагування. ${error instanceof Error ? error.message : readableError(0, 'load')}`
  } finally {
    busy.value = false
  }
}

async function downloadOriginal(snapshot: Snapshot) {
  if (!snapshot.originalAssetId || busy.value || editing.value) return
  const { signal, version } = startRequest()
  errorMessage.value = ''
  try {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(props.projectId)}/assets/${encodeURIComponent(snapshot.originalAssetId)}/download`, { credentials: 'same-origin', signal })
    if (!stillCurrent(version)) return
    if (handleUnauthorized(response)) return
    if (!response.ok) throw new Error(readableError(response.status, 'load'))
    const blob = await response.blob()
    if (!stillCurrent(version)) return
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = snapshot.originalFilename || 'original-source'
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  } catch (error) {
    if (!stillCurrent(version) || (error instanceof DOMException && error.name === 'AbortError')) return
    errorMessage.value = error instanceof Error ? error.message : 'Не вдалося завантажити оригінал.'
  }
}

onMounted(() => void loadMaterials())
onBeforeUnmount(() => {
  controller?.abort()
  epoch += 1
})
</script>

<template>
  <div class="sources-workspace">
    <div class="sources-heading">
      <div>
        <p class="eyebrow">
          {{ projectTitle }}
        </p>
        <h2>Джерела</h2>
        <p class="sources-lead">
          Додавайте тексти, які допоможуть підготувати матеріали проєкту.
        </p>
      </div>
    </div>

    <Alert
      v-if="errorMessage"
      variant="destructive"
      class="source-alert"
      role="alert"
    >
      <AlertTitle>Не вдалося виконати дію</AlertTitle>
      <AlertDescription>{{ errorMessage }}</AlertDescription>
      <a
        v-if="externalNoticeRequired"
        class="source-notice-link"
        href="#external-processing-notice"
      >
        Переглянути повідомлення й надати потрібну згоду
      </a>
    </Alert>

    <section
      class="source-add"
      aria-labelledby="source-add-title"
    >
      <div class="source-section-heading">
        <div>
          <p class="eyebrow">
            Нове джерело
          </p>
          <h3 id="source-add-title">
            Додати матеріал
          </h3>
        </div>
        <div
          class="source-mode"
          role="group"
          aria-label="Тип нового матеріалу"
        >
          <button
            type="button"
            :aria-pressed="mode === 'text'"
            :disabled="busy"
            @click="mode = 'text'"
          >
            Текст
          </button>
          <button
            type="button"
            :aria-pressed="mode === 'upload'"
            :disabled="busy"
            @click="mode = 'upload'"
          >
            TXT / Markdown
          </button>
        </div>
      </div>

      <form
        class="source-form"
        @submit.prevent="addMaterial"
      >
        <div class="source-form-row">
          <Field class="source-field">
            <FieldLabel for="source-label">
              Назва
            </FieldLabel>
            <input
              id="source-label"
              v-model="label"
              class="source-input"
              maxlength="200"
              required
              placeholder="Наприклад, Інтерв’ю з редакторкою"
              :disabled="busy || archived"
            >
            <FieldDescription>Коротко назвіть цей матеріал.</FieldDescription>
          </Field>
          <Field class="source-field">
            <FieldLabel for="source-purpose">
              Призначення
            </FieldLabel>
            <select
              id="source-purpose"
              v-model="purpose"
              class="source-input"
              :disabled="busy || archived"
            >
              <option
                v-for="option in purposes"
                :key="option.id"
                :value="option.id"
              >
                {{ option.label }}
              </option>
            </select>
            <FieldDescription>Це допомагає використовувати матеріал у правильному контексті.</FieldDescription>
          </Field>
        </div>

        <Field
          v-if="mode === 'text'"
          class="source-field"
        >
          <FieldLabel for="source-text">
            Текст джерела
          </FieldLabel>
          <Textarea
            id="source-text"
            v-model="text"
            class="source-input source-textarea"
            rows="7"
            :maxlength="TEXT_LIMIT"
            required
            placeholder="Вставте або введіть текст…"
            :disabled="busy || archived"
          />
          <FieldDescription>{{ textCount.toLocaleString('uk-UA') }} / {{ TEXT_LIMIT.toLocaleString('uk-UA') }} символів · зберігається як окрема версія.</FieldDescription>
        </Field>
        <Field
          v-else
          class="source-field"
        >
          <FieldLabel for="source-file">
            Файл TXT або Markdown
          </FieldLabel>
          <input
            id="source-file"
            class="source-file"
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            :disabled="busy || archived"
          >
          <FieldDescription>UTF-8, до 1 МБ. Оригінал зберігається для завантаження.</FieldDescription>
        </Field>

        <div class="source-form-actions">
          <Button
            class="source-button source-button-primary"
            type="submit"
            :disabled="!canAdd || archived"
          >
            {{ busy ? 'Зберігаємо…' : 'Додати джерело' }}
          </Button>
        </div>
      </form>
    </section>

    <div class="sources-columns">
      <section
        class="source-list"
        aria-labelledby="source-list-title"
      >
        <div class="source-section-heading">
          <div>
            <p class="eyebrow">
              У цьому проєкті
            </p>
            <h3 id="source-list-title">
              Збережені джерела
            </h3>
          </div>
          <span
            v-if="listState === 'ready'"
            class="source-count"
          >{{ materials.length }}</span>
        </div>
        <p
          v-if="listState === 'loading'"
          class="source-state"
          role="status"
        >
          Завантажуємо джерела…
        </p>
        <div
          v-else-if="listState === 'error'"
          class="source-state"
        >
          Список джерел недоступний.
          <Button
            class="source-button"
            variant="outline"
            :disabled="busy || editing"
            @click="reloadSources"
          >
            Оновити список джерел
          </Button>
        </div>
        <p
          v-else-if="materials.length === 0"
          class="source-state"
        >
          Джерел поки немає. Додайте текст або файл вище.
        </p>
        <ul
          v-else
          class="source-items"
        >
          <li
            v-for="material in materials"
            :key="material.id"
            :class="{ 'source-item-selected': selectedMaterial?.id === material.id }"
          >
            <button
              class="source-item-open"
              type="button"
              :disabled="busy || editing"
              :aria-current="selectedMaterial?.id === material.id ? 'true' : undefined"
              @click="loadMaterial(material.id)"
            >
              <span class="source-item-title">{{ material.label }}</span>
              <span class="source-item-meta">{{ purposeLabel(material.purpose) }}</span>
            </button>
            <button
              class="source-include"
              type="button"
              :disabled="archived || busy || detailState === 'loading' || includeBusyId === material.id || (editing && selectedMaterial?.id === material.id)"
              :aria-pressed="material.included"
              :aria-label="`${material.included ? 'Виключити' : 'Включити'} ${material.label}`"
              @click="toggleIncluded(material)"
            >
              <span aria-hidden="true">{{ material.included ? '✓' : '＋' }}</span>
              {{ material.included ? 'Ураховується' : 'Виключено' }}
            </button>
          </li>
        </ul>
      </section>

      <section
        class="source-reader"
        aria-labelledby="source-reader-title"
      >
        <template v-if="selectedMaterial">
          <div class="source-reader-heading">
            <div class="source-reader-title-wrap">
              <p class="eyebrow">
                {{ purposeLabel(selectedMaterial.purpose) }}
              </p>
              <h3 id="source-reader-title">
                {{ selectedMaterial.label }}
              </h3>
            </div>
            <Button
              v-if="!editing && !archived"
              class="source-button"
              variant="outline"
              :disabled="busy || detailState !== 'ready' || !selectedSnapshot || selectedSnapshot.id !== selectedMaterial.currentSnapshotId"
              @click="beginEdit"
            >
              Редагувати текст
            </Button>
          </div>

          <p
            v-if="detailState === 'loading'"
            class="source-state"
            role="status"
          >
            Відкриваємо збережений текст…
          </p>
          <div
            v-else-if="detailState === 'error'"
            class="source-state"
            role="alert"
          >
            {{ errorMessage }}
          </div>
          <form
            v-else-if="editing"
            class="source-editor"
            @submit.prevent="saveSnapshot"
          >
            <Field class="source-field">
              <FieldLabel for="source-edit-text">
                Нова версія тексту
              </FieldLabel>
              <Textarea
                id="source-edit-text"
                v-model="editorText"
                class="source-input source-textarea"
                rows="12"
                :maxlength="TEXT_LIMIT"
                :disabled="busy"
              />
              <FieldDescription>{{ editorCount.toLocaleString('uk-UA') }} / {{ TEXT_LIMIT.toLocaleString('uk-UA') }} символів. Попередній текст залишиться в історії.</FieldDescription>
            </Field>
            <p
              v-if="editorMessage"
              class="source-inline-error"
              role="alert"
            >
              {{ editorMessage }}
            </p>
            <Button
              v-if="refreshAvailable"
              class="source-button"
              type="button"
              variant="outline"
              :disabled="busy"
              @click="refreshLatestAndKeepDraft"
            >
              Завантажити актуальну версію
            </Button>
            <div class="source-form-actions">
              <Button
                class="source-button source-button-primary"
                type="submit"
                :disabled="busy"
              >
                {{ busy ? 'Зберігаємо…' : 'Зберегти нову версію' }}
              </Button>
              <Button
                class="source-button"
                type="button"
                variant="ghost"
                :disabled="busy"
                @click="editing = false; editorMessage = ''"
              >
                Скасувати
              </Button>
            </div>
          </form>
          <div
            v-else-if="selectedSnapshot"
            class="source-reading"
          >
            <div class="source-reading-toolbar">
              <span>Версія {{ selectedSnapshot.sequence }}<span v-if="selectedSnapshot.id === selectedMaterial.currentSnapshotId"> · Поточна</span></span>
              <Button
                v-if="selectedSnapshot.originalAssetId"
                class="source-button source-download"
                variant="ghost"
                :disabled="busy || editing"
                @click="downloadOriginal(selectedSnapshot)"
              >
                Завантажити оригінал
              </Button>
            </div>
            <pre class="source-plain-text">{{ selectedSnapshot.normalizedText }}</pre>
            <details class="source-history">
              <summary>Історія версій <span>({{ snapshots.length }})</span></summary>
              <ol>
                <li
                  v-for="snapshot in snapshots"
                  :key="snapshot.id"
                >
                  <button
                    type="button"
                    :disabled="busy || editing"
                    :aria-current="snapshot.id === selectedSnapshot.id ? 'true' : undefined"
                    @click="loadSnapshot(snapshot.id)"
                  >
                    <span>Версія {{ snapshot.sequence }}{{ snapshot.id === selectedMaterial.currentSnapshotId ? ' · Поточна' : '' }}</span>
                    <span class="source-history-date">{{ dateLabel(snapshot.createdAt) }}</span>
                  </button>
                </li>
              </ol>
            </details>
            <details class="source-metadata">
              <summary>Деталі джерела</summary>
              <dl>
                <dt>Тип</dt><dd>{{ selectedMaterial.kind === 'TEXT' ? 'Введений текст' : selectedMaterial.kind === 'FILE' ? 'Файл' : 'Посилання' }}</dd>
                <dt>Додано</dt><dd>{{ dateLabel(selectedMaterial.createdAt) }}</dd>
                <dt>Версію створено</dt><dd>{{ dateLabel(selectedSnapshot.createdAt) }}</dd>
                <dt>Походження</dt><dd>{{ originLabel(selectedSnapshot.origin) }}</dd>
                <dt>Автор версії</dt><dd>{{ selectedSnapshot.createdBy || 'Не вказано' }}</dd>
                <dt>Фрагментів</dt><dd>{{ selectedSnapshot.fragments.length }}</dd>
              </dl>
              <details
                v-if="selectedSnapshot.fragments.length"
                class="source-fragments"
              >
                <summary>Переглянути фрагменти</summary>
                <p
                  v-if="selectedSnapshot.fragments.length > 1000"
                  class="source-fragment-limit"
                >
                  Показано перші 1 000 фрагментів.
                </p>
                <ol>
                  <li
                    v-for="fragment in selectedSnapshot.fragments.slice(0, 1000)"
                    :key="fragment.id"
                  >
                    <p>{{ selectedSnapshot.normalizedText.slice(fragment.startOffset, fragment.endOffset) }}</p>
                    <span>Фрагмент {{ fragment.ordinal }}</span>
                    <details class="source-fragment-locator">
                      <summary>Деталі фрагмента</summary>
                      <dl>
                        <dt>Діапазон</dt><dd>{{ fragment.startOffset }}–{{ fragment.endOffset }}</dd>
                        <dt>SHA-256</dt><dd>{{ fragment.sha256 }}</dd>
                      </dl>
                    </details>
                  </li>
                </ol>
              </details>
            </details>
          </div>
          <p
            v-else
            class="source-state"
          >
            У цього джерела ще немає збереженого тексту.
          </p>
        </template>
        <div
          v-else
          class="source-reader-empty"
        >
          <p class="eyebrow">
            Перегляд
          </p>
          <h3 id="source-reader-title">
            Оберіть джерело
          </h3>
          <p>Збережений текст і його історія з’являться тут.</p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.sources-workspace { color: var(--ink); }
.sources-heading { margin-bottom: 30px; }
.sources-heading h2 { margin: 0; font-family: var(--serif); font-size: 31px; font-weight: 500; line-height: 1.2; }
.sources-lead { max-width: 640px; margin: 9px 0 0; color: var(--muted); font-size: 14px; line-height: 1.6; }
.source-add { padding: 22px 0 25px; border-block: 1px solid var(--rule); }
.source-section-heading, .source-reader-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.source-section-heading { margin-bottom: 20px; }
.source-section-heading h3, .source-reader-heading h3, .source-reader-empty h3 { margin: 0; font-family: var(--serif); font-size: 22px; font-weight: 500; line-height: 1.28; overflow-wrap: anywhere; }
.source-section-heading .eyebrow, .source-reader-heading .eyebrow, .source-reader-empty .eyebrow { margin: 0 0 5px; }
.source-mode { display: flex; flex-wrap: wrap; gap: 3px; padding: 3px; border: 1px solid var(--rule); }
.source-mode button { min-height: 34px; padding: 6px 10px; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 12px; cursor: pointer; }
.source-mode button[aria-pressed="true"] { background: color-mix(in srgb, var(--document) 75%, var(--ink)); color: var(--ink); }
.source-form { display: grid; gap: 18px; }
.source-form-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, .65fr); gap: 18px; }
.source-field { display: grid; gap: 7px; }
.source-field :deep([data-slot="field-label"]) { color: var(--ink); font-size: 13px; font-weight: 600; }
.source-field :deep([data-slot="field-description"]) { color: var(--muted); font-size: 11px; line-height: 1.5; }
.source-input { width: 100%; min-height: 42px; padding: 10px 12px; border: 1px solid var(--rule); border-radius: 2px; background: var(--document); color: var(--ink); font: inherit; font-size: 13px; }
.source-input:focus-visible, .source-file:focus-visible, .source-mode button:focus-visible, .source-item-open:focus-visible, .source-include:focus-visible, .source-history button:focus-visible { outline: 2px solid var(--copper); outline-offset: 2px; }
.source-textarea { min-height: 155px; resize: vertical; line-height: 1.6; }
.source-file { width: 100%; padding: 12px; border: 1px dashed var(--rule); background: var(--document); color: var(--ink); font: inherit; font-size: 12px; }
.source-form-actions { display: flex; flex-wrap: wrap; gap: 9px; }
.source-button { min-height: 38px; border-radius: 2px; font-size: 12px; }
.source-button-primary { background: var(--copper); color: var(--document); }
.sources-columns { display: grid; grid-template-columns: minmax(250px, .75fr) minmax(0, 1.55fr); gap: 38px; padding-top: 28px; }
.source-list, .source-reader { min-width: 0; }
.source-count { min-width: 28px; padding: 3px 8px; color: var(--muted); font-size: 12px; text-align: center; }
.source-items { margin: 0; padding: 0; list-style: none; }
.source-items li { display: grid; gap: 7px; padding: 13px 0; border-top: 1px solid var(--rule); }
.source-item-selected { border-left: 2px solid var(--copper); padding-left: 11px !important; }
.source-item-open { display: grid; gap: 4px; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.source-item-title { font-family: var(--serif); font-size: 17px; line-height: 1.3; overflow-wrap: anywhere; }
.source-item-meta { color: var(--muted); font-size: 11px; }
.source-include { justify-self: start; display: inline-flex; align-items: center; gap: 6px; padding: 4px 0; border: 0; background: transparent; color: var(--muted); font: inherit; font-size: 11px; cursor: pointer; }
.source-include[aria-pressed="true"] { color: var(--evidence, var(--copper)); }
.source-reader { min-height: 300px; padding-left: 30px; border-left: 1px solid var(--rule); }
.source-reader-heading { align-items: center; margin-bottom: 16px; }
.source-reader-title-wrap { min-width: 0; }
.source-reader .source-state { margin-top: 15px; }
.source-state { color: var(--muted); font-size: 13px; line-height: 1.6; }
.source-reader-empty { padding: 8px 0; }
.source-reader-empty p:last-child { color: var(--muted); font-size: 13px; line-height: 1.6; }
.source-reading-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; color: var(--muted); font-size: 11px; }
.source-download { min-height: 32px; }
.source-plain-text { max-height: 60vh; overflow: auto; margin: 0; padding: 18px; border: 1px solid var(--rule); background: var(--document); color: var(--ink); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--serif); font-size: 15px; line-height: 1.7; }
.source-history, .source-metadata { margin-top: 16px; border-top: 1px solid var(--rule); }
.source-history summary, .source-metadata summary { padding: 11px 0; color: var(--ink); font-size: 12px; font-weight: 600; cursor: pointer; }
.source-history summary span { color: var(--muted); font-weight: 400; }
.source-history ol { margin: 0; padding: 0 0 8px; list-style: none; }
.source-history li { border-top: 1px solid color-mix(in srgb, var(--rule), transparent 35%); }
.source-history button { display: flex; justify-content: space-between; gap: 10px; width: 100%; padding: 9px 0; border: 0; background: transparent; color: var(--ink); font: inherit; font-size: 11px; text-align: left; cursor: pointer; }
.source-history button[aria-current="true"] { color: var(--copper); font-weight: 600; }
.source-history-date { color: var(--muted); }
.source-metadata dl { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 8px 14px; margin: 0; padding: 0 0 13px; font-size: 11px; }
.source-metadata dt { color: var(--muted); }
.source-metadata dd { margin: 0; overflow-wrap: anywhere; }
.source-fragments { padding: 0 0 12px; }
.source-fragments > summary { padding: 9px 0; color: var(--ink); font-size: 11px; font-weight: 600; cursor: pointer; }
.source-fragments ol { margin: 0; padding-left: 22px; }
.source-fragments li { padding: 10px 0; border-top: 1px solid var(--rule); }
.source-fragments li > p { margin: 0 0 5px; color: var(--ink); font-family: var(--serif); font-size: 13px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.source-fragments li > span { color: var(--muted); font-size: 10px; }
.source-fragment-locator { margin-top: 5px; }
.source-fragment-locator > summary { color: var(--muted); font-size: 10px; cursor: pointer; }
.source-fragment-locator dl { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 5px 9px; margin: 7px 0; font-size: 10px; }
.source-fragment-locator dt { color: var(--muted); }
.source-fragment-locator dd { margin: 0; overflow-wrap: anywhere; }
.source-fragment-limit { margin: 0; color: var(--muted); font-size: 10px; }
.source-inline-error { color: var(--error); font-size: 12px; line-height: 1.5; }
.source-alert { margin: 0 0 18px; }
.source-notice-link { display: inline-block; margin-top: 10px; color: var(--copper); font-size: 12px; text-underline-offset: 3px; }
@media (max-width: 760px) {
  .sources-columns { grid-template-columns: minmax(0, 1fr); gap: 27px; }
  .source-reader { min-height: unset; padding: 24px 0 0; border-top: 1px solid var(--rule); border-left: 0; }
}
@media (max-width: 520px) {
  .sources-heading h2 { font-size: 28px; }
  .source-section-heading { align-items: flex-start; flex-direction: column; }
  .source-mode { width: 100%; }
  .source-mode button { flex: 1; }
  .source-form-row { grid-template-columns: minmax(0, 1fr); }
  .source-reader-heading { align-items: flex-start; flex-direction: column; }
  .source-reader-heading .source-button { width: 100%; }
  .source-metadata dl { grid-template-columns: 105px minmax(0, 1fr); }
}
</style>
