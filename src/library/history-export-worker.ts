import {DatabaseSync} from 'node:sqlite';
import {lstatSync} from 'node:fs';
import path from 'node:path';
import {historyQueryPlan} from './playback-history.js';
import {readPlaybackPolicy} from '../shared/playback-policy.js';
import {HISTORY_EXPORT_BATCH,HISTORY_EXPORT_MAX_ROWS,HISTORY_EXPORT_FRAME_BYTES,HISTORY_EXPORT_DEADLINE_MS,readHistoryExportRequest,readHistoryExportHeader,readHistoryExportRecord,readHistoryPending,type HistoryExportRequest,type HistoryExportFrame,type HistoryExportRecord,type HistoryPendingObservation} from '../shared/history-export.js';

type Port={on:(event:'message',listener:(event:{data:unknown})=>void)=>void;postMessage:(value:HistoryExportFrame)=>void};
const port=(process as typeof process&{parentPort?:Port}).parentPort;
if(!port)throw new Error('历史导出须由受监督的独立进程启动');
let begun=false,operationId='',sequence=0,cancelled=false;
let waiting:{sequence:number;resolve:()=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|null=null;
function send(frame:HistoryExportFrame):Promise<void>{
 if(cancelled)return Promise.reject(new Error('历史导出已停止'));if(Buffer.byteLength(JSON.stringify(frame),'utf8')>HISTORY_EXPORT_FRAME_BYTES)throw new Error('历史导出批次超过消息预算');
 return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting=null;reject(new Error('历史导出写入确认超时'));},15000);waiting={sequence:frame.sequence,resolve,reject,timer};port!.postMessage(frame);});
}
async function run(source:string,request:HistoryExportRequest,pendingAtRequest:HistoryPendingObservation):Promise<void>{
 let db:DatabaseSync|undefined;const deadline=Date.now()+HISTORY_EXPORT_DEADLINE_MS;
 try{
  if(!path.isAbsolute(source)||path.basename(source)!=='library.db'||source.length>32767)throw new Error('历史导出曲库路径无效');
  const stat=lstatSync(source);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('历史导出曲库不是普通文件');
  db=new DatabaseSync(source,{readOnly:true,allowExtension:false,timeout:1000});db.exec('PRAGMA query_only=ON; PRAGMA cache_size=-2048; BEGIN');
  // The first read pins the WAL view; all later rows and policies use this connection/transaction.
  const schema=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version),mode=(db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode;
  if(schema!==77||mode!=='wal')throw new Error('历史导出需要当前WAL曲库，不能在此进程迁移或更改日志模式');
  const ceiling=Number((db.prepare('SELECT COALESCE(MAX(id),0) n FROM playback_history').get() as {n:number}).n),origin=(db.prepare('SELECT id FROM rule_transfer_origin WHERE slot=1').get() as {id:string}|undefined)?.id;
  const header=readHistoryExportHeader({type:'header',format:'aural-playback-history',version:1,encoding:request.format,snapshotAt:new Date().toISOString(),origin,schema,scope:request.scope,pendingAtRequest,ceiling,legacyRule:'fixed-v1'});
  await send({operationId,sequence:sequence++,kind:'header',header});
  const plan=historyQueryPlan(request.scope),statement=db.prepare(`SELECT id,session_id,entry_id,item_id,created_at,last_checkpoint,presented_us,estimated_us,furthest_us,counted,updated_at,last_observed_at,observed_basis,
   CASE WHEN length(CAST(identity_json AS BLOB))<=32768 THEN identity_json ELSE NULL END identity_json
   FROM playback_history WHERE ${plan.scope} AND id<=? AND id<? ORDER BY id DESC LIMIT ?`);
  let before=ceiling===Number.MAX_SAFE_INTEGER?ceiling:ceiling+1,rows=0,plays=0,presented=0n,estimated=0n;
  if(ceiling===Number.MAX_SAFE_INTEGER)throw new Error('历史序号已达到导出游标上限');
  for(;;){
   if(cancelled||Date.now()>deadline)throw new Error(cancelled?'历史导出已停止':'历史导出超过10分钟预算');
   const raw=statement.all(...plan.params,ceiling,before,HISTORY_EXPORT_BATCH) as Array<{id:number;session_id:string;entry_id:string;item_id:string;created_at:string;identity_json:string;last_checkpoint:number;presented_us:number;estimated_us:number;furthest_us:number;counted:number;updated_at:string;last_observed_at:string;observed_basis:string}>;
   if(!raw.length)break;
   const batch:HistoryExportRecord[]=raw.map(row=>{
    if(typeof row.identity_json!=='string'||Buffer.byteLength(row.identity_json,'utf8')>32768)throw new Error('播放历史身份数据超过预算');
    const identity=JSON.parse(row.identity_json) as Record<string,unknown>;
    if(!identity||typeof identity!=='object'||Array.isArray(identity)||Object.keys(identity).length!==(identity.policyVersion===2?10:9)||['checkpoint','presentedUs','estimatedUs','furthestUs','observedAt','id','counted','updatedAt','timeBasis'].some(k=>Object.hasOwn(identity,k))||row.counted!==0&&row.counted!==1)throw new Error('播放历史存档身份结构无效');
    const record=readHistoryExportRecord({...identity,id:row.id,checkpoint:row.last_checkpoint,presentedUs:row.presented_us,estimatedUs:row.estimated_us,furthestUs:row.furthest_us,counted:row.counted===1,updatedAt:row.updated_at,observedAt:row.last_observed_at,timeBasis:row.observed_basis});
    if(record.sessionId!==row.session_id||record.entryId!==row.entry_id||record.itemId!==row.item_id||record.startedAt!==row.created_at)throw new Error('播放历史行与原身份资料不符');
    if(record.id>=before||record.id>ceiling)throw new Error('历史导出分页身份回退');
    if(record.policy){const stored=db!.prepare('SELECT value_json FROM playback_counting_policy WHERE revision=?').get(record.policy.revision) as {value_json:string}|undefined;if(!stored||JSON.stringify(readPlaybackPolicy(JSON.parse(stored.value_json)))!==JSON.stringify(record.policy))throw new Error('历史导出冻结规则与快照中的持久规则不符');}
    return record;
   });
   if(batch.some((v,i)=>i>0&&v.id>=batch[i-1].id))throw new Error('历史导出页顺序不符');
   rows+=batch.length;if(rows>HISTORY_EXPORT_MAX_ROWS)throw new Error('导出超过100万条，请缩小检索范围后导出');
   for(const row of batch){plays+=row.counted?1:0;presented+=BigInt(row.presentedUs);estimated+=BigInt(row.estimatedUs);}
   await send({operationId,sequence:sequence++,kind:'rows',rows:batch});before=batch[batch.length-1].id;
  }
  db.exec('ROLLBACK');db.close();db=undefined;
  await send({operationId,sequence:sequence++,kind:'done',totals:{rows,plays,presentedUs:String(presented),estimatedUs:String(estimated)}});
  process.exit(0);
 }finally{if(db){try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}}
}
port.on('message',event=>{
 const v=event.data as Record<string,unknown>;
 if(!v||typeof v!=='object'||Array.isArray(v))return;
 if(!begun&&v.kind==='begin'){
  begun=true;
  void (async()=>{if(Object.keys(v).length!==4||typeof v.source!=='string')throw new Error('历史导出启动参数无效');const r=readHistoryExportRequest(v.request);operationId=r.operationId;await run(v.source,r,readHistoryPending(v.pendingAtRequest));})().catch(error=>{try{port.postMessage({operationId,sequence,kind:'error',error:String(error instanceof Error?error.message:error).slice(0,1024)||'历史导出失败'});}finally{process.exit(1);}});
 }else if(v.operationId===operationId&&v.kind==='ack'&&Object.keys(v).length===3&&waiting&&v.sequence===waiting.sequence){const current=waiting;waiting=null;clearTimeout(current.timer);current.resolve();}
 else if(v.operationId===operationId&&v.kind==='cancel'&&Object.keys(v).length===2){cancelled=true;if(waiting){const current=waiting;waiting=null;clearTimeout(current.timer);current.reject(new Error('历史导出已停止'));}}
});
