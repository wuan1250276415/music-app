import React,{useEffect,useRef,useState} from 'react';
import {trap,useFocus} from './dialog-focus';
import {userError} from './user-error';
import type {TagBackupCleanupCommand,TagBackupCleanupPage,TagBackupCleanupView} from '../shared/tag-backup-cleanup';
import './tag-write.css';

const states={reserved:'意图已保存',running:'正在处理',verified:'独立核对完成',removed:'已确认清理',failed:'未完成',interrupted:'结果待核对',observed_missing:'当前备份缺失，原结果未完整确认',observed_present:'原备份仍在，未重发清理'};
const kinds={'inspect-backup':'备份核对','delete-backup':'备份清理','observe-backup':'原结果核对'};
export function TagBackupCleanupDialog({jobId,onClose}:{jobId?:string;onClose:()=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);
 const current=useRef<TagBackupCleanupView|null>(null);
 const alive=useRef(true),selected=useRef<string|null>(null),attempt=useRef<TagBackupCleanupCommand|null>(null),cursor=useRef<number|undefined>(undefined),request=useRef(0);
 const [page,setPage]=useState<TagBackupCleanupPage|null>(null),[view,setView]=useState<TagBackupCleanupView|null>(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState('');
 function install(value:TagBackupCleanupView):void{if(current.current?.id===value.id&&current.current.revision>value.revision)return;if(selected.current!==value.id){setConfirmed(false);request.current++;}selected.current=value.id;current.current=value;setView(value);}
 async function loadList():Promise<void>{const value=await window.music.tagBackupCleanupList(cursor.current);if(alive.current)setPage(value);}
 async function refresh(id=selected.current):Promise<void>{if(!id)return;const marker=++request.current,value=await window.music.tagBackupCleanupGet(id);if(alive.current&&marker===request.current)install(value);}
 useEffect(()=>{
  alive.current=true;void loadList().catch(e=>{if(alive.current)setError(userError(e));});
  const timer=setInterval(()=>{void refresh().catch(()=>{});},2000);
  const unlisten=window.music.onEvent(message=>{if(message.event==='tagBackupStorageChanged'){void refresh().catch(()=>{});void loadList().catch(()=>{});}});
  return()=>{alive.current=false;request.current++;clearInterval(timer);unlisten();};
 },[]);
 async function submit(value:TagBackupCleanupCommand):Promise<void>{
  if(busy)return;attempt.current??=value;setBusy(true);setError('');
  try{const result=await window.music.tagBackupCleanupCommand(attempt.current);attempt.current=null;if(alive.current){setUncertain(false);install(result);await loadList();}}
  catch(e){if(alive.current){setUncertain(true);setError(`${userError(e)}。可核对原请求结果，重复核对会复用原操作。`);}}
  finally{if(alive.current)setBusy(false);}
 }
 const running=view&&['reserved','running'].includes(view.state),canDelete=view?.kind==='inspect-backup'&&view.state==='verified'&&view.exitConfirmed&&view.proof?.backup.state==='present';
 return <div className="collection-backdrop"><div ref={dialog} className="catalog-dialog collection-dialog tag-write-dialog" role="dialog" aria-modal="true" aria-label="标签备份清理" onKeyDown={event=>trap(event,dialog.current,onClose,false)}>
  <header><h2>标签备份清理与记录</h2><button aria-label="关闭标签备份清理" onClick={onClose}>×</button></header>
  <p className="collection-note">每份备份先独立核对，再单独确认清理。只处理任务已结束且达到保留期的备份，音乐文件和清理记录会保留。停止请求会等待当前文件处理结束；关闭页面后仍可从记录查看结果。</p>
  {error&&<p role="alert" className="collection-error">{error}</p>}
  {uncertain&&<button disabled={busy} onClick={()=>attempt.current&&void submit(attempt.current)}>核对原请求结果</button>}
  {jobId&&<button disabled={busy||Boolean(running)||uncertain} onClick={()=>void submit({commandId:crypto.randomUUID(),action:'inspect',jobId})}>独立核对此备份</button>}
  {view&&<section data-tag-cleanup-detail={view.id}>
   <h3>{kinds[view.kind]} · {states[view.state]}</h3><p>{view.reason}</p><p>本份文件大小：{view.total} 字节</p>
   {view.proof&&<p className="collection-note">{view.state==='observed_missing'?'独立核对时未发现原备份；原清理结果仍未完整确认。':view.state==='observed_present'?'独立核对确认原备份仍在；原清理操作未重新执行。':view.proof.backup.state==='missing'?'本次核对时未发现原备份。':view.state==='removed'&&view.exitConfirmed?'原备份已按已核对的文件身份清理。':view.proof.removed?'已记录文件删除阶段，最终结果仍待确认。':'内容与原备份记录一致；文件仍保留。'}</p>}
   {canDelete&&<><label className="tag-write-confirm"><input type="checkbox" checked={confirmed} disabled={busy||uncertain} onChange={event=>setConfirmed(event.target.checked)}/>我确认清理此份已核对的备份，清理后不能再从此备份恢复</label><button disabled={busy||uncertain||!confirmed} onClick={()=>void submit({commandId:crypto.randomUUID(),action:'remove',inspectionId:view.id,confirmed:true})}>确认清理此备份</button></>}
   {running&&<button disabled={busy||uncertain||view.stopRequested} onClick={()=>void submit({commandId:crypto.randomUUID(),action:'stop',operationId:view.id})}>{view.stopRequested?'已请求停止，等待当前文件结束':'停止此操作'}</button>}
   {view.kind==='delete-backup'&&['interrupted','failed'].includes(view.state)&&!view.reconcileId&&<button disabled={busy||uncertain} onClick={()=>void submit({commandId:crypto.randomUUID(),action:'observe',operationId:view.id})}>核对原清理结果</button>}
   {view.reconcileId&&<button disabled={busy||uncertain} onClick={()=>void refresh(view.reconcileId!)}>查看独立核对记录</button>}
  </section>}
  <section className="tag-backup-entries" aria-label="备份清理记录"><h3>已保存的操作</h3>{page?.items.map(item=><article key={item.id}><button data-tag-cleanup-operation={item.id} disabled={busy||uncertain} onClick={()=>void refresh(item.id).catch(e=>setError(userError(e)))}>{kinds[item.kind]} · {states[item.state]} · {new Date(item.createdAt).toLocaleString()}</button><p className="collection-note">{item.reason}</p></article>)}{!page?.items.length&&<p>暂无备份核对或清理记录。</p>}{page?.nextCursor&&<button disabled={busy} onClick={()=>{cursor.current=page.nextCursor!;void loadList().catch(e=>setError(userError(e)));}}>查看更早的记录</button>}<button disabled={busy} onClick={()=>{cursor.current=undefined;void loadList().catch(e=>setError(userError(e)));}}>刷新最近记录</button></section>
  <footer><button onClick={onClose}>关闭</button><button disabled={busy||!selected.current} onClick={()=>void refresh().catch(e=>setError(userError(e)))}>刷新原操作</button></footer>
 </div></div>;
}
