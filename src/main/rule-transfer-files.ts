import {promises as fs,constants as fsConstants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import {RULE_BUNDLE_MAX_BYTES,readRuleBundle,type RuleBundle} from '../shared/rule-transfer.js';

// Paths come only from native file dialogs. Renderer input is structured rules.
export async function readPickedRules(filename:string):Promise<{name:string;bundle:RuleBundle}>{
 if(path.extname(filename).toLowerCase()!=='.json')throw new Error('请选择 JSON 规则文件');
 const before=await fs.lstat(filename,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.size<1n||before.size>BigInt(RULE_BUNDLE_MAX_BYTES))throw new Error('规则文件须为1MiB以内的非空普通文件');
 const observation=fileObservation(before),file=await fs.open(filename,'r');
 try{
  if(fileObservation(await file.stat({bigint:true}))!==observation)throw new Error('规则文件已变化');
  const bytes=Buffer.alloc(Number(before.size)+1);let size=0;
  while(size<bytes.length){const read=await file.read(bytes,size,bytes.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
  if(size!==Number(before.size)||fileObservation(await file.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(filename,{bigint:true}))!==observation)throw new Error('规则文件在读取期间变化');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size));
  return {name:path.basename(filename).slice(0,128),bundle:readRuleBundle(JSON.parse(text))};
 }finally{await file.close();}
}

export async function writePickedRules(filename:string,input:RuleBundle):Promise<{name:string;entries:number}>{
 if(path.extname(filename).toLowerCase()!=='.json')throw new Error('规则备份文件须使用 .json 扩展名');
 const bundle=readRuleBundle(input),bytes=Buffer.from(JSON.stringify(bundle,null,2)+'\n','utf8');
 if(bytes.length>RULE_BUNDLE_MAX_BYTES)throw new Error('格式化规则文件超过1MiB，请减少本次导出条目');
 const directory=await fs.realpath(path.dirname(filename)),target=path.join(directory,path.basename(filename));
 const existing=await fs.lstat(target,{bigint:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
 if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new Error('不能覆盖链接或非普通文件');
 const temporary=path.join(directory,`.aural-rules-${randomUUID()}.tmp`);let owned=false;
 try{
  const file=await fs.open(temporary,'wx',0o600);owned=true;
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
  const current=await fs.lstat(target,{bigint:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;});
  if(existing?current===null||fileObservation(current)!==fileObservation(existing):current!==null)throw new Error('保存位置已变化，请重新选择文件');
  if(existing){await fs.rename(temporary,target);owned=false;}
  else{
   // For a new file, link gives an atomic no-replace publication. A competing
   // creator cannot be silently overwritten between the check and publication.
   try{await fs.link(temporary,target);}catch(error){
    const code=(error as NodeJS.ErrnoException).code;
    if(!['ENOTSUP','EOPNOTSUPP','EPERM','EXDEV','ENOSYS'].includes(code??''))throw error;
    // FAT/removable and some NAS filesystems do not support hard links. The
    // exclusive copy still refuses to overwrite a competing file, but it is
    // not atomic publication: an interrupted copy must pass strict JSON/bounds
    // validation before it can be imported. Never claim directory durability.
    await fs.copyFile(temporary,target,fsConstants.COPYFILE_EXCL);
    const published=await fs.open(target,'r+');try{await published.sync();}finally{await published.close();}
   }
   await fs.unlink(temporary);owned=false;
  }
  return {name:path.basename(target).slice(0,128),entries:bundle.entries.length};
 }finally{if(owned)await fs.unlink(temporary).catch(()=>{});}
}
