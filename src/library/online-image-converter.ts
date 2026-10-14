import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MediaParser,MediaWorkerExitUnconfirmed} from './media-worker-client.js';
import {mediaStat} from './media-worker-protocol.js';
import {fileObservation} from '../platform/file-observation.js';
import {imageMime,MAX_IMAGE_BYTES} from './artwork.js';
import type {ConvertedCoverImage} from '../shared/contracts.js';

// A source-neutral conversion request, independent of embedded/sidecar selections.
export async function convertOnlineImage(parser:MediaParser,bytes:Uint8Array,signal:AbortSignal,tempParent=os.tmpdir()):Promise<ConvertedCoverImage>{
 signal.throwIfAborted();
 if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||!imageMime(bytes))throw new Error('在线图片格式或大小无效');
 const parent=path.resolve(tempParent),root=await fs.mkdtemp(path.join(parent,'aural-online-image-')),filename=path.join(root,'image.bin');
 let observation:string|undefined,identity:{dev:bigint;ino:bigint}|undefined,uncertain=false;
 try{
  const handle=await fs.open(filename,'wx');try{const stat=await handle.stat({bigint:true});identity={dev:stat.dev,ino:stat.ino};await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  observation=fileObservation(await fs.lstat(filename,{bigint:true}));
  signal.throwIfAborted();const before=mediaStat(await fs.stat(filename));
  const image=await parser.image({rootPath:root,realRootPath:await fs.realpath(root),fullPath:filename,relativePath:'image.bin',before,thumbnailSize:1024},signal);
  signal.throwIfAborted();if(image.token!==createHash('sha256').update(bytes).digest('hex'))throw new Error('在线图片转换指纹不符');return image;
 }catch(error){uncertain=error instanceof MediaWorkerExitUnconfirmed;throw error;}
 finally{
  // An unconfirmed worker retains its staging file for diagnosis; never unlink
  // a file while the native supervisor's termination is still uncertain.
  if(!uncertain){
   const normalize=(v:string)=>process.platform==='win32'?v.toLowerCase():v;
   if(path.dirname(root)!==parent||!/^aural-online-image-[a-zA-Z0-9]{6}$/.test(path.basename(root))||normalize(await fs.realpath(root))!==normalize(root)||(await fs.lstat(root)).isSymbolicLink())throw new Error('在线图片暂存目录身份已变化，保留文件');
   const stat=await fs.lstat(filename,{bigint:true}).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
   if(stat){if(!identity||stat.dev!==identity.dev||stat.ino!==identity.ino||!stat.isFile()||stat.isSymbolicLink()||observation&&fileObservation(stat)!==observation)throw new Error('在线图片暂存身份已变化，保留文件');await fs.unlink(filename);}
   await fs.rmdir(root);
  }
 }
}
