import type {ArtistRole,GenreFilter} from './contracts.js';
export const MUSIC_CODEC_FAMILIES=['flac','pcm','alac','mp3','aac','vorbis','opus','dsd','unknown'] as const;
export type MusicCodecFamily=typeof MUSIC_CODEC_FAMILIES[number];
export interface MusicFilters {
 artists?:{ids:string[];role:ArtistRole;operator:'any'|'all'};
 genres?:GenreFilter;
 years?:{min:number;max:number};
 codecs?:MusicCodecFamily[];
 quality?:'lossless'|'lossy'|'unknown';
 pcmRates?:{min:number;max:number};
 bitDepths?:number[];
 dsdRates?:number[];
 favorite?:boolean;
 ratingAtLeast?:number;
 available?:boolean;
 playCount?:{min:number;max:number};
 lastPlayed?:{mode:'never'}|{mode:'within-days';days:number}|{mode:'outside-days';days:number;includeNever:boolean};
 addedWithinDays?:number;
}
export const MUSIC_FILTER_MAX_DAYS=36500;
export const MUSIC_FILTER_MINUTE_MS=60000;
export function musicFilterTimeAnchor(now=Date.now()):number{
 if(!Number.isSafeInteger(now)||now<0||now>253402300739999)throw new Error('相对时间筛选基准无效');
 return Math.floor(now/MUSIC_FILTER_MINUTE_MS)*MUSIC_FILTER_MINUTE_MS;
}
const record=(v:unknown,keys:string[]):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('无效组合筛选字段');return v as Record<string,unknown>;};
const integer=(v:unknown,min:number,max:number)=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error('组合筛选数值超出范围');return v;};
const ids=(v:unknown)=>{if(!Array.isArray(v)||v.length<1||v.length>16||new Set(v).size!==v.length||v.some(id=>typeof id!=='string'||!id||id.length>128||id.includes('\0')))throw new Error('组合筛选身份最多16项且不能重复');return [...v as string[]].sort();};
const numbers=(v:unknown,allowed:number[])=>{if(!Array.isArray(v)||!v.length||v.length>allowed.length||new Set(v).size!==v.length||v.some(n=>!allowed.includes(n)))throw new Error('无效源音频筛选值');return [...v as number[]].sort((a,b)=>a-b);};
export function readMusicFilters(value:unknown):MusicFilters {
 const v=record(value,['artists','genres','years','codecs','quality','pcmRates','bitDepths','dsdRates','favorite','ratingAtLeast','available','playCount','lastPlayed','addedWithinDays']),out:MusicFilters={};
 if(v.artists!==undefined){const a=record(v.artists,['ids','role','operator']);if(typeof a.role!=='string'||!['performer','album_artist','composer','conductor','orchestra'].includes(a.role)||typeof a.operator!=='string'||!['any','all'].includes(a.operator))throw new Error('无效组合艺人角色');out.artists={ids:ids(a.ids),role:a.role as ArtistRole,operator:a.operator as 'any'|'all'};}
 if(v.genres!==undefined){const g=record(v.genres,['ids','operator','descendants']);if(typeof g.operator!=='string'||!['any','all'].includes(g.operator)||typeof g.descendants!=='boolean')throw new Error('无效组合风格条件');out.genres={ids:ids(g.ids),operator:g.operator as 'any'|'all',descendants:g.descendants};}
 for(const key of ['years','pcmRates'] as const)if(v[key]!==undefined){const r=record(v[key],['min','max']),min=integer(r.min,1,key==='years'?9999:1536000),max=integer(r.max,1,key==='years'?9999:1536000);if(min>max)throw new Error('组合筛选下限不能大于上限');out[key]={min,max};}
 if(v.codecs!==undefined){if(!Array.isArray(v.codecs)||!v.codecs.length||v.codecs.length>MUSIC_CODEC_FAMILIES.length||new Set(v.codecs).size!==v.codecs.length||v.codecs.some(c=>!MUSIC_CODEC_FAMILIES.includes(c)))throw new Error('无效源编码筛选');out.codecs=[...v.codecs].sort() as MusicCodecFamily[];}
 if(v.quality!==undefined){if(typeof v.quality!=='string'||!['lossless','lossy','unknown'].includes(v.quality))throw new Error('无效源编码质量筛选');out.quality=v.quality as MusicFilters['quality'];}
 if(v.bitDepths!==undefined)out.bitDepths=numbers(v.bitDepths,[8,16,20,24,32,64]);
 if(v.dsdRates!==undefined)out.dsdRates=numbers(v.dsdRates,[64,128,256,512]);
 for(const key of ['favorite','available'] as const)if(v[key]!==undefined){if(typeof v[key]!=='boolean')throw new Error('无效组合筛选状态');out[key]=v[key];}
 if(v.ratingAtLeast!==undefined)out.ratingAtLeast=integer(v.ratingAtLeast,1,5);
 if(v.playCount!==undefined){const r=record(v.playCount,['min','max']),min=integer(r.min,0,Number.MAX_SAFE_INTEGER),max=integer(r.max,0,Number.MAX_SAFE_INTEGER);if(min>max)throw new Error('播放次数下限不能大于上限');out.playCount={min,max};}
 if(v.lastPlayed!==undefined){
  const r=record(v.lastPlayed,['mode','days','includeNever']);
  if(r.mode==='never'){if(Object.keys(r).length!==1)throw new Error('未播放条件不能附带天数');out.lastPlayed={mode:'never'};}
  else if(r.mode==='within-days'){if(Object.keys(r).length!==2)throw new Error('最近播放条件无效');out.lastPlayed={mode:r.mode,days:integer(r.days,1,MUSIC_FILTER_MAX_DAYS)};}
  else if(r.mode==='outside-days'){if(Object.keys(r).length!==3||typeof r.includeNever!=='boolean')throw new Error('长期未播需明确是否包含无记录歌曲');out.lastPlayed={mode:r.mode,days:integer(r.days,1,MUSIC_FILTER_MAX_DAYS),includeNever:r.includeNever};}
  else throw new Error('播放时间筛选模式无效');
 }
 if(v.addedWithinDays!==undefined)out.addedWithinDays=integer(v.addedWithinDays,1,MUSIC_FILTER_MAX_DAYS);
 return out;
}
export function musicFilterCount(value:MusicFilters):number{return Object.keys(readMusicFilters(value)).length;}
export function musicFilterDependencies(...values:Array<MusicFilters|undefined>):{counts:boolean;recency:boolean;relative:boolean}{
 const filters=values.filter(v=>v!==undefined).map(v=>readMusicFilters(v));
 return {counts:filters.some(f=>f.playCount!==undefined),recency:filters.some(f=>f.lastPlayed!==undefined),relative:filters.some(f=>f.addedWithinDays!==undefined||f.lastPlayed&&f.lastPlayed.mode!=='never')};
}
