import type {PlaybackFileBinding} from './contracts.js';
import {readPlaybackFile} from './playback-file.js';
import {ASIO_DSD_QUERY_RATES,sameAsioDriver,validateAsioChannel,validateAsioDriverIdentity,validateAsioDriverKey,type AsioChannel,type AsioDriverKey,type AsioDriverIdentity} from './asio-output.js';

export type DsdTransport='native-dsd'|'dop';
export interface DopAuthorization {
 kind:'userConfigured';profileId:string;revision:number;driver:AsioDriverKey;driverVersion:number;dacName:string;
 supportedBitRates:number[];outputChannels:number[];evidenceText:string;documentConfirmed:true;volumeConfirmed:true;hardwareVerified:false;
}
export interface DsdRangeRequest {bitRate:number;channels:number;startTick:string;endTick:string|null;initialTick:string}
export interface DsdTimeRangeRequest {bitRate:number;channels:number;timebase:'microseconds'|'cue-75';start:string;end:string|null;initialUs:string}
export interface AsioDsdRequest {
 backend:'asio';transport:DsdTransport;path:string;asio:{configurationRevision:number;driver:AsioDriverKey;outputChannels:number[];bufferFrames:number};
 source:DsdRangeRequest|DsdTimeRangeRequest;initialPaused:boolean;dopAuthorization:DopAuthorization|null;expectedFile:PlaybackFileBinding|null;
}
export interface AsioDsdSource {
 kind:'dsd-msb-first-interleaved';container:'dsf'|'dff';bitRate:number;channels:number;totalTicks:string;layoutCode:number;channelTags:number[];
 storage:{planar:boolean;lsbFirst:boolean;blockBytes:number};payload:{offset:string;bytes:string};fileBinding:PlaybackFileBinding;
}
export interface AsioDsdOutput {
 backend:'asio';identity:AsioDriverIdentity;driverName:string;driverVersion:number;transport:DsdTransport;bitRate:number;deviceSampleRate:number;
 deviceFrameUnit:'dsd-bit'|'pcm-carrier';channels:AsioChannel[];bufferFrames:number;byteFramesPerBuffer:number;outputLatencyFrames:number;
 numericConversion:false;softwareGain:false;nativeDsdModeReported:boolean;dopUserConfigured:boolean;hardwareVerified:false;
}
export interface AsioDsdPlan {
 version:1;backend:'asio';transport:DsdTransport;configurationRevision:number;source:AsioDsdSource;output:AsioDsdOutput;dopAuthorization:DopAuthorization|null;
 range:{startTick:string;endTick:string;initialTick:string};buffers:{preReadByteFrames:string;preReadBytes:number;byteFramesPerBuffer:number;scratchBytes:number};
 stages:string[];clockPolicy:'bit-ticks-via-driver-frames-and-output-latency';tailPolicy:'driver-clock-or-reported-latency-estimate';hardwareVerified:false;bitPerfectVerified:false;
}
export interface AsioDsdClock {
 version:1;transport:DsdTransport;authority:'paused-bookmark'|'driver-reported'|'callback-estimate';sourceTick:string;callbackTick:string;bitRate:number;
 deviceFrameUnit:'dsd-bit'|'pcm-carrier';deviceSampleRate:number;devicePosition:string|null;systemTimeNs:string|null;outputLatencyFrames:number;publishedMusicFrames:string;hardwareVerified:false;
}
export interface AsioDsdTail {
 version:1;transport:DsdTransport;status:'draining'|'completed';evidence:'pending'|'driver-clock'|'driver-latency-period-estimate';sourceTick:string;bitRate:number;
 deviceFrameUnit:'dsd-bit'|'pcm-carrier';targetDeviceFrame:string|null;outputLatencyFrames:number;bufferFrames:number;elapsedMs:number;driverPosition:string|null;
 driverReleased:boolean;sourceReleased:boolean;hardwareVerified:false;
}
export interface AsioDsdRebuild {
 reason:'pause'|'seek'|'driver-reconfigure';positionTick:string;positionUs:string;bitRate:number;startTick:string;endTick:string;fileBinding:PlaybackFileBinding;
 configurationRevision:number;desiredState:'paused'|'playing';driverReleased:true;sourceReleased:true;hardwareVerified:false;
}
export interface AsioDsdPrepared {
 state:'preparing';position:number;clock:AsioDsdClock;output:string;requestedOutput:AsioDsdRequest['asio'];source:AsioDsdSource;actualOutput:AsioDsdOutput;
 dsdPlan:AsioDsdPlan;initialPaused:boolean;planToken:string;
}
export interface AsioDsdState {state:'playing'|'paused';position:number;clock:AsioDsdClock;output:string;requestedOutput:AsioDsdRequest['asio'];source:AsioDsdSource;actualOutput:AsioDsdOutput;dsdPlan:AsioDsdPlan}
export interface AsioDsdPosition {position:number;clock:AsioDsdClock;publishedSourceBits:string;callbackCount:string;underrunFrames:string}
export interface AsioDsdPlaybackView {request:AsioDsdRequest;source:AsioDsdSource;output:AsioDsdOutput;plan:AsioDsdPlan;clock:AsioDsdClock;tail?:AsioDsdTail;counts?:Omit<AsioDsdPosition,'position'|'clock'>;generation:number;receivedAt:number}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:unknown,names:string[]):v is Record<string,unknown>=>object(v)&&Object.keys(v).length===names.length&&names.every(name=>Object.hasOwn(v,name));
const int=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const count=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=0xffffffffffffffffn;
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.length>0)&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const rate=(v:unknown):v is number=>typeof v==='number'&&(ASIO_DSD_QUERY_RATES as readonly number[]).includes(v);
const mapping=(v:unknown):v is number[]=>Array.isArray(v)&&v.length>=1&&v.length<=16&&v.every(n=>int(n,0,4095))&&new Set(v).size===v.length;
const same=(a:unknown,b:unknown):boolean=>Array.isArray(b)?Array.isArray(a)&&a.length===b.length&&b.every((v,i)=>same(a[i],v)):object(b)?object(a)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(k=>same(a[k],b[k])):a===b;
const fail=(message:string):never=>{throw new Error(message);};
const quantum=(p:AsioDsdPlan):bigint=>p.transport==='dop'?16n:1n;
export function dsdTicksToUs(ticks:string,bitRate:number):string {
 if(!count(ticks)||!rate(bitRate))return fail('DSD 时间基无效');
 const value=BigInt(ticks)*1000000n/BigInt(bitRate);if(value>BigInt(Number.MAX_SAFE_INTEGER))return fail('DSD 时间超过播放协议范围');return value.toString();
}
export function readDopAuthorization(value:unknown):DopAuthorization {
 if(!keys(value,['kind','profileId','revision','driver','driverVersion','dacName','supportedBitRates','outputChannels','evidenceText','documentConfirmed','volumeConfirmed','hardwareVerified'])||
  value.kind!=='userConfigured'||typeof value.profileId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value.profileId)||!int(value.revision)||
  !int(value.driverVersion,-2147483648,2147483647)||!text(value.dacName,256)||!text(value.evidenceText,1024)||
  !Array.isArray(value.supportedBitRates)||value.supportedBitRates.length<1||value.supportedBitRates.length>3||!value.supportedBitRates.every(rate)||new Set(value.supportedBitRates).size!==value.supportedBitRates.length||
  !mapping(value.outputChannels)||value.documentConfirmed!==true||value.volumeConfirmed!==true||value.hardwareVerified!==false)return fail('DoP 设备档案确认无效');
 if(!(value.dacName as string).trim()||!(value.evidenceText as string).trim())return fail('DoP 设备名称或资料证据不能为空白');
 return {kind:'userConfigured',profileId:value.profileId.toLowerCase(),revision:value.revision,driver:validateAsioDriverKey(value.driver),driverVersion:value.driverVersion,
  dacName:value.dacName as string,supportedBitRates:[...value.supportedBitRates] as number[],outputChannels:[...value.outputChannels],evidenceText:value.evidenceText as string,
  documentConfirmed:true,volumeConfirmed:true,hardwareVerified:false};
}
export function readAsioDsdRequest(value:unknown):AsioDsdRequest {
 if(!keys(value,['backend','transport','path','asio','source','initialPaused','dopAuthorization','expectedFile'])||value.backend!=='asio'||typeof value.transport!=='string'||!['native-dsd','dop'].includes(value.transport)||
  !text(value.path,32767)||!/^(?:[a-z]:[\\/]|\\\\)/i.test(value.path)||typeof value.initialPaused!=='boolean'||
  !keys(value.asio,['configurationRevision','driver','outputChannels','bufferFrames'])||!int(value.asio.configurationRevision)||!mapping(value.asio.outputChannels)||!int(value.asio.bufferFrames,0,32768)||
  !object(value.source)||(value.source.bitRate!==0&&!rate(value.source.bitRate))||!int(value.source.channels,1,16)||
  value.source.channels!==value.asio.outputChannels.length)return fail('DSD 播放请求无效');
 const range=value.source;
 if(Object.hasOwn(range,'startTick')){
  if(!keys(range,['bitRate','channels','startTick','endTick','initialTick'])||!count(range.startTick)||!count(range.initialTick)||range.endTick!==null&&!count(range.endTick)||range.endTick!==null&&(BigInt(range.endTick as string)<=BigInt(range.startTick)||BigInt(range.initialTick)>=BigInt(range.endTick as string)-BigInt(range.startTick)))return fail('DSD 播放范围无效');
 }else{
  if(!keys(range,['bitRate','channels','timebase','start','end','initialUs'])||typeof range.timebase!=='string'||!['microseconds','cue-75'].includes(range.timebase)||!count(range.start)||!count(range.initialUs)||BigInt(range.start)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(range.initialUs)>BigInt(Number.MAX_SAFE_INTEGER)||range.end!==null&&(!count(range.end)||BigInt(range.end)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(range.end)<=BigInt(range.start)))return fail('DSD 时间范围无效');
 }
 const driver=validateAsioDriverKey(value.asio.driver);
 const authorization=value.dopAuthorization===null?null:readDopAuthorization(value.dopAuthorization);
 if(value.transport==='native-dsd'?authorization!==null:!authorization||!sameAsioDriver(authorization.driver,driver)||!same(authorization.outputChannels,value.asio.outputChannels)||value.source.bitRate!==0&&!authorization.supportedBitRates.includes(value.source.bitRate as number))return fail('DSD 输出与设备档案不一致');
 return {...structuredClone(value),asio:{...structuredClone(value.asio),driver},dopAuthorization:authorization,expectedFile:value.expectedFile===null?null:readPlaybackFile(value.expectedFile,null)} as unknown as AsioDsdRequest;
}
export function resolveDsdRange(source:AsioDsdRequest['source'],bitRate:number,totalTicks:string):AsioDsdPlan['range'] {
 if(!rate(bitRate)||!count(totalTicks))return fail('DSD 实际源时间基无效');
 const convert=(value:string,unit:'microseconds'|'cue-75'):string=>{
  const product=BigInt(value)*BigInt(bitRate);
  if(unit==='cue-75'&&product>0xffffffffffffffffn)return fail('DSD CUE 时间范围溢出');
  const result=product/(unit==='cue-75'?75n:1000000n);if(result>0xffffffffffffffffn)return fail('DSD 时间范围溢出');return result.toString();
 };
 const range='startTick' in source?{startTick:source.startTick,endTick:source.endTick??totalTicks,initialTick:source.initialTick}:
  {startTick:convert(source.start,source.timebase),endTick:source.end===null?totalTicks:convert(source.end,source.timebase),initialTick:convert(source.initialUs,'microseconds')};
 if(BigInt(range.startTick)>=BigInt(range.endTick)||BigInt(range.endTick)>BigInt(totalTicks)||BigInt(range.initialTick)>=BigInt(range.endTick)-BigInt(range.startTick))return fail('DSD 冻结范围超出源文件');return range;
}
export function readAsioDsdSource(value:unknown,tagStamp:string|null=null):AsioDsdSource {
 if(!keys(value,['kind','container','bitRate','channels','totalTicks','layoutCode','channelTags','storage','payload','fileBinding'])||value.kind!=='dsd-msb-first-interleaved'||
  (typeof value.container!=='string'||!['dsf','dff'].includes(value.container))||!rate(value.bitRate)||!int(value.channels,1,16)||!count(value.totalTicks)||BigInt(value.totalTicks)===0n||!int(value.layoutCode,0,0xffffffff)||
  !Array.isArray(value.channelTags)||value.channelTags.length!==value.channels||!value.channelTags.every(n=>int(n,0,0xffffffff))||
  !keys(value.storage,['planar','lsbFirst','blockBytes'])||typeof value.storage.planar!=='boolean'||typeof value.storage.lsbFirst!=='boolean'||!int(value.storage.blockBytes,0,65536)||
  !keys(value.payload,['offset','bytes'])||!count(value.payload.offset)||!count(value.payload.bytes)||BigInt(value.payload.bytes)===0n)return fail('DSD 原始来源回执无效');
 const binding=readPlaybackFile(value.fileBinding,tagStamp),bytes=BigInt(value.payload.bytes),ticks=BigInt(value.totalTicks),channels=BigInt(value.channels);
 if(BigInt(value.payload.offset)+bytes>BigInt(binding.byteLength))return fail('DSD 音频载荷超出绑定文件');
 if(value.container==='dsf'){
  const block=BigInt(value.storage.blockBytes);if(!value.storage.planar||block===0n||value.layoutCode>7||value.layoutCode<1||([0,1,2,3,4,4,5,6][value.layoutCode]!==value.channels))return fail('DSF 存储布局无效');
  const byteFrames=(ticks+7n)/8n;if(bytes!==(byteFrames+block-1n)/block*block*channels)return fail('DSF 位数与存储块不一致');
 }else if(value.storage.planar||value.storage.lsbFirst||value.storage.blockBytes!==0||bytes*8n!==ticks*channels)return fail('DFF 存储位数或布局无效');
 return {...structuredClone(value),fileBinding:binding} as unknown as AsioDsdSource;
}
export function readAsioDsdOutput(value:unknown,request:AsioDsdRequest,source:AsioDsdSource):AsioDsdOutput {
 if(!keys(value,['backend','identity','driverName','driverVersion','transport','bitRate','deviceSampleRate','deviceFrameUnit','channels','bufferFrames','byteFramesPerBuffer','outputLatencyFrames','numericConversion','softwareGain','nativeDsdModeReported','dopUserConfigured','hardwareVerified'])||
  value.backend!=='asio'||value.transport!==request.transport||value.bitRate!==source.bitRate||!text(value.driverName,256,true)||!int(value.driverVersion,-2147483648,2147483647)||
  !int(value.bufferFrames,1,32768)||request.asio.bufferFrames!==0&&value.bufferFrames!==request.asio.bufferFrames||!Array.isArray(value.channels)||value.channels.length!==source.channels||
  value.numericConversion!==false||value.softwareGain!==false||value.hardwareVerified!==false)return fail('DSD 实际输出回执无效');
 const native=request.transport==='native-dsd',deviceRate=native?source.bitRate:source.bitRate/16;
 if(value.deviceSampleRate!==deviceRate||value.deviceFrameUnit!==(native?'dsd-bit':'pcm-carrier')||value.nativeDsdModeReported!==native||value.dopUserConfigured===native||
  typeof value.dopUserConfigured!=='boolean'||!int(value.outputLatencyFrames,0,deviceRate*5)||value.bufferFrames%(native?8:2)!==0||value.byteFramesPerBuffer!==(native?value.bufferFrames/8:value.bufferFrames*2))return fail('DSD 设备时间基或缓冲布局不一致');
 const identity=validateAsioDriverIdentity(value.identity);if(!sameAsioDriver(identity,request.asio.driver))return fail('DSD 输出驱动身份变化');
 if(!native&&(!request.dopAuthorization||request.dopAuthorization.driverVersion!==value.driverVersion||!request.dopAuthorization.supportedBitRates.includes(source.bitRate)))return fail('DoP 设备档案版本或速率已过期');
 const channels=value.channels.map((channel,index)=>{
  const expected=request.asio.outputChannels[index];
  if(!native){const c=validateAsioChannel(channel,expected);if(c.floating||!(c.containerBytes===3&&c.validBits===24&&!c.rightAligned||c.containerBytes===4&&(c.validBits===32&&!c.rightAligned||c.validBits===24&&c.rightAligned)))return fail('DoP 不是精确整数承载格式');return c;}
  if(!keys(channel,['index','name','group','sampleType','containerBytes','validBits','floating','bigEndian','rightAligned'])||channel.index!==expected||!text(channel.name,256,true)||!int(channel.group,-2147483648,2147483647)||
   ![32,33].includes(channel.sampleType as number)||channel.containerBytes!==1||channel.validBits!==1||channel.floating!==false||channel.bigEndian!==false||channel.rightAligned!==false)return fail('Native DSD 声道不是原始 MSB1/LSB1 格式');
  return structuredClone(channel) as unknown as AsioChannel;
 });
 return {...structuredClone(value),identity,channels} as unknown as AsioDsdOutput;
}
export function readAsioDsdPlan(value:unknown,requestValue:AsioDsdRequest,tagStamp:string|null=null):AsioDsdPlan {
 const request=readAsioDsdRequest(requestValue);
 if(!keys(value,['version','backend','transport','configurationRevision','source','output','dopAuthorization','range','buffers','stages','clockPolicy','tailPolicy','hardwareVerified','bitPerfectVerified'])||
  value.version!==1||value.backend!=='asio'||value.transport!==request.transport||value.configurationRevision!==request.asio.configurationRevision||!same(value.dopAuthorization,request.dopAuthorization)||
  !keys(value.range,['startTick','endTick','initialTick'])||!count(value.range.startTick)||!count(value.range.endTick)||!count(value.range.initialTick)||
  !keys(value.buffers,['preReadByteFrames','preReadBytes','byteFramesPerBuffer','scratchBytes'])||!count(value.buffers.preReadByteFrames)||
  value.clockPolicy!=='bit-ticks-via-driver-frames-and-output-latency'||value.tailPolicy!=='driver-clock-or-reported-latency-estimate'||value.hardwareVerified!==false||value.bitPerfectVerified!==false)return fail('DSD 播放计划无效');
 const source=readAsioDsdSource(value.source,tagStamp),output=readAsioDsdOutput(value.output,request,source);
 if(source.channels!==request.source.channels||request.source.bitRate!==0&&source.bitRate!==request.source.bitRate||request.expectedFile!==null&&!same(source.fileBinding,request.expectedFile))return fail('DSD 来源与请求或文件书签不一致');
 const start=BigInt(value.range.startTick),end=BigInt(value.range.endTick),initial=BigInt(value.range.initialTick);
 if(!same(value.range,resolveDsdRange(request.source,source.bitRate,source.totalTicks))||start>=end||end>BigInt(source.totalTicks)||initial>=end-start)return fail('DSD 冻结范围不一致');
 dsdTicksToUs((end-start).toString(),source.bitRate);
 const capacity=Math.floor(32*1024*1024/source.channels);
 const scratch=output.byteFramesPerBuffer*source.channels+(request.transport==='native-dsd'?output.bufferFrames/8*source.channels:output.bufferFrames*output.channels.reduce((sum,c)=>sum+c.containerBytes,0));
 const stages=['bound-raw-dsd-reader','normalized-msb-interleaved-ring',request.transport==='native-dsd'?'native-bit-order-packing':'dop-integer-marker-packing','asio-double-buffer'];
 if(value.buffers.preReadByteFrames!==String(capacity)||value.buffers.preReadBytes!==capacity*source.channels||value.buffers.byteFramesPerBuffer!==output.byteFramesPerBuffer||value.buffers.scratchBytes!==scratch||!same(value.stages,stages))return fail('DSD 预分配缓冲或处理阶段不一致');
 return {...structuredClone(value),source,output,dopAuthorization:request.dopAuthorization} as unknown as AsioDsdPlan;
}
export function readAsioDsdClock(value:unknown,plan:AsioDsdPlan):AsioDsdClock {
 if(!keys(value,['version','transport','authority','sourceTick','callbackTick','bitRate','deviceFrameUnit','deviceSampleRate','devicePosition','systemTimeNs','outputLatencyFrames','publishedMusicFrames','hardwareVerified'])||
  value.version!==1||value.transport!==plan.transport||(typeof value.authority!=='string'||!['paused-bookmark','driver-reported','callback-estimate'].includes(value.authority))||!count(value.sourceTick)||!count(value.callbackTick)||!count(value.publishedMusicFrames)||
  value.bitRate!==plan.source.bitRate||value.deviceFrameUnit!==plan.output.deviceFrameUnit||value.deviceSampleRate!==plan.output.deviceSampleRate||value.outputLatencyFrames!==plan.output.outputLatencyFrames||value.hardwareVerified!==false||
  (value.devicePosition!==null&&!count(value.devicePosition))||(value.systemTimeNs!==null&&!count(value.systemTimeNs)))return fail('DSD 时钟回执无效');
 const initial=BigInt(plan.range.initialTick),limit=BigInt(plan.range.endTick)-BigInt(plan.range.startTick),source=BigInt(value.sourceTick),callback=BigInt(value.callbackTick),q=quantum(plan);
 if(source<initial||source>callback||callback>limit||BigInt(value.publishedMusicFrames)>(callback-initial+q-1n)/q||
  (value.authority==='driver-reported'?(value.devicePosition===null||value.systemTimeNs===null):(value.devicePosition!==null||value.systemTimeNs!==null))||
  value.authority==='paused-bookmark'&&source!==initial)return fail('DSD 时钟位数或观察依据不一致');
 return structuredClone(value) as unknown as AsioDsdClock;
}
export function readAsioDsdPrepared(value:unknown,request:AsioDsdRequest,sessionId:string,nonce:string,tagStamp:string|null=null):AsioDsdPrepared {
 if(!keys(value,['state','position','clock','output','requestedOutput','source','actualOutput','dsdPlan','initialPaused','planToken'])||value.state!=='preparing'||value.initialPaused!==request.initialPaused||
  value.planToken!==`${sessionId}-${nonce}-asio-dsd-1`||!text(value.output,1024)||!same(value.requestedOutput,request.asio))return fail('DSD 准备回执身份无效');
 const plan=readAsioDsdPlan(value.dsdPlan,request,tagStamp),clock=readAsioDsdClock(value.clock,plan);
 if(!same(value.source,plan.source)||!same(value.actualOutput,plan.output)||clock.authority!=='paused-bookmark'||clock.sourceTick!==plan.range.initialTick||clock.callbackTick!==plan.range.initialTick||clock.publishedMusicFrames!=='0'||
  typeof value.position!=='number'||!Number.isFinite(value.position)||Math.abs(value.position-Number(BigInt(plan.range.initialTick))/plan.source.bitRate)>0.000001)return fail('DSD 准备状态与冻结计划不一致');
 return {...structuredClone(value),source:plan.source,actualOutput:plan.output,dsdPlan:plan,clock} as unknown as AsioDsdPrepared;
}
export function readAsioDsdTail(value:unknown,plan:AsioDsdPlan):AsioDsdTail {
 if(!keys(value,['version','transport','status','evidence','sourceTick','bitRate','deviceFrameUnit','targetDeviceFrame','outputLatencyFrames','bufferFrames','elapsedMs','driverPosition','driverReleased','sourceReleased','hardwareVerified'])||
  value.version!==1||value.transport!==plan.transport||(typeof value.status!=='string'||!['draining','completed'].includes(value.status))||(typeof value.evidence!=='string'||!['pending','driver-clock','driver-latency-period-estimate'].includes(value.evidence))||
  value.sourceTick!==(BigInt(plan.range.endTick)-BigInt(plan.range.startTick)).toString()||value.bitRate!==plan.source.bitRate||value.deviceFrameUnit!==plan.output.deviceFrameUnit||value.outputLatencyFrames!==plan.output.outputLatencyFrames||
  value.bufferFrames!==plan.output.bufferFrames||!int(value.elapsedMs,0,30000)||(value.targetDeviceFrame!==null&&!count(value.targetDeviceFrame))||(value.driverPosition!==null&&!count(value.driverPosition))||value.hardwareVerified!==false)return fail('DSD 曲尾回执无效');
 const completed=value.status==='completed';
 if(value.driverReleased!==completed||value.sourceReleased!==completed||completed===(value.evidence==='pending')||
  (value.evidence==='driver-clock'?(value.targetDeviceFrame===null||value.driverPosition===null||BigInt(value.driverPosition as string)<BigInt(value.targetDeviceFrame as string)):value.driverPosition!==null))return fail('DSD 曲尾释放或时钟证据不一致');
 const estimate=Math.ceil((plan.output.outputLatencyFrames+plan.output.bufferFrames*3)*1000/plan.output.deviceSampleRate)+100;
 if(value.evidence==='driver-latency-period-estimate'&&(value.elapsedMs as number)<estimate)return fail('DSD 曲尾估计尚未到达已报告延迟与缓冲期限');
 return structuredClone(value) as unknown as AsioDsdTail;
}
export function readAsioDsdState(value:unknown,prepared:AsioDsdPrepared):AsioDsdState {
 if(!keys(value,['state','position','clock','output','requestedOutput','source','actualOutput','dsdPlan'])||(typeof value.state!=='string'||!['playing','paused'].includes(value.state))||
  value.output!==prepared.output||!same(value.requestedOutput,prepared.requestedOutput)||!same(value.source,prepared.source)||!same(value.actualOutput,prepared.actualOutput)||!same(value.dsdPlan,prepared.dsdPlan))return fail('DSD 活动状态改变了已批准计划');
 const clock=readAsioDsdClock(value.clock,prepared.dsdPlan);
 if(value.state==='paused'?(clock.authority!=='paused-bookmark'||clock.callbackTick!==prepared.dsdPlan.range.initialTick):clock.authority==='paused-bookmark')return fail('DSD 活动状态与时钟依据不一致');
 if(typeof value.position!=='number'||!Number.isFinite(value.position)||Math.abs(value.position-Number(BigInt(clock.sourceTick))/clock.bitRate)>0.000001)return fail('DSD 显示进度与原始位数不一致');
 return {...structuredClone(value),clock} as unknown as AsioDsdState;
}
export function readAsioDsdPosition(value:unknown,plan:AsioDsdPlan,previous:AsioDsdPosition|null=null):AsioDsdPosition {
 if(!keys(value,['position','clock','publishedSourceBits','callbackCount','underrunFrames'])||!count(value.publishedSourceBits)||!count(value.callbackCount)||!count(value.underrunFrames))return fail('DSD 进度计数无效');
 const clock=readAsioDsdClock(value.clock,plan),bits=BigInt(value.publishedSourceBits),consumed=BigInt(clock.callbackTick)-BigInt(plan.range.initialTick);
 if(bits>consumed||typeof value.position!=='number'||!Number.isFinite(value.position)||Math.abs(value.position-Number(BigInt(clock.sourceTick))/clock.bitRate)>0.000001)return fail('DSD 发布位数或进度不一致');
 if(previous&&(BigInt(clock.sourceTick)<BigInt(previous.clock.sourceTick)||BigInt(clock.callbackTick)<BigInt(previous.clock.callbackTick)||bits<BigInt(previous.publishedSourceBits)||
  BigInt(value.callbackCount)<BigInt(previous.callbackCount)||BigInt(value.underrunFrames)<BigInt(previous.underrunFrames)||BigInt(clock.publishedMusicFrames)<BigInt(previous.clock.publishedMusicFrames)))return fail('DSD 进度或计数发生回退');
 return {...structuredClone(value),clock} as unknown as AsioDsdPosition;
}
export function readAsioDsdRebuild(value:unknown,plan:AsioDsdPlan):AsioDsdRebuild {
 if(!keys(value,['reason','positionTick','positionUs','bitRate','startTick','endTick','fileBinding','configurationRevision','desiredState','driverReleased','sourceReleased','hardwareVerified'])||
  (typeof value.reason!=='string'||!['pause','seek','driver-reconfigure'].includes(value.reason))||!count(value.positionTick)||!count(value.positionUs)||value.bitRate!==plan.source.bitRate||value.startTick!==plan.range.startTick||value.endTick!==plan.range.endTick||
  value.configurationRevision!==plan.configurationRevision||(typeof value.desiredState!=='string'||!['paused','playing'].includes(value.desiredState))||value.reason!=='seek'&&value.desiredState!=='paused'||value.driverReleased!==true||value.sourceReleased!==true||value.hardwareVerified!==false||
  BigInt(value.positionTick)>=BigInt(plan.range.endTick)-BigInt(plan.range.startTick)||value.positionUs!==dsdTicksToUs(value.positionTick,plan.source.bitRate)||!same(value.fileBinding,plan.source.fileBinding))return fail('DSD 重建书签无效');
 return {...structuredClone(value),fileBinding:readPlaybackFile(value.fileBinding,null)} as unknown as AsioDsdRebuild;
}
