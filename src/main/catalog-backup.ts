import {utilityProcess,type UtilityProcess} from 'electron';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import type {MainCatalogResources} from './catalog-main-resources.js';
import {CatalogBackupPublication} from './catalog-backup-publication.js';
import {CatalogBackupLedger,backupFileProof,type LoadedBackupOperation} from './catalog-backup-ledger.js';
import type {CatalogBackupHistory} from '../shared/catalog-backup-history.js';
import {backupUuid,readCatalogBackupManifest,type RendererPendingSnapshot} from '../shared/catalog-backup.js';
import {readCatalogMaintenanceState,type CatalogMaintenanceState,type CatalogCapturedSnapshot} from '../shared/catalog-maintenance.js';
import {readBackupFreeze,readBackupFrozen,readBackupState,readBackupResult,type CatalogBackupState,type CatalogBackupFreeze,type CatalogBackupResult} from '../shared/catalog-backup-ui.js';
import {BACKUP_WORKER_FRAME_BYTES,readBackupWorkerFrame,type BackupPackedResult} from '../shared/catalog-backup-worker.js';
type Ports={resources:MainCatalogResources;dataDir:string;workerPath:string;ready:()=>boolean;quitting:()=>boolean;sleeping:()=>boolean;pick:()=>Promise<string|null>;
 otherBusy?:()=>boolean;
 call:<T>(method:string,params?:unknown)=>Promise<T>;publish:(state:CatalogBackupState)=>void;freeze:(request:CatalogBackupFreeze)=>void;thaw:(operationId:string)=>void;changed:()=>void};
