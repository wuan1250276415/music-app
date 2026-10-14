import {promises as fs} from 'node:fs';
import {parseMedia} from './media-scan.js';
import {readCueSource} from './cue-read.js';
import {readWorkerArtwork,readWorkerImage} from './artwork-worker.js';
import {prepareWorkerFlacTags} from './flac-tag-worker.js';
import {TAG_PREVIEW_RESPONSE_LIMIT} from '../shared/tag-write.js';
import {readWorkerLyrics} from './lyrics-worker.js';
import {MEDIA_PROTOCOL_VERSION,MEDIA_REQUEST_LIMIT,MEDIA_RESPONSE_LIMIT,CUE_RESPONSE_LIMIT,ARTWORK_RESPONSE_LIMIT,LYRICS_RESPONSE_LIMIT,MediaBoundaryError,mediaFrame,mediaStat,sameMediaStat,insideMediaRoot,validateMediaRequest,validateMediaResponse,type MediaRequest} from './media-worker-protocol.js';

// No database, Electron API, provider, user credential or dynamic entrypoint is imported.
let pending=Buffer.alloc(0),started=false,request:MediaRequest|undefined;
const normalized=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
async function run(input:unknown):Promise<void>{
 try{
  request=validateMediaRequest(input);
  const root=normalized(await fs.realpath(request.rootPath));
  if(root!==normalized(request.realRootPath)||!insideMediaRoot(root,normalized(await fs.realpath(request.fullPath))))throw new MediaBoundaryError('媒体目标已越过授权目录');
  const link=await fs.lstat(request.fullPath);if(!link.isFile()||link.isSymbolicLink())throw new MediaBoundaryError('媒体目标类型已变化');
  const handle=await fs.open(request.fullPath,'r');let response:unknown;
  try{
   const before=await handle.stat();if(!before.isFile()||!sameMediaStat(request.before,mediaStat(before)))throw new Error('媒体文件已变化');
   const file=request.kind==='tags'?await parseMedia(request.fullPath,request.relativePath,before,handle,new AbortController().signal):null;
   if(file?.parseError)throw new Error(file.parseError);
   const source=request.kind==='cue'?await readCueSource(handle,before.size,request.cueEncoding,request.cueGapPolicy):null;
   const candidate=request.kind==='artwork'?await readWorkerArtwork(request,handle):null;
   const image=request.kind==='image'?await readWorkerImage(request,handle):null;
   const tagPreview=request.kind==='flac-tag-preview'?await prepareWorkerFlacTags(handle,before.size,request.tagChanges!):null;
   const lyrics=request.kind==='lyrics'?await readWorkerLyrics(request,handle):null;
   const after=await handle.stat();
   if(!insideMediaRoot(root,normalized(await fs.realpath(request.fullPath))))throw new MediaBoundaryError('媒体目标读取期间越过授权目录');
   if(!sameMediaStat(mediaStat(before),mediaStat(after))||!sameMediaStat(mediaStat(after),mediaStat(await fs.stat(request.fullPath))))throw new Error('媒体文件读取期间变化');
   response=validateMediaResponse(image?{version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'image',image,after:mediaStat(after)}:tagPreview?{version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'flac-tag-preview',preview:tagPreview,after:mediaStat(after)}:lyrics?{version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'lyrics',...lyrics,after:mediaStat(after)}:request.kind==='artwork'?{version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'artwork',candidate,after:mediaStat(after)}:file?{version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'result',file,after:mediaStat(after)}:{version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'cue',source,after:mediaStat(after)},request);
  }finally{await handle.close();}
  process.stdout.write(mediaFrame(response,request.kind==='flac-tag-preview'?TAG_PREVIEW_RESPONSE_LIMIT:request.kind==='cue'?CUE_RESPONSE_LIMIT:request.kind==='artwork'||request.kind==='image'?ARTWORK_RESPONSE_LIMIT:request.kind==='lyrics'?LYRICS_RESPONSE_LIMIT:MEDIA_RESPONSE_LIMIT),()=>process.exit(0));
 }catch(error){
  if(!request){process.exit(65);return;}
  process.stdout.write(mediaFrame({version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'error',category:error instanceof MediaBoundaryError?'boundary':'parse',message:String(error instanceof Error?error.message:error).replace(/\0/g,'').slice(0,500)||'媒体解析失败'},MEDIA_RESPONSE_LIMIT),()=>process.exit(0));
 }
}
process.stdin.on('data',(chunk:Buffer)=>{
 if(started){process.exit(65);return;}
 if(pending.length+chunk.length>MEDIA_REQUEST_LIMIT+4){process.exit(65);return;}
 pending=Buffer.concat([pending,chunk]);if(pending.length<4)return;
 const size=pending.readUInt32LE();if(!size||size>MEDIA_REQUEST_LIMIT||pending.length>size+4){process.exit(65);return;}
 if(pending.length===size+4){started=true;try{const input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pending.subarray(4)));pending=Buffer.alloc(0);void run(input);}catch{process.exit(65);}}
});
process.stdin.on('error',()=>process.exit(65));
process.stdout.on('error',()=>process.exit(65));
process.stdin.on('end',()=>{if(!started)process.exit(65);});
