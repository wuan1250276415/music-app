import {readDecoderContainer} from '../shared/media-capabilities.js';
import {adjacentCueItems,samplePlayRange,resolveSamplePlayRange,type SamplePlayRange} from '../shared/source-sample-range.js';
import {AsioPlaybackTracker,asAsioCounter,type AsioFrameBookmark,type AsioRebuildRequest} from './asio-playback-state.js';
import {AsioDsdPlaybackTracker,buildDsdRequest} from './asio-dsd-playback-state.js';
import {DsdAnalysisCopy} from './dsd-analysis.js';
import {asioSessionConfiguration} from '../shared/asio-playback.js';
import {defaultAsioOutput,validateAsioOutputPreference,type AsioOutputPreference} from '../shared/asio-output.js';
import {defaultAudioBackend,readAudioBackendPreference,type AudioBackendPreference} from '../shared/audio-backend.js';
import {defaultDsdOutput,readDsdOutputPreference,selectedDopAuthorization,dsdOutputAffectsPlayback,type DsdOutputPreference} from '../shared/dsd-output.js';
import {requireFileObservation} from '../platform/file-observation.js';
import {defaultProcessing,processingEnabled,processingPlan,readProcessingPlan,validateReplayGain,validateOpusGain} from '../shared/audio-processing.js';
import {readPlaybackClock} from '../shared/playback-clock.js';
import {readPlaybackTail} from '../shared/playback-tail.js';
import {readPlaybackFile} from '../shared/playback-file.js';
import {readSourceEvidence} from '../shared/decoder-source.js';
import {readPipeline} from '../shared/pipeline-plan.js';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync,promises as fs } from 'node:fs';
import net, { type Socket } from 'node:net';
import path from 'node:path';
import { encodeFrame, FrameReader, type AudioMessage } from './audio-protocol.js';
import type { AudioAnalysisFrame, LibraryItem, PlaybackState } from '../shared/contracts.js';
import { RELEASE } from '../shared/release.js';
import {validateAudioOutputPreference,validEndpoint} from '../shared/audio-output.js';
import {validDsdPcmConversion} from '../shared/dsd-pcm.js';

import type {PlaybackHistoryBinding,HistoryObservation} from './playback-history.js';