const message=(error:unknown)=>String(error instanceof Error?error.message:error).slice(0,1024)||'曲库备份失败';
export class CatalogBackupCoordinator {
 private state:CatalogBackupState={operationId:null,phase:'idle',held:false,cancelRequested:false,bytes:0,total:0,message:'',result:null};
 private work:Promise<CatalogBackupResult|null>|null=null;private owner:UtilityProcess|null=null;private stopped='';private closed=false;private lastProgress=0;
 private frozen:{request:CatalogBackupFreeze;authorize:()=>void;resolve:(pending:RendererPendingSnapshot)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
 private frozenReceipt:{operationId:string;challenge:string;sha256:string;authorize:()=>void}|null=null;
 private readonly ledger:CatalogBackupLedger;
 private historyRead:Promise<CatalogBackupHistory>|null=null;
 constructor(private readonly ports:Ports){this.ledger=new CatalogBackupLedger(ports.dataDir);}
 get busy():boolean{return Boolean(this.work||this.owner||this.state.held);}
 history():Promise<CatalogBackupHistory>{if(this.historyRead)return this.historyRead;const pending=this.ledger.list();this.historyRead=pending;void pending.finally(()=>{if(this.historyRead===pending)this.historyRead=null;}).catch(()=>{});return pending;}
 snapshot():CatalogBackupState{return readBackupState(this.state);}
 private change(patch:Partial<CatalogBackupState>):void{this.state={...this.state,...patch};if(Object.keys(patch).every(k=>k==='bytes'||k==='total')&&Date.now()-this.lastProgress<100)return;this.lastProgress=Date.now();try{this.ports.publish(this.snapshot());}catch{/* A reloaded document reads the authoritative Main state. */}}
 frozenReply(value:unknown,authorize:()=>void):void{
  authorize();const reply=readBackupFrozen(value),waiting=this.frozen,sha256=createHash('sha256').update(JSON.stringify(reply)).digest('hex');
  if(!waiting){const old=this.frozenReceipt;if(!old||reply.operationId!==old.operationId||reply.challenge!==old.challenge||sha256!==old.sha256)throw new Error('备份冻结挑战已过期或内容已变化');old.authorize();return;}
  if(reply.operationId!==waiting.request.operationId||reply.challenge!==waiting.request.challenge)throw new Error('备份冻结挑战已过期');
  waiting.authorize();this.frozenReceipt={operationId:reply.operationId,challenge:reply.challenge,sha256,authorize:waiting.authorize};clearTimeout(waiting.timer);this.frozen=null;if(reply.pending)waiting.resolve(reply.pending);else waiting.reject(new Error(reply.error));
 }
 private requestFreeze(operationId:string,authorize:()=>void):Promise<RendererPendingSnapshot>{
  const request=readBackupFreeze({operationId,challenge:randomUUID()});return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{if(this.frozen?.request.challenge===request.challenge){this.frozen=null;reject(new Error('界面未确认待保存资料冻结，未开始曲库快照'));}},10000);
   this.frozen={request,authorize,resolve,reject,timer};try{this.ports.freeze(request);}catch(error){clearTimeout(timer);this.frozen=null;reject(error);}
  });
 }
 private check(authorize:()=>void):void{if(this.stopped)throw new Error(this.stopped);if(this.closed||!this.ports.ready()||this.ports.quitting()||this.ports.sleeping())throw new Error('应用或曲库状态已变化，备份未完成');authorize();}
 interrupt(reason:string):void{
  if(!this.work)return;this.stopped||=reason;
  if(this.frozen){const pending=this.frozen;this.frozen=null;clearTimeout(pending.timer);pending.reject(new Error(reason));}
  if(this.owner){try{this.owner.postMessage({kind:'cancel',operationId:this.state.operationId});}catch{}try{this.owner.kill();}catch{/* Keep ownership until actual exit. */}}
 }
 cancel(value:unknown):boolean{
  if(backupUuid(value)!==this.state.operationId)throw new Error('备份操作已变化');if(!this.work||this.state.phase==='choosing'||this.state.phase==='publishing')return false;
  this.change({cancelRequested:true,message:'已请求取消，等待原操作与进程结束。'});this.interrupt('曲库备份已取消');return true;
 }
 close():Promise<unknown>{this.closed=true;this.interrupt('应用退出，备份已中断');if(this.owner)try{this.owner.kill();}catch{}return this.work?.catch(()=>{})??Promise.resolve();}
 start(value:unknown,authorize:()=>void):Promise<CatalogBackupResult|null>{
  const operationId=backupUuid(value);authorize();
  if(operationId===this.state.operationId){if(this.work)return this.work;if(this.state.phase==='completed')return Promise.resolve(this.state.result);if(this.state.phase==='cancelled')return Promise.resolve(null);throw new Error(this.state.message||'原备份尚未确认完成，请核对后发起新备份');}
  if(this.work||this.owner||this.ports.resources.held||this.state.held||this.ports.otherBusy?.())throw new Error('已有备份、恢复或维护尚未结束');if(this.closed||!this.ports.ready()||this.ports.quitting()||this.ports.sleeping())throw new Error('曲库尚未准备好备份');
  this.stopped='';this.frozenReceipt=null;this.state={operationId,phase:'choosing',held:false,cancelRequested:false,bytes:0,total:0,message:'请选择备份保存位置。',result:null};this.change({});
  const work=Promise.resolve().then(()=>this.run(operationId,authorize));this.work=work;void work.finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return work;
 }
 verify(value:unknown,authorize:()=>void):Promise<CatalogBackupResult|null>{
  const operationId=backupUuid(value);authorize();if(this.work||this.owner||this.ports.resources.held||this.state.held||this.ports.otherBusy?.())throw new Error('已有备份、恢复或维护尚未结束');
  if(this.closed||!this.ports.ready()||this.ports.quitting()||this.ports.sleeping())throw new Error('曲库尚未准备好核对备份');
  this.stopped='';this.state={operationId,phase:'verifying',held:false,cancelRequested:false,bytes:0,total:0,message:'正在读取原备份操作证明并核对文件。',result:null};this.change({});
  const work=Promise.resolve().then(()=>this.runVerification(operationId,authorize));this.work=work;void work.finally(()=>{if(this.work===work)this.work=null;}).catch(()=>{});return work;
 }
 private async runVerification(operationId:string,authorize:()=>void):Promise<CatalogBackupResult|null>{
  let op:LoadedBackupOperation|null=null;const deadline=setTimeout(()=>this.interrupt('备份核对超过45分钟，等待原进程结束后停止。'),45*60*1000);
  try{
   op=await this.ledger.load(operationId);this.check(authorize);const target=await this.ledger.assertTarget(op),input=this.ledger.verificationInput(op);
   // Read-only verification never resumes a maintenance hold or republishes a file.
   const verified=await this.worker({stagePath:input.stagePath,manifest:input.manifest},target,authorize,'verify');this.check(authorize);
   if(verified.bytes!==input.proof.bytes||verified.sha256!==input.proof.sha256)throw new Error('当前备份内容与原快照证明不符');
   await this.ledger.assertTarget(op,backupFileProof(verified));this.check(authorize);
   const original=op.records.at(-1)!.checkpoint.result;
   const text=original?'原备份文件内容已重新核对，未恢复或改写当前曲库。':'目标文件内容与原快照一致；原操作没有完成保存回执，未重新发布或恢复曲库。';
   await this.ledger.append(op,{kind:'verified',verification:backupFileProof(verified),message:text});this.check(authorize);
   // Reconciliation is not a fabricated publication result.
   this.change({phase:'checked',result:original,message:text,bytes:verified.bytes,total:verified.bytes});return original;
  }catch(error){
   let cause=message(error);if(op)try{await this.ledger.append(op,{kind:'verificationFailed',message:cause});}catch(recordError){cause=(cause+'；核对记录未确认：'+message(recordError)).slice(0,1024);}
   this.change({phase:this.state.cancelRequested?'cancelled':'failed',message:cause,result:null});if(this.state.cancelRequested)return null;throw new Error(cause);
  }finally{clearTimeout(deadline);}
 }
 private async worker(snapshot:CatalogCapturedSnapshot,output:string,authorize:()=>void,mode:'pack'|'verify'='pack'):Promise<BackupPackedResult>{
  this.check(authorize);const worker=utilityProcess.fork(this.ports.workerPath,[],{serviceName:'Aural Catalog Backup',stdio:'pipe',execArgv:['--max-old-space-size=256']});this.owner=worker;
  let expected=0,result:BackupPackedResult|null=null,failure='',seenDone=false,diagnostics=0;
  const exited=new Promise<number>(resolve=>worker.once('exit',code=>{if(this.owner===worker)this.owner=null;resolve(code);}));
  const stop=(error:unknown)=>{failure||=message(error);try{worker.kill();}catch{}};
  const retryKill=setInterval(()=>{if((this.stopped||this.closed||failure)&&this.owner===worker)try{worker.kill();}catch{}},1000);
  worker.stderr?.on('data',(data:Buffer)=>{diagnostics+=data.length;if(diagnostics>16384)stop(new Error('备份诊断超过预算'));});
  worker.on('message',raw=>{
   if(this.owner!==worker)return;
   try{
    this.check(authorize);if(Buffer.byteLength(JSON.stringify(raw),'utf8')>BACKUP_WORKER_FRAME_BYTES)throw new Error('备份进程消息超过预算');const frame=readBackupWorkerFrame(raw);
    if(frame.operationId!==snapshot.manifest.backupId||frame.sequence!==expected++||seenDone)throw new Error('备份进程身份或顺序不符');
    if(frame.kind==='error')throw new Error(frame.message);
    if(frame.kind==='progress'){this.change({phase:mode==='verify'?(this.state.phase==='publishing'?'publishing':'verifying'):frame.phase,bytes:frame.bytes,total:frame.total});return;}
    if(JSON.stringify(frame.result.manifest)!==JSON.stringify(snapshot.manifest))throw new Error('备份进程清单与已捕获快照不符');result=frame.result;seenDone=true;
    worker.postMessage({kind:'ack',operationId:frame.operationId,sequence:frame.sequence});
   }catch(error){stop(error);}
  });
  try{
   try{worker.postMessage({kind:'begin',mode,operationId:snapshot.manifest.backupId,root:snapshot.stagePath,output,manifest:snapshot.manifest});}catch(error){stop(error);}
   const code=await exited;this.check(authorize);if(failure)throw new Error(failure);if(code!==0||!result)throw new Error('备份进程未正常确认退出，文件未确认完成');return result;
  }finally{clearInterval(retryKill);}
 }
 private async run(operationId:string,authorize:()=>void):Promise<CatalogBackupResult|null>{
  const output=new CatalogBackupPublication();let operation:LoadedBackupOperation|null=null,mainBegun=false,mainFrozen=false,libraryBegun=false,library:CatalogMaintenanceState|null=null,released=false;
  let deadline:NodeJS.Timeout|undefined;
  const release=async()=>{
   if(released)return;this.change({phase:'releasing',message:'正在恢复曲库及主窗口后台任务。'});
   const resume=!this.closed&&!this.ports.quitting()&&!this.ports.sleeping();
   if(libraryBegun){
    // Reconcile lost delivery before retrying an immutable release intent. Idle or
    // already released is authoritative absence of a live Library maintenance hold.
    const actual=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceState'));
    if(actual.phase!=='idle'&&actual.phase!=='released'){
     if(actual.operationId!==operationId||!actual.token||actual.phase==='failed'||library?.token&&library.token!==actual.token)throw new Error('曲库维护停止未确认，须退出后重新打开应用');
     library=actual;const state=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceRelease',{operationId,token:actual.token,resumeWatch:resume}));if(state.phase!=='released'||state.operationId!==operationId)throw new Error('曲库未确认释放维护');
    }
   }
   if(mainBegun){if(!mainFrozen)throw new Error('主窗口资源停止未确认，须退出后重新打开应用');await this.ports.resources.release(operationId,resume);}
   released=true;this.change({held:false});try{this.ports.thaw(operationId);}catch{/* Source release is authoritative even when a document disappears. */}if(resume)try{this.ports.changed();}catch{}
  };
  try{
   operation=await this.ledger.create(operationId);this.check(authorize);
   const filename=await this.ports.pick();if(!filename){await this.ledger.append(operation,{kind:'cancelled',message:'已取消选择备份保存位置。'});this.change({phase:'cancelled',message:'已取消选择备份保存位置。'});return null;}
   this.check(authorize);await output.prepare(filename);this.check(authorize);
   await this.ledger.append(operation,{kind:'selected',destination:output.descriptor(),message:'原生选择的保存位置已登记。'});this.check(authorize);
   deadline=setTimeout(()=>this.interrupt('备份超过45分钟，等待原操作结束后停止。'),45*60*1000);
   this.change({phase:'freezing',held:true,message:'正在冻结界面待保存资料。'});const pending=await this.requestFreeze(operationId,authorize);this.check(authorize);
   this.change({phase:'draining',message:'正在停止播放并等待原任务退出。'});mainBegun=true;await this.ports.resources.begin(operationId);mainFrozen=true;this.check(authorize);
   libraryBegun=true;library=readCatalogMaintenanceState(await this.ports.call('catalogMaintenanceBegin',{operationId}));if(library.operationId!==operationId||library.phase!=='frozen'||!library.token)throw new Error('曲库维护未完成停止');this.check(authorize);
   this.change({phase:'capturing',message:'正在建立曲库与待保存资料的一致快照。'});
   const captured=await this.ports.call<CatalogCapturedSnapshot>('catalogMaintenanceCapture',{operationId,token:library.token,pending});this.check(authorize);
   const manifest=readCatalogBackupManifest(captured.manifest),parent=path.join(this.ports.dataDir,'backups','catalog');
   if(manifest.backupId!==operationId||typeof captured.stagePath!=='string'||path.dirname(captured.stagePath)!==parent||!path.basename(captured.stagePath).startsWith('.aural-backup-'+operationId+'-'))throw new Error('曲库快照来源身份无效');
   const snapshot={stagePath:captured.stagePath,manifest};await this.ledger.capture(operation,snapshot.stagePath,manifest);await release();this.check(authorize);
   this.change({phase:'packing',bytes:0,total:0,message:'曲库快照已捕获，正在生成并独立复核备份文件。'});
   await output.budget(12+Buffer.byteLength(JSON.stringify(manifest),'utf8')+manifest.files.reduce((sum,file)=>sum+file.bytes,0)+40);this.check(authorize);
   const proof=await this.worker(snapshot,output.temporary,authorize);await output.adopt(proof);this.check(authorize);
   await this.ledger.append(operation,{kind:'packed',packed:backupFileProof(proof),message:'备份文件生成及独立校验进程已正常退出，尚未发布。'});this.check(authorize);
   this.change({phase:'publishing',bytes:proof.bytes,total:proof.bytes,message:'正在完成备份文件保存。'});
   await this.ledger.append(operation,{kind:'publishing',message:'发布意图已保存；完成回执前不认定目标文件保存成功。'});this.check(authorize);
   const publication=await output.publish(()=>this.check(authorize),async filename=>{
    const copied=await this.worker(snapshot,filename,authorize,'verify');
    if(copied.bytes!==proof.bytes||copied.sha256!==proof.sha256)throw new Error('复制发布的备份与已校验工件不符');return copied;
   });
   const result=readBackupResult({name:output.name,bytes:proof.bytes,sha256:proof.sha256,createdAt:manifest.createdAt,items:manifest.counts.playable_item,files:manifest.files.length,publication});
   const published=await output.publishedProof();await this.ledger.append(operation,{kind:'completed',published:backupFileProof(published),result,message:'备份保存完成；重启后可重新核对当前文件。'});
   this.change({phase:'completed',held:false,result,message:'曲库备份已保存。音乐源文件与系统凭据不包含在备份中。'});return result;
  }catch(error){
   let cause=message(error);
   try{await release();}catch(releaseError){cause=(cause+'；'+message(releaseError)).slice(0,1024);}
   const held=this.ports.resources.held||!released,phase=this.state.cancelRequested&&!held?'cancelled':'failed';
   if(operation)try{await this.ledger.append(operation,{kind:phase,message:cause});}catch(recordError){cause=(cause+'；操作记录未确认：'+message(recordError)).slice(0,1024);}
   this.change({phase,held,message:cause});
   if(this.state.phase==='cancelled')return null;throw new Error(cause);
  }finally{if(deadline)clearTimeout(deadline);if(this.frozen){clearTimeout(this.frozen.timer);this.frozen=null;}}
 }
}
