import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import {FINGERPRINT_RECIPE,validAudioFingerprint,fingerprintSourceIdentity,type AudioFingerprintSummary} from '../shared/audio-fingerprint.js';
import {samplePlayRange} from '../shared/source-sample-range.js';
import {requireFileObservation,validFileObservation} from '../platform/file-observation.js';
import type {LibraryItem} from '../shared/contracts.js';
type Source={item:LibraryItem;rootPath:string};
type Job={itemId:string;fileId:string;fresh:boolean;signal:AbortSignal;resolve:(value:AudioFingerprintSummary)=>void;reject:(error:Error)=>void;child:ChildProcessWithoutNullStreams|null;cancelled:boolean;finished:Promise<void>;finish:()=>void;abort:()=>void};
const identity=(item:LibraryItem)=>createHash('sha256').update(JSON.stringify(fingerprintSourceIdentity(item))).digest('hex');
export class AudioFingerprintWorker {
 private active:Job|null=null;private queue:Job[]=[];private owner:string|null=null;
 private readonly cache=new Map<string,{value:AudioFingerprintSummary;expires:number}>();
 constructor(private readonly executable:string,private readonly source:(itemId:string)=>Source){}
 private prune():void{for(const [key,v] of this.cache)if(v.expires<=Date.now())this.cache.delete(key);}
 compute(itemId:string,signal:AbortSignal,fresh=false):Promise<AudioFingerprintSummary>{
  if(this.owner)return Promise.reject(new Error('曲库维护期间暂停指纹计算'));signal.throwIfAborted();const source=this.source(itemId);if(!source.item.available)return Promise.reject(new Error('音乐文件当前不可用'));if(!validFileObservation(source.item.fileObservation))return Promise.reject(new Error('请重新扫描以建立文件观察，再进行音频识别'));if(this.queue.length+(this.active?1:0)>=3)return Promise.reject(new Error('指纹任务已满，请等待或取消已有任务'));
  return new Promise((resolve,reject)=>{let finish!:()=>void;const finished=new Promise<void>(r=>finish=r),job:Job={itemId,fileId:source.item.fileId,fresh,signal,resolve,reject,child:null,cancelled:false,finished,finish,abort:()=>{}};job.abort=()=>{job.cancelled=true;if(this.active===job)job.child?.kill();else{this.queue=this.queue.filter(v=>v!==job);job.signal.removeEventListener('abort',job.abort);job.reject(new Error('指纹查询已取消'));job.finish();}};signal.addEventListener('abort',job.abort,{once:true});this.queue.push(job);void this.pump();});
 }
 clear():void{this.cache.clear();for(const job of [...this.queue])job.abort();this.active?.abort();}
 async beginMaintenance(owner:string):Promise<void>{if(this.owner&&this.owner!==owner)throw new Error('指纹维护身份不符');this.owner=owner;const active=this.active;this.clear();if(active)await active.finished;if(this.active)throw new Error('指纹进程尚未退出');}
 endMaintenance(owner:string):void{if(this.owner!==owner||this.active)throw new Error('指纹维护未完成或身份不符');this.owner=null;}
 async quiesceFile(fileId:string):Promise<void>{for(const job of [...this.queue])if(job.fileId===fileId)job.abort();const active=this.active;if(active?.fileId===fileId){active.abort();await active.finished;}}
 async validateSource(itemId:string):Promise<void>{const source=this.source(itemId);if(!source.item.available)throw new Error('音乐文件当前不可用');if(!validFileObservation(source.item.fileObservation))throw new Error('请重新扫描以建立文件观察');requireFileObservation(source.item.fileObservation,await stat(source.item.path,{bigint:true}));}
 private async pump():Promise<void>{if(this.active||this.owner)return;const job=this.queue.shift();if(!job)return;this.active=job;try{job.signal.throwIfAborted();const value=await this.run(job,job.fresh);if(job.cancelled)throw new Error('指纹查询已取消');job.resolve(value);}catch(error){job.reject(error instanceof Error?error:new Error('指纹计算失败'));}finally{job.signal.removeEventListener('abort',job.abort);this.active=null;job.finish();void this.pump();}}
 private async run(job:Job,fresh:boolean):Promise<AudioFingerprintSummary>{
  const initial=this.source(job.itemId),item=initial.item,key=identity(item);const [filename,root]=await Promise.all([realpath(item.path),realpath(initial.rootPath)]),relative=path.relative(root,filename);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('音乐文件不属于当前曲库目录');const observed=requireFileObservation(item.fileObservation,await stat(filename,{bigint:true}));
  this.prune();const cached=this.cache.get(key);if(!fresh&&cached){job.signal.throwIfAborted();return structuredClone(cached.value);}job.signal.throwIfAborted();
  const exact=samplePlayRange(item),nonce=randomUUID(),request={version:1,algorithm:FINGERPRINT_RECIPE,nonce,parentPid:process.pid,path:filename,rootPath:root,startSeconds:item.sourceStartSeconds,endSeconds:item.sourceEndSeconds??-1,startCueFrame:item.sourceStartCueFrame,endCueFrame:item.sourceEndCueFrame,...(exact?{sampleRange:exact}:{})};
  const frame=(v:unknown)=>{const body=Buffer.from(JSON.stringify(v));if(body.length>131072)throw new Error('指纹请求超限');const packet=Buffer.allocUnsafe(body.length+4);packet.writeUInt32LE(body.length);body.copy(packet,4);return packet;};
  const result=await new Promise<AudioFingerprintSummary>((resolve,reject)=>{
   const child=spawn(this.executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});job.child=child;let pending=Buffer.alloc(0),failure:Error|null=null,complete:AudioFingerprintSummary|null=null,stderr=0,events=0,progress=0;const decoder=new TextDecoder('utf-8',{fatal:true});
   const abort=(message:string)=>{failure=new Error(message);child.kill();};const timer=setTimeout(()=>abort('指纹计算超时，正在等待组件退出'),310000);
   child.on('error',()=>{failure=new Error('指纹组件无法启动');});child.stdin.on('error',()=>abort('指纹请求传输失败'));child.stderr.on('data',(b:Buffer)=>{stderr+=b.length;if(stderr>4096)abort('指纹组件异常');});
   child.stdout.on('data',(b:Buffer)=>{try{pending=Buffer.concat([pending,b]);if(pending.length>262144)throw new Error('指纹输出超限');while(pending.length>=4){const n=pending.readUInt32LE();if(!n||n>131072)throw new Error('指纹响应帧无效');if(pending.length<n+4)break;const v=JSON.parse(decoder.decode(pending.subarray(4,n+4)));pending=pending.subarray(n+4);if(++events>1000||complete||!v||typeof v!=='object')throw new Error('指纹响应顺序无效');
    if(v.kind==='error')throw new Error('音频太短、来源不可用、片段无效或指纹计算中断');if(v.nonce!==nonce)throw new Error('指纹响应不属于本次读取');if(v.kind==='progress'){if(!['hashing','measuring','positioning','fingerprinting'].includes(v.phase)||!Number.isFinite(v.progress)||v.progress<progress||v.progress>1)throw new Error('指纹进度无效');progress=v.progress;}
    else if(v.kind==='complete'){if(job.cancelled||!validAudioFingerprint(v.summary)||exact&&(v.summary.sampleRate!==exact.sampleRate||v.summary.startFrame!==exact.startFrame||v.summary.endFrame!==exact.endFrame))throw new Error('指纹结果与当前音频片段不符');complete=v.summary;child.stdin.end(frame({kind:'commit',nonce}));}else throw new Error('指纹响应类型无效');
   }}catch(e){abort(e instanceof Error?e.message:'指纹响应无效');}});
   child.once('close',code=>{clearTimeout(timer);job.child=null;if(!failure&&!job.cancelled&&complete&&code===0&&!pending.length)resolve(complete);else reject(failure??new Error(job.cancelled?'指纹查询已取消':'指纹组件未完成退出'));});child.stdin.write(frame(request));if(job.cancelled)child.kill();
  });
  const current=this.source(job.itemId).item;job.signal.throwIfAborted();if(identity(current)!==key||requireFileObservation(observed,await stat(filename,{bigint:true}))!==observed)throw new Error('指纹期间歌曲或文件已变化，请重新扫描后查询');
  job.signal.throwIfAborted();if(job.cancelled)throw new Error('指纹查询已取消');while(this.cache.size>=4)this.cache.delete(this.cache.keys().next().value!);this.cache.set(key,{value:structuredClone(result),expires:Date.now()+600000});return result;
 }
}
