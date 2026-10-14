<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'

type ScriptFormat = 'LINKEDIN_CAROUSEL' | 'INSTAGRAM_CAROUSEL' | 'INSTAGRAM_STORIES'
interface Mapping { startOffset: number; endOffset: number; quote: string; claimRevisionId: string; evidenceId: string }
interface Frame { id: string; purpose: string; text: string; visualHint: string; transition: string; mappings: Mapping[] }
interface ScriptRevision { id: string; number: number; status?: 'PROPOSED' | 'APPROVED' | 'WITHDRAWN'; approvedAt?: string | null; withdrawnAt?: string | null; content: { frames: Frame[] }; parentAdaptationRevisionId: string; reviewCounter: number; staleReasons?: string[]; blockingReasons?: string[]; eligible?: boolean; hasUnmapped?: boolean }
interface AdaptationRevision { id: string; number: number; approvedAt: string | null; withdrawnAt: string | null }
interface State {
  format: ScriptFormat
  formatSelected: boolean
  adaptation: { id: string; revision: number; currentApprovedRevisionId: string | null; revisions: AdaptationRevision[] } | null
  script: { id: string; revision: number; currentApprovedRevisionId: string | null; draft: { counter: number; parentAdaptationRevisionId: string; parentAdaptationRevisionHash: string; content: { frames: Frame[] }; baseRevisionId: string | null } | null; revisions: ScriptRevision[] } | null
  parent: { id: string; sha256: string; eligible: boolean; staleReasons: string[]; blockingReasons: string[] } | null
}
interface LanguageSuggestion { id: string; frameId: string; startOffset: number; endOffset: number; originalText: string; replacementText: string; finding: string; status: 'OPEN' | 'ACCEPTED' | 'REJECTED'; contentHash: string }
interface Recovery { format: ScriptFormat; parentId: string; frames: Frame[]; expectedRevision: number; expectedDraftCounter: number }
const props = defineProps<{ projectId: string; csrfToken: string; userId: string; format: ScriptFormat; archived?: boolean }>()
const emit = defineEmits<{ 'session-expired': [] }>()
const state = ref<State | null>(null)
const frames = ref<Frame[]>([])
const parentId = ref('')
const baseline = ref('')
const expectedRevision = ref(0)
const expectedDraftCounter = ref(0)
const loading = ref(true)
const saving = ref(false)
const busy = ref(false)
const conflict = ref(false)
const error = ref('')
const recovered = ref(false)
const selectedFrame = ref(0)
const selectedApplyFrames = ref<Record<string, string[]>>({})
const reviewAcknowledgements = ref<Record<string, boolean>>({})
const languageSuggestions = ref<LanguageSuggestion[]>([])
const selectedLanguageIds = ref<string[]>([])
const languageBusy = ref(false)
const languageMessage = ref('')
const recoveryKey = computed(() => `cf:script:${props.userId}:${props.projectId}:${props.format}`)
const formatLabel = computed(() => props.format === 'INSTAGRAM_STORIES' ? 'Сценарій історій Instagram' : props.format === 'LINKEDIN_CAROUSEL' ? 'Сценарій каруселі LinkedIn' : 'Сценарій каруселі Instagram')
const approvedParents = computed(() => {
  const current = state.value?.adaptation?.currentApprovedRevisionId
  return state.value?.parent?.eligible ? state.value.adaptation?.revisions.filter(row => row.id === current && !!row.approvedAt && !row.withdrawnAt) ?? [] : []
})
const readonly = computed(() => props.archived || state.value?.formatSelected === false)
const dirty = computed(() => baseline.value !== serialize())
const activeRevision = computed(() => state.value?.script?.revisions.find(row => row.id === state.value?.script?.currentApprovedRevisionId) ?? null)
const completeFrames = computed(() => frames.value.length > 0 && frames.value.every(frame => frame.purpose.trim() && frame.text.trim() && (props.format !== 'INSTAGRAM_STORIES' || frame.transition?.trim())))
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let hydration = false
let controller = new AbortController()
let formatEpoch = 0
let inFlight: Promise<boolean> | null = null

