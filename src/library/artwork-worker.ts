import {promises as fs} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseFromTokenizer,type IPicture} from 'music-metadata';
import {ScanTokenizer} from './media-scan.js';
import {MAX_IMAGE_BYTES,artworkSidecars,imageMime,isFront} from './artwork.js';
import {flacArtworkPictures,readFlacArtworkPicture} from './flac-artwork.js';
import {readId3Artwork} from './id3-artwork.js';
import {fileObservation} from '../platform/file-observation.js';
import {insideMediaRoot,mediaStat,sameMediaStat,MediaBoundaryError,type MediaRequest} from './media-worker-protocol.js';
import type {ArtworkCandidate} from '../shared/contracts.js';

const normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
// Only a rejected image may advance to a lower-priority cover. A broken
// converter must stay an explicit, retryable failure instead of a cached choice.
class UnsupportedArtworkImage extends Error{}
export async function convertArtworkImage(bytes:Uint8Array,size:256|1024):Promise<{url:string;width:number;height:number}>{
 const executable=process.argv[2];if(!executable||!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!=='media-worker.exe')throw new Error('图片转换组件路径无效');
 return new Promise((resolve,reject)=>{
  const child=spawn(executable,['--artwork-convert'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const chunks:Buffer[]=[];let total=0,failed:Error|null=null,diagnostics=0;
  const fail=(error:Error)=>{failed??=error;child.stdin?.destroy();child.kill();};
  child.on('error',()=>fail(new Error('图片转换组件不可用')));
  child.stdin?.on('error',()=>{failed??=new Error('图片转换输入中断');});
  child.stdout?.on('error',()=>fail(new Error('图片转换输出中断')));
  child.stdout?.on('data',(chunk:Buffer)=>{total+=chunk.length;if(total>2*1024*1024+12){fail(new Error('缩略图超过预算'));return;}chunks.push(chunk);});
  child.stderr?.on('error',()=>fail(new Error('图片转换诊断中断')));
  child.stderr?.on('data',(chunk:Buffer)=>{diagnostics+=chunk.length;if(diagnostics>16384)fail(new Error('图片转换诊断超过预算'));});
  child.once('close',(code,signal)=>{
   if(failed){reject(failed);return;}
   if(code===82&&!signal){reject(new UnsupportedArtworkImage('图片无法安全解码或超过尺寸预算'));return;}
   if(code!==0||signal){reject(new Error('封面转换组件未完成读取，请重新读取封面'));return;}
   const result=Buffer.concat(chunks,total);
   if(result.length<15||result.readUInt32LE()+12!==result.length){reject(new Error('图片转换回执无效'));return;}
   const width=result.readUInt32LE(4),height=result.readUInt32LE(8),jpeg=result.subarray(12);
   if(!width||!height||width>size||height>size||imageMime(jpeg)!=='image/jpeg'){reject(new Error('缩略图格式无效'));return;}
   resolve({url:`data:image/jpeg;base64,${jpeg.toString('base64')}`,width,height});
  });
  const header=Buffer.alloc(8);header.writeUInt32LE(bytes.length);header.writeUInt32LE(size,4);
  child.stdin?.write(header);child.stdin?.end(Buffer.from(bytes));
 });
}

// Called only in the disposable adapter supervised by the Windows Job.
export async function readWorkerImage(request:MediaRequest,handle:FileHandle):Promise<import('../shared/contracts.js').ConvertedCoverImage>{
 if(request.kind!=='image'||!request.thumbnailSize||request.before.size<1||request.before.size>MAX_IMAGE_BYTES)throw new Error('图片文件超过预算或请求无效');
 const bytes=Buffer.alloc(request.before.size);let offset=0;
 while(offset<bytes.length){const read=await handle.read(bytes,offset,bytes.length-offset,offset);if(!read.bytesRead)throw new Error('图片文件无法完整读取');offset+=read.bytesRead;}
 if(!imageMime(bytes))throw new Error('图片文件格式无效');
 return {...await convertArtworkImage(bytes,request.thumbnailSize),token:createHash('sha256').update(bytes).digest('hex')};
}

export async function readWorkerArtwork(request:MediaRequest,handle:FileHandle):Promise<ArtworkCandidate|null>{
 if(request.kind!=='artwork'||!request.thumbnailSize)throw new Error('无效图片任务');
 const rejected=new Set(request.rejectedTokens??[]),signal=new AbortController().signal;
 let pictures:IPicture[]=[],metadataError:unknown,id3Error:unknown;
 let attempts=0;
 const attempted=new Set<string>();
 const candidate=async(bytes:Uint8Array,sourceKind:ArtworkCandidate['sourceKind'],label:string):Promise<ArtworkCandidate|null>=>{
  if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||!imageMime(bytes))return null;
  const token=createHash('sha256').update(bytes).digest('hex');if(rejected.has(token)||attempted.has(token)||attempts>=16)return null;attempted.add(token);attempts++;
  try{return {...await convertArtworkImage(bytes,request.thumbnailSize!),token,sourceKind,label};}
  catch(error){if(error instanceof UnsupportedArtworkImage)return null;throw error;}
 };
 if(request.artworkSource==='embedded'){
  // Native FLAC pictures do not depend on a successful text-tag parser. Keep
  // only descriptors in memory and convert one image at a time, front first.
  const flacPictures=await flacArtworkPictures(handle,request.before.size,signal);
  if(flacPictures)for(const picture of flacPictures.filter(value=>value.front)){
   if(attempts>=16)break;
   const result=await candidate(await readFlacArtworkPicture(handle,picture,signal),'embedded',picture.front?'歌曲内嵌正面封面':'歌曲内嵌图片');if(result)return result;
  }
  // APIC extraction must not depend on unrelated text tags, container duration
  // parsing, or reading audio data before the DSF/WAV metadata location.
  let id3Pictures:IPicture[]=[],completeRf64=false;
  try{const result=await readId3Artwork(handle,request.before.size,signal);id3Pictures=result.pictures;completeRf64=result.container==='rf64'&&result.complete;if(result.container==='rf64'&&!result.complete)id3Error=new Error('RF64 内嵌图片标签未能完整解析');}catch(error){id3Error=error;}
  for(const picture of id3Pictures.filter(isFront)){
   const result=await candidate(picture.data,'embedded','歌曲内嵌正面封面');if(result)return result;
  }
  // Retain the general parser for other containers, prefixed FLAC and legacy
  // comment pictures, without touching sidecar files before this phase ends.
  // The general RIFF parser maps cover data from ID3. A complete, bounded
  // RF64 ID3 traversal works independently of its unsupported ds64 seeking.
  if(!completeRf64)try{
   const tokenizer=new ScanTokenizer(handle,request.fullPath,request.before.size,signal);
   const metadata=await parseFromTokenizer(tokenizer,{skipCovers:false,duration:false,observer:event=>{if(event.tag.type==='common'&&event.tag.id==='picture')pictures=event.metadata.common.picture??pictures;}});
   tokenizer.finish();pictures=metadata.common.picture??pictures;
  }catch(error){metadataError=error;}
  const eligible=pictures.slice(0,64).filter(picture=>picture.data instanceof Uint8Array);
  for(const picture of eligible.filter(isFront)){
   const result=await candidate(picture.data,'embedded',isFront(picture)?'歌曲内嵌正面封面':'歌曲内嵌图片');if(result)return result;
  }
  if(flacPictures)for(const picture of flacPictures.filter(value=>!value.front)){
   if(attempts>=16)break;
   const result=await candidate(await readFlacArtworkPicture(handle,picture,signal),'embedded','歌曲内嵌图片');if(result)return result;
  }
  for(const picture of id3Pictures.filter(value=>!isFront(value))){
   const result=await candidate(picture.data,'embedded','歌曲内嵌图片');if(result)return result;
  }
  for(const picture of eligible.filter(value=>!isFront(value))){
   const result=await candidate(picture.data,'embedded','歌曲内嵌图片');if(result)return result;
  }
  const incomplete=metadataError!==undefined?metadataError:id3Error;
  if(incomplete!==undefined)throw new Error(`歌曲内嵌封面读取未完成，请重新读取：${String(incomplete instanceof Error?incomplete.message:incomplete).slice(0,300)}`);
  // A successful null is the only result that lets the service start sidecars.
  // This adapter never enumerates or stats directory images in this phase.
  return null;
 }
 if(request.artworkSource!=='sidecar')throw new Error('无效封面来源任务');
 let names:string[]=[];try{names=await fs.readdir(path.dirname(request.fullPath));}catch{/* Exact conventional paths can still be readable without enumeration. */}
 const visited=new Set<string>();
 for(const conventional of artworkSidecars(request.fullPath)){
  if(attempts>=16)break;
  const name=names.find(value=>value===conventional)??names.find(value=>value.toLowerCase()===conventional.toLowerCase())??conventional;if(visited.has(name))continue;visited.add(name);
  const full=path.join(path.dirname(request.fullPath),name);let bytes:Buffer;
  try{
   const link=await fs.lstat(full);if(!link.isFile()||link.isSymbolicLink()||!link.size||link.size>MAX_IMAGE_BYTES)continue;
   if(!insideMediaRoot(normalize(request.realRootPath),normalize(await fs.realpath(full))))throw new MediaBoundaryError('本地封面越过授权目录');
   const image=await fs.open(full,'r');
   try{
    const observation=fileObservation(await image.stat({bigint:true}));
    const before=await image.stat();if(!sameMediaStat(mediaStat(link),mediaStat(before))||fileObservation(await image.stat({bigint:true}))!==observation)throw new Error('封面已变化');
    bytes=Buffer.alloc(before.size+1);let offset=0;while(offset<bytes.length){const read=await image.read(bytes,offset,bytes.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
    if(offset!==before.size)throw new Error('封面读取期间变化');bytes=bytes.subarray(0,offset);
    const after=await image.stat();if(!sameMediaStat(mediaStat(before),mediaStat(after))||!sameMediaStat(mediaStat(after),mediaStat(await fs.stat(full)))||fileObservation(await image.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(full,{bigint:true}))!==observation)throw new Error('封面已变化');
    if(!insideMediaRoot(normalize(request.realRootPath),normalize(await fs.realpath(full))))throw new MediaBoundaryError('封面读取期间越过授权目录');
   }finally{await image.close();}
  }catch(error){if(error instanceof MediaBoundaryError)throw error;continue;}
  const result=await candidate(bytes,'sidecar',`本地封面 · ${name}`);if(result)return result;
 }
 return null;
}
