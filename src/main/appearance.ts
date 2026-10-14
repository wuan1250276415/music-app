import {MaintenanceHold} from './maintenance-hold.js';
import {nativeTheme,screen,type BrowserWindow} from 'electron';
import {randomUUID} from 'node:crypto';
import {defaultAppearancePreference,readAppearancePreference,readAppearanceRequest,ZOOM_PERCENTAGES,type AppearancePreference,type AppearanceRequest,type AppearanceResult,type AppearanceState} from '../shared/appearance.js';
type Ports={inputBlocked?:()=>boolean;window:()=>BrowserWindow|null;load:()=>Promise<unknown>;save:(expected:AppearancePreference,value:AppearancePreference)=>Promise<unknown>;publish:(state:AppearanceState)=>void;error:(message:string)=>void};
const same=(a:AppearancePreference,b:AppearancePreference)=>JSON.stringify(a)===JSON.stringify(b);
const message=(e:unknown)=>String(e instanceof Error?e.message:e).slice(0,512);
export class Appearance{
 private readonly maintenance=new MaintenanceHold();
 private preference=defaultAppearancePreference();private revision=0;private status:AppearanceState['status']='unknown';private message='外观设置尚未读取';private applyError='';private closed=false;
 private busy=false;private attempt:{request:AppearanceRequest;before:AppearancePreference;next:AppearancePreference}|null=null;
 private pending:Promise<AppearanceResult>|null=null;private command='';private receipts=new Map<string,{request:string;result:AppearanceResult}>();
 private desiredZoom:number|null=null;private zoomTimer:NodeJS.Timeout|null=null;private displayTimer:NodeJS.Timeout|null=null;private observationTimer:NodeJS.Timeout|null=null;
 constructor(private readonly ports:Ports){}
 snapshot():AppearanceState{
  const w=this.ports.window();let actualZoomPercent=this.preference.zoomPercent,displayScaleFactor=1;
  if(w&&!w.isDestroyed()){try{actualZoomPercent=Math.round(w.webContents.getZoomFactor()*100);displayScaleFactor=screen.getDisplayMatching(w.getBounds()).scaleFactor;}catch{/* Last known preference remains available. */}}
  return {version:1,revision:this.revision,preference:{...this.preference},effectiveTheme:nativeTheme.shouldUseDarkColors?'dark':'light',forcedColors:nativeTheme.inForcedColorsMode,actualZoomPercent,displayScaleFactor,status:this.status,message:this.message,applyError:this.applyError};
 }
 private changed():void{if(this.closed)return;this.revision++;try{this.ports.publish(this.snapshot());}catch{/* Renderer reload can read the current snapshot. */}}
 private report(value:unknown):void{try{this.ports.error(message(value));}catch{}}
 restoreSnapshot(owner:string):{preference:AppearancePreference;pendingRequest:AppearanceRequest|null;desiredZoom:number|null}{this.maintenance.assertFrozen(owner);if(this.closed||this.busy)throw new Error('外观状态尚未停止');return {preference:{...this.preference},pendingRequest:this.attempt?{...this.attempt.request}:null,desiredZoom:this.desiredZoom};}
 prepareRestoreState(owner:string,value:unknown):void{
  this.maintenance.assertFrozen(owner);if(this.closed||this.busy||this.zoomTimer)throw new Error('外观状态尚未停止');const next=readAppearancePreference(value);
  this.preference=next;this.attempt=null;this.pending=null;this.command='';this.receipts.clear();this.desiredZoom=null;this.status='ready';this.message='恢复后的外观设置已读取，等待恢复完成';this.applyError='';this.restoredPrepared=true;
 }
 private restoredPrepared=false;
 async initialize():Promise<void>{
  try{this.preference=readAppearancePreference(await this.ports.load());this.status='ready';this.message='外观设置已读取';}catch(e){this.status='unknown';this.message=`无法读取外观设置：${message(e)}`;this.report(this.message);}
  if(this.closed)return;this.apply();nativeTheme.on('updated',this.themeChanged);screen.on('display-added',this.displayChanged);screen.on('display-removed',this.displayChanged);screen.on('display-metrics-changed',this.displayChanged);this.changed();
 }
 background():string{return nativeTheme.shouldUseDarkColors?'#13110f':'#f6f1e8';}
 private themeChanged=()=>{if(this.closed)return;this.setBackground();this.changed();};
 private displayChanged=()=>{if(this.closed||this.displayTimer)return;this.displayTimer=setTimeout(()=>{this.displayTimer=null;this.changed();},150);};
 private setBackground():void{const w=this.ports.window();if(w&&!w.isDestroyed())try{w.setBackgroundColor(this.background());}catch(e){this.applyError=message(e);}}
 private apply():void{
  if(this.closed)return;this.applyError='';try{nativeTheme.themeSource=this.preference.theme;this.setBackground();const w=this.ports.window();if(w&&!w.isDestroyed())w.webContents.setZoomFactor(this.preference.zoomPercent/100);}catch(e){this.applyError=`外观设置已保存，但界面应用失败：${message(e)}`;this.report(this.applyError);}
 }
 bind(w:BrowserWindow):void{
  if(this.closed)return;
  w.webContents.setZoomMode('manual');w.webContents.setZoomFactor(this.preference.zoomPercent/100);
  void w.webContents.setVisualZoomLevelLimits(1,1).catch(e=>{if(!this.closed)this.report(e);});
  w.webContents.on('did-finish-load',()=>{if(this.closed||w!==this.ports.window())return;this.apply();this.changed();});
  w.webContents.on('zoom-changed',(_event,direction)=>{if(w===this.ports.window())this.zoom(direction==='in'?1:-1);});
  w.webContents.on('before-input-event',(event,input)=>{
   const modifier=process.platform==='darwin'?input.meta&&!input.control:input.control&&!input.meta;
   if(!modifier||input.alt||input.type!=='keyDown')return;
   const step=['Equal','NumpadAdd'].includes(input.code)?1:['Minus','NumpadSubtract'].includes(input.code)?-1:['Digit0','Numpad0'].includes(input.code)?0:null;
   if(step===null)return;event.preventDefault();this.zoom(step as -1|0|1);
  });
  const observe=()=>{if(this.closed||this.observationTimer)return;this.observationTimer=setTimeout(()=>{this.observationTimer=null;this.changed();},100);};w.on('move',observe);w.on('resize',observe);
  const restore=()=>{if(this.closed||w.isDestroyed()||w!==this.ports.window())return;observe();};w.on('restore',restore);w.on('unmaximize',restore);w.on('leave-full-screen',restore);
 }
 refresh():Promise<AppearanceState>{return this.maintenance.run(()=>this.refreshNow());}
 private async refreshNow():Promise<AppearanceState>{
  if(this.closed)throw new Error('应用正在退出');if(this.busy)return this.snapshot();
  this.busy=true;try{
   const current=readAppearancePreference(await this.ports.load());if(this.closed)return this.snapshot();this.preference=current;
   if(this.attempt){const result=this.finish(same(current,this.attempt.next)?'saved':'rejected',same(current,this.attempt.next)?'':'原外观设置提交未保存或已被其他修订替代');return result.state;}
   this.status='ready';this.message='外观设置已重新读取';this.apply();this.changed();return this.snapshot();
  }catch(e){this.status='unknown';this.message=`外观设置读取结果尚未确认：${message(e)}`;this.changed();return this.snapshot();}finally{this.busy=false;}
 }
 configure(value:unknown):Promise<AppearanceResult>{return this.maintenance.run(()=>{if(this.ports.inputBlocked?.())throw new Error('恢复界面尚未准备好，外观修改继续暂停');return this.configureNow(value);});}
 private configureNow(value:unknown):Promise<AppearanceResult>{
  let request:AppearanceRequest;try{request=readAppearanceRequest(value);}catch(e){return Promise.resolve({status:'rejected',state:this.snapshot(),error:message(e)});}
  if(this.closed)return Promise.resolve({status:'rejected',state:this.snapshot(),error:'应用正在退出'});
  const fingerprint=JSON.stringify(request),old=this.receipts.get(request.commandId);
  if(old)return Promise.resolve(old.request===fingerprint?{...old.result,state:this.snapshot()}:{status:'rejected',state:this.snapshot(),error:'同一外观操作不可改变内容'});
  if(this.pending&&this.command===request.commandId)return this.attempt&&JSON.stringify(this.attempt.request)===fingerprint?this.pending:Promise.resolve({status:'rejected',state:this.snapshot(),error:'同一外观操作不可改变内容'});
  if(this.busy)return Promise.resolve({status:'rejected',state:this.snapshot(),error:'外观设置正在保存或读取，请稍后重试'});
  if(this.attempt&&JSON.stringify(this.attempt.request)!==fingerprint)return Promise.resolve({status:'rejected',state:this.snapshot(),error:'请先核对原外观设置提交'});
  if(this.status==='unknown'&&!this.attempt)return Promise.resolve({status:'rejected',state:this.snapshot(),error:'请先重新读取外观设置'});
  if(!this.attempt&&request.baseRevision!==this.preference.revision)return Promise.resolve({status:'rejected',state:this.snapshot(),error:'外观设置已变化，请重新读取'});
  if(!this.attempt&&request.baseRevision>=Number.MAX_SAFE_INTEGER)return Promise.resolve({status:'rejected',state:this.snapshot(),error:'外观修订已达上限'});
  const replay=Boolean(this.attempt);if(!replay){this.desiredZoom=null;if(this.zoomTimer){clearTimeout(this.zoomTimer);this.zoomTimer=null;}}
  if(!this.attempt)this.attempt={request,before:this.preference,next:{version:1,revision:request.baseRevision+1,theme:request.theme,zoomPercent:request.zoomPercent}};
  this.busy=true;this.command=request.commandId;this.status='saving';this.message=replay?'正在核对原提交…':'正在保存外观…';this.changed();
  const running=this.write(replay).finally(()=>{this.busy=false;if(this.pending===running)this.pending=null;this.armZoom();});this.pending=running;return running;
 }
 private async write(replay:boolean):Promise<AppearanceResult>{
  const a=this.attempt!;let current:AppearancePreference;
  try{current=readAppearancePreference(replay?await this.ports.load():await this.ports.save(a.before,a.next));}
  catch(e){try{current=readAppearancePreference(await this.ports.load());}catch{this.status='unknown';this.message='保存结果尚未确认，请核对原操作；界面保留已确认的外观。';this.desiredZoom=null;this.changed();return {status:'unknown',state:this.snapshot(),error:message(e)};}}
  if(this.closed)return {status:'unknown',state:this.snapshot(),error:'应用退出时结果尚未发送，请重启后读取外观设置'};
  this.preference=current;return this.finish(same(current,a.next)?'saved':'rejected',same(current,a.next)?'':'外观设置未保存或修订已变化，请重新选择后提交');
 }
 private finish(status:'saved'|'rejected',error:string):AppearanceResult{
  this.status='ready';this.message=status==='saved'?'外观设置已保存':error;this.apply();this.changed();const result:AppearanceResult={status,state:this.snapshot(),error};
  if(this.attempt){this.receipts.set(this.attempt.request.commandId,{request:JSON.stringify(this.attempt.request),result});if(this.receipts.size>64)this.receipts.delete(this.receipts.keys().next().value!);this.attempt=null;}return result;
 }
 private zoom(direction:-1|0|1):void{
  if(this.closed||this.maintenance.held||this.ports.inputBlocked?.())return;if(this.status==='unknown'){this.report('外观保存结果尚未确认，请从“外观与缩放”核对设置');return;}
  const current=this.desiredZoom??this.attempt?.next.zoomPercent??this.preference.zoomPercent,index=ZOOM_PERCENTAGES.indexOf(current as typeof ZOOM_PERCENTAGES[number]);
  this.desiredZoom=direction===0?100:ZOOM_PERCENTAGES[Math.max(0,Math.min(ZOOM_PERCENTAGES.length-1,index+direction))];this.armZoom();
 }
 private armZoom():void{
  if(this.closed||this.maintenance.held||this.ports.inputBlocked?.()||this.zoomTimer||this.desiredZoom===null||this.status==='unknown')return;
  this.zoomTimer=setTimeout(()=>{this.zoomTimer=null;if(this.busy){this.armZoom();return;}const desired=this.desiredZoom;this.desiredZoom=null;if(desired===null||desired===this.preference.zoomPercent)return;void this.configure({commandId:randomUUID(),baseRevision:this.preference.revision,theme:this.preference.theme,zoomPercent:desired}).then(result=>{if(result.status!=='saved')this.report(result.error||result.state.message);}).catch(e=>this.report(e));},150);
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  if(this.zoomTimer)clearTimeout(this.zoomTimer);this.zoomTimer=null;
  await this.maintenance.waitRequests();await this.pending;
  if(this.busy||this.closed)throw new Error('外观资料仍在处理或应用已退出');
  if(this.desiredZoom!==null){
   const desired=this.desiredZoom;
   if(desired===this.preference.zoomPercent)this.desiredZoom=null;
   else{
    const result=await this.configureNow({commandId:randomUUID(),baseRevision:this.preference.revision,theme:this.preference.theme,zoomPercent:desired});
    if(result.status!=='saved')throw new Error('待保存缩放资料未确认，不能开始备份');
   }
  }
 });}
 endMaintenance(owner:string):void{this.maintenance.end(owner);if(this.restoredPrepared){this.restoredPrepared=false;this.apply();this.changed();}this.armZoom();}
 close():void{this.closed=true;if(this.zoomTimer)clearTimeout(this.zoomTimer);if(this.displayTimer)clearTimeout(this.displayTimer);if(this.observationTimer)clearTimeout(this.observationTimer);this.desiredZoom=null;nativeTheme.removeListener('updated',this.themeChanged);screen.removeListener('display-added',this.displayChanged);screen.removeListener('display-removed',this.displayChanged);screen.removeListener('display-metrics-changed',this.displayChanged);}
}
