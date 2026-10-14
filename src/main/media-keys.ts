import {MaintenanceHold} from './maintenance-hold.js';
import {dialog,globalShortcut,type BrowserWindow} from 'electron';
import {performance} from 'node:perf_hooks';
import {defaultMediaKeyPreference,readMediaKeyPreference,type MediaKeyPreference} from '../shared/media-key-preference.js';
import type {PlaybackState,QueueState} from '../shared/contracts.js';
type Action='toggle'|'previous'|'next'|'stop';
const keys=[['MediaPlayPause','播放／暂停','toggle'],['MediaPreviousTrack','上一首','previous'],['MediaNextTrack','下一首','next'],['MediaStop','停止','stop']] as const;
type Ports={window:()=>BrowserWindow|null;playback:()=>PlaybackState;queue:()=>QueueState;sleeping:()=>boolean;token:()=>number;
 toggle:()=>Promise<unknown>;previous:()=>Promise<unknown>;next:()=>Promise<unknown>;stop:()=>unknown;
 load:()=>Promise<unknown>;save:(expected:MediaKeyPreference,value:MediaKeyPreference)=>Promise<unknown>;error:(message:string)=>void};
export class MediaKeys{
 private readonly maintenance=new MaintenanceHold();
 private preference=defaultMediaKeyPreference();private owned=new Set<string>();private effective=false;private busy=false;private closed=false;
 private systemSession=false;private routePending=false;
 private transportBusy=false;private error='';private lastSeen=new Map<string,number>();private intentEpoch=0;
 constructor(private readonly ports:Ports){}
 restoreSnapshot(owner:string):MediaKeyPreference{this.maintenance.assertFrozen(owner);if(this.closed||this.busy||this.transportBusy||this.owned.size)throw new Error('媒体快捷键尚未停止');return {...this.preference};}
 prepareRestoreState(owner:string,value:unknown):void{this.restoreSnapshot(owner);this.preference=readMediaKeyPreference(value);this.lastSeen.clear();this.intentEpoch++;this.error='';this.routePending=false;}
 async initialize():Promise<void>{
  this.preference=readMediaKeyPreference(await this.ports.load());if(this.closed)return;
  if(this.preference.enabled)try{this.acquire();this.effective=!this.systemSession;}catch(error){this.record(error);}
 }
 setSystemSessionActive(active:boolean):void{
  if(this.systemSession===active)return;this.systemSession=active;
  if(active){this.routePending=false;this.release();if(this.owned.size)this.record(new Error('系统媒体面板已连接，但备用媒体键解绑尚未确认'));return;}
  if(this.busy){this.routePending=true;return;}this.activateFallback();
 }
 private activateFallback():void{
  if(this.closed||this.maintenance.held||this.systemSession||!this.preference.enabled)return;
  try{this.acquire();this.effective=true;this.error='';}catch(error){this.record(error);}
 }
 private record(error:unknown):void{
  this.error=((error instanceof Error?error.message:String(error))+(!this.effective&&this.owned.size?'；部分快捷键解绑未确认，控制已停用，可重试或退出应用':'')).slice(0,1024);
  if(!this.closed)try{this.ports.error(this.error);}catch{/* Keep the status readable after the renderer recovers. */}
 }
 private release():void{
  ++this.intentEpoch;this.effective=false;this.lastSeen.clear();
  for(const key of [...this.owned])try{globalShortcut.unregister(key);this.owned.delete(key);}catch{/* Retain ownership for a later cleanup; callbacks stay gated off. */}
 }
 private acquire():void{
  if(this.closed)throw new Error('应用正在退出');
  if(this.systemSession){this.release();return;}
  try{
   for(const [key,label,action] of keys){
    if(this.owned.has(key)&&globalShortcut.isRegistered(key))continue;
    if(globalShortcut.isRegistered(key))throw new Error(`${label}媒体键已由本应用的其他组件注册`);
    if(!globalShortcut.register(key,()=>this.dispatch(key,action)))throw new Error(`${label}媒体键当前不可用或已被其他应用占用；未启用这组快捷键`);
    this.owned.add(key);
   }
  }catch(error){this.release();throw error;}
 }
 private dispatch(key:string,action:Action):void{
  if(this.closed||this.maintenance.held||this.busy||!this.preference.enabled||!this.effective||this.ports.sleeping())return;
  if(action==='stop'){++this.intentEpoch;try{this.ports.stop();}catch(error){this.record(error);}return;}
  const now=performance.now(),last=this.lastSeen.get(key);this.lastSeen.set(key,now);if(last!==undefined&&now-last<350)return;
  const state=this.ports.playback(),queue=this.ports.queue();
  if(this.transportBusy||state.state==='preparing'||!queue.currentEntryId||action==='next'&&queue.entries.length<2)return;
  this.transportBusy=true;const epoch=this.intentEpoch,token=this.ports.token();
  void Promise.resolve().then(()=>{if(epoch===this.intentEpoch&&token===this.ports.token()&&!this.closed&&this.effective&&!this.busy&&!this.ports.sleeping())return this.ports[action]();})
   .catch(error=>this.record(error)).finally(()=>{this.transportBusy=false;});
 }
 private async message(options:Electron.MessageBoxOptions):Promise<Electron.MessageBoxReturnValue>{
  const window=this.ports.window();return window&&!window.isDestroyed()?dialog.showMessageBox(window,options):dialog.showMessageBox(options);
 }
 settings():Promise<void>{return this.maintenance.run(()=>this.settingsNow());}
 private async settingsNow():Promise<void>{
  if(this.closed)return;if(this.busy)throw new Error('媒体快捷键设置正在处理');this.busy=true;
  try{
   this.preference=readMediaKeyPreference(await this.ports.load());if(!this.preference.enabled)this.release();
   const result=await this.message({type:'question',title:'媒体快捷键',message:'是否让 Aural 响应系统媒体键？',detail:`${this.systemSession?'系统媒体面板已接管按键；这里的启用设置用于面板不可用时的备用控制。\n':''}当前：${this.effective?'已启用':this.preference.enabled?'已保存启用，当前未生效':'未启用'}。启用后，窗口隐藏时也可播放／暂停、上一首、下一首和停止；可能与其他播放器冲突。${this.error?`\n最近状态：${this.error}`:''}`,buttons:['启用／重试','停用','取消'],defaultId:this.preference.enabled?0:1,cancelId:2,noLink:true});
   if(result.response===2||this.closed)return;
   if(result.response!==0&&result.response!==1)throw new Error('无效媒体键设置选择');
   const enabled=result.response===0;
   if(enabled)this.acquire();
   if(enabled!==this.preference.enabled){
    const before=this.preference;if(before.revision>=Number.MAX_SAFE_INTEGER)throw new Error('媒体键设置修订达到上限');
    const expected:MediaKeyPreference={version:1,revision:before.revision+1,enabled};let saved:MediaKeyPreference;
    try{saved=readMediaKeyPreference(await this.ports.save(before,expected));}
    catch(error){
     try{saved=readMediaKeyPreference(await this.ports.load());}catch{this.release();throw new Error('媒体键设置保存结果尚未确认，快捷键已停用；请重新打开设置核对');}
     this.preference=saved;if(JSON.stringify(saved)!==JSON.stringify(expected))throw error;
    }
    if(JSON.stringify(saved)!==JSON.stringify(expected))throw new Error('媒体键设置回读不一致');
    this.preference=saved;
   }
   if(this.closed)return;if(enabled){this.acquire();this.effective=!this.systemSession;}else this.release();
   if(!enabled&&this.owned.size){this.record(new Error('媒体键已停用，解绑尚未确认'));return;}this.error='';
  }catch(error){
   // Failed or unknown opt-in cannot leave speculative registrations active.
   this.release();
   this.record(error);throw error;
  }finally{this.busy=false;if(this.routePending){this.routePending=false;if(!this.error)this.activateFallback();}}
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{this.release();await this.maintenance.waitRequests();this.release();if(this.busy||this.owned.size)throw new Error('媒体快捷键设置或解绑尚未确认');});}
 endMaintenance(owner:string):void{this.maintenance.end(owner);this.activateFallback();}
 close():void{this.closed=true;this.release();}
}
