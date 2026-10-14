import type {ChildProcess} from 'node:child_process';
import {backupUuid} from '../shared/catalog-backup.js';

// A timeout or a settled RPC is never evidence that a native owner has exited.
// Call with a still-owned child; its owner must clear the reference on close.
export function waitForOwnedChildClose(child:ChildProcess|null,stop:()=>void):Promise<void>{
 if(!child){stop();return Promise.resolve();}
 return new Promise<void>((resolve,reject)=>{
  const closed=()=>resolve();child.once('close',closed);
  try{stop();}catch(error){child.off('close',closed);reject(error);}
 });
}

// Reversible pause for one trusted Main operation. Failed drains retain ownership.
export class MaintenanceHold {
 private owner:string|null=null;private work:Promise<void>|null=null;private frozen=false;
 private readonly requests=new Set<Promise<unknown>>();
 get held():boolean{return this.owner!==null;}
 assertAvailable():void{if(this.held)throw new Error('正在备份或恢复曲库，请等待维护结束');}
 run<T>(action:()=>Promise<T>|T):Promise<T>{
  try{this.assertAvailable();}catch(error){return Promise.reject(error);}
  const work=Promise.resolve().then(()=>{this.assertAvailable();return action();}).finally(()=>this.requests.delete(work));
  this.requests.add(work);return work;
 }
 async waitRequests():Promise<void>{
  await Promise.allSettled([...this.requests]);
  if(this.requests.size)throw new Error('主窗口仍有原操作没有结束');
 }
 begin(owner:string,drain:()=>Promise<void>):Promise<void>{
  owner=backupUuid(owner);
  if(this.owner!==null){if(this.owner!==owner)return Promise.reject(new Error('已有其他主窗口维护占用'));return this.work!;}
  this.owner=owner;this.frozen=false;
  const work=Promise.resolve().then(async()=>{await drain();await this.waitRequests();this.frozen=true;});
  this.work=work;void work.catch(()=>{});return work;
 }
 assertFrozen(owner:string):void{
  if(backupUuid(owner)!==this.owner||!this.frozen)throw new Error('维护身份不符或资源停止尚未确认');
 }
 end(owner:string):void{
  this.assertFrozen(owner);
  this.owner=null;this.work=null;this.frozen=false;
 }
}
