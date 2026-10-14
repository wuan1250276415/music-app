import type {AudioConverterPlan,AudioPipelinePlan,ActualAudioOutput,PlaybackState,ProcessingPlan} from './contracts.js';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const frame=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;
const formats=['u8','s16','s24','s32','f32'];
const exact=(a:unknown,b:unknown):boolean=>{
 if(typeof b==='number')return typeof a==='number'&&Number.isFinite(a)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b));
 if(Array.isArray(b))return Array.isArray(a)&&a.length===b.length&&b.every((value,i)=>exact(a[i],value));
 if(object(b))return object(a)&&Object.keys(a).length===Object.keys(b).length&&Object.keys(b).every(key=>exact(a[key],b[key]));
 return a===b;
};
export function readConverter(value:unknown,output:ActualAudioOutput):AudioConverterPlan{
 if(!object(value)||Object.keys(value).length!==24||value.version!==1||!formats.includes(String(value.formatIn))||!formats.includes(String(value.formatOut))||!integer(value.channelsIn,1,16)||!integer(value.channelsOut,1,16)||!integer(value.sampleRateIn,1,1536000)||!integer(value.sampleRateOut,1,1536000)||!['passthrough','format-only','channels-only','resample-only','resample-first','channels-first'].includes(String(value.executionPath))||!['none','rectangular','triangular'].includes(String(value.dither))||!['none','linear'].includes(String(value.resampler))||!frame(value.inputLatencyFrames)||!frame(value.outputLatencyFrames))throw new Error('输出转换计划无效');
 for(const key of ['passthrough','preFormat','postFormat','channelConversion','resampling'])if(typeof value[key]!=='boolean')throw new Error('转换节点状态无效');
 if(value.formatIn!==output.format||value.formatOut!==output.deviceFormat||value.channelsIn!==output.channels||value.channelsOut!==output.deviceChannels||value.sampleRateIn!==output.sampleRate||value.sampleRateOut!==output.deviceSampleRate||value.passthrough===output.adapterConversion||value.resampling!==(value.sampleRateIn!==value.sampleRateOut)||value.resampler!==(value.resampling?'linear':'none'))throw new Error('输出转换与实际设备回执冲突');
 const converted=Boolean(value.preFormat||value.postFormat||value.channelConversion||value.resampling);
 if(value.passthrough===converted||value.passthrough!==(value.executionPath==='passthrough')||value.formatIn!==value.formatOut&&!value.preFormat&&!value.postFormat||value.channelsIn!==value.channelsOut&&!value.channelConversion||!output.allowConversion&&converted||output.applicationIntegerPath&&(converted||!['s16','s32'].includes(output.format)))throw new Error('转换执行路径或原始模式冲突');
 const path=value.passthrough?'passthrough':value.channelConversion?value.resampling?Number(value.channelsIn)<Number(value.channelsOut)?'resample-first':'channels-first':'channels-only':value.resampling?'resample-only':'format-only';
 if(value.executionPath!==path)throw new Error('转换顺序与节点不符');
 const map=(v:unknown,count:unknown)=>Array.isArray(v)&&v.length===count&&v.every(x=>integer(x,0,255));
 if(value.channelConversion){
  if(!['passthrough','mono-out','mono-in','shuffle','weights'].includes(String(value.channelPath))||!['rectangular','simple','custom'].includes(String(value.channelMode))||!map(value.inputMap,value.channelsIn)||!map(value.outputMap,value.channelsOut))throw new Error('声道映射计划无效');
  if(value.channelPath==='mono-out'&&value.channelsOut!==1||value.channelPath==='mono-in'&&value.channelsIn!==1)throw new Error('单声道转换计划无效');
  if(value.channelPath==='shuffle'){
   if(!Array.isArray(value.shuffle)||value.shuffle.length!==value.channelsOut||value.shuffle.some(i=>i!==255&&!integer(i,0,Number(value.channelsIn)-1)))throw new Error('声道重排计划无效');
  }else if(value.shuffle!==null)throw new Error('未启用的重排带有参数');
  if(value.channelPath==='weights'){
   if(!['f32','s16-fixed'].includes(String(value.weightRepresentation))||!Array.isArray(value.weights)||value.weights.length!==value.channelsIn)throw new Error('混音系数计划无效');
   for(const row of value.weights)if(!Array.isArray(row)||row.length!==value.channelsOut||row.some(v=>typeof v!=='number'||!Number.isFinite(v)||(value.weightRepresentation==='f32'?Math.abs(v)>64:!integer(v,-2147483648,2147483647))))throw new Error('混音系数超出范围');
  }else if(value.weights!==null||value.weightRepresentation!==null)throw new Error('未启用的混音带有参数');
 }else if(value.channelPath!=='none'||value.channelMode!=='none'||value.inputMap!==null||value.outputMap!==null||value.shuffle!==null||value.weights!==null||value.weightRepresentation!==null)throw new Error('未启用的声道转换带有参数');
 if(!value.resampling&&(value.inputLatencyFrames!=='0'||value.outputLatencyFrames!=='0'))throw new Error('未重采样的延迟回执无效');
 return structuredClone(value) as unknown as AudioConverterPlan;
}
export function makePipeline(source:NonNullable<PlaybackState['decodedSource']>,output:ActualAudioOutput,conversion:AudioConverterPlan,gain:ProcessingPlan,span:AudioPipelinePlan['span'],buffers:AudioPipelinePlan['buffers']):AudioPipelinePlan{
 const stages=['decode'];if(source.dsdConversion)stages.push('dsd-lowpass-and-src');if(source.opusGain)stages.push('opus-header-gain');stages.push(gain.enabled?'gain-envelope':'gain-bypass');if(conversion.preFormat)stages.push('pre-format-conversion');
 const channel=()=>{if(conversion.channelConversion)stages.push('channel-conversion');},src=()=>{if(conversion.resampling)stages.push('linear-src');};if(conversion.executionPath==='resample-first'){src();channel();}else{channel();src();}if(conversion.postFormat)stages.push('post-format-conversion');stages.push('wasapi-submit');if(output.mode==='shared')stages.push('windows-shared-engine');
 const media=source.media,integerReduced=media?.decoderConversion==='integer-output'&&(media.validBits??0)>(source.format==='s16'?16:32),decodedConversion=media?.decoderConversion==='integer-to-float'||integerReduced||media?.decoderConversion==='float-output'&&(media.validBits??0)>32;
 if(output.applicationIntegerPath&&(integerReduced||media?.validBits==null||!['pcm-integer','lossless-integer'].includes(media.encoding)))throw new Error('整数路径缺少可容纳的源有效位证据');
 if(!output.allowConversion&&decodedConversion)throw new Error('原始模式不能使用解码器样本格式转换，请选择允许转换模式');
 const warnings=['hardware-unverified','decoder-format-transform-unverified'];if(media?.validBits==null)warnings.push('source-valid-bits-unknown');if(media?.decoderConversion==='integer-to-float'&&(media.validBits??0)>24)warnings.push('integer-to-float-precision');if(integerReduced)warnings.push('integer-output-precision');if(media?.decoderConversion==='float-output'&&(media.validBits??0)>32)warnings.push('float-precision-reduction');if(output.mode==='shared')warnings.push('windows-shared-engine');if(conversion.resampling)warnings.push('src-delay-and-quality-unverified');if(source.dsdConversion)warnings.push('dsd-filter-unverified');if(conversion.formatOut!=='f32'&&conversion.dither==='none'&&!conversion.passthrough)warnings.push('integer-output-without-dither');
 return {version:2,transport:'pcm',source,output,conversion,gain,span,buffers,path:output.applicationIntegerPath?'integer-candidate':gain.enabled?'float-processing':'float-unity',stages,clockPolicy:conversion.resampling?'converter-delay-estimate':'frame-preserving',tailPolicy:conversion.resampling?'linear-src-100ms':'no-resampler',encodedQuality:source.dsdConversion?'dsd-converted':['pcm-integer','pcm-float','lossless-integer'].includes(media?.encoding??'')?'lossless':media?.encoding==='lossy'?'lossy':'unknown',sampleStatus:gain.enabled||source.dsdConversion||(source.opusGain?.headerGainQ78??0)!==0?'processing':!conversion.passthrough||decodedConversion?'conversion':output.applicationIntegerPath?'integer-candidate':'unity-float-unverified',warnings,hardwareVerified:false,bitPerfectVerified:false};
}
export function readPipeline(value:unknown,source:NonNullable<PlaybackState['decodedSource']>,output:ActualAudioOutput,gain:ProcessingPlan,span:AudioPipelinePlan['span'],previous?:AudioPipelinePlan):AudioPipelinePlan{
 if(!object(value)||Object.keys(value).length!==17||value.version!==2||!object(value.buffers)||Object.keys(value.buffers).length!==3)throw new Error('播放计划结构无效');
 if(source.format!==output.format||source.channels!==output.channels||source.sampleRate!==output.sampleRate)throw new Error('解码格式与回调格式不一致');
 const conversion=readConverter(value.conversion,output),b=value.buffers;
 const bytes=({u8:1,s16:2,s24:3,s32:4,f32:4} as Record<string,number>)[source.format]*source.channels;
 const capacity=Math.min(Math.max(4096,source.sampleRate*2),Math.floor(32*1024*1024/bytes));
 if(b.preReadFrames!==String(capacity)||b.preReadBytes!==capacity*bytes||!frame(b.deviceFrames)||!integer(Number(b.deviceFrames),1,4294967295))throw new Error('播放缓冲计划无效');
 const expected=makePipeline(source,output,conversion,gain,span,{preReadFrames:String(capacity),preReadBytes:capacity*bytes,deviceFrames:b.deviceFrames});
 if(!exact(value,expected))throw new Error('播放计划与来源／处理／输出不符');
 if(previous&&(!exact(conversion,previous.conversion)||!exact(expected.buffers,previous.buffers)||!exact(source,previous.source)||!exact(output,previous.output)))throw new Error('播放中固定的转换计划发生变化');
 return structuredClone(expected);
}
