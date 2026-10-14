import {promises as fs} from 'node:fs';
import path from 'node:path';
import {MediaParser,MediaWorkerExitUnconfirmed} from './media-worker-client.js';
import {fileObservation,requireFileObservation} from '../platform/file-observation.js';
import {insideMediaRoot,mediaStat,sameMediaStat,MediaBoundaryError,type LocalLyricsObservation} from './media-worker-protocol.js';
import type {LibraryItem,LyricsDocument} from '../shared/contracts.js';
import {localLyricsContext,type LyricsContext} from './lyrics.js';

type Loaded={documents:LyricsDocument[];observations:LocalLyricsObservation[];notice:string};
const normalized=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
export class LocalLyricsLoader{
 private readonly pending=new Map<string,Promise<Loaded>>();
 constructor(private readonly parser:MediaParser){}
 load(item:LibraryItem,rootPath:string):Promise<Loaded>{
  if(!item.available)return Promise.resolve({documents:[],observations:[],notice:'音乐文件离线，仍可使用已导入的歌词。'});
  const lyricsContext=localLyricsContext(item);
  const key=JSON.stringify([item.id,item.fileId,item.path,item.fileStamp,item.fileObservation,rootPath,lyricsContext]),previous=this.pending.get(key);if(previous)return previous;
  if(this.pending.size>=8)return Promise.reject(new Error('歌词读取等待已满，请稍后重试'));
  const task=this.read(item,rootPath,lyricsContext).finally(()=>this.pending.delete(key));this.pending.set(key,task);return task;
 }
 private async read(item:LibraryItem,rootPath:string,lyricsContext:LyricsContext):Promise<Loaded>{
  try{
   const realRootPath=await fs.realpath(rootPath);
   if(!insideMediaRoot(normalized(realRootPath),normalized(await fs.realpath(item.path))))throw new MediaBoundaryError('音乐文件已越过授权目录');
   const link=await fs.lstat(item.path);if(!link.isFile()||link.isSymbolicLink())throw new MediaBoundaryError('音乐文件类型已变化');
   const handle=await fs.open(item.path,'r');
   try{
    const observation=requireFileObservation(item.fileObservation,await handle.stat({bigint:true}));
    const before=await handle.stat();if(!before.isFile()||!sameMediaStat(mediaStat(link),mediaStat(before))||fileObservation(await handle.stat({bigint:true}))!==observation)throw new Error('音乐文件已变化');
    const loaded=await this.parser.lyrics({rootPath,realRootPath,fullPath:item.path,relativePath:path.relative(rootPath,item.path),before:mediaStat(before),lyricsContext},new AbortController().signal);
    const after=await handle.stat();if(!sameMediaStat(mediaStat(before),mediaStat(after))||!sameMediaStat(mediaStat(after),mediaStat(await fs.stat(item.path)))||fileObservation(await handle.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(item.path,{bigint:true}))!==observation)throw new Error('音乐文件读取期间变化');
    if(normalized(await fs.realpath(rootPath))!==normalized(realRootPath)||!insideMediaRoot(normalized(realRootPath),normalized(await fs.realpath(item.path))))throw new MediaBoundaryError('音乐文件读取期间越过授权目录');
    return loaded;
   }finally{await handle.close();}
  }catch(error){
   if(error instanceof MediaBoundaryError||error instanceof MediaWorkerExitUnconfirmed)throw error;
   return {documents:[],observations:[],notice:`本地／内嵌歌词未完成读取，仍可使用已导入歌词。${String(error instanceof Error?error.message:error).replace(/\0/g,'').slice(0,300)}`};
  }
 }
}
