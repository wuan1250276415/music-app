import {promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseFromTokenizer,TimestampFormat,LyricsContentType,type IAudioMetadata} from 'music-metadata';
import {parseLrc,cueLyrics,localSidecarFamilies,normalizeSidecarLyrics,type LyricsContext} from './lyrics.js';
import {ScanTokenizer} from './media-scan.js';
import {insideMediaRoot,mediaStat,sameMediaStat,MediaBoundaryError,lyricsDocumentId,validateLyricsDocuments,type MediaRequest,type LocalLyricsObservation} from './media-worker-protocol.js';
import type {LyricsDocument} from '../shared/contracts.js';
const normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value;

async function embeddedLyrics(item:LyricsContext&{path:string},handle:FileHandle,size:number,notices:Set<string>):Promise<LyricsDocument[]> {
  try{
    const tokenizer=new ScanTokenizer(handle,item.path,size,new AbortController().signal);
    let metadata:IAudioMetadata|undefined;
    try{metadata=await parseFromTokenizer(tokenizer,{skipCovers:true,duration:false,observer:event=>{metadata=event.metadata;}});tokenizer.finish();}
    catch{notices.add('内嵌标签未完整读取，保留此前解析出的有效歌词。');}
    if(!metadata)return [];
    const documents:LyricsDocument[]=[];
    const add=(document:LyricsDocument)=>{const scoped=cueLyrics({...document,sourceKind:'embedded'},item);if(scoped?.lines.length)documents.push(scoped);};
    // Preserve raw LRC offsets and repeated timestamps before the tag library normalizes them.
    let tagsRead=0;
    rawTags:for(const tags of Object.values(metadata.native))for(const tag of tags){
      if(documents.length>=16)break rawTags;
      if(++tagsRead>4096){notices.add('内嵌标签遍历已达到预算。');break rawTags;}
      if(!['LYRICS','UNSYNCEDLYRICS','USLT','ULT','©LYR','WM/LYRICS'].includes(tag.id.toUpperCase()))continue;
      const detail=tag.value&&typeof tag.value==='object'?tag.value as {text?:unknown;language?:unknown;descriptor?:unknown}:null;
      const value=typeof tag.value==='string'?tag.value:detail?.text;
      if(typeof value==='string')add({...parseLrc(value,'歌曲内嵌歌词'),language:typeof detail?.language==='string'?detail.language.slice(0,32):undefined,descriptor:typeof detail?.descriptor==='string'?detail.descriptor.slice(0,128):undefined,encoding:'标签解码'});
    }
    for(const lyric of metadata.common.lyrics??[]){
      if(documents.length>=16)break;
      if(lyric.contentType!==LyricsContentType.lyrics&&lyric.contentType!==LyricsContentType.text)continue;
      if(lyric.timeStampFormat===TimestampFormat.milliseconds&&Array.isArray(lyric.syncText)&&lyric.syncText.length<=5000){
        const lines=lyric.syncText.filter(line=>typeof line.text==='string'&&line.text.trim()&&!line.text.includes('\0')&&Buffer.byteLength(line.text,'utf8')<=32768&&typeof line.timestamp==='number'&&Number.isFinite(line.timestamp)&&line.timestamp>=0&&line.timestamp<=Number.MAX_SAFE_INTEGER).map(line=>({text:line.text.trim(),atSeconds:line.timestamp!/1000})).sort((a,b)=>a.atSeconds-b.atSeconds);
        if(lines.reduce((bytes,line)=>bytes+Buffer.byteLength(line.text,'utf8'),0)<=1024*1024)add({source:'歌曲内嵌同步歌词',kind:'timed',lines,language:lyric.language?.slice(0,32),descriptor:lyric.descriptor?.slice(0,128),encoding:'标签解码',sourceOffsetMs:0});
      }else if(lyric.timeStampFormat!==TimestampFormat.mpegFrameNumber&&typeof lyric.text==='string')add({...parseLrc(lyric.text,'歌曲内嵌歌词'),language:lyric.language?.slice(0,32),descriptor:lyric.descriptor?.slice(0,128),encoding:'标签解码'});
    }
    return documents;
  }catch{notices.add('部分内嵌歌词无法解析。');return [];}
}

