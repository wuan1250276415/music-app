import {MaintenanceHold,waitForOwnedChildClose} from './maintenance-hold.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {dialog,type BrowserWindow} from 'electron';
import {FrameReader,encodeFrame,type AudioMessage} from './audio-protocol.js';
import {RELEASE} from '../shared/release.js';
import type {SystemMediaAction,SystemMediaState} from '../shared/system-media.js';
import type {PlaybackState,QueueState,LibraryItem} from '../shared/contracts.js';

type Ports={window:()=>BrowserWindow|null;playback:()=>PlaybackState;queue:()=>QueueState;token:()=>number;sleeping:()=>boolean;
 item:(id:string)=>Promise<LibraryItem|undefined>;cover:(id:string)=>Promise<Uint8Array|null>;
 control:(action:SystemMediaAction,value:unknown,itemId:string|null)=>Promise<unknown>|unknown;
 publish:(state:SystemMediaState)=>void;route:(active:boolean)=>void;error:(message:string)=>void};
type Metadata={key:string;title:string;artist:string;album:string;albumArtist:string;cover:string|null};
type Job={key:string;id:string};
const empty=(key:string):Metadata=>({key,title:'',artist:'',album:'',albumArtist:'',cover:null});
const text=(value:string)=>Array.from(value.replace(/[\u0000-\u001f\u007f]/g,' ')).slice(0,768).join('');
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
export class SystemMedia{
 private readonly maintenance=new MaintenanceHold();
 private state:SystemMediaState={status:'stopped',message:'系统媒体面板尚未连接',observedAt:Date.now(),platform:'windows',verified:false};
 private child:ChildProcessWithoutNullStreams|null=null;private pending:Promise<SystemMediaState>|null=null;
 private closed=false;private ready=false;private failCurrent:((message:string)=>void)|null=null;private completeCurrent:(()=>void)|null=null;
 private heartbeat:NodeJS.Timeout|null=null;private refreshTimer:NodeJS.Timeout|null=null;private killTimer:NodeJS.Timeout|null=null;
 private nonce='';private outputSequence=0n;private inputSequence=0n;private lastFrame=0;
 private awaiting:{sequence:string;context:string;at:number}|null=null;private lastSignature='';private force=false;
 private sendWindowAt=0;private sentBytes=0;private sentFrames=0;
 private identity='';private context='';private libraryRevision=0;private metadata=empty('');
 private metadataNeeds:Job|null=null;private metadataLoading=false;private coverNeeds:Job|null=null;private coverLoading=false;
 private readonly flights=new Set<Promise<unknown>>();private maintenanceResume=false;
 private actionBusy=false;private actionEpoch=0;private lastAction=new Map<string,number>();private settingsBusy=false;
 constructor(private readonly executable:string,private readonly ports:Ports){}
 snapshot():SystemMediaState{return {...this.state};}
 private changed(status:SystemMediaState['status'],message:string):void{
  this.state={status,message:message.slice(0,1024),observedAt:Date.now(),platform:'windows',verified:false};
  try{this.ports.route(status==='ready'&&!this.closed);}catch{/* A shortcut failure cannot corrupt native supervision. */}
  try{this.ports.publish(this.snapshot());}catch{/* UI can reload the current status. */}
 }
 private report(message:string):void{if(!this.closed)try{this.ports.error(message);}catch{}}
 start():Promise<SystemMediaState>{return this.maintenance.run(()=>this.startNow());}
 private startNow():Promise<SystemMediaState>{
  if(this.closed)return Promise.resolve(this.snapshot());
  if(process.platform!=='win32'){this.changed('unsupported','当前系统不提供 Windows 媒体面板');return Promise.resolve(this.snapshot());}
  if(this.pending)return this.pending;if(this.ready){this.invalidateMetadata();return Promise.resolve(this.snapshot());}
  if(this.child)return Promise.reject(new Error('旧系统媒体组件尚未确认退出，请稍后重试'));
  this.nonce=randomUUID();this.outputSequence=0n;this.inputSequence=0n;this.awaiting=null;this.lastSignature='';this.identity='';this.libraryRevision++;this.metadataNeeds=this.coverNeeds=null;this.lastAction.clear();this.lastFrame=performance.now();this.sendWindowAt=this.lastFrame;this.sentBytes=this.sentFrames=0;
  const child=spawn(this.executable,[this.nonce,String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true});this.child=child;
  this.changed('starting','正在连接 Windows 系统媒体面板');
  let finish!:(value:SystemMediaState)=>void;const promise=new Promise<SystemMediaState>(resolve=>{finish=resolve;});this.pending=promise;
  let settled=false,failed=false,windowAt=performance.now(),bytes=0,diagnostics=0;
  const complete=()=>{if(settled)return;settled=true;this.pending=null;finish(this.snapshot());};this.completeCurrent=complete;
  const fail=(message:string)=>{
   if(failed||this.closed||this.maintenance.held)return;failed=true;this.ready=false;this.actionEpoch++;this.clearTimers();this.awaiting=null;
   this.changed('unavailable',message);this.report(message);child.kill();complete();
  };this.failCurrent=fail;
  const reader=new FrameReader(value=>{
   this.read(value);this.lastFrame=performance.now();
   if(value.kind==='ready'){this.ready=true;this.changed('ready','Windows 系统媒体面板已连接');complete();this.refresh(true);}
  },4096);
  this.heartbeat=setInterval(()=>{
   if(!this.ready&&performance.now()-this.lastFrame>5000)fail('系统媒体面板连接超时，可在设置中重新连接');
   else if(this.ready&&performance.now()-this.lastFrame>8000)fail('系统媒体面板连接中断，可重新连接');
   else if(this.awaiting&&performance.now()-this.awaiting.at>5000)fail('系统媒体状态更新超时，已停用系统控制');
  },1000);this.heartbeat.unref();
  child.on('error',()=>fail('系统媒体组件启动失败，可在设置中重新连接'));
  child.stdin.on('error',()=>fail('系统媒体输入管道中断'));child.stdout.on('error',()=>fail('系统媒体输出管道中断'));child.stderr.on('error',()=>fail('系统媒体诊断管道中断'));
  child.stdout.on('data',(chunk:Buffer)=>{
   if(failed||this.closed||this.maintenance.held)return;const now=performance.now();if(now-windowAt>=5000){windowAt=now;bytes=0;diagnostics=0;}bytes+=chunk.length;
   if(bytes>65536){fail('系统媒体通知超过预算，控制已停用');return;}
   try{reader.push(chunk);}catch(error){fail(error instanceof Error?error.message:'系统媒体回执无效');}
  });
  child.stderr.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>16384)fail('系统媒体诊断超过预算');});
  child.once('close',()=>{
   if(!failed&&!this.closed&&!this.maintenance.held){try{reader.finish();}catch{/* Either a partial frame or an unexpected exit means unavailable. */}fail('系统媒体组件已退出，可重新连接');}
   if(this.child===child){this.child=null;this.failCurrent=null;this.completeCurrent=null;if(this.killTimer)clearTimeout(this.killTimer);this.killTimer=null;}complete();
  });return promise;
 }
 private read(value:AudioMessage):void{
  if(Object.keys(value).length!==10||value.protocol!==1||value.buildId!==RELEASE.hostBuildId||value.nonce!==this.nonce||typeof value.sequence!=='string'||!/^[1-9]\d{0,19}$/.test(value.sequence))throw new Error('系统媒体回执身份无效');
  const sequence=BigInt(value.sequence);if(sequence!==this.outputSequence+1n||sequence>0xffffffffffffffffn)throw new Error('系统媒体回执顺序无效');this.outputSequence=sequence;
  if(!this.ready&&value.kind!=='ready'&&value.kind!=='error'||this.ready&&value.kind==='ready')throw new Error('系统媒体连接顺序无效');
  if(value.kind==='error'){
   if(value.context!==null||value.action!==null||value.value!==null||value.appliedSequence!==null||typeof value.message!=='string'||!value.message||value.message.length>1024)throw new Error('系统媒体错误回执无效');
   throw new Error(`Windows 系统媒体接口不可用：${value.message}`);
  }
  if(value.message!==null)throw new Error('系统媒体回执含无效消息');
  if(value.kind==='ready'||value.kind==='heartbeat'){
   if(value.context!==null||value.action!==null||value.value!==null||value.appliedSequence!==null)throw new Error('系统媒体心跳无效');return;
  }
  if(value.kind==='applied'){
   const awaiting=this.awaiting;
   if(!awaiting||!uuid(value.context)||value.action!==null||value.value!==null||value.appliedSequence!==awaiting.sequence||value.context!==awaiting.context)throw new Error('系统媒体更新回执不匹配');
   this.awaiting=null;this.refresh();return;
  }
  if(value.kind!=='action'||!uuid(value.context)||value.appliedSequence!==null||typeof value.action!=='string'||!['play','pause','previous','next','stop','seek','repeat','shuffle'].includes(value.action))throw new Error('系统媒体操作无效');
  const action=value.action as SystemMediaAction;
  if(action==='seek'?typeof value.value!=='number'||!Number.isFinite(value.value)||value.value<0||value.value>604800:action==='repeat'?typeof value.value!=='string'||!['off','one','all'].includes(value.value):action==='shuffle'?typeof value.value!=='boolean':value.value!==null)throw new Error('系统媒体操作参数无效');
  this.dispatch(value.context,action,value.value);
 }
 private clearTimers():void{if(this.heartbeat)clearInterval(this.heartbeat);if(this.refreshTimer)clearTimeout(this.refreshTimer);this.heartbeat=this.refreshTimer=null;}
 refresh(force=false):void{
  this.force||=force;if(!this.ready||this.closed||this.maintenance.held||this.refreshTimer)return;
  this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;try{this.flush();}catch(error){this.failCurrent?.(error instanceof Error?error.message:'系统媒体更新失败');}},200);this.refreshTimer.unref();
 }
 invalidateMetadata():void{this.libraryRevision++;this.refresh(true);}
 private current():{state:PlaybackState;queue:QueueState;id:string|null}{
  const state=this.ports.playback(),queue=this.ports.queue(),id=state.itemId??queue.entries.find(entry=>entry.id===queue.currentEntryId)?.itemId??null;
  const identity=JSON.stringify([this.ports.token(),queue.currentEntryId,queue.revision,id,state.clock?.generation??null,this.ports.sleeping()]);
  if(identity!==this.identity){this.identity=identity;this.context=randomUUID();this.actionEpoch++;}
  const key=JSON.stringify([id,this.libraryRevision]);
  if(this.metadata.key!==key){this.metadata=empty(key);this.metadataNeeds=id?{key,id}:null;this.coverNeeds=null;this.pumpMetadata();}
  return {state,queue,id};
 }
 private flush():void{
  if(!this.ready||this.closed||this.maintenance.held||!this.child)return;const {state,queue,id}=this.current();
  if(this.awaiting)return;
  const sleeping=this.ports.sleeping(),preparing=state.state==='preparing',live=state.state==='playing'||state.state==='paused',duration=state.durationSeconds;
  const body={protocol:1,buildId:RELEASE.mainBuildId,nonce:this.nonce,sequence:'',kind:'snapshot',context:this.context,itemId:id,state:state.state,
   title:this.metadata.title||(id?'正在读取歌曲信息…':''),artist:this.metadata.artist,album:this.metadata.album,albumArtist:this.metadata.albumArtist,
   positionSeconds:Math.min(604800,Math.max(0,state.positionSeconds)),durationSeconds:duration===null?null:Math.min(604800,Math.max(0,duration)),
   canPlay:!sleeping&&!preparing&&Boolean(queue.currentEntryId),canPause:!sleeping&&live,
   canPrevious:!sleeping&&!preparing&&Boolean(queue.currentEntryId),canNext:!sleeping&&!preparing&&queue.entries.length>1,
   canStop:!sleeping&&Boolean(id),canSeek:!sleeping&&live&&Boolean(duration&&duration>0.01),shuffle:queue.shuffle,repeat:queue.repeat,cover:this.metadata.cover};
  const signature=JSON.stringify({...body,positionSeconds:Math.floor(body.positionSeconds/5)});
  if(signature===this.lastSignature&&!this.force)return;
  if(this.inputSequence>=0xffffffffffffffffn)throw new Error('系统媒体消息序号达到上限');body.sequence=String(this.inputSequence+1n);
  const frame=encodeFrame(body),now=performance.now();
  if(now-this.sendWindowAt>=5000){this.sendWindowAt=now;this.sentBytes=this.sentFrames=0;}
  // Stay below the helper's sliding burst budget and retain only the latest
  // snapshot. Control contexts are still fenced while delivery is deferred.
  if(this.sentBytes+frame.length>4*1024*1024||this.sentFrames>=32){
   this.refreshTimer=setTimeout(()=>{this.refreshTimer=null;this.refresh(true);},Math.max(200,5100-(now-this.sendWindowAt)));this.refreshTimer.unref();return;
  }
  this.sentBytes+=frame.length;this.sentFrames++;this.inputSequence++;
  this.awaiting={sequence:body.sequence,context:body.context,at:now};this.lastSignature=signature;this.force=false;
  this.child.stdin.write(frame,error=>{if(error)this.failCurrent?.('系统媒体状态发送失败');});
 }
 private pumpMetadata():void{
  if(this.metadataLoading||!this.metadataNeeds||this.closed||this.maintenance.held)return;const job=this.metadataNeeds;this.metadataNeeds=null;this.metadataLoading=true;
  this.track(Promise.resolve().then(()=>this.maintenance.held?undefined:this.ports.item(job.id)).then(item=>{
   if(this.closed||this.maintenance.held||this.metadata.key!==job.key)return;if(item&&item.id!==job.id)throw new Error('系统媒体歌曲信息不匹配');
   this.metadata={key:job.key,title:text(item?.title??'歌曲已移除'),artist:text(item?.artist??''),album:text(item?.catalog?.releaseTitle??item?.album??''),albumArtist:text(item?.catalog?.albumArtists.map(member=>member.creditedName??member.name).join(' / ')??''),cover:null};
   this.refresh(true);if(item){this.coverNeeds=job;this.pumpCover();}
  }).catch(()=>{if(!this.closed&&this.metadata.key===job.key){this.metadata.title='歌曲信息暂不可用';this.refresh(true);}}).finally(()=>{this.metadataLoading=false;this.pumpMetadata();}));
 }
 private pumpCover():void{
  if(this.coverLoading||!this.coverNeeds||this.closed||this.maintenance.held)return;const job=this.coverNeeds;this.coverNeeds=null;this.coverLoading=true;
  this.track(Promise.resolve().then(()=>this.maintenance.held?null:this.ports.cover(job.id)).then(value=>{
   if(this.closed||this.maintenance.held||this.metadata.key!==job.key)return;
   if(value&&value.length>0&&value.length<=384*1024&&value[0]===255&&value[1]===216&&value[2]===255)this.metadata.cover=Buffer.from(value).toString('base64');this.refresh(true);
  }).catch(()=>{/* Cover failure must not hide metadata or disable playback controls. */}).finally(()=>{this.coverLoading=false;this.pumpCover();}));
 }
 private dispatch(context:string,action:SystemMediaAction,value:unknown):void{
  if(!this.ready||this.closed||this.maintenance.held)return;const {state,queue,id}=this.current();if(context!==this.context||this.ports.sleeping()){this.refresh(true);return;}
  if(action==='stop'){this.actionEpoch++;try{this.track(Promise.resolve(this.ports.control(action,null,id)).catch(error=>this.report(String(error))));}catch(error){this.report(String(error));}this.refresh(true);return;}
  const key=JSON.stringify([action,value]),now=performance.now(),last=this.lastAction.get(key);this.lastAction.set(key,now);if(this.lastAction.size>32)this.lastAction.delete(this.lastAction.keys().next().value!);
  if(this.actionBusy||last!==undefined&&now-last<350||state.state==='preparing'||!queue.currentEntryId){this.refresh(true);return;}
  if(action==='play'&&state.state==='playing'||action==='pause'&&state.state!=='playing'||action==='next'&&queue.entries.length<2){this.refresh(true);return;}
  if(action==='seek'&&(!(state.state==='playing'||state.state==='paused')||!state.durationSeconds||typeof value!=='number'||value>=state.durationSeconds)){this.refresh(true);return;}
  const epoch=this.actionEpoch,token=this.ports.token();this.actionBusy=true;
  this.track(Promise.resolve().then(()=>{if(this.maintenance.held)return;this.current();if(epoch===this.actionEpoch&&token===this.ports.token()&&context===this.context&&this.ready&&!this.closed&&!this.ports.sleeping())return this.ports.control(action,value,id);})
   .catch(error=>this.report(error instanceof Error?error.message:String(error))).finally(()=>{this.actionBusy=false;this.refresh(true);}));
 }
 settings():Promise<void>{return this.maintenance.run(()=>this.settingsNow());}
 private async settingsNow():Promise<void>{
  if(this.closed)return;if(this.settingsBusy)throw new Error('系统媒体设置正在处理');this.settingsBusy=true;
  try{
   const options:Electron.MessageBoxOptions={type:'info',title:'系统媒体面板',message:this.state.message,detail:'显示当前歌曲、歌手、专辑和本地封面，提供播放／暂停、切歌、停止与进度控制。可用按钮由当前播放状态决定；系统是否展示循环和随机控件取决于 Windows 界面。\n连接后使用 Windows 媒体键路由，备用全局媒体快捷键暂时让出按键。重新连接不会自动播放。',buttons:['重新连接／刷新','关闭'],defaultId:1,cancelId:1,noLink:true};
   const window=this.ports.window(),result=await(window&&!window.isDestroyed()?dialog.showMessageBox(window,options):dialog.showMessageBox(options));
   if(result.response===0&&!this.closed)await this.start();
  }finally{this.settingsBusy=false;}
 }
 private track(work:Promise<unknown>):void{
  this.flights.add(work);void work.finally(()=>this.flights.delete(work)).catch(()=>{});
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  this.maintenanceResume=!this.closed&&['starting','ready'].includes(this.state.status);
  this.ready=false;this.actionEpoch++;this.clearTimers();this.metadataNeeds=this.coverNeeds=null;this.awaiting=null;
  await waitForOwnedChildClose(this.child,()=>{this.child?.kill();this.changed('stopped','曲库维护，系统媒体面板已暂停');});
  await Promise.allSettled([...this.flights]);await this.maintenance.waitRequests();
  if(this.child||this.flights.size||this.metadataLoading||this.coverLoading||this.actionBusy||this.settingsBusy)throw new Error('系统媒体资源尚未确认停止');
 });}
 prepareRestoreState(owner:string):void{
  this.maintenance.assertFrozen(owner);if(this.closed||this.child||this.flights.size||this.metadataLoading||this.coverLoading||this.actionBusy||this.settingsBusy)throw new Error('系统媒体旧资源尚未停止');
  this.identity='';this.context='';this.libraryRevision++;this.metadata=empty('');this.metadataNeeds=this.coverNeeds=null;this.lastAction.clear();this.lastSignature='';this.awaiting=null;this.actionEpoch++;
 }
 endMaintenance(owner:string,resume:boolean):Promise<SystemMediaState>{
  const restart=this.maintenanceResume;this.maintenance.end(owner);this.maintenanceResume=false;
  return resume&&restart&&!this.closed?this.start():Promise.resolve(this.snapshot());
 }
 close():void{
  if(this.closed)return;this.closed=true;this.ready=false;this.actionEpoch++;this.clearTimers();this.metadataNeeds=this.coverNeeds=null;this.awaiting=null;
  this.changed('stopped','系统媒体组件正在退出');this.completeCurrent?.();const child=this.child;if(!child)return;
  try{child.stdin.end(encodeFrame({protocol:1,buildId:RELEASE.mainBuildId,nonce:this.nonce,sequence:String(++this.inputSequence),kind:'shutdown'}));}catch{child.kill();}
  this.killTimer=setTimeout(()=>{if(this.child===child)child.kill();},1500);this.killTimer.unref();
 }
}

// Reuse only verified, normalized local thumbnails; never expose a file path or
// network URL to WinRT. The DB resource may have been evicted between these calls.
export async function systemMediaCover(id:string,call:<T>(method:string,params?:unknown,timeout?:number)=>Promise<T>):Promise<Uint8Array|null>{
 const candidate=await call<import('../shared/contracts.js').ArtworkCandidate|null>('artworkCandidate',{itemId:id,thumbnailSize:256},60000);
 if(!candidate)return null;const match=/^aural-artwork:\/\/image\/([0-9a-f]{64})\.jpg$/.exec(candidate.url);if(!match)return null;
 const bytes=await call<Uint8Array|null>('artworkResource',{itemId:id,assetId:match[1]});
 return bytes instanceof Uint8Array&&bytes.length<=384*1024&&createHash('sha256').update(bytes).digest('hex')===match[1]?bytes:null;
}
