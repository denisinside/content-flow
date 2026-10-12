import { ConflictException, NotFoundException, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { compositionSchema } from '@contextflow/visuals';
import type { Prisma, PrismaClient, Job } from '../generated/prisma/client.js';
import { DurableJobService, canonicalManifestHash } from '../jobs/job-service.js';
import { jobView } from '../jobs/contracts.js';
import { backgroundWorkflowRelease, BackgroundProviderError } from './background-provider.js';
import { backgroundManifestSchema, backgroundReportSchema, backgroundFormatSchema, type BackgroundGenerateInput, type BackgroundApplyInput } from './background-contracts.js';
import type { VisualService } from './visual.service.js';
const json=(value:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export class VisualBackgroundService {
  constructor(readonly prisma:PrismaClient,readonly visuals:VisualService,readonly jobs:DurableJobService,private readonly env:Record<string,string|undefined>=process.env){}
  async lock(tx:Prisma.TransactionClient,user:string,project:string){
    const rows=await tx.$queryRaw<{id:string}[]>`SELECT p."id" FROM contextflow."Project" p JOIN contextflow."Workspace" w ON w."id"=p."workspaceId" JOIN contextflow."WorkspaceMember" m ON m."workspaceId"=w."id" WHERE p."id"=${project}::uuid AND p."archivedAt" IS NULL AND p."trashedAt" IS NULL AND w."archivedAt" IS NULL AND w."trashedAt" IS NULL AND m."userId"=${user}::uuid AND m."leftAt" IS NULL FOR UPDATE OF p FOR SHARE OF w,m`;
    if(!rows.length)throw new NotFoundException('Project not found');
  }
  async list(user:string,project:string,rawFormat:string){
    const format=backgroundFormatSchema.parse(rawFormat);let release=null;
    try {release=backgroundWorkflowRelease(this.env);}catch(error){if(!(error instanceof BackgroundProviderError&&error.code==='CONFIG'))throw error;}
    const data=await this.prisma.$transaction(async tx=>{await this.lock(tx,user,project);
      const rows=await tx.visualBackgroundCandidate.findMany({where:{projectId:project},orderBy:{createdAt:'desc'},take:30});
      const candidates=[];
      for(const row of rows){const revision=await tx.visualCompositionRevision.findFirst({where:{id:row.compositionRevisionId,projectId:project},include:{composition:true}});if(!revision||revision.composition.format!==format)continue;
        const asset=await tx.asset.findFirst({where:{id:row.assetId,projectId:project,state:'AVAILABLE'}});if(!asset)continue;
        const inspection=await this.visuals.inspectParent(tx,project,format,revision);const applications=await tx.visualBackgroundApplication.findMany({where:{candidateId:row.id,projectId:project},orderBy:{createdAt:'desc'},take:1});
        candidates.push({id:row.id,frameId:row.frameId,sourceRevisionId:row.compositionRevisionId,sourceCompositionHash:revision.sha256,asset:{id:asset.id,sha256:asset.sha256},report:row.report,appliedAt:applications[0]?.createdAt.toISOString()??null,applyBlockers:[...inspection.staleReasons,...inspection.blockingReasons]});}
      const jobs=await tx.job.findMany({where:{projectId:project,operation:'VISUAL_BACKGROUND_GENERATION'},orderBy:{createdAt:'desc'},take:30});
      return{candidates,jobs:jobs.filter(row=>(row.inputManifest as Record<string,unknown>)['format']===format).map(row=>({...jobView(row),frameId:(row.inputManifest as Record<string,unknown>)['frameId']}))};});
    return{configured:!!release,release,...data};
  }
  async generate(user:string,project:string,formatRaw:string,input:BackgroundGenerateInput){
    const format=backgroundFormatSchema.parse(formatRaw);
    return this.prisma.$transaction(async tx=>{await this.lock(tx,user,project);
      const existing=await tx.job.findUnique({where:{projectId_operation_commandKey:{projectId:project,operation:'VISUAL_BACKGROUND_GENERATION',commandKey:input.commandKey}}});
      if(existing){const old=backgroundManifestSchema.parse(existing.inputManifest);if(old.format!==format||old.compositionRevisionId!==input.compositionRevisionId||old.frameId!==input.frameId||old.request.visualBrief!==input.visualBrief)throw new ConflictException('Command key input changed');return{jobId:existing.id,status:existing.status,replayed:true};}
      const revision=await tx.visualCompositionRevision.findFirst({where:{id:input.compositionRevisionId,projectId:project},include:{composition:{include:{draft:true}}}});
      if(!revision||revision.composition.format!==format)throw new NotFoundException('Visual revision not found');
      const owner=revision.composition,draft=owner.draft;
      if(owner.revision!==input.expectedRevision||!draft||draft.counter!==input.expectedDraftCounter||draft.sha256!==revision.sha256)throw new ConflictException('Save an exact visual checkpoint before generation');
      const inspection=await this.visuals.inspectParent(tx,project,format,revision);if(!inspection.eligible)throw new ConflictException('Visual source needs review');
      const content=compositionSchema.parse(revision.content),frame=content.frames.find(row=>row.id===input.frameId);if(!frame)throw new NotFoundException('Frame not found');
      const release=backgroundWorkflowRelease(this.env),text=frame.layers.find(row=>row.type==='text');
      const manifest=backgroundManifestSchema.parse({schemaVersion:'visual-background-v1',format,compositionRevisionId:revision.id,compositionHash:revision.sha256,frameId:frame.id,frameHash:canonicalManifestHash(frame),parentKind:revision.parentKind,parentRevisionId:revision.parentRevisionId,parentRevisionHash:revision.parentRevisionHash,parentReviewCounter:revision.parentReviewCounter,workspaceStyleRevision:revision.workspaceStyleRevision,
        request:{schemaVersion:'visual-background-v1',frameId:frame.id,visualBrief:input.visualBrief,width:1080,height:content.height,templateId:frame.templateId,palette:{background:frame.background,text:text?.type==='text'?text.color:'#20262b',accent:frame.layers.find(row=>row.type==='rect')?.color??'#343a40'}},release});
      const job=await this.jobs.create(tx,{projectId:project,userId:user,operation:'VISUAL_BACKGROUND_GENERATION',contractVersion:'visual-background-v1',commandKey:input.commandKey,inputManifest:json(manifest) as Prisma.InputJsonObject});return{jobId:job.id,status:job.status,replayed:false};});
  }
  async apply(user:string,project:string,formatRaw:string,candidateId:string,input:BackgroundApplyInput){
    const format=backgroundFormatSchema.parse(formatRaw),inputHash=canonicalManifestHash({candidateId,format,...input});
    const result=await this.prisma.$transaction(async tx=>{await this.lock(tx,user,project);
      const prior=await tx.visualBackgroundApplication.findUnique({where:{projectId_commandKey:{projectId:project,commandKey:input.commandKey}}});
      if(prior){if(prior.inputHash!==inputHash)throw new ConflictException('Command key input changed');return{applied:false,replayed:true};}
      const candidate=await tx.visualBackgroundCandidate.findFirst({where:{id:candidateId,projectId:project}});if(!candidate)throw new NotFoundException('Background candidate not found');
      const source=await tx.visualCompositionRevision.findFirst({where:{id:candidate.compositionRevisionId,projectId:project},include:{composition:{include:{draft:true}}}});if(!source||source.composition.format!==format)throw new NotFoundException('Visual source not found');
      const owner=source.composition,draft=owner.draft;if(!draft||owner.revision!==input.expectedRevision||draft.counter!==input.expectedDraftCounter)throw new ConflictException('Visual draft changed');
      const inspection=await this.visuals.inspectParent(tx,project,format,draft);if(!inspection.eligible||draft.parentRevisionId!==source.parentRevisionId||draft.parentReviewCounter!==source.parentReviewCounter)throw new ConflictException('Background source needs review');
      const content=compositionSchema.parse(draft.content),original=compositionSchema.parse(source.content);if(content.height!==original.height)throw new ConflictException('Canvas size changed');
      const frame=content.frames.find(row=>row.id===candidate.frameId);if(!frame)throw new ConflictException('Target frame removed');
      const report=backgroundReportSchema.parse(candidate.report);if(!report.ready||report.hasText||!report.usable)throw new BadRequestException('Background failed quality review');
      const asset=await tx.asset.findFirst({where:{id:candidate.assetId,projectId:project,state:'AVAILABLE',purpose:'GENERATED'}});if(!asset)throw new ConflictException('Background asset unavailable');
      frame.layers=frame.layers.filter(layer=>layer.type!=='image'||layer.role!=='background');
      frame.layers.unshift({id:randomUUID(),type:'image',role:'background',x:0,y:0,width:1080,height:content.height,fit:'cover',resource:{type:'project',id:asset.id,sha256:asset.sha256}});
      compositionSchema.parse(content);
      await tx.visualCompositionDraft.update({where:{id:draft.id},data:{content:json(content),sha256:canonicalManifestHash(content),counter:{increment:1},updatedBy:user,updatedAt:new Date()}});
      await tx.visualComposition.update({where:{id:owner.id},data:{revision:{increment:1}}});
      await tx.visualBackgroundApplication.create({data:{projectId:project,candidateId,commandKey:input.commandKey,inputHash,appliedBy:user,draftCounter:draft.counter+1}});
      return{applied:true,replayed:false};});
    return{...result,state:await this.visuals.get(user,project,format)};
  }
  async validateSubmission(tx:Prisma.TransactionClient,job:Job){const input=backgroundManifestSchema.parse(job.inputManifest);const row=await tx.visualCompositionRevision.findFirst({where:{id:input.compositionRevisionId,projectId:job.projectId}});if(!row||row.sha256!==input.compositionHash||canonicalManifestHash(row.content)!==row.sha256)throw new ConflictException('Frozen visual source invalid');const inspection=await this.visuals.inspectParent(tx,job.projectId,input.format,row);if(!inspection.eligible)throw new ConflictException('Frozen visual source needs review');}
}
