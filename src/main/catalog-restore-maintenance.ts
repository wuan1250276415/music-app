import type {RestoreLibraryReleaseRequest,RestoreLibraryReleaseProof} from '../platform/catalog-restore-release.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {backupUuid,readCatalogBackupManifest,type RendererPendingSnapshot} from '../shared/catalog-backup.js';
import {readBackupFreeze,readBackupFrozen,readBackupState,type CatalogBackupFreeze,type CatalogBackupState} from '../shared/catalog-backup-ui.js';
import {readCatalogMaintenanceState,type CatalogMaintenanceState,type CatalogCapturedSnapshot} from '../shared/catalog-maintenance.js';
import type {MainCatalogResources} from './catalog-main-resources.js';
import {readCatalogServiceExitProof,readCatalogRestoreBootProof,type CatalogServiceExitProof,type CatalogRestoreBootProof,type CatalogRestoreBootRequest} from '../platform/catalog-library-lifecycle.js';

type Ports={dataDir:string;resources:MainCatalogResources;ready:()=>boolean;busy:()=>boolean;serviceAbsent:()=>boolean;matchesDormant:(proof:CatalogRestoreBootProof)=>boolean;matchesReleased:(proof:RestoreLibraryReleaseProof)=>boolean;resumeAllowed:()=>boolean;call:<T>(method:string,params?:unknown)=>Promise<T>;freeze:(request:CatalogBackupFreeze)=>void;thaw:(operationId:string)=>void;changed:()=>void;publish:(state:CatalogBackupState)=>void};
// Retains all three maintenance owners after capture. Directory replacement
// must not use the ordinary backup coordinator, which releases before packing.
export class CatalogRestoreMaintenance{
 private operationId:string|null=null;private stopped='';private work:Promise<CatalogCapturedSnapshot>|null=null;private releaseWork:Promise<void>|null=null;
 private mainBegun=false;private mainFrozen=false;private libraryBegun=false;private library:CatalogMaintenanceState|null=null;
 private libraryRetired=false;private restoredRelease:RestoreLibraryReleaseRequest|null=null;
 private completedSha256:string|null=null;
 private waiting:{request:CatalogBackupFreeze;authorize:()=>void;resolve:(pending:RendererPendingSnapshot)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
 private receipt:{operationId:string;challenge:string;sha256:string;authorize:()=>void}|null=null;
 private boundary:CatalogBackupState={operationId:null,phase:'idle',held:false,cancelRequested:false,bytes:0,total:0,message:'',result:null};
 constructor(private readonly ports:Ports){}
 get busy():boolean{return this.operationId!==null;}
 snapshotBoundary():CatalogBackupState{return readBackupState(this.boundary);}
 private change(phase:CatalogBackupState['phase'],message:string,held=this.busy):void{this.boundary={...this.boundary,operationId:this.operationId??this.boundary.operationId,phase,held,message};try{this.ports.publish(this.snapshotBoundary());}catch{/* Main hold survives a replaced document. */}}
 ready(value:string):void{this.assertFrozen(value);this.change('capturing','候选曲库及恢复前一致快照已核对，等待完成恢复或明确取消。');}
 owns(value:string):boolean{return this.operationId===value||this.receipt?.operationId===value;}
 assertFrozen(value:string):void{if(this.operationId!==value||this.releaseWork||!this.mainFrozen||this.library?.phase!=='frozen'||!this.library.token||this.stopped)throw new Error('恢复前维护资源未确认冻结');this.ports.resources.assertFrozen(value);}
 assertReleaseHeld(value:string):void{if(this.operationId!==value||this.releaseWork||!this.mainFrozen||!this.libraryRetired||!this.library?.token||!['frozen','releasing','released'].includes(this.library.phase)||this.stopped)throw new Error('恢复释放阶段的主程序或曲库身份已变化');this.ports.resources.assertHeld(value);}
 beginRestoredRelease(request:RestoreLibraryReleaseRequest):void{
  this.assertFrozen(request.operationId);if(!this.libraryRetired||this.restoredRelease||request.token!==this.library?.token)throw new Error('恢复曲库释放不是原维护租约');this.restoredRelease=structuredClone(request);this.library={...this.library!,phase:'releasing',message:'恢复曲库正在按原完成决策释放维护。'};this.change('releasing','正在恢复曲库服务，主程序和界面交互继续暂停。');
 }
 markRestoredReleased(proof:RestoreLibraryReleaseProof):void{
  this.assertReleaseHeld(proof.operationId);if(!this.restoredRelease||proof.requestSha256!==lifecycleDigest(this.restoredRelease)||this.library?.phase!=='releasing'||!this.ports.matchesReleased(proof))throw new Error('恢复曲库未确认原释放结果或实际普通服务实例');this.library={...this.library,phase:'released',message:'曲库已确认释放维护，主程序和界面仍保留占用。'};this.change('releasing','曲库服务已恢复，正在准备主程序资源和新界面。');
 }
 finalizing(value:string):void{this.assertReleaseHeld(value);if(this.library?.phase!=='released')throw new Error('曲库服务释放尚未确认');this.change('releasing','正在核对恢复后的界面并等待原读取结束，交互继续暂停。');}
 finalReady(value:string):void{this.assertReleaseHeld(value);this.ports.resources.assertFinalBarrier(value,true);this.change('releasing','曲库和新界面已核对，等待持久确认恢复完成；交互继续暂停。');}
 prepareCompleted(value:string,recordSha256:string):void{this.assertReleaseHeld(value);this.ports.resources.assertFinalBarrier(value,true);if(this.completedSha256||!/^[a-f0-9]{64}$/.test(recordSha256)||this.waiting)throw new Error('恢复完成交接已登记或界面冻结仍未确认');this.completedSha256=recordSha256;}
 publishCompleted(value:string,recordSha256:string):void{
  if(this.operationId!==value||this.completedSha256!==recordSha256||this.stopped||this.library?.phase!=='released')throw new Error('恢复完成状态不属于原持久证明');this.ports.resources.assertAvailable();
  this.change('checked','曲库恢复完成。播放保持停止，可手动继续；原资料和恢复记录已保留。',false);this.operationId=null;this.work=null;this.releaseWork=null;this.receipt=null;this.mainBegun=false;this.mainFrozen=false;this.libraryBegun=false;this.libraryRetired=false;this.library=null;this.restoredRelease=null;this.completedSha256=null;
  try{this.ports.thaw(value);}catch{/* Published non-held state is authoritative. */}try{this.ports.changed();}catch{}
 }
 lease(value:string):{operationId:string;token:string}{this.assertFrozen(value);return {operationId:value,token:this.library!.token!};}
 beginLibraryClose(value:string):void{this.assertFrozen(value);this.libraryRetired=true;this.library={...this.library!,phase:'closing',message:'曲库正在关闭，三方维护占用保留。'};this.change('capturing','正在关闭曲库，保留恢复前资料和维护占用。');}
 markLibraryClosed(value:CatalogServiceExitProof):void{const proof=readCatalogServiceExitProof(value);if(this.stopped||proof.receipt.operationId!==this.operationId||proof.receipt.token!==this.library?.token||this.library.phase!=='closing'||!this.ports.serviceAbsent())throw new Error('原曲库服务未确认实际退出');this.ports.resources.assertFrozen(proof.receipt.operationId);this.library={...this.library,phase:'closed',message:'原曲库已实际退出，等待目录切换。'};this.change('capturing','原曲库已关闭并退出，恢复前资料和维护占用继续保留。');}
 assertCutoverReady(value:string):void{if(this.operationId!==value||this.stopped||!this.mainFrozen||this.library?.phase!=='closed'||!this.ports.serviceAbsent())throw new Error('目录切换前原曲库实际退出或维护占用未确认');this.ports.resources.assertFrozen(value);}
 markDormant(value:CatalogRestoreBootProof,request:CatalogRestoreBootRequest):void{const proof=readCatalogRestoreBootProof(value,request);if(this.stopped||this.releaseWork||proof.operationId!==this.operationId||this.library?.phase!=='closed'||!this.mainFrozen||!this.ports.matchesDormant(proof))throw new Error('恢复只读曲库尚未确认原实例及维护占用');this.ports.resources.assertFrozen(proof.operationId);this.library={operationId:proof.operationId,token:proof.token,phase:'frozen',message:'恢复只读曲库已核对，后台任务保持停止。'};this.change('capturing','曲库已在只读状态启动并核对，等待完成恢复或回滚。');}
 frozenReply(value:unknown,authorize:()=>void):void{
  authorize();const reply=readBackupFrozen(value),sha256=createHash('sha256').update(JSON.stringify(reply)).digest('hex'),waiting=this.waiting;
  if(!waiting){const previous=this.receipt;if(!previous||reply.operationId!==previous.operationId||reply.challenge!==previous.challenge||sha256!==previous.sha256)throw new Error('恢复冻结回执已过期或原内容不同');previous.authorize();return;}
  if(reply.operationId!==waiting.request.operationId||reply.challenge!==waiting.request.challenge)throw new Error('恢复冻结挑战已变化');waiting.authorize();this.receipt={operationId:reply.operationId,challenge:reply.challenge,sha256,authorize:waiting.authorize};clearTimeout(waiting.timer);this.waiting=null;if(reply.pending)waiting.resolve(reply.pending);else waiting.reject(new Error(reply.error));
 }
 private freeze(operationId:string,authorize:()=>void):Promise<RendererPendingSnapshot>{const request=readBackupFreeze({operationId,challenge:randomUUID()});return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{if(this.waiting?.request.challenge===request.challenge){this.waiting=null;reject(new Error('界面未确认恢复前待保存资料冻结'));}},10000);this.waiting={request,authorize,resolve,reject,timer};try{this.ports.freeze(request);}catch(error){clearTimeout(timer);this.waiting=null;reject(error);}});}
 interrupt(reason:string):void{if(!this.busy)return;this.stopped||=reason;this.change('failed',reason);if(this.waiting){const waiting=this.waiting;this.waiting=null;clearTimeout(waiting.timer);waiting.reject(new Error(reason));}}
 private check(authorize:()=>void):void{if(this.stopped||!this.ports.ready())throw new Error(this.stopped||'应用状态变化，恢复前快照未完成');authorize();}
 capture(value:unknown,authorize:()=>void):Promise<CatalogCapturedSnapshot>{
  const operationId=backupUuid(value);authorize();if(this.operationId===operationId&&this.work)return this.work;if(this.busy||this.ports.resources.held||this.ports.busy()||!this.ports.ready())throw new Error('已有曲库维护或应用尚未准备好');
  this.operationId=operationId;this.stopped='';this.receipt=null;this.mainBegun=false;this.mainFrozen=false;this.libraryBegun=false;this.library=null;this.libraryRetired=false;this.restoredRelease=null;this.releaseWork=null;this.completedSha256=null;
  this.boundary={operationId,phase:'freezing',held:true,cancelRequested:false,bytes:0,total:0,message:'正在冻结恢复前的待保存资料。',result:null};this.change('freezing',this.boundary.message);
  const work=Promise.resolve().then(async()=>{
   const pending=await this.freeze(operationId,authorize);this.check(authorize);this.change('draining','正在停止播放及后台任务，准备恢复前的一致快照。');this.mainBegun=true;await this.ports.resources.begin(operationId);this.mainFrozen=true;this.check(authorize);
   this.libraryBegun=true;const frozen=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceBegin',{operationId}));if(frozen.operationId!==operationId||frozen.phase!=='frozen'||!frozen.token)throw new Error('恢复前曲库未确认停止');this.library=frozen;this.check(authorize);
   this.change('capturing','正在保存恢复前的曲库及待核对资料。');const snapshot=await this.ports.call<CatalogCapturedSnapshot>('catalogMaintenanceCapture',{operationId,token:frozen.token,pending});this.check(authorize);const manifest=readCatalogBackupManifest(snapshot.manifest);
   if(manifest.backupId!==operationId||typeof snapshot.stagePath!=='string'||path.dirname(snapshot.stagePath)!==path.join(this.ports.dataDir,'backups','catalog')||!path.basename(snapshot.stagePath).startsWith('.aural-backup-'+operationId+'-'))throw new Error('恢复前一致快照不属于当前私有操作');
   const actual=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceState'));if(actual.operationId!==operationId||actual.token!==frozen.token||actual.phase!=='frozen')throw new Error('恢复前捕获结束后原曲库维护租约不同');this.library=actual;this.assertFrozen(operationId);return {stagePath:snapshot.stagePath,manifest};
  });this.work=work;void work.catch(()=>{});return work;
 }
 // This release is only for aborts before any directory cutover. After actual
 // service exit the full restore coordinator needs a separate new-boot policy.
 releaseBeforeCutover(value:string):Promise<void>{
  const operationId=backupUuid(value);if(!this.busy)return Promise.resolve();if(operationId!==this.operationId)throw new Error('恢复维护释放身份不同');if(this.releaseWork)return this.releaseWork;
  if(this.libraryRetired||this.library?.phase==='closing'||this.library?.phase==='closed')throw new Error('原曲库已进入受控关闭，必须完成恢复或回滚后才能释放维护');
  const work=Promise.resolve().then(async()=>{
   await this.work?.catch(()=>{});this.change('releasing','正在结束恢复前的维护，原曲库尚未替换。');const resume=this.ports.resumeAllowed();
   if(this.libraryBegun){const actual=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceState'));if(actual.phase!=='idle'&&actual.phase!=='released'){
    if(actual.operationId!==operationId||!actual.token||['failed','closing','closed'].includes(actual.phase)||this.library?.token&&this.library.token!==actual.token)throw new Error('恢复维护停止未确认，保留占用并重新启动后核对');
    const released=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceRelease',{operationId,token:actual.token,resumeWatch:resume}));if(released.operationId!==operationId||released.phase!=='released')throw new Error('原曲库未确认释放恢复维护');
   }}
   if(this.mainBegun){if(!this.mainFrozen)throw new Error('主窗口资源停止未确认，恢复维护占用保留');await this.ports.resources.release(operationId,resume);}
   if(this.waiting){const waiting=this.waiting;this.waiting=null;clearTimeout(waiting.timer);waiting.reject(new Error('恢复前准备已结束'));}this.change('cancelled','恢复前准备已结束，原曲库未替换。',false);this.operationId=null;try{this.ports.thaw(operationId);}catch{/* Actual source release is authoritative. */}if(resume)try{this.ports.changed();}catch{}
  });this.releaseWork=work;void work.catch(()=>{});return work;
 }
}
