import type {FileHandle} from 'node:fs/promises';
import {FLAC_METADATA_LIMIT,type FlacTagPreview,type TagFieldChange} from '../shared/tag-write.js';
import {rewriteFlacMetadata} from './flac-tag-adapter.js';
export async function readFlacMetadataPrefix(handle:FileHandle,fileBytes:number):Promise<Buffer>{
 if(!Number.isSafeInteger(fileBytes)||fileBytes<43||fileBytes>68719476736)throw new Error('FLAC 文件大小无效');
 const exact=async(length:number,position:number)=>{const b=Buffer.alloc(length);let at=0;while(at<length){const {bytesRead}=await handle.read(b,at,length-at,position+at);if(!bytesRead)throw new Error('FLAC 元数据读取不完整');at+=bytesRead;}return b;};
 const marker=await exact(4,0);if(marker.toString('ascii')!=='fLaC')throw new Error('仅支持标准独立 FLAC 标签');const pieces=[marker];let at=4,blocks=0,ended=false;
 while(!ended){
  if(++blocks>1024||at+4>Math.min(fileBytes,FLAC_METADATA_LIMIT))throw new Error('FLAC 元数据块预算无效');
  const header=await exact(4,at),length=header.readUIntBE(1,3);at+=4;
  if(at+length>=fileBytes||at+length>FLAC_METADATA_LIMIT)throw new Error('FLAC 元数据范围无效');pieces.push(header,await exact(length,at));at+=length;ended=Boolean(header[0]&128);
 }
 return Buffer.concat(pieces,at);
}
export async function prepareWorkerFlacTags(handle:FileHandle,fileBytes:number,changes:TagFieldChange[]):Promise<FlacTagPreview>{
 const prefix=await readFlacMetadataPrefix(handle,fileBytes);return rewriteFlacMetadata(prefix,String(fileBytes-prefix.length),changes).preview;
}
