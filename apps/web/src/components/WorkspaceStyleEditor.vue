<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

type SettingValue = string | number | boolean
type Style = { revision: number; brandbook: string; tone: string; settings: Record<string, SettingValue> }
type SettingRow = { id: number; key: string; kind: 'string' | 'number' | 'boolean'; value: string | number | boolean }

const props = withDefaults(defineProps<{
  workspaceId: string
  csrfToken: string
  disabled?: boolean
}>(), { disabled: false })
const emit = defineEmits<{ dirty: [value: boolean]; saved: [] }>()

const style = ref<Style | null>(null)
const brandbook = ref('')
const tone = ref('')
const rows = ref<SettingRow[]>([])
const baseline = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const conflict = ref(false)
const newKey = ref('')
const newKind = ref<SettingRow['kind']>('string')
const newValue = ref('')
let requestVersion = 0
let nextRowId = 1

const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,79}$/
const settingCount = computed(() => rows.value.length)
const dirty = computed(() => !!style.value && serializeDraft() !== baseline.value)
const canSave = computed(() => !props.disabled && !loading.value && !saving.value && !conflict.value && !!style.value && dirty.value && !fieldError.value)

function serializeDraft() {
  return JSON.stringify({
    brandbook: brandbook.value,
    tone: tone.value,
    settings: rows.value.map(row => ({ key: row.key, kind: row.kind, value: row.value })),
  })
}

function snapshot(styleValue: Style) {
  style.value = styleValue
  brandbook.value = styleValue.brandbook
  tone.value = styleValue.tone
  rows.value = Object.entries(styleValue.settings).map(([key, value]) => ({
    id: nextRowId++, key,
    kind: typeof value === 'boolean' ? 'boolean' : typeof value === 'number' ? 'number' : 'string',
    value,
  }))
  baseline.value = serializeDraft()
  conflict.value = false
  notice.value = ''
  publishDirty()
}

function publishDirty() { emit('dirty', dirty.value) }
watch([brandbook, tone, rows], publishDirty, { deep: true })

const fieldError = computed(() => {
  if (brandbook.value.length > 50_000) return 'Брендбук має містити не більше 50 000 символів.'
  if (tone.value.length > 10_000) return 'Опис тону має містити не більше 10 000 символів.'
  if (rows.value.length > 50) return 'Можна зберегти до 50 параметрів.'
  const seen = new Set<string>()
  for (const row of rows.value) {
    if (!keyPattern.test(row.key)) return `Назва «${row.key}» має починатися з латинської літери та містити до 80 літер, цифр або підкреслень.`
    if (seen.has(row.key)) return `Назва «${row.key}» повторюється.`
    seen.add(row.key)
    if (row.kind === 'string' && (typeof row.value !== 'string' || row.value.length > 500)) return `Значення «${row.key}» має містити до 500 символів.`
    if (row.kind === 'number' && ((typeof row.value === 'string' && row.value.trim() === '') || !Number.isFinite(Number(row.value)))) return `Значення «${row.key}» має бути скінченним числом.`
  }
  return ''
})

function readableError(status: number) {
  if (status === 401) return 'Сесію завершено. Увійдіть знову.'
  if (status === 404) return 'Простір недоступний або його більше не існує.'
  if (status === 409) return 'Налаштування вже змінив інший учасник простору.'
  if (status === 400) return 'Перевірте довжину тексту та формат параметрів.'
  return 'Не вдалося виконати запит. Перевірте з’єднання та спробуйте ще раз.'
}

