import path from 'node:path';
const key=(filename:string)=>process.platform==='win32'?path.resolve(filename).toLowerCase():path.resolve(filename);
// A read remains registered until the entire owner operation (including close)
// has settled. This is application coordination, not an OS-exclusive write lock.
export class FileReadGate {
 private maintenanceOwner:string|null=null;
 private readonly blocked=new Map<string,string>();
 private readonly reads=new Map<Promise<unknown>,{path:string;abort?:()=>void}>();
 run<T>(filename:string,action:()=>Promise<T>,abort?:()=>void):Promise<T> {
  if(this.maintenanceOwner)return Promise.reject(new Error('曲库正在维护，暂不开始新的文件读取'));
  const filenameKey=key(filename);if(this.blocked.has(filenameKey))return Promise.reject(new Error('文件正准备写入或等待恢复，暂不开始新的读取'));
  const result=Promise.resolve().then(action).finally(()=>{this.reads.delete(result);});this.reads.set(result,{path:filenameKey,abort});return result;
 }
 runOwned<T>(filename:string,owner:string,action:()=>Promise<T>,abort?:()=>void):Promise<T>{
  if(this.maintenanceOwner)return Promise.reject(new Error('曲库维护期间不能开始新的恢复读取'));
  const filenameKey=key(filename);if(!owner||this.blocked.get(filenameKey)!==owner)return Promise.reject(new Error('重新解析没有当前文件读取协调占用'));
  if([...this.reads.values()].some(r=>r.path===filenameKey))return Promise.reject(new Error('此文件仍有读取未退出'));
  const result=Promise.resolve().then(()=>{if(this.blocked.get(filenameKey)!==owner)throw new Error('重新解析期间文件协调身份变化');return action();}).finally(()=>{this.reads.delete(result);});this.reads.set(result,{path:filenameKey,abort});return result;
 }
 async quiesce(filename:string,owner:string):Promise<void> {
  const filenameKey=key(filename),previous=this.blocked.get(filenameKey);if(previous&&previous!==owner)throw new Error('文件读取协调已由其他操作持有');this.blocked.set(filenameKey,owner);
  const pending=[...this.reads.entries()].filter(([,r])=>r.path===filenameKey);for(const [,r] of pending)r.abort?.();await Promise.allSettled(pending.map(([promise])=>promise));
 }
 async quiesceAll(owner:string):Promise<void>{
  if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('曲库读取维护身份不符');this.maintenanceOwner=owner;
  const pending=[...this.reads.entries()];for(const [,read] of pending)try{read.abort?.();}catch{/* The read still has to settle. */}
  await Promise.allSettled(pending.map(([promise])=>promise));if(this.reads.size)throw new Error('仍有文件读取没有完成，不能建立曲库快照');
 }
 releaseAll(owner:string):void{if(this.maintenanceOwner!==owner||this.reads.size)throw new Error('读取维护尚未完成或身份不符');this.maintenanceOwner=null;}
 release(filename:string,owner:string):void {const filenameKey=key(filename);if(this.blocked.get(filenameKey)!==owner)throw new Error('文件读取协调身份不符');this.blocked.delete(filenameKey);}
 releaseRecovered(filename:string,owner:string):void {const filenameKey=key(filename),current=this.blocked.get(filenameKey);if(current===undefined)return;if(current!==owner)throw new Error('文件读取协调已属于新的操作，不能解除');if([...this.reads.values()].some(r=>r.path===filenameKey))throw new Error('此文件仍有未完成读取，不能解除协调占用');this.blocked.delete(filenameKey);}
}
