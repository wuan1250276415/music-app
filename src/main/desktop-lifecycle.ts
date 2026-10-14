import {MaintenanceHold} from './maintenance-hold.js';
import {app,dialog,Menu,nativeImage,Tray,type BrowserWindow} from 'electron';
import {defaultDesktopPreference,readDesktopPreference,type DesktopPreference} from '../shared/desktop-preference.js';
import type {PlaybackState,QueueState} from '../shared/contracts.js';

type Ports={inputBlocked?:()=>boolean;window:()=>BrowserWindow|null;show:()=>void;playback:()=>PlaybackState;queue:()=>QueueState;
 toggle:()=>Promise<unknown>;previous:()=>Promise<unknown>;next:()=>Promise<unknown>;stop:()=>unknown;
 load:()=>Promise<unknown>;save:(expected:DesktopPreference,value:DesktopPreference)=>Promise<unknown>;mediaKeysSettings:()=>Promise<void>;systemMediaSettings:()=>Promise<void>;windowPlacementSettings:()=>Promise<void>};

// Main owns the tray and close policy. Renderer cannot hide a window or bypass explicit exit cleanup.
export class DesktopLifecycle{
 private readonly maintenance=new MaintenanceHold();
 private tray:Tray|null=null;private preference=defaultDesktopPreference();private busy=false;private quitting=false;private menuIdentity='';
 constructor(private readonly ports:Ports){}
 restoreSnapshot(owner:string):DesktopPreference{this.maintenance.assertFrozen(owner);if(this.busy||this.quitting)throw new Error('窗口与托盘状态未停止');return {...this.preference};}
 prepareRestoreState(owner:string,value:unknown):void{this.restoreSnapshot(owner);this.preference=readDesktopPreference(value);this.menuIdentity='';}
 async initialize():Promise<void>{
  this.preference=readDesktopPreference(await this.ports.load());
  if(this.quitting)return;
  try{
   // First-party monochrome waveform, no executable-path or packaged asset dependency.
   const pixels=Buffer.alloc(32*32*4);for(let y=0;y<32;y++)for(let x=0;x<32;x++){
    const bar=(x>=6&&x<10&&y>=10&&y<22)||(x>=14&&x<18&&y>=5&&y<27)||(x>=22&&x<26&&y>=10&&y<22);
    const i=(y*32+x)*4,v=bar?240:32;pixels[i]=pixels[i+1]=pixels[i+2]=v;pixels[i+3]=255;
   }
   const icon=nativeImage.createFromBitmap(pixels,{width:32,height:32,scaleFactor:1});
   if(icon.isEmpty())throw new Error('empty tray icon');
   this.tray=new Tray(icon);this.tray.on('double-click',()=>this.ports.show());this.refresh();
  }catch{this.tray?.destroy();this.tray=null;}
 }
 get hasTray():boolean{return Boolean(this.tray&&!this.tray.isDestroyed());}
 get isQuitting():boolean{return this.quitting;}
 beginQuit():void{this.quitting=true;this.tray?.destroy();this.tray=null;}
 bind(window:BrowserWindow):void{
  window.on('close',event=>{
   if(this.quitting)return;event.preventDefault();
   if(this.maintenance.held||this.ports.inputBlocked?.()){this.ports.show();return;}
   if(this.busy)return;this.busy=true;
   void this.handleClose(window).catch(error=>{if(!this.quitting)this.report(error);}).finally(()=>{this.busy=false;});
  });
  // Windows logoff/shutdown must never become a hidden background window.
  window.on('query-session-end',()=>{this.beginQuit();app.quit();});
 }
 private report(error:unknown):void{dialog.showErrorBox('Aural',error instanceof Error?error.message:String(error));}
 private async message(options:Electron.MessageBoxOptions):Promise<Electron.MessageBoxReturnValue>{
  const window=this.ports.window();return window&&!window.isDestroyed()?dialog.showMessageBox(window,options):dialog.showMessageBox(options);
 }
 private async save(behavior:DesktopPreference['closeBehavior']):Promise<void>{
  const before=this.preference;if(before.revision>=Number.MAX_SAFE_INTEGER)throw new Error('窗口设置修订达到上限');
  const expected:DesktopPreference={version:1,revision:before.revision+1,closeBehavior:behavior};let saved:DesktopPreference;
  try{saved=readDesktopPreference(await this.ports.save(before,expected));}
  catch(error){
   try{saved=readDesktopPreference(await this.ports.load());}catch{throw new Error('窗口设置保存结果尚未确认，窗口保持打开，请稍后重试');}
   this.preference=saved;if(JSON.stringify(saved)!==JSON.stringify(expected))throw error;
  }
  if(JSON.stringify(saved)!==JSON.stringify(expected))throw new Error('窗口设置回读不一致，窗口保持打开');
  this.preference=saved;
 }
 private handleClose(window:BrowserWindow):Promise<void>{return this.maintenance.run(()=>this.handleCloseNow(window));}
 private async handleCloseNow(window:BrowserWindow):Promise<void>{
  let behavior=this.preference.closeBehavior;
  if(!this.hasTray){
   const result=await this.message({type:'question',title:'关闭 Aural',message:'系统托盘不可用，关闭将退出应用。',detail:'退出会停止音乐和后台任务。',buttons:['退出应用','取消'],defaultId:1,cancelId:1,noLink:true});
   if(result.response!==0)return;behavior='quit';
  }else if(behavior==='ask'){
   const result=await this.message({type:'question',title:'关闭 Aural',message:'关闭窗口后，是否继续在后台运行？',detail:'后台运行会保留音乐播放和任务，可从系统托盘打开窗口或退出应用。',buttons:['后台运行','退出应用','取消'],defaultId:0,cancelId:2,checkboxLabel:'记住这次选择（可在“窗口与托盘”中修改）',checkboxChecked:false,noLink:true});
   if(result.response===2)return;behavior=result.response===0?'tray':'quit';
   if(result.checkboxChecked)await this.save(behavior);
  }
  if(this.quitting||window.isDestroyed()||window!==this.ports.window())return;
  if(behavior==='quit'){app.quit();return;}
  if(!this.hasTray)throw new Error('系统托盘不可用，窗口保持打开');
  window.hide();
 }
 settings():Promise<void>{return this.maintenance.run(()=>{if(this.ports.inputBlocked?.())throw new Error('恢复界面尚未准备好，托盘设置继续暂停');return this.settingsNow();});}
 private async settingsNow():Promise<void>{
  if(this.busy)throw new Error('窗口关闭设置正在处理，请稍后重试');this.busy=true;
  try{
   this.preference=readDesktopPreference(await this.ports.load());
   const choices=['ask','tray','quit'] as const;
   const result=await this.message({type:'question',title:'窗口与托盘',message:'关闭窗口时如何处理？',detail:`当前设置：${this.preference.closeBehavior==='ask'?'每次询问':this.preference.closeBehavior==='tray'?'后台运行':'退出应用'}。后台运行保留播放；退出会停止播放与后台任务。${this.hasTray?'':'系统托盘当前不可用，不能选择后台运行。'}`,buttons:['每次询问','后台运行','退出应用','取消'],defaultId:choices.indexOf(this.preference.closeBehavior),cancelId:3,noLink:true});
   if(result.response===3||this.quitting)return;
   if(result.response===1&&!this.hasTray)throw new Error('系统托盘不可用，设置未修改');
   const behavior=choices[result.response];if(!behavior)throw new Error('无效窗口设置');
   if(behavior!==this.preference.closeBehavior)await this.save(behavior);
  }finally{this.busy=false;}
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{await this.maintenance.waitRequests();if(this.busy)throw new Error('窗口关闭设置尚未停止');this.menuIdentity='';this.refresh();});}
 endMaintenance(owner:string):void{this.maintenance.end(owner);this.menuIdentity='';this.refresh();}
  refresh():void{
  if(!this.hasTray||this.quitting)return;
  try{this.updateMenu();}catch{
   this.tray?.destroy();this.tray=null;this.menuIdentity='';
   // If a previously usable tray fails, keep the application reachable.
   this.ports.show();
  }
 }
 private updateMenu():void{
  const blocked=this.maintenance.held||Boolean(this.ports.inputBlocked?.());
  const state=this.ports.playback(),queue=this.ports.queue(),active=state.state==='playing'||state.state==='paused';
  const identity=JSON.stringify([state.state,Boolean(queue.currentEntryId),queue.entries.length>1,blocked]);if(identity===this.menuIdentity)return;this.menuIdentity=identity;
  const action=(work:()=>unknown)=>()=>{void this.maintenance.run(()=>{if(this.ports.inputBlocked?.())throw new Error('恢复界面尚未准备好，系统操作继续暂停');return work();}).catch(error=>{if(!this.quitting)this.report(error);});};
  this.tray!.setToolTip(`Aural · ${state.state==='playing'?'正在播放':state.state==='paused'?'已暂停':state.state==='preparing'?'准备播放':state.state==='error'?'播放异常':'音乐库'}`);
  this.tray!.setContextMenu(Menu.buildFromTemplate([
   {label:'打开音乐库',click:()=>this.ports.show()},
   {type:'separator'},
   {label:state.state==='playing'?'暂停':'播放／继续',enabled:!blocked&&state.state!=='preparing'&&(active||Boolean(queue.currentEntryId)),click:action(this.ports.toggle)},
   {label:'上一首',enabled:!blocked&&state.state!=='preparing'&&Boolean(queue.currentEntryId),click:action(this.ports.previous)},
   {label:'下一首',enabled:!blocked&&state.state!=='preparing'&&queue.entries.length>1,click:action(this.ports.next)},
   {label:'停止',enabled:!blocked&&state.state!=='idle',click:action(this.ports.stop)},
   {type:'separator'},
   {label:'窗口与托盘…',enabled:!blocked,click:action(()=>this.settings())},
   {label:'窗口位置与显示器…',enabled:!blocked,click:action(this.ports.windowPlacementSettings)},
   {label:'系统媒体面板…',enabled:!blocked,click:action(this.ports.systemMediaSettings)},
   {label:'媒体快捷键…',enabled:!blocked,click:action(this.ports.mediaKeysSettings)},
   {label:'退出应用',click:()=>app.quit()}
  ]));
 }
}
