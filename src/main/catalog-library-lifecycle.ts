import {CompletedLibraryStartupFailed} from './catalog-normal-startup-error.js';
import type {NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import {readRestoreLibraryReleaseRequest,readRestoreLibraryReleaseProof,type RestoreLibraryReleaseRequest,type RestoreLibraryReleaseProof} from '../platform/catalog-restore-release.js';
import {readRestoreServiceReadyRequest,readRestoreServiceReadyProof,type RestoreServiceReadyRequest,type RestoreServiceReadyProof} from '../platform/catalog-restore-commit.js';
import {readRestoreNormalRequest,readRestoreNormalProof,type RestoreNormalRequest,type RestoreNormalProof} from '../platform/catalog-restore-normal.js';
import {readRestoreHydrationRequest,readRestoreHydrationProof,type RestoreHydrationRequest,type RestoreHydrationProof} from '../platform/catalog-restore-hydration.js';
import {readCatalogRestoreActivationRequest,readCatalogRestoreActivationProof,type CatalogRestoreActivationRequest,type CatalogRestoreActivationProof} from '../platform/catalog-restore-activation.js';
import {utilityProcess,type UtilityProcess} from 'electron';
import {randomUUID} from 'node:crypto';
import type {RequestMessage,ResponseMessage,EventMessage} from '../shared/contracts.js';
import {readLibraryInstanceReady,readCatalogServiceStopRequest,readCatalogServiceStopReceipt,readCatalogServiceExitProof,readCatalogRestoreBootRequest,readCatalogRestoreBootProof,lifecycleDigest,type CatalogServiceStopRequest,type CatalogServiceStopReceipt,type CatalogServiceExitProof,type CatalogRestoreBootRequest,type CatalogRestoreBootProof} from '../platform/catalog-library-lifecycle.js';
import {restoreTransactionDigest,RESTORE_TRANSACTION_FRAME_BYTES} from '../shared/catalog-restore-transaction.js';
import {RELEASE} from '../shared/release.js';
import {readLibraryStartupPhase,type LibraryStartupMessage,type LibraryStartupPhase} from '../shared/startup-progress.js';
import {StartupRpcTrace} from '../platform/startup-rpc-trace.js';

type Ports={workerPath:string;params:()=>{dataDir:string;credentialVaultPath:string;waveformPath:string;mediaWorkerPath:string;tagWorkerPath:string};beforeNormal:()=>Promise<NormalLibraryPermission|null>;guard:(operationId:string)=>void;state:(process:UtilityProcess|null,ready:boolean)=>void;publish:(event:EventMessage)=>void;startupProgress?:(phase:LibraryStartupPhase)=>void;unexpectedExit:(code:number)=>void};
type Owner={process:UtilityProcess;mode:'original'|'dormant';instanceId:string|null;ready:boolean;exited:boolean;exit:Promise<number>;privateBoot:boolean;bootOperationId:string|null;activation:{request:CatalogRestoreActivationRequest;work:Promise<CatalogRestoreActivationProof>;proof:CatalogRestoreActivationProof|null}|null;hydration:{request:RestoreHydrationRequest;work:Promise<RestoreHydrationProof>}|null;normal:{request:RestoreNormalRequest;work:Promise<RestoreNormalProof>;proof:RestoreNormalProof|null}|null;committedReady:{request:RestoreServiceReadyRequest;work:Promise<RestoreServiceReadyProof>;proof:RestoreServiceReadyProof|null}|null;committedRelease:{request:RestoreLibraryReleaseRequest;work:Promise<RestoreLibraryReleaseProof>;proof:RestoreLibraryReleaseProof|null}|null;stop:{operationId:string;receipt:CatalogServiceStopReceipt|null;ack:boolean}|null};
type Waiter={owner:Owner;method:string;resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout|undefined;trace?:((ok:boolean)=>void)};
const errorMessage=(error:unknown)=>error instanceof Error?error:new Error(String(error));

// Every reply, cancellation and exit belongs to the process that created it.
// In particular a late exit can never clear a subsequently opened Library.
export class CatalogLibraryLifecycle{
 private owner:Owner|null=null;private starting=false;private closed=false;
 private readonly pending=new Map<string,Waiter>();
 private readonly rpcTrace=new StartupRpcTrace('main');
 constructor(private readonly ports:Ports){}
 instance():{instanceId:string;mode:'original'|'dormant'}{const owner=this.owner;if(!owner?.instanceId||owner.exited)throw new Error('曲库服务尚未确认实例身份');return {instanceId:owner.instanceId,mode:owner.mode};}
 private owns(owner:Owner):boolean{return this.owner===owner&&!owner.exited;}
 matchesDormant(proof:CatalogRestoreBootProof):boolean{const owner=this.owner;return Boolean(owner&&!owner.exited&&owner.mode==='dormant'&&owner.instanceId===proof.instanceId&&owner.process.pid===proof.pid&&owner.bootOperationId===proof.operationId&&!owner.stop);}
 matchesReleased(proof:RestoreLibraryReleaseProof):boolean{const owner=this.owner;return Boolean(owner&&this.owns(owner)&&owner.mode==='original'&&owner.ready&&!owner.stop&&owner.instanceId===proof.instanceId&&owner.process.pid===proof.pid&&owner.bootOperationId===proof.operationId&&owner.committedRelease?.proof&&lifecycleDigest(owner.committedRelease.proof)===lifecycleDigest(proof));}
 assertCompletedHandoff(proof:RestoreLibraryReleaseProof):void{if(this.closed||this.starting||!this.matchesReleased(proof)||[...this.pending.values()].some(waiter=>waiter.owner===this.owner&&(waiter.method.startsWith('catalogRestore')||waiter.method==='catalogServiceStop')))throw new Error('恢复曲库实例或私有请求尚未完成普通交接');}
 handoffCompleted(proof:RestoreLibraryReleaseProof):void{this.assertCompletedHandoff(proof);const owner=this.owner!;owner.bootOperationId=null;owner.privateBoot=false;owner.activation=null;owner.hydration=null;owner.normal=null;owner.committedReady=null;owner.committedRelease=null;}
 private fork(mode:Owner['mode']):Owner{
  if(this.owner||this.closed)throw new Error('原曲库服务尚未实际退出或应用已关闭');
  const child=utilityProcess.fork(this.ports.workerPath,[],{serviceName:'Aural Library Service',stdio:'pipe'});
  let resolveExit!:(code:number)=>void;const exit=new Promise<number>(resolve=>{resolveExit=resolve;});
  const owner:Owner={process:child,mode,instanceId:null,ready:false,exited:false,exit,privateBoot:mode==='dormant',bootOperationId:null,activation:null,hydration:null,normal:null,committedReady:null,committedRelease:null,stop:null};this.owner=owner;this.ports.state(child,false);
  child.on('message',(value:ResponseMessage|EventMessage|LibraryStartupMessage)=>{
   if(this.owner!==owner||owner.exited||!value||typeof value!=='object')return;
   if('startupProgress' in value){
    // Advisory phases never satisfy init, release readiness or restoration.
    const phase=readLibraryStartupPhase(value.startupProgress);
    if(phase&&Object.keys(value).length===1&&this.starting&&owner.mode==='original'&&owner.privateBoot&&!owner.ready&&!owner.stop)this.ports.startupProgress?.(phase);
    return;
   }
   if('event' in value){if(owner.mode==='dormant'||owner.stop||['catalogBackupChanged','catalogBackupFreeze','catalogBackupThaw','catalogRestoreChanged'].includes(value.event))return;this.ports.publish(value);return;}
   const waiter=this.pending.get(value.id);if(!waiter||waiter.owner!==owner)return;
   this.pending.delete(value.id);clearTimeout(waiter.timer);waiter.trace?.(value.ok);if(value.ok)waiter.resolve(value.result);else waiter.reject(new Error(value.error??'音乐库服务错误'));
  });
  child.once('exit',code=>{
   const wasCurrent=this.owner===owner;
   owner.exited=true;owner.ready=false;
    for(const [id,waiter] of this.pending){if(waiter.owner!==owner)continue;clearTimeout(waiter.timer);this.pending.delete(id);waiter.trace?.(false);waiter.reject(new Error(`音乐库服务退出 (${code})`));}
   if(this.owner===owner){this.owner=null;this.ports.state(null,false);}
   resolveExit(code);
   if(wasCurrent&&!this.closed&&!owner.privateBoot&&!(code===0&&owner.stop?.ack&&owner.stop.receipt))this.ports.unexpectedExit(code);
  });
  let diagnostics=0;child.stderr?.on('data',(bytes:Buffer)=>{if(this.owner!==owner)return;const remaining=Math.max(0,16384-diagnostics);diagnostics+=bytes.length;if(remaining&&mode==='original')console.error('[library]',bytes.subarray(0,remaining).toString());});
  return owner;
 }
 private send<T>(owner:Owner,method:string,params?:unknown,timeoutMs?:number):Promise<T>{
  if(this.owner!==owner||owner.exited)return Promise.reject(new Error('音乐库服务实例已退出'));
  const id=randomUUID(),trace=this.rpcTrace.begin(method);return new Promise<T>((resolve,reject)=>{
   const timer=timeoutMs===undefined?undefined:setTimeout(()=>{
    const waiter=this.pending.get(id);if(!waiter||waiter.owner!==owner)return;this.pending.delete(id);
    if((method==='metadataMatch'||method==='metadataCreditPreview'||method==='tagWritePreview')&&this.owner===owner&&!owner.exited&&params&&typeof params==='object'){
     const requestId=(params as {requestId?:string}).requestId;if(requestId)try{owner.process.postMessage({id:randomUUID(),method:method==='tagWritePreview'?'tagWritePreviewCancel':'cancelMetadataMatch',params:requestId});}catch{}
    }trace?.(false);reject(new Error(`音乐库服务超时：${method}`));
   },timeoutMs);
   this.pending.set(id,{owner,method,resolve:resolve as (value:unknown)=>void,reject,timer,trace});
   try{owner.process.postMessage({id,method,params} satisfies RequestMessage);}catch(error){clearTimeout(timer);this.pending.delete(id);trace?.(false);reject(errorMessage(error));}
  });
 }
 call<T>(method:string,params?:unknown,timeoutMs=15000):Promise<T>{const owner=this.owner;if(!owner?.ready||owner.mode!=='original'||owner.stop)return Promise.reject(new Error('音乐库服务尚未就绪或正在恢复维护'));return this.send<T>(owner,method,params,timeoutMs);}
 controlCall<T>(method:string,params?:unknown):Promise<T>{
  if(!['catalogMaintenanceState','catalogMaintenanceBegin','catalogMaintenanceCapture','catalogMaintenanceRelease'].includes(method))return Promise.reject(new Error('不允许的私有维护调用'));
  const owner=this.owner;if(!owner?.instanceId||owner.exited||owner.stop)return Promise.reject(new Error('原曲库维护实例未运行或正在关闭'));return this.send<T>(owner,method,params);
 }
 private async terminate(owner:Owner):Promise<number>{
  if(!owner.exited)try{owner.process.kill();}catch{}
  const retry=setInterval(()=>{if(!owner.exited)try{owner.process.kill();}catch{}},1000);
  try{return await owner.exit;}finally{clearInterval(retry);}
 }
 async startNormal():Promise<void>{
  if(this.starting||this.owner||this.closed)throw new Error('曲库服务已有启动或尚未退出');this.starting=true;let owner:Owner|null=null,permission:NormalLibraryPermission|null=null,stage:'fork'|'initialize'|'receipt'='fork';
  // Existing large catalogs can require a verified snapshot and transactional
  // schema migration before init returns. Keep one bounded initialization
  // request alive; ordinary calls remain unavailable until the actual receipt.
  // The schema72 -> 73 100k catalog upgrade exceeded the previous three minutes.
  try{permission=await this.ports.beforeNormal();if(this.closed)throw new Error('应用已关闭');owner=this.fork('original');owner.privateBoot=true;stage='initialize';const result=await this.send(owner,'init',{...this.ports.params(),...(permission?{existingLibrary:permission}:{})},45*60*1000);stage='receipt';const ready=readLibraryInstanceReady(result,permission?{permission,sha256:lifecycleDigest(permission)}:undefined);
   if(this.closed||!this.owns(owner)||ready.pid!==owner.process.pid)throw new Error('曲库就绪回执与实际进程不同');owner.instanceId=ready.instanceId;owner.ready=true;owner.privateBoot=false;this.ports.state(owner.process,true);
  }catch(error){if(owner)await this.terminate(owner);if(permission&&!this.closed)throw new CompletedLibraryStartupFailed(permission,stage,error);throw error;}finally{this.starting=false;}
 }
 async startDormant(value:CatalogRestoreBootRequest,authorize:()=>void):Promise<CatalogRestoreBootProof>{
  const request=readCatalogRestoreBootRequest(value);authorize();this.ports.guard(request.operationId);
  if(this.starting||this.owner||this.closed)throw new Error('原曲库尚未实际退出，不能恢复启动');this.starting=true;let owner:Owner|null=null;
  try{owner=this.fork('dormant');owner.bootOperationId=request.operationId;let expired=false;const timer=setTimeout(()=>{expired=true;if(owner&&!owner.exited)void this.terminate(owner);},45*60*1000);
   try{const proof=readCatalogRestoreBootProof(await this.send(owner,'catalogRestoreInit',{...this.ports.params(),restore:request}),request);authorize();this.ports.guard(request.operationId);
    if(expired||this.closed||!this.owns(owner)||proof.pid!==owner.process.pid)throw new Error('恢复只读启动回执与实际进程不同');owner.instanceId=proof.instanceId;owner.privateBoot=false;return proof;
   }finally{clearTimeout(timer);}
  }catch(error){if(owner)await this.terminate(owner);throw error;}finally{this.starting=false;}
 }
 activateFrozen(value:CatalogRestoreActivationRequest,bootRequest:CatalogRestoreBootRequest,boot:CatalogRestoreBootProof,authorize:()=>void):Promise<CatalogRestoreActivationProof>{
  const request=readCatalogRestoreActivationRequest(value,boot),owner=this.owner;authorize();this.ports.guard(request.operationId);
  if(this.starting||this.closed||!owner||!this.matchesDormant(boot)||owner.stop)throw new Error('当前只读曲库实例不能开始可写准备');
  if(owner.activation){if(lifecycleDigest(owner.activation.request)!==lifecycleDigest(request))throw new Error('同一只读实例已用于不同激活请求');return owner.activation.work;}
  const work=Promise.resolve().then(async()=>{
   let expired=false;const timer=setTimeout(()=>{expired=true;void this.terminate(owner);},45*60*1000);
   try{const proof=readCatalogRestoreActivationProof(await this.send(owner,'catalogRestoreActivate',request),request,bootRequest);authorize();this.ports.guard(request.operationId);
    if(expired||this.closed||!this.owns(owner)||proof.pid!==owner.process.pid||proof.pid!==boot.pid||proof.buildId!==boot.buildId||Buffer.byteLength(JSON.stringify(proof))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('可写准备回执与实际进程或原构建不同');owner.activation!.proof=proof;return proof;
   }catch(error){await this.terminate(owner);throw error;}finally{clearTimeout(timer);}
  });owner.activation={request,work,proof:null};void work.catch(()=>{});return work;
 }
 hydrateFrozen(value:RestoreHydrationRequest,boot:CatalogRestoreBootProof,authorize:()=>void):Promise<RestoreHydrationProof>{
  const owner=this.owner;authorize();if(this.closed||this.starting||!owner?.activation?.proof||!this.matchesDormant(boot)||owner.stop)throw new Error('当前曲库实例尚未确认可写准备');
  const request=readRestoreHydrationRequest(value,owner.activation.proof,undefined,boot.token);this.ports.guard(request.operationId);
  if(request.role!==owner.activation.request.role)throw new Error('恢复状态重建角色不同');if(owner.hydration){if(lifecycleDigest(request)!==lifecycleDigest(owner.hydration.request))throw new Error('原曲库状态重建请求不能改变');return owner.hydration.work;}
  const work=Promise.resolve().then(async()=>{let expired=false;const timer=setTimeout(()=>{expired=true;void this.terminate(owner);},45*60*1000);
   try{const proof=readRestoreHydrationProof(await this.send(owner,'catalogRestoreHydrate',request),request);authorize();this.ports.guard(request.operationId);if(expired||this.closed||!this.owns(owner)||proof.pid!==owner.process.pid||proof.pid!==boot.pid||proof.buildId!==boot.buildId||Buffer.byteLength(JSON.stringify(proof))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('恢复状态读取回执与实际进程不同');return proof;}finally{clearTimeout(timer);}
  });owner.hydration={request,work};void work.catch(()=>{});return work;
 }
 prepareNormalFrozen(value:RestoreNormalRequest,boot:CatalogRestoreBootProof,authorize:()=>void):Promise<RestoreNormalProof>{
  const owner=this.owner;authorize();if(this.starting||this.closed||!owner?.activation?.proof||!owner.hydration||!this.matchesDormant(boot)||owner.stop)throw new Error('普通服务准备缺少当前曲库激活和状态证明');
  const request=readRestoreNormalRequest(value,owner.activation.proof,undefined,undefined,boot.token);this.ports.guard(request.operationId);if(request.role!==owner.activation.request.role)throw new Error('普通服务准备角色不同');
  if(owner.normal){if(lifecycleDigest(owner.normal.request)!==lifecycleDigest(request))throw new Error('原普通服务准备请求不能改变');return owner.normal.work;}
  const work=Promise.resolve().then(async()=>{const hydrated=await owner.hydration!.work;authorize();this.ports.guard(request.operationId);let expired=false;const timer=setTimeout(()=>{expired=true;void this.terminate(owner);},45*60*1000);
   try{const proof=readRestoreNormalProof(await this.send(owner,'catalogRestorePrepareNormal',request),request,owner.activation!.proof!,hydrated.snapshotSha256);authorize();this.ports.guard(request.operationId);if(expired||this.closed||!this.owns(owner)||proof.pid!==owner.process.pid||proof.buildId!==boot.buildId||Buffer.byteLength(JSON.stringify(proof))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('普通服务准备回执与实际进程不同');owner.normal!.proof=proof;return proof;}finally{clearTimeout(timer);}
  });owner.normal={request,work,proof:null};void work.catch(()=>{});return work;
 }
 prepareCommittedService(value:RestoreServiceReadyRequest,boot:CatalogRestoreBootProof,authorize:()=>void):Promise<RestoreServiceReadyProof>{
  const owner=this.owner;authorize();if(this.starting||this.closed||!owner?.normal?.proof||!this.matchesDormant(boot)||owner.stop)throw new Error('完成后服务准备缺少当前普通服务证明');
  const request=readRestoreServiceReadyRequest(value,undefined,owner.normal.proof,boot.token);this.ports.guard(request.operationId);
  if(owner.committedReady){if(lifecycleDigest(owner.committedReady.request)!==lifecycleDigest(request))throw new Error('原服务就绪请求不能改变');return owner.committedReady.work;}
  const work=Promise.resolve().then(async()=>{let expired=false;const timer=setTimeout(()=>{expired=true;void this.terminate(owner);},45*60*1000);
   try{const proof=readRestoreServiceReadyProof(await this.send(owner,'catalogRestoreServiceReady',request),request,owner.normal!.proof!);authorize();this.ports.guard(request.operationId);if(expired||this.closed||!this.owns(owner)||proof.pid!==owner.process.pid||proof.buildId!==boot.buildId||Buffer.byteLength(JSON.stringify(proof))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('完成后服务就绪回执与实际进程不同');owner.committedReady!.proof=proof;return proof;}finally{clearTimeout(timer);}
  });owner.committedReady={request,work,proof:null};void work.catch(()=>{});return work;
 }
 releaseCommittedService(value:RestoreLibraryReleaseRequest,boot:CatalogRestoreBootProof,persist:(proof:RestoreLibraryReleaseProof)=>Promise<void>,authorize:()=>void):Promise<RestoreLibraryReleaseProof>{
  const owner=this.owner;authorize();if(this.starting||this.closed||!owner?.committedReady?.proof||owner.stop)throw new Error('当前曲库尚未确认冻结就绪');const request=readRestoreLibraryReleaseRequest(value,undefined,owner.committedReady.proof,boot.token);this.ports.guard(request.operationId);
  if(owner.committedRelease){if(lifecycleDigest(owner.committedRelease.request)!==lifecycleDigest(request))throw new Error('原曲库释放请求不能改变');return owner.committedRelease.work;}if(!this.matchesDormant(boot))throw new Error('曲库释放不属于当前实际恢复进程');
  const work=Promise.resolve().then(async()=>{let expired=false;const timer=setTimeout(()=>{expired=true;void this.terminate(owner);},45*60*1000);
   try{const proof=readRestoreLibraryReleaseProof(await this.send(owner,'catalogRestoreRelease',request),request,owner.committedReady!.proof!);authorize();this.ports.guard(request.operationId);if(expired||this.closed||!this.owns(owner)||proof.pid!==owner.process.pid||proof.buildId!==boot.buildId||Buffer.byteLength(JSON.stringify(proof))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('曲库释放回执与实际进程不同');
    // Ordinary RPC and event publication remain blocked until the actual release
    // proof is durably in the original global chain, including its read-back.
    await persist(proof);authorize();this.ports.guard(request.operationId);if(expired||this.closed||!this.owns(owner)||!this.matchesDormant(boot))throw new Error('曲库释放持久登记期间原实例已退出');owner.committedRelease!.proof=proof;owner.mode='original';owner.ready=true;this.ports.state(owner.process,true);return proof;
   }catch(error){await this.terminate(owner);throw error;}finally{clearTimeout(timer);}
  });owner.committedRelease={request,work,proof:null};void work.catch(()=>{});return work;
 }
 async stopFrozen(value:CatalogServiceStopRequest,persist:(receipt:CatalogServiceStopReceipt)=>Promise<string>,authorize:()=>void):Promise<CatalogServiceExitProof>{
  const request=readCatalogServiceStopRequest(value),owner=this.owner;authorize();this.ports.guard(request.operationId);
  if(this.starting||!owner?.instanceId||owner.exited||owner.stop||owner.activation||request.instanceId!==owner.instanceId||request.mode!==owner.mode)throw new Error('曲库关闭请求不属于当前独立实例');
  owner.stop={operationId:request.operationId,receipt:null,ack:false};owner.ready=false;this.ports.state(owner.process,false);
  let expired=false;const timer=setTimeout(()=>{expired=true;void this.terminate(owner);},45*60*1000);
  try{
   const receipt=readCatalogServiceStopReceipt(await this.send(owner,'catalogServiceStop',request),request);authorize();this.ports.guard(request.operationId);
   if(expired||this.closed||owner.exited||this.owner!==owner||receipt.pid!==owner.process.pid||receipt.buildId!==RELEASE.mainBuildId||Buffer.byteLength(JSON.stringify(receipt))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('曲库关闭回执与实际进程或构建不符');
   owner.stop.receipt=receipt;const recordSha256=restoreTransactionDigest(await persist(receipt));authorize();this.ports.guard(request.operationId);
   if(expired||this.closed||owner.exited||this.owner!==owner)throw new Error('原曲库关闭回执持久登记期间实例已退出');
   owner.stop.ack=true;owner.process.postMessage({id:randomUUID(),method:'catalogServiceStopAck',params:{operationId:request.operationId,challenge:request.challenge,receiptSha256:lifecycleDigest(receipt),recordSha256}} satisfies RequestMessage);
   const code=await owner.exit;authorize();this.ports.guard(request.operationId);
   if(expired||code!==0||this.owner!==null)throw new Error('原曲库没有确认正常实际退出');return readCatalogServiceExitProof({version:1,receipt,exitCode:0,exitedAt:new Date().toISOString()},request);
  }catch(error){await this.terminate(owner);throw error;}finally{clearTimeout(timer);}
 }
 interruptFrozenStop(operationId:string):void{const owner=this.owner;if(owner?.stop?.operationId===operationId&&!owner.exited)void this.terminate(owner);}
 interruptDormant(operationId:string):void{const owner=this.owner;if(owner?.bootOperationId===operationId&&!owner.exited)void this.terminate(owner);}
 close():Promise<unknown>{this.closed=true;return this.owner?this.terminate(this.owner):Promise.resolve();}
}
