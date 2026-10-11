<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Button } from '@/components/ui/button'

type AnnotationPost = { id: string; body: string; action: string; createdBy: string; createdAt: string; authorName: string | null }
type AnnotationThread = { id: string; articleVersionId: string; kind: 'COMMENT' | 'SUGGESTION'; status: 'OPEN' | 'RESOLVED' | 'ACCEPTED' | 'REJECTED'; revision: number; quote: string; body: string; replacementText: string | null; resultVersionId: string | null; createdBy: string; createdAt: string; authorName: string | null; anchor: { status: 'EXACT' | 'UNRESOLVED'; start: number | null; end: number | null }; posts: AnnotationPost[] }
type Anchor = { start: number; end: number; quote: string } | null
const props = defineProps<{ projectId: string; csrfToken: string; userId: string; targetVersionId: string | null; contentHash: string | null; expectedArticleRevision: number; anchor: Anchor; readonly?: boolean }>()
const emit = defineEmits<{ 'session-expired': []; 'candidate-created': [versionId: string] }>()
const threads = ref<AnnotationThread[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const kind = ref<'COMMENT' | 'SUGGESTION'>('COMMENT')
const body = ref('')
const replacementText = ref('')
const replies = ref<Record<string, string>>({})
let pendingCreateFingerprint = ''
let pendingCreateKey = ''
const base = computed(() => `/api/v1/projects/${encodeURIComponent(props.projectId)}/article/annotations`)
const openThreads = computed(() => threads.value.filter(thread => thread.status === 'OPEN'))
const closedThreads = computed(() => threads.value.filter(thread => thread.status !== 'OPEN'))

function statusLabel(thread: AnnotationThread) {
  if (thread.anchor.status === 'UNRESOLVED') return 'Фрагмент не знайдено в цій версії'
  return ({ OPEN: 'Відкрито', RESOLVED: 'Закрито', ACCEPTED: 'Застосовано як окрему версію', REJECTED: 'Відхилено' } as const)[thread.status]
}
function mergeThreads(updated: AnnotationThread[]) {
  for (const thread of updated) {
    const index = threads.value.findIndex(existing => existing.id === thread.id)
    if (index < 0) threads.value.push(thread)
    else threads.value[index] = thread
  }
}
function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('uk-UA', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
async function request(path = '', payload?: unknown) {
  const response = await fetch(`${base.value}${path}`, {
    credentials: 'same-origin',
    method: payload === undefined ? 'GET' : 'POST',
    ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': props.csrfToken }, body: JSON.stringify(payload) }),
  })
  if (response.status === 401) { emit('session-expired'); throw new Error('Сесію завершено.') }
  if (!response.ok) throw new Error(response.status === 409 ? 'Коментар або текст статті змінився. Оновіть панель і перевірте стан.' : 'Не вдалося зберегти зміни. Введений текст залишився у формі; спробуйте ще раз.')
  return response.json() as Promise<{ threads: AnnotationThread[]; candidateVersionId?: string }>
}
async function load() {
  loading.value = true; error.value = ''
  try {
    const query = props.targetVersionId ? `?targetVersionId=${encodeURIComponent(props.targetVersionId)}` : ''
    threads.value = (await request(query)).threads
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося відкрити коментарі.' }
  finally { loading.value = false }
}
watch(() => [props.targetVersionId, props.contentHash], () => { void load() })
onMounted(() => { void load() })
async function create() {
  const anchor = props.anchor
  if (!anchor || !props.targetVersionId || !props.contentHash || !body.value.trim() || (kind.value === 'SUGGESTION' && !replacementText.value.trim())) return
  busy.value = true; error.value = ''
  try {
    const payload = { articleVersionId: props.targetVersionId, contentHash: props.contentHash, anchorStart: anchor.start, anchorEnd: anchor.end, body: body.value.trim(), kind: kind.value, ...(kind.value === 'SUGGESTION' ? { replacementText: replacementText.value } : {}) }
    const fingerprint = JSON.stringify(payload)
    if (fingerprint !== pendingCreateFingerprint) { pendingCreateFingerprint = fingerprint; pendingCreateKey = crypto.randomUUID() }
    const result = await request('', { ...payload, commandKey: pendingCreateKey })
    mergeThreads(result.threads); body.value = ''; replacementText.value = ''; pendingCreateFingerprint = ''; pendingCreateKey = ''
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося створити коментар.' }
  finally { busy.value = false }
}
async function reply(thread: AnnotationThread) {
  const text = replies.value[thread.id]?.trim()
  if (!text) return
  busy.value = true; error.value = ''
  try { mergeThreads((await request(`/${encodeURIComponent(thread.id)}/reply`, { expectedRevision: thread.revision, body: text })).threads); replies.value[thread.id] = '' }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося додати відповідь.' }
  finally { busy.value = false }
}
async function act(thread: AnnotationThread, action: 'RESOLVE' | 'REOPEN' | 'ACCEPT' | 'REJECT') {
  busy.value = true; error.value = ''
  try {
    const result = await request(`/${encodeURIComponent(thread.id)}/action`, { expectedRevision: thread.revision, action, ...(action === 'ACCEPT' ? { expectedArticleRevision: props.expectedArticleRevision } : {}) })
    mergeThreads(result.threads)
    if (action === 'ACCEPT' && result.candidateVersionId) emit('candidate-created', result.candidateVersionId)
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Не вдалося оновити коментар.' }
  finally { busy.value = false }
}
</script>

<template>
  <div
    class="annotation-panel"
    aria-label="Коментарі й правки"
  >
    <p
      v-if="!targetVersionId"
      class="annotation-note"
    >
      Збережіть версію статті, щоб прив’язати до неї коментарі та пропозиції.
    </p>
    <p
      v-else
      class="annotation-note"
    >
      Коментарі й пропозиції прив’язані до збереженої версії статті.
    </p>
    <section
      class="annotation-compose"
      aria-labelledby="annotation-compose-heading"
    >
      <h3 id="annotation-compose-heading">
        Нова примітка
      </h3>
      <blockquote v-if="anchor">
        {{ anchor.quote }}
      </blockquote>
      <p
        v-else
        class="annotation-note"
      >
        Щоб додати коментар або запропонувати правку, виділіть фрагмент у статті, а потім відкрийте цю панель.
      </p>
      <label for="annotation-kind">Тип</label>
      <select
        id="annotation-kind"
        v-model="kind"
        :disabled="readonly || busy"
      >
        <option value="COMMENT">
          Коментар
        </option>
        <option value="SUGGESTION">
          Пропозиція правки
        </option>
      </select>
      <label for="annotation-body">Коментар</label>
      <textarea
        id="annotation-body"
        v-model="body"
        rows="3"
        maxlength="2000"
        :disabled="readonly || busy"
        placeholder="Напишіть коментар"
      />
      <template v-if="kind === 'SUGGESTION'">
        <label for="annotation-replacement">Запропонований текст</label>
        <textarea
          id="annotation-replacement"
          v-model="replacementText"
          rows="3"
          maxlength="100000"
          :disabled="readonly || busy"
          placeholder="Введіть варіант для виділеного фрагмента"
        />
      </template>
      <Button
        class="workspace-button workspace-button-primary"
        :disabled="readonly || busy || !targetVersionId || !anchor || !body.trim() || (kind === 'SUGGESTION' && !replacementText.trim())"
        @click="create"
      >
        Додати {{ kind === 'SUGGESTION' ? 'пропозицію' : 'коментар' }}
      </Button>
    </section>
    <p
      v-if="error"
      class="article-error"
      role="alert"
    >
      {{ error }}
    </p>
    <p
      v-if="loading"
      role="status"
    >
      Завантажуємо коментарі…
    </p>
    <p
      v-else-if="!threads.length"
      class="annotation-note"
    >
      До цієї версії ще не додано коментарів або пропозицій.
    </p>
    <section
      v-if="openThreads.length"
      aria-labelledby="annotation-open-heading"
    >
      <h3 id="annotation-open-heading">
        Відкриті
      </h3>
      <article
        v-for="thread in openThreads"
        :key="thread.id"
        class="annotation-thread"
      >
        <p class="annotation-meta">
          {{ thread.kind === 'COMMENT' ? 'Коментар' : 'Пропозиція правки' }} · {{ thread.authorName || thread.createdBy }} · {{ statusLabel(thread) }} · {{ formatDate(thread.createdAt) }}
        </p>
        <p
          v-if="thread.anchor.status === 'UNRESOLVED'"
          class="annotation-note"
        >
          Цей фрагмент не вдалося зіставити з поточною версією. Відповісти або закрити гілку можна; застосувати пропозицію до тексту не можна.
        </p>
        <blockquote>{{ thread.quote }}</blockquote>
        <p>{{ thread.body }}</p>
        <p
          v-if="thread.kind === 'SUGGESTION'"
          class="annotation-replacement"
        >
          <span>Запропоновано:</span> {{ thread.replacementText }}
        </p>
        <ol class="annotation-posts">
          <li
            v-for="post in thread.posts"
            :key="post.id"
          >
            <span>{{ post.authorName || post.createdBy }} · {{ formatDate(post.createdAt) }}</span><p>{{ post.body }}</p>
          </li>
        </ol>
        <label :for="`reply-${thread.id}`">Відповісти</label>
        <textarea
          :id="`reply-${thread.id}`"
          v-model="replies[thread.id]"
          rows="2"
          maxlength="2000"
          :disabled="readonly || busy"
        />
        <div class="annotation-actions">
          <Button
            class="workspace-button"
            variant="outline"
            :disabled="readonly || busy || !replies[thread.id]?.trim()"
            @click="reply(thread)"
          >
            Додати відповідь
          </Button>
          <template v-if="thread.kind === 'COMMENT'">
            <Button
              class="workspace-button"
              variant="ghost"
              :disabled="readonly || busy"
              @click="act(thread, 'RESOLVE')"
            >
              Закрити коментар
            </Button>
          </template>
          <template v-else>
            <Button
              class="workspace-button"
              variant="outline"
              :disabled="readonly || busy || !targetVersionId || thread.anchor.status !== 'EXACT'"
              @click="act(thread, 'ACCEPT')"
            >
              Створити версію з правкою
            </Button><Button
              class="workspace-button"
              variant="ghost"
              :disabled="readonly || busy"
              @click="act(thread, 'REJECT')"
            >
              Відхилити
            </Button>
          </template>
        </div>
      </article>
    </section>
    <section
      v-if="closedThreads.length"
      aria-labelledby="annotation-closed-heading"
    >
      <h3 id="annotation-closed-heading">
        Інші коментарі й правки
      </h3>
      <article
        v-for="thread in closedThreads"
        :key="thread.id"
        class="annotation-thread annotation-thread-closed"
      >
        <p class="annotation-meta">
          {{ thread.kind === 'COMMENT' ? 'Коментар' : 'Пропозиція правки' }} · {{ thread.authorName || thread.createdBy }} · {{ statusLabel(thread) }}
        </p>
        <blockquote>{{ thread.quote }}</blockquote><p>{{ thread.body }}</p>
        <Button
          v-if="thread.kind === 'COMMENT' && thread.status === 'RESOLVED'"
          class="workspace-button"
          variant="outline"
          :disabled="readonly || busy"
          @click="act(thread, 'REOPEN')"
        >
          Відкрити знову
        </Button>
        <Button
          v-if="thread.kind === 'SUGGESTION' && thread.status === 'ACCEPTED' && thread.resultVersionId"
          class="workspace-button"
          variant="outline"
          @click="emit('candidate-created', thread.resultVersionId)"
        >
          Переглянути створену версію
        </Button>
        <p v-if="thread.resultVersionId">
          Правку збережено в окремій версії. Її можна переглянути в історії статті.
        </p>
      </article>
    </section>
  </div>
</template>

<style scoped>
.annotation-panel { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.annotation-panel h3 { font-size: 15px; margin: 0 0 10px; }
.annotation-panel label { display: block; margin: 12px 0 4px; }
.annotation-panel select, .annotation-panel textarea { width: 100%; min-height: 44px; border: 1px solid var(--field-rule, var(--rule)); border-radius: 3px; padding: 10px; background: var(--document); color: var(--ink); }
.annotation-panel textarea { resize: vertical; }
.annotation-panel blockquote { border-left: 1px solid var(--rule); margin: 10px 0; padding-left: 12px; font-family: var(--serif); font-size: 17px; line-height: 1.5; overflow-wrap: anywhere; }
.annotation-note, .annotation-meta { color: var(--muted); font-size: 13px; line-height: 1.55; }
.annotation-meta { margin: 0 0 8px; }
.annotation-compose, .annotation-thread { padding: 16px 0; border-bottom: 1px solid var(--rule); }
.annotation-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.annotation-posts { padding-left: 20px; font-size: 13px; }
.annotation-posts span { color: var(--muted); }
.annotation-posts p, .annotation-thread p { line-height: 1.55; overflow-wrap: anywhere; }
.annotation-replacement span { font-weight: 600; }
.annotation-thread-closed { opacity: .82; }
.annotation-panel :is(button, textarea, select):focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
</style>
