import {MaintenanceHold} from './maintenance-hold.js';
import {promises as fs,type Stats} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import {MEDIA_EXTENSIONS} from '../shared/media-formats.js';
import type {LibraryItem,PlaybackState} from '../shared/contracts.js';
import type {DesktopFileFolder,DesktopFileReview,DesktopFileInbox,DesktopFileLookup,DesktopFileMatches,DesktopFileImport,DesktopFilePlay} from '../shared/desktop-files.js';

type Root={id:string;path:string;status:string};
type Bound={path:string;real:string;stat:Stats;observation:string|null};
type PrivateRequest={view:DesktopFileReview;bindings:Map<string,Bound>;folders:Map<string,Bound>;busy:boolean};
type Imported={status:'saved'|'rejected';rootId:string|null;jobId:string|null;error:string};
type Ports={roots:()=>Promise<Root[]>;lookup:(input:DesktopFileLookup[])=>Promise<DesktopFileMatches>;item:(id:string)=>Promise<{item:LibraryItem;rootPath:string}>;
 receipt:(commandId:string)=>Promise<Imported|null>;importFolder:(folder:DesktopFileFolder,commandId:string,realPath:string)=>Promise<Imported>;play:(id:string,ids:string[],command:DesktopFilePlay['command'])=>Promise<PlaybackState>;
 token:()=>number;sleeping:()=>boolean;
 publish:(inbox:DesktopFileInbox)=>void;show:()=>void};
