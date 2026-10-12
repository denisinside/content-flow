<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
interface Job {id:string;frameId:string;status:string;errorCategory:string|null;providerOutcome:string;retryAllowed:boolean}
interface Candidate {id:string;frameId:string;asset:{id:string;sha256:string};report:{reason:string};applyBlockers:string[];appliedAt:string|null}
interface Prepared {expectedRevision:number;expectedDraftCounter:number;compositionRevisionId:string;frameId:string}
const props = defineProps<{projectId:string;format:string;frameId:string;csrfToken:string;disabled:boolean;prepare:()=>Promise<Prepared|null>;apply:(candidateId:string,frameId:string)=>Promise<boolean>}>()
const emit = defineEmits<{'session-expired':[]}>()
const state = ref<{configured:boolean;jobs:Job[];candidates:Candidate[]}|null>(null)
const brief = ref(''),error = ref(''),busy = ref(false),images = ref<Record<string,string>>({}),reviewed = ref<Record<string,boolean>>({})
const jobs = computed(() => state.value?.jobs.filter(row => row.frameId === props.frameId) ?? [])
const candidates = computed(() => state.value?.candidates.filter(row => row.frameId === props.frameId) ?? [])
let timer:ReturnType<typeof setInterval>|undefined,disposed=false,pending:{key:string;brief:string;frameId:string}|null=null
const controller = new AbortController()
function url(path='') {return `/api/v1/projects/${encodeURIComponent(props.projectId)}/visuals/backgrounds${path}?format=${encodeURIComponent(props.format)}`}
async function request(path='',body?:unknown) {
  const response = await fetch(url(path),{credentials:'same-origin',signal:controller.signal,method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'Content-Type':'application/json','X-CSRF-Token':props.csrfToken},body:JSON.stringify(body)})})
  if (response.status===401) emit('session-expired')
  if (!response.ok) throw new Error(response.status===409?'Композицію змінено. Ваші правки збережені; оновіть стан перед застосуванням.':'Не вдалося виконати дію. Перевірте з’єднання та повторіть спробу.')
  return response.json() as Promise<unknown>
}
async function refresh() {
  if (disposed||document.hidden) return
  try {
    const next = await request() as NonNullable<typeof state.value>
    if (disposed) return
    state.value=next
    for (const candidate of next.candidates) {
      if (images.value[candidate.id]) continue
      const response = await fetch(`/api/v1/projects/${props.projectId}/visuals/assets/${candidate.asset.id}?scope=PROJECT`,{credentials:'same-origin',signal:controller.signal})
      if (!response.ok) continue
      const blob=await response.blob(),hash=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())
      if ([...new Uint8Array(hash)].map(byte=>byte.toString(16).padStart(2,'0')).join('')!==candidate.asset.sha256) throw new Error('Зображення не пройшло перевірку цілісності.')
      const image=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('Зображення недоступне.'));reader.readAsDataURL(blob)})
      if (!disposed) images.value[candidate.id]=image
    }
  } catch (cause) {if (!disposed) error.value=cause instanceof Error?cause.message:'Стан недоступний.'}
}
async function generate() {
  if (busy.value||props.disabled||!brief.value.trim()) return
  busy.value=true;error.value=''
  const target=props.frameId,visualBrief=brief.value.trim()
  try {
    const prepared=await props.prepare()
    if (!prepared||props.frameId!==target) return
    if (!pending||pending.brief!==visualBrief||pending.frameId!==target) pending={key:crypto.randomUUID(),brief:visualBrief,frameId:target}
    await request('/generate',{...prepared,visualBrief,commandKey:pending.key});pending=null;await refresh()
  } catch (cause) {error.value=cause instanceof Error?cause.message:'Генерацію не запущено.'}
  finally {busy.value=false}
}
async function applyCandidate(candidate:Candidate) {
  if (busy.value||!reviewed.value[candidate.id]) return
  busy.value=true;error.value=''
  try {if (await props.apply(candidate.id,candidate.frameId)) await refresh()}catch(cause){error.value=cause instanceof Error?cause.message:'Фон не застосовано.'}finally{busy.value=false}
}
async function action(job:Job,name:'cancel'|'retry') {
  try {const response=await fetch(`/api/v1/projects/${props.projectId}/jobs/${job.id}/${name}`,{method:'POST',credentials:'same-origin',headers:{'X-CSRF-Token':props.csrfToken},signal:controller.signal});if(!response.ok)throw new Error('Дію не виконано. Оновіть стан.');await refresh()}catch(cause){error.value=cause instanceof Error?cause.message:'Дію не виконано.'}
}
function label(job:Job) {return ({QUEUED:'У черзі',RUNNING:'Генеруємо фон',SUCCEEDED:'Кандидат готовий',FAILED:'Не вдалося згенерувати фон',CANCELLED:'Скасовано',RETRY_WAIT:'Очікуємо повтору'} as Record<string,string>)[job.status]??job.status}
watch(()=>props.frameId,()=>{error.value='';brief.value='';void refresh()})
onMounted(()=>{void refresh();timer=setInterval(()=>{if(state.value?.jobs.some(row=>['QUEUED','RUNNING','RETRY_WAIT'].includes(row.status)))void refresh()},2000)})
onBeforeUnmount(()=>{disposed=true;clearInterval(timer);controller.abort()})
</script>

