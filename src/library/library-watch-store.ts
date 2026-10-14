import type {DatabaseSync} from 'node:sqlite';
import {readLibraryWatchRequest,WATCH_PERIODS,type LibraryWatchRequest,type WatchAnchor} from '../shared/library-watch.js';

export interface WatchRecord {version:1;rootId:string;path:string;revision:number;enabled:boolean;periodicMinutes:number;anchor:WatchAnchor|null;requested:number;completed:number;launch:{commandId:string;epoch:number;jobId:string|null;anchor:WatchAnchor}|null;lastSuccessAt:number|null;failedPasses:number;paused:string;lastCommand:LibraryWatchRequest|null}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export class LibraryWatchStore{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 private key(id:string):string{if(typeof id!=='string'||!id||id.length>128||id.includes('\0'))throw new Error('无效监听目录');return `library_watch:${id}`;}
 load(root:{id:string;path:string}):WatchRecord{
  const row=this.db.prepare('SELECT value FROM app_setting WHERE key=?').get(this.key(root.id)) as {value:string}|undefined;
  if(!row)return {version:1,rootId:root.id,path:root.path,revision:0,enabled:true,periodicMinutes:30,anchor:null,requested:0,completed:0,launch:null,lastSuccessAt:null,failedPasses:0,paused:'',lastCommand:null};
  if(row.value.length>32768)throw new Error('目录监听记录超过预算');const r=JSON.parse(row.value) as WatchRecord;
  const count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<Number.MAX_SAFE_INTEGER;
  if(!r||Object.keys(r).length!==14||r.version!==1||r.rootId!==root.id||typeof r.path!=='string'||r.path.length>32768||r.path.includes('\0')||!count(r.revision)||typeof r.enabled!=='boolean'||!WATCH_PERIODS.includes(r.periodicMinutes as typeof WATCH_PERIODS[number])||!count(r.requested)||!count(r.completed)||r.completed>r.requested||!Number.isInteger(r.failedPasses)||r.failedPasses<0||r.failedPasses>3||typeof r.paused!=='string'||r.paused.length>512||r.lastSuccessAt!==null&&!count(r.lastSuccessAt))throw new Error('目录监听记录无效，请保留数据库并检查');
  const anchor=(a:WatchAnchor)=>a&&Object.keys(a).length===3&&typeof a.realPath==='string'&&a.realPath.length>0&&a.realPath.length<=32768&&!a.realPath.includes('\0')&&typeof a.dev==='string'&&typeof a.ino==='string'&&/^\d{1,30}$/.test(a.dev)&&/^\d{1,30}$/.test(a.ino);
  if(r.anchor!==null&&!anchor(r.anchor))throw new Error('目录监听身份无效');
  if(r.launch!==null&&(!r.launch||Object.keys(r.launch).length!==4||!uuid.test(r.launch.commandId)||!count(r.launch.epoch)||r.launch.epoch>r.requested||r.launch.jobId!==null&&!uuid.test(r.launch.jobId)||!anchor(r.launch.anchor)))throw new Error('自动扫描回执关系无效');
  if(r.lastCommand!==null){r.lastCommand=readLibraryWatchRequest(r.lastCommand);if(r.lastCommand.rootId!==r.rootId||r.lastCommand.revision+1!==r.revision||r.lastCommand.periodicMinutes!==r.periodicMinutes||(r.lastCommand.action!=='disable')!==r.enabled)throw new Error('自动更新设置回执关系无效');}return r;
 }
 save(r:WatchRecord):void{
  // Every manager mutation is synchronous in the service's sole DB writer.
  const value=JSON.stringify(r);if(value.length>32768)throw new Error('目录监听记录超过预算');
  this.transaction(()=>this.db.prepare('INSERT INTO app_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key(r.rootId),value));
 }
}