type Session={
  history?:PlaybackHistoryBinding;
  id:string;nonce:string;pipe:string;process:ChildProcessWithoutNullStreams;socket:Socket|null;
  generation:number;sequence:bigint;ready:boolean;
  asio:AsioPlaybackTracker|null;backendRevision:number;rebuilding:boolean;pauseCommand:string|null;
  asioDsd:AsioDsdPlaybackTracker|null;dsdPlayCommand:string|null;
  nativeExit:Promise<number|null>|null;
  pending:Map<string,{commandId:string;resolve:(value:AudioMessage)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>;
  snapshots:Map<string,{resolve:(state:'playing'|'paused')=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>;
  seeks:Map<string,{resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>;
  pcmTransitions:Map<string,{state:'playing'|'paused';resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>;
  pcmTransition:Promise<void>|null;
  volumeRevision:number;volumes:Map<string,{volumeDb:number;muted:boolean;revision:number;resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>;
  cuePair:{nextItem:LibraryItem;firstEndCueFrame:number|null;segmentIndex:0|1;
    boundaryOffsetSeconds:number;boundaryPcmFrame:string|null}|null;
  boundaryWaiters:Array<{resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>;
  timedOut:Set<string>;
  hello:{resolve:(value:AudioMessage)=>void;reject:(error:Error)=>void}|null;
  analysisStarted:boolean;
  clockRequired:boolean;
  tailRequired:boolean;tailTimer:NodeJS.Timeout|null;livenessTimer:NodeJS.Timeout|null;
  processingRequired:boolean;processingOpus:import('../shared/contracts.js').OpusGainInfo|null;processingSeeds:{settings:import('../shared/contracts.js').AudioProcessing;tags:import('../shared/contracts.js').ReplayGainTags|null;nextTags:import('../shared/contracts.js').ReplayGainTags|null};
  replayGainStamp:string|null;
  preflightRequired:boolean;preflightPhase:'awaiting-plan'|'start-sent'|'started';initialPaused:boolean;initialPositionUs:number;
  pipelineRequired:boolean;rangeSpec:{startCue:number|null;endCue:number|null;startSeconds:number;endSeconds:number|null;nextEndCue:number|null;samples?:SamplePlayRange};
  started:{resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null;
};

export class AudioController {
  private session:Session|null=null;
  private systemSleeping=false;
  private retired=new Set<Promise<boolean>>();
  private operation=0;
  private queuedSeek:{position:number;itemId:string|null;waiters:Array<{resolve:(state:PlaybackState)=>void;reject:(error:Error)=>void}>}|null=null;
  private seekRunning=false;
  private state:PlaybackState={state:'idle',itemId:null,positionSeconds:0,durationSeconds:null,output:'未连接'};
  private backendPreference=defaultAudioBackend();
  private asioPreference=defaultAsioOutput();
  private dsdOutputPreference=defaultDsdOutput();
  private asioRebuilder:((request:AsioRebuildRequest)=>Promise<PlaybackState>)|null=null;
  private reconfigureTimes:number[]=[];
  prepareRestoreState():void{
    if(!this.outputIsReleased()||this.queuedSeek||this.seekRunning||!['idle','error'].includes(this.state.state))throw new Error('恢复前音频输出或定位尚未释放');
    this.operation++;this.outputBlocked=null;this.reconfigureTimes=[];this.latestAnalysis=null;this.analysisWanted=false;
    this.state={state:'idle',itemId:null,positionSeconds:0,durationSeconds:null,output:'未连接'};
  }
  backendSnapshot():AudioBackendPreference{return structuredClone(this.backendPreference);}
  dsdOutputSnapshot():DsdOutputPreference{return structuredClone(this.dsdOutputPreference);}
  applyDsdOutputPreference(value:DsdOutputPreference):void{const p=readDsdOutputPreference(value);if(this.session?.asioDsd&&dsdOutputAffectsPlayback(this.dsdOutputPreference,p))throw new Error('请先释放原始 DSD 会话再应用输出预设');this.dsdOutputPreference=p;}
  private selectedDsdMode():'stop'|'pcm'|'native-dsd'|'dop'{return this.dsdOutputPreference.mode==='inherit'?this.backendPreference.asioDsdPolicy:this.dsdOutputPreference.mode;}
  rawDsdSelected(item:LibraryItem):boolean{return this.backendPreference.backend==='asio'&&['.dsf','.dff'].includes(path.extname(item.path).toLowerCase())&&['native-dsd','dop'].includes(this.selectedDsdMode());}
  dsdPreferenceAffectsPlayback(next:DsdOutputPreference):boolean {
    if(!dsdOutputAffectsPlayback(this.dsdOutputPreference,next))return false;
    return Boolean(this.session?.asioDsd||this.session?.asio?.prepared?.decodedSource.dsdConversion);
  }
  assertAsioProcessingAllowed(settings:import('../shared/contracts.js').AudioProcessing):void{if(this.session?.asioDsd&&processingEnabled(settings))throw new Error('正在播放原始 DSD，请先明确切换转 PCM 或停止，再启用软件音量、静音或 ReplayGain');}
  applyBackendPreference(value:AudioBackendPreference):void{if(!['idle','error'].includes(this.state.state)||!this.outputIsReleased())throw new Error('音频输出尚未释放，不能切换后端');this.backendPreference=readAudioBackendPreference(value);}
  applyAsioPreference(value:AsioOutputPreference):void{if(this.session?.asio||this.session?.asioDsd)throw new Error('请先释放 ASIO 会话，再应用驱动配置');this.asioPreference=validateAsioOutputPreference(value);}
  setAsioRebuilder(rebuilder:(request:AsioRebuildRequest)=>Promise<PlaybackState>):void{this.asioRebuilder=rebuilder;}
  frameBookmark():AsioFrameBookmark|undefined{
    const raw=this.session?.asioDsd;
    if(raw?.prepared&&raw.latestClock&&['playing','paused'].includes(this.state.state)){
      const limit=BigInt(raw.prepared.dsdPlan.range.endTick)-BigInt(raw.prepared.dsdPlan.range.startTick),source=BigInt(raw.latestClock.sourceTick);
      return raw.bookmark(String(source>=limit?limit-1n:source),this.session!.backendRevision);
    }
    const session=this.session,tracker=session?.asio,p=tracker?.prepared,clock=tracker?.latestClock;
    if(!session||!tracker||!p||!clock||!['playing','paused'].includes(this.state.state))return;
    const origin=tracker.span?.segmentIndex===1?BigInt(tracker.span.boundaryFrame!)-BigInt(tracker.span.startFrame):0n;if(BigInt(clock.sourceFrame)<origin)return;
    let source=BigInt(clock.sourceFrame);const end=tracker.latestTail?BigInt(tracker.latestTail.sourceFrame):tracker.span!.endFrame===null?null:BigInt(tracker.span!.endFrame)-BigInt(tracker.span!.startFrame);
    if(end!==null&&source>=end)source=end-1n;if(source<origin)return;
    return {frame:String(source-origin),sampleRate:p.actualOutput.sampleRate,fileBinding:p.decodedSource.fileBinding!,configurationRevision:tracker.context.preference.revision,backendRevision:session.backendRevision};
  }
  refreshFrameBookmark(bookmark:AsioFrameBookmark|undefined):AsioFrameBookmark|undefined{
    if(!bookmark||this.backendPreference.backend!=='asio')return;
    if(bookmark.dsd){const mode=this.selectedDsdMode();if(mode!=='native-dsd'&&mode!=='dop')return;
      return {...bookmark,configurationRevision:this.asioPreference.revision,backendRevision:this.backendPreference.revision,dsd:{...bookmark.dsd,settingRevision:this.dsdOutputPreference.revision,transport:mode,authorization:mode==='dop'?selectedDopAuthorization(this.dsdOutputPreference):null}};}
    return {...bookmark,configurationRevision:this.asioPreference.revision,backendRevision:this.backendPreference.revision};
  }
  private mode:'shared'|'exclusive'|'exclusive-convert'='shared';
  private dsdPolicy:'stop'|'pcm'='stop';
  private processing=defaultProcessing();
  private deviceId:string|null=null;
  private outputBlocked:string|null=null;
  private analysisWanted=false;
  private analysisRevision=0;
  private analysisCommand:Promise<void>|null=null;
  private latestAnalysis:AudioAnalysisFrame|null=null;
  private readonly dsdAnalysis:DsdAnalysisCopy;
  private externalOutputGuard:()=>void=()=>{};
  constructor(private readonly nativeExecutable:string,private readonly publishState:(state:PlaybackState,reason?:string)=>void,
    private readonly commandTimeoutMs=5000){
    this.dsdAnalysis=new DsdAnalysisCopy(path.join(path.dirname(nativeExecutable),'dsd-analysis-worker.exe'),frame=>{
      if(frame&&(!this.analysisWanted||this.state.state!=='playing'||this.session?.id!==frame.sessionId||this.session.generation!==frame.generation||this.state.itemId!==frame.itemId))return;
      this.latestAnalysis=frame;
    });
  }
  private historyObserver:(value:HistoryObservation|null)=>void=()=>{};
  setHistoryObserver(observer:(value:HistoryObservation|null)=>void):void{this.historyObserver=observer;}
  private publish(state:PlaybackState,reason?:string):void{
    // History must never interrupt audio control or presentation.
    try{this.historyObserver(this.historyObservation());}catch{/* Recorder reports its own persistence errors. */}
    this.publishState(state,reason);
  }
  private historyObservation(session=this.session):HistoryObservation|null{
    if(!session?.history||session.preflightPhase!=='started'||this.state.state==='preparing'||this.state.state==='error')return null;
    let frame:string|undefined,rate=0,evidence:HistoryObservation['evidence']='bookmark',boundary:bigint|null=null;
    const dsd=session.asioDsd,asio=session.asio;
    if(dsd){
      const clock=dsd.latestClock;if(!clock)return null;frame=clock.sourceTick;rate=clock.bitRate;
      evidence=clock.authority==='driver-reported'?'reported':clock.authority==='paused-bookmark'?'bookmark':'estimated';
      if(dsd.latestTail?.status==='completed'&&dsd.latestTail.evidence==='driver-clock'){frame=dsd.latestTail.sourceTick;evidence='reported';}
    }else if(asio){
      const clock=asio.latestClock;if(!clock)return null;frame=clock.sourceFrame;rate=clock.sourceSampleRate;
      evidence=clock.authority==='driver-reported'?'reported':clock.authority==='paused-bookmark'?'bookmark':'estimated';
      if(asio.latestTail?.status==='completed'&&asio.latestTail.evidence==='driver-clock'){frame=asio.latestTail.sourceFrame;evidence='reported';}
      if(session.cuePair&&asio.span?.boundaryFrame!==null&&asio.span?.boundaryFrame!==undefined)boundary=BigInt(asio.span.boundaryFrame)-BigInt(asio.span.startFrame);
    }else{
      const clock=this.state.clock;if(!clock||clock.generation!==session.generation)return null;frame=clock.sourceFrame;rate=clock.sourceSampleRate;
      evidence=clock.authority==='device-reported'?'reported':clock.authority==='paused-bookmark'?'bookmark':'estimated';
      if(this.state.tail?.status==='completed'&&this.state.tail.evidence==='device-clock'){frame=this.state.tail.sourceFrame;evidence=clock.conversion.resampled?'estimated':'reported';}
      if(session.cuePair?.boundaryPcmFrame&&this.state.pipelinePlan)boundary=BigInt(session.cuePair.boundaryPcmFrame)-BigInt(this.state.pipelinePlan.span.startFrame);
    }
    if(this.state.state==='idle'&&!(dsd?.latestTail?.status==='completed'||asio?.latestTail?.status==='completed'||this.state.tail?.status==='completed'))return null;
    return {binding:session.history,transportId:session.id,generation:session.generation,frame:BigInt(frame),rate,boundaryFrame:boundary,evidence};
  }
  snapshot():PlaybackState{return {...this.state};}
  outputIsReleased():boolean{return this.session===null&&this.retired.size===0&&!this.systemSleeping;}
  setExternalOutputGuard(guard:()=>void):void{this.externalOutputGuard=guard;}
  setSystemSleeping(value:boolean):void{this.systemSleeping=value;}
  markSystemInterruption(before:PlaybackState,token:number,status:'sleeping'|'ready'|'failed',message:string):void{
    this.markPlaybackInterruption(before,token,'system-suspend',status,message,before.interruption?.positionEvidence??'recent-position');
  }
  markPlaybackInterruption(before:PlaybackState,token:number,kind:NonNullable<PlaybackState['interruption']>['kind'],status:NonNullable<PlaybackState['interruption']>['status'],message:string,positionEvidence:NonNullable<PlaybackState['interruption']>['positionEvidence']):void{
    if(token!==this.operation)return;
    this.state={state:'idle',itemId:before.itemId,positionSeconds:before.positionSeconds,durationSeconds:before.durationSeconds,
      output:this.retired.size?'等待旧宿主退出':'设备已释放',message,interruption:{kind,status,positionEvidence,hardwareVerified:false}};
    this.publish(this.snapshot());
  }
  analysisSnapshot():AudioAnalysisFrame|null{
    const value=this.latestAnalysis;
    return this.analysisWanted&&this.state.state==='playing'&&value&&value.itemId===this.state.itemId&&
      value.sessionId===this.session?.id&&value.generation===this.session?.generation&&Date.now()-value.receivedAt>=0&&Date.now()-value.receivedAt<=500?value:null;
  }
  analysisStatus():import('../shared/contracts.js').AudioAnalysisStatus{
    if(this.session?.asioDsd&&this.analysisWanted&&this.state.state==='playing')return this.dsdAnalysis.snapshot();
    const active=this.analysisWanted&&this.state.state==='playing',frame=this.analysisSnapshot();
    return {source:active?'pcm-callback':'none',state:active?frame?'ready':'warming-up':'disabled',message:active?'设备前有效 PCM 分析副本':'分析已关闭或播放暂停',sessionId:this.session?.id??null,generation:this.session?.generation??null,hardwareVerified:false};
  }
  setAnalysisEnabled(enabled:boolean):void{
    if(enabled===this.analysisWanted)return;
    this.analysisWanted=enabled;++this.analysisRevision;this.latestAnalysis=null;this.syncAnalysis();
  }
  private syncAnalysis():void{
    const session=this.session,raw=session?.asioDsd,view=this.state.asioDsd;
    if(raw){
      this.dsdAnalysis.update(this.analysisWanted&&this.state.state==='playing'&&session.ready&&session.preflightPhase==='started'&&raw.prepared&&view&&this.state.itemId?
        {nonce:session.nonce,sessionId:session.id,generation:session.generation,itemId:this.state.itemId,path:raw.request.path,source:raw.prepared.source,range:raw.prepared.dsdPlan.range,positionTick:view.clock.sourceTick,receivedAt:view.receivedAt}:null);return;
    }
    this.dsdAnalysis.update(null);
    if(this.analysisCommand||!session?.ready||!session.analysisStarted)return;
    const revision=this.analysisRevision;
    this.analysisCommand=this.send(session,'analysis.configure',{enabled:this.analysisWanted}).then(()=>{})
      .catch(()=>{if(this.session===session)this.latestAnalysis=null;})
      .finally(()=>{this.analysisCommand=null;if(revision!==this.analysisRevision)this.syncAnalysis();});
  }
  setOutput(mode:'shared'|'exclusive'|'exclusive-convert'):{mode:'shared'|'exclusive'|'exclusive-convert'}{
    if(this.state.state!=='idle'&&this.state.state!=='error')throw new Error('请先停止播放，再切换输出模式');
    this.mode=mode;
    if(this.state.state==='error'){
      this.state={state:'idle',itemId:null,positionSeconds:0,durationSeconds:null,output:'未连接'};
      this.publish(this.snapshot(),'outputChanged');
    }
    return {mode};
  }
  setDsdPolicy(policy:'stop'|'pcm'):{policy:'stop'|'pcm'}{
    if(policy!=='stop'&&policy!=='pcm')throw new Error('无效 DSD 播放策略');
    if(this.state.state!=='idle'&&this.state.state!=='error')throw new Error('请先停止播放，再切换 DSD 策略');
    this.dsdPolicy=policy;return {policy};
  }
  dsdPolicySnapshot():{policy:'stop'|'pcm'}{return {policy:this.dsdPolicy};}

  applyOutputPreference(value:import('../shared/contracts.js').AudioOutputPreference):void{
    const p=validateAudioOutputPreference(value);
    if(this.backendPreference.backend==='asio'){this.mode=p.mode;this.dsdPolicy=p.dsdPolicy;this.deviceId=p.deviceId;this.processing={...p.processing};return;}
    this.setOutput(p.mode);this.setDsdPolicy(p.dsdPolicy);this.deviceId=p.deviceId;this.processing={...p.processing};
  }
  blockOutput(reason:string|null):void{this.outputBlocked=reason;}
  volumeNeedsReopen(value:import('../shared/contracts.js').AudioOutputPreference):boolean{
    if(this.systemSleeping)throw new Error('系统正在休眠，请唤醒后再调整');
    const p=validateAudioOutputPreference(value);
    if(this.state.state==='preparing')throw new Error('正在准备播放，请稍后再调整音量');
    return ['playing','paused'].includes(this.state.state)&&!this.state.tail&&
      (p.processing.volumeDb!==this.processing.volumeDb||p.processing.muted!==this.processing.muted)&&
      (this.state.actualOutput?.format!=='f32'||this.state.actualOutput.applicationIntegerPath);
  }
  async applyLiveVolume(value:import('../shared/contracts.js').AudioOutputPreference,token:number):Promise<void>{
    const p=validateAudioOutputPreference(value);
    if(p.deviceId!==this.deviceId||p.mode!==this.mode||p.dsdPolicy!==this.dsdPolicy||JSON.stringify({...this.processing,volumeDb:p.processing.volumeDb,muted:p.processing.muted})!==JSON.stringify(p.processing))throw new Error('实时音量与当前输出设置冲突');
    const unchanged=p.processing.volumeDb===this.processing.volumeDb&&p.processing.muted===this.processing.muted;
    this.processing={...p.processing};const session=this.session;
    if(token!==this.operation||!session||!['playing','paused'].includes(this.state.state)||this.state.tail)return;
    if(unchanged)return;
    if(this.mode==='exclusive'||this.state.actualOutput?.format!=='f32'||this.state.actualOutput.applicationIntegerPath)throw new Error('当前输出路径不允许实时音量');
    if(session.volumeRevision>=Number.MAX_SAFE_INTEGER)throw new Error('音量修订达到上限，请重新打开播放');
    const commandId=randomUUID();
    const applied=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('实时音量目标回执超时')),this.commandTimeoutMs);
      session.volumes.set(commandId,{volumeDb:p.processing.volumeDb,muted:p.processing.muted,revision:session.volumeRevision+1,resolve,reject,timer});
    });
    try{await Promise.all([this.send(session,'volume.configure',{baseRevision:String(session.volumeRevision),volumeDb:p.processing.volumeDb,muted:p.processing.muted},commandId),applied]);}
    catch(error){if(this.session===session)this.fail(session,error instanceof Error?error:new Error(String(error)));throw error;}
    finally{const waiter=session.volumes.get(commandId);if(waiter){clearTimeout(waiter.timer);session.volumes.delete(commandId);}}
  }
  operationToken():number{return this.operation;}
  asioVolumeNeedsReopen(value:AudioBackendPreference):boolean{
    const p=readAudioBackendPreference(value);this.checkAsioVolume(p);
    return ['playing','paused'].includes(this.state.state)&&!this.state.asio?.tail&&this.state.asio?.output.format!=='f32';
  }
  private checkAsioVolume(p:AudioBackendPreference):void{
    if(this.session?.asioDsd)throw new Error('原始 DSD 使用设备硬件控制音量；请先明确切换 DSD 转 PCM 再启用软件音量');
    if(this.systemSleeping||this.state.state==='preparing')throw new Error('正在准备或休眠，请稍后调整 ASIO 音量');
    const current=this.backendPreference;
    if(current.backend!=='asio'||p.backend!=='asio'||p.asioDsdPolicy!==current.asioDsdPolicy||JSON.stringify({...current.asioProcessing,volumeDb:p.asioProcessing.volumeDb,muted:p.asioProcessing.muted})!==JSON.stringify(p.asioProcessing))throw new Error('ASIO 实时音量只能修改音量和静音');
    if(!this.asioPreference.allowConversion)throw new Error('ASIO 原始精度路径禁用软件音量，请先允许精度转换');
    if(this.state.asio?.tail)throw new Error('ASIO 正在完成歌曲尾部，请稍后调整音量');
  }
  async applyAsioLiveVolume(value:AudioBackendPreference,token:number):Promise<void>{
    const p=readAudioBackendPreference(value);this.checkAsioVolume(p);const unchanged=JSON.stringify(p.asioProcessing)===JSON.stringify(this.backendPreference.asioProcessing);
    this.backendPreference=p;const session=this.session;if(session?.asio)session.backendRevision=p.revision;
    if(token!==this.operation||!session?.asio||!['playing','paused'].includes(this.state.state)||unchanged)return;
    if(this.state.asio?.output.format!=='f32')throw new Error('ASIO 当前源需要重新准备浮点路径');
    if(session.volumeRevision>=Number.MAX_SAFE_INTEGER)throw new Error('ASIO 音量修订达到上限');const commandId=randomUUID();
    const applied=new Promise<void>((resolve,reject)=>{session.volumes.set(commandId,{volumeDb:p.asioProcessing.volumeDb,muted:p.asioProcessing.muted,revision:session.volumeRevision+1,resolve,reject,timer:setTimeout(()=>reject(new Error('ASIO 音量目标回执超时')),this.commandTimeoutMs)});});
    try{await Promise.all([this.send(session,'volume.configure',{baseRevision:String(session.volumeRevision),volumeDb:p.asioProcessing.volumeDb,muted:p.asioProcessing.muted},commandId),applied]);}
    catch(error){if(this.session===session)this.fail(session,error instanceof Error?error:new Error(String(error)));throw error;}
    finally{const waiter=session.volumes.get(commandId);if(waiter){clearTimeout(waiter.timer);session.volumes.delete(commandId);}}
  }
  rememberOutputFailure(before:PlaybackState,message:string):void{this.state={...before,state:'error',message};this.publish(this.snapshot(),'error');}
  async release():Promise<void>{this.stop();await Promise.all([this.waitForRelease(),this.dsdAnalysis.waitForStopped()]);}
  private retire(session:Session,graceful:boolean,naturalExit=false):void{
    this.clearTail(session);
    const child=session.process;
    if(graceful&&session.socket&&!session.socket.destroyed){
      try{
        session.socket.write(encodeFrame({protocol:RELEASE.audioProtocol,kind:'command',sessionId:session.id,
          requestId:randomUUID(),commandId:randomUUID(),expectedGeneration:session.generation,
          timeoutMs:1000,method:'playback.stop',params:{}}));
        session.socket.end();
      }catch{session.socket.destroy();}
    }else session.socket?.destroy();
    if(child.exitCode!==null||child.signalCode!==null)return;
    const release=new Promise<boolean>(resolve=>{
      let settled=false;
      const finish=(exited:boolean)=>{
        if(settled)return;
        settled=true;clearTimeout(killTimer);clearTimeout(deadline);resolve(exited);
      };
      child.once('exit',()=>finish(true));
      child.once('close',()=>finish(true));
      const killTimer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();},graceful||naturalExit?session.asioDsd?2500:800:0);
      const deadline=setTimeout(()=>finish(false),session.asioDsd?5000:2500);
      killTimer.unref();deadline.unref();
    });
    this.retired.add(release);
    void release.then(exited=>{
      if(exited||child.exitCode!==null||child.signalCode!==null)this.retired.delete(release);
      else child.once('close',()=>this.retired.delete(release));
    });
  }

  private async waitForRelease():Promise<void>{
    const results=await Promise.all([...this.retired]);
    if(results.some(exited=>!exited))throw new Error('旧音频宿主未能退出，已阻止启动新播放以避免设备冲突');
  }

  private fail(session:Session,error:Error):void{
    if(this.session!==session)return;
    this.clearTail(session);
    session.hello?.reject(error);session.hello=null;
    if(session.started){clearTimeout(session.started.timer);session.started.reject(error);session.started=null;}
    for(const waiter of session.pending.values()){clearTimeout(waiter.timer);waiter.reject(error);}
    session.pending.clear();
    for(const waiter of session.snapshots.values()){clearTimeout(waiter.timer);waiter.reject(error);}
    session.snapshots.clear();session.timedOut.clear();
    for(const waiter of session.seeks.values()){clearTimeout(waiter.timer);waiter.reject(error);}
    session.seeks.clear();
    for(const waiter of session.pcmTransitions.values()){clearTimeout(waiter.timer);waiter.reject(error);}session.pcmTransitions.clear();
    for(const waiter of session.volumes.values()){clearTimeout(waiter.timer);waiter.reject(error);}session.volumes.clear();
    for(const waiter of session.boundaryWaiters){clearTimeout(waiter.timer);waiter.reject(error);}
    session.boundaryWaiters=[];
    this.dsdAnalysis.update(null);
    this.state={...this.state,state:'error',message:error.message};
    this.latestAnalysis=null;
    this.publish(this.snapshot(),'error');
    this.session=null;
    this.retire(session,false);
  }

  private eventProcessing(session:Session,value:unknown):PlaybackState['processingPlan']{
    if(value===undefined&&!session.processingRequired)return this.state.processingPlan;
    const seeds=session.processingSeeds;
    return readProcessingPlan(value,processingPlan(seeds.settings,session.cuePair?.segmentIndex===1?seeds.nextTags:seeds.tags,session.processingOpus));
  }
  private eventClock(session:Session,payload:Record<string,unknown>):PlaybackState['clock']{
    if(payload.clock===undefined&&!session.clockRequired)return this.state.clock;
    if(typeof payload.position!=='number')throw new Error('播放时钟位置无效');
    const rate=this.state.actualOutput?.sampleRate??this.state.decodedSource?.sampleRate??0;
    const clock=readPlaybackClock(payload.clock,rate,Number(payload.position),session.generation,this.state.actualOutput?.deviceSampleRate??0);
    this.checkPipelineClock(this.state.pipelinePlan,clock);
    return clock;
  }
  private checkPipelineClock(plan:PlaybackState['pipelinePlan'],clock:PlaybackState['clock']):void{
    if(!plan||!clock)return;
    const c=plan.conversion,r=clock.conversion;
    if(c.resampling!==r.resampled||c.inputLatencyFrames!==r.inputLatencyFrames||c.outputLatencyFrames!==r.outputLatencyFrames||r.latencyEvidence!==(c.resampling?'converter-reported-estimate':'frame-preserving'))throw new Error('呈现时钟与固定转换计划冲突');
  }
  private acceptPipeline(session:Session,payload:Record<string,unknown>):void{
    if(payload.pipelinePlan===undefined&&!session.pipelineRequired)return;
    const source=this.state.decodedSource,output=this.state.actualOutput,gain=this.state.processingPlan;
    if(!source||!output||!gain)throw new Error('播放计划缺少来源、处理或输出信息');
    const spec=session.rangeSpec,rate=source.sampleRate;
    const cue=(v:number)=>{if(!Number.isSafeInteger(v)||v<0)throw new Error('CUE 计划时间基无效');const product=BigInt(v)*BigInt(rate);if(product>18446744073709551615n)throw new Error('CUE 计划范围溢出');return String(product/75n);};
    const seconds=(v:number)=>{const result=Math.floor(v*rate);if(!Number.isSafeInteger(result)||result<0)throw new Error('源计划范围无效');return String(result);};
    const startFrame=spec.startCue===null?seconds(spec.startSeconds):cue(spec.startCue);
    const endFrame=session.cuePair?spec.nextEndCue===null?null:cue(spec.nextEndCue):spec.startCue!==null?spec.endCue===null?null:cue(spec.endCue):spec.endSeconds===null?null:seconds(spec.endSeconds);
    const boundaryFrame=session.cuePair&&session.cuePair.firstEndCueFrame!==null?cue(session.cuePair.firstEndCueFrame):null;
    if(endFrame!==null&&BigInt(endFrame)<=BigInt(startFrame)||boundaryFrame!==null&&(BigInt(boundaryFrame)<=BigInt(startFrame)||endFrame!==null&&BigInt(boundaryFrame)>=BigInt(endFrame)))throw new Error('源范围与播放计划不符');
    const span={...(spec.samples?resolveSamplePlayRange(spec.samples,rate):{startFrame,endFrame,boundaryFrame}),segmentIndex:session.cuePair?.segmentIndex??0};
    const plan=readPipeline(payload.pipelinePlan,source,output,gain,span,this.state.pipelinePlan);
    this.checkPipelineClock(plan,this.state.clock);
    this.state={...this.state,pipelinePlan:plan};
  }
  private clearTail(session:Session):void{if(session.tailTimer)clearTimeout(session.tailTimer);session.tailTimer=null;if(session.livenessTimer)clearTimeout(session.livenessTimer);session.livenessTimer=null;}
  private refreshLiveness(session:Session):void{
    if(session.livenessTimer)clearTimeout(session.livenessTimer);session.livenessTimer=null;
    if(session.clockRequired&&(this.state.state==='playing'||this.state.state==='paused'))session.livenessTimer=setTimeout(()=>this.fail(session,new Error('音频宿主长时间未报告播放状态，播放已停止')),10000);
  }
  private eventTail(session:Session,value:unknown):PlaybackState['tail']{
    if(value==null)return undefined;
    const actual=this.state.actualOutput;
    if(!actual)throw new Error('歌曲尾部缺少实际输出格式');
    const tail=readPlaybackTail(value,actual.sampleRate,actual.deviceSampleRate,actual.mode,session.generation);
    const conversion=this.state.clock?.conversion,previous=this.state.tail;
    if(conversion&&BigInt(tail.filterTailInputFrames)!==(actual.sampleRate===actual.deviceSampleRate?0n:BigInt(conversion.inputLatencyFrames)+BigInt(Math.ceil(actual.sampleRate/10))))throw new Error('歌曲尾部预算与实际转换器不一致');
    const rank={flushing:1,draining:2,completed:3};
    if(previous?.generation===session.generation&&(previous.sourceFrame!==tail.sourceFrame||previous.inputEndFrame!==tail.inputEndFrame||rank[tail.status]<rank[previous.status]))throw new Error('歌曲尾部阶段或源范围回退');
    if(tail.status==='completed')this.clearTail(session);
    else if(!session.tailTimer)session.tailTimer=setTimeout(()=>this.fail(session,new Error('歌曲尾部输出确认超时，播放已停止')),35000);
    return tail;
  }
  private onMessage(session:Session,message:AudioMessage):void{
    if(this.session!==session)return;
    const protocol=message.protocol as Record<string,unknown>|undefined;
    if(!protocol||protocol.major!==RELEASE.audioProtocol.major){this.fail(session,new Error('音频协议版本不兼容'));return;}
    if(message.kind==='hello'){
      if(message.sessionId!==session.id||message.nonce!==session.nonce||message.buildId!==RELEASE.hostBuildId||
        typeof message.maxMessageBytes!=='number'||message.maxMessageBytes<RELEASE.audioProtocol.maxMessageBytes||
        !Array.isArray(message.capabilities)||!message.capabilities.includes('cue-frame-bounds')||session.rangeSpec.samples&&!message.capabilities.includes('source-sample-span-v1')||
        !message.capabilities.includes('output-conversion-policy')||
        !message.capabilities.includes('buffer-telemetry')||
        !message.capabilities.includes('analysis-tap-v1')||
        !message.capabilities.includes('dsd-pcm-policy-v1')||
        !message.capabilities.includes('wasapi-endpoint-v1')||
        !message.capabilities.includes('initial-position-v1')||
        !message.capabilities.includes('presentation-clock-v4')||!message.capabilities.includes('tail-completion-v1')||!message.capabilities.includes('gain-processing-v3')||!message.capabilities.includes('opus-gain-v1')||!message.capabilities.includes('live-volume-v1')||!message.capabilities.includes('pcm-pipeline-plan-v2')||!message.capabilities.includes('pcm-preflight-v1')||!message.capabilities.includes('decoder-source-v1')||!message.capabilities.includes('playback-file-binding-v1')||
        (session.cuePair!==null&&!message.capabilities.includes('cue-two-span'))){
        this.fail(session,new Error('音频宿主协议握手不兼容'));return;
      }
      if((session.asio||session.asioDsd)&&protocol.minor!==RELEASE.audioProtocol.minor||session.asio&&!message.capabilities.includes('asio-pcm-session-v1')||session.asioDsd&&!message.capabilities.includes('asio-dsd-session-v1')){this.fail(session,new Error('音频宿主未提供兼容的 ASIO 会话'));return;}
      session.hello?.resolve(message);session.hello=null;session.ready=true;session.clockRequired=true;session.tailRequired=true;session.processingRequired=true;session.pipelineRequired=true;session.preflightRequired=true;return;
    }
    if(message.sessionId!==session.id||!session.ready){this.fail(session,new Error('音频协议会话不匹配'));return;}
    if(message.kind==='receipt'){
      const waiter=session.pending.get(String(message.requestId));
      const commandId=String(message.commandId);
      if(!waiter){
        if(session.timedOut.delete(commandId)&&message.accepted===false)
          this.fail(session,new Error(String(message.error||'超时音频命令被拒绝')));
        return;
      }
      if(commandId!==waiter.commandId||typeof message.accepted!=='boolean'){
        this.fail(session,new Error('音频回执与命令不匹配'));return;
      }
      clearTimeout(waiter.timer);session.pending.delete(String(message.requestId));
      if(message.accepted===true)waiter.resolve(message);
      else waiter.reject(new Error(String(message.error||'音频命令被拒绝')));
      return;
    }
    if(message.kind!=='event'||typeof message.sequence!=='string'||!/^[0-9]+$/.test(message.sequence)||
      BigInt(message.sequence)<=session.sequence||typeof message.generation!=='number'||
      !Number.isSafeInteger(message.generation)||message.generation<0||
      (message.event!=='playback.analysis'&&message.generation<session.generation)){
      this.fail(session,new Error('音频事件序号或代际无效'));return;
    }
    const previousGeneration=session.generation;
    session.sequence=BigInt(message.sequence);
    if(message.event==='playback.analysis'&&message.generation!==session.generation)return;
    session.generation=message.generation;
    const payload=message.payload&&typeof message.payload==='object'?message.payload as Record<string,unknown>:{};
    if(session.asioDsd){this.onAsioDsdEvent(session,message,payload,previousGeneration);return;}
    if(session.asio&&message.event!=='playback.analysis'&&message.event!=='playback.error'){this.onAsioEvent(session,message,payload,previousGeneration);return;}
    switch(message.event){
      case 'playback.analysis':{
        // Analysis is optional; a malformed frame cannot stop valid playback.
        if(!this.analysisWanted||this.state.state!=='playing'||!this.state.itemId)return;
        const channels=payload.channels,rate=payload.sampleRate;
        const vector=(value:unknown,length:number,min:number,max:number):value is number[]=>Array.isArray(value)&&value.length===length&&value.every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max);
        const counter=(value:unknown):number|null=>{if(typeof value!=='string'||!/^\d{1,20}$/.test(value))return null;const number=BigInt(value);return number<=BigInt(Number.MAX_SAFE_INTEGER)?Number(number):null;};
        const dropped=counter(payload.droppedFrames),invalid=counter(payload.invalidSamples);
        if(payload.version!==1||payload.tap!=='callback-pcm-before-device'||payload.windowFrames!==2048||
          typeof channels!=='number'||!Number.isInteger(channels)||channels<1||channels>16||
          typeof rate!=='number'||!Number.isInteger(rate)||rate<1||rate>1536000||
          typeof payload.position!=='number'||!Number.isFinite(payload.position)||payload.position<0||
          payload.cueSegmentIndex!==(session.cuePair?.segmentIndex??0)||
          !vector(payload.peakDb,channels,-96,24)||!vector(payload.rmsDb,channels,-96,24)||!vector(payload.spectrumDb,64,-96,24)||
          !Array.isArray(payload.waveform)||payload.waveform.length!==64||!payload.waveform.every(point=>vector(point,2,-1,1)&&point[0]<=point[1])||
          dropped===null||invalid===null)return;
        const position=Math.max(0,payload.position-(session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0));
        if(Math.abs(position-this.state.positionSeconds)>1)return;
        this.latestAnalysis={version:1,sessionId:session.id,generation:session.generation,itemId:this.state.itemId,receivedAt:Date.now(),
          positionSeconds:position,sampleRate:rate,channels,windowFrames:2048,tap:'callback-pcm-before-device',
          peakDb:payload.peakDb,rmsDb:payload.rmsDb,spectrumDb:payload.spectrumDb,waveform:payload.waveform as Array<[number,number]>,droppedFrames:dropped,invalidSamples:invalid};
        return;
      }
      case 'playback.prepared':
      case 'playback.stateChanged':
        this.latestAnalysis=null;
        if(message.event==='playback.prepared'||payload.state==='playing'||payload.state==='paused'){
          const prepared=message.event==='playback.prepared';
          if(session.preflightRequired){
            if(prepared){
              if(session.preflightPhase!=='awaiting-plan'||this.state.state!=='preparing'||message.generation!==1||Object.keys(payload).length!==13||payload.state!=='preparing'||payload.initialPaused!==session.initialPaused||payload.planToken!==`${session.id}-${session.nonce}-pcm-1`)throw new Error('播放前计划回执或阶段无效');
            }else if(session.preflightPhase==='awaiting-plan')throw new Error('设备在播放前计划核对前已启动');
          }else if(prepared)throw new Error('未协商的播放前计划');
          this.clearTail(session);this.state={...this.state,tail:undefined};
          const source=payload.decodedSource as PlaybackState['decodedSource'];
          if(source&&session.preflightRequired&&Object.keys(source).length!==(Object.hasOwn(source,'container')?11:10))throw new Error('解码来源字段与协议不符');
          if(source!==undefined&&(!source||!['miniaudio','ffmpeg-8.1.3'].includes(source.backend)||typeof source.codec!=='string'||source.codec.length>64||!['f32','s16','s32'].includes(source.format)||!Number.isSafeInteger(source.sampleRate)||source.sampleRate<=0||source.sampleRate>1536000||!Number.isSafeInteger(source.channels)||source.channels<=0||source.channels>16||source.certification!=='pending')){this.fail(session,new Error('解码来源信息无效'));return;}
          if(source&&session.preflightRequired){
            source.media=readSourceEvidence(source.media,source);
            if(source.container!==undefined)source.container=readDecoderContainer(source.container,source);
            source.fileBinding=readPlaybackFile(source.fileBinding,session.replayGainStamp);
          }
          if(source?.dsdConversion!=null&&(!validDsdPcmConversion(source.dsdConversion)||source.backend!=='ffmpeg-8.1.3'||!source.codec.startsWith('dsd_')||source.sampleRate!==176400||source.format!=='f32'||this.dsdPolicy!=='pcm'||this.mode==='exclusive')||source?.codec.startsWith('dsd_')&&!source.dsdConversion){this.fail(session,new Error('DSD 转换来源或播放策略无效'));return;}
          if(session.cuePair&&session.cuePair.boundaryPcmFrame===null){
            const actual=payload.actualOutput as Record<string,unknown>|undefined;
            const rate=actual?.sampleRate;
            const start=payload.sourceStartPcmFrame;
            const boundary=payload.cueBoundaryPcmFrame;
            if(typeof rate!=='number'||!Number.isSafeInteger(rate)||rate<=0||
              typeof start!=='string'||!/^\d+$/.test(start)||
              typeof boundary!=='string'||!/^\d+$/.test(boundary)||BigInt(boundary)<=BigInt(start)){
              this.fail(session,new Error('CUE 连续播放计划回执无效'));return;
            }
            session.cuePair.boundaryPcmFrame=boundary;
            session.cuePair.boundaryOffsetSeconds=Number(BigInt(boundary)-BigInt(start))/rate;
          }
          if(session.started||payload.actualOutput!==undefined){
            const requested=payload.requestedOutput as PlaybackState['requestedOutput'],actual=payload.actualOutput as PlaybackState['actualOutput'];
            const positive=(v:unknown,max:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=max;
            if(!source||!requested||requested.backend!=='wasapi'||requested.deviceId!==this.deviceId||requested.mode!==(this.mode==='shared'?'shared':'exclusive')||requested.allowConversion!==(this.mode!=='exclusive')||requested.dsdPolicy!==this.dsdPolicy||!actual||actual.backend!=='wasapi'||!validEndpoint(actual.deviceId)||!validEndpoint(actual.deviceName)||this.deviceId!==null&&actual.deviceId!==this.deviceId||actual.mode!==requested.mode||typeof actual.allowConversion!=='boolean'||actual.allowConversion!==requested.allowConversion||!['u8','s16','s24','s32','f32'].includes(actual.format)||!['u8','s16','s24','s32','f32'].includes(actual.deviceFormat)||![actual.sampleRate,actual.deviceSampleRate].every(v=>positive(v,1536000))||![actual.channels,actual.deviceChannels].every(v=>positive(v,16))||typeof actual.adapterConversion!=='boolean'||typeof actual.applicationIntegerPath!=='boolean'||actual.hardwareVerified!==false||typeof payload.position!=='number'||!Number.isFinite(payload.position)||payload.position<0){this.fail(session,new Error('输出设备或实际格式回执无效'));return;}
            this.state={...this.state,requestedOutput:{...requested},actualOutput:{backend:actual.backend,deviceId:actual.deviceId,deviceName:actual.deviceName,mode:actual.mode,format:actual.format,deviceFormat:actual.deviceFormat,sampleRate:actual.sampleRate,deviceSampleRate:actual.deviceSampleRate,channels:actual.channels,deviceChannels:actual.deviceChannels,adapterConversion:actual.adapterConversion,allowConversion:actual.allowConversion,applicationIntegerPath:actual.applicationIntegerPath,hardwareVerified:false},positionSeconds:payload.position};
          }
          if(source){
            const opus=source.codec.toLowerCase()==='opus';
            if(opus&&(source.backend!=='ffmpeg-8.1.3'||source.format!=='f32'||source.sampleRate!==48000)||!opus&&source.opusGain!=null)throw new Error('Opus 增益回执与解码来源冲突');
            const context=opus?validateOpusGain(source.opusGain):null;
            if(this.state.decodedSource&&(this.state.decodedSource.codec!==source.codec||JSON.stringify(session.processingOpus)!==JSON.stringify(context)))throw new Error('播放中的 Opus 增益来源发生变化');
            source.opusGain=context;session.processingOpus=context;
          }
          if(prepared){
            const sourceRate=source?.sampleRate??0;
            const expected=Math.floor(session.initialPositionUs/1000000)*sourceRate+Math.floor((session.initialPositionUs%1000000)*sourceRate/1000000);
            if(typeof payload.position!=='number'||Math.abs(payload.position-expected/sourceRate)>0.5/sourceRate)throw new Error('播放前初始位置与命令不符');
          }
          const gainPlan=this.eventProcessing(session,payload.processingPlan);
          if(gainPlan?.enabled&&(this.mode==='exclusive'||this.state.actualOutput?.applicationIntegerPath||this.state.actualOutput?.format!=='f32'))throw new Error('音频处理路径与实际格式冲突');
          const clock=this.eventClock(session,payload);
          this.state={...this.state,state:prepared?'preparing':payload.state as 'playing'|'paused',output:String(payload.output??this.state.output),decodedSource:source??this.state.decodedSource,clock,processingPlan:gainPlan,
            ...(clock?{positionSeconds:Math.max(0,Number(payload.position)-(session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0))}:{})};
          this.acceptPipeline(session,payload);
          if(prepared){
            const plan=this.state.pipelinePlan!;
            if(payload.sourceStartPcmFrame!==plan.span.startFrame||payload.sourceEndPcmFrame!==plan.span.endFrame||payload.cueBoundaryPcmFrame!==plan.span.boundaryFrame)throw new Error('播放前源范围回执冲突');
            this.state={...this.state,planAcceptance:{phase:'validated',hardwareVerified:false}};
            session.preflightPhase='start-sent';
            void this.send(session,'playback.start',{planToken:payload.planToken}).catch(error=>this.fail(session,error as Error));
          }else{
            if(session.preflightRequired&&session.preflightPhase==='start-sent'&&payload.state!==(session.initialPaused?'paused':'playing'))throw new Error('播放初始状态与计划不符');
            session.preflightPhase='started';
            if(session.preflightRequired)this.state={...this.state,planAcceptance:{phase:'ready',hardwareVerified:false}};
            if(session.started){clearTimeout(session.started.timer);session.started.resolve();session.started=null;}
            const transition=session.pcmTransitions.get(String(message.causedBy));
            if(transition){if(payload.state!==transition.state)throw new Error('暂停或继续的实际状态与命令不符');clearTimeout(transition.timer);session.pcmTransitions.delete(String(message.causedBy));transition.resolve();}
          }
        }

        else if(payload.state==='ended'||payload.state==='stopped'){
          const tail=payload.state==='ended'?this.eventTail(session,payload.tail):undefined;
          if(payload.state==='ended'&&(session.tailRequired||payload.tail!=null)&&tail?.status!=='completed')throw new Error('歌曲尾部尚未完成，不能继续播放列表');
          this.clearTail(session);this.state={...this.state,state:'idle',itemId:null,positionSeconds:0,tail};
        }
        else{this.fail(session,new Error('音频状态无效'));return;}break;
      case 'playback.tail':{
        const tail=this.eventTail(session,payload.tail);if(!tail)throw new Error('歌曲尾部事件缺少回执');
        this.state={...this.state,tail};break;
      }
      case 'playback.position':{
        const parseCounter=(value:unknown):number|null=>{
          if(typeof value!=='string'||!/^\d+$/.test(value))return null;
          const parsed=BigInt(value);
          return parsed<=BigInt(Number.MAX_SAFE_INTEGER)?Number(parsed):null;
        };
        const callbackCount=parseCounter(payload.callbackCount);
        const bufferUnderrunCallbacks=parseCounter(payload.bufferUnderrunCallbacks);
        const bufferUnderrunFrames=parseCounter(payload.bufferUnderrunFrames);
        if(typeof payload.position!=='number'||!Number.isFinite(payload.position)||payload.position<0||
          callbackCount===null||bufferUnderrunCallbacks===null||bufferUnderrunFrames===null||
          bufferUnderrunCallbacks>callbackCount||
          (this.state.diagnostics!==undefined &&
            (callbackCount<this.state.diagnostics.callbackCount||
             bufferUnderrunCallbacks<this.state.diagnostics.bufferUnderrunCallbacks||
             bufferUnderrunFrames<this.state.diagnostics.bufferUnderrunFrames))){
          this.fail(session,new Error('音频缓冲诊断事件无效'));return;
        }
        if(session.processingRequired&&payload.processingCounts===undefined)throw new Error('音频处理计数缺失');
        if(payload.processingCounts!==undefined){
          const c=payload.processingCounts as Record<string,unknown>;
          if(!c||Object.keys(c).length!==2)throw new Error('音频处理计数回执无效');
          for(const key of ['clippedSamples','invalidSamples'])if(typeof c[key]!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(String(c[key]))||BigInt(String(c[key]))>18446744073709551615n||this.state.processingCounts&&BigInt(String(c[key]))<BigInt(this.state.processingCounts[key as 'clippedSamples'|'invalidSamples']))throw new Error('音频处理计数无效');
          this.state={...this.state,processingCounts:{clippedSamples:String(c.clippedSamples),invalidSamples:String(c.invalidSamples)}};
        }
        this.state={...this.state,positionSeconds:Math.max(0,payload.position-
          (session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0)),
          diagnostics:{callbackCount,bufferUnderrunCallbacks,bufferUnderrunFrames},clock:this.eventClock(session,payload)};
        break;
      }
      case 'playback.cueBoundary':{
        this.latestAnalysis=null;
        const pair=session.cuePair;
        if(!pair||pair.segmentIndex!==0||pair.boundaryPcmFrame!==payload.sourcePcmFrame||
          typeof payload.position!=='number'||!Number.isFinite(payload.position)){
          this.fail(session,new Error('CUE 边界事件与预排计划不一致'));return;
        }
        pair.segmentIndex=1;
        this.state={...this.state,itemId:pair.nextItem.id,durationSeconds:pair.nextItem.durationSeconds,processingPlan:this.eventProcessing(session,payload.processingPlan),
          positionSeconds:Math.max(0,payload.position-pair.boundaryOffsetSeconds),clock:this.eventClock(session,payload)};
        this.acceptPipeline(session,payload);
        for(const waiter of session.boundaryWaiters){clearTimeout(waiter.timer);waiter.resolve();}
        session.boundaryWaiters=[];
        break;
      }
      case 'playback.volumeChanged':{
        const waiter=session.volumes.get(String(message.causedBy));
        if(!waiter||Object.keys(payload).length!==(session.pipelineRequired?8:7)||payload.revision!==String(waiter.revision)||payload.volumeDb!==waiter.volumeDb||payload.muted!==waiter.muted||payload.application!=='callback-target'||payload.rampMs!==20||payload.hardwareVerified!==false)throw new Error('实时音量目标回执无效');
        session.processingSeeds.settings={...session.processingSeeds.settings,volumeDb:waiter.volumeDb,muted:waiter.muted};
        const plan=this.eventProcessing(session,payload.processingPlan);
        session.volumeRevision=waiter.revision;this.state={...this.state,processingPlan:plan,volumeControl:{revision:waiter.revision,application:'callback-target',rampMs:20,hardwareVerified:false}};
        this.acceptPipeline(session,payload);
        clearTimeout(waiter.timer);session.volumes.delete(String(message.causedBy));waiter.resolve();break;
      }
      case 'playback.snapshot':{
        const waiter=session.snapshots.get(String(message.causedBy));
        if(!waiter)return; // A late snapshot must not overwrite newer state.
        if((payload.state!=='playing'&&payload.state!=='paused')||
          typeof payload.position!=='number'||!Number.isFinite(payload.position)){
          this.fail(session,new Error('音频快照无效'));return;
        }
        this.state={...this.state,state:payload.state,processingPlan:this.eventProcessing(session,payload.processingPlan),tail:this.eventTail(session,payload.tail),positionSeconds:Math.max(0,payload.position-
          (session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0)),clock:this.eventClock(session,payload)};
        this.acceptPipeline(session,payload);
        clearTimeout(waiter.timer);session.snapshots.delete(String(message.causedBy));
        waiter.resolve(payload.state);
        break;
      }
      case 'playback.seekCompleted':{
        this.clearTail(session);
        this.latestAnalysis=null;
        const waiter=session.seeks.get(String(message.causedBy));
        if(!waiter||message.generation<=previousGeneration||
          (payload.state!=='playing'&&payload.state!=='paused')||
          typeof payload.position!=='number'||!Number.isFinite(payload.position)||payload.position<0){
          this.fail(session,new Error('音频跳转完成事件无效'));return;
        }
        if(session.cuePair&&payload.cueSegmentIndex!==session.cuePair.segmentIndex){
          this.fail(session,new Error('CUE 跳转越过当前曲目'));return;
        }
        this.state={...this.state,state:payload.state,processingPlan:this.eventProcessing(session,payload.processingPlan),tail:undefined,positionSeconds:Math.max(0,payload.position-
          (session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0)),clock:this.eventClock(session,payload)};
        this.acceptPipeline(session,payload);
        clearTimeout(waiter.timer);session.seeks.delete(String(message.causedBy));
        ++this.analysisRevision;this.syncAnalysis();
        waiter.resolve();break;
      }
      case 'playback.error':this.fail(session,new Error(String(payload.message??'音频引擎错误')));return;
      default:this.fail(session,new Error('音频事件类型无效'));return;
    }
    this.refreshLiveness(session);
    this.publish(this.snapshot(),message.event==='playback.stateChanged'&&payload.state==='ended'?'ended':
      message.event==='playback.cueBoundary'?'cueBoundary':String(message.event));
  }

  private onAsioEvent(session:Session,message:AudioMessage,payload:Record<string,unknown>,previousGeneration:number):void{
    const tracker=session.asio!;
    if(session.rebuilding)throw new Error('ASIO 释放后的旧会话继续发送活动事件');
    const terminal=message.event==='playback.rebuildRequired'||message.event==='playback.stateChanged'&&payload.state==='stopped';
    if(message.generation!==(terminal?previousGeneration+1:message.event==='playback.prepared'?1:previousGeneration))throw new Error('ASIO 事件代际与控制阶段不符');
    const offset=()=>session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0;
    switch(message.event){
      case 'playback.prepared':{
        if(session.preflightPhase!=='awaiting-plan'||this.state.state!=='preparing')throw new Error('ASIO 计划准备阶段无效');
        const p=tracker.acceptPrepared(payload);
        if(session.cuePair){session.cuePair.boundaryPcmFrame=p.cueBoundaryPcmFrame;session.cuePair.boundaryOffsetSeconds=Number(BigInt(p.cueBoundaryPcmFrame!)-BigInt(p.sourceStartPcmFrame))/p.actualOutput.sampleRate;}
        session.processingOpus=p.decodedSource.opusGain??null;
        this.state={...this.state,asio:tracker.view(session.generation),decodedSource:p.decodedSource,processingPlan:p.processingPlan,positionSeconds:p.position,output:p.output,planAcceptance:{phase:'validated',hardwareVerified:false}};
        session.preflightPhase='start-sent';
        void this.send(session,'playback.start',{planToken:p.planToken}).catch(error=>this.fail(session,error as Error));break;
      }
      case 'playback.stateChanged':{
        this.latestAnalysis=null;
        if(payload.state==='playing'||payload.state==='paused'){
          if(session.preflightPhase==='awaiting-plan')throw new Error('ASIO 在正式计划核对前开始播放');
          if(session.preflightPhase==='start-sent'&&payload.state!==(session.initialPaused?'paused':'playing'))throw new Error('ASIO 初始暂停状态与计划不符');
          const p=tracker.state(payload);this.clearTail(session);
          this.state={...this.state,state:payload.state,positionSeconds:Math.max(0,p.position-offset()),asio:tracker.view(session.generation),processingPlan:p.processing,planAcceptance:{phase:'ready',hardwareVerified:false}};
          session.preflightPhase='started';session.pauseCommand=null;
          if(session.started){clearTimeout(session.started.timer);session.started.resolve();session.started=null;}
        }else if(payload.state==='ended'){
          if(Object.keys(payload).length!==2)throw new Error('ASIO 完成事件字段无效');const tail=tracker.tail(payload.tail);if(tail.status!=='completed')throw new Error('ASIO 歌曲尾部尚未完成');
          this.clearTail(session);this.state={...this.state,state:'idle',itemId:null,positionSeconds:0,asio:tracker.view(session.generation)};
        }else if(payload.state==='stopped'){
          if(Object.keys(payload).length!==1)throw new Error('ASIO 停止事件字段无效');this.clearTail(session);this.state={state:'idle',itemId:null,positionSeconds:0,durationSeconds:null,output:'设备已释放'};
        }else throw new Error('ASIO 活动状态无效');break;
      }
      case 'playback.position':{
        if(session.preflightPhase!=='started'||Object.keys(payload).length!==7)throw new Error('ASIO 位置事件阶段或字段无效');
        const counters=['callbackCount','bufferUnderrunCallbacks','bufferUnderrunFrames'] as const;
        const values=counters.map(k=>asAsioCounter(payload[k],this.state.diagnostics?String(this.state.diagnostics[k]):undefined));
        if(values.some(v=>BigInt(v)>BigInt(Number.MAX_SAFE_INTEGER))||BigInt(values[1])>BigInt(values[0]))throw new Error('ASIO 缓冲诊断超出可显示范围');
        const counts=payload.processingCounts as Record<string,unknown>,packing=payload.asioPackingCounts as Record<string,unknown>;
        if(!counts||Object.keys(counts).length!==2||!packing||Object.keys(packing).length!==2)throw new Error('ASIO 处理计数字段无效');
        const clock=tracker.clock(payload.clock,payload.position),old=this.state.asio?.packingCounts;
        this.state={...this.state,positionSeconds:Math.max(0,Number(payload.position)-offset()),asio:{...tracker.view(session.generation),packingCounts:{saturatedSamples:asAsioCounter(packing.saturatedSamples,old?.saturatedSamples),nonfiniteSamples:asAsioCounter(packing.nonfiniteSamples,old?.nonfiniteSamples)}},
          diagnostics:{callbackCount:Number(values[0]),bufferUnderrunCallbacks:Number(values[1]),bufferUnderrunFrames:Number(values[2])},processingCounts:{clippedSamples:asAsioCounter(counts.clippedSamples,this.state.processingCounts?.clippedSamples),invalidSamples:asAsioCounter(counts.invalidSamples,this.state.processingCounts?.invalidSamples)}};
        if(clock.authority==='paused-bookmark'&&this.state.state!=='paused')throw new Error('ASIO 活动状态与暂停时钟冲突');break;
      }
      case 'playback.cueBoundary':{
        const pair=session.cuePair;if(!pair||pair.segmentIndex!==0||Object.keys(payload).length!==6)throw new Error('ASIO CUE 边界与队列预排不符');
        tracker.boundary(payload);pair.segmentIndex=1;this.latestAnalysis=null;
        const processing=tracker.processing(payload.processingPlan);tracker.plan(payload.asioPlan,processing);tracker.clock(payload.clock,payload.position);
        this.state={...this.state,itemId:pair.nextItem.id,durationSeconds:pair.nextItem.durationSeconds,positionSeconds:Math.max(0,Number(payload.position)-offset()),processingPlan:processing,asio:tracker.view(session.generation)};
        for(const waiter of session.boundaryWaiters){clearTimeout(waiter.timer);waiter.resolve();}session.boundaryWaiters=[];break;
      }
      case 'playback.tail':{
        if(Object.keys(payload).length!==1)throw new Error('ASIO 尾部事件字段无效');const tail=tracker.tail(payload.tail);if(tail.status!=='draining')throw new Error('ASIO 尾部阶段无效');
        this.state={...this.state,asio:tracker.view(session.generation)};
        if(!session.tailTimer)session.tailTimer=setTimeout(()=>this.fail(session,new Error('ASIO 尾部与驱动释放确认超时')),35000);break;
      }
      case 'playback.snapshot':{
        const waiter=session.snapshots.get(String(message.causedBy));if(!waiter)return;
        if(payload.state!=='playing'&&payload.state!=='paused')throw new Error('ASIO 快照状态无效');
        const p=tracker.state(payload,true);if(payload.tail!==null)tracker.tail(payload.tail);
        this.state={...this.state,state:payload.state,positionSeconds:Math.max(0,p.position-offset()),processingPlan:p.processing,asio:tracker.view(session.generation)};
        clearTimeout(waiter.timer);session.snapshots.delete(String(message.causedBy));waiter.resolve(payload.state);break;
      }
      case 'playback.volumeChanged':{
        const waiter=session.volumes.get(String(message.causedBy));
        if(!waiter||Object.keys(payload).length!==8||payload.revision!==String(waiter.revision)||payload.volumeDb!==waiter.volumeDb||payload.muted!==waiter.muted||payload.application!=='callback-target'||payload.rampMs!==20||payload.hardwareVerified!==false)throw new Error('ASIO 实时音量回执无效');
        session.processingSeeds.settings={...session.processingSeeds.settings,volumeDb:waiter.volumeDb,muted:waiter.muted};tracker.setVolume(session.processingSeeds.settings);
        const gain=tracker.processing(payload.processingPlan);tracker.plan(payload.asioPlan,gain);session.volumeRevision=waiter.revision;
        this.state={...this.state,asio:tracker.view(session.generation),processingPlan:gain,volumeControl:{revision:waiter.revision,application:'callback-target',rampMs:20,hardwareVerified:false}};
        clearTimeout(waiter.timer);session.volumes.delete(String(message.causedBy));waiter.resolve();break;
      }
      case 'playback.rebuildRequired':{
        if(session.preflightPhase!=='started'||!this.asioRebuilder||!this.state.itemId)throw new Error('ASIO 会话重建尚未处于活动阶段');
        const request=tracker.rebuild(payload),commandId=String(message.causedBy??'');
        if(request.reason==='pause'&&(commandId!==session.pauseCommand||this.state.state!=='playing')||request.reason==='seek'&&!session.seeks.has(commandId)||request.reason==='driver-reconfigure'&&commandId!=='')throw new Error('ASIO 重建回执与命令不符');
        if(request.reason==='driver-reconfigure'){
          const now=performance.now();this.reconfigureTimes=this.reconfigureTimes.filter(t=>now-t<60000);if(this.reconfigureTimes.length>=2)throw new Error('ASIO 驱动一分钟内重复要求重建，已停止自动恢复');this.reconfigureTimes.push(now);
        }
        const p=tracker.prepared!,origin=tracker.span!.segmentIndex===1?BigInt(tracker.span!.boundaryFrame!)-BigInt(tracker.span!.startFrame):0n;
        if(BigInt(request.positionFrame)<origin)throw new Error('ASIO 重建位置落在当前 CUE 曲目之前');
        const rebuild:AsioRebuildRequest={itemId:this.state.itemId,token:this.operation,reason:request.reason,paused:request.desiredState==='paused',frame:String(BigInt(request.positionFrame)-origin),sampleRate:request.sourceSampleRate,fileBinding:p.decodedSource.fileBinding!,configurationRevision:tracker.context.preference.revision,backendRevision:session.backendRevision,generation:session.generation};
        const waiter=session.seeks.get(commandId);if(waiter){clearTimeout(waiter.timer);session.seeks.delete(commandId);}
        session.rebuilding=true;this.clearTail(session);this.latestAnalysis=null;this.session=null;
        const released=new Error('ASIO 旧会话已释放，其他进行中的操作已取消');
        for(const pending of session.pending.values()){clearTimeout(pending.timer);pending.reject(released);}session.pending.clear();
        for(const pending of session.snapshots.values()){clearTimeout(pending.timer);pending.reject(released);}session.snapshots.clear();
        for(const pending of session.seeks.values()){clearTimeout(pending.timer);pending.reject(released);}session.seeks.clear();
        for(const pending of session.volumes.values()){clearTimeout(pending.timer);pending.reject(released);}session.volumes.clear();
        for(const pending of session.boundaryWaiters){clearTimeout(pending.timer);pending.reject(released);}session.boundaryWaiters=[];
        this.state={...this.state,state:'preparing',positionSeconds:Number(rebuild.frame)/rebuild.sampleRate,message:request.reason==='pause'?'正在保留位置并准备暂停':request.reason==='seek'?'正在跳转并重新准备输出':'驱动要求重新准备输出'};
        this.publish(this.snapshot(),'asioRebuilding');this.retire(session,false,true);
        const token=this.operation;
        void (async()=>{
          await this.waitForRelease();if(await session.nativeExit!==0)throw new Error('ASIO 旧进程未正常退出，已阻止重建');
          if(request.reason==='driver-reconfigure')await new Promise(resolve=>setTimeout(resolve,250*this.reconfigureTimes.length));
          if(token!==this.operation||this.systemSleeping)throw new Error('ASIO 重建请求已取消');
          await this.asioRebuilder!(rebuild);waiter?.resolve();
        })().catch(error=>{
          waiter?.reject(error instanceof Error?error:new Error(String(error)));
          if(token===this.operation){this.state={...this.state,state:'error',message:error instanceof Error?error.message:String(error)};this.publish(this.snapshot(),'error');}
        });return;
      }
      default:throw new Error('ASIO 音频事件类型无效');
    }
    this.refreshLiveness(session);this.publish(this.snapshot(),message.event==='playback.stateChanged'&&payload.state==='ended'?'ended':message.event==='playback.cueBoundary'?'cueBoundary':String(message.event));
  }

  private cancelSessionOperations(session:Session,error:Error):void {
    if(session.started){clearTimeout(session.started.timer);session.started.reject(error);session.started=null;}
    for(const map of [session.pending,session.snapshots,session.seeks,session.volumes,session.pcmTransitions]){for(const waiter of map.values()){clearTimeout(waiter.timer);waiter.reject(error);}map.clear();}
    for(const waiter of session.boundaryWaiters){clearTimeout(waiter.timer);waiter.reject(error);}session.boundaryWaiters=[];
  }
  private scheduleDsdRebuild(session:Session,request:AsioRebuildRequest,commandId:string):void {
    this.dsdAnalysis.update(null);
    const waiter=session.seeks.get(commandId);if(waiter){clearTimeout(waiter.timer);session.seeks.delete(commandId);}
    session.rebuilding=true;this.clearTail(session);this.latestAnalysis=null;this.session=null;
    this.cancelSessionOperations(session,new Error('DSD 旧会话已释放，其他操作已取消'));
    this.state={...this.state,state:'preparing',positionSeconds:Number(request.frame)/request.sampleRate,message:request.reason==='pause'?'正在保留原始位数并准备暂停':request.reason==='seek'?'正在跳转并重新准备 DSD 输出':'驱动要求重新准备 DSD 输出'};
    this.publish(this.snapshot(),'asioRebuilding');this.retire(session,false,true);const token=this.operation;
    void (async()=>{
      await this.waitForRelease();if(await session.nativeExit!==0)throw new Error('DSD 旧宿主未正常退出，已阻止重建');
      if(request.reason==='driver-reconfigure')await new Promise(resolve=>setTimeout(resolve,250*this.reconfigureTimes.length));
      if(token!==this.operation||this.systemSleeping)throw new Error('DSD 重建请求已取消');
      await this.asioRebuilder!(request);waiter?.resolve();
    })().catch(error=>{waiter?.reject(error instanceof Error?error:new Error(String(error)));if(token===this.operation){this.state={...this.state,state:'error',message:error instanceof Error?error.message:String(error)};this.publish(this.snapshot(),'error');}});
  }
  private finishDsdSession(session:Session,ended:boolean):void {
    if(ended)try{this.historyObserver(this.historyObservation(session));}catch{/* Preserve audio lifecycle. */}
    this.dsdAnalysis.update(null);
    session.rebuilding=true;this.clearTail(session);this.latestAnalysis=null;this.session=null;
    this.cancelSessionOperations(session,new Error('DSD 会话已完成或停止'));this.retire(session,false,true);const token=this.operation;
    void (async()=>{
      await this.waitForRelease();if(await session.nativeExit!==0)throw new Error('DSD 宿主释放后未正常退出，已阻止队列自动继续');
      if(token!==this.operation||this.systemSleeping)return;
      this.state={...this.state,state:'idle',itemId:null,positionSeconds:0,output:'设备已释放'};this.publish(this.snapshot(),ended?'ended':'stopped');
    })().catch(error=>{if(token===this.operation){this.state={...this.state,state:'error',message:error instanceof Error?error.message:String(error)};this.publish(this.snapshot(),'error');}});
  }
  private onAsioDsdEvent(session:Session,message:AudioMessage,payload:Record<string,unknown>,previousGeneration:number):void {
    const tracker=session.asioDsd!;
    if(session.rebuilding)throw new Error('DSD 已释放的会话继续发送活动事件');
    if(message.event==='playback.error'){
      if(Object.keys(payload).length!==3||typeof payload.message!=='string'||payload.driverReleased!==true||payload.sourceReleased!==true)throw new Error('DSD 错误释放回执无效');this.fail(session,new Error(payload.message));return;
    }
    const terminal=message.event==='playback.dsdRebuildRequired'||message.event==='playback.dsdStateChanged'&&payload.state==='stopped';
    if(message.generation!==(terminal?previousGeneration+1:message.event==='playback.dsdPrepared'?1:previousGeneration))throw new Error('DSD 事件代际与控制阶段不符');
    switch(message.event){
      case 'playback.dsdPrepared':{
        if(session.preflightPhase!=='awaiting-plan'||this.state.state!=='preparing'||message.causedBy!==session.dsdPlayCommand)throw new Error('DSD 准备事件与原播放操作不符');
        const p=tracker.acceptPrepared(payload);
        this.state={...this.state,asioDsd:tracker.view(session.generation),positionSeconds:p.position,durationSeconds:Number(BigInt(p.dsdPlan.range.endTick)-BigInt(p.dsdPlan.range.startTick))/p.source.bitRate,output:p.output,planAcceptance:{phase:'validated',hardwareVerified:false}};
        session.preflightPhase='start-sent';void this.send(session,'playback.start',{planToken:p.planToken}).catch(error=>this.fail(session,error as Error));break;
      }
      case 'playback.dsdStateChanged':{
        if(payload.state==='playing'||payload.state==='paused'){
          if(session.preflightPhase==='awaiting-plan')throw new Error('DSD 在计划核对前开始播放');
          if(session.preflightPhase==='start-sent'){
            if(payload.state!==(session.initialPaused?'paused':'playing')||message.causedBy!==session.dsdPlayCommand)throw new Error('DSD 初始状态或原操作不符');
          }else if(payload.state!=='playing'||this.state.state!=='paused'||message.causedBy!==session.pauseCommand)throw new Error('DSD 继续播放状态与原操作不符');
          const p=tracker.state(payload);this.clearTail(session);this.state={...this.state,state:p.state,positionSeconds:p.position,asioDsd:tracker.view(session.generation),planAcceptance:{phase:'ready',hardwareVerified:false}};
          session.preflightPhase='started';session.pauseCommand=null;
          if(session.started){clearTimeout(session.started.timer);session.started.resolve();session.started=null;}
        }else if(payload.state==='ended'){
          if(session.preflightPhase!=='started'||Object.keys(payload).length!==2||message.causedBy!==undefined&&message.causedBy!=='')throw new Error('DSD 完成事件阶段或字段无效');
          if(tracker.latestTail?.status!=='draining')throw new Error('DSD 完成事件未经过曲尾等待');const tail=tracker.tail(payload.tail);if(tail.status!=='completed')throw new Error('DSD 曲尾没有确认完成');
          if(!tracker.latestPosition||BigInt(tracker.latestPosition.publishedSourceBits)!==BigInt(tracker.prepared!.dsdPlan.range.endTick)-BigInt(tracker.prepared!.dsdPlan.range.startTick)-BigInt(tracker.prepared!.dsdPlan.range.initialTick))throw new Error('DSD 完成位数尚未确认');
          this.state={...this.state,asioDsd:tracker.view(session.generation)};this.finishDsdSession(session,true);return;
        }else if(payload.state==='stopped'){
          if(Object.keys(payload).length!==3||payload.driverReleased!==true||payload.sourceReleased!==true)throw new Error('DSD 停止释放回执无效');this.finishDsdSession(session,false);return;
        }else throw new Error('DSD 活动状态无效');break;
      }
      case 'playback.dsdPosition':{
        if(session.preflightPhase!=='started'||message.causedBy!==undefined&&message.causedBy!=='')throw new Error('DSD 位置事件阶段或因果身份无效');
        const p=tracker.position(payload);if((p.clock.authority==='paused-bookmark')!==(this.state.state==='paused'))throw new Error('DSD 位置时钟与暂停状态冲突');
        this.state={...this.state,positionSeconds:p.position,asioDsd:tracker.view(session.generation)};break;
      }
      case 'playback.dsdTail':{
        if(session.preflightPhase!=='started'||Object.keys(payload).length!==1||tracker.tail(payload.tail).status!=='draining')throw new Error('DSD 曲尾阶段或字段无效');
        this.state={...this.state,asioDsd:tracker.view(session.generation)};if(!session.tailTimer)session.tailTimer=setTimeout(()=>this.fail(session,new Error('DSD 曲尾与输出释放确认超时')),35000);break;
      }
      case 'playback.dsdSnapshot':{
        const waiter=session.snapshots.get(String(message.causedBy));if(!waiter)throw new Error('DSD 快照缺少原操作');
        if(session.preflightPhase!=='started')throw new Error('DSD 尚未开始，不能核对活动快照');const p=tracker.snapshot(payload);
        if(p.state!==this.state.state)throw new Error('DSD 快照活动状态发生意外变化');this.state={...this.state,positionSeconds:p.position,asioDsd:tracker.view(session.generation)};
        clearTimeout(waiter.timer);session.snapshots.delete(String(message.causedBy));waiter.resolve(p.state);break;
      }
      case 'playback.dsdRebuildRequired':{
        if(session.preflightPhase!=='started'||!this.asioRebuilder||!this.state.itemId)throw new Error('DSD 重建不在活动阶段');const p=tracker.rebuild(payload),id=String(message.causedBy??'');
        if(p.reason==='pause'&&(id!==session.pauseCommand||this.state.state!=='playing')||p.reason==='seek'&&!session.seeks.has(id)||p.reason==='driver-reconfigure'&&id!=='')throw new Error('DSD 重建事件与原操作不符');
        if(p.reason==='driver-reconfigure'){const now=performance.now();this.reconfigureTimes=this.reconfigureTimes.filter(t=>now-t<60000);if(this.reconfigureTimes.length>=2)throw new Error('DSD 驱动一分钟内重复要求重建，已停止自动恢复');this.reconfigureTimes.push(now);}
        const bookmark=tracker.bookmark(p.positionTick,session.backendRevision);
        this.scheduleDsdRebuild(session,{...bookmark,itemId:this.state.itemId,token:this.operation,reason:p.reason,paused:p.desiredState==='paused',generation:session.generation},id);return;
      }
      default:throw new Error('原始 DSD 会话发送了未允许的音频事件');
    }
    this.syncAnalysis();this.refreshLiveness(session);this.publish(this.snapshot(),String(message.event));
  }

  private connect(session:Session):Promise<Socket>{
    return new Promise((resolve,reject)=>{
      const deadline=Date.now()+5000;
      const attempt=()=>{
        if(this.session!==session){reject(new Error('音频会话已取消'));return;}
        const socket=net.createConnection(session.pipe);
        const onError=(error:NodeJS.ErrnoException)=>{
          socket.destroy();
          if((error.code==='ENOENT'||error.code==='ECONNREFUSED'||error.code==='EPIPE')&&Date.now()<deadline)
            setTimeout(attempt,30);
          else reject(error);
        };
        socket.once('connect',()=>{socket.off('error',onError);resolve(socket);});
        socket.once('error',onError);
      };
      attempt();
    });
  }

  private async reconcile(session:Session,command:string):Promise<void>{
    if(this.session!==session)throw new Error('音频会话已失效');
    const commandId=randomUUID();
    const event=new Promise<'playing'|'paused'>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        session.snapshots.delete(commandId);
        reject(new Error('音频快照事件超时'));
      },this.commandTimeoutMs);
      session.snapshots.set(commandId,{resolve,reject,timer});
    });
    try{
      const [,state]=await Promise.all([this.send(session,'playback.snapshot',{},commandId),event]);
      const expected=command==='playback.pause'?'paused':'playing';
      if(command!=='playback.play'&&command!=='playback.seek'&&state!==expected)
        throw new Error(`音频命令超时后状态未确认：${command}`);
    }finally{
      const waiter=session.snapshots.get(commandId);
      if(waiter){clearTimeout(waiter.timer);session.snapshots.delete(commandId);}
    }
  }

  private send(session:Session,command:string,params:Record<string,unknown>={},commandId:string=randomUUID()):Promise<AudioMessage>{
    if(!session.socket||session.socket.destroyed)return Promise.reject(new Error('音频通道未连接'));
    const requestId=randomUUID(),timeout=(session.asio||session.asioDsd)&&command==='playback.play'?20000:(session.asio||session.asioDsd)&&command==='playback.start'?10000:this.commandTimeoutMs;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        session.pending.delete(requestId);
        const error=new Error(`音频命令超时：${command}`);
        if(command==='analysis.configure'||command==='volume.configure'){reject(error);return;}
        if(session.asio||session.asioDsd||command==='playback.start'||command==='playback.play'&&session.preflightRequired&&session.preflightPhase!=='started'||command==='playback.snapshot'||command==='playback.cancelNext'){
          this.fail(session,error);reject(error);return;
        }
        session.timedOut.add(commandId);
        void this.reconcile(session,command).then(()=>resolve({kind:'receipt',accepted:true,reconciled:true}))
          .catch(reconcileError=>{this.fail(session,reconcileError as Error);reject(reconcileError);});
      },timeout);
      session.pending.set(requestId,{commandId,resolve,reject,timer});
      try{
        session.socket!.write(encodeFrame({protocol:RELEASE.audioProtocol,kind:'command',sessionId:session.id,requestId,commandId,
          expectedGeneration:session.generation,timeoutMs:timeout,method:command,params}));
      }catch(error){clearTimeout(timer);session.pending.delete(requestId);reject(error);}
    });
  }

  async play(item:LibraryItem,nextItem?:LibraryItem,initialPositionSeconds=0,initialPaused=false,bookmark?:AsioFrameBookmark,history?:PlaybackHistoryBinding):Promise<PlaybackState>{
    this.externalOutputGuard();
    const asio=this.backendPreference.backend==='asio';
    const dsdMode=asio?this.selectedDsdMode():this.dsdPolicy,rawDsd=this.rawDsdSelected(item);
    const selectedProcessing=asio?this.backendPreference.asioProcessing:this.processing,selectedDsd=dsdMode==='pcm'?'pcm':'stop';
    if(rawDsd){nextItem=undefined;if(processingEnabled(selectedProcessing))throw new Error('原始 DSD 禁用软件音量、静音和 ReplayGain；请明确选择转 PCM 后再启用数字处理');}
    const conversion=asio?this.asioPreference.allowConversion:this.mode!=='exclusive';
    if(bookmark&&(!asio||bookmark.backendRevision!==this.backendPreference.revision||bookmark.configurationRevision!==this.asioPreference.revision))throw new Error('ASIO 重建设置已变化');
    if(!rawDsd&&bookmark?.dsd)bookmark=undefined;
    if(asio)asioSessionConfiguration(this.asioPreference);
    if(this.systemSleeping)throw new Error('系统正在休眠，已阻止打开音频');
    if(this.outputBlocked&&!asio)throw new Error(this.outputBlocked);
    if(!Number.isFinite(initialPositionSeconds)||initialPositionSeconds<0||initialPositionSeconds>Number.MAX_SAFE_INTEGER/1000000||item.durationSeconds!==null&&initialPositionSeconds>=item.durationSeconds)throw new Error('恢复播放位置超出曲目范围');
    this.stop();
    const operation=++this.operation;
    try{await this.waitForRelease();this.externalOutputGuard();}
    catch(error){
      this.state={...this.state,state:'error',message:(error as Error).message};
      this.publish(this.snapshot(),'error');
      throw error;
    }
    if(operation!==this.operation||this.systemSleeping)throw new Error('播放请求已取消');
    if(!item.available)throw new Error('音频文件当前不可用');
    if(!existsSync(this.nativeExecutable))throw new Error('原生音频宿主尚未编译，请先运行 native/audio-host/build.ps1');
    if(!['.flac','.wav','.wave','.mp3','.m4a','.aac','.ogg','.oga','.opus','.dsf','.dff'].includes(path.extname(item.path).toLowerCase()))
      throw new Error('此格式的播放适配尚在开发；已接入 FLAC、WAV、MP3、AAC/M4A、ALAC、Vorbis 和 Opus，具体编码仍由宿主探测');
    if(['.dsf','.dff'].includes(path.extname(item.path).toLowerCase())&&!rawDsd&&(selectedDsd!=='pcm'||!conversion))throw new Error('DSD 播放已停止：请选择明确的 Native／DoP 预设，或允许转换后选择 DSD 转 PCM');
    if(nextItem&&!adjacentCueItems(item,nextItem))
      throw new Error('相邻 CUE 轨计划无效');
    const sampleRange=samplePlayRange(item,nextItem);
    if(!conversion&&processingEnabled(selectedProcessing))throw new Error('原始格式模式不允许音频增益处理');
    const gainSeeds={settings:{...selectedProcessing},tags:item.replayGain?validateReplayGain(item.replayGain):null,nextTags:nextItem?.replayGain?validateReplayGain(nextItem.replayGain):null};
    const checkingGain=selectedProcessing.replayGain!=='off'&&Boolean(gainSeeds.tags||gainSeeds.nextTags);
    if(item.fileObservation!==undefined||nextItem?.fileObservation!==undefined||checkingGain){
      let timer:NodeJS.Timeout|undefined;
      try{
        const current=await Promise.race([(async()=>{const legacy=await fs.stat(item.path),observed=await fs.lstat(item.path,{bigint:true});requireFileObservation(item.fileObservation,observed);if(nextItem?.fileObservation!==undefined)requireFileObservation(nextItem.fileObservation,observed);return legacy;})(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('音乐文件属性核对超时')),5000);})]);
        if(checkingGain&&(!current.isFile()||!item.fileStamp||`${current.size}:${Math.trunc(current.mtimeMs)}`!==item.fileStamp))throw new Error('音乐文件与 ReplayGain 标签的扫描记录不一致，请重新扫描后播放');
      }finally{clearTimeout(timer);}
      if(operation!==this.operation)throw new Error('播放请求已取消');
    }
    const session:Session={history,id:randomUUID(),nonce:randomUUID(),pipe:`\\\\.\\pipe\\aural-${randomUUID()}`,
      process:null as unknown as ChildProcessWithoutNullStreams,socket:null,generation:0,sequence:0n,ready:false,asio:null,asioDsd:null,dsdPlayCommand:null,backendRevision:this.backendPreference.revision,rebuilding:false,pauseCommand:null,nativeExit:null,
      pending:new Map(),snapshots:new Map(),seeks:new Map(),pcmTransitions:new Map(),pcmTransition:null,volumeRevision:0,volumes:new Map(),timedOut:new Set(),hello:null,analysisStarted:false,processingRequired:false,replayGainStamp:selectedProcessing.replayGain!=='off'&&(gainSeeds.tags||gainSeeds.nextTags)?item.fileStamp??null:null,preflightRequired:false,preflightPhase:'awaiting-plan',initialPaused,initialPositionUs:Math.floor(initialPositionSeconds*1000000),pipelineRequired:false,rangeSpec:{startCue:item.sourceStartCueFrame,endCue:item.sourceEndCueFrame,startSeconds:item.sourceStartSeconds,endSeconds:item.sourceEndSeconds,nextEndCue:nextItem?.sourceEndCueFrame??null,...(sampleRange?{samples:sampleRange}:{})},processingOpus:null,processingSeeds:gainSeeds,clockRequired:false,tailRequired:false,tailTimer:null,livenessTimer:null,started:null,
      cuePair:nextItem?{nextItem,firstEndCueFrame:item.sourceEndCueFrame,segmentIndex:0,
        boundaryOffsetSeconds:0,boundaryPcmFrame:null}:null,boundaryWaiters:[]};
    if(rawDsd)session.asioDsd=new AsioDsdPlaybackTracker(buildDsdRequest(item,dsdMode as 'native-dsd'|'dop',this.asioPreference,this.dsdOutputPreference,session.initialPositionUs,initialPaused,bookmark?.dsd?bookmark:undefined),this.dsdOutputPreference.revision,session.id,session.nonce,bookmark?.dsd?bookmark:undefined);
    else if(asio)session.asio=new AsioPlaybackTracker({sessionId:session.id,nonce:session.nonce,preference:structuredClone(this.asioPreference),initialPaused,dsdPolicy:selectedDsd,settings:gainSeeds.settings,tags:gainSeeds.tags,nextTags:gainSeeds.nextTags,tagStamp:session.replayGainStamp}, {...session.rangeSpec,boundaryCue:nextItem?item.sourceEndCueFrame:null},session.initialPositionUs,bookmark);
    this.state={backend:asio?'asio':'wasapi',state:'preparing',itemId:item.id,positionSeconds:initialPositionSeconds,durationSeconds:item.durationSeconds,output:asio?'正在准备 ASIO':'正在准备 WASAPI'};
    this.publish(this.snapshot());
    this.session=session;
    session.process=spawn(this.nativeExecutable,[session.pipe,session.id,session.nonce,String(process.pid)],
      {windowsHide:true,stdio:['pipe','pipe','pipe']});
    session.nativeExit=new Promise(resolve=>{session.process.once('exit',code=>resolve(code));session.process.once('error',()=>resolve(null));});
    let stdoutBytes=0,stderrBytes=0;
    session.process.stdout.on('data',(chunk:Buffer)=>{if(this.session===session&&(session.asio||session.asioDsd)&&(stdoutBytes+=chunk.length)>256*1024)this.fail(session,new Error('ASIO 宿主标准输出超过诊断预算'));});
    session.process.stderr.setEncoding('utf8');
    session.process.stderr.on('data',(chunk:string)=>{if(this.session!==session)return;if((session.asio||session.asioDsd)&&(stderrBytes+=Buffer.byteLength(chunk,'utf8'))>256*1024){this.fail(session,new Error('ASIO 宿主错误输出超过诊断预算'));return;}console.error('[audio-host]',chunk.trim());});
    session.process.on('error',error=>this.fail(session,error));
    session.process.on('exit',code=>{
      if(session.asioDsd&&code===0){const timer=setTimeout(()=>{if(this.session===session)this.fail(session,new Error('DSD 宿主已退出但未收到完整释放事件'));},250);timer.unref();return;}
      if(this.session===session&&this.state.state!=='idle'&&this.state.state!=='error')
        this.fail(session,new Error(`音频进程退出 (${code??'unknown'})`));
    });
    try{
      session.socket=await this.connect(session);
      if(this.session!==session)throw new Error('音频会话已取消');
      const reader=new FrameReader(message=>this.onMessage(session,message));
      session.socket.on('data',chunk=>{try{reader.push(chunk);}catch(error){this.fail(session,error as Error);}});
      session.socket.on('error',error=>this.fail(session,error));
      session.socket.on('close',()=>{
        if(this.session===session&&this.state.state!=='idle'&&this.state.state!=='error')
          this.fail(session,new Error('音频通道意外关闭'));
      });
      const handshake=new Promise<AudioMessage>((resolve,reject)=>{
        session.hello={resolve,reject};
        const timer=setTimeout(()=>{if(session.hello){session.hello=null;reject(new Error('音频握手超时'));}},5000);
        session.hello={resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}};
      });
      session.socket.write(encodeFrame({protocol:RELEASE.audioProtocol,kind:'hello',buildId:RELEASE.mainBuildId,
        sessionId:session.id,nonce:session.nonce,maxMessageBytes:RELEASE.audioProtocol.maxMessageBytes}));
      await handshake;
      const started=new Promise<void>((resolve,reject)=>{session.started={resolve,reject,timer:setTimeout(()=>reject(new Error('打开输出设备和准备音源超时')),asio?35000:20000)};});
      if(session.asioDsd){session.dsdPlayCommand=randomUUID();await Promise.all([started,this.send(session,'playback.play',session.asioDsd.request as unknown as Record<string,unknown>,session.dsdPlayCommand)]);return this.snapshot();}
      await Promise.all([started,this.send(session,'playback.play',{backend:asio?'asio':'wasapi',deviceId:asio?null:this.deviceId,initialPositionUs:bookmark?'0':String(Math.floor(initialPositionSeconds*1000000)),...(bookmark?{initialPositionFrame:bookmark.frame}:{}),...(asio?{asio:asioSessionConfiguration(this.asioPreference)}:{}),initialPaused,path:item.path,startSeconds:item.sourceStartSeconds,
        endSeconds:item.sourceEndSeconds??-1,startCueFrame:item.sourceStartCueFrame,
        endCueFrame:item.sourceEndCueFrame,mode:asio?'exclusive':this.mode==='shared'?'shared':'exclusive',
        allowConversion:conversion,
        dsdPolicy:selectedDsd,processing:gainSeeds,
        analysisEnabled:this.analysisWanted,
        ...(sampleRange?{sampleRange}:{}),
        ...(nextItem&&!sampleRange?{nextCueStartFrame:nextItem.sourceStartCueFrame,
          nextCueEndFrame:nextItem.sourceEndCueFrame}:{})})]);
      session.analysisStarted=true;this.syncAnalysis();
      return this.snapshot();
    }catch(error){this.fail(session,error as Error);throw error;}
  }

  private async seekOnce(positionSeconds:number,itemId:string|null):Promise<PlaybackState>{
    if(this.state.itemId!==itemId)throw new Error('播放曲目已变化，请重新跳转');
    const session=this.session;
    if(session?.pcmTransition)await session.pcmTransition;
    if(this.session!==session||this.state.itemId!==itemId)throw new Error('暂停或继续期间播放会话已切换');
    if(!session?.ready||(this.state.state!=='playing'&&this.state.state!=='paused'))
      throw new Error('当前没有可跳转的播放会话');
    if(this.state.durationSeconds!==null&&positionSeconds>=this.state.durationSeconds)
      throw new Error('跳转位置超出曲目范围');
    const commandId=randomUUID();
    this.latestAnalysis=null;
    const completed=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        session.seeks.delete(commandId);
        reject(new Error('音频跳转完成事件超时'));
      },session.asio||session.asioDsd?45000:this.commandTimeoutMs*2);
      session.seeks.set(commandId,{resolve,reject,timer});
    });
    try{
      const timelinePosition=positionSeconds+
        (session.cuePair?.segmentIndex===1?session.cuePair.boundaryOffsetSeconds:0);
      await Promise.all([this.send(session,'playback.seek',{positionUs:String(Math.floor(timelinePosition*1_000_000))},commandId),completed]);
      if(this.session!==session&&!session.asio&&!session.asioDsd||this.state.itemId!==itemId||!['playing','paused'].includes(this.state.state))throw new Error('播放会话已切换');
      return this.snapshot();
    }catch(error){
      const rejectedByHost=/^(invalid seek position|seek outside source span|seek overflow|seek in progress|ASIO seek timebase is invalid|ASIO seek is outside the active source span|DSD seek timebase is invalid|DSD seek is outside its frozen source range)$/.test((error as Error).message);
      if(!rejectedByHost&&this.session===session)this.fail(session,error as Error);
      throw error;
    }finally{
      const waiter=session.seeks.get(commandId);
      if(waiter){clearTimeout(waiter.timer);session.seeks.delete(commandId);waiter.reject(new Error('音频跳转未完成'));}
    }
  }
  seek(positionSeconds:number,expectedItemId?:string):Promise<PlaybackState>{
    if(!Number.isFinite(positionSeconds)||positionSeconds<0||positionSeconds>Number.MAX_SAFE_INTEGER/1_000_000)
      return Promise.reject(new Error('无效跳转位置'));
    if(expectedItemId!==undefined&&(typeof expectedItemId!=='string'||expectedItemId!==this.state.itemId))return Promise.reject(new Error('播放曲目已变化，请重新跳转'));
    return new Promise((resolve,reject)=>{
      const itemId=this.state.itemId;
      if(this.queuedSeek&&this.queuedSeek.itemId!==itemId){for(const waiter of this.queuedSeek.waiters)waiter.reject(new Error('播放曲目已变化，请重新跳转'));this.queuedSeek=null;}
      if(this.queuedSeek){this.queuedSeek.position=positionSeconds;this.queuedSeek.waiters.push({resolve,reject});}
      else this.queuedSeek={position:positionSeconds,itemId,waiters:[{resolve,reject}]};
      if(!this.seekRunning)void this.drainSeeks();
    });
  }

  async cancelNext():Promise<'none'|'cancelled'|'crossed'>{
    const session=this.session;
    if(!session?.ready||!session.cuePair)return 'none';
    if(session.cuePair.segmentIndex===1)return 'crossed';
    try{
      await this.send(session,'playback.cancelNext');
      if(this.session!==session)throw new Error('播放会话已切换');
      session.cuePair=null;
      return 'cancelled';
    }catch(error){
      if(!['boundary already crossed','ASIO CUE boundary already crossed'].includes((error as Error).message))throw error;
      if(session.cuePair?.segmentIndex===1)return 'crossed';
      await new Promise<void>((resolve,reject)=>{
        const waiter={resolve,reject,timer:setTimeout(()=>{
          session.boundaryWaiters=session.boundaryWaiters.filter(value=>value!==waiter);
          reject(new Error('CUE 边界事件超时'));
        },session.asio?15000:this.commandTimeoutMs)};
        session.boundaryWaiters.push(waiter);
      });
      return 'crossed';
    }
  }
  private async drainSeeks():Promise<void>{
    this.seekRunning=true;
    while(this.queuedSeek){
      const request=this.queuedSeek;this.queuedSeek=null;
      try{const state=await this.seekOnce(request.position,request.itemId);for(const waiter of request.waiters)waiter.resolve(state);}
      catch(error){for(const waiter of request.waiters)waiter.reject(error as Error);}
    }
    this.seekRunning=false;
  }

  pause():PlaybackState{
    const session=this.session;
    if(session?.rebuilding||session?.pauseCommand)return this.snapshot();
    if(session?.ready&&this.state.state==='playing'){
      const commandId=randomUUID();session.pauseCommand=commandId;
      if(!session.asio&&!session.asioDsd)this.pcmPauseTransition(session,commandId,'paused');
      else void this.send(session,'playback.pause',{},commandId).catch(error=>this.fail(session,error as Error));
    }
    else if(session?.ready&&this.state.state==='paused'){
      const commandId=randomUUID();session.pauseCommand=commandId;
      if(!session.asio&&!session.asioDsd)this.pcmPauseTransition(session,commandId,'playing');
      else void this.send(session,'playback.resume',{},commandId).catch(error=>this.fail(session,error as Error));
    }
    return this.snapshot();
  }
  private pcmPauseTransition(session:Session,commandId:string,state:'paused'|'playing'):void{
    const completed=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{session.pcmTransitions.delete(commandId);reject(new Error('暂停或继续完成事件超时'));},this.commandTimeoutMs*2);
      session.pcmTransitions.set(commandId,{state,resolve,reject,timer});
    });
    session.pcmTransition=Promise.all([this.send(session,state==='paused'?'playback.pause':'playback.resume',{},commandId),completed]).then(()=>{}).catch(error=>this.fail(session,error as Error)).finally(()=>{
      const pending=session.pcmTransitions.get(commandId);if(pending){clearTimeout(pending.timer);session.pcmTransitions.delete(commandId);pending.reject(new Error('暂停或继续未完成'));}
      session.pauseCommand=null;session.pcmTransition=null;
    });
  }
  stop():PlaybackState{
    this.dsdAnalysis.update(null);
    this.latestAnalysis=null;
    ++this.operation;
    if(this.queuedSeek){for(const waiter of this.queuedSeek.waiters)waiter.reject(new Error('音频会话已停止'));this.queuedSeek=null;}
    const session=this.session;this.session=null;
    if(session){
      this.clearTail(session);
      for(const waiter of session.pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('音频会话已停止'));}
      session.pending.clear();session.hello?.reject(new Error('音频会话已停止'));
      if(session.started){clearTimeout(session.started.timer);session.started.reject(new Error('音频会话已停止'));session.started=null;}
      for(const waiter of session.snapshots.values()){clearTimeout(waiter.timer);waiter.reject(new Error('音频会话已停止'));}
      session.snapshots.clear();session.timedOut.clear();
      for(const waiter of session.seeks.values()){clearTimeout(waiter.timer);waiter.reject(new Error('音频会话已停止'));}
      session.seeks.clear();
      for(const waiter of session.pcmTransitions.values()){clearTimeout(waiter.timer);waiter.reject(new Error('音频会话已停止'));}session.pcmTransitions.clear();
      for(const waiter of session.volumes.values()){clearTimeout(waiter.timer);waiter.reject(new Error('音频会话已停止'));}session.volumes.clear();
      for(const waiter of session.boundaryWaiters){clearTimeout(waiter.timer);waiter.reject(new Error('音频会话已停止'));}
      session.boundaryWaiters=[];
      this.retire(session,true);
    }
    this.state={state:'idle',itemId:null,positionSeconds:0,durationSeconds:null,output:'未连接'};
    this.publish(this.snapshot());
    return this.snapshot();
  }
}
