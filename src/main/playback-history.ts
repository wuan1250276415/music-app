import {createHash} from 'node:crypto';
import {checkedPendingFile,pendingDirectory} from '../platform/catalog-restore-pending-files.js';
import {MaintenanceHold} from './maintenance-hold.js';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import type {LibraryItem} from '../shared/contracts.js';
import {HISTORY_MAX_US,readHistoryCheckpoint,type PlaybackHistoryCheckpoint} from '../shared/playback-history.js';
import {readPlaybackPolicy,type PlaybackPolicySnapshot} from '../shared/playback-policy.js';

export interface HistoryEntry {entryId:string;item:LibraryItem}
export interface PlaybackHistoryBinding {sessionId:string;first:HistoryEntry;next?:HistoryEntry}
export interface HistoryObservation {
 binding:PlaybackHistoryBinding;transportId:string;generation:number;frame:bigint;rate:number;
 boundaryFrame:bigint|null;evidence:'reported'|'estimated'|'bookmark';
}
type Accumulator={value:PlaybackHistoryCheckpoint;remainders:Map<string,bigint>};
type HistoryPorts={save:(value:PlaybackHistoryCheckpoint)=>Promise<unknown>;changed:()=>void;error:(message:string)=>void};
const key=(c:{sessionId:string;entryId:string})=>c.sessionId+':'+c.entryId;
const text=(value:string)=>value.replace(/[\u0000-\u001f]/g,' ').slice(0,2048);
// Counters describe source music frames mapped by the validated host, not wall time or play clicks.
export class PlaybackHistoryRecorder {
 private readonly maintenance=new MaintenanceHold();
 private restoreCompletionOwner:string|null=null;
 private baseline:HistoryObservation|null=null;private run='';private accumulators=new Map<string,Accumulator>();
 private pending=new Map<string,PlaybackHistoryCheckpoint>();private flight:Promise<void>|null=null;private timer:NodeJS.Timeout|null=null;
 private ready=false;private closed=false;private journalKnown=false;private lastError='';
 private policy:PlaybackPolicySnapshot|null=null;private restorePendingWork:Promise<{beforeSha256:string;afterSha256:string}>|null=null;private restorePendingKey='';private restoreHistoryPrepared=false;
 constructor(private readonly filename:string,private readonly ports:HistoryPorts){}
 status():{enabled:boolean;pending:number;error:string}{return {enabled:this.ready,pending:this.pending.size,error:this.lastError};}
 configure(value:unknown):PlaybackPolicySnapshot{
  const next=readPlaybackPolicy(value);
  if(this.restoreCompletionOwner&&JSON.stringify(this.policy)!==JSON.stringify(next))throw new Error('恢复最终历史屏障期间不能变更统计规则');
  if(this.policy&&next.revision<this.policy.revision)return readPlaybackPolicy(this.policy);
  if(this.policy&&next.revision===this.policy.revision&&JSON.stringify(next)!==JSON.stringify(this.policy))throw new Error('同修订播放统计规则内容不符');
  this.policy=next;return readPlaybackPolicy(next);
 }
 private report(message:string):void{if(message===this.lastError)return;this.lastError=message;try{this.ports.error(message);}catch{/* Window may already be closed. */}}
 async initialize():Promise<void>{
  try{
   const stat=await fs.stat(this.filename).catch(e=>{if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;});
   if(stat){
    if(!stat.isFile()||stat.size>16*1024*1024)throw new Error('待保存播放历史文件超过预算');
    const v=JSON.parse(await fs.readFile(this.filename,'utf8')) as {version:unknown;entries:unknown};
    if(!v||Object.keys(v).length!==2||v.version!==1||!Array.isArray(v.entries)||v.entries.length>512)throw new Error('待保存播放历史文件无效');
    for(const raw of v.entries){const c=readHistoryCheckpoint(raw);if(this.pending.has(key(c)))throw new Error('待保存播放历史身份重复');this.pending.set(key(c),c);}
   }
   this.journalKnown=true;this.ready=true;await this.flush();
  }catch(e){this.report(`播放历史待保存数据无法核对，已保留原文件：${String(e instanceof Error?e.message:e).slice(0,300)}`);}
  this.timer=setInterval(()=>void this.flush(),15000);this.timer.unref();
 }
 observe(observation:HistoryObservation|null):void{
  if(this.maintenance.held||this.restoreCompletionOwner){this.baseline=null;return;}
  const old=this.baseline;this.baseline=observation;
  if(!observation&&old&&this.ready&&!this.closed)void this.flush();
  if(!this.ready||this.closed||!observation)return;
  if(this.run!==observation.binding.sessionId){this.run=observation.binding.sessionId;this.accumulators.clear();}
  const active=observation.boundaryFrame!==null&&observation.frame>=observation.boundaryFrame&&observation.binding.next?observation.binding.next:observation.binding.first;
  this.prepare(observation,active);
  if(!old||old.transportId!==observation.transportId||old.generation!==observation.generation||old.rate!==observation.rate||old.binding.sessionId!==observation.binding.sessionId)return;
  // A recovering device clock can trail an earlier callback estimate. Keep the watermark;
  // replaying those source coordinates would count the same interval a second time.
  if(observation.frame<old.frame){this.baseline={...observation,frame:old.frame,evidence:'estimated'};return;}
  if(observation.evidence==='bookmark'||old.evidence==='bookmark')return;
  const evidence=old.evidence==='reported'&&observation.evidence==='reported'?'reported':'estimated';
  const boundary=observation.boundaryFrame;
  if(boundary!==null&&observation.binding.next){
   this.credit(observation,observation.binding.first,old.frame<boundary?old.frame:boundary,observation.frame<boundary?observation.frame:boundary,0n,evidence);
   this.credit(observation,observation.binding.next,old.frame>boundary?old.frame:boundary,observation.frame>boundary?observation.frame:boundary,boundary,evidence);
  }else this.credit(observation,observation.binding.first,old.frame,observation.frame,0n,evidence);
 }
 private prepare(o:HistoryObservation,entry:HistoryEntry):Accumulator|undefined{
  const id=key({sessionId:o.binding.sessionId,entryId:entry.entryId});let a=this.accumulators.get(id);
  if(!a){
   if(!this.policy){this.report('播放统计规则尚未核对，暂缓记录新播放');return;}
   if(this.pending.size>=512&&!this.pending.has(id)){this.report('播放历史待保存队列已满，暂缓记录新播放；现有待保存数据保留');return;}
   const item=entry.item,duration=item.durationSeconds===null?null:Math.round(item.durationSeconds*1000000);
   a={value:{sessionId:o.binding.sessionId,entryId:entry.entryId,itemId:item.id,title:text(item.title),artist:text(item.artist),album:text(item.album),durationUs:duration!==null&&Number.isSafeInteger(duration)&&duration>0&&duration<=HISTORY_MAX_US?duration:null,policyVersion:2,policy:readPlaybackPolicy(this.policy),checkpoint:0,presentedUs:0,estimatedUs:0,furthestUs:0,startedAt:new Date().toISOString()},remainders:new Map()};
   this.accumulators.set(id,a);
  }
  return a;
 }
 private credit(o:HistoryObservation,entry:HistoryEntry,begin:bigint,end:bigint,origin:bigint,evidence:'reported'|'estimated'):void{
  if(end<=begin)return;const a=this.prepare(o,entry);if(!a)return;
  const id=key(a.value);
  const remainderKey=evidence+':'+o.rate,scaled=(end-begin)*1000000n+(a.remainders.get(remainderKey)??0n),us=scaled/BigInt(o.rate);
  a.remainders.set(remainderKey,scaled%BigInt(o.rate));if(us===0n)return;
  const field=evidence==='reported'?'presentedUs':'estimatedUs',sum=BigInt(a.value[field])+us;
  if(sum>BigInt(HISTORY_MAX_US)||a.value.checkpoint>=Number.MAX_SAFE_INTEGER){this.report('播放历史累计值超过记录预算');return;}
  a.value[field]=Number(sum);if(evidence==='reported')a.value.furthestUs=Math.max(a.value.furthestUs,Math.min(HISTORY_MAX_US,Number((end-origin)*1000000n/BigInt(o.rate))));
  // Wall time labels recency only; duration above always comes from source-clock deltas.
  const observedAt=new Date().toISOString();a.value.observedAt=observedAt>(a.value.observedAt??a.value.startedAt)?observedAt:(a.value.observedAt??a.value.startedAt);
  a.value.checkpoint++;this.pending.set(id,{...a.value});
 }
 private async persist():Promise<void>{
  if(!this.journalKnown)return;
  await fs.mkdir(path.dirname(this.filename),{recursive:true});
  const temporary=this.filename+'.tmp',file=await fs.open(temporary,'w');
  try{await file.writeFile(JSON.stringify({version:1,entries:[...this.pending.values()]}),'utf8');await file.sync();}finally{await file.close();}
  await fs.rename(temporary,this.filename);
 }
 flush():Promise<void>{return this.maintenance.held||this.restoreCompletionOwner?Promise.resolve():this.flushNow();}
 private flushNow():Promise<void>{
  if(this.flight)return this.flight;if(!this.ready||!this.journalKnown)return Promise.resolve();
  const work=(async()=>{
   if(!this.pending.size)return;await this.persist();
   for(const c of [...this.pending.values()]){
    const result=await this.ports.save(c) as {sessionId:string;entryId:string;checkpoint:number};
    if(!result||Object.keys(result).length!==3||result.sessionId!==c.sessionId||result.entryId!==c.entryId||result.checkpoint!==c.checkpoint)throw new Error('播放历史保存回执不符');
    if(this.pending.get(key(c))?.checkpoint===c.checkpoint)this.pending.delete(key(c));
    await this.persist();try{this.ports.changed();}catch{/* UI notification is not the durable receipt. */}
   }
   this.lastError='';
  })().catch(e=>this.report(`播放历史尚未保存，将自动重试：${String(e instanceof Error?e.message:e).slice(0,300)}`));
  this.flight=work;void work.finally(()=>{if(this.flight===work)this.flight=null;});return work;
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  this.restorePendingWork=null;this.restorePendingKey='';this.restoreHistoryPrepared=false;
  this.baseline=null;if(this.timer)clearInterval(this.timer);this.timer=null;
  if(this.closed||!this.ready||!this.journalKnown)throw new Error('播放历史待保存资料未核对，已保留原文件，不能开始备份');
  await this.flushNow();await this.flushNow();
  // Saving to Library can fail. Persist every remaining original checkpoint before
  // source freeze; a snapshot must never silently omit Main's in-memory requests.
  await this.persist();if(this.flight)await this.flight;
 });}
 settleRestorePending(owner:string,activationId:string,expectedSha256:string,reset:boolean,authorize:()=>void):Promise<{beforeSha256:string;afterSha256:string}>{
  authorize();
  this.maintenance.assertFrozen(owner);const key=JSON.stringify([owner,activationId,expectedSha256,reset]);if(this.restorePendingWork){if(key!==this.restorePendingKey)throw new Error('原播放历史处理请求不能改变内容');return this.restorePendingWork;}
  if(this.closed||!this.ready||!this.journalKnown||this.flight)throw new Error('原播放历史尚未确认冻结');this.restorePendingKey=key;
  const work=Promise.resolve().then(async()=>{
   const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex'),original=Buffer.from(JSON.stringify({version:1,entries:[...this.pending.values()]}));
   if(hash(original)!==expectedSha256)throw new Error('原播放历史内存与隔离快照不同');const check=()=>{authorize();this.maintenance.assertFrozen(owner);if(this.closed||this.flight)throw new Error('播放历史处理身份变化');};
   check();await checkedPendingFile(this.filename,{bytes:original.length,sha256:expectedSha256},check);if(!reset)return {beforeSha256:expectedSha256,afterSha256:expectedSha256};
   const parent=await pendingDirectory(path.dirname(this.filename)),empty=Buffer.from(JSON.stringify({version:1,entries:[]})),emptySha256=hash(empty),temporary=this.filename+'.restore-'+activationId+'.tmp';
   const file=await fs.open(temporary,'wx',0o600);try{await file.writeFile(empty);await file.sync();}finally{await file.close();}
   await checkedPendingFile(temporary,{bytes:empty.length,sha256:emptySha256},check);await checkedPendingFile(this.filename,{bytes:original.length,sha256:expectedSha256},check);
   if(await pendingDirectory(path.dirname(this.filename))!==parent)throw new Error('播放历史目录身份变化');check();await fs.rename(temporary,this.filename);
   await checkedPendingFile(this.filename,{bytes:empty.length,sha256:emptySha256},check);if(await pendingDirectory(path.dirname(this.filename))!==parent)throw new Error('播放历史处理后目录身份变化');
   this.pending.clear();this.accumulators.clear();this.baseline=null;this.run='';this.policy=null;this.ready=false;this.report('恢复准备期间暂停播放记录；原待保存资料已保留。');
   return {beforeSha256:expectedSha256,afterSha256:emptySha256};
  });this.restorePendingWork=work;void work.catch(()=>{});return work;
 }
 restoreSnapshot(owner:string):PlaybackPolicySnapshot|null{this.maintenance.assertFrozen(owner);if(this.closed||this.flight)throw new Error('播放历史原请求尚未停止');return this.policy?readPlaybackPolicy(this.policy):null;}
 async prepareRestoreState(owner:string,value:unknown,expectedSha256:string,authorize:()=>void):Promise<void>{
  authorize();this.maintenance.assertFrozen(owner);if(!this.restorePendingWork||this.closed||this.flight||!this.journalKnown)throw new Error('恢复待保存历史尚未处理');
  const result=await this.restorePendingWork;authorize();this.maintenance.assertFrozen(owner);if(result.afterSha256!==expectedSha256)throw new Error('恢复历史处理回执不同');
  const next=readPlaybackPolicy(value),reset=JSON.parse(this.restorePendingKey)[3]===true;
  if(!reset&&JSON.stringify(this.policy)!==JSON.stringify(next))throw new Error('原库统计策略与原 Main 状态不同');
  const raw=Buffer.from(JSON.stringify({version:1,entries:[...this.pending.values()]}));if(createHash('sha256').update(raw).digest('hex')!==expectedSha256)throw new Error('恢复历史内存与原处理摘要不同');await checkedPendingFile(this.filename,{bytes:raw.length,sha256:expectedSha256},()=>{authorize();this.maintenance.assertFrozen(owner);if(this.closed||this.flight)throw new Error('播放历史身份变化');});
  this.policy=next;this.baseline=null;this.run='';this.accumulators.clear();this.restoreHistoryPrepared=true;
 }
 endMaintenance(owner:string):void{
  if(this.restoreCompletionOwner)throw new Error('恢复最终历史交互占用尚未完成');
  this.maintenance.end(owner);if(this.closed)return;if(this.restoreHistoryPrepared){this.restoreHistoryPrepared=false;this.ready=true;this.lastError='';}
  this.timer=setInterval(()=>void this.flush(),15000);this.timer.unref();
 }
 endRestoreMaintenance(owner:string,expectedSha256:string):void{
  this.restoreSnapshot(owner);if(this.restoreCompletionOwner||this.timer||!this.restoreHistoryPrepared||!this.journalKnown)throw new Error('恢复最终历史尚未准备或存在计时器');
  const sha=createHash('sha256').update(JSON.stringify({version:1,entries:[...this.pending.values()]})).digest('hex');if(sha!==expectedSha256)throw new Error('恢复最终历史内存与原处理结果不同');
  this.restoreCompletionOwner=owner;this.maintenance.end(owner);this.restoreHistoryPrepared=false;this.ready=true;this.lastError='';this.baseline=null;
 }
 async assertRestorePendingResult(owner:string,expectedSha256:string,authorize:()=>void):Promise<void>{
  authorize();this.restoreSnapshot(owner);if(!this.restorePendingWork||!this.restoreHistoryPrepared||!this.journalKnown||this.timer)throw new Error('恢复最终历史处理尚未完成');
  const result=await this.restorePendingWork;authorize();this.restoreSnapshot(owner);const raw=Buffer.from(JSON.stringify({version:1,entries:[...this.pending.values()]}));
  if(result.afterSha256!==expectedSha256||createHash('sha256').update(raw).digest('hex')!==expectedSha256)throw new Error('恢复最终历史处理或内存摘要不同');
  await checkedPendingFile(this.filename,{bytes:raw.length,sha256:expectedSha256},()=>{authorize();this.restoreSnapshot(owner);});authorize();this.restoreSnapshot(owner);
 }
 assertRestoreCompletionQuiet(owner:string,expectedSha256:string):void{
  if(this.restoreCompletionOwner!==owner||this.maintenance.held||this.closed||this.flight||this.timer||!this.ready||!this.journalKnown||createHash('sha256').update(JSON.stringify({version:1,entries:[...this.pending.values()]})).digest('hex')!==expectedSha256)throw new Error('恢复最终历史占用或停止状态不同');
 }
 completeRestore(owner:string,expectedSha256:string):void{
  this.assertRestoreCompletionQuiet(owner,expectedSha256);this.restoreCompletionOwner=null;this.restorePendingWork=null;this.restorePendingKey='';this.baseline=null;this.run='';this.accumulators.clear();
  this.timer=setInterval(()=>void this.flush(),15000);this.timer.unref();
 }
 async close():Promise<void>{this.closed=true;this.baseline=null;if(this.timer)clearInterval(this.timer);this.timer=null;if(this.maintenance.held||this.restoreCompletionOwner)return;await this.flushNow();await this.flushNow();}
}
