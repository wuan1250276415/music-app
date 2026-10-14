import type {AudioAnalysisFrame,AudioAnalysisStatus} from './contracts.js';
import type {AsioDsdSource,AsioDsdPlan} from './asio-dsd.js';
export const DSD_ANALYSIS_PROFILE='raw-window-dsd96-swr128-kaiser9-c0.5-preroll8192-v1';
export interface DsdAnalysisIdentity {nonce:string;sessionId:string;generation:number;itemId:string}
export interface DsdAnalysisContext extends DsdAnalysisIdentity {path:string;source:AsioDsdSource;range:AsioDsdPlan['range'];positionTick:string;receivedAt:number}
export interface DsdAnalysisEvidence {
 profile:typeof DSD_ANALYSIS_PROFILE;sourceBitRate:number;fileBinding:AsioDsdSource['fileBinding'];range:{startTick:string;endTick:string};
 windowStartFrame:string;windowEndFrame:string;positionEvidence:'playback-anchor-extrapolation';delayCompensation:'pending';hardwareVerified:false;
}
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
function keys(v:unknown,names:string[]):v is Record<string,unknown>{return record(v)&&Object.keys(v).length===names.length&&names.every(n=>Object.hasOwn(v,n));}
const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;
const common=['version','buildId','nonce','sessionId','generation','itemId','profile','kind'];
function identity(v:Record<string,unknown>,c:DsdAnalysisContext,buildId:string):void {
 if(v.version!==1||v.buildId!==buildId||v.nonce!==c.nonce||v.sessionId!==c.sessionId||v.generation!==c.generation||v.itemId!==c.itemId||v.profile!==DSD_ANALYSIS_PROFILE)throw new Error('DSD 分析身份或构建不一致');
}
export function readDsdAnalysisReady(v:unknown,c:DsdAnalysisContext,buildId:string):void {
 if(!keys(v,[...common,'source','range'])||v.kind!=='ready')throw new Error('DSD 分析准备回执无效');identity(v,c,buildId);
 // Both inputs have already been strictly validated against the playback plan.
 if(!same(v.source,c.source)||!same(v.range,c.range))throw new Error('DSD 分析来源或范围不一致');
}
function same(a:unknown,b:unknown):boolean {if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]));if(record(a)&&record(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]));return a===b;}
function numbers(v:unknown,n:number,min:number,max:number):v is number[]{return Array.isArray(v)&&v.length===n&&v.every(x=>typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max);}
export function readDsdAnalysisWindow(v:unknown,c:DsdAnalysisContext,buildId:string,request:{id:string;sequence:string;positionTick:string}):AudioAnalysisFrame|null {
 const warming=record(v)&&v.kind==='warming-up';
 if(!keys(v,[...common,'requestId','sequence','positionTick',...(warming?[]:['windowStartFrame','windowEndFrame','sampleRate','channels','windowFrames','peakDb','rmsDb','spectrumDb','waveform','invalidSamples'])]))throw new Error('DSD 分析窗口字段无效');
 identity(v,c,buildId);if(v.kind!== (warming?'warming-up':'window')||v.requestId!==request.id||v.sequence!==request.sequence||v.positionTick!==request.positionTick||!decimal(v.positionTick)||BigInt(v.positionTick)>BigInt(c.range.endTick)-BigInt(c.range.startTick))throw new Error('DSD 分析窗口不属于原请求');
 const ratio=BigInt(c.source.bitRate/176400),last=(BigInt(c.range.startTick)+BigInt(v.positionTick))/ratio,first=(BigInt(c.range.startTick)+ratio-1n)/ratio;
 if(warming){if(last>=first+2048n)throw new Error('DSD 分析预热回执与范围不符');return null;}
 if(!decimal(v.windowStartFrame)||!decimal(v.windowEndFrame)||BigInt(v.windowEndFrame)!==last||BigInt(v.windowStartFrame)!==last-2048n||BigInt(v.windowStartFrame)<first||last*ratio>BigInt(c.range.endTick)||v.sampleRate!==176400||v.channels!==c.source.channels||v.windowFrames!==2048||
 !numbers(v.peakDb,c.source.channels,-96,24)||!numbers(v.rmsDb,c.source.channels,-96,24)||!numbers(v.spectrumDb,64,-96,24)||!Array.isArray(v.waveform)||v.waveform.length!==64||!v.waveform.every(p=>numbers(p,2,-1,1)&&p[0]<=p[1])||!Number.isSafeInteger(v.invalidSamples)||Number(v.invalidSamples)<0||Number(v.invalidSamples)>2048*c.source.channels)throw new Error('DSD 分析范围或样本无效');
 return {version:1,sessionId:c.sessionId,generation:c.generation,itemId:c.itemId,receivedAt:Date.now(),positionSeconds:Number(last*ratio-BigInt(c.range.startTick))/c.source.bitRate,sampleRate:176400,channels:c.source.channels,windowFrames:2048,tap:'independent-dsd-pcm-copy',peakDb:v.peakDb,rmsDb:v.rmsDb,spectrumDb:v.spectrumDb,waveform:v.waveform as Array<[number,number]>,droppedFrames:0,invalidSamples:Number(v.invalidSamples),dsdCopy:{profile:DSD_ANALYSIS_PROFILE,sourceBitRate:c.source.bitRate,fileBinding:c.source.fileBinding,range:{startTick:c.range.startTick,endTick:c.range.endTick},windowStartFrame:v.windowStartFrame,windowEndFrame:v.windowEndFrame,positionEvidence:'playback-anchor-extrapolation',delayCompensation:'pending',hardwareVerified:false}};
}
export function dsdAnalysisStatus(c:DsdAnalysisContext|null,state:AudioAnalysisStatus['state'],message:string):AudioAnalysisStatus{return {source:c?'dsd-copy':'none',state,message,sessionId:c?.sessionId??null,generation:c?.generation??null,hardwareVerified:false};}
