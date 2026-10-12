import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DifyBackgroundProvider } from './background-provider.js';
import type { BackgroundRequest,BackgroundWorkflowSettings } from './background-contracts.js';
const settings:BackgroundWorkflowSettings={endpoint:'https://api.dify.ai/v1',workflowId:randomUUID(),releaseId:'synthetic',configDigest:'a'.repeat(64),contractVersion:'visual-background-v1',promptTemplateVersion:'visual-background-http-v2',apiKey:'synthetic-secret',fileOrigins:['https://api.dify.ai']};
const request:BackgroundRequest={schemaVersion:'visual-background-v1',frameId:randomUUID(),visualBrief:'Calm blue background',width:1080,height:1350,templateId:'editorial',palette:{background:'#ffffff',text:'#20262b',accent:'#343a40'}};
function output(url='https://api.dify.ai/files/00000000-0000-4000-8000-000000000001/file-preview',hasText=false){return {background_files:[{url,mime_type:'image/png'}],background_report:JSON.stringify({schemaVersion:'visual-background-report-v1',frameId:request.frameId,width:1080,height:1350,model:'gemini-nano-banana-2.1',ready:!hasText,hasText,usable:true,reason:'Synthetic review'})};}
describe('Dify HTTP visual background trust boundary',()=>{
  it('captures run identity and downloads one bounded image without forwarding credentials',async()=>{
    const runId=randomUUID(),calls:Array<{url:string;init:RequestInit|undefined}>=[];
    const transport:typeof fetch=async(url,init)=>{calls.push({url:String(url),init});if(calls.length===1)return new Response(`data: ${JSON.stringify({event:'workflow_started',workflow_run_id:runId})}\n\ndata: ${JSON.stringify({event:'workflow_finished',workflow_run_id:runId,data:{workflow_id:settings.workflowId,status:'succeeded',outputs:output()}})}\n\n`,{headers:{'content-type':'text/event-stream'}});return new Response(Buffer.from([137,80,78,71,13,10,26,10]),{headers:{'content-type':'image/png'}});};
    const seen:string[]=[];const result=await new DifyBackgroundProvider(transport).execute(settings,randomUUID(),request,new AbortController().signal,async()=>{},async id=>{seen.push(id);});
    expect(result.providerRunId).toBe(runId);expect(seen).toEqual([runId]);expect(result.model).toBe('gemini-nano-banana-2.1');expect(new Headers(calls[1]!.init?.headers).has('Authorization')).toBe(false);expect(calls[1]!.init?.redirect).toBe('error');
  });
  it('rejects text-bearing images, foreign file origins and obsolete model reports before download',async()=>{
    const old=output();old.background_report=old.background_report.replace('gemini-nano-banana-2.1','gemini-2.5-flash-image');
    for(const outputs of [output(undefined,true),output('http://127.0.0.1/private'),old]){let calls=0;const runId=randomUUID();const provider=new DifyBackgroundProvider(async()=>{calls++;return Response.json({id:runId,workflow_id:settings.workflowId,status:'succeeded',outputs});});await expect(provider.resume(settings,runId,new AbortController().signal)).rejects.toThrow();expect(calls).toBe(1);}
  });
  it('submission loss is unknown and is never automatically posted again',async()=>{
    let calls=0;const provider=new DifyBackgroundProvider(async()=>{calls++;throw new TypeError('Synthetic disconnect');});await expect(provider.execute(settings,randomUUID(),request,new AbortController().signal,async()=>{},async()=>{})).rejects.toMatchObject({code:'UNKNOWN_OUTCOME',outcome:'UNKNOWN'});expect(calls).toBe(1);
  });
  it('accepts exact Dify tool raster paths and rejects other paths or origins',async()=>{
    const toolSettings={...settings,fileOrigins:['https://upload.dify.ai']};
    const good='https://upload.dify.ai/files/tools/7881f9c6-fced-4790-96f6-2824023498f8.png?timestamp=1&nonce=synthetic&sign=synthetic';
    for(const url of [good,good.replace('.png','.svg'),good.replace('/tools/','/other/'),good.replace('upload.dify.ai','attacker.example')]){
      let calls=0;const runId=randomUUID();const provider=new DifyBackgroundProvider(async()=>++calls===1?Response.json({id:runId,workflow_id:settings.workflowId,status:'succeeded',outputs:output(url)}):new Response(Buffer.from([137,80,78,71,13,10,26,10]),{headers:{'content-type':'image/png'}}));
      if(url===good)expect((await provider.resume(toolSettings,runId,new AbortController().signal)).mediaType).toBe('image/png');
      else {await expect(provider.resume(toolSettings,runId,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_CONTRACT'});expect(calls).toBe(1);}
    }
  });
  it('uses actual JPEG bytes despite plugin PNG label and rejects non-raster bytes',async()=>{
    for(const bytes of [Buffer.from([255,216,255,224]),Buffer.from('<html>')]){
      const runId=randomUUID();let calls=0;const provider=new DifyBackgroundProvider(async()=>++calls===1?Response.json({id:runId,workflow_id:settings.workflowId,status:'succeeded',outputs:output()}):new Response(bytes,{headers:{'content-type':'image/png'}}));
      if(bytes[0]===255)expect((await provider.resume(settings,runId,new AbortController().signal)).mediaType).toBe('image/jpeg');
      else await expect(provider.resume(settings,runId,new AbortController().signal)).rejects.toMatchObject({code:'INVALID_CONTRACT'});
    }
  });
  it('a failed HTTP graph cannot grant a safe paid resubmission',async()=>{
    const runId=randomUUID();const provider=new DifyBackgroundProvider(async()=>Response.json({id:runId,workflow_id:settings.workflowId,status:'failed'}));
    await expect(provider.resume(settings,runId,new AbortController().signal)).rejects.toMatchObject({code:'PROVIDER_FAILED',outcome:'UNKNOWN'});
  });
  it('a rate limit while reconciling an existing run never grants permission to resubmit',async()=>{
    let posts=0;const provider=new DifyBackgroundProvider(async(_url,init)=>{if(init?.method==='POST')posts++;return new Response('',{status:429});});
    await expect(provider.resume(settings,randomUUID(),new AbortController().signal)).rejects.toMatchObject({code:'RATE_LIMIT',outcome:'UNKNOWN'});expect(posts).toBe(0);
  });
});
