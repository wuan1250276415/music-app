import {createHash} from 'node:crypto';
import type {CueEntry} from './cue.js';

export const FLAC_CUE_PARSER='aural-flac-cuesheet-4' as const;
const LIMIT=256*1024;
export interface FlacCueTrack {number:number;offset:number;audio:boolean;preEmphasis:boolean;isrc:string;indices:Array<{number:number;sample:number}>}
export interface FlacCueSource {version:1;parserVersion:typeof FLAC_CUE_PARSER|'aural-flac-cuesheet-1'|'aural-flac-cuesheet-2'|'aural-flac-cuesheet-3';blockOffset:number;rawBase64:string;sourceHash:string;streamInfoBase64:string;sampleRate:number;totalSamples:number;cd:boolean;catalog:string;leadIn:string;tracks:FlacCueTrack[]}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function paddedAscii(bytes:Buffer):string {
 const zero=bytes.indexOf(0),text=zero<0?bytes:bytes.subarray(0,zero);
 if(text.some(v=>v<32||v>126)||zero>=0&&bytes.subarray(zero).some(v=>v!==0))throw new Error('FLAC CUESHEET 文本或填充无效');
 return text.toString('ascii');
}
// RFC 9639 §8.7 uses sample offsets, including offsets relative to each track.
// Retain those samples even when the existing 75 fps playback path cannot represent them.
export function parseFlacCueBlock(raw:Buffer,streamInfo:Buffer,blockOffset:number):FlacCueSource {
 if(raw.length<396||raw.length>LIMIT||streamInfo.length!==34||!Number.isSafeInteger(blockOffset)||blockOffset<42||blockOffset+raw.length>32*1024*1024)throw new Error('FLAC CUESHEET 长度或位置无效');
 const packed=streamInfo.readBigUInt64BE(10),sampleRate=Number(packed>>44n),totalSamples=Number(packed&0xfffffffffn);
 if(sampleRate<=0||sampleRate>655350||totalSamples<=0)throw new Error('FLAC CUESHEET 要求已知采样率与完整采样数');
 const cd=Boolean(raw[136]&128),catalog=paddedAscii(raw.subarray(0,128)),leadIn=raw.readBigUInt64BE(128).toString();
 if((raw[136]&127)!==0||raw.subarray(137,395).some(v=>v!==0))throw new Error('FLAC CUESHEET 保留位非零');
 const count=raw[395];if(count<1||cd&&(count>100||sampleRate!==44100||BigInt(leadIn)<88200n||catalog!==''&&!/^\d{13}$/.test(catalog)))throw new Error('FLAC CUESHEET CD 标记或音轨数无效');
 let at=396,indexCount=0;const tracks:FlacCueTrack[]=[],numbers=new Set<number>();
 const sample=(position:number)=>{const value=raw.readBigUInt64BE(position);if(value>BigInt(totalSamples))throw new Error('FLAC CUESHEET 采样位置超出音频');return Number(value);};
 for(let i=0;i<count;i++){
  if(at+36>raw.length)throw new Error('FLAC CUESHEET 音轨结构不完整');
  const offset=sample(at),number=raw[at+8],isrc=paddedAscii(raw.subarray(at+9,at+21)),flags=raw[at+21],n=raw[at+35],last=i===count-1;
  if(!number||numbers.has(number)||isrc!==''&&!/^[A-Za-z0-9]{12}$/.test(isrc)||(flags&63)!==0||raw.subarray(at+22,at+35).some(v=>v!==0)||cd&&offset%588!==0||last&&(number!==(cd?170:255)||n!==0)||!last&&(number===(cd?170:255)||cd&&number>99||n===0||cd&&n>100))throw new Error('FLAC CUESHEET 音轨编号、索引或保留字段无效');
  numbers.add(number);at+=36;const indices:FlacCueTrack['indices']=[];
  if((indexCount+=n)>16384||at+n*12>raw.length)throw new Error('FLAC CUESHEET 索引超过预算或不完整');
  for(let j=0;j<n;j++){
   const relative=sample(at),index=raw[at+8],absolute=offset+relative,previous=indices.at(-1);
   if(absolute>=totalSamples||raw.subarray(at+9,at+12).some(v=>v!==0)||j===0&&relative!==0||previous&&(index<=previous.number||absolute<=previous.sample)||cd&&(relative%588!==0||j===0&&index>1||previous&&index!==previous.number+1))throw new Error('FLAC CUESHEET 索引顺序或位置无效');
   indices.push({number:index,sample:absolute});at+=12;
  }
  const previous=tracks.at(-1);if(previous&&(offset<=previous.offset||previous.indices.some(index=>index.sample>=offset)))throw new Error('FLAC CUESHEET 音轨范围重叠');
  tracks.push({number,offset,audio:!(flags&128),preEmphasis:Boolean(flags&64),isrc,indices});
 }
 if(at!==raw.length||tracks.at(-1)!.offset!==totalSamples)throw new Error('FLAC CUESHEET 尾部或 lead-out 与完整采样数不符');
 return {version:1,parserVersion:FLAC_CUE_PARSER,blockOffset,rawBase64:raw.toString('base64'),sourceHash:hash(raw),streamInfoBase64:streamInfo.toString('base64'),sampleRate,totalSamples,cd,catalog,leadIn,tracks};
}
export function readFlacCueSource(value:unknown,size:number):FlacCueSource {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('FLAC CUESHEET 来源无效');
 const v=value as Record<string,unknown>;
 if(typeof v.rawBase64!=='string'||v.rawBase64.length>Math.ceil(LIMIT/3)*4||typeof v.streamInfoBase64!=='string'||v.streamInfoBase64.length!==48||typeof v.blockOffset!=='number'||!Number.isSafeInteger(size))throw new Error('FLAC CUESHEET 来源超过预算');
 const raw=Buffer.from(v.rawBase64,'base64'),info=Buffer.from(v.streamInfoBase64,'base64');
 if(raw.toString('base64')!==v.rawBase64||info.toString('base64')!==v.streamInfoBase64||v.blockOffset+raw.length>=size)throw new Error('FLAC CUESHEET 原始字节或文件范围无效');
 const parsed=parseFlacCueBlock(raw,info,v.blockOffset);
 const keys=Object.keys(parsed);if(Object.keys(v).length!==keys.length||keys.some(key=>JSON.stringify(v[key])!==JSON.stringify(parsed[key as keyof FlacCueSource])))throw new Error('FLAC CUESHEET 解析回执与原始字节不符');
 return parsed;
}
export function flacCueEntries(source:Pick<FlacCueSource,'sampleRate'|'tracks'>,file:string,performer:string):{entries:CueEntry[];notice:string;timeBaseDen:number} {
 const audio=source.tracks.slice(0,-1),aligned=source.tracks.every(track=>Number.isSafeInteger(track.offset*75/source.sampleRate)&&track.indices.every(index=>Number.isSafeInteger(index.sample*75/source.sampleRate))),timeBaseDen=aligned?75:source.sampleRate,toFrame=(sample:number)=>aligned?sample*75/source.sampleRate:sample;
 if(!audio.length||audio.some(track=>!track.audio||!track.indices.some(index=>index.number===1)))return {entries:[],notice:'内嵌 CUESHEET 已识别；此编排没有可分音轨、包含非音频轨或缺少 INDEX 01，暂保留整文件播放。',timeBaseDen};
 const entries:CueEntry[]=audio.map((track,ordinal)=>({number:track.number,file,fileType:'WAVE',title:`音轨 ${String(track.number).padStart(2,'0')}`,performer,performerOrigin:'missing',sourceOrdinal:ordinal,index00Frame:track.indices.find(index=>index.number===0)?.sample===undefined?undefined:toFrame(track.indices.find(index=>index.number===0)!.sample),index01Frame:toFrame(track.indices.find(index=>index.number===1)!.sample),startFrame:toFrame(track.indices.find(index=>index.number===1)!.sample),endFrame:toFrame(source.tracks[ordinal+1].indices.find(index=>index.number===1)?.sample??source.tracks[ordinal+1].offset),indices:track.indices.map(index=>({number:index.number,frame:toFrame(index.sample)})),flags:track.preEmphasis?['PRE']:[],fields:[],isrc:track.isrc||undefined}));
 const first=entries[0];if(first.startFrame!>0)entries.push({number:0,file,fileType:'WAVE',title:'首轨隐藏音频',performer,performerOrigin:'missing',sourceOrdinal:0,hidden:true,index01Frame:0,startFrame:0,endFrame:first.startFrame,indices:[{number:1,frame:0}],flags:[],fields:[]});
 return {entries,notice:'',timeBaseDen};
}
