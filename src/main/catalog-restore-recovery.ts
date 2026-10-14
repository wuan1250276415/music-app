import {promises as fs,type BigIntStats} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {CatalogRestoreTransactionStore} from './catalog-restore-transaction-store.js';
import {inspectRecordedMove} from './catalog-recorded-move-review.js';
import {readRecordedMoveConfirmation,recordedMoveReviewBasis,MOVE_RECONCILIATION_POLICY,type RecordedMoveReview} from '../shared/catalog-move-reconciliation.js';
import {fileObservation} from '../platform/file-observation.js';
import type {NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import {CompletedLibraryStartupFailed} from './catalog-normal-startup-error.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {RELEASE} from '../shared/release.js';
import {readRestoreRecoveryRestartRequest,readRestoreRecoveryState,normalRestoreRecoveryState,type RestoreRecoveryState,RESTORE_RECOVERY_REPORT_BYTES} from '../shared/catalog-restore-recovery.js';
import {inspectCatalogRestoreStartup,RestoreStartupBlocked,type RestoreStartupInspection} from './catalog-restore-startup.js';
type Ports={dataDir:string;absent:()=>boolean;pick:()=>Promise<string|null>;restart:(permission:NormalLibraryPermission)=>void};
const identity=(stat:BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
// Independent recovery view: existing actual native exit may be explicitly
// reconciled into the original ledger, but no directory move, Library, SQL,
// device or previous maintenance lease is started/adopted by these operations.
export class CatalogRestoreRecovery{
 private state:RestoreRecoveryState={...normalRestoreRecoveryState};private work:Promise<RestoreRecoveryState>|null=null;private workKind:'recheck'|'restart'|'reconcile'|null=null;private exportWork:Promise<string|null>|null=null;private closed=false;private stopped='';private inspection:RestoreStartupInspection|null=null;private restarting=false;private readonly instanceId=randomUUID();private reviewWork:Promise<RecordedMoveReview>|null=null;private moveReview:{value:RecordedMoveReview;authorize:()=>void}|null=null;private moveControl:AbortController|null=null;private confirmation:{identity:string;requestId:string;authorize:()=>void;work:Promise<RestoreRecoveryState>}|null=null;
 constructor(private readonly ports:Ports){}
 get active():boolean{return this.state.active;}
 snapshot():RestoreRecoveryState{return readRestoreRecoveryState(this.state);}
 private redact(value:string,max=1024):string{return value.split(this.ports.dataDir).join('[应用数据目录]').replace(/[\u0000-\u001f]/g,' ').slice(0,max);}
 private report(inspection:RestoreStartupInspection|null,notice:string):RestoreRecoveryState{
  this.inspection=inspection;return readRestoreRecoveryState({version:2,active:true,phase:inspection?.safeToOpen?'reviewed':'blocked',observedAt:new Date().toISOString(),namespaceReady:inspection?.safeToOpen??false,restartReady:Boolean(inspection?.safeToOpen&&inspection.permission),notice:this.redact(notice),failure:this.state.failure,transactions:(inspection?.transactions??[]).map(t=>({...t,error:t.error===null?null:this.redact(t.error,512)}))});
 }
 activate(error:RestoreStartupBlocked):void{if(this.closed||this.active||!this.ports.absent())throw new Error('启动恢复核对不能接管活动曲库');this.state=this.report(error.inspection,error.message);}
 activateLibraryFailure(error:CompletedLibraryStartupFailed):void{
  if(this.closed||this.active||!this.ports.absent())throw new Error('曲库启动失败不能接管活动服务');
  const failure={kind:'completed-library-startup' as const,completionId:error.permission.completionId,stage:error.stage,detectedAt:new Date().toISOString(),message:this.redact(error.message)};
  this.state={...this.report(null,'曲库启动未确认，当前没有活动曲库服务。请重新核对目录与记录；原资料保持。'),failure};this.state=readRestoreRecoveryState(this.state);
 }
 private check(authorize:()=>void):void{if(this.closed||!this.active||!this.ports.absent()||this.stopped||this.restarting)throw new Error(this.stopped||'启动恢复核对所属应用已变化');authorize();}
 recheck(authorize:()=>void):Promise<RestoreRecoveryState>{
  authorize();if(this.restarting)throw new Error('重新启动已经请求，请等待应用退出');if(this.reviewWork)throw new Error('请等待原切换回执审核结束');if(this.exportWork)throw new Error('请等待原核对报告保存结束');if(this.work){this.check(authorize);if(this.workKind!=='recheck')throw new Error('请等待原恢复处理结束后再重新核对');return this.work;}this.stopped='';this.moveReview=null;this.check(authorize);this.state={...this.state,phase:'checking',namespaceReady:false,restartReady:false,notice:'正在重新读取原恢复记录，并独立核对当前目录。'};
  const work=Promise.resolve().then(async()=>{const check=()=>this.check(authorize);try{const observed=await inspectCatalogRestoreStartup(this.ports.dataDir,check);check();this.state=this.report(observed,observed.safeToOpen?'本次记录与目录核对通过。曲库仍未打开，数据与启动状态还需进一步核对。':'当前恢复记录或目录仍未获得一致确认，资料保持。');}catch(error){check();this.state=this.report(null,String(error instanceof Error?error.message:error));}return this.snapshot();}).finally(()=>{if(this.work===work){this.work=null;this.workKind=null;}});this.work=work;this.workKind='recheck';void work.catch(()=>{});return work;
 }
 restart(value:unknown,authorize:()=>void):Promise<RestoreRecoveryState>{
  const request=readRestoreRecoveryRestartRequest(value);this.check(authorize);if(this.work||this.exportWork||this.reviewWork)throw new Error('请等待当前核对或报告保存结束');
  const expected=this.state,original=this.inspection;if(expected.phase!=='reviewed'||!expected.namespaceReady||!expected.restartReady||!original?.permission||!original.safeToOpen||lifecycleDigest(this.snapshot())!==request.observedSha256)throw new Error('请先重新核对并确认当前结果');const permission=original.permission;
  const check=()=>{this.check(authorize);if(this.state!==expected)throw new Error('重新启动前核对结果已经变化');};
  const work=Promise.resolve().then(async()=>{
   check();const actual=await inspectCatalogRestoreStartup(this.ports.dataDir,check);check();
   if(!actual.safeToOpen||lifecycleDigest(actual)!==lifecycleDigest(original)){this.state=this.report(actual,'重新启动前记录或目录变化，请阅读新的核对结果后再确认。');throw new Error('重新启动前核对结果变化，资料保持');}
   // The next fresh process independently repeats namespace and existing DB
   // validation. This acceptance is not a claim that the Library has opened.
   check();this.ports.restart(permission);this.restarting=true;this.state=readRestoreRecoveryState({...expected,phase:'restarting',namespaceReady:false,restartReady:false,notice:'已请求重新启动。新进程将再次核对现有曲库；尚未确认打开成功。'});return this.snapshot();
  }).finally(()=>{if(this.work===work){this.work=null;this.workKind=null;}});this.work=work;this.workKind='restart';void work.catch(()=>{});return work;
 }
 reviewRecordedMove(transactionId:unknown,authorize:()=>void):Promise<RecordedMoveReview>{
  this.check(authorize);if(this.work||this.exportWork||this.reviewWork)throw new Error('请等待当前核对或报告保存结束');this.moveReview=null;
  const control=new AbortController();this.moveControl=control;const timer=setTimeout(()=>control.abort(new Error('切换回执审核超过45分钟，资料保持')),45*60*1000),guard=()=>this.check(authorize);
  const work=inspectRecordedMove(this.ports.dataDir,transactionId,guard,control.signal).then(result=>{guard();this.moveReview={value:result.review,authorize};this.state=this.report(result.startup,'原切换退出回执和当前完整内容已核对。补记需单独确认，曲库仍保持关闭。');return result.review;}).finally(()=>{clearTimeout(timer);if(this.reviewWork===work)this.reviewWork=null;if(this.moveControl===control)this.moveControl=null;});this.reviewWork=work;void work.catch(()=>{});return work;
 }
 reconcileRecordedMove(value:unknown,authorize:()=>void):Promise<RestoreRecoveryState>{
  const request=readRecordedMoveConfirmation(value),identity=JSON.stringify(request);this.check(authorize);
  if(this.confirmation?.requestId===request.requestId){if(this.confirmation.identity!==identity)throw new Error('原补记确认内容不能改变');this.confirmation.authorize();return this.confirmation.work;}
  if(this.work||this.exportWork||this.reviewWork)throw new Error('请等待当前核对或报告保存结束');const selected=this.moveReview;
  if(!selected||selected.value.transactionId!==request.transactionId||selected.value.operationId!==request.operationId||lifecycleDigest(selected.value)!==request.reviewSha256)throw new Error('请重新审核原切换回执后确认');selected.authorize();
  const control=new AbortController();this.moveControl=control;const guard=()=>{this.check(authorize);selected.authorize();control.signal.throwIfAborted();};
  const timer=setTimeout(()=>control.abort(new Error('切换回执补记超过45分钟，资料和记录保持')),45*60*1000);
  const work=Promise.resolve().then(async()=>{
   guard();const current=await inspectRecordedMove(this.ports.dataDir,request.transactionId,guard,control.signal);guard();
   if(lifecycleDigest(recordedMoveReviewBasis(current.review))!==lifecycleDigest(recordedMoveReviewBasis(selected.value)))throw new Error('补记前原切换、目录或完整内容变化，请重新审核');
   const nativeProof=current.native.proof;if(!nativeProof)throw new Error('原实际退出证明缺失');
   await new CatalogRestoreTransactionStore(this.ports.dataDir).reconcileRecordedMove(current.transaction,nativeProof,{version:1,requestId:request.requestId,instanceId:this.instanceId,mainPid:process.pid,mainBuildId:RELEASE.mainBuildId,review:selected.value,reviewSha256:request.reviewSha256,startupSha256:selected.value.startupSha256,acceptedAt:new Date().toISOString(),policy:MOVE_RECONCILIATION_POLICY},control.signal,guard);guard();this.moveReview=null;
   const after=await inspectCatalogRestoreStartup(this.ports.dataDir,guard);guard();this.state=this.report(after,'已持久补记原切换完成回执。曲库仍未打开，未决恢复还需继续核对。');return this.snapshot();
  }).finally(()=>{clearTimeout(timer);if(this.work===work){this.work=null;this.workKind=null;}if(this.moveControl===control)this.moveControl=null;});this.work=work;this.workKind='reconcile';this.confirmation={identity,requestId:request.requestId,authorize:selected.authorize,work};void work.catch(()=>{});return work;
 }
 interrupt(reason:string):void{this.moveReview=null;if(this.work||this.exportWork||this.reviewWork){this.stopped||=reason;this.moveControl?.abort(new Error(reason));}}
 exportReport(authorize:()=>void):Promise<string|null>{
  this.check(authorize);if(this.work||this.reviewWork)throw new Error('请等待本次目录或切换回执核对结束');if(this.exportWork)return this.exportWork;
  const expected=this.state,raw=Buffer.from(JSON.stringify({format:'aural-restore-startup-report',version:2,appVersion:RELEASE.appVersion,exportedAt:new Date().toISOString(),snapshot:this.snapshot()},null,2)+'\n');if(raw.length>RESTORE_RECOVERY_REPORT_BYTES+64*1024)throw new Error('编码后的恢复核对报告超过预算');
  const check=()=>{this.check(authorize);if(this.state!==expected)throw new Error('核对报告已经变化，请重新选择保存');};
  const work=Promise.resolve().then(async()=>{check();const filename=await this.ports.pick();check();if(filename===null)return null;await this.writeReport(filename,raw,check);check();return filename;}).finally(()=>{if(this.exportWork===work)this.exportWork=null;});this.exportWork=work;void work.catch(()=>{});return work;
 }
 private async writeReport(filename:string,raw:Buffer,check:()=>void):Promise<void>{
  if(!path.isAbsolute(filename)||path.resolve(filename)!==filename||path.extname(filename).toLowerCase()!=='.json')throw new Error('请选择新的 JSON 核对报告文件');
  const relative=path.relative(this.ports.dataDir,filename);if(relative===''||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw new Error('核对报告需保存到应用数据目录以外');
  const parent=path.dirname(filename);let current=path.parse(parent).root;
  for(const part of parent.slice(current.length).split(path.sep).filter(Boolean)){check();current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('报告保存位置含链接或非目录');}
  if((await fs.realpath(parent)).toLowerCase()!==parent.toLowerCase())throw new Error('报告保存目录实际位置不符');const parentIdentity=identity(await fs.lstat(parent,{bigint:true}));check();
  const handle=await fs.open(filename,'wx+',0o600).catch((error:NodeJS.ErrnoException)=>{if(error.code==='EEXIST')throw new Error('已有同名文件，请为核对报告选择新名称');throw error;});
  try{check();const openedParent=await fs.lstat(parent,{bigint:true});if(openedParent.isSymbolicLink()||identity(openedParent)!==parentIdentity||(await fs.realpath(filename)).toLowerCase()!==filename.toLowerCase())throw new Error('核对报告打开期间目录变化');await handle.writeFile(raw);await handle.sync();const held=await handle.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});if(!held.isFile()||named.isSymbolicLink()||held.nlink!==1n||named.nlink!==1n||held.size!==BigInt(raw.length)||fileObservation(held)!==fileObservation(named))throw new Error('核对报告保存身份未确认');
   const actual=Buffer.alloc(raw.length);let at=0;while(at<actual.length){check();const read=await handle.read(actual,at,actual.length-at,at);if(!read.bytesRead)throw new Error('核对报告读回截断');at+=read.bytesRead;}check();
   const after=await fs.lstat(filename,{bigint:true});if(!actual.equals(raw)||fileObservation(await handle.stat({bigint:true}))!==fileObservation(held)||fileObservation(after)!==fileObservation(held)||after.isSymbolicLink()||after.nlink!==1n||identity(await fs.lstat(parent,{bigint:true}))!==parentIdentity)throw new Error('核对报告读回或保存目录未确认');
  }finally{await handle.close();}
 }
 close():Promise<unknown>{this.interrupt('应用退出，原切换核对和补记需等待结束');this.closed=true;return Promise.allSettled([this.work,this.exportWork,this.reviewWork]);}
}