const key=(s:string)=>process.platform==='win32'?s.toLocaleLowerCase():s;
const inside=(root:string,file:string)=>{const r=path.relative(root,file);return r===''||!path.isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${path.sep}`);};
const error=(e:unknown)=>String(e instanceof Error?e.message:e).slice(0,500);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
function validPath(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=4096&&!/[\u0000-\u001f]/.test(value)&&path.isAbsolute(value)&&!/^\\\\[?.]\\/.test(value);}
async function bind(input:string):Promise<Bound>{
 const filename=path.resolve(input),stat=await fs.lstat(filename);if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw new Error('不支持链接或特殊文件');
 const before=stat.isFile()?fileObservation(await fs.lstat(filename,{bigint:true})):null;
 const real=await fs.realpath(filename),again=await fs.stat(real);
 if(stat.dev!==again.dev||stat.ino!==again.ino||stat.isDirectory()!==again.isDirectory())throw new Error('文件位置在读取期间发生变化');
 const observation=again.isFile()?fileObservation(await fs.lstat(filename,{bigint:true})):null;if(before!==observation)throw new Error('文件属性在读取期间发生变化');
 return {path:filename,real,stat:again,observation};
}
async function unchanged(b:Bound,full=false):Promise<boolean>{
 const n=await bind(b.path);return key(n.real)===key(b.real)&&n.stat.dev===b.stat.dev&&n.stat.ino===b.stat.ino&&n.stat.isDirectory()===b.stat.isDirectory()&&(!full||n.stat.size===b.stat.size&&n.stat.mtimeMs===b.stat.mtimeMs&&n.stat.ctimeMs===b.stat.ctimeMs&&n.observation===b.observation);
}
async function cueHash(b:Bound):Promise<string>{
 if(!b.stat.isFile()||b.stat.size>2*1024*1024)throw new Error('CUE 超过 2 MiB 限额');
 const handle=await fs.open(b.path,'r');try{
  if(fileObservation(await handle.stat({bigint:true}))!==b.observation)throw new Error('CUE 属性与待处理请求不一致');
  const buffer=Buffer.alloc(b.stat.size+1);let offset=0;
  while(offset<buffer.length){const read=await handle.read(buffer,offset,buffer.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
  const after=await handle.stat();if(offset!==b.stat.size||after.size!==b.stat.size||after.mtimeMs!==b.stat.mtimeMs||after.ctimeMs!==b.stat.ctimeMs||after.dev!==b.stat.dev||after.ino!==b.stat.ino||fileObservation(await handle.stat({bigint:true}))!==b.observation||!await unchanged(b,true))throw new Error('CUE 正在变化，请重新扫描');
  return createHash('sha256').update(buffer.subarray(0,offset)).digest('hex');
 }finally{await handle.close();}
}
export function desktopFileArguments(argv:string[],packaged:boolean):string[]{
 // Ignore switches, relative arguments and runtime/application bootstrap paths.
 return argv.slice(packaged?1:2).filter(v=>validPath(v)&&MEDIA_EXTENSIONS.includes(path.extname(v).slice(1).toLowerCase() as typeof MEDIA_EXTENSIONS[number]));
}
export class DesktopFiles{
 private readonly maintenance=new MaintenanceHold();
 private requests=new Map<string,PrivateRequest>();private revision=0;private message='';private ready=false;private closed=false;
 private pending:Array<{paths:string[];source:DesktopFileReview['source']}> = [];private lane:Promise<void>=Promise.resolve();private playEpoch=0;
 constructor(private readonly ports:Ports){}
 inbox():DesktopFileInbox{return {revision:this.revision,message:this.message,requests:[...this.requests.values()].map(({view:v})=>({id:v.id,revision:v.revision,source:v.source,status:v.status,message:v.message,count:v.entries.length}))};}
 private changed():void{if(this.closed)return;this.revision++;try{this.ports.publish(this.inbox());}catch{/* The inbox remains readable after window reload. */}}
 private get(requestId:unknown):PrivateRequest{if(!id(requestId))throw new Error('文件请求无效');const r=this.requests.get(requestId);if(!r)throw new Error('文件请求已关闭');return r;}
 private current(requestId:unknown,revision:unknown):PrivateRequest{const r=this.get(requestId);if(!Number.isSafeInteger(revision)||revision!==r.view.revision)throw new Error('文件请求已变化，请重新读取');if(r.busy||r.view.status==='loading')throw new Error('文件请求正在处理');return r;}
 review(requestId:unknown):DesktopFileReview{return structuredClone(this.get(requestId).view);}
 enqueue(paths:unknown,source:DesktopFileReview['source']):Promise<string|null>{return this.maintenance.run(()=>this.enqueueNow(paths,source));}
 private enqueueNow(paths:unknown,source:DesktopFileReview['source']):Promise<string|null>{
  if(this.closed)return Promise.resolve(null);
  if(!Array.isArray(paths)||!paths.length||paths.length>100||paths.some(v=>!validPath(v))||paths.reduce((sum,v)=>sum+Buffer.byteLength(v),0)>256*1024){this.message='每次最多接收 100 个本地文件或文件夹，路径总长度须小于 256 KiB';this.changed();throw new Error(this.message);}
  if(this.requests.size+this.pending.length>=8){this.message='待处理文件请求已满，请先关闭已有请求，再重新打开文件。';this.changed();throw new Error(this.message);}
  const input=[...new Map((paths as string[]).map(v=>[key(path.resolve(v)),path.resolve(v)])).values()];
  if(!this.ready){this.pending.push({paths:input,source});return Promise.resolve(null);}
  const view:DesktopFileReview={id:randomUUID(),revision:0,source,status:'loading',entries:input.map(p=>({id:randomUUID(),path:p,kind:'rejected',message:'正在检查…',itemIds:[]})),folders:[],items:[],scans:[],message:'正在检查本地文件…',truncated:false};
  const r:PrivateRequest={view,bindings:new Map(),folders:new Map(),busy:true};this.requests.set(view.id,r);this.message='';this.changed();try{this.ports.show();}catch{/* Startup/reload can recover the inbox. */}
  this.lane=this.lane.then(async()=>{if(this.closed)return;try{await this.resolve(r);}catch(e){r.view.message=error(e);}finally{r.busy=false;r.view.status='review';r.view.revision++;this.changed();}});
  return Promise.resolve(view.id);
 }
 start():void{if(this.ready||this.closed)return;this.ready=true;const pending=this.pending.splice(0);for(const r of pending){try{void this.enqueue(r.paths,r.source).catch(e=>{this.message=error(e);this.changed();});}catch(e){this.message=error(e);this.changed();}}}
 private async resolve(r:PrivateRequest):Promise<void>{
  const roots=await this.ports.roots();if(roots.length>256)throw new Error('音乐目录过多，请从曲库搜索或单独添加目录');
  const realRoots:Array<{root:Root;bound:Bound}>=[];
  for(const root of roots){try{const bound=await bind(root.path);if(bound.stat.isDirectory())realRoots.push({root,bound});}catch{/* Offline roots do not grant a new path. */}}
  realRoots.sort((a,b)=>b.bound.real.length-a.bound.real.length||a.root.id.localeCompare(b.root.id));
  const previousFolders=r.view.folders,lookup:DesktopFileLookup[]=[];r.bindings.clear();r.folders.clear();r.view.folders=[];r.view.items=[];r.view.truncated=false;
  for(const entry of r.view.entries){
   entry.itemIds=[];
   try{
    const b=await bind(entry.path),ext=path.extname(b.path).slice(1).toLowerCase();
    if(b.stat.isDirectory())entry.kind='folder';else if(ext==='cue')entry.kind='cue';else if(MEDIA_EXTENSIONS.includes(ext as typeof MEDIA_EXTENSIONS[number]))entry.kind='audio';else throw new Error('不支持此文件类型');
    r.bindings.set(entry.id,b);const existing=realRoots.find(root=>inside(root.bound.real,b.real));
    if(existing&&entry.kind!=='folder')lookup.push({entryId:entry.id,rootId:existing.root.id,relativePath:path.relative(existing.bound.real,b.real),kind:entry.kind});
    const folderBound=existing?.bound??(entry.kind==='folder'?b:await bind(path.dirname(b.real)));
    const folderPath=existing?.root.path??folderBound.real;
    let folder=r.view.folders.find(f=>key(f.path)===key(folderPath));
    if(!folder){if(r.view.folders.length>=32)throw new Error('每次最多扫描 32 个文件夹，请分批打开');folder={id:previousFolders.find(f=>key(f.path)===key(folderPath))?.id??randomUUID(),path:folderPath,existingRootId:existing?.root.id??null,entryIds:[]};r.view.folders.push(folder);r.folders.set(folder.id,folderBound);}
    folder.entryIds.push(entry.id);entry.message=entry.kind==='folder'?'仅在确认后扫描完整文件夹及子目录':'尚未匹配；可扫描所列完整目录后刷新';
   }catch(e){r.bindings.delete(entry.id);entry.kind='rejected';entry.message=error(e);}
  }
  const result=await this.ports.lookup(lookup.filter(input=>r.bindings.has(input.entryId)));if(this.closed)return;
  for(const found of result.entries){const entry=r.view.entries.find(v=>v.id===found.entryId);if(entry){entry.itemIds=found.itemIds;entry.message=found.itemIds.length?`曲库已匹配 ${found.itemIds.length} 首${entry.kind==='audio'?'（存在 CUE 时展示可见分轨）':''}`:entry.message;}}
  r.view.items=result.items;r.view.truncated=result.truncated;r.view.message='请选择播放已匹配曲目，或确认扫描范围。扫描不会自动播放。';
 }
 refresh(requestId:unknown,revision:unknown):Promise<DesktopFileReview>{return this.maintenance.run(()=>this.refreshNow(requestId,revision));}
 private async refreshNow(requestId:unknown,revision:unknown):Promise<DesktopFileReview>{
  const r=this.current(requestId,revision);if(r.view.status==='unknown')throw new Error('请先核对上次扫描提交');r.busy=true;r.view.revision++;this.changed();
  try{await this.resolve(r);}catch(e){r.view.message=error(e);}finally{r.busy=false;r.view.revision++;this.changed();}return this.review(r.view.id);
 }
 submit(input:DesktopFileImport):Promise<DesktopFileReview>{return this.maintenance.run(()=>this.submitNow(input));}
 private async submitNow(input:DesktopFileImport):Promise<DesktopFileReview>{
  if(!input||!Array.isArray(input.folderIds)||!input.folderIds.length||input.folderIds.length>32||new Set(input.folderIds).size!==input.folderIds.length)throw new Error('请选择扫描文件夹');
  const r=this.current(input.id,input.baseRevision),selected=[...input.folderIds].sort();
  if(r.view.status==='unknown'){
   if(JSON.stringify(r.view.scans.map(s=>s.folderId).sort())!==JSON.stringify(selected))throw new Error('核对时不可改变原扫描范围');
  }else{
   if(r.view.scans.length)throw new Error('此请求已提交，请刷新匹配或从任务中心继续处理');
   if(selected.some(v=>!r.view.folders.some(f=>f.id===v)))throw new Error('扫描目录不属于此请求');
   // Validate all selected folders before any mutation. A file replacement does not expand scope.
   for(const folderId of selected){const b=r.folders.get(folderId);if(!b||!await unchanged(b))throw new Error('扫描目录已变化，请刷新文件请求');}
   r.view.scans=selected.map(folderId=>({folderId,commandId:randomUUID(),rootId:null,jobId:null,message:''}));
  }
  r.busy=true;r.view.status='submitting';r.view.revision++;this.changed();
  try{
   for(const scan of r.view.scans){
    if(scan.jobId||scan.message)continue;
    const folder=r.view.folders.find(f=>f.id===scan.folderId)!;
    // Replaying an uncertain RPC uses its original durable scan command; never invent another ID.
    const receipt=await this.ports.receipt(scan.commandId);
    if(!receipt){const b=r.folders.get(folder.id);if(!b||!await unchanged(b)){scan.message='目录已变化，未提交扫描；请从曲库重新添加或扫描目录。';continue;}}
    if(this.closed)throw new Error('应用正在退出');
    const result=receipt??await this.ports.importFolder(folder,scan.commandId,r.folders.get(folder.id)!.real);
    scan.rootId=result.rootId;scan.jobId=result.jobId;scan.message=result.status==='saved'?'扫描已提交，进度请查看任务中心':result.error;
   }
   r.view.status='submitted';r.view.message='提交已确认。目录会保留在曲库中；扫描结束后请刷新匹配，再选择播放。';
  }catch(e){r.view.status='unknown';r.view.message=`提交结果尚未确认：${error(e)}。请核对原提交后再继续。`;}
  finally{r.busy=false;r.view.revision++;this.changed();}return this.review(r.view.id);
 }
 play(input:DesktopFilePlay):Promise<PlaybackState>{return this.maintenance.run(()=>this.playNow(input));}
 private async playNow(input:DesktopFilePlay):Promise<PlaybackState>{
  if(!input||typeof input.itemId!=='string')throw new Error('无效文件播放请求');const r=this.current(input.id,input.baseRevision);
  if(r.view.status==='unknown')throw new Error('请先核对扫描提交');
  const entry=r.view.entries.find(e=>e.itemIds.includes(input.itemId)),summary=r.view.items.find(i=>i.id===input.itemId);
  if(!entry||!summary?.available)throw new Error('曲目不属于此请求或当前不可用');
  r.busy=true;const token=this.ports.token(),epoch=++this.playEpoch;
  try{
   const binding=r.bindings.get(entry.id);if(!binding||!await unchanged(binding,true))throw new Error('源文件已变化，请刷新匹配');
   const {item,rootPath}=await this.ports.item(input.itemId);if(!item.available)throw new Error('曲目已变化，请刷新匹配');
   const audioFile=entry.kind==='audio'?binding:await bind(item.path),realRoot=await fs.realpath(rootPath);
   if(!inside(realRoot,audioFile.real)||item.fileStamp!==`${audioFile.stat.size}:${Math.trunc(audioFile.stat.mtimeMs)}`||item.fileObservation!==undefined&&item.fileObservation!==audioFile.observation)throw new Error('音乐文件与扫描记录不符，请重新扫描');
   // For CUE, the lookup binds document identity; separately ensure the current document still resolves to the selected path.
   if(entry.kind==='cue'){
    if(!item.cue||!inside(rootPath,item.path)||key(await fs.realpath(path.resolve(rootPath,item.cue.documentPath)))!==key(binding.real))throw new Error('CUE 文档与轨目不再匹配，请刷新');
   }else if(key(await fs.realpath(item.path))!==key(binding.real))throw new Error('曲目文件位置已变化，请刷新匹配');
   if(item.cue){const cue=entry.kind==='cue'?binding:await bind(path.resolve(rootPath,item.cue.documentPath));if(!inside(realRoot,cue.real)||!item.cue.sourceHash||await cueHash(cue)!==item.cue.sourceHash)throw new Error('CUE 编排已变化，请重新扫描后播放');}
   if(!await unchanged(audioFile,true))throw new Error('音乐文件正在变化，请重新扫描');
   if(this.closed||epoch!==this.playEpoch||token!==this.ports.token()||this.ports.sleeping())throw new Error('播放状态已变化，请重新选择播放');
   // Only the selected item is queued: other matched sources have not been revalidated for playback.
   return await this.ports.play(item.id,[item.id],input.command);
  }finally{r.busy=false;}
 }
 dismiss(requestId:unknown,revision:unknown):void{this.maintenance.assertAvailable();const r=this.current(requestId,revision);if(r.view.status==='unknown')throw new Error('请先核对上次扫描提交');this.requests.delete(r.view.id);this.changed();}
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  ++this.playEpoch;await this.maintenance.waitRequests();await this.lane;
  if(this.closed||!this.ready||[...this.requests.values()].some(r=>r.busy||r.view.status==='loading'))throw new Error('外部文件请求尚未确认停止');
 });}
 endMaintenance(owner:string):void{this.maintenance.end(owner);}
 close():void{this.closed=true;this.pending=[];this.requests.clear();}
}
