import {defaultAsioOutput,sameAsioDriver,validateAsioOutputRequest,validateAsioOutputPreference,validateAsioSelection,type AsioOutputRequest,type AsioOutputPreference,type AsioDriverIdentity,type AsioOutputView,type AsioOutputResult} from '../shared/asio-output.js';
import type {AsioDrivers} from './asio-drivers.js';
import type {AudioController} from './audio.js';
import type {PlaybackCoordinator} from './playback.js';
import {processingEnabled} from '../shared/audio-processing.js';
type Store={load:()=>Promise<AsioOutputPreference>;save:(request:AsioOutputRequest,driver:AsioDriverIdentity|null)=>Promise<AsioOutputPreference>;receipt:(request:AsioOutputRequest)=>Promise<AsioOutputPreference|null>};
export class AsioOutputManager {
 private preference=defaultAsioOutput();private unknown:AsioOutputRequest|null=null;
 private receipts=new Map<string,{identity:string;promise:Promise<AsioOutputResult>;settled:boolean}>();
 private serial:Promise<unknown>=Promise.resolve();
 constructor(private readonly drivers:AsioDrivers,private readonly store:Store,private readonly publish:(view:AsioOutputView)=>void,private readonly audio:AudioController,private readonly coordinator:PlaybackCoordinator){}
 prepareRestoreState(owner:string,value:unknown):void{
  this.coordinator.assertRestoreFrozen(owner);if([...this.receipts.values()].some(r=>!r.settled))throw new Error('原输出设置请求尚未结束');
  const next=validateAsioOutputPreference(value);this.preference=next;this.unknown=null;this.receipts.clear();this.audio.applyAsioPreference(this.preference);
 }
 async initialize():Promise<void>{this.preference=validateAsioOutputPreference(await this.store.load());this.audio.applyAsioPreference(this.preference);}
 snapshot():AsioOutputView{return {preference:structuredClone(this.preference),pendingRequest:this.unknown?structuredClone(this.unknown):null,playbackIntegration:'pcm'};}
 private changed():void{try{this.publish(this.snapshot());}catch{/* Committed preferences remain authoritative. */}}
 private result(status:AsioOutputResult['status'],error=''):AsioOutputResult{return {status,view:this.snapshot(),error};}
 configure(value:unknown):Promise<AsioOutputResult>{
  const r=validateAsioOutputRequest(value),identity=JSON.stringify(r),prior=this.receipts.get(r.commandId);
  if(prior){if(prior.identity!==identity)throw new Error('ASIO 操作 ID 已用于其他内容');return prior.promise;}
  if(this.receipts.size>=128){for(const [id,entry] of this.receipts)if(entry.settled){this.receipts.delete(id);break;}if(this.receipts.size>=128)throw new Error('ASIO 配置操作过多，请稍后重试');}
  const promise=this.serial.then(()=>this.execute(r));this.serial=promise.then(()=>{},()=>{});
  const entry={identity,promise,settled:false};this.receipts.set(r.commandId,entry);
  void promise.then(result=>{entry.settled=true;if(result.status==='unknown')this.receipts.delete(r.commandId);},()=>{entry.settled=true;});return promise;
 }
 private async execute(r:AsioOutputRequest):Promise<AsioOutputResult>{
  let committed=false;
  try{
   if(this.unknown&&JSON.stringify(this.unknown)!==JSON.stringify(r))throw new Error('上次 ASIO 保存结果尚未确认，请先核对原操作');
   const old=await this.store.receipt(r);
   if(old&&!this.unknown)return this.result('saved','已核对原操作，不重复切换输出。');
   if(old||this.unknown){
    await this.coordinator.inspectStoppedOutput(async()=>{const p=validateAsioOutputPreference(await this.store.load());this.audio.applyAsioPreference(p);this.preference=p;this.unknown=null;this.changed();});
    return this.result(old?'saved':'rejected',old?'已核对保存回执，请手动继续播放。':'原操作没有保存，可以重新提交。');
   }
   const prepare=async()=>{
    if(r.baseRevision!==this.preference.revision||this.unknown)throw new Error('ASIO 配置已变化，请重新读取');
    const active=this.audio.backendSnapshot();if(active.backend==='asio'&&!r.allowConversion&&(processingEnabled(active.asioProcessing)||active.asioDsdPolicy==='pcm'))throw new Error('当前 ASIO 数字处理或 DSD 策略需要保留精度转换授权');
    if(r.driver){const catalog=await this.drivers.list();if(catalog.registryStatus!==0||!catalog.drivers.some(d=>sameAsioDriver(d,r.driver)))throw new Error('ASIO 驱动身份未发现或发生变化');validateAsioSelection(r,this.drivers.observed(r.driver));}
   };
   await this.coordinator.configureBackendOutput('asio',async()=>{
    await prepare();const catalog=r.driver?await this.drivers.list():null,driver=r.driver?catalog!.drivers.find(d=>sameAsioDriver(d,r.driver))??null:null;
    if(r.driver&&!driver)throw new Error('ASIO 驱动目录已变化，请重新选择');
    let saved:AsioOutputPreference;
    try{saved=await this.store.save(r,driver);}catch(error){
     let receipt:AsioOutputPreference|null;
     try{receipt=await this.store.receipt(r);}catch{this.unknown=r;this.changed();throw new Error('ASIO 保存结果尚未确认，请核对原操作');}
     if(!receipt)throw error;saved=receipt;
    }
    try{saved=validateAsioOutputPreference(saved);if(saved.revision!==r.baseRevision+1||!sameAsioDriver(saved.driver,r.driver)||saved.bufferFrames!==r.bufferFrames||saved.allowConversion!==r.allowConversion||JSON.stringify(saved.outputChannels)!==JSON.stringify(r.outputChannels))throw new Error('ASIO 保存回读无效');}
    catch(error){this.unknown=r;this.changed();throw error;}
    this.preference=saved;committed=true;this.audio.applyAsioPreference(saved);this.changed();
   },prepare);
   return this.result('saved','ASIO 配置已保存。');
  }catch(error){return this.result(this.unknown?.commandId===r.commandId?'unknown':committed?'saved':'rejected',`${committed?'配置已保存，恢复播放未完成：':''}${error instanceof Error?error.message:String(error)}`);}
 }
}