function serialize() { return JSON.stringify({ parentAdaptationRevisionId: parentId.value, content: { frames: frames.value } }) }
function copyFrames(value: Frame[]): Frame[] { return JSON.parse(JSON.stringify(value)) as Frame[] }
function keepRecovery() {
  if (!dirty.value || hydration || disposed) return
  try { sessionStorage.setItem(recoveryKey.value, JSON.stringify({ format: props.format, parentId: parentId.value, frames: frames.value, expectedRevision: expectedRevision.value, expectedDraftCounter: expectedDraftCounter.value } satisfies Recovery)) } catch { /* Current editor contents remain available. */ }
}
function changed() {
  if (hydration || disposed) return
  keepRecovery()
  clearTimeout(timer)
  if (!conflict.value && !recovered.value) timer = setTimeout(() => void save(), 700)
}
function populate(next: State) {
  hydration = true
  state.value = next
  const draft = next.script?.draft
  frames.value = structuredClone(draft?.content.frames ?? [])
  parentId.value = draft?.parentAdaptationRevisionId ?? ''
  expectedRevision.value = next.script?.revision ?? 0
  expectedDraftCounter.value = draft?.counter ?? 0
  selectedFrame.value = Math.min(selectedFrame.value, Math.max(0, frames.value.length - 1))
  baseline.value = serialize()
  hydration = false
}
function frameTitle(frame: Frame, index: number) { return frame.purpose.trim() || `Кадр ${index + 1}` }
function toggleApplyFrame(revisionId: string, frameId: string, checked: boolean) {
  const current = selectedApplyFrames.value[revisionId] ?? []
  selectedApplyFrames.value[revisionId] = checked ? [...new Set([...current, frameId])] : current.filter(id => id !== frameId)
}
function blankFrame(): Frame { return { id: crypto.randomUUID(), purpose: '', text: '', visualHint: '', transition: '', mappings: [] } }
function revisionStatus(revision: ScriptRevision) { return revision.status ?? (revision.withdrawnAt ? 'WITHDRAWN' : revision.approvedAt ? 'APPROVED' : 'PROPOSED') }
function addFrame() { frames.value.push(blankFrame()); selectedFrame.value = frames.value.length - 1; changed() }
function removeFrame(index: number) {
  if (frames.value.length <= 1) return
  frames.value.splice(index, 1)
  selectedFrame.value = Math.min(selectedFrame.value, frames.value.length - 1)
  changed()
}
function moveFrame(index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= frames.value.length) return
  const moved = frames.value.splice(index, 1)[0]!
  frames.value.splice(target, 0, moved)
  selectedFrame.value = target
  changed()
}
function onOutlineKeydown(event: KeyboardEvent, index: number) {
  if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); moveFrame(index, -1) }
  else if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); moveFrame(index, 1) }
  else if (event.key === 'ArrowDown' && index < frames.value.length - 1) { event.preventDefault(); selectedFrame.value = index + 1; (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[data-frame]')[index + 1]?.focus() }
  else if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); selectedFrame.value = index - 1; (event.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[data-frame]')[index - 1]?.focus() }
}
function editFrameText(frame: Frame, value: string) {
  const old = frame.text
  let prefix = 0
  while (prefix < old.length && prefix < value.length && old[prefix] === value[prefix]) prefix++
  let suffix = 0
  while (suffix < old.length - prefix && suffix < value.length - prefix && old[old.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++
  const oldChangedEnd = old.length - suffix
  const delta = value.length - old.length
  frame.text = value
  frame.mappings = frame.mappings.flatMap(mapping => {
    if (mapping.endOffset <= prefix) return value.slice(mapping.startOffset, mapping.endOffset) === mapping.quote ? [mapping] : []
    if (mapping.startOffset >= oldChangedEnd) {
      const shifted = { ...mapping, startOffset: mapping.startOffset + delta, endOffset: mapping.endOffset + delta }
      return value.slice(shifted.startOffset, shifted.endOffset) === shifted.quote ? [shifted] : []
    }
    return []
  })
  changed()
}
async function request(path = '', body?: unknown) {
  const requestEpoch = formatEpoch
  const url = `/api/v1/projects/${encodeURIComponent(props.projectId)}/scripts${path}?format=${encodeURIComponent(props.format)}`
  const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(body) }) })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) {
    if (response.status === 409 && requestEpoch === formatEpoch) conflict.value = true
    throw new Error(response.status === 409 ? 'Зміни сценарію або батьківської публікації конфліктують. Ваш текст збережено в цьому вікні.' : response.status === 503 ? 'Сценарій тимчасово недоступний. Збережений текст залишився в редакторі.' : 'Не вдалося виконати дію. Ваш текст залишився в редакторі; повторіть спробу.')
  }
  return response.json()
}
async function load() {
  const requestedEpoch = formatEpoch
  try {
    const next = await request() as State
    if (disposed || requestedEpoch !== formatEpoch) return
    populate(next)
    const raw = sessionStorage.getItem(recoveryKey.value)
    if (raw) {
      try {
        const local = JSON.parse(raw) as Recovery
        if (local.format === props.format && JSON.stringify({ parentAdaptationRevisionId: local.parentId, content: { frames: local.frames } }) !== baseline.value) {
          parentId.value = local.parentId
          frames.value = structuredClone(local.frames)
          expectedRevision.value = local.expectedRevision
          expectedDraftCounter.value = local.expectedDraftCounter
          recovered.value = true
        }
      } catch { error.value = 'Не вдалося прочитати локальний сценарій відновлення; збережений сценарій із сервера доступний нижче.' }
    }
  } catch (cause) { if (!disposed && requestedEpoch === formatEpoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити сценарій.' }
  finally { if (requestedEpoch === formatEpoch) loading.value = false }
}
async function reconcile(useLocal: boolean) {
  const localFrames = copyFrames(frames.value), localParent = parentId.value
  try {
    const fresh = await request() as State
    if (!useLocal) {
      populate(fresh); conflict.value = false; recovered.value = false; error.value = ''; sessionStorage.removeItem(recoveryKey.value)
      return
    }
    populate(fresh)
    frames.value = localFrames
    parentId.value = localParent
    conflict.value = false
    recovered.value = false
    if (serialize() === baseline.value) { sessionStorage.removeItem(recoveryKey.value); return }
    keepRecovery()
    await save()
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити сценарій.' }
}
async function save(): Promise<boolean> {
  clearTimeout(timer)
  if (inFlight) { const ok = await inFlight; return ok && dirty.value ? save() : ok }
  if (!dirty.value) return true
  if (readonly.value || conflict.value || recovered.value || !parentId.value || !completeFrames.value) return false
  const snapshot = serialize(), submittedFrames = copyFrames(frames.value), submittedParent = parentId.value
  const submittedRevision = expectedRevision.value, submittedCounter = expectedDraftCounter.value, saveEpoch = formatEpoch
  saving.value = true; error.value = ''
  inFlight = (async () => {
    try {
      const next = await request('/draft', { expectedRevision: submittedRevision, expectedDraftCounter: submittedCounter, parentAdaptationRevisionId: submittedParent, content: { frames: submittedFrames } }) as State
      if (disposed || saveEpoch !== formatEpoch) return false
      state.value = next
      expectedRevision.value = next.script?.revision ?? submittedRevision
      expectedDraftCounter.value = next.script?.draft?.counter ?? submittedCounter
      baseline.value = snapshot
      if (!dirty.value) sessionStorage.removeItem(recoveryKey.value); else keepRecovery()
      return true
    } catch (cause) { if (!disposed && saveEpoch === formatEpoch) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти сценарій.'; return false }
    finally { saving.value = false; inFlight = null }
  })()
  const ok = await inFlight
  return ok && dirty.value && !disposed ? save() : ok
}
async function command(path: string, extra: Record<string, unknown> = {}, saveFirst = true) {
  if (busy.value || readonly.value || (saveFirst && !await save())) return
  if (!parentId.value && path === '/checkpoint') { error.value = 'Спершу виберіть погоджену версію підпису.'; return }
  busy.value = true; error.value = ''
  try {
    const next = await request(path, { expectedRevision: expectedRevision.value, ...(path === '/checkpoint' ? { expectedDraftCounter: expectedDraftCounter.value } : {}), ...extra }) as State
    if (disposed) return
    populate(next)
    if (!dirty.value) sessionStorage.removeItem(recoveryKey.value)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося виконати дію.' }
  finally { busy.value = false }
}
async function reviewLanguage() {
  if (languageBusy.value || dirty.value || recovered.value || !state.value?.script?.draft?.baseRevisionId || !state.value.script) return
  languageBusy.value = true; languageMessage.value = ''; selectedLanguageIds.value = []
  try {
    const result = await request('/language-suggestions/review', { sourceRevisionId: state.value.script.draft.baseRevisionId, expectedRevision: state.value.script.revision }) as { sourceRevisionId: string; expectedRevision: number; suggestions: LanguageSuggestion[] }
    languageSuggestions.value = result.suggestions
    languageMessage.value = result.suggestions.length ? `Знайдено пропозицій: ${result.suggestions.length}. Виберіть лише ті, які потрібно застосувати.` : 'Мовних пропозицій немає.'
  } catch (cause) { languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося перевірити текст.' }
  finally { languageBusy.value = false }
}
async function acceptLanguage() {
  if (languageBusy.value || dirty.value || !selectedLanguageIds.value.length || !state.value?.script?.draft?.baseRevisionId || !state.value.script) return
  languageBusy.value = true; languageMessage.value = ''
  try {
    await request('/language-suggestions/accept', { sourceRevisionId: state.value.script.draft.baseRevisionId, expectedRevision: state.value.script.revision, suggestionIds: selectedLanguageIds.value })
    const fresh = await request() as State
    populate(fresh); languageSuggestions.value = []; selectedLanguageIds.value = []; languageMessage.value = 'Вибрані зміни застосовано до чернетки. Створіть нову версію сценарію для повторного мовного перегляду.'
  } catch (cause) { languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося застосувати пропозиції.' }
  finally { languageBusy.value = false }
}
async function rejectLanguage(item: LanguageSuggestion) {
  if (languageBusy.value || dirty.value || !state.value?.script) return
  languageBusy.value = true; languageMessage.value = ''
  try {
    await request(`/language-suggestions/${item.id}/reject`, { expectedRevision: state.value.script.revision })
    languageSuggestions.value = languageSuggestions.value.map(row => row.id === item.id ? { ...row, status: 'REJECTED' } : row)
    const fresh = await request() as State
    state.value = fresh
    expectedRevision.value = fresh.script?.revision ?? expectedRevision.value
  } catch (cause) { languageMessage.value = cause instanceof Error ? cause.message : 'Не вдалося відхилити пропозицію.' }
  finally { languageBusy.value = false }
}
function recoverLocal() {
  recovered.value = false
  baseline.value = JSON.stringify({ parentAdaptationRevisionId: '', content: { frames: [] } })
  changed()
}
function discardRecovery() { sessionStorage.removeItem(recoveryKey.value); recovered.value = false; void load() }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || recovered.value) { event.preventDefault(); event.returnValue = '' } }
watch(() => [props.projectId, props.format] as const, () => {
  formatEpoch++; controller.abort(); controller = new AbortController(); clearTimeout(timer)
  state.value = null; frames.value = []; parentId.value = ''; baseline.value = ''; conflict.value = false; recovered.value = false; error.value = ''; loading.value = true
  void load()
})
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); void load() })
onBeforeUnmount(() => { keepRecovery(); disposed = true; clearTimeout(timer); controller.abort(); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <section
    class="script-workspace"
    aria-labelledby="script-title"
  >
    <header class="script-heading">
      <div>
        <h2 id="script-title">
          {{ formatLabel }}
        </h2>
        <p>Погоджений сценарій можна передати дизайнеру в JSON, Markdown або ZIP. Готові зображення з’являться пізніше.</p>
      </div>
      <p
        class="script-save-state"
        role="status"
        aria-live="polite"
      >
        {{ saving ? 'Зберігаємо…' : conflict ? 'Потрібно узгодити зміни' : dirty || recovered ? 'Є незбережені зміни' : 'Збережено' }}
      </p>
    </header>

    <p
      v-if="loading"
      class="script-status"
      role="status"
    >
      Завантажуємо сценарій…
    </p>
    <template v-else>
      <div
        v-if="!state"
        class="script-status"
        role="alert"
      >
        <p>{{ error || 'Не вдалося завантажити сценарій.' }}</p>
        <Button
          variant="outline"
          @click="loading = true; error = ''; void load()"
        >
          Спробувати ще раз
        </Button>
      </div>
      <template v-else>
        <p
          v-if="!state?.formatSelected || readonly"
          class="script-status"
        >
          Цей формат не входить до активного проєкту або проєкт архівовано. Перегляд доступний, редагування вимкнене.
        </p>
        <div
          v-if="recovered"
          class="script-recovery"
          role="alert"
        >
          <p>Знайдено локальний незбережений сценарій. Його текст залишився в цьому браузері.</p>
          <Button
            variant="outline"
            @click="recoverLocal"
          >
            Відновити текст
          </Button>
          <Button
            variant="ghost"
            @click="discardRecovery"
          >
            Відкинути локальну копію
          </Button>
        </div>
        <p
          v-if="error"
          class="script-error"
          role="alert"
        >
          {{ error }}
        </p>
        <div
          v-if="conflict"
          class="script-recovery"
          role="alert"
        >
          <p>На сервері з’явилася новіша версія. Ваш текст залишився в редакторі.</p>
          <Button
            variant="outline"
            :disabled="busy || saving"
            @click="reconcile(true)"
          >
            Спробувати зберегти мій текст
          </Button>
          <Button
            variant="ghost"
            :disabled="busy || saving"
            @click="reconcile(false)"
          >
            Завантажити серверну версію
          </Button>
        </div>
        <p
          v-if="state?.parent && (!state.parent.eligible || state.parent.staleReasons.length || state.parent.blockingReasons.length)"
          class="script-review-note"
          role="status"
        >
          Батьківська публікація змінилася або потребує перегляду. Сценарій залишився доступним для редагування; перед погодженням перевірте її актуальність.
        </p>

        <div class="script-controls">
          <label class="script-parent">
            <span>Підпис, для якого створено сценарій</span>
            <select
              v-model="parentId"
              :disabled="readonly || busy || saving || recovered"
              @change="changed"
            >
              <option value="">Виберіть погоджену версію</option>
              <option
                v-for="revision in approvedParents"
                :key="revision.id"
                :value="revision.id"
              >Версія {{ revision.number }} · погоджена</option>
            </select>
          </label>
          <p
            v-if="!approvedParents.length"
            class="script-help"
          >
            Спершу створіть і погодьте підпис у редакторі каналу. Сценарій матиме посилання саме на вибрану версію.
          </p>
        </div>

        <div
          class="script-editor"
          :class="{ 'is-readonly': readonly }"
        >
          <nav
            class="script-outline"
            aria-label="Порядок кадрів"
          >
            <div class="script-outline-heading">
              <h3>Кадри</h3>
              <span>{{ frames.length }}</span>
            </div>
            <ol>
              <li
                v-for="(frame, index) in frames"
                :key="frame.id"
              >
                <button
                  :data-frame="index"
                  type="button"
                  class="script-frame-tab"
                  :aria-current="selectedFrame === index ? 'step' : undefined"
                  @click="selectedFrame = index"
                  @keydown="onOutlineKeydown($event, index)"
                >
                  <span class="script-frame-index">{{ String(index + 1).padStart(2, '0') }}</span>
                  <span class="script-frame-title">{{ frameTitle(frame, index) }}</span>
                </button>
                <div
                  v-if="selectedFrame === index"
                  class="script-frame-order"
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    :disabled="readonly || index === 0"
                    :aria-label="`Вгору: Перемістити кадр ${index + 1} вище`"
                    @click="moveFrame(index, -1)"
                  >
                    Вгору
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    :disabled="readonly || index === frames.length - 1"
                    :aria-label="`Вниз: Перемістити кадр ${index + 1} нижче`"
                    @click="moveFrame(index, 1)"
                  >
                    Вниз
                  </Button>
                </div>
              </li>
            </ol>
            <Button
              class="script-add"
              variant="outline"
              :disabled="readonly || frames.length >= 30"
              @click="addFrame"
            >
              Додати кадр
            </Button>
            <p class="script-order-help">
              Alt + ↑ / ↓ змінює порядок вибраного кадру.
            </p>
          </nav>

          <div
            v-if="frames[selectedFrame]"
            class="script-paper"
          >
            <div class="script-paper-heading">
              <h3>Кадр {{ selectedFrame + 1 }}</h3>
              <Button
                variant="ghost"
                :disabled="readonly || frames.length <= 1"
                @click="removeFrame(selectedFrame)"
              >
                Вилучити
              </Button>
            </div>
            <label class="script-field"><span>Призначення кадру</span><input
              v-model="frames[selectedFrame]!.purpose"
              maxlength="200"
              :disabled="readonly || recovered || busy || languageBusy"
              placeholder="Наприклад, пояснити ключовий висновок"
              @input="changed"
            ></label>
            <label class="script-field"><span>Точний текст</span><textarea
              :value="frames[selectedFrame]!.text"
              maxlength="3000"
              rows="7"
              :disabled="readonly || recovered || busy || languageBusy"
              placeholder="Текст, який дизайнер розмістить у кадрі"
              @input="editFrameText(frames[selectedFrame]!, ($event.target as HTMLTextAreaElement).value)"
            /></label>
            <label class="script-field"><span>Візуальна підказка</span><textarea
              v-model="frames[selectedFrame]!.visualHint"
              maxlength="1000"
              rows="3"
              :disabled="readonly || recovered || busy || languageBusy"
              placeholder="Композиція, зображення чи акцент для дизайнера"
              @input="changed"
            /></label>
            <label
              v-if="format === 'INSTAGRAM_STORIES'"
              class="script-field"
            ><span>Перехід до наступної історії</span><input
              v-model="frames[selectedFrame]!.transition"
              maxlength="300"
              :disabled="readonly || recovered || busy || languageBusy"
              placeholder="Наприклад, наступна історія розкриває відповідь"
              @input="changed"
            ></label>
            <p class="script-frame-count">
              {{ frames[selectedFrame]!.text.length }} / 3000 символів
            </p>
          </div>
          <p
            v-else
            class="script-empty"
          >
            Додайте перший кадр до сценарію.
          </p>
        </div>

        <div class="script-actions">
          <Button
            variant="outline"
            :disabled="readonly || busy || saving || conflict || recovered || !completeFrames || !parentId"
            @click="command('/checkpoint')"
          >
            Зберегти версію
          </Button>
          <Button
            variant="outline"
            :disabled="readonly || busy || saving || !state?.script?.draft?.baseRevisionId"
            @click="command(`/revisions/${state!.script!.draft!.baseRevisionId}/apply`)"
          >
            Застосувати сценарій
          </Button>
        </div>
        <section
          class="script-language"
          aria-labelledby="script-language-title"
        >
          <div class="script-language-heading">
            <div>
              <h3 id="script-language-title">
                Мовні пропозиції
              </h3><p>Перевірка підказує точкові виправлення. Вибір залишається за вами.</p>
            </div>
            <Button
              variant="outline"
              :disabled="readonly || busy || saving || conflict || languageBusy || dirty || recovered || !state?.script?.draft?.baseRevisionId"
              @click="reviewLanguage"
            >
              {{ languageBusy ? 'Перевіряємо…' : 'Перевірити мову' }}
            </Button>
          </div>
          <p
            v-if="!state?.script?.draft?.baseRevisionId"
            class="script-help"
          >
            Збережіть версію сценарію, перш ніж перевіряти мову.
          </p>
          <p
            v-if="languageMessage"
            class="script-language-message"
            role="status"
            aria-live="polite"
          >
            {{ languageMessage }}
          </p>
          <article
            v-for="suggestion in languageSuggestions"
            :key="suggestion.id"
            class="script-language-item"
          >
            <p>{{ suggestion.finding }} · кадр {{ Math.max(1, frames.findIndex(frame => frame.id === suggestion.frameId) + 1) }}</p>
            <p class="script-language-change">
              <del>{{ suggestion.originalText }}</del> <ins>{{ suggestion.replacementText }}</ins>
            </p>
            <label
              v-if="suggestion.status === 'OPEN'"
              class="script-language-select"
            ><input
              v-model="selectedLanguageIds"
              type="checkbox"
              :value="suggestion.id"
              :disabled="readonly || languageBusy || dirty"
            > Застосувати цю правку</label>
            <span v-else>{{ suggestion.status === 'ACCEPTED' ? 'Застосовано' : 'Відхилено' }}</span>
            <Button
              v-if="suggestion.status === 'OPEN'"
              variant="ghost"
              :disabled="readonly || languageBusy || dirty"
              @click="rejectLanguage(suggestion)"
            >
              Відхилити
            </Button>
          </article>
          <Button
            v-if="selectedLanguageIds.length"
            variant="outline"
            :disabled="readonly || languageBusy || dirty"
            @click="acceptLanguage"
          >
            Застосувати вибрані правки
          </Button>
        </section>

        <section
          v-if="activeRevision"
          class="script-approval"
          aria-label="Погоджений сценарій"
        >
          <p>Є погоджений сценарій, версія {{ activeRevision.number }}.</p>
          <details>
            <summary>Переглянути погоджений текст</summary>
            <ol>
              <li
                v-for="frame in activeRevision.content.frames"
                :key="frame.id"
              >
                <strong>{{ frame.purpose }}</strong><p>{{ frame.text }}</p><small>{{ frame.visualHint }}</small>
              </li>
            </ol>
          </details>
        </section>

        <section
          class="script-history"
          aria-label="Історія сценаріїв"
        >
          <h3>Історія версій</h3>
          <article
            v-for="revision in state?.script?.revisions ?? []"
            :key="revision.id"
            class="script-revision"
          >
            <div><strong>Версія {{ revision.number }}</strong><span>{{ revisionStatus(revision) === 'APPROVED' ? 'Погоджено' : revisionStatus(revision) === 'WITHDRAWN' ? 'Відкликано' : 'Очікує перевірки' }}</span></div>
            <p
              v-if="revision.staleReasons?.length || revision.blockingReasons?.length"
              class="script-review-note"
            >
              Потрібно перевірити зміни підпису або джерел.
            </p>
            <details>
              <summary>Переглянути кадри й вибрати для застосування</summary><ol>
                <li
                  v-for="frame in revision.content.frames"
                  :key="frame.id"
                >
                  <label class="script-apply-frame"><input
                    type="checkbox"
                    :checked="selectedApplyFrames[revision.id]?.includes(frame.id) ?? false"
                    :disabled="readonly || busy || dirty || recovered"
                    @change="toggleApplyFrame(revision.id, frame.id, ($event.target as HTMLInputElement).checked)"
                  ><span><strong>{{ frame.purpose }}</strong><p>{{ frame.text }}</p><small>{{ frame.visualHint }}</small></span></label>
                </li>
              </ol>
            </details>
            <div class="script-revision-actions">
              <Button
                v-if="revisionStatus(revision) !== 'WITHDRAWN'"
                variant="ghost"
                :disabled="readonly || busy || dirty || recovered"
                @click="command(`/revisions/${revision.id}/apply`)"
              >
                Застосувати всі кадри
              </Button>
              <Button
                v-if="revisionStatus(revision) !== 'WITHDRAWN'"
                variant="outline"
                :disabled="readonly || busy || dirty || recovered || !selectedApplyFrames[revision.id]?.length"
                @click="command(`/revisions/${revision.id}/apply`, { frameIds: selectedApplyFrames[revision.id] })"
              >
                Застосувати вибрані ({{ selectedApplyFrames[revision.id]?.length ?? 0 }})
              </Button>
              <label
                v-if="revisionStatus(revision) === 'PROPOSED' && revision.hasUnmapped"
                class="script-acknowledgement"
              ><input
                v-model="reviewAcknowledgements[revision.id]"
                type="checkbox"
                :disabled="readonly || busy || dirty || recovered"
              > Підтверджую, що непов’язаний із доказами текст цього кадру перевірено вручну.</label>
              <Button
                v-if="revisionStatus(revision) === 'PROPOSED'"
                variant="outline"
                :disabled="readonly || busy || dirty || recovered || (revision.hasUnmapped && !reviewAcknowledgements[revision.id])"
                @click="command(`/revisions/${revision.id}/approve`, { expectedReviewCounter: revision.reviewCounter, acknowledgeUnmapped: reviewAcknowledgements[revision.id] === true })"
              >
                Погодити
              </Button>
              <Button
                v-if="revisionStatus(revision) === 'APPROVED'"
                variant="ghost"
                :disabled="readonly || busy || dirty || recovered"
                @click="command(`/revisions/${revision.id}/withdraw`, { reason: 'Відкликано редактором' })"
              >
                Відкликати погодження
              </Button>
            </div>
          </article>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.script-workspace { margin: 28px 0 0; padding: 24px 0 0; border-top: 1px solid var(--rule); color: var(--ink); }
.script-heading { display:flex; align-items:baseline; justify-content:space-between; gap:16px; }
.script-heading h2 { margin:0; font:550 27px/1.3 SourceSerif, Georgia, serif; }
.script-heading p,.script-help,.script-order-help,.script-status,.script-frame-count,.script-approval p { color:var(--muted); font-size:13px; line-height:1.55; }
.script-heading > div > p { margin:5px 0 0; }
.script-save-state { margin:0; white-space:nowrap; }
.script-controls { margin:20px 0; padding-bottom:18px; border-bottom:1px solid var(--rule); }
.script-parent { display:grid; gap:6px; max-width:560px; font-size:13px; }
.script-parent select,.script-field input,.script-field textarea { box-sizing:border-box; width:100%; border:1px solid var(--field-rule); border-radius:0; background:var(--paper); color:var(--ink); font:400 15px/1.5 Onest,sans-serif; }
.script-parent select,.script-field input { min-height:42px; padding:8px 10px; }
.script-parent select:focus-visible,.script-field input:focus-visible,.script-field textarea:focus-visible,.script-frame-tab:focus-visible { outline:2px solid var(--copper); outline-offset:3px; }
.script-help { margin:8px 0 0; }
.script-editor { display:grid; grid-template-columns:minmax(210px,270px) minmax(0,1fr); gap:clamp(20px,4vw,48px); align-items:start; }
.script-outline { min-width:0; }
.script-outline-heading { display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid var(--rule); }
.script-outline-heading h3,.script-paper-heading h3,.script-history h3 { margin:0; font:550 19px/1.4 SourceSerif,Georgia,serif; }
.script-outline-heading span { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.script-outline ol { margin:0; padding:0; list-style:none; }
.script-outline li { border-bottom:1px solid var(--rule); }
.script-frame-tab { width:100%; display:flex; align-items:baseline; gap:12px; padding:11px 4px; border:0; background:transparent; color:var(--ink); text-align:left; cursor:pointer; }
.script-frame-tab[aria-current="step"] { background:var(--selected); }
.script-frame-index { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
.script-frame-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:14px; }
.script-frame-order,.script-actions,.script-revision-actions { display:flex; flex-wrap:wrap; gap:6px; }
.script-frame-order { padding:0 4px 6px 34px; }
.script-add { margin-top:14px; }
.script-order-help { margin:8px 0; font-size:12px; }
.script-paper { min-width:0; padding:18px clamp(18px,3vw,34px); border:1px solid var(--rule); background:var(--paper); }
.script-paper-heading { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
.script-field { display:grid; gap:7px; margin:14px 0; font-size:13px; }
.script-field textarea { min-height:80px; resize:vertical; padding:10px 12px; }
.script-field textarea:first-of-type { font:400 19px/1.6 SourceSerif,Georgia,serif; }
.script-frame-count { margin:0; text-align:right; font-variant-numeric:tabular-nums; }
.script-actions { margin:16px 0 22px; }
.script-language { margin:20px 0 24px; padding:16px 0; border-top:1px solid var(--rule); border-bottom:1px solid var(--rule); }
.script-language-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; }
.script-language-heading h3 { margin:0; font:550 19px/1.4 SourceSerif,Georgia,serif; }
.script-language-heading p,.script-language-item>p:first-child { color:var(--muted); font-size:13px; }
.script-language-item { padding:10px 0; border-top:1px solid var(--rule); }
.script-language-change { font:17px/1.5 SourceSerif,Georgia,serif; }
.script-language-change del { color:var(--review,#945000); }
.script-language-change ins { color:var(--approved,#32664b); text-decoration-thickness:1px; }
.script-language-select { display:inline-flex; align-items:center; gap:8px; font-size:13px; }
.script-language-message { color:var(--muted); font-size:13px; }
.script-recovery,.script-error,.script-review-note { margin:12px 0; padding:10px 12px; border:1px solid var(--review,#945000); color:var(--ink); font-size:13px; line-height:1.5; }
.script-recovery { display:flex; align-items:center; flex-wrap:wrap; gap:8px; }
.script-recovery p { flex-basis:100%; margin:0; }
.script-error { border-color:#a64236; }
.script-approval,.script-history { margin-top:24px; padding-top:16px; border-top:1px solid var(--rule); }
.script-history h3 { margin-bottom:8px; }
.script-revision { padding:12px 0; border-top:1px solid var(--rule); }
.script-revision > div:first-child { display:flex; flex-wrap:wrap; gap:12px; align-items:baseline; }
.script-revision > div:first-child span { color:var(--muted); font-size:13px; }
.script-revision p { margin:7px 0; white-space:pre-wrap; }
.script-revision small { color:var(--muted); }
.script-revision-actions { margin-top:8px; }
.script-apply-frame { display:flex; align-items:flex-start; gap:9px; margin:8px 0; }
.script-apply-frame input { margin-top:5px; }
.script-acknowledgement { flex-basis:100%; display:flex; align-items:flex-start; gap:8px; font-size:13px; line-height:1.5; }
.script-empty { color:var(--muted); }
.is-readonly { opacity:.82; }
@media(max-width:720px) { .script-heading { align-items:flex-start; flex-direction:column; gap:4px; } .script-editor { grid-template-columns:minmax(0,1fr); gap:18px; } .script-outline { display:block; } .script-outline ol { display:flex; gap:6px; overflow-x:auto; padding:8px 0; } .script-outline li { min-width:148px; border:1px solid var(--rule); } .script-frame-order { padding-left:6px; } .script-frame-tab { min-height:44px; } .script-actions>* { flex:1 1 100%; } .script-recovery { align-items:stretch; } }
@media(prefers-reduced-motion:reduce) { .script-workspace * { scroll-behavior:auto; } }
</style>
