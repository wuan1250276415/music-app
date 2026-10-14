import {canonicalSearchText} from './search-normalization.js';
import type {MetadataAlbumReviewRow,MetadataAlbumRemoteTrack,MetadataAlbumSuggestion} from '../shared/metadata-album-review.js';
const key=(v:string)=>canonicalSearchText(v).replace(/[\s\p{P}\p{S}]/gu,'');
const grams=(v:string):Set<string>=>{const c=[...v],s=new Set<string>();for(let i=0;i<c.length-1;i++)s.add(c[i]+c[i+1]);return s;};
export class MetadataAlbumMatcher {
 private readonly keyed:Array<{track:MetadataAlbumRemoteTrack;key:string;grams:Set<string>}>;
 constructor(private readonly tracks:MetadataAlbumRemoteTrack[]){this.keyed=tracks.map(track=>{const value=key(track.title);return {track,key:value,grams:grams(value)};});}
 suggestions(local:Omit<MetadataAlbumReviewRow,'suggestions'>):MetadataAlbumSuggestion[]{
  const name=key(local.title),parts=grams(name),rated=this.keyed.map(remote=>{
   let common=0;for(const v of parts)if(remote.grams.has(v))common++;
   const similarity=name&&name===remote.key?1:parts.size&&remote.grams.size?2*common/(parts.size+remote.grams.size):0;
   const positionMatch=local.discNumber!==null&&local.trackNumber!==null&&local.discNumber===remote.track.discNumber&&local.trackNumber===remote.track.position;
   const known=local.knownRecordingIds??(local.knownRecordingId?[local.knownRecordingId]:[]),recordingMatch:MetadataAlbumSuggestion['recordingMatch']=!known.length?'unknown':known.includes(remote.track.recordingId??'')?'exact':'conflict';
   const durationDifference=local.durationSeconds!==null&&local.durationSeconds>0&&remote.track.durationSeconds!==null&&remote.track.durationSeconds>0?Math.round(Math.abs(local.durationSeconds-remote.track.durationSeconds)*1000)/1000:null;
   const length=durationDifference===null?0:Math.max(0,1-durationDifference/Math.max(15,local.durationSeconds!*0.1));
   const score=Math.round(50*similarity+(positionMatch?20:0)+20*length+(recordingMatch==='exact'?10:0));
   return {remote,similarity,positionMatch,recordingMatch,durationDifference,score};
  }).filter(v=>v.similarity>=0.4||v.positionMatch||v.recordingMatch==='exact').sort((a,b)=>Number(b.recordingMatch==='exact')-Number(a.recordingMatch==='exact')||b.score-a.score||a.remote.track.discNumber-b.remote.track.discNumber||a.remote.track.position-b.remote.track.position).slice(0,5);
  return rated.map(v=>{const warnings:string[]=[];if(v.similarity<1)warnings.push(v.similarity>=0.7?'曲名相近，仍需核对版本':'曲名不同');if(!v.positionMatch)warnings.push(local.discNumber===null||local.trackNumber===null?'本地碟号／曲号不足':'碟号／曲号不同');if(v.durationDifference===null)warnings.push('时长信息不足');else if(v.durationDifference>Math.max(2,local.durationSeconds!*0.01))warnings.push(`时长相差 ${v.durationDifference} 秒`);if(v.recordingMatch==='conflict')warnings.push('与已有录音外部引用冲突，不能采用');if(!v.remote.track.recordingId)warnings.push('来源未提供录音 ID，不能采用');if(this.tracks.filter(t=>t.recordingId!==null&&t.recordingId===v.remote.track.recordingId).length>1)warnings.push('同一录音在发行版出现多次，需确认具体曲目');return {...v.remote.track,score:v.score,titleMatch:v.similarity===1?'exact':v.similarity>=0.7?'similar':'different',positionMatch:v.positionMatch,recordingMatch:v.recordingMatch,durationDifference:v.durationDifference,warnings};});
 }
}
