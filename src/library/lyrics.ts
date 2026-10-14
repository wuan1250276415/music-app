import path from 'node:path';
import type {LibraryItem,LyricsDocument} from '../shared/contracts.js';
export interface LyricsContext {kind:'file'|'cue';title:string;sourceStartSeconds:number;sourceEndSeconds:number|null;sourceStartCueFrame:number|null;sourceEndCueFrame:number|null;cueIndex01Frame:number|null;cueIndex01Seconds?:number|null}

export type SidecarTimeBasis='track-relative'|'audio-absolute';
export function localLyricsContext(item:LibraryItem):LyricsContext{
 return {kind:item.kind,title:item.title,sourceStartSeconds:item.sourceStartSeconds,sourceEndSeconds:item.sourceEndSeconds,sourceStartCueFrame:item.sourceStartCueFrame,sourceEndCueFrame:item.sourceEndCueFrame,cueIndex01Frame:item.kind==='cue'&&(item.cue?.timeBaseDen??75)===75?item.cue?.index01Frame??item.sourceStartCueFrame:null,cueIndex01Seconds:item.kind==='cue'&&item.cue?item.cue.index01Frame/(item.cue.timeBaseDen??75):null};
}
export function localSidecarFamilies(item:Pick<LibraryItem,'kind'|'title'|'path'>):Array<{base:string;timeBasis:SidecarTimeBasis}>{
 const stem=path.basename(item.path,path.extname(item.path)),title=item.title.replace(/[<>:"/\\|?*]/g,'').trim();
 // A coincident title and audio stem keeps the existing title-relative convention.
 const families:Array<{base:string;timeBasis:SidecarTimeBasis}>=item.kind==='cue'?[{base:title,timeBasis:'track-relative'},{base:stem,timeBasis:'audio-absolute'}]:[{base:stem,timeBasis:'track-relative'}];
 return families.filter((family,index)=>!!family.base&&!families.slice(0,index).some(previous=>previous.base.toLowerCase()===family.base.toLowerCase()));
}
export function localSidecarTimeBasis(source:string,item:Pick<LibraryItem,'kind'|'title'|'path'>):SidecarTimeBasis|null{
 const name=path.basename(source);
 for(const family of localSidecarFamilies(item)){
  if(!name.toLowerCase().startsWith(family.base.toLowerCase()))continue;
  if(/^(?:\.[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3})?\.(?:lrc|txt)$/i.test(name.slice(family.base.length)))return family.timeBasis;
 }
 return null;
}
export function normalizeSidecarLyrics(document:LyricsDocument,item:LyricsContext,timeBasis:SidecarTimeBasis):LyricsDocument|null{
 return timeBasis==='audio-absolute'?cueLyrics(document,item):cueTitleLyrics(document,item);
}

// A title-named CUE sidecar starts at INDEX01. Keep album-file lyrics on the
// absolute source clock and translate only this track-relative local document.
export function cueTitleLyrics(document:LyricsDocument,item:LyricsContext):LyricsDocument{
 if(item.kind!=='cue'||document.kind!=='timed')return document;
 const index=item.cueIndex01Seconds??(item.cueIndex01Frame===null?null:item.cueIndex01Frame/75);
 if(index===null)return document;
 const lead=index-item.sourceStartSeconds;
 return lead>0?{...document,lines:document.lines.map(line=>({...line,atSeconds:line.atSeconds+lead}))}:document;
}

export function parseLrc(text: string, source: string): LyricsDocument {
  if(Buffer.byteLength(text,'utf8')>1024*1024||text.includes('\0')||text.split(/\r?\n/).some(line=>Buffer.byteLength(line,'utf8')>32768))return {source,kind:'plain',lines:[]};
  const entries: Array<{atSeconds:number;text:string}> = [];
  let offsetSeconds=0,sourceOffsetMs=0,renderedBytes=0;
  for (const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)) {
    const offset=/^\[offset:([+-]?\d+)\]/i.exec(line.trim());
    if (offset) {const milliseconds=Number(offset[1]);if(Number.isSafeInteger(milliseconds)){sourceOffsetMs=milliseconds;offsetSeconds=milliseconds/1000;}continue;}
    const stamps=[...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content=line.replace(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g,'').trim();
    if (!stamps.length || !content) continue;
    const contentBytes=Buffer.byteLength(content,'utf8');
    for (const stamp of stamps) {
      const sec=Number(stamp[2]);
      if (sec>=60) continue;
      const fraction=stamp[3]?Number(stamp[3])/Math.pow(10,stamp[3].length):0;
      renderedBytes+=contentBytes;if(renderedBytes>1024*1024)return {source,kind:'plain',lines:[]};
      entries.push({atSeconds:Number(stamp[1])*60+sec+fraction,text:content});
      if(entries.length>5000)return {source,kind:'plain',lines:[]};
    }
  }
  if (entries.length) {
    // LRC offset applies to the complete document, including stamps before the tag.
    for(const entry of entries)entry.atSeconds+=offsetSeconds;
    entries.sort((a,b)=>a.atSeconds-b.atSeconds);
    return {source,kind:'timed',sourceOffsetMs,lines:entries};
  }
  const plain:Array<{atSeconds:number;text:string}>=[];
  for(const value of text.split(/\r?\n/)){const line=value.trim();if(!line||/^\[[a-z]+:/i.test(line))continue;if(plain.length>=5000)return {source,kind:'plain',lines:[]};plain.push({atSeconds:0,text:line});}
  return {source,kind:'plain',sourceOffsetMs:0,lines:plain};
}

export function cueLyrics(document:LyricsDocument,item:Pick<LyricsContext,'kind'|'sourceStartSeconds'|'sourceEndSeconds'|'sourceStartCueFrame'|'sourceEndCueFrame'>):LyricsDocument|null {
  if(item.kind!=='cue')return document;
  // Album-file timestamps are absolute; the player's CUE position is track-relative.
  if(document.kind!=='timed')return null;
  const start=item.sourceStartCueFrame!==null&&Number.isSafeInteger(item.sourceStartCueFrame)?item.sourceStartCueFrame/75:item.sourceStartSeconds;
  const end=item.sourceEndCueFrame!==null&&Number.isSafeInteger(item.sourceEndCueFrame)?item.sourceEndCueFrame/75:item.sourceEndSeconds;
  if(!Number.isFinite(start)||start<0||end!==null&&(!Number.isFinite(end)||end<=start))return null;
  const lines=document.lines.filter(line=>line.atSeconds>=start&&(end===null||line.atSeconds<end)).map(line=>({...line,atSeconds:line.atSeconds-start}));
  return lines.length?{...document,lines}:null;
}

