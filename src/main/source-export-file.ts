import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
export interface SourceExportBytes {rawBase64:string;sha256:string;bytes:number}
export interface SourceExportOptions {extension:string;maxBytes:number;label:string;forbiddenRoot:string}
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
// Only Main chooses options and the native-picked filename. A new exclusive
// handle prevents overwrite; this is not a crash-atomic file publication.
export async function exportPickedSourceBytes(filename:string,data:SourceExportBytes,options:SourceExportOptions,check:()=>void):Promise<{name:string;sha256:string;bytes:number}> {
 const {extension,maxBytes,label,forbiddenRoot}=options;
 if(!/^(cue|json|flaccue|vorbis-cue)$/.test(extension)||!Number.isSafeInteger(maxBytes)||maxBytes<0||maxBytes>8*1024*1024||!path.isAbsolute(filename)||path.extname(filename).toLowerCase()!=='.'+extension||typeof data.rawBase64!=='string'||data.rawBase64.length>Math.ceil(maxBytes/3)*4||!Number.isSafeInteger(data.bytes)||data.bytes<0||data.bytes>maxBytes||!/^[0-9a-f]{64}$/.test(data.sha256))throw new Error(`${label}导出位置或内容无效`);
 const bytes=Buffer.from(data.rawBase64,'base64');if(bytes.toString('base64')!==data.rawBase64||bytes.length!==data.bytes||hash(bytes)!==data.sha256)throw new Error(`${label}导出字节校验失败`);
 const directory=await fs.realpath(path.dirname(filename)),target=path.join(directory,path.basename(filename)),protectedRoot=await fs.realpath(forbiddenRoot),relative=path.relative(protectedRoot,target);
 if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('请选择应用数据目录之外的保存位置');
 const parent=await fs.lstat(directory,{bigint:true});if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error(`${label}保存目录不可用`);check();
 const file=await fs.open(target,'wx+',0o600);
 try{
  const owned=await file.stat({bigint:true});check();await file.writeFile(bytes);await file.sync();const after=await file.stat({bigint:true}),located=await fs.lstat(target,{bigint:true});
  if(!after.isFile()||after.nlink!==1n||after.dev!==owned.dev||after.ino!==owned.ino||after.birthtimeNs!==owned.birthtimeNs||after.size!==BigInt(bytes.length)||located.isSymbolicLink()||fileObservation(located)!==fileObservation(after))throw new Error(`${label}导出位置在保存期间变化`);
  const verification=Buffer.alloc(bytes.length+1);let read=0;while(read<verification.length){check();const result=await file.read(verification,read,verification.length-read,read);if(!result.bytesRead)break;read+=result.bytesRead;}
  const parentAfter=await fs.lstat(directory,{bigint:true});
  if(read!==bytes.length||hash(verification.subarray(0,read))!==data.sha256||fileObservation(await file.stat({bigint:true}))!==fileObservation(after)||fileObservation(await fs.lstat(target,{bigint:true}))!==fileObservation(after)||!parentAfter.isDirectory()||parentAfter.isSymbolicLink()||parentAfter.dev!==parent.dev||parentAfter.ino!==parent.ino||parentAfter.birthtimeNs!==parent.birthtimeNs||await fs.realpath(directory)!==directory)throw new Error(`${label}导出回读或目录校验失败`);check();
 }catch(error){throw new Error(`${error instanceof Error?error.message:String(error)}；新建的导出文件已保留，请核对后使用新的文件名重试。`);}
 finally{await file.close();}
 return {name:path.basename(target),sha256:data.sha256,bytes:data.bytes};
}
