import {isDeepStrictEqual} from 'node:util';
import {readAsioDsdRequest,readAsioDsdPrepared,readAsioDsdState,readAsioDsdClock,readAsioDsdPosition,readAsioDsdTail,readAsioDsdRebuild,resolveDsdRange,type AsioDsdRequest,type AsioDsdPrepared,type AsioDsdClock,type AsioDsdTail,type AsioDsdPosition,type AsioDsdPlaybackView,type DsdTransport} from '../shared/asio-dsd.js';
import {selectedDopAuthorization,type DsdOutputPreference} from '../shared/dsd-output.js';
import {ASIO_DSD_QUERY_RATES,type AsioOutputPreference} from '../shared/asio-output.js';
import type {LibraryItem} from '../shared/contracts.js';
import type {AsioFrameBookmark} from './asio-playback-state.js';

const units=(value:number):string=>{if(!Number.isSafeInteger(value)||value<0)throw new Error('DSD 源范围无法安全换算');return String(value);};
export function buildDsdRequest(item:LibraryItem,transport:DsdTransport,asio:AsioOutputPreference,preference:DsdOutputPreference,initialUs:number,initialPaused:boolean,bookmark?:AsioFrameBookmark):AsioDsdRequest {
 if(!asio.driver)throw new Error('DSD 原始输出需要明确的 ASIO 驱动与声道映射');
 const source={bitRate:(ASIO_DSD_QUERY_RATES as readonly number[]).includes(item.sampleRate??0)?item.sampleRate!:0,channels:asio.outputChannels.length,
  ...(item.sourceStartCueFrame!==null?{timebase:'cue-75' as const,start:units(item.sourceStartCueFrame),end:item.sourceEndCueFrame===null?null:units(item.sourceEndCueFrame)}:
   {timebase:'microseconds' as const,start:units(Math.floor(item.sourceStartSeconds*1000000)),end:item.sourceEndSeconds===null?null:units(Math.floor(item.sourceEndSeconds*1000000))}),initialUs:units(initialUs)};
 const authorization=transport==='dop'?selectedDopAuthorization(preference):null;
 if(bookmark){
  if(!bookmark.dsd||bookmark.dsd.settingRevision>preference.revision||bookmark.dsd.transport!==transport||!isDeepStrictEqual(bookmark.dsd.authorization,authorization))throw new Error('DSD 重建输出预设或设备档案已变化');
  const expected=resolveDsdRange({...source,initialUs:'0'},bookmark.sampleRate,bookmark.dsd.endTick);
  if(expected.startTick!==bookmark.dsd.startTick||expected.endTick!==bookmark.dsd.endTick)throw new Error('DSD 重建源范围与曲库编排已变化');
 }
 return readAsioDsdRequest({backend:'asio',transport,path:item.path,asio:{configurationRevision:asio.revision,driver:{registryName:asio.driver.registryName,clsid:asio.driver.clsid},outputChannels:[...asio.outputChannels],bufferFrames:asio.bufferFrames},
  source:bookmark?{bitRate:bookmark.sampleRate,channels:source.channels,startTick:bookmark.dsd!.startTick,endTick:bookmark.dsd!.endTick,initialTick:bookmark.frame}:source,
  initialPaused,dopAuthorization:authorization,expectedFile:bookmark?.fileBinding??null});
}

export class AsioDsdPlaybackTracker {
 prepared:AsioDsdPrepared|null=null;latestClock:AsioDsdClock|null=null;latestTail:AsioDsdTail|undefined;latestPosition:AsioDsdPosition|null=null;
 constructor(readonly request:AsioDsdRequest,readonly settingRevision:number,readonly sessionId:string,readonly nonce:string,readonly initialBookmark?:AsioFrameBookmark){}
 acceptPrepared(value:unknown):AsioDsdPrepared {
  if(this.prepared)throw new Error('DSD 正式计划不能重复准备');
  const p=readAsioDsdPrepared(value,this.request,this.sessionId,this.nonce);
  if(this.initialBookmark&&(this.initialBookmark.sampleRate!==p.source.bitRate||!isDeepStrictEqual(this.initialBookmark.fileBinding,p.source.fileBinding)))throw new Error('DSD 重建源文件绑定或速率已变化');
  this.prepared=p;this.latestClock=p.clock;return p;
 }
 private acceptClock(value:AsioDsdClock):void {
  const old=this.latestClock;if(old&&(['sourceTick','callbackTick','publishedMusicFrames'] as const).some(key=>BigInt(value[key])<BigInt(old[key])))throw new Error('DSD 活动时钟或位数计数回退');this.latestClock=value;
 }
 state(value:unknown):ReturnType<typeof readAsioDsdState>{const next=readAsioDsdState(value,this.requirePrepared());this.acceptClock(next.clock);return next;}
 position(value:unknown):AsioDsdPosition {const p=readAsioDsdPosition(value,this.requirePrepared().dsdPlan,this.latestPosition);this.acceptClock(p.clock);this.latestPosition=p;return p;}
 tail(value:unknown):AsioDsdTail {
  const next=readAsioDsdTail(value,this.requirePrepared().dsdPlan),old=this.latestTail;
  if(old&&(old.status==='completed'&&next.status!=='completed'||old.targetDeviceFrame!==next.targetDeviceFrame))throw new Error('DSD 曲尾阶段或目标发生变化');this.latestTail=next;return next;
 }
 rebuild(value:unknown):ReturnType<typeof readAsioDsdRebuild>{return readAsioDsdRebuild(value,this.requirePrepared().dsdPlan);}
 snapshot(value:Record<string,unknown>):ReturnType<typeof readAsioDsdState>{
  if(Object.keys(value).length!==9||!Object.hasOwn(value,'tail'))throw new Error('DSD 快照字段无效');const {tail,...state}=value,next=this.state(state);
  if(tail!==null)this.tail(tail);else if(this.latestTail)throw new Error('DSD 快照撤销了已进入的曲尾');return next;
 }
 bookmark(frame:string,backendRevision:number):AsioFrameBookmark {
  const p=this.requirePrepared();return {frame,sampleRate:p.source.bitRate,fileBinding:p.source.fileBinding,configurationRevision:this.request.asio.configurationRevision,backendRevision,
   dsd:{settingRevision:this.settingRevision,transport:this.request.transport,authorization:structuredClone(this.request.dopAuthorization),startTick:p.dsdPlan.range.startTick,endTick:p.dsdPlan.range.endTick}};
 }
 view(generation:number):AsioDsdPlaybackView {
  const p=this.requirePrepared(),v=this.latestPosition;return {request:this.request,source:p.source,output:p.actualOutput,plan:p.dsdPlan,clock:this.latestClock!,tail:this.latestTail,
   counts:v?{publishedSourceBits:v.publishedSourceBits,callbackCount:v.callbackCount,underrunFrames:v.underrunFrames}:undefined,generation,receivedAt:Date.now()};
 }
 private requirePrepared():AsioDsdPrepared {if(!this.prepared)throw new Error('DSD 尚未核对正式播放计划');return this.prepared;}
}
