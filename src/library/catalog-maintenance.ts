import {randomUUID,createHash} from 'node:crypto';
import {readMaintenanceBegin,readMaintenanceRelease,readCatalogCaptureRequest,readCatalogMaintenanceState,type CatalogMaintenanceState,type CatalogMaintenanceLease,type CatalogCaptureRequest,type CatalogCapturedSnapshot} from '../shared/catalog-maintenance.js';
import {readCatalogServiceStopRequest,type CatalogServiceStopReceipt} from '../platform/catalog-library-lifecycle.js';

type Ports={freeze:(owner:string,waitRequests:()=>Promise<void>)=>Promise<void>;release:(owner:string,resumeWatch:boolean)=>Promise<void>;capture:(request:CatalogCaptureRequest,check:()=>void)=>Promise<CatalogCapturedSnapshot>};
export class CatalogMaintenance {
 private state:CatalogMaintenanceState={operationId:null,token:null,phase:'idle',message:''};
 private readonly requests=new Set<Promise<unknown>>();private freezeWork:Promise<CatalogMaintenanceState>|null=null;
 private captureWork:Promise<CatalogCapturedSnapshot>|null=null;private captureKey='';private releaseWork:Promise<CatalogMaintenanceState>|null=null;private releaseIntent:boolean|null=null;
 private closeWork:Promise<CatalogServiceStopReceipt>|null=null;private closeKey='';private preparing=false;
 constructor(private readonly ports:Ports){}
 snapshot():CatalogMaintenanceState{return readCatalogMaintenanceState(this.state);}
 get held():boolean{return this.state.phase!=='idle'&&this.state.phase!=='released';}
 run<T>(action:()=>Promise<T>):Promise<T>{
  if(this.held)return Promise.reject(new Error('曲库正在备份或恢复维护中，请等待维护结束'));
  const work=Promise.resolve().then(()=>{if(this.held)throw new Error('曲库已进入维护，未开始此操作');return action();}).finally(()=>{this.requests.delete(work);});this.requests.add(work);return work;
 }
 private lease(value:CatalogMaintenanceLease):void{if(value.operationId!==this.state.operationId||value.token!==this.state.token)throw new Error('曲库维护身份已变化');}
 begin(value:unknown):Promise<CatalogMaintenanceState>{
  const r=readMaintenanceBegin(value);if(r.operationId===this.state.operationId){if(this.state.phase==='released'||this.state.phase==='failed')throw new Error('原曲库维护已经结束或失败，请核对状态');if(this.state.phase==='draining'&&this.freezeWork)return this.freezeWork;return Promise.resolve(this.snapshot());}
  if(this.held)throw new Error('已有曲库维护尚未结束');this.state={operationId:r.operationId,token:randomUUID(),phase:'draining',message:'正在停止后台任务并等待原操作退出。'};this.captureWork=null;this.captureKey='';this.releaseWork=null;this.releaseIntent=null;this.closeWork=null;this.closeKey='';
  const token=this.state.token!;
  const work=Promise.resolve().then(async()=>{
   try{await this.ports.freeze(token,async()=>{await Promise.allSettled([...this.requests]);if(this.requests.size)throw new Error('仍有曲库请求没有结束');});this.state={...this.state,phase:'frozen',message:'曲库任务与文件操作已确认停止。'};return this.snapshot();}
   catch(error){this.state={...this.state,phase:'failed',message:String(error instanceof Error?error.message:error).slice(0,1024)};throw error;}
  });this.freezeWork=work;void work.catch(()=>{});return work;
 }
 capture(value:unknown):Promise<CatalogCapturedSnapshot>{
  const r=readCatalogCaptureRequest(value);this.lease(r);const key=createHash('sha256').update(JSON.stringify(r)).digest('hex');
  if(this.captureWork){if(key!==this.captureKey)throw new Error('同一维护身份已用于不同捕获请求');return this.captureWork;}
  if(this.releaseWork||this.preparing)throw new Error('曲库维护已请求释放或正在激活，不能再开始捕获');
  if(this.state.phase!=='frozen')throw new Error('曲库尚未完成维护停止，不能建立快照');this.captureKey=key;this.state={...this.state,phase:'capturing',message:'正在建立一致数据库与恢复资料快照。'};
  const check=()=>{this.lease(r);if(this.state.phase!=='capturing')throw new Error('曲库捕获维护状态已变化');};
  const work=Promise.resolve().then(()=>this.ports.capture(r,check)).catch(error=>{
   const cause=error instanceof Error&&error.cause instanceof Error?error.cause.message:'';
   this.state={...this.state,phase:'frozen',message:('快照捕获失败：'+String(error instanceof Error?error.message:error)+(cause?'；'+cause:'')).slice(0,1024)};throw error;
  }).finally(()=>{if(this.state.phase==='capturing')this.state={...this.state,phase:'frozen',message:'快照捕获已结束，等待明确释放维护。'};});this.captureWork=work;void work.catch(()=>{});return work;
 }
 release(value:unknown):Promise<CatalogMaintenanceState>{
  const r=readMaintenanceRelease(value);this.lease(r);
  if(this.releaseWork){if(this.releaseIntent!==r.resumeWatch)throw new Error('原维护释放请求的恢复意图不同');return this.releaseWork;}
  if(this.preparing||this.state.phase==='failed'||this.state.phase==='closing'||this.state.phase==='closed'||this.closeWork)throw new Error('维护停止未确认或曲库已进入关闭，须保留占用并重新启动后核对');
  this.releaseIntent=r.resumeWatch;
  const work=Promise.resolve().then(async()=>{
   await this.freezeWork;await this.captureWork?.catch(()=>{});this.lease(r);if(this.state.phase!=='frozen')throw new Error('曲库维护尚未准备好释放');
   this.state={...this.state,phase:'releasing',message:'正在释放维护占用。'};
   try{await this.ports.release(r.token,r.resumeWatch);this.state={...this.state,phase:'released',message:'曲库维护已释放；中断任务保留原状态。'};return this.snapshot();}
   catch(error){this.state={...this.state,phase:'failed',message:String(error instanceof Error?error.message:error).slice(0,1024)};throw error;}
  });this.releaseWork=work;void work.catch(()=>{});return work;
 }
 async prepareFrozen<T>(lease:CatalogMaintenanceLease,prepare:()=>Promise<T>):Promise<T>{
  this.lease(lease);if(this.preparing||this.releaseWork||this.closeWork||this.state.phase!=='frozen')throw new Error('曲库冻结状态尚未准备好激活');this.preparing=true;
  try{await this.freezeWork;this.lease(lease);if(this.requests.size)throw new Error('激活前仍有原曲库请求');return await prepare();}
  catch(error){this.state={...this.state,phase:'failed',message:String(error instanceof Error?error.message:error).slice(0,1024)};throw error;}
  finally{this.preparing=false;}
 }
 closeFrozen(value:unknown,close:()=>Promise<CatalogServiceStopReceipt>):Promise<CatalogServiceStopReceipt>{
  const request=readCatalogServiceStopRequest(value);this.lease(request);const key=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  if(this.closeWork){if(key!==this.closeKey)throw new Error('同一维护已用于不同的关闭请求');return this.closeWork;}
  if(this.preparing||this.releaseWork||this.state.phase!=='frozen')throw new Error('曲库尚未冻结、正在激活或已请求释放，不能关闭');this.closeKey=key;this.state={...this.state,phase:'closing',message:'正在关闭冻结曲库，等待持久关闭回执。'};
  const work=Promise.resolve().then(async()=>{await this.freezeWork;await this.captureWork?.catch(()=>{});this.lease(request);if(this.requests.size)throw new Error('仍有原曲库请求未结束');const receipt=await close();this.state={...this.state,phase:'closed',message:'数据库已关闭，等待原主进程确认后退出。'};return receipt;}).catch(error=>{this.state={...this.state,phase:'failed',message:String(error instanceof Error?error.message:error).slice(0,1024)};throw error;});this.closeWork=work;void work.catch(()=>{});return work;
 }
}
