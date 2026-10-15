import {readRecognitionCommand,readRecognitionResultRequest,type MetadataRecognitionCommand,type MetadataRecognitionOpen,type RecognitionCode} from '../shared/metadata-recognition.js';
import type {RecognitionMapping} from '../shared/recognition-mapping.js';
import type {FingerprintIdentification} from '../shared/audio-fingerprint.js';
import type {MetadataWorkflowClaim} from '../shared/metadata-workflow.js';
import type {MetadataBatchReviewLease} from '../shared/metadata-batch-review.js';
import type {MetadataRecognitionRepository} from './metadata-recognition.js';
export type RecognitionScope={claim:MetadataWorkflowClaim;lease:MetadataBatchReviewLease};
export interface RecognitionPorts{
 claimRetry?(jobId:string):{scope:RecognitionScope|null;through:number;done:boolean};
 claimNext?(jobId:string,after:number):{scope:RecognitionScope|null;through:number;done:boolean};
 retain?(scope:RecognitionScope,result:FingerprintIdentification):RecognitionMapping;
 restore?(scope:RecognitionScope,itemId:string,value:RecognitionMapping):Promise<FingerprintIdentification>;
 preflight(signal:AbortSignal):Promise<void>;
 claim(jobId:string):RecognitionScope;
 valid(scope:RecognitionScope):boolean;
 close(scope:RecognitionScope,releaseClaim:boolean):void;
 prepareResume(scope:RecognitionScope):void;
 find(scope:RecognitionScope,itemId:string,signal:AbortSignal,onLookup:()=>void):Promise<FingerprintIdentification>;
 publicResult(scope:RecognitionScope,token:string):FingerprintIdentification|null;
 changed(jobId:string):void;
}
type Context={reviewOnly?:boolean;scope:RecognitionScope;results:Map<string,FingerprintIdentification>};
export class RecognitionFailure extends Error{constructor(readonly code:RecognitionCode){super(code);}}
function codeFor(error:unknown,lookup:boolean):RecognitionCode{if(error instanceof RecognitionFailure)return error.code;const message=error instanceof Error?error.message:'';if(/应用密钥|凭据|认证/.test(message))return 'auth-required';if(/来源.*变化|音频.*变化|不一致/.test(message))return 'source-changed';if(/离线|不可读|不存在|移除/.test(message))return 'source-unavailable';if(/启用|暂停|来源状态/.test(message))return 'source-disabled';if(/429|限流|退避/.test(message))return 'rate-limited';if(/超时|期限|timeout/i.test(message))return 'timeout';if(/容量|预算|已满|4份/.test(message))return 'capacity';return lookup?'lookup-failed':'decode-failed';}
export class MetadataRecognitionManager{
 private readonly contexts=new Map<string,Context>();private active:{jobId:string;controller:AbortController;work:Promise<void>}|null=null;private scheduled:NodeJS.Timeout|undefined;private held:string|null=null;private readonly timer:NodeJS.Timeout;
 constructor(private readonly repo:MetadataRecognitionRepository,private readonly ports:RecognitionPorts,private dormant=false){this.timer=setInterval(()=>this.prune(),2000);this.timer.unref();}
 command(raw:unknown){if(this.held||this.dormant)throw new Error('曲库维护期间不能处理后台识别');const request=readRecognitionCommand(raw),result=this.repo.command(request);if(!result.replayed){if(request.action==='pause'||request.action==='cancel'){if(this.active?.jobId===request.jobId)this.active.controller.abort(new Error('后台识别已取消'));else if(request.action==='cancel')this.drop(request.jobId,true,'cancelled','cancelled');}this.ports.changed(request.jobId);this.kick();}return {...result.run,replayed:result.replayed};}
 receipt(raw:unknown){return this.repo.receipt(raw);}
 private kick():void{if(this.held||this.active||this.scheduled)return;this.scheduled=setTimeout(()=>{this.scheduled=undefined;const jobId=this.repo.next();if(!jobId||this.held)return;const controller=new AbortController(),work=this.run(jobId,controller.signal).catch(()=>{this.drop(jobId,true,'failed','internal');}).finally(()=>{if(this.active?.jobId===jobId)this.active=null;this.kick();});this.active={jobId,controller,work};},0);this.scheduled.unref();}
 private async run(jobId:string,signal:AbortSignal):Promise<void>{if(this.repo.raw(jobId)?.mode==='library')return this.runLibrary(jobId,signal);let context=this.contexts.get(jobId),generation=0;
  try{await this.ports.preflight(signal);signal.throwIfAborted();if(this.repo.raw(jobId)?.state!=='queued')return;if(context&&!this.ports.valid(context.scope)){this.ports.close(context.scope,true);this.contexts.delete(jobId);context=undefined;}if(!context){const scope=this.ports.claim(jobId);context={scope,results:new Map()};this.contexts.set(jobId,context);}else this.ports.prepareResume(context.scope);generation=this.repo.bind(jobId,context.scope.claim.claimToken,context.scope.claim.items.map(i=>i.id));this.ports.changed(jobId);
   for(const item of context.scope.claim.items){signal.throwIfAborted();if(!this.ports.valid(context.scope))throw new RecognitionFailure('scope-unavailable');if(context.results.has(item.id)&&this.ports.publicResult(context.scope,context.results.get(item.id)!.identificationToken))continue;if(Date.now()+45000>=Date.parse(context.scope.lease.expiresAt)){this.repo.finish(jobId,'review','timeout');this.ports.changed(jobId);return;}let lookup=false;this.repo.phase(jobId,generation,context.scope.claim.claimToken,item.id,'decoding');this.ports.changed(jobId);
    try{const found=await this.ports.find(context.scope,item.id,signal,()=>{lookup=true;this.repo.phase(jobId,generation,context!.scope.claim.claimToken,item.id,'lookup');this.ports.changed(jobId);});signal.throwIfAborted();if(!this.repo.owns(jobId,generation,context.scope.claim.claimToken)||!this.ports.valid(context.scope)||found.itemId!==item.id||Date.parse(found.expiresAt)<=Date.now())throw new RecognitionFailure('scope-unavailable');context.results.set(item.id,structuredClone(found));this.repo.phase(jobId,generation,context.scope.claim.claimToken,item.id,found.recordings.length?'ready':'empty',found.recordings.length?'none':'no-match');}
    catch(error){if(signal.aborted||!this.repo.owns(jobId,generation,context.scope.claim.claimToken))throw error;const code=codeFor(error,lookup);this.repo.phase(jobId,generation,context.scope.claim.claimToken,item.id,'failed',code);if(['auth-required','source-disabled','capacity'].includes(code)){this.repo.finish(jobId,context.results.size?'review':'failed',code);if(!context.results.size)this.drop(jobId,true,'failed',code);this.ports.changed(jobId);return;}}
    this.ports.changed(jobId);await new Promise<void>(resolve=>setTimeout(resolve,0));
   }this.repo.finish(jobId,'review');this.ports.changed(jobId);
  }catch(error){const current=this.repo.raw(jobId);if(current?.state==='stopping'){if(current.stop_action==='pause'&&context&&this.ports.valid(context.scope)){this.repo.finish(jobId,'paused','paused');this.ports.changed(jobId);}else this.drop(jobId,true,current.stop_action==='cancel'?'cancelled':'interrupted',current.stop_action==='cancel'?'cancelled':'preview-lost');}else if(signal.aborted){if(current&&['paused','cancelled'].includes(current.state)){if(current.state==='cancelled')this.drop(jobId,true,'cancelled','cancelled');}else this.drop(jobId,true,'interrupted','preview-lost');}else{const code=codeFor(error,false);if(current?.state==='queued'&&context&&code==='auth-required'&&this.ports.valid(context.scope)&&[...context.results.values()].some(r=>this.ports.publicResult(context!.scope,r.identificationToken))){this.repo.finish(jobId,'paused',code);this.ports.changed(jobId);}else this.drop(jobId,true,'failed',code);}}
 }
 private async runLibrary(jobId:string,signal:AbortSignal):Promise<void>{
  let context:Context|undefined;let generation=0;
  const release=(state:'queued'|'paused'|'cancelled'|'interrupted'|'failed'|'done',code:RecognitionCode='none')=>{
   this.contexts.delete(jobId);if(context)this.ports.close(context.scope,true);context=undefined;
   this.repo.finish(jobId,state,code,true);this.ports.changed(jobId);
  };
  try{
   await this.ports.preflight(signal);signal.throwIfAborted();
   if(this.repo.raw(jobId)?.state!=='queued')return;
   if(!this.ports.claimNext||!this.ports.retain||!this.ports.restore)throw new RecognitionFailure('internal');
   const current=this.repo.raw(jobId)!;if(current.retry_active&&!this.ports.claimRetry)throw new RecognitionFailure('internal');const next=current.retry_active?this.ports.claimRetry!(jobId):this.ports.claimNext(jobId,current.cursor);
   if(!next.scope){this.repo.cursor(jobId,next.through);release(next.done?'done':'queued');return;}
   context={scope:next.scope,results:new Map()};this.contexts.set(jobId,context);
   generation=this.repo.bind(jobId,context.scope.claim.claimToken,context.scope.claim.items.map(item=>item.id));this.ports.changed(jobId);
   for(const item of context.scope.claim.items){
    signal.throwIfAborted();if(!this.ports.valid(context.scope))throw new RecognitionFailure('scope-unavailable');
    if(Date.now()+45000>=Date.parse(context.scope.lease.expiresAt)){release('queued','timeout');return;}
    let lookup=false;
    try{
     let found:FingerprintIdentification|undefined;const saved=current.retry_active?null:this.repo.mapping(jobId,item.id);
     if(saved)try{found=await this.ports.restore(context.scope,item.id,saved);}catch{signal.throwIfAborted();}
     if(!found){this.repo.forget(jobId,item.id);this.repo.phase(jobId,generation,context.scope.claim.claimToken,item.id,'decoding');this.ports.changed(jobId);
      found=await this.ports.find(context.scope,item.id,signal,()=>{lookup=true;this.repo.phase(jobId,generation,context!.scope.claim.claimToken,item.id,'lookup');this.ports.changed(jobId);});
     }
     signal.throwIfAborted();if(!this.repo.owns(jobId,generation,context.scope.claim.claimToken)||!this.ports.valid(context.scope)||found.itemId!==item.id)throw new RecognitionFailure('scope-unavailable');
     const mapping=this.ports.retain(context.scope,found);this.repo.retain(jobId,generation,context.scope.claim.claimToken,item.id,mapping);
     this.repo.phase(jobId,generation,context.scope.claim.claimToken,item.id,found.recordings.length?'ready':'empty',found.recordings.length?'none':'no-match');
    }catch(error){
     if(signal.aborted||!this.repo.owns(jobId,generation,context.scope.claim.claimToken))throw error;
     const code=codeFor(error,lookup);this.repo.phase(jobId,generation,context.scope.claim.claimToken,item.id,'failed',code);
     if(['auth-required','source-disabled','capacity','rate-limited'].includes(code)){release('failed',code);return;}
    }
    this.repo.advance(jobId,generation,context.scope.claim.claimToken,item.id);this.ports.changed(jobId);await new Promise<void>(resolve=>setTimeout(resolve,0));
   }
   this.repo.cursor(jobId,next.through);release(next.done?'done':'queued');
  }catch(error){
   const current=this.repo.raw(jobId);
   if(current?.stop_action==='pause'||current?.state==='paused')release('paused','paused');
   else if(current?.stop_action==='cancel'||current?.state==='cancelled')release('cancelled','cancelled');
   else if(signal.aborted)release('interrupted','preview-lost');else release('failed',codeFor(error,false));
  }
 }
 private drop(jobId:string,release:boolean,state:'done'|'failed'|'cancelled'|'interrupted',code:RecognitionCode):void{const context=this.contexts.get(jobId);this.contexts.delete(jobId);if(context)this.ports.close(context.scope,release);if(this.repo.raw(jobId))this.repo.finish(jobId,state,code,true);this.ports.changed(jobId);}
 invalidate(jobId?:string):void{if(this.dormant)return;const ids=jobId?[jobId]:new Set([...(this.contexts.keys()),...(this.active?[this.active.jobId]:[])]);for(const id of ids){this.repo.invalidate(id);if(this.active?.jobId===id)this.active.controller.abort(new Error('后台识别范围已失效'));else if(this.contexts.has(id))this.drop(id,true,'interrupted','preview-lost');}if(!jobId){for(let id=this.repo.next();id;id=this.repo.next()){this.repo.invalidate(id);this.ports.changed(id);}}}
 reconcile(jobId:string):void{this.repo.pruneRetry(jobId);const context=this.contexts.get(jobId);if(!this.repo.workflowReady(jobId)||context&&!this.ports.valid(context.scope))this.invalidate(jobId);}
 previewClosed(reviewToken:string):void{for(const [jobId,c] of this.contexts)if(c.scope.lease.reviewToken===reviewToken){if(this.active?.jobId===jobId){this.repo.invalidate(jobId);this.active.controller.abort(new Error('用户关闭识别预览'));}else if(c.reviewOnly){this.contexts.delete(jobId);this.ports.close(c.scope,false);}else this.drop(jobId,false,'done','none');}}
 isProcessing(reviewToken:string):boolean{return !!this.active&&this.contexts.get(this.active.jobId)?.scope.lease.reviewToken===reviewToken;}
 assertEditable(reviewToken:string):void{if(this.isProcessing(reviewToken))throw new Error('后台识别仍在处理，请先暂停或等待完成');}
 open(jobId:string):MetadataRecognitionOpen{
  this.prune();let context=this.contexts.get(jobId);const run=this.repo.get(jobId);
  if(run?.mode==='library'&&!['queued','running','stopping'].includes(run.state)&&!context){const scope=this.ports.claim(jobId);context={reviewOnly:true,scope,results:new Map()};this.contexts.set(jobId,context);}
  if(!context||!run||(!context.reviewOnly&&!['review','paused'].includes(run.state))||!this.ports.valid(context.scope))throw new Error('后台关联已过期或仍在处理，请重新读取任务');
  const preparedItemIds=context.reviewOnly?context.scope.claim.items.filter(item=>this.repo.mapping(jobId,item.id)).map(item=>item.id):[...context.results].filter(([,r])=>this.ports.publicResult(context!.scope,r.identificationToken)).map(([id])=>id);
  return {claim:structuredClone(context.scope.claim),lease:structuredClone(context.scope.lease),preparedItemIds,errors:this.repo.details(jobId).filter(r=>r.phase==='failed'||r.phase==='interrupted').map(r=>({itemId:r.itemId,code:r.code}))};
 }
 result(raw:unknown):FingerprintIdentification|Promise<FingerprintIdentification>{
  const r=readRecognitionResultRequest(raw),context=this.contexts.get(r.jobId);
  if(!context||context.scope.claim.claimToken!==r.claimToken||!this.ports.valid(context.scope))throw new Error('后台关联不属于当前审核页');this.assertEditable(context.scope.lease.reviewToken);
  if(context.reviewOnly){
   const mapping=this.repo.mapping(r.jobId,r.itemId);if(!mapping||!this.ports.restore||!context.scope.claim.items.some(item=>item.id===r.itemId))throw new Error('此曲没有保存的识别依据');
   return this.ports.restore(context.scope,r.itemId,mapping).then(value=>{if(this.contexts.get(r.jobId)!==context||!this.ports.valid(context.scope))throw new Error('识别审核页已关闭');context.results.set(r.itemId,value);return structuredClone(value);});
  }
  const found=context.results.get(r.itemId),value=found?this.ports.publicResult(context.scope,found.identificationToken):null;if(!value)throw new Error('此曲后台关联已过期，请重新识别');return value;
 }
 private prune():void{for(const [jobId,c] of this.contexts)if(!this.ports.valid(c.scope))this.invalidate(jobId);}
 async beginMaintenance(owner:string):Promise<void>{if(this.held&&this.held!==owner)throw new Error('后台识别被其他维护占用');this.held=owner;if(this.scheduled){clearTimeout(this.scheduled);this.scheduled=undefined;}this.invalidate();await this.active?.work;for(const id of [...this.contexts.keys()])this.drop(id,true,'interrupted','preview-lost');}
 endMaintenance(owner:string):void{if(this.held===owner){this.held=null;this.dormant=false;}}
 async dispose():Promise<void>{clearInterval(this.timer);await this.beginMaintenance(this.held??'recognition-dispose');}
}
