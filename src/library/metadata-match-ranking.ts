import {canonicalSearchText} from './search-normalization.js';
import type {LibraryItem,MetadataCandidate,MetadataMatchEvidence} from '../shared/contracts.js';
export const METADATA_RANKING_ALGORITHM='context-v1';
const key=(s:string)=>canonicalSearchText(s.slice(0,4096)).replace(/[\s\p{P}\p{S}]/gu,'');
const known=(s:string|undefined|null)=>Boolean(s?.trim()&&!/^(?:未知(?:标题|歌手|艺术家|艺人|专辑)?|unknown(?:\s+(?:title|artist|album))?)$/i.test(s.trim()));
function similarity(a:string,b:string):number{
 const x=key(a),y=key(b);if(!x||!y)return 0;if(x===y)return 1;
 const grams=(v:string)=>{const chars=[...v],set=new Set<string>();for(let i=0;i<chars.length-1;i++)set.add(chars[i]+chars[i+1]);return set;};
 const left=grams(x),right=grams(y);if(!left.size||!right.size)return 0;
 let common=0;for(const v of left)if(right.has(v))common++;
 return 2*common/(left.size+right.size);
}
function albumCore(value:string):string{
 // Only edition annotations are removed. Live/remix/acoustic versions stay distinct.
 return canonicalSearchText(value).replace(/[（(\[【]([^）)\]】]*)[）)\]】]/gu,(all,part:string)=>
  /(?:日版|台版|港版|欧版|美版|国版|再版|重制|豪华|限定|纪念|deluxe|remaster|edition|pressing|reissue|shm.?cd|sacd)/i.test(part)&&!/(?:现场|演唱会|live|remix|acoustic|instrumental)/i.test(part)?'':all);
}
export function rankMetadataCandidate(item:Pick<LibraryItem,'title'|'artist'|'album'|'durationSeconds'>,candidate:MetadataCandidate):MetadataCandidate{
 const evidence:MetadataMatchEvidence={algorithm:METADATA_RANKING_ALGORITHM,providerScore:candidate.matchEvidence?.providerScore??candidate.score,...(candidate.matchEvidence?.retrieval?{retrieval:{...candidate.matchEvidence.retrieval}}:{}),title:{kind:'different',similarity:similarity(item.title,candidate.title)},artist:{kind:'missing',similarity:null},album:{kind:'missing',similarity:null},duration:{kind:'missing',differenceSeconds:null},warnings:[]};
 evidence.title.kind=evidence.title.similarity===1?'exact':evidence.title.similarity>=0.7?'similar':'different';
 let earned=35*evidence.title.similarity,weight=35;
 if(known(item.artist)&&known(candidate.artist)){const s=similarity(item.artist,candidate.artist);evidence.artist={kind:s===1?'exact':s>=0.7?'similar':'different',similarity:s};earned+=25*s;weight+=25;}else{if(known(item.artist))weight+=25;evidence.warnings.push('歌手信息不足');}
 if(known(item.album)&&known(candidate.album)){
  let s=similarity(item.album,candidate.album!),kind:MetadataMatchEvidence['album']['kind']=s===1?'exact':s>=0.7?'similar':'different';
  if(kind!=='exact'&&key(albumCore(item.album))&&key(albumCore(item.album))===key(albumCore(candidate.album!))){s=0.9;kind='edition-title';evidence.warnings.push('专辑标题相近，具体发行版仍需核对');}
  evidence.album={kind,similarity:s};earned+=25*s;weight+=25;
 }else{if(known(item.album))weight+=25;evidence.warnings.push('专辑信息不足');}
 const local=item.durationSeconds,remote=candidate.durationSeconds;
 if(typeof local==='number'&&Number.isFinite(local)&&local>0&&typeof remote==='number'&&Number.isFinite(remote)&&remote>0){
  const differenceSeconds=Math.abs(local-remote),near=Math.max(2,local*0.01),far=Math.max(15,local*0.1),s=differenceSeconds<=near?1:differenceSeconds>=far?0:1-(differenceSeconds-near)/(far-near);
  evidence.duration={kind:differenceSeconds<=near?'close':differenceSeconds>=far?'different':'near',differenceSeconds:Math.round(differenceSeconds*1000)/1000};earned+=10*s;weight+=10;
 }else{if(typeof local==='number'&&Number.isFinite(local)&&local>0)weight+=10;evidence.warnings.push('时长信息不足');}
 earned+=5*Math.max(0,Math.min(100,evidence.providerScore))/100;weight+=5;
 if(evidence.title.kind==='different')evidence.warnings.push('歌名存在差异');
 if(evidence.artist.kind==='different')evidence.warnings.push('歌手存在差异');
 if(evidence.album.kind==='different')evidence.warnings.push('专辑存在差异');
 if(evidence.duration.kind==='different')evidence.warnings.push('时长差异较大，可能属于其他录音版本');
 return {...candidate,score:Math.round(earned/weight*100),matchEvidence:evidence};
}
