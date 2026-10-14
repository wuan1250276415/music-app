import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {FrameReader,encodeFrame} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import {readDsdAnalysisReady,readDsdAnalysisWindow,dsdAnalysisStatus,type DsdAnalysisContext} from '../shared/dsd-analysis.js';
import type {AudioAnalysisFrame,AudioAnalysisStatus} from '../shared/contracts.js';
type Worker={child:ChildProcessWithoutNullStreams;key:string;context:DsdAnalysisContext;ready:boolean;retiring:boolean;closed:Promise<void>;resolveClosed:()=>void;timer:NodeJS.Timeout|null;deadline:NodeJS.Timeout|null;sequence:bigint;request:{id:string;sequence:string;positionTick:string;at:number}|null;anchorAt:number;anchorReceivedAt:number;lastPosition:string|null};
const key=(c:DsdAnalysisContext)=>`${c.sessionId}/${c.generation}`;
// Analysis has its own process and file handle. Failure never reaches playback.fail().
export class DsdAnalysisCopy {
 private worker:Worker|null=null;private desired:DsdAnalysisContext|null=null;private failedKey:string|null=null;
 private status:AudioAnalysisStatus=dsdAnalysisStatus(null,'disabled','分析副本已关闭');
 private retirementUnknown=false;
 constructor(private executable:string,private receive:(frame:AudioAnalysisFrame|null)=>void){}
 snapshot():AudioAnalysisStatus{return {...this.status};}
 update(context:DsdAnalysisContext|null):void {
  this.desired=context?structuredClone(context):null;
  const worker=this.worker;
  if(!context){this.failedKey=null;this.receive(null);this.status=dsdAnalysisStatus(null,'disabled','分析副本已关闭');if(worker)this.retire(worker);return;}
  if(worker&&worker.key===key(context)&&!worker.retiring){
   worker.context=structuredClone(context);if(context.receivedAt!==worker.anchorReceivedAt){worker.anchorReceivedAt=context.receivedAt;worker.anchorAt=performance.now()-Math.max(0,Date.now()-context.receivedAt);}return;
  }
  if(worker){this.status=dsdAnalysisStatus(context,this.retirementUnknown?'failed':'starting',this.retirementUnknown?'旧分析进程退出尚未确认，本次不创建新副本':'正在等待旧分析副本退出');this.retire(worker);return;}
  if(this.retirementUnknown){this.status=dsdAnalysisStatus(context,'failed','旧分析进程退出尚未确认，本次不创建新副本');return;}
  if(this.failedKey===key(context))return;
  this.start(context);
 }
 async waitForStopped():Promise<void>{const w=this.worker;if(w){this.retire(w);await Promise.race([w.closed,new Promise<void>((_,reject)=>{const t=setTimeout(()=>reject(new Error('DSD 分析文件句柄退出未确认')),3000);t.unref();w.closed.finally(()=>clearTimeout(t));})]);}if(this.retirementUnknown)throw new Error('DSD 分析文件句柄退出未确认');}
 private start(c:DsdAnalysisContext):void {
  this.receive(null);this.status=dsdAnalysisStatus(c,'starting','正在建立独立 DSD 分析副本');
  try{
   const child=spawn(this.executable,[],{stdio:['pipe','pipe','pipe'],windowsHide:true});let resolveClosed!:()=>void;
   const w:Worker={child,key:key(c),context:structuredClone(c),ready:false,retiring:false,closed:new Promise(r=>resolveClosed=r),resolveClosed:()=>resolveClosed(),timer:null,deadline:null,sequence:0n,request:null,anchorAt:performance.now()-Math.max(0,Date.now()-c.receivedAt),anchorReceivedAt:c.receivedAt,lastPosition:null};this.worker=w;
   const fail=(error:unknown)=>this.fail(w,error);
   let outputBytes=0,budgetAt=performance.now(),stderrBytes=0;
   const reader=new FrameReader(value=>{
    if(this.worker!==w||w.retiring)return;
    if(!w.ready){readDsdAnalysisReady(value,w.context,RELEASE.hostBuildId);w.ready=true;this.clearDeadline(w);this.request(w);return;}
    const request=w.request;if(!request)throw new Error('DSD 分析存在未请求的窗口');
    const frame=readDsdAnalysisWindow(value,w.context,RELEASE.hostBuildId,request);w.request=null;this.clearDeadline(w);
    if(performance.now()-request.at<=500&&this.desired&&key(this.desired)===w.key){if(frame)frame.receivedAt=Date.now()-Math.ceil(performance.now()-request.at);this.status=dsdAnalysisStatus(w.context,frame?'ready':'warming-up',frame?'独立 PCM 分析副本；滤波延迟对齐待验证':'等待曲目内完整的有效分析窗口');this.receive(frame);}
    else {this.receive(null);this.status=dsdAnalysisStatus(w.context,'warming-up','分析结果已过期，等待新窗口');}
    w.timer=setTimeout(()=>{w.timer=null;this.request(w);},50);w.timer.unref();
   },16384);
   child.stdout.on('data',(chunk:Buffer)=>{if(w.retiring)return;try{const now=performance.now();if(now-budgetAt>=1000){budgetAt=now;outputBytes=0;}if((outputBytes+=chunk.length)>256*1024)throw new Error('DSD 分析输出超过预算');reader.push(chunk);}catch(e){fail(e);}});
   child.stderr.on('data',(chunk:Buffer)=>{if(!w.retiring&&(stderrBytes+=chunk.length)>16384)fail(new Error('DSD 分析诊断超过预算'));});
   child.stdin.on('error',fail);child.on('error',fail);
   child.on('close',()=>{
    if(!w.retiring){try{reader.finish();}catch(e){fail(e);}if(!w.retiring)fail(new Error('DSD 分析进程提前退出'));}
    this.clearTimers(w);w.resolveClosed();if(this.worker===w){this.worker=null;this.retirementUnknown=false;const desired=this.desired;if(desired&&this.failedKey!==key(desired))this.update(desired);}
   });
   this.deadline(w,8000,'DSD 分析准备超时');
   child.stdin.write(encodeFrame({version:1,kind:'init',buildId:RELEASE.mainBuildId,nonce:c.nonce,sessionId:c.sessionId,generation:c.generation,itemId:c.itemId,parentPid:process.pid,path:c.path,source:c.source,range:c.range}));
  }catch(error){this.failedKey=key(c);this.status=dsdAnalysisStatus(c,'failed',String(error));const w=this.worker;if(w)this.retire(w);}
 }
 private request(w:Worker):void {
  if(this.worker!==w||w.retiring||!w.ready||w.request)return;
  const c=w.context,elapsed=performance.now()-w.anchorAt;
  if(elapsed<0||elapsed>500){this.receive(null);this.status=dsdAnalysisStatus(c,'warming-up','等待新的播放时钟锚点');w.timer=setTimeout(()=>{w.timer=null;this.request(w);},50);w.timer.unref();return;}
  const limit=BigInt(c.range.endTick)-BigInt(c.range.startTick),tick=BigInt(c.positionTick)+BigInt(Math.floor(elapsed*c.source.bitRate/1000));const positionTick=String(tick>limit?limit:tick);
  if(positionTick===w.lastPosition){w.timer=setTimeout(()=>{w.timer=null;this.request(w);},50);w.timer.unref();return;}w.lastPosition=positionTick;
  w.request={id:randomUUID(),sequence:String(++w.sequence),positionTick,at:performance.now()};this.deadline(w,2000,'DSD 分析窗口处理超时');
  try{w.child.stdin.write(encodeFrame({version:1,kind:'window',nonce:c.nonce,sessionId:c.sessionId,generation:c.generation,requestId:w.request.id,sequence:w.request.sequence,positionTick}));}catch(e){this.fail(w,e);}
 }
 private fail(w:Worker,error:unknown):void {if(this.worker!==w||w.retiring)return;this.failedKey=w.key;this.receive(null);this.status=dsdAnalysisStatus(w.context,'failed',error instanceof Error?error.message:String(error));this.retire(w);}
 private retire(w:Worker):void {if(w.retiring)return;w.retiring=true;this.clearTimers(w);w.child.stdin.destroy();try{w.child.kill();}catch{}w.deadline=setTimeout(()=>{w.deadline=null;if(this.worker===w){this.retirementUnknown=true;this.receive(null);this.status=dsdAnalysisStatus(this.desired,'failed','分析进程退出尚未确认');}},2500);w.deadline.unref();}
 private deadline(w:Worker,ms:number,message:string):void {this.clearDeadline(w);w.deadline=setTimeout(()=>this.fail(w,new Error(message)),ms);w.deadline.unref();}
 private clearDeadline(w:Worker):void {if(w.deadline)clearTimeout(w.deadline);w.deadline=null;}
 private clearTimers(w:Worker):void {this.clearDeadline(w);if(w.timer)clearTimeout(w.timer);w.timer=null;}
}