async function sidecarLyrics(item:LyricsContext&{path:string},request:MediaRequest,notices:Set<string>,observations:Map<string,LocalLyricsObservation>):Promise<LyricsDocument[]> {
  const folder=path.dirname(item.path);
  const families=localSidecarFamilies(item);
  if(!families.length)return [];
  const discovered:string[]=[];
  // One bounded directory walk, with title-relative documents ordered before album clocks.
  try{
    const directory=await fs.opendir(folder);let count=0;
    for await(const entry of directory){
      if(++count>4096){notices.add('目录枚举达到预算，部分语言歌词可能未发现。');break;}
      if(families.some(({base})=>entry.name.toLowerCase().startsWith(`${base.toLowerCase()}.`)&&/^(?:\.[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3})?\.(?:lrc|txt)$/i.test(entry.name.slice(base.length))))discovered.push(entry.name);
    }
  }catch{notices.add('歌词目录暂不可枚举，仅尝试精确名称。');}
  const candidates=families.flatMap(family=>{
   const exact=[`${family.base}.lrc`,`${family.base}.txt`].map(name=>discovered.find(found=>found===name)??discovered.find(found=>found.toLowerCase()===name.toLowerCase())??name);
   const extras=discovered.filter(name=>name.toLowerCase().startsWith(`${family.base.toLowerCase()}.`)&&/^\.[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}\.(?:lrc|txt)$/i.test(name.slice(family.base.length))).sort();
   return [...exact,...extras.slice(0,14)].map(name=>({...family,name}));
  });
  const seen=new Set<string>();let rawBytes=0;
  const documents:LyricsDocument[]=[];
  for (const {name,base,timeBasis} of candidates) {
    if(documents.length>=16)break;
    if(seen.has(name.toLowerCase()))continue;seen.add(name.toLowerCase());
    if (name==='.lrc' || name==='.txt') continue;
    const candidate=path.join(folder,name);
    try {
      const link=await fs.lstat(candidate);
      if(!link.isFile()||link.isSymbolicLink())throw new MediaBoundaryError('歌词来源类型不在授权范围内');
      if(normalize(await fs.realpath(request.rootPath))!==normalize(request.realRootPath)||!insideMediaRoot(normalize(request.realRootPath),normalize(await fs.realpath(candidate))))throw new MediaBoundaryError('歌词来源已越过授权目录');
      const file=await fs.open(candidate,'r');let bytes:Buffer,before:LocalLyricsObservation['before'];
      try{
        const stat=await file.stat();if(!stat.isFile()||stat.size>1024*1024||rawBytes+stat.size>16*1024*1024){notices.add('部分歌词超过文件大小预算。');continue;}rawBytes+=stat.size;
        if(!sameMediaStat(mediaStat(link),mediaStat(stat)))throw new Error('歌词文件已变化');
        before=mediaStat(stat);
        const buffer=Buffer.alloc(stat.size+1);let length=0;
        while(length<buffer.length){const read=await file.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
        if(length!==stat.size)throw new Error('歌词读取期间变化');bytes=buffer.subarray(0,length);
        const after=await file.stat();if(!sameMediaStat(mediaStat(stat),mediaStat(after))||!sameMediaStat(mediaStat(after),mediaStat(await fs.stat(candidate))))throw new Error('歌词读取期间变化');
        if(normalize(await fs.realpath(request.rootPath))!==normalize(request.realRootPath)||!insideMediaRoot(normalize(request.realRootPath),normalize(await fs.realpath(candidate))))throw new MediaBoundaryError('歌词读取期间越过授权目录');
      }finally{await file.close();}
      let decoded: string,encoding:string;
      if (bytes[0]===0xff&&bytes[1]===0xfe) {decoded=new TextDecoder('utf-16le',{fatal:true}).decode(bytes.subarray(2));encoding='UTF-16LE';}
      else if(bytes[0]===0xfe&&bytes[1]===0xff){decoded=new TextDecoder('utf-16be',{fatal:true}).decode(bytes.subarray(2));encoding='UTF-16BE';}
      else {
        try {decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes);encoding='UTF-8';}
        catch {decoded=new TextDecoder('gb18030',{fatal:true}).decode(bytes);encoding='GB18030（回退）';}
      }
      const document=normalizeSidecarLyrics(parseLrc(decoded,candidate),item,timeBasis);
      const language=/^\.([a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3})\.(?:lrc|txt)$/i.exec(name.slice(base.length))?.[1];
      if(document?.lines.length){
       const complete={...document,sourceKind:'sidecar' as const,label:name,language,encoding},documentId=lyricsDocumentId(complete);
       observations.set(documentId,{documentId,source:candidate,rawBase64:bytes.toString('base64'),rawSha256:createHash('sha256').update(bytes).digest('hex'),encoding:encoding==='UTF-16LE'?'utf-16le':encoding==='UTF-16BE'?'utf-16be':encoding==='UTF-8'?'utf-8':'gb18030',before});documents.push(complete);
      }
    } catch(error) {if(error instanceof MediaBoundaryError)throw error;if((error as NodeJS.ErrnoException).code!=='ENOENT')notices.add('部分本地歌词不可读取、解码失败或读取期间变化。');}
  }
  return documents;
}

export async function readWorkerLyrics(request:MediaRequest,handle:FileHandle):Promise<{documents:LyricsDocument[];observations:LocalLyricsObservation[];notice:string}> {
  if(request.kind!=='lyrics'||!request.lyricsContext)throw new Error('无效歌词任务');
  const item={...request.lyricsContext,path:request.fullPath};
  const notices=new Set<string>(),observations=new Map<string,LocalLyricsObservation>(),embedded=await embeddedLyrics(item,handle,request.before.size,notices),sidecars=await sidecarLyrics(item,request,notices,observations);
  const ordered=item.kind==='cue'?[...sidecars,...embedded]:[...embedded.filter(doc=>doc.kind==='timed'),...sidecars,...embedded.filter(doc=>doc.kind==='plain')];
  const sources:LyricsDocument[]=[],seen=new Set<string>();let bytes=0;
  for(const doc of ordered){
    if(sources.length>=16)break;
    // Raw and normalized tag views of the same content should not create duplicate choices.
    const digest=lyricsDocumentId(doc);
    if(seen.has(digest))continue;seen.add(digest);
    const document={...doc,id:digest,label:doc.label??`${doc.source}${doc.language?` · ${doc.language}`:''}${doc.descriptor?` · ${doc.descriptor}`:''}`,encoding:doc.encoding??'标签解码',sourceOffsetMs:doc.sourceOffsetMs??0};
    try{validateLyricsDocuments([document],request);}catch{notices.add('部分歌词内容超过预算或字段无效。');continue;}
    const size=Buffer.byteLength(JSON.stringify(document),'utf8');if(bytes+size+sources.length+2>1536*1024){notices.add('歌词集合已达到显示预算。');continue;}bytes+=size;
    sources.push(document);
  }
  return {documents:sources,observations:sources.flatMap(doc=>observations.has(doc.id!)?[observations.get(doc.id!)!]:[]),notice:[...notices].join(' ').slice(0,500)};
}
