import {defaultDsdOutput,nextDsdOutput,readDsdOutputPreference,readDsdOutputRequest,selectedDopAuthorization,type DsdOutputPreference,type DsdOutputRequest,type DsdOutputView,type DsdOutputResult} from '../shared/dsd-output.js';
import {sameAsioDriver} from '../shared/asio-output.js';
import {processingEnabled} from '../shared/audio-processing.js';
import type {AsioOutputManager} from './asio-output-manager.js';
import type {AsioDrivers} from './asio-drivers.js';
import type {AudioController} from './audio.js';
import type {PlaybackCoordinator} from './playback.js';
type Store={load:()=>Promise<DsdOutputPreference>;receipt:(r:DsdOutputRequest)=>Promise<DsdOutputPreference|null>;save:(r:DsdOutputRequest)=>Promise<DsdOutputPreference>};
export class DsdOutputManager {
 private preference=defaultDsdOutput();private unknown:DsdOutputRequest|null=null;
 private serial:Promise<unknown>=Promise.resolve();
 private receipts=new Map<string,{identity:string;promise:Promise<DsdOutputResult>;settled:boolean}>();
 constructor(private readonly audio:AudioController,private readonly coordinator:PlaybackCoordinator,private readonly asio:AsioOutputManager,
  private readonly drivers:AsioDrivers,private readonly assertReleased:()=>void,private readonly store:Store,private readonly publish:(view:DsdOutputView)=>void){}
 prepareRestoreState(owner:string,value:unknown):void{
  this.coordinator.assertRestoreFrozen(owner);if([...this.receipts.values()].some(r=>!r.settled))throw new Error('原输出设置请求尚未结束');
  const next=readDsdOutputPreference(value);this.preference=next;this.unknown=null;this.receipts.clear();this.audio.applyDsdOutputPreference(this.preference);
 }
 async initialize():Promise<void>{this.preference=readDsdOutputPreference(await this.store.load());this.audio.applyDsdOutputPreference(this.preference);}
 snapshot():DsdOutputView{return {preference:structuredClone(this.preference),pendingRequest:this.unknown?structuredClone(this.unknown):null,playbackIntegration:'raw-dsd'};}
 assertKnown():void{if(this.audio.backendSnapshot().backend==='asio'&&this.unknown)throw new Error('DSD 设置保存结果尚未确认，请先核对原操作');}
 private changed():void{try{this.publish(this.snapshot());}catch{/* Committed settings stay authoritative. */}}
 private result(status:DsdOutputResult['status'],error=''):DsdOutputResult{return {status,view:this.snapshot(),error};}
 configure(value:unknown):Promise<DsdOutputResult>{
  const r=readDsdOutputRequest(value),identity=JSON.stringify(r),old=this.receipts.get(r.commandId);
  if(old){if(old.identity!==identity)throw new Error('DSD 操作 ID 已用于其他内容');return old.settled?old.promise.then(result=>({...result,view:this.snapshot()})):old.promise;}
  if(this.receipts.size>=128){for(const [id,entry] of this.receipts)if(entry.settled){this.receipts.delete(id);break;}if(this.receipts.size>=128)throw new Error('DSD 设置操作过多，请稍后重试');}
  const promise=this.serial.then(()=>this.execute(r));this.serial=promise.then(()=>{},()=>{});const entry={identity,promise,settled:false};this.receipts.set(r.commandId,entry);
  void promise.then(result=>{entry.settled=true;if(result.status==='unknown')this.receipts.delete(r.commandId);},()=>{entry.settled=true;});return promise;
 }
 private async prepare(r:DsdOutputRequest):Promise<DsdOutputPreference>{
  if(this.audio.snapshot().state==='preparing')throw new Error('正在准备或重建播放，请稍后修改 DSD 设置');
  if(this.audio.snapshot().asioDsd?.tail?.status==='completed'&&!this.audio.outputIsReleased())throw new Error('DSD 宿主正在退出，请等待输出释放');
  this.assertReleased();if(this.asio.snapshot().pendingRequest)throw new Error('ASIO 配置保存结果尚未确认，请先核对');
  const next=nextDsdOutput(this.preference,r),p=this.asio.snapshot().preference;
  if(r.action==='save-profile'){
   const catalog=await this.drivers.list();if(catalog.registryStatus!==0||!catalog.drivers.some(driver=>sameAsioDriver(driver,r.profile.driver)))throw new Error('档案驱动未在当前 64 位目录中发现，请刷新');
  }
  if((r.action==='configure'||r.action==='save-profile'&&r.profile.profileId===next.selectedProfileId)&&(next.mode==='native-dsd'||next.mode==='dop'||next.mode==='pcm')){
   if(!p.driver)throw new Error('请先保存 ASIO 驱动和明确输出声道');
   const catalog=await this.drivers.list();if(catalog.registryStatus!==0||!catalog.drivers.some(driver=>sameAsioDriver(driver,p.driver)))throw new Error('已保存的 ASIO 驱动未发现，请重新选择');
   if(next.mode==='pcm'&&!p.allowConversion)throw new Error('DSD 转 PCM 需要明确允许 PCM 精度转换');
   if(next.mode!=='pcm'&&processingEnabled(this.audio.backendSnapshot().asioProcessing))throw new Error('原始 DSD 需要关闭软件音量、静音、ReplayGain 和预增益，或选择转 PCM');
   if(next.mode==='dop'){
    const profile=selectedDopAuthorization(next);if(!profile||!sameAsioDriver(profile.driver,p.driver)||JSON.stringify(profile.outputChannels)!==JSON.stringify(p.outputChannels))throw new Error('DoP 档案须匹配当前已保存的 ASIO 驱动和声道映射');
   }
  }
  return next;
 }
 private async execute(r:DsdOutputRequest):Promise<DsdOutputResult>{
  let committed=false;
  try{
   if(this.unknown&&JSON.stringify(this.unknown)!==JSON.stringify(r))throw new Error('上次 DSD 保存结果尚未确认，请核对原操作');
   const old=await this.store.receipt(r);
   if(old&&!this.unknown)return this.result('saved','已核对原操作，不重复应用旧设置。');
   if(old||this.unknown){
    await this.coordinator.inspectStoppedOutput(async()=>{this.assertReleased();const p=readDsdOutputPreference(await this.store.load());this.audio.applyDsdOutputPreference(p);this.preference=p;this.unknown=null;this.changed();});
    return this.result(old?'saved':'rejected',old?'已核对保存回执，请手动继续播放。':'已确认原操作没有保存，可重新提交。');
   }
   await this.coordinator.configureBackendOutput('asio',async()=>{
    const expected=await this.prepare(r);let saved:DsdOutputPreference;
    try{saved=await this.store.save(r);}catch(error){let receipt:DsdOutputPreference|null;try{receipt=await this.store.receipt(r);}catch{this.unknown=r;this.changed();throw new Error('DSD 保存结果尚未确认，请核对原操作');}if(!receipt)throw error;saved=receipt;}
    try{saved=readDsdOutputPreference(saved);if(JSON.stringify(saved)!==JSON.stringify(expected))throw new Error('DSD 保存回读与原操作不一致');}catch(error){this.unknown=r;this.changed();throw error;}
    committed=true;this.preference=saved;try{this.audio.applyDsdOutputPreference(saved);}catch(error){this.unknown=r;this.changed();throw error;}this.changed();
   },async()=>{await this.prepare(r);},()=>this.audio.dsdPreferenceAffectsPlayback(nextDsdOutput(this.preference,r)),()=>this.preference.mode!=='stop'&&(this.preference.mode!=='inherit'||this.audio.backendSnapshot().asioDsdPolicy!=='stop'));
   return this.result('saved','DSD 预设与设备档案已保存。原始输出的设备与数值验证仍待完成。');
  }catch(error){return this.result(this.unknown?.commandId===r.commandId?'unknown':committed?'saved':'rejected',`${committed?'设置已保存，恢复播放未完成：':''}${error instanceof Error?error.message:String(error)}`);}
 }
}
