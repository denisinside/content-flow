import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { BACKGROUND_CONTRACT, BACKGROUND_MODEL, backgroundReportSchema, backgroundRequestSchema, type BackgroundWorkflowSettings, type BackgroundRequest, type BackgroundRelease } from './background-contracts.js';

const artifact = JSON.parse(readFileSync(new URL('../../src/visuals/workflows/background-generation/release.json', import.meta.url), 'utf8')) as { releaseId: string; configDigest: string; promptTemplateVersion: string };
export class BackgroundProviderError extends Error {
  constructor(readonly code: 'CONFIG'|'AUTH'|'RATE_LIMIT'|'QUOTA'|'INVALID_INPUT'|'INVALID_CONTRACT'|'QUALITY_REJECTED'|'PROVIDER_FAILED'|'UNKNOWN_OUTCOME'|'TIMEOUT'|'FILE_UNAVAILABLE', readonly outcome: 'NOT_SUBMITTED'|'KNOWN_FAILED'|'UNKNOWN' = 'KNOWN_FAILED') { super(code); this.name='BackgroundProviderError'; }
}
export function backgroundWorkflowSettings(env: Record<string,string|undefined> = process.env): BackgroundWorkflowSettings {
  let endpoint: URL;
  try { endpoint = new URL(env['DIFY_API_BASE_URL'] ?? ''); } catch { throw new BackgroundProviderError('CONFIG','NOT_SUBMITTED'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname.replace(/\/+$/,'') !== '/v1'
    || !z.uuid().safeParse(env['DIFY_VISUAL_BACKGROUND_WORKFLOW_ID']).success || env['DIFY_VISUAL_BACKGROUND_CONFIG_SHA256'] !== artifact.configDigest || !env['DIFY_VISUAL_BACKGROUND_API_KEY']) throw new BackgroundProviderError('CONFIG','NOT_SUBMITTED');
  const defaultOrigins=endpoint.origin==='https://api.dify.ai'?'https://api.dify.ai,https://upload.dify.ai':endpoint.origin;
  const origins = (env['DIFY_VISUAL_BACKGROUND_FILE_ORIGINS'] || defaultOrigins).split(',').map(value => value.trim());
  if (origins.some(value => { try { const url=new URL(value); return url.protocol!=='https:' || url.origin!==value || !!url.username || /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname); } catch { return true; } })) throw new BackgroundProviderError('CONFIG','NOT_SUBMITTED');
  return { endpoint: endpoint.origin+'/v1', workflowId: env['DIFY_VISUAL_BACKGROUND_WORKFLOW_ID']!, releaseId: artifact.releaseId, configDigest: artifact.configDigest,
    contractVersion: BACKGROUND_CONTRACT, promptTemplateVersion: artifact.promptTemplateVersion, apiKey: env['DIFY_VISUAL_BACKGROUND_API_KEY']!, fileOrigins: origins };
}
export function backgroundWorkflowRelease(env: Record<string,string|undefined> = process.env): BackgroundRelease {
  const { apiKey: _key, fileOrigins: _origins, ...release } = backgroundWorkflowSettings(env); void _key; void _origins; return release;
}
async function readBounded(response: Response, maximum: number): Promise<Buffer> {
  const reader=response.body?.getReader(); if (!reader) throw new BackgroundProviderError('INVALID_CONTRACT');
  let size=0;const chunks:Uint8Array[]=[];
  try { for (;;) { const item=await reader.read(); if(item.done)break;size+=item.value.byteLength;if(size>maximum){await reader.cancel();throw new BackgroundProviderError('INVALID_CONTRACT');}chunks.push(item.value); } return Buffer.concat(chunks); } finally {reader.releaseLock();}
}
function responseError(status:number, submitted=true):never {
  if(status===401||status===403)throw new BackgroundProviderError('AUTH');
  if(status===402)throw new BackgroundProviderError('QUOTA');
  if(status===429)throw new BackgroundProviderError('RATE_LIMIT');
  throw new BackgroundProviderError('PROVIDER_FAILED',submitted&&status>=500?'UNKNOWN':'KNOWN_FAILED');
}
const runSchema=z.object({id:z.uuid(),workflow_id:z.uuid(),status:z.string(),outputs:z.record(z.string(),z.unknown()).optional()}).passthrough();
type Run=z.infer<typeof runSchema>;
export class DifyBackgroundProvider {
  constructor(private readonly transport:typeof fetch=fetch) {}
  private async result(settings:BackgroundWorkflowSettings,run:Run,signal:AbortSignal) {
    if(run.workflow_id!==settings.workflowId)throw new BackgroundProviderError('INVALID_CONTRACT');
    // A failed HTTP graph can have spent an image call before timeout/review failure.
    // Run failure alone never proves that a paid generation was not submitted.
    if(run.status!=='succeeded')throw new BackgroundProviderError('PROVIDER_FAILED','UNKNOWN');
    let raw:unknown;try {raw=JSON.parse(String(run.outputs?.['background_report']));}catch{throw new BackgroundProviderError('INVALID_CONTRACT');}
    const parsed=backgroundReportSchema.safeParse(raw);if(!parsed.success)throw new BackgroundProviderError('INVALID_CONTRACT');
    if(!parsed.data.ready||parsed.data.hasText||!parsed.data.usable)throw new BackgroundProviderError('QUALITY_REJECTED');
    const files=z.array(z.object({url:z.string(),mime_type:z.enum(['image/png','image/jpeg']),size:z.number().nonnegative().optional()}).passthrough()).length(1).safeParse(run.outputs?.['background_files']);
    if(!files.success)throw new BackgroundProviderError('INVALID_CONTRACT');
    const file=files.data[0]!;let url:URL;
    try{url=new URL(file.url,settings.endpoint);}catch{throw new BackgroundProviderError('INVALID_CONTRACT');}
    const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
    const previewPath=new RegExp('^/(?:files|v1/files)/'+uuid+'/(?:file-preview|image-preview)$','i').test(url.pathname);
    const toolPath=new RegExp('^/files/tools/'+uuid+'\\.(?:png|jpe?g)$','i').test(url.pathname);
    if(!settings.fileOrigins.includes(url.origin)||url.protocol!=='https:'||url.username||url.password||url.hash||!previewPath&&!toolPath)throw new BackgroundProviderError('INVALID_CONTRACT');
    if(file.size!==undefined&&file.size>5*1024*1024)throw new BackgroundProviderError('INVALID_CONTRACT');
    let response:Response;try{response=await this.transport(url,{redirect:'error',signal,headers:{Accept:file.mime_type}});}catch{throw new BackgroundProviderError('FILE_UNAVAILABLE','UNKNOWN');}
    if(!response.ok){await response.body?.cancel();throw new BackgroundProviderError('FILE_UNAVAILABLE','UNKNOWN');}
    if(response.headers.get('content-type')?.split(';')[0]!==file.mime_type){await response.body?.cancel();throw new BackgroundProviderError('INVALID_CONTRACT');}
    const bytes=await readBounded(response,5*1024*1024);
    // Gemini Image 0.1.10 labels every blob PNG, even if Google returns JPEG.
    // Detect only these two raster signatures; the renderer still decodes/bounds it.
    const mediaType:'image/png'|'image/jpeg'|null=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes[0]===255&&bytes[1]===216&&bytes[2]===255?'image/jpeg':null;
    if(!mediaType)throw new BackgroundProviderError('INVALID_CONTRACT');
    return {bytes,mediaType,report:parsed.data,providerRunId:run.id,model:BACKGROUND_MODEL};
  }
  async execute(settings:BackgroundWorkflowSettings,jobId:string,request:BackgroundRequest,signal:AbortSignal,beforeSubmit:()=>Promise<void>,recordRun:(id:string)=>Promise<void>) {
    if(!backgroundRequestSchema.safeParse(request).success)throw new BackgroundProviderError('INVALID_INPUT','NOT_SUBMITTED');
    await beforeSubmit();let response:Response;
    try {response=await this.transport(settings.endpoint+'/workflows/run',{method:'POST',headers:{Authorization:`Bearer ${settings.apiKey}`,'Content-Type':'application/json',Accept:'text/event-stream'},redirect:'error',signal,
      body:JSON.stringify({inputs:{visual_json:JSON.stringify(request)},response_mode:'streaming',user:'job-'+jobId})});}catch{throw new BackgroundProviderError('UNKNOWN_OUTCOME','UNKNOWN');}
    if(!response.ok){await response.body?.cancel();responseError(response.status);}
    if(!response.headers.get('content-type')?.includes('text/event-stream')){await response.body?.cancel();throw new BackgroundProviderError('UNKNOWN_OUTCOME','UNKNOWN');}
    const reader=response.body?.getReader();if(!reader)throw new BackgroundProviderError('UNKNOWN_OUTCOME','UNKNOWN');
    let buffer='',size=0,captured:string|undefined,run:Run|undefined;const decoder=new TextDecoder('utf-8',{fatal:true});
    const event=async(raw:string)=>{const text=raw.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(!text||text==='[DONE]')return;
      let data:Record<string,unknown>;try {data=JSON.parse(text) as Record<string,unknown>;}catch{throw new BackgroundProviderError('INVALID_CONTRACT');}
      const id=data['workflow_run_id'];if(typeof id==='string'&&z.uuid().safeParse(id).success){if(captured&&captured!==id)throw new BackgroundProviderError('INVALID_CONTRACT');if(!captured){captured=id;await recordRun(id);}}
      if(data['event']==='workflow_finished'){const detail=data['data'] as Record<string,unknown>;const parsed=runSchema.safeParse({...detail,id:captured});if(!parsed.success)throw new BackgroundProviderError('INVALID_CONTRACT');run=parsed.data;}};
    try {for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>8*1024*1024)throw new BackgroundProviderError('INVALID_CONTRACT');buffer+=decoder.decode(next.value,{stream:true});let boundary:RegExpExecArray|null;while((boundary=/\r?\n\r?\n/.exec(buffer))){if(boundary.index>1024*1024)throw new BackgroundProviderError('INVALID_CONTRACT');await event(buffer.slice(0,boundary.index));buffer=buffer.slice(boundary.index+boundary[0].length);}if(buffer.length>1024*1024)throw new BackgroundProviderError('INVALID_CONTRACT');}buffer+=decoder.decode();if(buffer.trim())await event(buffer);}
    catch(error){if(error instanceof BackgroundProviderError)throw error;throw new BackgroundProviderError('UNKNOWN_OUTCOME','UNKNOWN');}finally{reader.releaseLock();}
    if(!run)throw new BackgroundProviderError('UNKNOWN_OUTCOME','UNKNOWN');
    const result=await this.result(settings,run,signal);if(result.report.frameId!==request.frameId||result.report.width!==request.width||result.report.height!==request.height)throw new BackgroundProviderError('INVALID_CONTRACT');return result;
  }
  async resume(settings:BackgroundWorkflowSettings,runId:string,signal:AbortSignal) {
    if(!z.uuid().safeParse(runId).success)throw new BackgroundProviderError('INVALID_INPUT','NOT_SUBMITTED');
    while(!signal.aborted){let response:Response;try{response=await this.transport(settings.endpoint+'/workflows/run/'+runId,{headers:{Authorization:`Bearer ${settings.apiKey}`,Accept:'application/json'},redirect:'error',signal});}catch{throw new BackgroundProviderError('UNKNOWN_OUTCOME','UNKNOWN');}
      if(!response.ok){await response.body?.cancel();throw new BackgroundProviderError(response.status===429?'RATE_LIMIT':response.status===401||response.status===403?'AUTH':'UNKNOWN_OUTCOME','UNKNOWN');}let raw:unknown;try{raw=JSON.parse((await readBounded(response,1024*1024)).toString('utf8'));}catch{throw new BackgroundProviderError('INVALID_CONTRACT','UNKNOWN');}
      const parsed=runSchema.safeParse(raw);if(!parsed.success||parsed.data.id!==runId||parsed.data.workflow_id!==settings.workflowId)throw new BackgroundProviderError('INVALID_CONTRACT');
      if(!['running','paused'].includes(parsed.data.status))return this.result(settings,parsed.data,signal);
      await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,1500);signal.addEventListener('abort',finish,{once:true});});
    }throw new BackgroundProviderError('TIMEOUT','UNKNOWN');
  }
}
