import {readDecoderContainer} from './media-capabilities.js';
import type {PlaybackState,ProcessingPlan,AudioProcessing,ReplayGainTags} from './contracts.js';
import {readSourceEvidence} from './decoder-source.js';
import {readPlaybackFile} from './playback-file.js';
import {validDsdPcmConversion} from './dsd-pcm.js';
import {validateOpusGain,processingPlan,readProcessingPlan} from './audio-processing.js';
import {sameAsioDriver,validateAsioOutputPreference,validateAsioDriverIdentity,validateAsioChannel,type AsioDriverIdentity,type AsioChannel,type AsioOutputPreference} from './asio-output.js';

export type AsioDecodedSource=NonNullable<PlaybackState['decodedSource']>;
export interface AsioActualOutput {
 backend:'asio';identity:AsioDriverIdentity;driverName:string;driverVersion:number;format:'s16'|'s32'|'f32';validBits:number;
 sampleRate:number;channels:AsioChannel[];bufferFrames:number;outputLatencyFrames:number;numericConversion:boolean;
 exactPackingCandidate:boolean;allowConversion:boolean;hardwareVerified:false;
}
export interface AsioSpan {startFrame:string;endFrame:string|null;boundaryFrame:string|null;segmentIndex:0|1}
export interface AsioPlaybackPlan {
 version:1;backend:'asio';transport:'pcm';configurationRevision:number;source:AsioDecodedSource;output:AsioActualOutput;
 processing:ProcessingPlan;span:AsioSpan;buffers:{preReadFrames:string;preReadBytes:number;deviceFrames:number;scratchBytes:number};
 stages:string[];encodedQuality:'lossless'|'lossy'|'dsd-converted'|'unknown';clockPolicy:'asio-callback-position-plus-output-latency';
 tailPolicy:'driver-clock-or-reported-latency-estimate';hardwareVerified:false;bitPerfectVerified:false;
}
export interface AsioClock {
 version:1;backend:'asio';authority:'paused-bookmark'|'driver-reported'|'callback-estimate';sourceFrame:string;callbackFrame:string;
 sourceSampleRate:number;devicePosition:string|null;systemTimeNs:string|null;outputLatencyFrames:number;publishedMusicFrames:string;hardwareVerified:false;
}
export interface AsioTail {
 version:1;backend:'asio';status:'draining'|'completed';evidence:'pending'|'driver-clock'|'driver-latency-period-estimate';sourceFrame:string;sourceSampleRate:number;
 targetDeviceFrame:string|null;outputLatencyFrames:number;bufferFrames:number;elapsedMs:number;driverPosition:string|null;driverStopped:boolean;hardwareVerified:false;
}
export interface AsioRebuild {reason:'pause'|'seek'|'driver-reconfigure';positionFrame:string;positionUs:string;sourceSampleRate:number;desiredState:'paused'|'playing';driverReleased:true;hardwareVerified:false}
export interface AsioPrepared {
 planToken:string;initialPaused:boolean;state:'preparing';position:number;clock:AsioClock;output:string;requestedOutput:Record<string,unknown>;
 actualOutput:AsioActualOutput;decodedSource:AsioDecodedSource;processingPlan:ProcessingPlan;asioPlan:AsioPlaybackPlan;
 sourceStartPcmFrame:string;sourceEndPcmFrame:string|null;cueBoundaryPcmFrame:string|null;
}
export interface AsioPreflightContext {
 sessionId:string;nonce:string;preference:AsioOutputPreference;span:AsioSpan;initialFrame:string;initialPaused:boolean;dsdPolicy:'stop'|'pcm';
 settings:AudioProcessing;tags:ReplayGainTags|null;nextTags:ReplayGainTags|null;tagStamp:string|null;
}
export interface AsioPlaybackView {output:AsioActualOutput;requestedOutput:Record<string,unknown>;plan:AsioPlaybackPlan;clock:AsioClock;tail?:AsioTail;generation:number;receivedAt:number;packingCounts?:{saturatedSamples:string;nonfiniteSamples:string}}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value:unknown,list:string[]):value is Record<string,unknown>=>object(value)&&Object.keys(value).length===list.length&&list.every(key=>Object.hasOwn(value,key));
const int=(value:unknown,min:number,max:number):value is number=>Number.isSafeInteger(value)&&(value as number)>=min&&(value as number)<=max;
const frame=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(value)&&BigInt(value)<=0xffffffffffffffffn;
const same=(a:unknown,b:unknown):boolean=>{
 if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>same(a[i],v));
 if(object(b))return object(a)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>same(a[k],b[k]));
 return a===b;
};
export function asioSessionConfiguration(value:unknown):{configurationRevision:number;registryName:string;clsid:string;outputChannels:number[];bufferFrames:number;allowConversion:boolean} {
 const p=validateAsioOutputPreference(value);if(!p.driver)throw new Error('ASIO 首选驱动尚未选择');
 return {configurationRevision:p.revision,registryName:p.driver.registryName,clsid:p.driver.clsid,outputChannels:[...p.outputChannels],bufferFrames:p.bufferFrames,allowConversion:p.allowConversion};
}
export function readAsioDecodedSource(value:unknown,dsdPolicy:'stop'|'pcm',allowConversion:boolean,tagStamp:string|null):AsioDecodedSource {
 if(!keys(value,['backend','codec','format','sampleRate','channels','certification','media','fileBinding','dsdConversion','opusGain',...(value&&typeof value==='object'&&Object.hasOwn(value,'container')?['container']:[])])||!['miniaudio','ffmpeg-8.1.3'].includes(String(value.backend))||typeof value.codec!=='string'||!value.codec.length||value.codec.length>64||/[\u0000-\u001f\u007f]/.test(value.codec)||!['s16','s32','f32'].includes(String(value.format))||!int(value.sampleRate,8000,1536000)||!int(value.channels,1,16)||value.certification!=='pending')throw new Error('ASIO 解码来源回执无效');
 const source=structuredClone(value) as unknown as AsioDecodedSource;
 if(source.container!==undefined)source.container=readDecoderContainer(source.container,source);
 source.media=readSourceEvidence(value.media,source);source.fileBinding=readPlaybackFile(value.fileBinding,tagStamp);
 if(source.codec.startsWith('dsd_')){
  if(!validDsdPcmConversion(value.dsdConversion)||source.backend!=='ffmpeg-8.1.3'||source.format!=='f32'||source.sampleRate!==176400||dsdPolicy!=='pcm'||!allowConversion)throw new Error('ASIO DSD 转 PCM 来源或授权无效');
 }else if(value.dsdConversion!==null)throw new Error('ASIO 普通 PCM 来源携带 DSD 转换');
 if(source.codec==='opus'){
  if(source.backend!=='ffmpeg-8.1.3'||source.format!=='f32'||source.sampleRate!==48000)throw new Error('ASIO Opus 解码格式无效');source.opusGain=validateOpusGain(value.opusGain);
 }else if(value.opusGain!==null)throw new Error('ASIO 非 Opus 来源携带 Opus 增益');
 return source;
}
export function readAsioActualOutput(value:unknown,preference:AsioOutputPreference,source:AsioDecodedSource):AsioActualOutput {
 const p=validateAsioOutputPreference(preference);
 if(!p.driver||!keys(value,['backend','identity','driverName','driverVersion','format','validBits','sampleRate','channels','bufferFrames','outputLatencyFrames','numericConversion','exactPackingCandidate','allowConversion','hardwareVerified']))throw new Error('ASIO 实际输出回执无效');
 const identity=validateAsioDriverIdentity(value.identity),bits=source.format==='f32'?32:source.media?.validBits??(source.format==='s16'?16:32);
 if(value.backend!=='asio'||!sameAsioDriver(identity,p.driver)||typeof value.driverName!=='string'||value.driverName.length>256||/[\u0000-\u001f\u007f]/.test(value.driverName)||!int(value.driverVersion,-2147483648,2147483647)||value.format!==source.format||value.validBits!==bits||bits>(source.format==='s16'?16:32)||value.sampleRate!==source.sampleRate||!Array.isArray(value.channels)||value.channels.length!==source.channels||value.channels.length!==p.outputChannels.length||!int(value.bufferFrames,1,32768)||p.bufferFrames!==0&&p.bufferFrames!==value.bufferFrames||!int(value.outputLatencyFrames,0,source.sampleRate*5)||value.allowConversion!==p.allowConversion||value.hardwareVerified!==false)throw new Error('ASIO 实际驱动、源格式、映射、缓冲或延迟与命令冲突');
 const channels=value.channels.map((v,i)=>validateAsioChannel(v,p.outputChannels[i]));if(channels.some(c=>!c.containerBytes))throw new Error('ASIO 实际 PCM 声道容器无效');
 const exact=channels.every(c=>source.format==='f32'?c.floating&&c.validBits===32:!c.floating&&c.validBits>=bits);
 if(value.exactPackingCandidate!==exact||value.numericConversion!==!exact||!p.allowConversion&&!exact)throw new Error('ASIO 实际精度转换未授权或与格式不符');
 return {backend:'asio',identity,driverName:value.driverName,driverVersion:value.driverVersion,format:source.format,validBits:bits,sampleRate:source.sampleRate,channels,bufferFrames:value.bufferFrames,outputLatencyFrames:value.outputLatencyFrames,numericConversion:!exact,exactPackingCandidate:exact,allowConversion:p.allowConversion,hardwareVerified:false};
}
export function readAsioPlan(value:unknown,preference:AsioOutputPreference,source:AsioDecodedSource,output:AsioActualOutput,processing:ProcessingPlan,span:AsioSpan):AsioPlaybackPlan {
 if(!keys(value,['version','backend','transport','configurationRevision','source','output','processing','span','buffers','stages','encodedQuality','clockPolicy','tailPolicy','hardwareVerified','bitPerfectVerified'])||value.version!==1||value.backend!=='asio'||value.transport!=='pcm'||value.configurationRevision!==preference.revision||!same(value.source,source)||!same(value.output,output)||!same(value.processing,processing)||!same(value.span,span)||value.clockPolicy!=='asio-callback-position-plus-output-latency'||value.tailPolicy!=='driver-clock-or-reported-latency-estimate'||value.hardwareVerified!==false||value.bitPerfectVerified!==false)throw new Error('ASIO 正式播放计划身份、来源或策略不一致');
 if(!frame(span.startFrame)||span.endFrame!==null&&(!frame(span.endFrame)||BigInt(span.endFrame)<=BigInt(span.startFrame))||span.boundaryFrame!==null&&(!frame(span.boundaryFrame)||BigInt(span.boundaryFrame)<=BigInt(span.startFrame)||span.endFrame===null||BigInt(span.boundaryFrame)>=BigInt(span.endFrame))||![0,1].includes(span.segmentIndex)||span.segmentIndex===1&&span.boundaryFrame===null)throw new Error('ASIO 播放计划范围无效');
 if(processing.enabled&&(!preference.allowConversion||source.format!=='f32'))throw new Error('ASIO 音频处理未授权或缺少浮点路径');
 const b=value.buffers,bytes=source.channels*(source.format==='s16'?2:4);
 const capacity=Math.min(Math.max(4096,source.sampleRate*2),Math.floor(32*1024*1024/bytes));
 const scratch=output.bufferFrames*(bytes+output.channels.reduce((sum,c)=>sum+c.containerBytes,0));
 if(!keys(b,['preReadFrames','preReadBytes','deviceFrames','scratchBytes'])||b.preReadFrames!==String(capacity)||b.preReadBytes!==capacity*bytes||b.deviceFrames!==output.bufferFrames||b.scratchBytes!==scratch||scratch>8*1024*1024)throw new Error('ASIO 播放计划缓冲几何或预算无效');
 const encoding=source.media?.encoding,quality=encoding==='lossy'?'lossy':encoding==='dsd'?'dsd-converted':encoding==='unknown'?'unknown':'lossless';
 if(value.encodedQuality!==quality||!same(value.stages,['bound-file-decoder','bounded-pcm-ring',source.format==='f32'?'float-envelope':'integer-unity','asio-pcm-pack','asio-double-buffer']))throw new Error('ASIO 播放计划处理节点或源编码质量不符');
 return structuredClone(value) as unknown as AsioPlaybackPlan;
}
export function readAsioClock(value:unknown,output:AsioActualOutput,initialFrame:string,position:number):AsioClock {
 if(!keys(value,['version','backend','authority','sourceFrame','callbackFrame','sourceSampleRate','devicePosition','systemTimeNs','outputLatencyFrames','publishedMusicFrames','hardwareVerified'])||value.version!==1||value.backend!=='asio'||!['paused-bookmark','driver-reported','callback-estimate'].includes(String(value.authority))||!frame(value.sourceFrame)||!frame(value.callbackFrame)||!frame(value.publishedMusicFrames)||!frame(initialFrame)||value.sourceSampleRate!==output.sampleRate||value.outputLatencyFrames!==output.outputLatencyFrames||value.hardwareVerified!==false||BigInt(value.sourceFrame)<BigInt(initialFrame)||BigInt(value.sourceFrame)>BigInt(value.callbackFrame)||BigInt(value.publishedMusicFrames)>BigInt(value.callbackFrame)-BigInt(initialFrame)||!Number.isFinite(position)||position<0||Math.abs(Number(value.sourceFrame)/output.sampleRate-position)>1/output.sampleRate)throw new Error('ASIO 呈现时钟范围或实际输出不符');
 if(value.authority==='driver-reported'){
  if(!frame(value.devicePosition)||!frame(value.systemTimeNs))throw new Error('ASIO 驱动时钟位置与时间无效');
 }else if(value.devicePosition!==null||value.systemTimeNs!==null||value.authority==='paused-bookmark'&&value.sourceFrame!==initialFrame)throw new Error('ASIO 时钟证据或暂停书签不符');
 return structuredClone(value) as unknown as AsioClock;
}
export function readAsioTail(value:unknown,output:AsioActualOutput,initialFrame:string,previous?:AsioTail):AsioTail {
 if(!keys(value,['version','backend','status','evidence','sourceFrame','sourceSampleRate','targetDeviceFrame','outputLatencyFrames','bufferFrames','elapsedMs','driverPosition','driverStopped','hardwareVerified'])||value.version!==1||value.backend!=='asio'||!['draining','completed'].includes(String(value.status))||!frame(value.sourceFrame)||!frame(initialFrame)||BigInt(value.sourceFrame)<=BigInt(initialFrame)||value.sourceSampleRate!==output.sampleRate||value.outputLatencyFrames!==output.outputLatencyFrames||value.bufferFrames!==output.bufferFrames||!int(value.elapsedMs,0,30000)||value.hardwareVerified!==false||value.targetDeviceFrame!==null&&!frame(value.targetDeviceFrame))throw new Error('ASIO 歌曲尾部范围或输出参数无效');
 if(previous&&(value.sourceFrame!==previous.sourceFrame||value.targetDeviceFrame!==previous.targetDeviceFrame||value.elapsedMs<previous.elapsedMs||previous.status==='completed'&&value.status!=='completed'))throw new Error('ASIO 歌曲尾部范围或状态回退');
 if(value.status==='draining'){
  if(value.evidence!=='pending'||value.driverStopped!==false||value.driverPosition!==null)throw new Error('ASIO 未完成尾部不能确认驱动停止');
 }else{
  if(value.driverStopped!==true)throw new Error('ASIO 完成尾部缺少驱动释放确认');
  if(value.evidence==='driver-clock'){
   if(!frame(value.targetDeviceFrame)||!frame(value.driverPosition)||BigInt(value.driverPosition)<BigInt(value.targetDeviceFrame))throw new Error('ASIO 尾部驱动时钟未达到最后音乐样本');
  }else if(value.evidence!=='driver-latency-period-estimate'||value.driverPosition!==null||value.elapsedMs<Math.ceil((output.outputLatencyFrames*1000+output.bufferFrames*3000)/output.sampleRate)+100)throw new Error('ASIO 尾部估计未达到声明等待预算');
 }
 return structuredClone(value) as unknown as AsioTail;
}
export function readAsioRebuild(value:unknown,plan:AsioPlaybackPlan):AsioRebuild {
 if(!keys(value,['reason','positionFrame','positionUs','sourceSampleRate','desiredState','driverReleased','hardwareVerified'])||!['pause','seek','driver-reconfigure'].includes(String(value.reason))||!frame(value.positionFrame)||!frame(value.positionUs)||BigInt(value.positionUs)>BigInt(Number.MAX_SAFE_INTEGER)||value.sourceSampleRate!==plan.output.sampleRate||!['paused','playing'].includes(String(value.desiredState))||value.reason==='pause'&&value.desiredState!=='paused'||value.driverReleased!==true||value.hardwareVerified!==false)throw new Error('ASIO 会话重建回执无效');
 const frameValue=BigInt(value.positionFrame),rate=BigInt(plan.output.sampleRate),us=frameValue/rate*1000000n+frameValue%rate*1000000n/rate;
 if(us!==BigInt(value.positionUs)||plan.span.endFrame!==null&&frameValue>=BigInt(plan.span.endFrame)-BigInt(plan.span.startFrame))throw new Error('ASIO 重建书签范围或时间基不符');
 return structuredClone(value) as unknown as AsioRebuild;
}
export function readAsioPrepared(value:unknown,context:AsioPreflightContext):AsioPrepared {
 if(!keys(value,['planToken','initialPaused','state','position','clock','output','requestedOutput','actualOutput','decodedSource','processingPlan','asioPlan','sourceStartPcmFrame','sourceEndPcmFrame','cueBoundaryPcmFrame'])||value.planToken!==`${context.sessionId}-${context.nonce}-asio-pcm-1`||value.initialPaused!==context.initialPaused||value.state!=='preparing'||!frame(context.initialFrame)||!Number.isFinite(value.position)||typeof value.position!=='number'||typeof value.output!=='string'||!value.output.length||value.output.length>1024||value.sourceStartPcmFrame!==context.span.startFrame||value.sourceEndPcmFrame!==context.span.endFrame||value.cueBoundaryPcmFrame!==context.span.boundaryFrame)throw new Error('ASIO 播放前准备回执身份、阶段或范围无效');
 const preference=validateAsioOutputPreference(context.preference);if(!preference.driver)throw new Error('ASIO 播放前驱动配置为空');
 const expected={backend:'asio',mode:'exclusive',driver:{registryName:preference.driver.registryName,clsid:preference.driver.clsid},configurationRevision:preference.revision,outputChannels:preference.outputChannels,bufferFrames:preference.bufferFrames,allowConversion:preference.allowConversion,dsdPolicy:context.dsdPolicy};
 if(!same(value.requestedOutput,expected))throw new Error('ASIO 请求输出与预备命令不符');
 const source=readAsioDecodedSource(value.decodedSource,context.dsdPolicy,preference.allowConversion,context.tagStamp),output=readAsioActualOutput(value.actualOutput,preference,source);
 const processing=readProcessingPlan(value.processingPlan,processingPlan(context.settings,context.span.segmentIndex===1?context.nextTags:context.tags,source.opusGain??null));
 const plan=readAsioPlan(value.asioPlan,preference,source,output,processing,context.span),clock=readAsioClock(value.clock,output,context.initialFrame,value.position);
 if(clock.authority!=='paused-bookmark'||clock.publishedMusicFrames!=='0'||clock.callbackFrame!==context.initialFrame||Math.abs(value.position-Number(context.initialFrame)/output.sampleRate)>0.5/output.sampleRate)throw new Error('ASIO 在正式计划批准前已消费源音乐或初始位置冲突');
 return {planToken:value.planToken as string,initialPaused:context.initialPaused,state:'preparing',position:value.position,clock,output:value.output,requestedOutput:expected,
  actualOutput:output,decodedSource:source,processingPlan:processing,asioPlan:plan,sourceStartPcmFrame:context.span.startFrame,sourceEndPcmFrame:context.span.endFrame,cueBoundaryPcmFrame:context.span.boundaryFrame};
}
