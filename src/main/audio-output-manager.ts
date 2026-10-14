import type {AudioOutputRequest,AudioOutputPreference,AudioOutputView,AudioOutputResult} from '../shared/contracts.js';
import {validateAudioOutputRequest,validateAudioOutputPreference,defaultAudioOutput} from '../shared/audio-output.js';
import type {AudioController} from './audio.js';
import type {PlaybackCoordinator} from './playback.js';
import type {WasapiDevices} from './audio-devices.js';
type Store={load:()=>Promise<AudioOutputPreference>;save:(request:AudioOutputRequest,deviceName:string|null)=>Promise<AudioOutputPreference>;receipt:(request:AudioOutputRequest)=>Promise<AudioOutputPreference|null>};
export class AudioOutputManager{
 private preference=defaultAudioOutput();private unknown:AudioOutputRequest|null=null;
 private receipts=new Map<string,{identity:string;promise:Promise<AudioOutputResult>;settled:boolean}>();
 constructor(private readonly audio:AudioController,private readonly coordinator:PlaybackCoordinator,private readonly devices:WasapiDevices,private readonly store:Store,private readonly publish:(view:AudioOutputView)=>void){}
 prepareRestoreState(owner:string,value:unknown):void{
  this.coordinator.assertRestoreFrozen(owner);if([...this.receipts.values()].some(r=>!r.settled))throw new Error('原输出设置请求尚未结束');
  const next=validateAudioOutputPreference(value);this.preference=next;this.unknown=null;this.receipts.clear();this.audio.applyOutputPreference(this.preference);
 }
 async initialize():Promise<void>{this.preference=validateAudioOutputPreference(await this.store.load());this.audio.applyOutputPreference(this.preference);}
 snapshot():AudioOutputView{return {preference:{...this.preference},pendingCommandId:this.unknown?.commandId??null,pendingRequest:this.unknown?{...this.unknown}:null};}
 private result(status:AudioOutputResult['status'],error=''):AudioOutputResult{return {status,preference:{...this.preference},playback:this.audio.snapshot(),error};}
 private changed():void{try{this.publish(this.snapshot());}catch{/* Persistence has already committed. */}}
 configure(value:unknown,live=false):Promise<AudioOutputResult>{
  const r=validateAudioOutputRequest(value),identity=JSON.stringify([live?'volume':'output',r]),prior=this.receipts.get(r.commandId);
  if(prior){if(prior.identity!==identity)throw new Error('输出设置操作 ID 已用于其他内容');return prior.promise;}
  if(this.unknown&&JSON.stringify(this.unknown)!==JSON.stringify(r))return Promise.resolve(this.result('rejected','上次输出设置保存结果尚未确认，请先核对原操作或重启应用'));
  if(this.receipts.size>=512){for(const [id,entry] of this.receipts)if(entry.settled){this.receipts.delete(id);break;}if(this.receipts.size>=512)throw new Error('输出设置操作过多，请稍后重试');}
  const entry={identity,promise:this.execute(r,live),settled:false};this.receipts.set(r.commandId,entry);
  void entry.promise.then(result=>{entry.settled=true;if(result.status==='unknown')this.receipts.delete(r.commandId);},()=>{entry.settled=true;});return entry.promise;
 }
 setVolume(value:unknown):Promise<AudioOutputResult>{return this.configure(value,true);}
 private async execute(r:AudioOutputRequest,live:boolean):Promise<AudioOutputResult>{
  let committed=false;
  try{
   const old=await this.store.receipt(r);
   if(this.unknown&&JSON.stringify(this.unknown)!==JSON.stringify(r))return this.result('rejected','上次输出设置保存结果尚未确认，请先核对原操作');
   if(old){
    if(this.unknown){this.preference=validateAudioOutputPreference(await this.store.load());this.audio.applyOutputPreference(this.preference);this.audio.blockOutput(null);this.unknown=null;this.changed();}
    return this.result('saved','已核对保存回执；不会重复切换设备或自动恢复播放。');
   }
   if(this.unknown){this.preference=validateAudioOutputPreference(await this.store.load());this.audio.applyOutputPreference(this.preference);this.audio.blockOutput(null);this.unknown=null;this.changed();return this.result('rejected','已确认上次操作没有保存，可重新选择并提交。');}
   if(r.baseRevision!==this.preference.revision)throw new Error('输出设置已变化，请重新读取');
   if(live)return this.executeVolume(r);
   const catalog=await this.devices.list(),selected=r.deviceId===null?null:catalog.devices.find(device=>device.id===r.deviceId);
   if(r.deviceId!==null&&!selected)throw new Error('所选输出设备当前不可用，请刷新设备列表');
   await this.coordinator.configureBackendOutput('wasapi',async()=>{
    if(this.unknown)throw new Error('上次输出设置保存结果尚未确认，请先核对原操作');if(!this.devices.isCurrent(catalog))throw new Error('设备列表已变化，请重新读取后再切换');
    if(r.baseRevision!==this.preference.revision)throw new Error('输出设置已变化，请重新读取');
    let saved:AudioOutputPreference;
    try{saved=await this.store.save(r,selected?.name??null);}
    catch(error){
     let receipt:AudioOutputPreference|null;
     try{receipt=await this.store.receipt(r);}catch{this.unknown=r;this.audio.blockOutput('输出设置保存结果尚未确认，已阻止播放。请核对原操作或重启应用。');this.changed();throw new Error('输出设置保存结果尚未确认，播放保持停止。');}
     if(!receipt)throw error;saved=receipt;
    }
    try{saved=validateAudioOutputPreference(saved);if(saved.revision!==r.baseRevision+1||saved.deviceId!==r.deviceId||saved.mode!==r.mode||saved.dsdPolicy!==r.dsdPolicy||JSON.stringify(saved.processing)!==JSON.stringify(r.processing))throw new Error();}
    catch{this.unknown=r;this.audio.blockOutput('保存的输出设置尚未确认，请核对原操作或重启应用。');this.changed();throw new Error('保存的输出设置回读无效，播放保持停止。');}
    this.preference=saved;committed=true;this.audio.applyOutputPreference(this.preference);this.changed();
   },async()=>{if(this.unknown)throw new Error('上次输出设置保存结果尚未确认，请先核对原操作');if(!this.devices.isCurrent(catalog))throw new Error('设备列表已变化，请重新读取后再切换');if(r.baseRevision!==this.preference.revision)throw new Error('输出设置已变化，请重新读取');});
   return this.result('saved');
  }catch(error){return this.result(this.unknown?.commandId===r.commandId?'unknown':committed?'saved':'rejected',`${committed?'设置已保存，恢复播放未完成：':''}${error instanceof Error?error.message:String(error)}`);}
 }
 private checkVolume(r:AudioOutputRequest):void{
  const p=this.preference;
  if(this.unknown)throw new Error('上次设置保存尚未确认，请先核对原操作');
  if(r.baseRevision!==p.revision||r.deviceId!==p.deviceId||r.mode!==p.mode||r.dsdPolicy!==p.dsdPolicy||JSON.stringify({...p.processing,volumeDb:r.processing.volumeDb,muted:r.processing.muted})!==JSON.stringify(r.processing))throw new Error('实时音量只能修改当前设置的音量和静音，请重新读取');
  if(p.mode==='exclusive')throw new Error('原始格式独占模式禁用软件音量；请在输出设置选择允许转换模式');
 }
 private async executeVolume(r:AudioOutputRequest):Promise<AudioOutputResult>{
  let committed=false;
  try{
   this.checkVolume(r);
   await this.coordinator.configureVolume(async(token,reopening)=>{
    this.checkVolume(r);let saved:AudioOutputPreference;
    try{saved=await this.store.save(r,this.preference.deviceName);}
    catch(error){
     let receipt:AudioOutputPreference|null;
     try{receipt=await this.store.receipt(r);}catch{this.unknown=r;this.audio.blockOutput('音量设置保存尚未确认，请核对原操作。');this.changed();await this.audio.release();throw new Error('音量保存结果尚未确认，播放已停止。');}
     if(!receipt)throw error;saved=receipt;
    }
    try{saved=validateAudioOutputPreference(saved);if(saved.revision!==r.baseRevision+1||saved.deviceId!==r.deviceId||saved.mode!==r.mode||saved.dsdPolicy!==r.dsdPolicy||JSON.stringify(saved.processing)!==JSON.stringify(r.processing))throw new Error();}
    catch{this.unknown=r;this.audio.blockOutput('音量设置回读无效，请核对原操作。');this.changed();await this.audio.release();throw new Error('音量保存回读无效，播放已停止。');}
    this.preference=saved;committed=true;this.changed();
    if(reopening)this.audio.applyOutputPreference(saved);else await this.audio.applyLiveVolume(saved,token);
   },()=>{this.checkVolume(r);return this.audio.volumeNeedsReopen({...this.preference,processing:{...r.processing}});});
   return this.result('saved');
  }catch(error){return this.result(this.unknown?.commandId===r.commandId?'unknown':committed?'saved':'rejected',`${committed?'音量已保存，本次会话调整未完成：':''}${error instanceof Error?error.message:String(error)}`);}
 }
}