<template>
  <details class="background-panel">
    <summary>AI-фон для кадру</summary>
    <p v-if="state && !state.configured">
      Генерацію фону ще не під’єднано. Власні фото й редактор доступні.
    </p>
    <template v-else>
      <label for="background-brief">Опишіть фон без тексту</label>
      <textarea
        id="background-brief"
        v-model="brief"
        maxlength="2000"
        rows="3"
        :disabled="disabled || busy"
      />
      <button
        type="button"
        :disabled="disabled || busy || !state?.configured || !brief.trim()"
        @click="generate"
      >
        {{ busy ? 'Виконуємо дію…' : 'Згенерувати фон' }}
      </button>
      <p
        v-for="job in jobs"
        :key="job.id"
        role="status"
      >
        {{ label(job) }}
        <button
          v-if="['QUEUED','RUNNING','RETRY_WAIT'].includes(job.status)"
          type="button"
          @click="action(job,'cancel')"
        >
          Скасувати
        </button>
        <button
          v-if="job.retryAllowed"
          type="button"
          @click="action(job,'retry')"
        >
          Повторити безпечно
        </button>
        <span v-if="['UNKNOWN','MAY_STILL_RUN'].includes(job.providerOutcome) && job.status === 'FAILED'">Результат невідомий. Автоматичного повтору немає; нову генерацію можна запустити явно.</span>
      </p>
      <figure
        v-for="candidate in candidates"
        :key="candidate.id"
      >
        <img
          v-if="images[candidate.id]"
          :src="images[candidate.id]"
          alt="Кандидат фону вибраного кадру"
        >
        <figcaption>{{ candidate.appliedAt ? 'Фон уже застосовували' : 'Новий кандидат' }}</figcaption>
        <p v-if="candidate.applyBlockers.length">
          Джерело змінилося або потребує перегляду.
        </p>
        <label><input
          v-model="reviewed[candidate.id]"
          type="checkbox"
        > Переглянув фон: немає написів і небажаних деталей.</label>
        <button
          type="button"
          :disabled="disabled || busy || !reviewed[candidate.id] || !!candidate.applyBlockers.length"
          @click="applyCandidate(candidate)"
        >
          Застосувати фон
        </button>
      </figure>
    </template>
    <p
      v-if="error"
      role="alert"
    >
      {{ error }}
    </p>
  </details>
</template>

<style scoped>
.background-panel { margin-top:18px; padding-top:14px; border-top:1px solid var(--rule); min-width:0; grid-column:1/-1; font-size:13px; }
summary { cursor:pointer; padding:8px 0; font-weight:600; }
label { display:block; margin:10px 0 6px; line-height:1.5; }
textarea { width:100%; padding:8px; border:1px solid var(--rule); color:var(--ink); background:var(--paper); font:inherit; }
button { margin-top:8px; min-height:40px; padding:7px 12px; border:1px solid var(--ink); background:var(--paper); color:var(--ink); font:inherit; cursor:pointer; }
button:disabled {opacity:.5;cursor:not-allowed;}
figure {margin:18px 0;}
img {display:block;width:100%;max-height:250px;object-fit:contain;}
p {line-height:1.5;}
:focus-visible {outline:2px solid var(--ink);outline-offset:2px;}
</style>
