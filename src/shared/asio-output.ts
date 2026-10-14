export interface AsioDriverKey {registryName:string;clsid:string}
export interface AsioDriverIdentity extends AsioDriverKey {description:string}
export interface AsioDriverCatalog {architecture:'x64';registryStatus:number;skipped:number;truncated:boolean;drivers:AsioDriverIdentity[];observedAt:number}
export interface AsioChannel {index:number;sampleType:number;group:number;name:string;containerBytes:number;validBits:number;floating:boolean;bigEndian:boolean;rightAligned:boolean}
export interface AsioBufferShape {minimum:number;maximum:number;preferred:number;granularity:number}
export const ASIO_PCM_QUERY_RATES=[8000,11025,16000,22050,32000,44100,48000,64000,88200,96000,176400,192000,352800,384000,705600,768000,1411200,1536000] as const;
export const ASIO_DSD_QUERY_RATES=[2822400,5644800,11289600] as const;
export type AsioSupport='reported'|'unsupported'|'unreported'|'query-failed';
export interface AsioIoFormatSupport {requestedFormat:0|1;returnedFormat:number;error:number;support:AsioSupport}
export interface AsioRateSupport {rate:number;error:number;support:AsioSupport}
export interface AsioCapabilities {
 identity:AsioDriverIdentity;driverName:string;driverVersion:number;inputChannels:number;outputChannels:number;
 channels:AsioChannel[];channelsTruncated:boolean;buffers:AsioBufferShape;currentSampleRate:number|null;
 ioMode:'pcm'|'dsd'|'unknown'|'unreported'|'query-failed';latencies:{input:number;output:number}|null;
 ioFormats:AsioIoFormatSupport[];sampleRates:AsioRateSupport[];
 observedAt:number;buffersCreated:false;playbackStarted:false;hardwareVerified:false;
}
export interface AsioOutputRequest {commandId:string;baseRevision:number;driver:AsioDriverKey|null;outputChannels:number[];bufferFrames:number;allowConversion:boolean}
export interface AsioOutputPreference {revision:number;driver:AsioDriverIdentity|null;outputChannels:number[];bufferFrames:number;allowConversion:boolean}
export interface AsioOutputView {preference:AsioOutputPreference;pendingRequest:AsioOutputRequest|null;playbackIntegration:'pcm'}
export interface AsioOutputResult {status:'saved'|'rejected'|'unknown';view:AsioOutputView;error:string}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&(empty||v.length>0)&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v);
const int=(v:unknown,min=0,max=2147483647):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const keys=(v:unknown,list:string[]):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===list.length&&list.every(k=>Object.hasOwn(v,k)));
export function validateAsioDriverKey(value:unknown):AsioDriverKey {
 if(!keys(value,['registryName','clsid'])||!text(value.registryName,512)||!text(value.clsid,38)||!/^\{[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}\}$/.test(value.clsid))throw new Error('ASIO 驱动身份无效');
 return {registryName:value.registryName,clsid:value.clsid};
}
export function validateAsioDriverIdentity(value:unknown):AsioDriverIdentity {
 if(!keys(value,['registryName','clsid','description'])||!text(value.description,256,true))throw new Error('ASIO 驱动条目无效');
 return {...validateAsioDriverKey({registryName:value.registryName,clsid:value.clsid}),description:value.description};
}
export const asioDriverId=(v:AsioDriverKey):string=>JSON.stringify([v.registryName,v.clsid]);
export const sameAsioDriver=(a:AsioDriverKey|null,b:AsioDriverKey|null):boolean=>a===null?b===null:b!==null&&asioDriverId(a)===asioDriverId(b);
export function validateAsioCatalog(value:unknown,observedAt:number):AsioDriverCatalog {
 if(!keys(value,['registryStatus','skipped','truncated','drivers'])||!int(value.registryStatus,0,0xffffffff)||!int(value.skipped,0,1024)||typeof value.truncated!=='boolean'||!Array.isArray(value.drivers)||value.drivers.length>256)throw new Error('ASIO 驱动目录回执无效');
 const drivers=value.drivers.map(validateAsioDriverIdentity),names=new Set<string>();
 for(const driver of drivers){if(names.has(driver.registryName))throw new Error('ASIO 注册名称重复');names.add(driver.registryName);}
 if(value.registryStatus!==0&&drivers.length)throw new Error('ASIO 注册表错误回执包含驱动');
 return {architecture:'x64',registryStatus:value.registryStatus,skipped:value.skipped,truncated:value.truncated,drivers,observedAt};
}
function pcmShape(type:number):[number,number,boolean,boolean,boolean] {
 const big=type<16,t=big?type:type-16;
 if(t>=0&&t<=4)return [[2,3,4,4,8][t],[16,24,32,32,64][t],t>=3,big,false];
 if(t>=8&&t<=11)return [4,[16,18,20,24][t-8],false,big,true];
 return [0,0,false,false,false];
}
export function validateAsioChannel(v:unknown,index:number):AsioChannel {
 if(!keys(v,['index','sampleType','group','name','containerBytes','validBits','floating','bigEndian','rightAligned'])||v.index!==index||!int(v.sampleType,-2147483648)||!int(v.group,-2147483648)||!text(v.name,256,true))throw new Error('ASIO 输出声道回执无效');
 const shape=pcmShape(v.sampleType);
 if(JSON.stringify([v.containerBytes,v.validBits,v.floating,v.bigEndian,v.rightAligned])!==JSON.stringify(shape))throw new Error('ASIO 声道样本格式与容器信息不一致');
 return {index,sampleType:v.sampleType,group:v.group,name:v.name,containerBytes:shape[0],validBits:shape[1],floating:shape[2],bigEndian:shape[3],rightAligned:shape[4]};
}
export function validateAsioCapabilities(value:unknown,driver:AsioDriverKey,observedAt:number):AsioCapabilities {
 if(!keys(value,['identity','driverName','driverVersion','inputChannels','outputChannels','channels','channelsTruncated','buffers','currentSampleRate','ioMode','latencies','ioFormats','sampleRates','buffersCreated','playbackStarted','hardwareVerified']))throw new Error('ASIO 能力回执无效');
 const identity=validateAsioDriverIdentity(value.identity);
 if(!sameAsioDriver(identity,driver)||!text(value.driverName,256,true)||!int(value.driverVersion,-2147483648)||!int(value.inputChannels,0,4096)||!int(value.outputChannels,1,4096)||typeof value.channelsTruncated!=='boolean'||!Array.isArray(value.channels)||value.channels.length!==Math.min(value.outputChannels,256)||value.channelsTruncated!==(value.outputChannels>256)||value.buffersCreated!==false||value.playbackStarted!==false||value.hardwareVerified!==false)throw new Error('ASIO 能力身份或观察范围无效');
 if(value.currentSampleRate!==null&&(typeof value.currentSampleRate!=='number'||!Number.isFinite(value.currentSampleRate)||value.currentSampleRate<8000||value.currentSampleRate>(value.ioMode==='dsd'?11289600:1536000))||!['pcm','dsd','unknown','unreported','query-failed'].includes(value.ioMode as string))throw new Error('ASIO 采样率或模式观察无效');
 if(!keys(value.buffers,['minimum','maximum','preferred','granularity'])||Object.values(value.buffers).some(v=>!int(v,-2147483648)))throw new Error('ASIO 缓冲范围回执无效');
 const buffers=value.buffers as unknown as AsioBufferShape;
 let latencies:AsioCapabilities['latencies']=null;
 if(value.latencies!==null){if(!keys(value.latencies,['input','output'])||!int(value.latencies.input)||!int(value.latencies.output))throw new Error('ASIO 延迟观察无效');latencies={input:value.latencies.input,output:value.latencies.output};}
 if(!Array.isArray(value.ioFormats)||value.ioFormats.length!==2)throw new Error('ASIO I/O 模式能力观察无效');
 const ioFormats=value.ioFormats.map((entry,index):AsioIoFormatSupport=>{
  if(!keys(entry,['requestedFormat','returnedFormat','error'])||entry.requestedFormat!==index||!int(entry.returnedFormat,-2147483648)||!int(entry.error,-2147483648))throw new Error('ASIO I/O 模式查询结果无效');
  const support:AsioSupport=entry.error===0x3f4847a0&&entry.returnedFormat===index?'reported':entry.returnedFormat===-1&&[0x3f4847a0,-998,-997].includes(entry.error)?'unsupported':entry.error===-1000||entry.error===-998?'unreported':'query-failed';
  return {requestedFormat:index as 0|1,returnedFormat:entry.returnedFormat,error:entry.error,support};
 });
 const expectedRates=value.ioMode==='dsd'?ASIO_DSD_QUERY_RATES:ASIO_PCM_QUERY_RATES;
 if(!Array.isArray(value.sampleRates)||value.sampleRates.length!==expectedRates.length)throw new Error('ASIO 当前模式采样率观察无效');
 const sampleRates=value.sampleRates.map((entry,index):AsioRateSupport=>{
  if(!keys(entry,['rate','error'])||entry.rate!==expectedRates[index]||!int(entry.error,-2147483648))throw new Error('ASIO 采样率查询结果或范围无效');
  return {rate:expectedRates[index],error:entry.error,support:entry.error===0?'reported':entry.error===-995?'unsupported':entry.error===-1000?'unreported':'query-failed'};
 });
 const channels=value.channels.map(validateAsioChannel);
 return {identity,driverName:value.driverName,driverVersion:value.driverVersion,inputChannels:value.inputChannels,outputChannels:value.outputChannels,channels,ioFormats,sampleRates,channelsTruncated:value.channelsTruncated,buffers:{...buffers},currentSampleRate:value.currentSampleRate as number|null,ioMode:value.ioMode as AsioCapabilities['ioMode'],latencies,observedAt,buffersCreated:false,playbackStarted:false,hardwareVerified:false};
}
export function asioBufferAllowed(frames:number,shape:AsioBufferShape):boolean {
 const {minimum,maximum,preferred,granularity}=shape,n=frames===0?preferred:frames;
 if(!int(frames,0,32768)||minimum<=0||maximum<minimum||preferred<minimum||preferred>maximum||!int(n,1,32768)||n<minimum||n>maximum)return false;
 if(granularity< -1)return false;
 if(minimum===maximum)return n===minimum&&preferred===minimum&&granularity===0;
 if(granularity===0)return n===preferred;
 if(granularity===-1){const ratio=n/minimum;return Number.isInteger(ratio)&&ratio>0&&(ratio&(ratio-1))===0;}
 return granularity>0&&(n-minimum)%granularity===0;
}
function configuration(value:Record<string,unknown>):Pick<AsioOutputPreference,'outputChannels'|'bufferFrames'|'allowConversion'> {
 if(!Array.isArray(value.outputChannels)||value.outputChannels.length>16||value.outputChannels.some(v=>!int(v,0,4095))||new Set(value.outputChannels).size!==value.outputChannels.length||!int(value.bufferFrames,0,32768)||typeof value.allowConversion!=='boolean')throw new Error('ASIO 声道映射或缓冲设置无效');
 if(value.driver===null?(value.outputChannels.length!==0||value.bufferFrames!==0||value.allowConversion):value.outputChannels.length===0)throw new Error('请选择明确的 ASIO 输出声道；清除驱动时需同时清除其设置');
 return {outputChannels:[...value.outputChannels],bufferFrames:value.bufferFrames,allowConversion:value.allowConversion};
}
export function validateAsioOutputRequest(value:unknown):AsioOutputRequest {
 if(!keys(value,['commandId','baseRevision','driver','outputChannels','bufferFrames','allowConversion'])||typeof value.commandId!=='string'||!uuid.test(value.commandId)||!int(value.baseRevision,0,Number.MAX_SAFE_INTEGER))throw new Error('ASIO 设置操作无效');
 return {commandId:value.commandId,baseRevision:value.baseRevision,driver:value.driver===null?null:validateAsioDriverKey(value.driver),...configuration(value)};
}
export function validateAsioOutputPreference(value:unknown):AsioOutputPreference {
 if(!keys(value,['revision','driver','outputChannels','bufferFrames','allowConversion'])||!int(value.revision,0,Number.MAX_SAFE_INTEGER))throw new Error('保存的 ASIO 配置无效');
 return {revision:value.revision,driver:value.driver===null?null:validateAsioDriverIdentity(value.driver),...configuration(value)};
}
export const defaultAsioOutput=():AsioOutputPreference=>({revision:0,driver:null,outputChannels:[],bufferFrames:0,allowConversion:false});
export function validateAsioSelection(request:AsioOutputRequest,capabilities:AsioCapabilities):void {
 if(!sameAsioDriver(request.driver,capabilities.identity))throw new Error('ASIO 声道观察属于其他驱动，请重新读取');
 if(request.outputChannels.some(index=>!capabilities.channels[index]?.containerBytes))throw new Error('所选声道缺少可用 PCM 格式观察；DSD 与未读取的声道不能按 PCM 配置保存');
 if(!asioBufferAllowed(request.bufferFrames,capabilities.buffers))throw new Error('缓冲大小不符合驱动范围、步长或应用上限（32768 帧）');
 if(capabilities.ioMode==='unknown'||capabilities.ioMode==='query-failed')throw new Error('驱动 I/O 模式不明确，请重新读取');
}
