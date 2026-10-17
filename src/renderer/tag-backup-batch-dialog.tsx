import React,{useEffect,useRef,useState} from 'react';
import {trap,useFocus} from './dialog-focus';
import {userError} from './user-error';
import {TagBackupCleanupDialog} from './tag-backup-cleanup-dialog';
import type {TagBackupBatch,TagBackupBatchCommand,TagBackupBatchItems,TagBackupBatchPage,TagBackupSchedule,TagBackupScheduleRequest} from '../shared/tag-backup-batch';
import './tag-write.css';

const states={ready:'范围已保存，待确认',running:'正在逐份处理',pausing:'正在等待当前文件结束',paused:'已暂停',cancelling:'正在取消',cancelled:'已取消',completed:'已处理完本批次',attention:'有异常项待处理',interrupted:'上次处理已中断'};
const itemStates={pending:'待处理',inspecting:'正在核对',removing:'正在清理',removed:'已确认清理',blocked:'需要处理',skipped:'已明确跳过'};
type Attempt={kind:'preview';id:string}|{kind:'command';request:TagBackupBatchCommand}|{kind:'schedule';request:TagBackupScheduleRequest};
export function TagBackupBatchDialog({onClose}:{onClose:()=>void}):React.JSX.Element {
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);
 const alive=useRef(true),selected=useRef<string|null>(null),latest=useRef<TagBackupBatch|null>(null),attempt=useRef<Attempt|null>(null),epoch=useRef(0),offset=useRef(0),cursor=useRef<number|undefined>(undefined);
 const [page,setPage]=useState<TagBackupBatchPage|null>(null),[detail,setDetail]=useState<TagBackupBatchItems|null>(null),[schedule,setSchedule]=useState<TagBackupSchedule|null>(null),[enabled,setEnabled]=useState(false),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState(''),[records,setRecords]=useState(false);
 function install(value:TagBackupBatchItems):void {if(latest.current?.id===value.batch.id&&latest.current.revision>value.batch.revision)return;if(latest.current?.id!==value.batch.id||latest.current?.state!==value.batch.state)setConfirmed(false);latest.current=value.batch;selected.current=value.batch.id;setDetail(value);}
 async function list():Promise<void>{const value=await window.music.tagBackupBatchList(cursor.current);if(alive.current)setPage(value);}
 async function refresh(id=selected.current,next=offset.current):Promise<void>{if(!id)return;const marker=++epoch.current,value=await window.music.tagBackupBatchItems({batchId:id,offset:next});if(alive.current&&marker===epoch.current){offset.current=next;install(value);}}
 useEffect(()=>{alive.current=true;void list().catch(e=>setError(userError(e)));void window.music.tagBackupSchedule().then(s=>{if(alive.current){setSchedule(s);setEnabled(s.effective);}}).catch(e=>setError(userError(e)));const timer=setInterval(()=>void refresh().catch(()=>{}),2000),off=window.music.onEvent(e=>{if(e.event==='tagBackupStorageChanged'){void window.music.tagBackupSchedule().then(s=>{if(alive.current)setSchedule(s);}).catch(()=>{});void list().catch(()=>{});void refresh().catch(()=>{});}});return()=>{alive.current=false;epoch.current++;clearInterval(timer);off();};},[]);
 async function submit(value:Attempt):Promise<void>{if(busy)return;attempt.current??=value;const q=attempt.current;setBusy(true);setError('');epoch.current++;
  try{if(q.kind==='schedule'){const s=await window.music.tagBackupScheduleConfigure(q.request);if(alive.current){setSchedule(s);setEnabled(s.effective);}}else{const b=q.kind==='preview'?await window.music.tagBackupBatchPreview(q.id):await window.music.tagBackupBatchCommand(q.request);if(alive.current){selected.current=b.id;offset.current=0;await refresh(b.id,0);}}attempt.current=null;if(alive.current){setUncertain(false);await list();}}
  catch(e){if(alive.current){setUncertain(true);setError(`${userError(e)}。可核对原请求结果；不会重复创建或清理。`);}}
  finally{if(alive.current)setBusy(false);}
 }
 function command(action:'start'|'pause'|'cancel'|'skip',ordinal?:number):void{if(!detail)return;const base={commandId:crypto.randomUUID(),batchId:detail.batch.id,baseRevision:detail.batch.revision};const request=action==='start'?{...base,action,confirmed:true as const}:action==='skip'?{...base,action,ordinal:ordinal!}:{...base,action};void submit({kind:'command',request});}
 const batch=detail?.batch,running=batch&&['running','pausing','cancelling'].includes(batch.state),canStart=batch&&['ready','paused','interrupted','attention'].includes(batch.state);
 if(records)return <TagBackupCleanupDialog onClose={()=>{setRecords(false);void refresh();}}/>;
 return <div className="collection-backdrop"><div ref={dialog} className="catalog-dialog collection-dialog tag-write-dialog" role="dialog" aria-modal="true" aria-label="备份批量与自动清理" onKeyDown={event=>trap(event,dialog.current,onClose,false)}>
  <header><h2>备份批量与自动清理</h2><button aria-label="关闭备份批次" onClick={onClose}>×</button></header>
  <p className="collection-note">仅处理已达到保留期、任务已结束且不再用于恢复的备份。每批最多100份，每份先独立核对再清理；音乐文件、原操作记录和未确认的文件会保留。暂停和取消等待当前文件结束。</p>
  {error&&<p role="alert" className="collection-error">{error}</p>}{uncertain&&<button disabled={busy} onClick={()=>attempt.current&&void submit(attempt.current)}>核对原批次请求结果</button>}
  <section><h3>自动清理</h3><label><input type="checkbox" aria-label="按保留期自动清理备份" disabled={!schedule||busy||uncertain} checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>按保留期自动清理备份</label><p className="collection-note">默认关闭。开启后定期核对，到期备份按批次处理；重启遇到未完成批次时，需要先明确继续或取消。恢复曲库后须重新确认此设置。</p>{schedule?.reason&&<p role="status">{schedule.reason}</p>}<button disabled={!schedule||busy||uncertain} onClick={()=>schedule&&void submit({kind:'schedule',request:{commandId:crypto.randomUUID(),baseRevision:schedule.revision,enabled}})}>保存自动清理设置</button></section>
  <section><h3>手动批量清理</h3><button disabled={busy||uncertain} onClick={()=>void submit({kind:'preview',id:crypto.randomUUID()})}>核对到期备份范围</button></section>
  {detail&&<section data-tag-backup-batch={detail.batch.id}><h3>{states[detail.batch.state]} · {detail.batch.total}份</h3><p>{detail.batch.message}</p><p>已清理 {detail.batch.counts.removed} · 待处理 {detail.batch.counts.pending} · 异常 {detail.batch.counts.blocked} · 跳过 {detail.batch.counts.skipped}</p>
   {canStart&&<><label><input type="checkbox" aria-label="确认清理本批次" disabled={busy||uncertain} checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我确认按此固定范围清理，清理后不能再从这些备份恢复</label><button disabled={busy||uncertain||!confirmed} onClick={()=>command('start')}>确认清理本批次</button></>}
   {batch?.state==='running'&&<button disabled={busy||uncertain} onClick={()=>command('pause')}>暂停清理批次</button>}{!['completed','cancelled','cancelling'].includes(detail.batch.state)&&<button disabled={busy||uncertain} onClick={()=>command('cancel')}>取消清理批次</button>}
   {running&&<p role="status">正在后台处理，关闭此页面后仍可查看进度。</p>}
   <div className="tag-backup-entries">{detail.items.map(item=><article key={item.ordinal}><h4>{item.ordinal+1}. {item.basis.title} · {itemStates[item.state]}</h4><p>{item.message}</p>{item.state==='blocked'&&<><button disabled={busy||uncertain||Boolean(running)} onClick={()=>command('skip',item.ordinal)}>明确跳过此项</button><button onClick={()=>setRecords(true)}>核对原操作记录</button></>}</article>)}</div>
   <button disabled={busy||offset.current===0} onClick={()=>void refresh(selected.current,Math.max(0,offset.current-20))}>上一页备份</button><button disabled={busy||detail.nextOffset===null} onClick={()=>void refresh(selected.current,detail.nextOffset!)}>下一页备份</button>
  </section>}
  <section><h3>已保存的批次</h3>{page?.items.map(item=><article key={item.id}><button disabled={busy||uncertain} data-tag-backup-batch-history={item.id} onClick={()=>void refresh(item.id,0).catch(e=>setError(userError(e)))}>{item.source==='automatic'?'自动':'手动'} · {states[item.state]} · {item.total}份 · {new Date(item.createdAt).toLocaleString()}</button></article>)}{!page?.items.length&&<p>暂无批次。</p>}{page?.nextCursor&&<button onClick={()=>{cursor.current=page.nextCursor!;void list();}}>查看更早批次</button>}<button onClick={()=>{cursor.current=undefined;void list();}}>刷新最近批次</button></section>
  <footer><button onClick={onClose}>关闭</button><button onClick={()=>setRecords(true)}>查看逐份清理记录</button></footer>
 </div></div>;
}
