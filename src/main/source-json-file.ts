import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';

// Main-only options; neither a path nor a parser/limit is accepted from Renderer.
export async function readPickedSourceJson<T>(filename:string,options:{label:string;maxBytes:number;read:(value:unknown)=>T},check:()=>void):Promise<{name:string;archiveSha256:string;bundle:T}> {
 const {label,maxBytes,read}=options;
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024)throw new Error('来源备份读取预算无效');
 const deadline=Date.now()+20000,guard=()=>{check();if(Date.now()>deadline)throw new Error(`${label}读取超过20秒预算`);};
 if(!path.isAbsolute(filename)||path.extname(filename).toLowerCase()!=='.json')throw new Error(`请选择 JSON 格式的${label}`);guard();
 const before=await fs.lstat(filename,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>BigInt(maxBytes))throw new Error(`${label}须为${maxBytes/1024/1024}MiB以内的普通独立文件`);
 const observation=fileObservation(before),file=await fs.open(filename,'r');
 try{
  guard();if(fileObservation(await file.stat({bigint:true}))!==observation)throw new Error(`${label}已变化`);const bytes=Buffer.alloc(Number(before.size)+1);let size=0;
  while(size<bytes.length){guard();const result=await file.read(bytes,size,bytes.length-size,size);if(!result.bytesRead)break;size+=result.bytesRead;}
  if(size!==Number(before.size)||fileObservation(await file.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(filename,{bigint:true}))!==observation)throw new Error(`${label}在读取期间变化`);guard();
  const source=bytes.subarray(0,size),text=new TextDecoder('utf-8',{fatal:true}).decode(source),bundle=read(JSON.parse(text));
  if(!source.equals(Buffer.from(JSON.stringify(bundle,null,2)+'\n','utf8')))throw new Error('来源备份格式已改动，请使用 Aural 原始导出的来源备份');
  guard();return {name:path.basename(filename).slice(0,128),archiveSha256:createHash('sha256').update(source).digest('hex'),bundle};
 }finally{await file.close();}
}
