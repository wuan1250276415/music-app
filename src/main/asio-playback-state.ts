import {processingPlan,readProcessingPlan} from '../shared/audio-processing.js';
import {resolveSamplePlayRange,type SamplePlayRange} from '../shared/source-sample-range.js';
import {readAsioPrepared,readAsioClock,readAsioPlan,readAsioTail,readAsioRebuild,type AsioPreflightContext,type AsioSpan,type AsioPrepared,type AsioClock,type AsioTail,type AsioPlaybackPlan,type AsioRebuild,type AsioPlaybackView} from '../shared/asio-playback.js';
import type {PlaybackFileBinding,ProcessingPlan,AudioProcessing,PlaybackState} from '../shared/contracts.js';
// Raw DSD uses original bit ticks and bit rate here; it is never a PCM frame.
export interface AsioFrameBookmark {frame:string;sampleRate:number;fileBinding:PlaybackFileBinding;configurationRevision:number;backendRevision:number;dsd?:{settingRevision:number;transport:import('../shared/asio-dsd.js').DsdTransport;authorization:import('../shared/asio-dsd.js').DopAuthorization|null;startTick:string;endTick:string}}
export interface AsioRebuildRequest extends AsioFrameBookmark {itemId:string;token:number;reason:AsioRebuild['reason'];paused:boolean;generation:number}
export interface AsioRangeSpec {startCue:number|null;endCue:number|null;startSeconds:number;endSeconds:number|null;nextEndCue:number|null;boundaryCue:number|null;samples?:SamplePlayRange}
const same=(a:unknown,b:unknown):boolean=>{
 if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>same(a[i],v));
 if(b&&typeof b==='object')return !!a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===Object.keys(b).length&&Object.entries(b).every(([k,v])=>same((a as Record<string,unknown>)[k],v));return a===b;
};
const integerFrame=(value:number,rate:number):string=>{
 const n=Math.floor(value*rate);if(!Number.isSafeInteger(n)||n<0)throw new Error('ASIO 源秒范围不能安全换算为帧');return String(n);
};
const cueFrame=(value:number,rate:number):string=>{
 if(!Number.isSafeInteger(value)||value<0)throw new Error('ASIO CUE 范围无效');const n=BigInt(value)*BigInt(rate)/75n;if(n>0xffffffffffffffffn)throw new Error('ASIO CUE 范围溢出');return String(n);
};
export class AsioPlaybackTracker {
 prepared:AsioPrepared|null=null;span:AsioSpan|null=null;initialFrame='0';latestClock:AsioClock|null=null;latestTail:AsioTail|undefined;
 constructor(readonly context:Omit<AsioPreflightContext,'span'|'initialFrame'>,readonly range:AsioRangeSpec,readonly initialUs:number,readonly bookmark?:AsioFrameBookmark){}
 acceptPrepared(value:Record<string,unknown>):AsioPrepared{
  if(this.prepared)throw new Error('ASIO 正式计划不能重复准备');
  const source=value.decodedSource as Record<string,unknown>|undefined,rate=source?.sampleRate;
  if(typeof rate!=='number'||!Number.isSafeInteger(rate)||rate<8000||rate>1536000)throw new Error('ASIO 源采样率无效');
  const r=this.range,startFrame=r.startCue===null?integerFrame(r.startSeconds,rate):cueFrame(r.startCue,rate);
  const endFrame=r.boundaryCue!==null?r.nextEndCue===null?null:cueFrame(r.nextEndCue,rate):r.startCue!==null?r.endCue===null?null:cueFrame(r.endCue,rate):r.endSeconds===null?null:integerFrame(r.endSeconds,rate);
  this.span={...(r.samples?resolveSamplePlayRange(r.samples,rate):{startFrame,endFrame,boundaryFrame:r.boundaryCue===null?null:cueFrame(r.boundaryCue,rate)}),segmentIndex:0};
  this.initialFrame=this.bookmark?.frame??String(BigInt(Math.floor(this.initialUs/1000000))*BigInt(rate)+BigInt(this.initialUs%1000000)*BigInt(rate)/1000000n);
  const prepared=readAsioPrepared(value,{...this.context,span:this.span,initialFrame:this.initialFrame});
  if(this.bookmark&&(rate!==this.bookmark.sampleRate||this.context.preference.revision!==this.bookmark.configurationRevision||!same(prepared.decodedSource.fileBinding,this.bookmark.fileBinding)))throw new Error('ASIO 重建源绑定、采样率或驱动配置发生变化');
  this.prepared=prepared;this.latestClock=prepared.clock;return prepared;
 }
 processing(value:unknown):ProcessingPlan{
  const p=this.requirePrepared();return readProcessingPlan(value,processingPlan(this.context.settings,this.span?.segmentIndex===1?this.context.nextTags:this.context.tags,p.decodedSource.opusGain??null));
 }
 plan(value:unknown,gain:ProcessingPlan):AsioPlaybackPlan{
  const p=this.requirePrepared();const plan=readAsioPlan(value,this.context.preference,p.decodedSource,p.actualOutput,gain,this.span!);p.processingPlan=gain;p.asioPlan=plan;return plan;
 }
 clock(value:unknown,position:unknown):AsioClock{
  const p=this.requirePrepared();if(typeof position!=='number')throw new Error('ASIO 时钟位置缺失');
  const clock=readAsioClock(value,p.actualOutput,this.initialFrame,position),old=this.latestClock;
  if(old&&(['sourceFrame','callbackFrame','publishedMusicFrames'] as const).some(k=>BigInt(clock[k])<BigInt(old[k])))throw new Error('ASIO 播放计数或呈现位置回退');
  if(this.span!.endFrame!==null&&BigInt(clock.callbackFrame)>BigInt(this.span!.endFrame!)-BigInt(this.span!.startFrame))throw new Error('ASIO 播放位置越过源范围');
  this.latestClock=clock;return clock;
 }
 state(value:Record<string,unknown>,snapshot=false):{position:number;clock:AsioClock;processing:ProcessingPlan;plan:AsioPlaybackPlan}{
  const p=this.requirePrepared(),expected=['position','clock','output','requestedOutput','actualOutput','decodedSource','processingPlan','asioPlan','sourceStartPcmFrame','sourceEndPcmFrame','cueBoundaryPcmFrame','state',...(snapshot?['tail']:[])];
  if(Object.keys(value).length!==expected.length||expected.some(k=>!Object.hasOwn(value,k))||!same(value.requestedOutput,p.requestedOutput)||!same(value.actualOutput,p.actualOutput)||!same(value.decodedSource,p.decodedSource)||value.output!==p.output||value.sourceStartPcmFrame!==this.span!.startFrame||value.sourceEndPcmFrame!==this.span!.endFrame||value.cueBoundaryPcmFrame!==this.span!.boundaryFrame)throw new Error('ASIO 活动状态来源、输出或范围发生变化');
  const gain=this.processing(value.processingPlan),plan=this.plan(value.asioPlan,gain),clock=this.clock(value.clock,value.position);return {position:value.position as number,clock,processing:gain,plan};
 }
 tail(value:unknown):AsioTail{
  const tail=readAsioTail(value,this.requirePrepared().actualOutput,this.initialFrame,this.latestTail);
  if(this.latestClock&&BigInt(tail.sourceFrame)<BigInt(this.latestClock.sourceFrame)||this.span!.endFrame!==null&&BigInt(tail.sourceFrame)>BigInt(this.span!.endFrame!)-BigInt(this.span!.startFrame))throw new Error('ASIO 尾部源范围与活动位置冲突');
  this.latestTail=tail;return tail;
 }
 boundary(value:Record<string,unknown>):void{
  const span=this.span;if(!span||span.segmentIndex!==0||span.boundaryFrame===null||value.sourcePcmFrame!==span.boundaryFrame||value.relativePcmFrame!==String(BigInt(span.boundaryFrame)-BigInt(span.startFrame)))throw new Error('ASIO CUE 边界回执无效');
  if(typeof value.position!=='number'||value.position<Number(BigInt(span.boundaryFrame)-BigInt(span.startFrame))/this.requirePrepared().actualOutput.sampleRate)throw new Error('ASIO CUE 边界尚未到达呈现位置');span.segmentIndex=1;
 }
 rebuild(value:unknown):AsioRebuild{return readAsioRebuild(value,this.requirePrepared().asioPlan);}
 setVolume(settings:AudioProcessing):void{this.context.settings={...settings};}
 view(generation:number):AsioPlaybackView{
  const p=this.requirePrepared();return {output:p.actualOutput,requestedOutput:p.requestedOutput,plan:p.asioPlan,clock:this.latestClock!,tail:this.latestTail,generation,receivedAt:Date.now()};
 }
 private requirePrepared():AsioPrepared{if(!this.prepared)throw new Error('ASIO 尚未核对正式播放计划');return this.prepared;}
}
export function asAsioCounter(value:unknown,previous?:string):string{
 if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value)||BigInt(value)>0xffffffffffffffffn||previous!==undefined&&BigInt(value)<BigInt(previous))throw new Error('ASIO 处理计数无效');return value;
}