async function load(options: { discard?: boolean; keepDraft?: boolean } = {}) {
  const version = ++requestVersion
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/style`, { credentials: 'same-origin' })
    if (version !== requestVersion) return
    if (!response.ok) throw new Error(readableError(response.status))
    const result = await response.json() as { style: Style }
    if (version !== requestVersion) return
    if (options.keepDraft && style.value) {
      style.value = result.style
      conflict.value = false
      notice.value = `Завантажено версію ${result.style.revision}. Ваші введені зміни збережені у формі; перевірте їх перед записом.`
    } else {
      snapshot(result.style)
      if (options.discard) notice.value = 'Завантажено останню версію. Незбережені зміни відкинуто.'
    }
  } catch (cause) {
    if (version === requestVersion) error.value = cause instanceof Error ? cause.message : 'Не вдалося завантажити налаштування.'
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

function updateRowKind(row: SettingRow) {
  row.value = row.kind === 'boolean' ? false : ''
}

function addSetting() {
  error.value = ''
  const key = newKey.value.trim()
  if (!keyPattern.test(key)) { error.value = 'Назва має починатися з латинської літери та містити до 80 літер, цифр або підкреслень.'; return }
  if (rows.value.some(row => row.key === key)) { error.value = `Параметр «${key}» уже є у списку.`; return }
  if (rows.value.length >= 50) { error.value = 'Досягнуто ліміт у 50 параметрів.'; return }
  rows.value.push({ id: nextRowId++, key, kind: newKind.value, value: newKind.value === 'boolean' ? false : newValue.value })
  newKey.value = ''
  newValue.value = ''
}

function removeSetting(id: number) { rows.value = rows.value.filter(row => row.id !== id) }

async function save() {
  if (!canSave.value || !style.value) return
  saving.value = true
  error.value = ''
  notice.value = ''
  const version = requestVersion
  try {
    const settings = Object.fromEntries(rows.value.map(row => [row.key, row.kind === 'number' ? Number(row.value) : row.value]))
    const response = await fetch(`/api/v1/workspaces/${encodeURIComponent(props.workspaceId)}/style`, {
      method: 'PATCH', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken },
      body: JSON.stringify({ expectedRevision: style.value.revision, brandbook: brandbook.value, tone: tone.value, settings }),
    })
    if (version !== requestVersion) return
    if (response.status === 409) { conflict.value = true; error.value = readableError(409); return }
    if (!response.ok) throw new Error(readableError(response.status))
    const result = await response.json() as { style: Style }
    if (version !== requestVersion) return
    snapshot(result.style)
    notice.value = `Збережено версію ${result.style.revision}.`
    emit('saved')
  } catch (cause) {
    if (version === requestVersion) error.value = cause instanceof Error ? cause.message : 'Не вдалося зберегти налаштування.'
  } finally {
    if (version === requestVersion) saving.value = false
  }
}

watch(() => props.workspaceId, () => {
  requestVersion++
  style.value = null
  brandbook.value = ''
  tone.value = ''
  rows.value = []
  baseline.value = ''
  conflict.value = false
  saving.value = false
  error.value = ''
  notice.value = ''
  publishDirty()
  void load()
}, { immediate: true })

onBeforeUnmount(() => { requestVersion++ })
</script>

<template>
  <section
    class="workspace-style"
    aria-labelledby="workspace-style-heading"
  >
    <header class="style-header">
      <div>
        <h2 id="workspace-style-heading">
          Брендбук і тон
        </h2>
        <p>Спільні підказки для всіх проєктів цього простору.</p>
      </div>
      <span
        v-if="style"
        class="style-revision"
      >Версія {{ style.revision }}</span>
    </header>

    <p
      v-if="loading && !style"
      class="style-state"
      role="status"
    >
      Завантажуємо налаштування простору…
    </p>
    <div
      v-else-if="!style && error"
      class="style-state style-error"
      role="alert"
    >
      <p>{{ error }}</p>
      <button
        type="button"
        class="style-button style-button-secondary"
        :disabled="disabled"
        @click="load()"
      >
        Спробувати ще раз
      </button>
    </div>

    <template v-if="style">
      <p class="style-inheritance">
        Ці налаштування доступні учасникам і успадковуються всіма проєктами. У брифі можна уточнити тон для окремого проєкту.
      </p>

      <div class="style-field">
        <label for="workspace-brandbook">Брендбук</label>
        <p class="field-help">
          Опишіть бренд, аудиторію, лексику, правила й обмеження. Це текстовий контекст для підготовки контенту.
        </p>
        <textarea
          id="workspace-brandbook"
          v-model="brandbook"
          :disabled="disabled || saving"
          maxlength="50000"
          rows="7"
          placeholder="Наприклад: як називати продукт, які формулювання вживати та яких уникати."
        />
        <span class="field-count">{{ brandbook.length.toLocaleString('uk-UA') }} / 50 000</span>
      </div>

      <div class="style-field">
        <label for="workspace-tone">Тон комунікації</label>
        <p class="field-help">
          Коротко задайте загальне звучання. Його можна уточнити в брифі проєкту.
        </p>
        <textarea
          id="workspace-tone"
          v-model="tone"
          :disabled="disabled || saving"
          maxlength="10000"
          rows="3"
          placeholder="Наприклад: спокійно, конкретно, доброзичливо; без канцеляризмів."
        />
        <span class="field-count">{{ tone.length.toLocaleString('uk-UA') }} / 10 000</span>
      </div>

      <div class="style-field style-settings">
        <div class="settings-heading">
          <div>
            <h3>Додаткові параметри</h3>
            <p class="field-help">
              Названі текстові, числові або логічні значення для системних інтеграцій.
            </p>
          </div>
          <span class="field-count">{{ settingCount }} / 50</span>
        </div>
        <div
          v-if="rows.length"
          class="settings-table"
          role="list"
          aria-label="Параметри бренду"
        >
          <div
            v-for="row in rows"
            :key="row.id"
            class="setting-row"
            role="listitem"
          >
            <label
              class="sr-only"
              :for="`setting-key-${row.id}`"
            >Назва параметра</label>
            <input
              :id="`setting-key-${row.id}`"
              v-model="row.key"
              class="setting-key"
              :disabled="disabled || saving"
              maxlength="80"
              autocomplete="off"
              aria-label="Назва параметра"
            >
            <label
              class="sr-only"
              :for="`setting-type-${row.id}`"
            >Тип значення</label>
            <select
              :id="`setting-type-${row.id}`"
              v-model="row.kind"
              :disabled="disabled || saving"
              aria-label="Тип значення"
              @change="updateRowKind(row)"
            >
              <option value="string">
                Текст
              </option><option value="number">
                Число
              </option><option value="boolean">
                Так / ні
              </option>
            </select>
            <label
              class="sr-only"
              :for="`setting-value-${row.id}`"
            >Значення параметра</label>
            <select
              v-if="row.kind === 'boolean'"
              :id="`setting-value-${row.id}`"
              v-model="row.value"
              :disabled="disabled || saving"
              aria-label="Значення параметра"
            >
              <option :value="true">
                Так
              </option><option :value="false">
                Ні
              </option>
            </select>
            <input
              v-else
              :id="`setting-value-${row.id}`"
              v-model="row.value"
              :type="row.kind === 'number' ? 'number' : 'text'"
              :maxlength="row.kind === 'string' ? 500 : undefined"
              :disabled="disabled || saving"
              :aria-label="`Значення параметра ${row.key}`"
            >
            <button
              type="button"
              class="remove-setting"
              :disabled="disabled || saving"
              :aria-label="`Видалити параметр ${row.key}`"
              @click="removeSetting(row.id)"
            >
              Видалити
            </button>
          </div>
        </div>
        <form
          class="add-setting"
          @submit.prevent="addSetting"
        >
          <label
            class="sr-only"
            for="new-setting-key"
          >Назва нового параметра</label>
          <input
            id="new-setting-key"
            v-model="newKey"
            maxlength="80"
            autocomplete="off"
            placeholder="Назва, наприклад brand_name"
            :disabled="disabled || saving || settingCount >= 50"
          >
          <label
            class="sr-only"
            for="new-setting-kind"
          >Тип нового параметра</label>
          <select
            id="new-setting-kind"
            v-model="newKind"
            :disabled="disabled || saving || settingCount >= 50"
          >
            <option value="string">
              Текст
            </option><option value="number">
              Число
            </option><option value="boolean">
              Так / ні
            </option>
          </select>
          <label
            v-if="newKind !== 'boolean'"
            class="sr-only"
            for="new-setting-value"
          >Значення нового параметра</label>
          <input
            v-if="newKind !== 'boolean'"
            id="new-setting-value"
            v-model="newValue"
            :type="newKind === 'number' ? 'number' : 'text'"
            :maxlength="newKind === 'string' ? 500 : undefined"
            placeholder="Значення"
            :disabled="disabled || saving || settingCount >= 50"
          >
          <span
            v-else
            class="boolean-default"
          >Ні</span>
          <button
            type="submit"
            class="style-button style-button-secondary"
            :disabled="disabled || saving || settingCount >= 50"
          >
            Додати
          </button>
        </form>
        <p class="settings-limit">
          До 50 параметрів. Назва: латинська літера на початку, далі літери, цифри або _. Значення тексту — до 500 символів.
        </p>
      </div>

      <p
        v-if="fieldError"
        class="style-error field-error"
        role="alert"
      >
        {{ fieldError }}
      </p>
      <div
        v-if="error"
        class="style-message style-error"
        role="alert"
      >
        <p>{{ error }}</p>
        <template v-if="conflict">
          <p>Ваші введені значення залишилися у формі. Оберіть, як продовжити.</p>
          <div class="conflict-actions">
            <button
              type="button"
              class="style-button style-button-secondary"
              :disabled="disabled || loading"
              @click="load({ discard: true })"
            >
              Перезавантажити й відкинути мої зміни
            </button>
            <button
              type="button"
              class="style-button style-button-secondary"
              :disabled="disabled || loading"
              @click="load({ keepDraft: true })"
            >
              Завантажити нову версію й залишити мої зміни
            </button>
          </div>
        </template>
      </div>
      <p
        v-if="notice"
        class="style-message"
        role="status"
      >
        {{ notice }}
      </p>

      <footer class="style-actions">
        <span
          v-if="dirty && !conflict"
          class="unsaved-state"
        >Є незбережені зміни</span>
        <span
          v-else
          class="unsaved-state"
        >&nbsp;</span>
        <button
          type="button"
          class="style-button style-button-primary"
          :disabled="!canSave"
          @click="save"
        >
          {{ saving ? 'Зберігаємо…' : 'Зберегти для всіх проєктів' }}
        </button>
      </footer>
    </template>
  </section>
</template>

<style scoped>
.workspace-style { max-width: 920px; padding: 28px 0 44px; color: var(--ink); }
.style-header { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; padding-bottom: 22px; border-bottom: 1px solid var(--rule); }
.style-header h2 { margin: 0; font-family: var(--serif); font-size: 29px; font-weight: 550; line-height: 1.2; letter-spacing: -.025em; }
.style-header p, .field-help { margin: 8px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.style-revision, .field-count { flex: 0 0 auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.style-inheritance { max-width: 72ch; margin: 20px 0 28px; color: var(--lead-ink); font-size: 14px; line-height: 1.6; }
.style-field { display: grid; gap: 8px; padding: 23px 0; border-top: 1px solid var(--rule); }
.style-field > label, .settings-heading h3 { margin: 0; font-size: 15px; font-weight: 600; }
.style-field textarea, .setting-row input, .setting-row select, .add-setting input, .add-setting select { width: 100%; min-width: 0; border: 1px solid var(--field-rule); border-radius: 2px; background: var(--document); color: var(--ink); font: inherit; font-size: 14px; }
.style-field textarea { resize: vertical; min-height: 88px; padding: 12px 14px; line-height: 1.55; }
.style-field textarea::placeholder, .add-setting input::placeholder { color: #666b70; opacity: 1; }
.style-field textarea:focus-visible, .setting-row input:focus-visible, .setting-row select:focus-visible, .add-setting input:focus-visible, .add-setting select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.style-field textarea:disabled, .setting-row input:disabled, .setting-row select:disabled, .add-setting input:disabled, .add-setting select:disabled { background: #f4f4f2; color: var(--muted); }
.field-count { justify-self: end; }
.settings-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
.settings-heading .field-help { margin-top: 5px; }
.settings-table { display: grid; }
.setting-row { display: grid; grid-template-columns: minmax(120px, 1fr) 110px minmax(140px, 1.2fr) auto; align-items: center; gap: 8px; padding: 9px 0; border-bottom: 1px solid var(--rule); }
.setting-row input, .setting-row select, .add-setting input, .add-setting select { height: 40px; padding: 0 10px; }
.add-setting { display: grid; grid-template-columns: minmax(120px, 1fr) 110px minmax(140px, 1.2fr) auto; align-items: center; gap: 8px; padding-top: 12px; }
.boolean-default { color: var(--muted); font-size: 13px; }
.remove-setting { min-height: 40px; padding: 0 7px; border: 0; background: transparent; color: var(--muted); font-size: 12px; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.remove-setting:hover:not(:disabled) { color: var(--ink); }
.remove-setting:focus-visible, .style-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.remove-setting:disabled { cursor: default; opacity: .55; }
.settings-limit { margin: 2px 0 0; color: var(--muted); font-size: 12px; line-height: 1.5; }
.style-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-top: 20px; border-top: 1px solid var(--rule); }
.unsaved-state { color: var(--muted); font-size: 13px; }
.style-button { display: inline-flex; min-height: 42px; align-items: center; justify-content: center; border: 1px solid var(--accent); border-radius: 2px; padding: 8px 15px; font: inherit; font-size: 13px; line-height: 1.3; cursor: pointer; }
.style-button-primary { background: var(--accent); color: var(--copper-foreground); }
.style-button-primary:hover:not(:disabled) { background: var(--copper-hover); }
.style-button-secondary { background: var(--document); color: var(--ink); }
.style-button-secondary:hover:not(:disabled) { background: #f2f2f0; }
.style-button:disabled { cursor: default; opacity: .52; }
.style-message, .style-state { margin: 14px 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.style-error { color: var(--error); }
.style-message p { margin: 0 0 8px; }
.conflict-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 12px; }
.field-error { margin: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 760px) {
  .workspace-style { padding: 22px 0 32px; }
  .style-header { align-items: flex-start; }
  .style-header h2 { font-size: 25px; }
  .setting-row { grid-template-columns: minmax(0, 1fr) minmax(96px, .55fr); padding: 12px 0; }
  .setting-row input:first-of-type { grid-column: 1; }
  .setting-row > select:first-of-type { grid-column: 2; }
  .setting-row input:not(:first-of-type), .setting-row > select:last-of-type { grid-column: 1; }
  .setting-row .remove-setting { grid-column: 2; justify-self: end; min-height: 44px; }
  .add-setting { grid-template-columns: minmax(0, 1fr) minmax(96px, .55fr); }
  .add-setting input:first-of-type { grid-column: 1; }
  .add-setting select { grid-column: 2; }
  .add-setting input:last-of-type, .boolean-default { grid-column: 1; }
  .add-setting .style-button { grid-column: 2; justify-self: end; min-width: 84px; min-height: 44px; }
  .style-actions { align-items: stretch; flex-direction: column; }
  .style-actions .style-button { min-height: 46px; }
  .conflict-actions { flex-direction: column; align-items: stretch; }
}
</style>
