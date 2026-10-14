import {TAG_PREVIEW_RESPONSE_LIMIT,type FlacTagPreview} from '../shared/tag-write.js';
import {spawn} from 'node:child_process';
import {FileReadGate} from './file-read-gate.js';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import type {ParsedFile} from './database.js';
import type {ParsedCueSource} from './cue-read.js';
import type {ArtworkCandidate} from '../shared/contracts.js';
import {MEDIA_PROTOCOL_VERSION,MEDIA_REQUEST_LIMIT,MEDIA_RESPONSE_LIMIT,CUE_RESPONSE_LIMIT,ARTWORK_RESPONSE_LIMIT,LYRICS_RESPONSE_LIMIT,MediaBoundaryError,mediaFrame,validateMediaRequest,validateMediaResponse,type MediaRequest,type MediaResponse} from './media-worker-protocol.js';

export class MediaWorkerUnavailable extends Error{}
export class MediaWorkerExitUnconfirmed extends MediaWorkerUnavailable{}
export class MediaParser {
 async beginMaintenance(owner:string):Promise<void>{await this.reads.quiesceAll(owner);if(this.busy||this.waiting.length||this.uncertain)throw new MediaWorkerExitUnconfirmed('媒体读取未全部退出或监督生命周期不明确，不能建立快照');}
 endMaintenance(owner:string):void{if(this.busy||this.waiting.length||this.uncertain)throw new MediaWorkerExitUnconfirmed('媒体维护尚未确认完成');this.reads.releaseAll(owner);}
 private readonly reads=new FileReadGate();
 async quiesceFile(filename:string,owner:string):Promise<void>{await this.reads.quiesce(filename,owner);if(this.uncertain)throw new MediaWorkerExitUnconfirmed('媒体读取进程退出不明确，不能开始文件暂存');}
 releaseFile(filename:string,owner:string):void{this.reads.release(filename,owner);}
 releaseRecoveredFile(filename:string,owner:string):void{this.reads.releaseRecovered(filename,owner);}
 private busy=false;
 private unavailable='';
 private uncertain=false;
 private foregroundBurst=0;
 private readonly waiting:Array<{kind:MediaRequest['kind'];start:()=>void;fail:(error:Error)=>void}>=[];
 constructor(private readonly executable=path.resolve(__dirname,'../../../native/media-worker/build/media-worker.exe')){}
 async parse(input:Omit<MediaRequest,'version'|'id'|'kind'>,signal:AbortSignal):Promise<ParsedFile>{const result=await this.execute('tags',input,signal);if(result.kind!=='result')throw new Error('标签任务回执类型无效');return result.file;}
 async cue(input:Omit<MediaRequest,'version'|'id'|'kind'>,signal:AbortSignal):Promise<ParsedCueSource>{const result=await this.execute('cue',input,signal);if(result.kind!=='cue')throw new Error('CUE 任务回执类型无效');return result.source;}
 async artwork(input:Omit<MediaRequest,'version'|'id'|'kind'|'artworkSource'>&{artworkSource:'embedded'|'sidecar'},signal:AbortSignal):Promise<ArtworkCandidate|null>{const result=await this.execute('artwork',input,signal);if(result.kind!=='artwork')throw new Error('封面任务回执类型无效');return result.candidate;}
 async image(input:Omit<MediaRequest,'version'|'id'|'kind'>&{thumbnailSize:256|1024},signal:AbortSignal):Promise<import('../shared/contracts.js').ConvertedCoverImage>{const result=await this.execute('image',input,signal);if(result.kind!=='image')throw new Error('图片转换回执类型无效');return result.image;}
 async lyrics(input:Omit<MediaRequest,'version'|'id'|'kind'>,signal:AbortSignal){const result=await this.execute('lyrics',input,signal);if(result.kind!=='lyrics')throw new Error('歌词任务回执类型无效');return {documents:result.documents,observations:result.observations,notice:result.notice};}
 async flacTagPreview(input:Omit<MediaRequest,'version'|'id'|'kind'>,signal:AbortSignal):Promise<FlacTagPreview>{const result=await this.execute('flac-tag-preview',input,signal);if(result.kind!=='flac-tag-preview')throw new Error('FLAC 标签预览回执类型无效');return result.preview;}
 // Internal owner-bound reads retain the existing block for all ordinary callers.
 async parseOwned(input:Omit<MediaRequest,'version'|'id'|'kind'>,owner:string,signal:AbortSignal):Promise<ParsedFile>{const result=await this.execute('tags',input,signal,owner);if(result.kind!=='result')throw new Error('重新解析回执类型无效');return result.file;}
 async flacTagPreviewOwned(input:Omit<MediaRequest,'version'|'id'|'kind'>,owner:string,signal:AbortSignal):Promise<FlacTagPreview>{const result=await this.execute('flac-tag-preview',input,signal,owner);if(result.kind!=='flac-tag-preview')throw new Error('目标标签回执类型无效');return result.preview;}
 private fault():Error{return this.uncertain?new MediaWorkerExitUnconfirmed(this.unavailable):new MediaWorkerUnavailable(this.unavailable);}
 private acquire(kind:MediaRequest['kind'],signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(this.unavailable)return Promise.reject(this.fault());
  if(!this.busy){this.busy=true;this.foregroundBurst=kind==='artwork'||kind==='image'||kind==='lyrics'||kind==='flac-tag-preview'?1:0;return Promise.resolve();}
  if(this.waiting.length>=16)return Promise.reject(new Error('媒体任务等待队列已满，请稍后重试'));
  return new Promise((resolve,reject)=>{
   const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',aborted);const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);};
   const aborted=()=>{clean();reject(signal.reason??new Error('媒体任务已取消'));};
   const entry={kind,start:()=>{clean();resolve();},fail:(error:Error)=>{clean();reject(error);}};
   // A scan's wait is cancellable but does not consume its per-file execution budget.
   const timer=kind==='artwork'||kind==='image'||kind==='lyrics'||kind==='flac-tag-preview'?setTimeout(()=>entry.fail(new Error('媒体前台任务等待超过 25 秒，请稍后重试')),25000):undefined;
   this.waiting.push(entry);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();
  });
 }
 private release():void{
  if(this.unavailable){this.busy=false;for(const entry of [...this.waiting])entry.fail(this.fault());return;}
  const foreground=(kind:MediaRequest['kind'])=>kind==='artwork'||kind==='image'||kind==='lyrics'||kind==='flac-tag-preview';
  const background=this.waiting.find(entry=>!foreground(entry.kind));
  const next=this.foregroundBurst>=3&&background?background:this.waiting.find(entry=>foreground(entry.kind))??background;
  if(!next){this.busy=false;this.foregroundBurst=0;return;}this.foregroundBurst=foreground(next.kind)?this.foregroundBurst+1:0;next.start();
 }
 private async execute(kind:MediaRequest['kind'],input:Omit<MediaRequest,'version'|'id'|'kind'>,signal:AbortSignal,owner?:string):Promise<MediaResponse>{
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason??new Error('媒体读取已取消'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  try{const action=()=>this.executeRegistered(kind,input,controller.signal),cancel=()=>controller.abort(new Error('文件操作正在等待读取进程退出'));return await (owner===undefined?this.reads.run(input.fullPath,action,cancel):this.reads.runOwned(input.fullPath,owner,action,cancel));}finally{signal.removeEventListener('abort',abort);}
 }
 private async executeRegistered(kind:MediaRequest['kind'],input:Omit<MediaRequest,'version'|'id'|'kind'>,signal:AbortSignal):Promise<MediaResponse>{
  signal.throwIfAborted();
  if(process.platform!=='win32'||!path.isAbsolute(this.executable))throw new MediaWorkerUnavailable('当前平台尚未配置媒体监督组件');
  const request=validateMediaRequest({...input,...(kind==='cue'?{cueEncoding:input.cueEncoding??'auto',cueGapPolicy:input.cueGapPolicy??'previous'}:{}),version:MEDIA_PROTOCOL_VERSION,kind,id:randomUUID()}),frame=mediaFrame(request,MEDIA_REQUEST_LIMIT);
  await this.acquire(kind,signal);
  try{signal.throwIfAborted();return await this.launch(request,frame,signal);}finally{this.release();}
 }
 private launch(request:MediaRequest,frame:Buffer,signal:AbortSignal):Promise<MediaResponse>{
  return new Promise((resolve,reject)=>{
   // Do not inherit NODE_OPTIONS, inspector flags, credentials or Electron overrides.
   const env:NodeJS.ProcessEnv={ELECTRON_RUN_AS_NODE:'1'};
   for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
   let child:ReturnType<typeof spawn>;
   try{child=spawn(this.executable,[process.execPath,path.resolve(__dirname,'media-worker-entry.js'),String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});}
   catch(error){this.unavailable='无法启动媒体监督组件';reject(new MediaWorkerUnavailable(this.unavailable));return;}
   const responseLimit=request.kind==='flac-tag-preview'?TAG_PREVIEW_RESPONSE_LIMIT:request.kind==='cue'?CUE_RESPONSE_LIMIT:request.kind==='artwork'||request.kind==='image'?ARTWORK_RESPONSE_LIMIT:request.kind==='lyrics'?LYRICS_RESPONSE_LIMIT:MEDIA_RESPONSE_LIMIT,chunks:Buffer[]=[],header=Buffer.alloc(4);
   let received=0,error:Error|null=null,stderrBytes=0,spawned=false;
   child.once('spawn',()=>{spawned=true;});
   const cancel=(cause:Error)=>{error??=cause;child.stdin?.end();};
   const aborted=()=>cancel(signal.reason instanceof Error?signal.reason:new Error('媒体解析已取消'));
   signal.addEventListener('abort',aborted,{once:true});
   // The supervisor's 22s wall limit is authoritative. This fallback requests cancellation;
   // it never frees a slot before close, including a stuck OS termination operation.
   const watchdog=setTimeout(()=>cancel(new Error('媒体解析监督超过 25 秒，等待进程退出确认')),25000);
   child.on('error',()=>{this.unavailable='媒体监督组件不可用，请重新启动应用';cancel(new MediaWorkerUnavailable(this.unavailable));});
   child.stdin?.on('error',()=>cancel(new Error('媒体请求管道中断')));
   child.stdout?.on('data',(chunk:Buffer)=>{
    if(error)return;
    if(received+chunk.length>responseLimit+4){cancel(new Error('媒体解析回执超过预算'));return;}
    if(received<4)chunk.copy(header,received,0,Math.min(4-received,chunk.length));
    chunks.push(chunk);received+=chunk.length;
    if(received>=4){const size=header.readUInt32LE();if(!size||size>responseLimit||received>size+4)cancel(new Error('媒体解析回执帧无效'));}
   });
   child.stdout?.on('error',()=>cancel(new Error('媒体回执管道中断')));
   child.stderr?.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>16384)cancel(new Error('媒体诊断输出超过预算'));});
   child.stderr?.on('error',()=>cancel(new Error('媒体诊断管道中断')));
   child.once('close',(code,exitSignal)=>{
    clearTimeout(watchdog);signal.removeEventListener('abort',aborted);
    if(!spawned&&error instanceof MediaWorkerUnavailable){reject(error);return;}
    if(code===null||exitSignal||![0,65,66,67,68,69,70,71].includes(code)){
     this.uncertain=true;this.unavailable='媒体监督进程异常退出，无法确认解析进程生命周期，请重新启动应用';reject(new MediaWorkerExitUnconfirmed(this.unavailable));return;
    }
    if(signal.aborted){reject(signal.reason??new Error('媒体解析已取消'));return;}
    if([65,66,67,68].includes(code)){this.unavailable='媒体进程启动或资源监督失败，请重新启动应用';reject(new MediaWorkerUnavailable(this.unavailable));return;}
    if(error){reject(error);return;}
    if(code!==0){reject(new Error(code===70?'媒体解析超过 22 秒期限':code===71?'媒体解析进程异常退出或资源预算不足':'媒体解析未完成'));return;}
    try{
     const pending=Buffer.concat(chunks,received);
     if(pending.length<4||pending.readUInt32LE()+4!==pending.length)throw new Error('媒体解析回执不完整');
     const response=validateMediaResponse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(4))),request);
     if(response.kind==='error')throw response.category==='boundary'?new MediaBoundaryError(response.message):new Error(response.message);
     resolve(response);
    }catch(error){reject(error);}
   });
   child.stdin?.write(frame);if(signal.aborted)aborted();
  });
 }
}
