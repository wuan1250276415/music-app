import type {LibraryItem} from './contracts.js';

export interface SourceSampleRange {sampleRate:number;start:number;end:number}
export interface SamplePlayRange {sampleRate:number;startFrame:string;endFrame:string;nextStartFrame:string|null;nextEndFrame:string|null}
export function readSourceSampleRange(value:unknown):SourceSampleRange {
 const v=value as SourceSampleRange;
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==3||!Number.isSafeInteger(v.sampleRate)||v.sampleRate<1||v.sampleRate>1536000||!Number.isSafeInteger(v.start)||!Number.isSafeInteger(v.end)||v.start<0||v.end<=v.start)throw new Error('源采样范围无效');
 return {sampleRate:v.sampleRate,start:v.start,end:v.end};
}
export function adjacentCueItems(current:LibraryItem,next:LibraryItem):boolean {
 if(!current.available||!next.available||current.kind!=='cue'||next.kind!=='cue'||current.fileId!==next.fileId||current.path!==next.path)return false;
 if(current.sourceSampleRange||next.sourceSampleRange){if(!current.sourceSampleRange||!next.sourceSampleRange)return false;const a=readSourceSampleRange(current.sourceSampleRange),b=readSourceSampleRange(next.sourceSampleRange);return a.sampleRate===b.sampleRate&&a.end===b.start;}
 return current.sourceEndCueFrame!==null&&next.sourceStartCueFrame===current.sourceEndCueFrame&&next.sourceEndCueFrame!==null&&next.sourceEndCueFrame>next.sourceStartCueFrame!;
}
export function samplePlayRange(item:LibraryItem,next?:LibraryItem):SamplePlayRange|undefined {
 if(!item.sourceSampleRange){if(next?.sourceSampleRange)throw new Error('相邻音轨时间基准不同');return undefined;}
 const range=readSourceSampleRange(item.sourceSampleRange);
 if(item.sampleRate!==range.sampleRate||item.sourceStartCueFrame!==null||item.sourceEndCueFrame!==null||Math.abs(item.sourceStartSeconds-range.start/range.sampleRate)>1e-9||item.sourceEndSeconds===null||Math.abs(item.sourceEndSeconds-range.end/range.sampleRate)>1e-9)throw new Error('歌曲与源采样范围不一致');
 if(next&&!adjacentCueItems(item,next))throw new Error('相邻音轨的采样范围不连续');
 if(next)samplePlayRange(next);
 const following=next?readSourceSampleRange(next.sourceSampleRange):null;
 return {sampleRate:range.sampleRate,startFrame:String(range.start),endFrame:String(range.end),nextStartFrame:following?String(following.start):null,nextEndFrame:following?String(following.end):null};
}
export function resolveSamplePlayRange(range:SamplePlayRange,decodedRate:number):{startFrame:string;endFrame:string;boundaryFrame:string|null} {
 const decimal=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9]\d{0,15})$/.test(v)&&BigInt(v)<=BigInt(Number.MAX_SAFE_INTEGER);
 if(Object.keys(range).length!==5||range.sampleRate!==decodedRate||!Number.isSafeInteger(decodedRate)||decodedRate<1||decodedRate>1536000||!decimal(range.startFrame)||!decimal(range.endFrame)||BigInt(range.endFrame)<=BigInt(range.startFrame)||(range.nextStartFrame===null)!==(range.nextEndFrame===null)||range.nextStartFrame!==null&&(!decimal(range.nextStartFrame)||!decimal(range.nextEndFrame)||range.nextStartFrame!==range.endFrame||BigInt(range.nextEndFrame!)<=BigInt(range.endFrame)))throw new Error('实际解码采样率或连续范围与原采样编排不符');
 return {startFrame:range.startFrame,endFrame:range.nextEndFrame??range.endFrame,boundaryFrame:range.nextStartFrame};
}
