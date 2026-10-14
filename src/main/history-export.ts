import {MaintenanceHold} from './maintenance-hold.js';
import {utilityProcess,type UtilityProcess} from 'electron';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {HistoryExportFile} from './history-export-file.js';
import {HISTORY_EXPORT_FRAME_BYTES,HISTORY_EXPORT_MAX_ROWS,HISTORY_EXPORT_DEADLINE_MS,historyExportId,readHistoryExportRequest,readHistoryExportFrame,readHistoryExportState,readHistoryExportResult,readHistoryPending,historyExportHeaderText,historyExportRowsText,historyExportFooterText,type HistoryExportRequest,type HistoryExportState,type HistoryExportResult,type HistoryExportHeader,type HistoryExportTotals,type HistoryPendingObservation} from '../shared/history-export.js';

type Ports={source:string;workerPath:string;pick:(format:'jsonl'|'csv')=>Promise<string|null>;flush:()=>Promise<void>;pending:()=>HistoryPendingObservation;origin:()=>Promise<unknown>;publish:(state:HistoryExportState)=>void;ready:()=>boolean};
type Stopped={message:string;cancelled:boolean};
const message=(e:unknown)=>String(e instanceof Error?e.message:e).slice(0,1024)||'播放历史导出失败';
export class PlaybackHistoryExporter {
 private readonly maintenance=new MaintenanceHold();
 private state:HistoryExportState={operationId:null,request:null,phase:'idle',rows:0,bytes:0,message:'',result:null};
 private owner:UtilityProcess|null=null;private task:Promise<HistoryExportResult|null>|null=null;private canonical='';private stopped:Stopped|null=null;private closed=false;private lastPublishAt=0;
 constructor(private readonly ports:Ports){}
 snapshot():HistoryExportState{return readHistoryExportState(this.state);}
 private change(patch:Partial<HistoryExportState>):void{
  this.state={...this.state,...patch};const now=Date.now();
  if(Object.keys(patch).every(k=>k==='rows'||k==='bytes')&&now-this.lastPublishAt<100)return;
  this.lastPublishAt=now;try{this.ports.publish(this.snapshot());}catch{/* A reloaded window can read the last Main state. */}
 }
 private stop(message:string,cancelled:boolean):void{
  if(this.stopped||!this.task)return;this.stopped={message,cancelled};this.change({phase:'stopping',message});
  if(this.owner){try{this.owner.postMessage({kind:'cancel',operationId:this.state.operationId});}catch{}try{this.owner.kill();}catch{/* Keep owner until actual exit. */}}
 }
 cancel(value:unknown):boolean{
  const id=historyExportId(value);if(id!==this.state.operationId)throw new Error('导出操作已变化');
  if(!this.task||this.state.phase==='choosing'||this.state.phase==='publishing')return false;this.stop('已请求停止导出，等待只读进程退出。',true);return true;
 }
 interrupt(reason:string):void{if(this.state.phase!=='publishing')this.stop(reason,false);}
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{this.interrupt('曲库维护，历史导出已中断。');await this.task?.catch(()=>{});if(this.owner)throw new Error('历史导出进程尚未确认退出');});}
 endMaintenance(owner:string):void{this.maintenance.end(owner);}
 close():Promise<unknown>{this.closed=true;this.interrupt('应用退出，历史导出已中断。');return this.task?.catch(()=>{})??Promise.resolve();}
 start(value:unknown,authorize:()=>void):Promise<HistoryExportResult|null>{
  this.maintenance.assertAvailable();
  const request=readHistoryExportRequest(value),canonical=JSON.stringify(request);
  if(request.operationId===this.state.operationId){
   if(canonical!==this.canonical)throw new Error('导出身份已用于其他范围');if(this.task)return this.task;
   if(this.state.phase==='completed')return Promise.resolve(this.state.result);if(this.state.phase==='cancelled')return Promise.resolve(null);throw new Error(this.state.message||'原导出未完成，请核对文件后重新选择');
  }
  if(this.closed||!this.ports.ready())throw new Error('曲库尚未就绪');if(this.task||this.owner)throw new Error('已有播放历史导出，请先停止或等待完成');
  this.canonical=canonical;this.stopped=null;this.state={operationId:request.operationId,request,phase:'choosing',rows:0,bytes:0,message:'请选择保存位置。',result:null};this.change({});
  // Begin on the next microtask so cancellation always sees the registered task.
  const work=Promise.resolve().then(()=>this.run(request,authorize));this.task=work;
  void work.finally(()=>{if(this.task===work)this.task=null;}).catch(()=>{});return work;
 }
 private check(authorize:()=>void):void{if(this.stopped)throw new Error(this.stopped.message);if(this.closed||!this.ports.ready())throw new Error('曲库或应用状态已变化');authorize();}
 private async run(request:HistoryExportRequest,authorize:()=>void):Promise<HistoryExportResult|null>{
  const output=new HistoryExportFile();let timer:NodeJS.Timeout|undefined,walTimer:NodeJS.Timeout|undefined,killTimer:NodeJS.Timeout|undefined;
  try{
   const selected=await this.ports.pick(request.format);if(!selected){this.change({phase:'cancelled',message:'已取消选择保存位置。'});return null;}
   this.check(authorize);this.change({phase:'preparing',message:'正在核对待保存记录并建立只读快照…'});
   timer=setTimeout(()=>this.stop('导出超过10分钟预算，等待只读进程退出。',false),HISTORY_EXPORT_DEADLINE_MS);
   await this.ports.flush();this.check(authorize);
   const pending=readHistoryPending(this.ports.pending()),origin=historyExportId(await this.ports.origin());this.check(authorize);
   await output.open(selected,request.format);this.check(authorize);
   const walPath=this.ports.source+'-wal',walStart=await fs.stat(walPath).then(v=>v.size).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return 0;throw e;});
   this.check(authorize);
   const worker=utilityProcess.fork(this.ports.workerPath,[],{serviceName:'Aural History Export',stdio:'pipe',execArgv:['--max-old-space-size=128']});this.owner=worker;
   let header:HistoryExportHeader|null=null,expected=0,before=Number.MAX_SAFE_INTEGER,done:HistoryExportTotals|null=null,chain:Promise<void>=Promise.resolve(),rows=0,plays=0,presented=0n,estimated=0n;
   const hash=createHash('sha256');
   const write=async(text:string)=>{const bytes=Buffer.from(text,'utf8');await output.write(bytes);hash.update(bytes);};
   const exit=new Promise<number>(resolve=>worker.once('exit',code=>{if(this.owner===worker)this.owner=null;resolve(code);}));
   worker.stderr?.on('data',()=>{/* Present bounded structured errors instead of forwarding process stderr. */});
   worker.on('message',raw=>{
    chain=chain.then(async()=>{
     this.check(authorize);if(Buffer.byteLength(JSON.stringify(raw),'utf8')>HISTORY_EXPORT_FRAME_BYTES)throw new Error('导出消息超过预算');
     const frame=readHistoryExportFrame(raw);if(frame.operationId!==request.operationId||frame.sequence!==expected++||done)throw new Error('导出消息身份或顺序不符');
     if(frame.kind==='error')throw new Error(frame.error);
     if(frame.kind==='header'){
      if(header||frame.sequence!==0||frame.header.origin!==origin||frame.header.encoding!==request.format||JSON.stringify(frame.header.scope)!==JSON.stringify(request.scope)||JSON.stringify(frame.header.pendingAtRequest)!==JSON.stringify(pending))throw new Error('导出快照与原请求不符');
      header=frame.header;before=header.ceiling+1;await write(historyExportHeaderText(header));this.change({phase:'running',bytes:output.bytes,message:'正在导出已保存的历史快照…'});
     }else if(frame.kind==='rows'){
      if(!header||rows+frame.rows.length>HISTORY_EXPORT_MAX_ROWS)throw new Error('导出记录范围或数量超出预算');
      for(const row of frame.rows){if(row.id>=before||row.id>header.ceiling||request.scope.itemId&&row.itemId!==request.scope.itemId)throw new Error('导出记录顺序或曲目范围不符');before=row.id;rows++;plays+=row.counted?1:0;presented+=BigInt(row.presentedUs);estimated+=BigInt(row.estimatedUs);}
      await write(historyExportRowsText(request.format,frame.rows));this.change({rows,bytes:output.bytes});
     }else{
      if(!header||JSON.stringify(frame.totals)!==JSON.stringify({rows,plays,presentedUs:String(presented),estimatedUs:String(estimated)}))throw new Error('导出完成总计与接收记录不符');done=frame.totals;
     }
     this.check(authorize);worker.postMessage({kind:'ack',operationId:request.operationId,sequence:frame.sequence});
    }).catch(e=>{this.stop(message(e),false);});
   });
   let checkingWal=false;
   walTimer=setInterval(()=>{
    if(checkingWal||this.owner!==worker)return;checkingWal=true;
    void fs.stat(walPath).then(stat=>{if(stat.size-walStart>128*1024*1024)this.stop('快照期间曲库日志增长超过128MiB，请稍后或缩小范围再导出。',false);}).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT')this.stop('无法核对快照期间曲库日志的增长。',false);}).finally(()=>{checkingWal=false;});
   },1000);
   killTimer=setInterval(()=>{if(this.stopped&&this.owner===worker)try{worker.kill();}catch{/* Actual exit alone releases this owner. */}},1000);
   try{worker.postMessage({kind:'begin',source:this.ports.source,request,pendingAtRequest:pending});}catch(e){this.stop(message(e),false);}
   const code=await exit;await chain;this.check(authorize);
   if(code!==0||!done||!header)throw new Error('导出进程未确认完整结束，保存位置未发布');
   if(timer){clearTimeout(timer);timer=undefined;}
   const sha256=hash.digest('hex');await output.write(Buffer.from(historyExportFooterText(request.format,done,sha256),'utf8'));this.check(authorize);
   this.change({phase:'publishing',bytes:output.bytes,message:'正在完成文件写入…'});
   const publication=await output.publish(()=>this.check(authorize));
   const result=readHistoryExportResult({name:output.name,format:request.format,rows,bytes:output.bytes,sha256,snapshotAt:(header as HistoryExportHeader).snapshotAt,pending:pending.pending,publication});
   this.change({phase:'completed',rows,bytes:output.bytes,result,message:`已导出 ${rows.toLocaleString()} 条已保存记录。${!pending.enabled||pending.error?'待保存记录存在异常，导出只包含已保存数据；文件中已注明。':pending.pending?'请求时仍有待保存数据，文件中已注明。':''}`});return result;
  }catch(e){
   if(this.stopped?.cancelled){this.change({phase:'cancelled',message:'已停止导出，未发布完整文件。'});return null;}
   const error=message(e);this.change({phase:'failed',message:error});throw new Error(error);
  }finally{if(timer)clearTimeout(timer);if(walTimer)clearInterval(walTimer);if(killTimer)clearInterval(killTimer);await output.discard();}
 }
}
