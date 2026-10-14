import type {MetadataReleaseContext,MetadataReleaseTrack,MetadataProviderCredit} from '../shared/contracts.js';
const mbid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('专辑上下文对象无效');return v as Record<string,unknown>;};
const text=(v:unknown,max=240):string|null=>{if(v===undefined||v===null)return null;if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v))throw new Error('专辑上下文文字无效');return v.trim()||null;};
const id=(v:unknown):string=>{if(typeof v!=='string'||!mbid.test(v))throw new Error('专辑上下文身份无效');return v.toLowerCase();};
const integer=(v:unknown,min:number,max:number):number=>{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw new Error('专辑上下文数量或顺序无效');return Number(v);};
export function parseMetadataReleaseContext(payload:unknown,releaseId:string,credits:(value:unknown)=>MetadataProviderCredit[]):MetadataReleaseContext{
 const v=object(payload);if(id(v.id)!==releaseId.toLowerCase())throw new Error('专辑上下文身份与请求不一致');
 const title=text(v.title);if(!title)throw new Error('专辑上下文缺少标题');
 const group=v['release-group']===undefined||v['release-group']===null?null:object(v['release-group']);
 const secondary=group?.['secondary-types'];if(secondary!==undefined&&(!Array.isArray(secondary)||secondary.length>8))throw new Error('专辑类型范围无效');
 const rawLabels=v['label-info']??[];if(!Array.isArray(rawLabels)||rawLabels.length>64)throw new Error('唱片公司范围无效');
 const labels=rawLabels.map(raw=>{const info=object(raw),label=info.label==null?null:object(info.label);return {id:label?.id==null?null:id(label.id),name:label?text(label.name)||'未知唱片公司':'未知唱片公司',catalogNumber:text(info['catalog-number'],128)};});
 if(!Array.isArray(v.media)||!v.media.length||v.media.length>64)throw new Error('专辑介质范围无效');
 const seenMedia=new Set<number>(),seenTracks=new Set<string>();let loaded=0;
 const media=v.media.map(raw=>{
  const medium=object(raw),position=integer(medium.position,1,64),trackCount=integer(medium['track-count'],0,1000);
  if(seenMedia.has(position))throw new Error('专辑介质顺序重复');seenMedia.add(position);
  const ordinary=medium.tracks??[];
  if(!Array.isArray(ordinary)||ordinary.length>trackCount)throw new Error('专辑曲目表数量无效');
  const extra=medium['data-tracks']??[];
  if(!Array.isArray(extra)||extra.length>1000)throw new Error('附加曲目范围无效');
  if(medium['track-offset']!==undefined)integer(medium['track-offset'],0,1000);
  const positions=new Set<number>();
  const parseTrack=(raw:unknown,kind:'audio'|'pregap'|'data'):MetadataReleaseTrack=>{
   const track=object(raw),trackId=id(track.id),pos=integer(track.position,kind==='pregap'?0:1,kind==='pregap'?0:1000);
   if(seenTracks.has(trackId)||positions.has(pos))throw new Error('专辑曲目身份或顺序重复');seenTracks.add(trackId);positions.add(pos);
   const recording=track.recording==null?null:object(track.recording),title=text(track.title)??(recording?text(recording.title):null);
   if(!title)throw new Error('专辑曲目缺少标题');
   const length=track.length??recording?.length;
   const value:MetadataReleaseTrack={kind,id:trackId,position:pos,number:text(track.number,64)??String(pos),title,recordingId:recording?.id==null?null:id(recording.id),recordingTitle:recording?text(recording.title):null,lengthMs:length==null?null:integer(length,0,604800000),...(track['artist-credit']===undefined?{}:{credits:credits(track['artist-credit'])}),...(recording?.['artist-credit']===undefined?{}:{recordingCredits:credits(recording['artist-credit'])})};
   return value;
  };
  const tracks=ordinary.map(raw=>parseTrack(raw,'audio')),pregap=medium.pregap==null?null:parseTrack(medium.pregap,'pregap'),dataTracks=extra.map(raw=>parseTrack(raw,'data'));
  loaded+=tracks.length+dataTracks.length+(pregap?1:0);if(loaded>1000)throw new Error('专辑上下文超过1000首曲目的预览范围');
  // MusicBrainz track-count counts CD-TOC audio only. Pregap and data are separate.
  // All positive positions must be accounted for, including a leading data track.
  const positiveCount=trackCount+dataTracks.length,complete=tracks.length===trackCount&&Array.from({length:positiveCount},(_,n)=>n+1).every(n=>positions.has(n))&&(medium['track-offset']??0)===0;
  return {position,title:text(medium.title),format:text(medium.format,64),trackCount,trackListComplete:complete,additionalTracksUnreviewed:false,tracks:tracks.sort((a,b)=>a.position-b.position),pregap,dataTracks:dataTracks.sort((a,b)=>a.position-b.position)};
 });
 return {releaseId:releaseId.toLowerCase(),title,date:text(v.date,32),country:text(v.country,16),status:text(v.status,32),disambiguation:text(v.disambiguation),barcode:text(v.barcode,64),artists:credits(v['artist-credit']),labels,group:group?{id:id(group.id),title:text(group.title)||title,primaryType:text(group['primary-type'],64),secondaryTypes:Array.isArray(secondary)?secondary.map(t=>text(t,64)||'').filter(Boolean):[]}:null,media:media.sort((a,b)=>a.position-b.position)};
}
