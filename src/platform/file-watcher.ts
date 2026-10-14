import {watch,promises as fs,type FSWatcher} from 'node:fs';
import path from 'node:path';
import type {WatchAnchor} from '../shared/library-watch.js';

export interface FileWatcher {open(directory:string,changed:(filename:string|null)=>void,failed:(error:Error)=>void):{close:()=>void}}
// A notification is a hint, never an authorized path or proof of a deletion.
export class NodeFileWatcher implements FileWatcher{
 open(directory:string,changed:(filename:string|null)=>void,failed:(error:Error)=>void):{close:()=>void}{
  const watcher:FSWatcher=watch(directory,{recursive:true,persistent:false,encoding:'utf8'},(_event,filename)=>changed(typeof filename==='string'?filename:null));
  let closed=false;watcher.on('error',error=>{if(!closed)failed(error);});watcher.on('close',()=>{if(!closed){closed=true;failed(new Error('目录监听已停止'));}});
  return {close:()=>{if(closed)return;closed=true;watcher.close();}};
 }
}
export const normalizedWatchPath=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
export function inWatchPath(root:string,value:string):boolean{const rel=path.relative(normalizedWatchPath(root),normalizedWatchPath(value));return rel===''||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${path.sep}`);}
export async function probeWatchRoot(directory:string):Promise<WatchAnchor>{
 const before=await fs.lstat(directory,{bigint:true});if(!before.isDirectory()||before.isSymbolicLink())throw new Error('音乐根目录不是可监听的普通目录');
 const realPath=normalizedWatchPath(await fs.realpath(directory)),after=await fs.lstat(directory,{bigint:true});
 if(!after.isDirectory()||after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino)throw new Error('音乐根目录读取期间已变化');
 return {realPath,dev:after.dev.toString(),ino:after.ino.toString()};
}
export function sameWatchAnchor(a:WatchAnchor,b:WatchAnchor):boolean{return a.realPath===b.realPath&&a.dev===b.dev&&a.ino===b.ino;}
