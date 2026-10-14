import {MaintenanceHold} from './maintenance-hold.js';
import {dialog,screen,type BrowserWindow,type Display} from 'electron';
import {defaultWindowPlacementPreference,readWindowPlacementPreference,type WindowPlacementPreference,type WindowPlacement,type WindowRect} from '../shared/window-placement.js';
type Ports={inputBlocked?:()=>boolean;window:()=>BrowserWindow|null;load:()=>Promise<unknown>;save:(expected:WindowPlacementPreference,value:WindowPlacementPreference)=>Promise<unknown>;error:(message:string)=>void};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const errorText=(e:unknown)=>String(e instanceof Error?e.message:e).slice(0,512);
function clamp(b:WindowRect,a:WindowRect):WindowRect{
 const width=Math.min(a.width,Math.max(Math.min(760,a.width),b.width)),height=Math.min(a.height,Math.max(Math.min(480,a.height),b.height));
 return {x:Math.round(Math.max(a.x,Math.min(b.x,a.x+a.width-width))),y:Math.round(Math.max(a.y,Math.min(b.y,a.y+a.height-height))),width,height};
}
function centered(d:Display):WindowRect{const a=d.workArea,width=Math.min(1320,a.width),height=Math.min(850,a.height);return {x:Math.round(a.x+(a.width-width)/2),y:Math.round(a.y+(a.height-height)/2),width,height};}
function onDisplay(b:WindowRect,maximized:boolean,d:Display):WindowPlacement{
 return {bounds:b,maximized,display:{id:String(d.id),label:d.label.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160),workArea:{...d.workArea},scaleFactor:d.scaleFactor}};
}
// Only Main observes geometry. Coordinates are DIP; display density is evidence, never a second scaling multiplier.
export class WindowPlacementManager{
 private readonly maintenance=new MaintenanceHold();
 private preference=defaultWindowPlacementPreference();private known=false;private closed=false;private quitting=false;private settingsBusy=false;private initializedWindow:BrowserWindow|null=null;
 private pending:WindowPlacement|null=null;private flight:Promise<void>|null=null;private timer:NodeJS.Timeout|null=null;private screenTimer:NodeJS.Timeout|null=null;
 constructor(private readonly ports:Ports){}
 private report(e:unknown):void{try{this.ports.error(errorText(e));}catch{}}
 restoreSnapshot(owner:string):WindowPlacementPreference{this.maintenance.assertFrozen(owner);if(this.closed||this.quitting||this.settingsBusy||this.flight||this.pending)throw new Error('窗口位置原请求未停止');return structuredClone(this.preference);}
 prepareRestoreState(owner:string,value:unknown):void{this.restoreSnapshot(owner);this.preference=readWindowPlacementPreference(value);this.known=true;this.pending=null;}
 async initialize():Promise<void>{
  try{this.preference=readWindowPlacementPreference(await this.ports.load());this.known=true;}catch(e){this.report(`窗口位置无法读取，本次使用默认位置：${errorText(e)}`);}
  if(this.closed||this.quitting)return;screen.on('display-added',this.displaysChanged);screen.on('display-removed',this.displaysChanged);screen.on('display-metrics-changed',this.displaysChanged);
 }
 creation():{bounds:WindowRect;maximized:boolean;minWidth:number;minHeight:number}{
  const p=this.preference.enabled?this.preference.placement:null,all=screen.getAllDisplays();
  const matched=p?all.find(d=>String(d.id)===p.display.id&&d.label.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,160)===p.display.label):undefined;const d=matched??screen.getPrimaryDisplay();
  let b=centered(d);
  if(p&&matched){const old=p.display.workArea,a=d.workArea;
   const fraction=(pos:number,start:number,space:number)=>space>0?Math.max(0,Math.min(1,(pos-start)/space)):0.5;
   b=clamp({...p.bounds,x:a.x+fraction(p.bounds.x,old.x,old.width-p.bounds.width)*Math.max(0,a.width-p.bounds.width),y:a.y+fraction(p.bounds.y,old.y,old.height-p.bounds.height)*Math.max(0,a.height-p.bounds.height)},a);
  }
  return {bounds:b,maximized:p?.maximized??false,minWidth:Math.min(760,d.workArea.width),minHeight:Math.min(480,d.workArea.height)};
 }
 bind(w:BrowserWindow):void{
  const observe=()=>{if(this.closed||this.quitting||w!==this.initializedWindow||w!==this.ports.window())return;this.capture();this.arm();};
  w.on('move',observe);w.on('resize',observe);w.on('maximize',observe);w.on('unmaximize',observe);w.on('hide',observe);
  const recover=()=>{if(w===this.initializedWindow){this.ensureVisible();observe();}};
  w.on('restore',recover);w.on('unmaximize',recover);w.on('leave-full-screen',recover);
  w.on('closed',()=>{if(this.initializedWindow===w)this.initializedWindow=null;});
 }
 finishRestore(w:BrowserWindow,maximized:boolean):void{
  if(this.closed||this.quitting||w.isDestroyed()||w!==this.ports.window())return;
  if(maximized)w.maximize();this.initializedWindow=w;this.capture();this.arm();
 }
 private capture(force=false):void{
  if((this.maintenance.held||this.ports.inputBlocked?.())&&!force)return;
  const w=this.ports.window();if(!w||w.isDestroyed()||w!==this.initializedWindow||w.isMinimized()||w.isFullScreen()||!this.preference.enabled)return;
  try{const b=w.getNormalBounds(),d=screen.getDisplayMatching(w.getBounds());this.pending=readWindowPlacementPreference({version:1,revision:0,enabled:true,placement:onDisplay(clamp(b,d.workArea),w.isMaximized(),d)}).placement;}
  catch(e){this.report(e);}
 }
 private arm():void{
  if(this.closed||this.quitting||this.maintenance.held||this.ports.inputBlocked?.()||this.settingsBusy||this.flight||this.timer||!this.known||!this.pending)return;
  this.timer=setTimeout(()=>{this.timer=null;void this.drain();},450);
 }
 private async write(enabled:boolean,placement:WindowPlacement|null):Promise<boolean>{
  if(!this.known||this.closed)return false;
  const before=this.preference;if(before.enabled===enabled&&same(before.placement,placement))return true;
  if(before.revision>=Number.MAX_SAFE_INTEGER){this.known=false;this.report('窗口位置修订达到上限');return false;}
  const next:WindowPlacementPreference={version:1,revision:before.revision+1,enabled,placement};let current:WindowPlacementPreference;
  try{current=readWindowPlacementPreference(await this.ports.save(before,next));}
  catch(e){try{current=readWindowPlacementPreference(await this.ports.load());}catch{this.known=false;this.report('窗口位置保存结果尚未确认，请打开“窗口位置与显示器”重新读取；自动保存已暂停。');return false;}}
  if(this.closed)return false;this.preference=current;
  if(!same(current,next)){this.known=false;this.report('窗口位置修订已变化，自动保存已暂停，请重新读取设置。');return false;}return true;
 }
 private drain(force=false):Promise<void>{
  if((this.maintenance.held||this.ports.inputBlocked?.())&&!force)return Promise.resolve();
  if(this.flight)return this.flight;
  if(this.closed||this.settingsBusy||!this.known||!this.preference.enabled||!this.pending)return Promise.resolve();
  const placement=this.pending;this.pending=null;
  const running=this.write(true,placement).then(ok=>{if(!ok&&!this.pending)this.pending=placement;}).catch(e=>{this.known=false;this.report(e);}).finally(()=>{if(this.flight===running)this.flight=null;this.arm();});
  this.flight=running;return running;
 }
 private displaysChanged=()=>{
  if(this.closed||this.quitting||this.screenTimer)return;
  this.screenTimer=setTimeout(()=>{this.screenTimer=null;this.ensureVisible();this.capture();this.arm();},150);
 };
 private ensureVisible():void{
  const w=this.ports.window();if(this.closed||this.quitting||!w||w.isDestroyed()||w!==this.initializedWindow||w.isMinimized()||w.isMaximized()||w.isFullScreen())return;
  try{const b=w.getBounds(),all=screen.getAllDisplays(),d=screen.getDisplayMatching(b),a=d.workArea;
   const reachable=all.some(d=>{const r=d.workArea;return Math.min(b.x+b.width,r.x+r.width)-Math.max(b.x,r.x)>=Math.min(120,b.width)&&b.y>=r.y-4&&b.y+32<=r.y+r.height;});
   w.setMinimumSize(Math.min(760,a.width),Math.min(480,a.height));
   if(!reachable||b.width>a.width||b.height>a.height)w.setBounds(clamp(b,a));
  }catch(e){this.report(e);}
 }
 settings():Promise<void>{return this.maintenance.run(()=>{if(this.ports.inputBlocked?.())throw new Error('恢复界面尚未准备好，窗口位置设置继续暂停');return this.settingsNow();});}
 private async settingsNow():Promise<void>{
  if(this.closed||this.quitting)throw new Error('应用正在退出');if(this.settingsBusy)throw new Error('窗口位置设置正在处理');this.settingsBusy=true;
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  try{
   if(this.flight)await this.flight;
   this.known=false;this.preference=readWindowPlacementPreference(await this.ports.load());this.known=true;if(this.closed||this.quitting)return;
   const w=this.ports.window(),options:Electron.MessageBoxOptions={type:'question',title:'窗口位置与显示器',message:'重启时如何恢复窗口？',detail:`当前：${this.preference.enabled?'记住窗口位置、大小和最大化状态':'使用默认位置'}。显示器不可用时回到主屏幕。重置会立即恢复默认窗口，并清除已保存的位置。`,buttons:['记住当前位置','下次使用默认位置','重置当前窗口','取消'],defaultId:this.preference.enabled?0:1,cancelId:3,noLink:true};
   const result=w&&!w.isDestroyed()?await dialog.showMessageBox(w,options):await dialog.showMessageBox(options);
   if(result.response===3||this.closed||this.quitting)return;
   if(result.response===0){this.capture();if(!this.pending){if(!w||w.isDestroyed()||w.isMinimized()||w.isFullScreen())throw new Error('请先恢复普通窗口，再记住当前位置');this.pending=onDisplay(clamp(w.getNormalBounds(),screen.getDisplayMatching(w.getBounds()).workArea),w.isMaximized(),screen.getDisplayMatching(w.getBounds()));}}
   if(result.response===2&&w&&!w.isDestroyed()&&w.isFullScreen())throw new Error('请先退出全屏，再重置窗口');
   if(!await this.write(result.response!==1,result.response===0?this.pending:null))throw new Error('窗口位置设置未确认，请重新读取后操作');
   this.pending=null;
   if(result.response===2&&w&&!w.isDestroyed()&&!this.quitting){w.unmaximize();const d=screen.getPrimaryDisplay();w.setMinimumSize(Math.min(760,d.workArea.width),Math.min(480,d.workArea.height));w.setBounds(centered(d));this.capture();}
  }catch(e){this.report(e);throw e;}finally{this.settingsBusy=false;this.arm();}
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  if(this.timer)clearTimeout(this.timer);this.timer=null;
  await this.maintenance.waitRequests();await this.flight;
  if(this.closed||this.quitting||this.settingsBusy)throw new Error('窗口位置资料尚未停止');
  this.capture(true);await this.drain(true);
  if(this.pending&&this.preference.enabled)throw new Error('窗口位置仍有未确认的保存，不能开始备份');
 });}
 endMaintenance(owner:string):void{this.maintenance.end(owner);this.capture();this.arm();}
 resumeInteraction():void{this.capture();this.arm();}
 async flushForQuit():Promise<void>{
  if(this.quitting||this.closed)return;this.capture();this.quitting=true;
  if(this.timer){clearTimeout(this.timer);this.timer=null;}
  if(this.flight)await this.flight;if(this.closed)return;await this.drain();
 }
 close():void{this.closed=true;this.pending=null;if(this.timer)clearTimeout(this.timer);if(this.screenTimer)clearTimeout(this.screenTimer);screen.removeListener('display-added',this.displaysChanged);screen.removeListener('display-removed',this.displaysChanged);screen.removeListener('display-metrics-changed',this.displaysChanged);}
}
