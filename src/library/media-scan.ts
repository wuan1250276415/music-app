import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {FileTokenizer,type IReadChunkOptions} from 'strtok3';
import type {ParsedFile} from './database.js';
import {fileReplayGain} from './replay-gain.js';
import {readEmbeddedFlacCues} from './flac-cue-reader.js';

export class ScanTokenizer extends FileTokenizer{
 private remaining=32*1024*1024;
 private operations=0;
 private async tick():Promise<void>{this.signal.throwIfAborted();if(performance.now()>this.deadline)throw new Error('标签读取超过 20 秒预算');if(++this.operations%64===0)await new Promise<void>(resolve=>setImmediate(resolve));this.signal.throwIfAborted();}
 private readonly deadline=performance.now()+20000;
 constructor(handle:FileHandle,filePath:string,size:number,private readonly signal:AbortSignal){super(handle,{fileInfo:{path:filePath,size}});}
 private budget(buffer:Uint8Array,options?:IReadChunkOptions):void{
  this.signal.throwIfAborted();if(performance.now()>this.deadline)throw new Error('标签读取超过 20 秒预算');
  const length=options?.length??buffer.length;if(!Number.isSafeInteger(length)||length<0||length>this.remaining)throw new Error('标签读取超过 32 MiB 预算');this.remaining-=length;
 }
 override async readBuffer(buffer:Uint8Array,options?:IReadChunkOptions):Promise<number>{await this.tick();this.budget(buffer,options);const n=await super.readBuffer(buffer,options);this.signal.throwIfAborted();return n;}
 override async peekBuffer(buffer:Uint8Array,options?:IReadChunkOptions):Promise<number>{await this.tick();this.budget(buffer,options);const n=await super.peekBuffer(buffer,options);this.signal.throwIfAborted();return n;}
 override async ignore(length:number):Promise<number>{await this.tick();if(!Number.isSafeInteger(length)||length<0)throw new Error('标签跳过位置无效');return super.ignore(length);}
 override setPosition(position:number):void{this.signal.throwIfAborted();if(!Number.isSafeInteger(position)||position<0||position>this.fileInfo.size)throw new Error('标签定位越界');super.setPosition(position);}
 finish():void{this.signal.throwIfAborted();if(performance.now()>this.deadline)throw new Error('标签读取超过 20 秒预算');}
 // Ownership stays with the scanner so its final fstat observes the same handle.
 override async close():Promise<void>{}
}

export async function parseMedia(full: string, relativePath: string, stat: { size: number; mtimeMs: number },handle:FileHandle,signal:AbortSignal): Promise<ParsedFile> {
  const fallback = path.basename(full,path.extname(full));
  const basic: ParsedFile = {
    relativePath,size:stat.size,mtimeMs:stat.mtimeMs,title:fallback,
    artist:'未知艺术家',album:'未知专辑',genre:'',durationSeconds:null,
    codec:path.extname(full).slice(1).toUpperCase(),sampleRate:null,bitsPerSample:null,trackNumber:null,discNumber:null,
    catalog:{fieldOrigins:{title:'filename',artist:'missing',album:'missing'}}
  };
  try {
    const { parseFromTokenizer } = await import('music-metadata');
    const tokenizer=new ScanTokenizer(handle,full,stat.size,signal);
    const meta = await parseFromTokenizer(tokenizer,{skipCovers:true,duration:false});tokenizer.finish();
    const embeddedCue=await readEmbeddedFlacCues(handle,stat.size,signal);
    if(embeddedCue!==undefined){basic.embeddedCue=embeddedCue.cue;basic.embeddedCueText=embeddedCue.text;}
    basic.title = meta.common.title?.trim() || fallback;
    basic.artist = meta.common.artist?.trim() || meta.common.albumartist?.trim() || '未知艺术家';
    basic.album = meta.common.album?.trim() || '未知专辑';
    basic.genre = meta.common.genre?.[0]?.trim() || '';
    basic.durationSeconds = Number.isFinite(meta.format.duration) ? meta.format.duration! : null;
    basic.codec = meta.format.codec || basic.codec;
    basic.sampleRate = meta.format.sampleRate ?? null;
    basic.bitsPerSample = meta.format.bitsPerSample ?? null;
    basic.trackNumber = meta.common.track.no ?? null;
    basic.discNumber = meta.common.disk.no ?? null;
    basic.replayGain=fileReplayGain(meta.common);
    const catalog:NonNullable<ParsedFile['catalog']>={
      fieldOrigins:{title:meta.common.title?.trim()?'file-tag':'filename',artist:meta.common.artist?.trim()||meta.common.albumartist?.trim()?'file-tag':'missing',album:meta.common.album?.trim()?'file-tag':'missing'},
      artists:meta.common.artists,albumArtists:meta.common.albumartists,albumArtist:meta.common.albumartist,
      composers:meta.common.composer,conductors:meta.common.conductor,
      isrcs:meta.common.isrc,genres:meta.common.genre,date:meta.common.releasedate??meta.common.date??(meta.common.year?String(meta.common.year):undefined),
      country:meta.common.releasecountry,label:meta.common.label?.join('、'),catalogNumber:meta.common.catalognumber?.join('、'),barcode:meta.common.barcode
    };
    // The worker validates before JSON serialization; absent tags must already be absent keys.
    basic.catalog=Object.fromEntries(Object.entries(catalog).filter(([,value])=>value!==undefined));
    if([basic.title,basic.artist,basic.album,basic.genre,basic.codec].some(v=>typeof v!=='string'||v.length>16384||v.includes('\u0000'))||Buffer.byteLength(JSON.stringify(basic),'utf8')>2*1024*1024)throw new Error('标签内容超过扫描预算');
    for(const values of [basic.catalog?.artists,basic.catalog?.albumArtists,basic.catalog?.composers,basic.catalog?.conductors,basic.catalog?.genres,basic.catalog?.isrcs])if(values&&(values.length>128||values.some(v=>typeof v!=='string'||v.length>16384)))throw new Error('标签集合超过扫描预算');
  } catch (error) {
    basic.parseError = String(error instanceof Error ? error.message : error).slice(0,500);
  }
  return basic;
}

