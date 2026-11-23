import { randomUUID, createHash } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { JobFailure, JobFenceLost, type JobContext, type JobHandler } from '../jobs/contracts.js';
import { canonicalManifestHash } from '../jobs/job-service.js';
import { BACKGROUND_MODEL, backgroundManifestSchema } from './background-contracts.js';
import { backgroundWorkflowSettings, BackgroundProviderError, DifyBackgroundProvider } from './background-provider.js';
import type { VisualBackgroundService } from './background.service.js';
import type { VisualRenderer } from './visual-renderer.js';
import { normalizeGeneratedBackground } from './background-normalization.js';
import type { PrivateAssetStore } from '../storage/private-asset-store.js';
const json=(value:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
type Result={assetId:string;bucket:string;objectKey:string;sha256:string;bytes:number;executionId:string;report:Prisma.InputJsonValue};
export function createBackgroundJobHandler(deps:{prisma:PrismaClient;backgrounds:VisualBackgroundService;renderer:VisualRenderer;assets:PrivateAssetStore;provider?:Pick<DifyBackgroundProvider,'execute'|'resume'>;env?:Record<string,string|undefined>}):JobHandler{
  const env=deps.env??process.env,provider=deps.provider??new DifyBackgroundProvider(),staged=new Map<string,Result>();
  async function discard(context:JobContext){const row=staged.get(context.attempt.id);if(!row)return;staged.delete(context.attempt.id);
    const project=await deps.prisma.project.findUnique({where:{id:context.job.projectId},select:{workspaceId:true}});
    if(project)await deps.prisma.privateObjectDeletion.upsert({where:{bucket_objectKey:{bucket:row.bucket,objectKey:row.objectKey}},update:{},create:{projectId:context.job.projectId,workspaceId:project.workspaceId,requestedBy:context.job.requestedBy,bucket:row.bucket,objectKey:row.objectKey}});
    await deps.assets.remove(row.bucket,row.objectKey);
  }
  async function call(context:JobContext,runId?:string):Promise<Result>{
    if(context.job.contractVersion!=='visual-background-v1')throw new JobFailure('INPUT_INTEGRITY','NOT_SUBMITTED');
    const manifest=backgroundManifestSchema.parse(context.job.inputManifest),settings=backgroundWorkflowSettings(env);
    const {apiKey:_key,fileOrigins:_origins,...release}=settings;void _key;void _origins;
    if(canonicalManifestHash(release)!==canonicalManifestHash(manifest.release))throw new JobFailure('CONFIG_CHANGED','NOT_SUBMITTED');
    const execution=await deps.prisma.aIExecution.upsert({where:{attemptId:context.attempt.id},update:{},create:{projectId:context.job.projectId,jobId:context.job.id,attemptId:context.attempt.id,workflowId:settings.workflowId,releaseId:settings.releaseId,configDigest:settings.configDigest,contractVersion:settings.contractVersion,promptTemplateVersion:settings.promptTemplateVersion,inputManifest:json(manifest),inputHash:context.job.inputHash,providerRunId:runId??null}});
    let captured=runId,phase='provider_request';
    const record=async(id:string)=>{if(captured&&captured!==id)throw new JobFailure('INVALID_CONTRACT');captured=id;await context.recordProviderRun(id);await deps.prisma.aIExecution.updateMany({where:{id:execution.id,status:'RUNNING'},data:{providerRunId:id}});};
    try{
      let generated:Awaited<ReturnType<DifyBackgroundProvider['execute']>>;
      if(runId)generated=await provider.resume(settings,runId,context.signal);
      else try{generated=await provider.execute(settings,context.job.id,manifest.request,context.signal,context.recordSubmissionIntent,record);}catch(error){if(!captured||!(error instanceof BackgroundProviderError)||!['UNKNOWN_OUTCOME','TIMEOUT','FILE_UNAVAILABLE'].includes(error.code))throw error;generated=await provider.resume(settings,captured,context.signal);}
      phase='provider_result_validation';
      if(captured&&generated.providerRunId!==captured||generated.report.frameId!==manifest.frameId||generated.report.width!==manifest.request.width||generated.report.height!==manifest.request.height)throw new JobFailure('INVALID_CONTRACT');
      if(context.signal.aborted)throw new JobFenceLost();
      phase='normalize_image';
      const normalized=await normalizeGeneratedBackground(deps.renderer,generated.bytes,generated.mediaType,context.signal);
      if(context.signal.aborted)throw new JobFenceLost();
      phase='store_image';
      const assetId=randomUUID(),stored=await deps.assets.put(context.job.projectId,assetId,normalized.bytes);
      const result={assetId,bucket:stored.bucket,objectKey:stored.objectKey,sha256:createHash('sha256').update(normalized.bytes).digest('hex'),bytes:normalized.bytes.length,executionId:execution.id,report:json(generated.report)};
      staged.set(context.attempt.id,result);
      if(context.signal.aborted){await discard(context);throw new JobFenceLost();}
      return result;
    }catch(error){
      console.error(JSON.stringify({event:'VISUAL_BACKGROUND_GENERATION_ERROR',jobId:context.job.id,attemptId:context.attempt.id,phase,errorType:error instanceof Error?error.constructor.name:typeof error,code:error instanceof BackgroundProviderError?error.code:undefined,status:error&&typeof error==='object'&&'status' in error?(error as {status:unknown}).status:undefined}));
      if(error instanceof JobFailure||error instanceof JobFenceLost)throw error;
      if(error instanceof BackgroundProviderError)throw new JobFailure(error.code,error.outcome);
      if(error instanceof ServiceUnavailableException && phase==='normalize_image')throw new JobFailure('ENGINE_UNAVAILABLE',captured?'UNKNOWN':'NOT_SUBMITTED');
      if(error instanceof ServiceUnavailableException && phase==='store_image')throw new JobFailure('STORAGE_UNAVAILABLE',captured?'UNKNOWN':'NOT_SUBMITTED');
      throw new JobFailure('INVALID_CONTRACT',captured?'UNKNOWN':'NOT_SUBMITTED');
    }
  }
  return{operation:'VISUAL_BACKGROUND_GENERATION',validateSubmission:(tx,job)=>deps.backgrounds.validateSubmission(tx,job),execute:context=>call(context),resume:(context,id)=>call(context,id),
    async commit(tx,raw,job){const result=raw as Result,manifest=backgroundManifestSchema.parse(job.inputManifest);
      const existing=await tx.visualBackgroundCandidate.findUnique({where:{jobId:job.id}});if(existing)return{candidateId:existing.id,assetId:existing.assetId};
      const revision=await tx.visualCompositionRevision.findFirst({where:{projectId:job.projectId,id:manifest.compositionRevisionId}});if(!revision||revision.sha256!==manifest.compositionHash)throw new JobFailure('INPUT_INTEGRITY');
      // A successful historical candidate survives ordinary edits; unsafe source evidence still blocks acceptance.
      const inspection=await deps.backgrounds.visuals.inspectParent(tx,job.projectId,manifest.format,revision);if(inspection.blockingReasons.length)throw new JobFailure('SOURCE_BLOCKED');
      await tx.asset.create({data:{id:result.assetId,projectId:job.projectId,bucket:result.bucket,objectKey:result.objectKey,mediaType:'image/png',bytes:BigInt(result.bytes),sha256:result.sha256,state:'AVAILABLE',purpose:'GENERATED',createdBy:job.requestedBy}});
      const candidate=await tx.visualBackgroundCandidate.create({data:{projectId:job.projectId,compositionRevisionId:revision.id,frameId:manifest.frameId,jobId:job.id,aiExecutionId:result.executionId,assetId:result.assetId,report:result.report}});
      await tx.aIExecution.update({where:{id:result.executionId},data:{status:'SUCCEEDED',finishedAt:new Date(),model:BACKGROUND_MODEL}});return{candidateId:candidate.id,assetId:result.assetId};},
    async completed(context){staged.delete(context.attempt.id);},async failed(context,error){await discard(context);const current=await deps.prisma.job.findUnique({where:{id:context.job.id},select:{providerOutcome:true,errorCategory:true}});await deps.prisma.aIExecution.updateMany({where:{attemptId:context.attempt.id,status:'RUNNING'},data:{status:current&&['UNKNOWN','MAY_STILL_RUN'].includes(current.providerOutcome)?'OUTCOME_UNKNOWN':'FAILED',finishedAt:new Date(),errorCategory:current?.errorCategory??(error instanceof JobFailure?error.category:'EXECUTION_FAILED')}});}};
}
