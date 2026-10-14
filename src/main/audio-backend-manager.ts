import {defaultAudioBackend,readAudioBackendPreference,readAudioBackendRequest,matchesAudioBackendRequest,type AudioBackendPreference,type AudioBackendRequest,type AudioBackendView,type AudioBackendResult} from '../shared/audio-backend.js';
import {processingEnabled} from '../shared/audio-processing.js';
import {sameAsioDriver} from '../shared/asio-output.js';
import type {AudioController} from './audio.js';
import type {PlaybackCoordinator} from './playback.js';
import type {AsioDrivers} from './asio-drivers.js';
import type {AsioOutputManager} from './asio-output-manager.js';
type Store={load:()=>Promise<AudioBackendPreference>;save:(r:AudioBackendRequest)=>Promise<AudioBackendPreference>;receipt:(r:AudioBackendRequest)=>Promise<AudioBackendPreference|null>};
export class AudioBackendManager {
 private preference=defaultAudioBackend();private unknown:AudioBackendRequest|null=null;
 private receipts=new Map<string,{identity:string;promise:Promise<AudioBackendResult>;settled:boolean}>();
 private serial:Promise<unknown>=Promise.resolve();
 constructor(private readonly audio:AudioController,private readonly coordinator:PlaybackCoordinator,private readonly asio:AsioOutputManager,private readonly drivers:AsioDrivers,private readonly store:Store,private readonly publish:(view:AudioBackendView)=>void){}
 prepareRestoreState(owner:string,value:unknown):void{
  this.coordinator.assertRestoreFrozen(owner);if([...this.receipts.values()].some(r=>!r.settled))throw new Error('原输出设置请求尚未结束');
  const next=readAudioBackendPreference(value);this.preference=next;this.unknown=null;this.receipts.clear();this.apply();
 }
 async initialize():Promise<void>{this.preference=readAudioBackendPreference(await this.store.load());this.apply();}
 snapshot():AudioBackendView{return {preference:structuredClone(this.preference),pendingRequest:this.unknown?structuredClone(this.unknown):null};}
 assertKnown():void{if(this.unknown)throw new Error('音频后端保存结果尚未确认，请先核对原操作');if(this.preference.backend==='asio'&&this.asio.snapshot().pendingRequest)throw new Error('ASIO 配置保存结果尚未确认，请先核对原操作');}
 private apply():void{this.audio.applyBackendPreference(this.preference);this.audio.applyAsioPreference(this.asio.snapshot().preference);}
 private changed():void{try{this.publish(this.snapshot());}catch{/* Persistence is already authoritative. */}}
 private result(status:AudioBackendResult['status'],error=''):AudioBackendResult{return {status,view:this.snapshot(),error};}
 private async validate(r:AudioBackendRequest):Promise<void>{
  this.assertKnown();if(r.baseRevision!==this.preference.revision)throw new Error('音频后端设置已变化，请重新读取');
  if(r.backend==='asio'){
   this.audio.assertAsioProcessingAllowed(r.asioProcessing);
   const p=this.asio.snapshot().preference;if(!p.driver)throw new Error('请先保存 ASIO 驱动、输出声道和缓冲配置');
   if(!p.allowConversion&&(processingEnabled(r.asioProcessing)||r.asioDsdPolicy==='pcm'))throw new Error('ASIO 数字处理或 DSD 转 PCM 需要明确允许 PCM 精度转换');
   const catalog=await this.drivers.list();if(catalog.registryStatus!==0||!catalog.drivers.some(d=>sameAsioDriver(d,p.driver)))throw new Error('已保存的 ASIO 驱动未发现，请重新选择');
  }
 }
 configure(value:unknown,volume=false):Promise<AudioBackendResult>{
  const r=readAudioBackendRequest(value),identity=JSON.stringify([volume?'volume':'backend',r]),old=this.receipts.get(r.commandId);if(old){if(old.identity!==identity)throw new Error('音频后端操作 ID 已用于其他内容');return old.promise;}
  if(this.receipts.size>=128){for(const [id,e] of this.receipts)if(e.settled){this.receipts.delete(id);break;}if(this.receipts.size>=128)throw new Error('音频后端操作过多，请稍后重试');}
  const promise=this.serial.then(()=>this.execute(r,volume));this.serial=promise.then(()=>{},()=>{});const entry={identity,promise,settled:false};this.receipts.set(r.commandId,entry);void promise.then(result=>{entry.settled=true;if(result.status==='unknown')this.receipts.delete(r.commandId);},()=>{entry.settled=true;});return promise;
 }
 setVolume(value:unknown):Promise<AudioBackendResult>{return this.configure(value,true);}
 private checkVolume(r:AudioBackendRequest):void{
  this.assertKnown();const p=this.preference;
  if(r.baseRevision!==p.revision||p.backend!=='asio'||r.backend!=='asio'||r.asioDsdPolicy!==p.asioDsdPolicy||JSON.stringify({...p.asioProcessing,volumeDb:r.asioProcessing.volumeDb,muted:r.asioProcessing.muted})!==JSON.stringify(r.asioProcessing))throw new Error('ASIO 音量设置已变化，请重新读取');
 }
 private async persist(r:AudioBackendRequest):Promise<AudioBackendPreference>{
  let saved:AudioBackendPreference;
  try{saved=await this.store.save(r);}catch(error){let receipt:AudioBackendPreference|null;try{receipt=await this.store.receipt(r);}catch{this.unknown=r;this.changed();throw new Error('音频后端保存结果尚未确认，请核对原操作');}if(!receipt)throw error;saved=receipt;}
  try{saved=readAudioBackendPreference(saved);if(!matchesAudioBackendRequest(saved,r))throw new Error('音频后端保存回读无效');}catch(error){this.unknown=r;this.changed();throw error;}return saved;
 }
 private async execute(r:AudioBackendRequest,volume:boolean):Promise<AudioBackendResult>{
  let committed=false;
  try{
   if(this.unknown&&JSON.stringify(this.unknown)!==JSON.stringify(r))throw new Error('上次音频后端保存结果尚未确认，请先核对原操作');
   const old=await this.store.receipt(r);
   if(old&&!this.unknown)return this.result('saved','已核对原操作，不重复切换输出。');
   if(old||this.unknown){
    await this.coordinator.inspectStoppedOutput(async()=>{this.preference=readAudioBackendPreference(await this.store.load());this.unknown=null;this.apply();this.changed();});
    return this.result(old?'saved':'rejected',old?'已核对原操作，请手动继续播放。':'已确认原操作没有保存，可以重新提交。');
   }
   if(volume){
    this.checkVolume(r);
    await this.coordinator.configureVolume(async(token,reopening)=>{this.checkVolume(r);this.preference=await this.persist(r);committed=true;this.changed();if(reopening)this.apply();else await this.audio.applyAsioLiveVolume(this.preference,token);},()=>{this.checkVolume(r);return this.audio.asioVolumeNeedsReopen({...this.preference,asioProcessing:r.asioProcessing});});
    return this.result('saved');
   }
   await this.coordinator.configureOutput(async()=>{
    await this.validate(r);this.preference=await this.persist(r);committed=true;this.apply();this.changed();
   },()=>this.validate(r));
   return this.result('saved');
  }catch(error){if(volume&&this.unknown){try{await this.audio.release();}catch{/* New playback remains blocked by the unresolved preference. */}}return this.result(this.unknown?.commandId===r.commandId?'unknown':committed?'saved':'rejected',`${committed?'设置已保存，恢复播放未完成：':''}${error instanceof Error?error.message:String(error)}`);}
 }
}
