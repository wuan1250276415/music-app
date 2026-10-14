import {useEffect,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {catalogBackupClient,closeCatalogBackup,startCatalogBackup,cancelCatalogBackup,readCatalogBackupHistory,verifyCatalogBackup} from './catalog-backup-client.js';
import type {CatalogBackupHistory} from '../shared/catalog-backup-history.js';
import {restoreApplyActive} from '../shared/catalog-restore-consent';
import './catalog-backup.css';
const labels:Record<string,string>={idle:'曲库备份',choosing:'选择保存位置',freezing:'冻结待保存资料',draining:'等待原任务结束',capturing:'建立一致快照',releasing:'恢复后台任务',packing:'生成备份',verifying:'复核备份',publishing:'完成保存',completed:'备份完成',checked:'文件核对完成',failed:'备份未完成',cancelled:'备份已取消'};
const historyLabels:Record<string,string>={recorded:'保存完成，当前文件待核对',interrupted:'原操作未确认完成',cancelled:'已取消',failed:'保存或核对未完成',verified:'文件核对通过',reconciled:'内容一致，原保存回执未确认',invalid:'记录损坏或不完整'};
const size=(bytes:number)=>bytes<1024**2?(bytes/1024).toFixed(1)+' KiB':bytes<1024**3?(bytes/1024**2).toFixed(1)+' MiB':(bytes/1024**3).toFixed(2)+' GiB';
export function CatalogBackupBoundary({children}:{children:ReactNode}){
 const client=useSyncExternalStore(catalogBackupClient.subscribe,catalogBackupClient.snapshot),ref=useRef<HTMLDivElement|null>(null),state=client.state;
 const applying=restoreApplyActive(client.restoreApply),ownedApply=state.operationId!==null&&state.operationId===client.restoreApply.operationId;
 const restoreInterrupted=client.restoreApply.phase==='interrupted'&&client.restoreOperationId===client.restoreApply.operationId;
 const restoring=applying||restoreInterrupted||state.operationId!==null&&client.restoreOperationId===state.operationId;
 const active=applying||!['idle','completed','checked','failed','cancelled'].includes(state.phase),shown=client.open||state.held;
 const restoreRetained=ownedApply&&client.restoreApply.phase==='retained';
 const shownMessage=restoring&&(applying&&!ownedApply||restoreRetained||restoreInterrupted)?client.restoreApply.message:state.message;
 const [history,setHistory]=useState<CatalogBackupHistory|null>(null),[historyError,setHistoryError]=useState(''),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(false);
 useEffect(()=>{if(!shown||active||state.held||restoring)return;let current=true;setLoading(true);setHistoryError('');void readCatalogBackupHistory().then(result=>{if(current)setHistory(result);},error=>{if(current){setHistory(null);setHistoryError(String(error));}}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;};},[shown,active,state.held,state.operationId,state.phase,refresh,restoring]);
 useEffect(()=>{if(!shown)return;const previous=document.activeElement as HTMLElement|null;ref.current?.focus();return()=>{previous?.focus();};},[shown]);
 return <><div className="catalog-backup-app" inert={state.held}>{children}</div>{shown&&<div className="catalog-backup-overlay"><div className="catalog-backup-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-backup-title" ref={ref} tabIndex={-1} onKeyDown={event=>{
  if(event.key==='Escape'&&!state.held){event.preventDefault();closeCatalogBackup();}
  if(event.key==='Tab'){const elements=[...ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]')];if(!elements.length){event.preventDefault();return;}const first=elements[0],last=elements[elements.length-1];if(event.shiftKey&&(document.activeElement===first||document.activeElement===ref.current)){event.preventDefault();last.focus();}else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===ref.current)){event.preventDefault();first.focus();}}
 }}>
  <h2 id="catalog-backup-title">{restoring?restoreInterrupted||state.phase==='failed'?'恢复未完成':restoreRetained?'已返回原曲库':!applying&&state.phase==='checked'?'曲库恢复完成':'正在恢复音乐库':labels[state.phase]}</h2>
  <p>{restoring?restoreInterrupted?'原恢复操作未确认完成，资料和记录保留，须按实际状态核对。':restoreRetained?'备份未替换当前资料，已核对并返回原曲库。可以继续浏览，并手动开始播放。':!applying&&state.phase==='checked'?'曲库与使用状态已恢复，原资料和恢复记录已保留。可以继续浏览，并手动开始播放。':'正在恢复曲库资料、歌单、歌词和使用设置，并核对新界面。完成前，界面操作继续暂停。':'保存曲库资料、歌单、用户歌词、播放历史与设置，并保留待核对操作和标签写回的恢复资料。'}</p>
  <p className="catalog-backup-note">{restoring?'播放会保持停止，请在恢复完成后手动继续。原待保存资料和恢复记录会保留。':'不打包音乐目录中的源文件；标签写回的恢复副本会保留。系统登录凭据不包含在备份中。建立快照时会停止播放，完成后请手动继续。'}</p>
  {shownMessage&&<p role="status" aria-live="polite">{shownMessage}</p>}
  {(!applying||ownedApply)&&state.total>0&&<><progress max={state.total} value={state.bytes} aria-label={labels[state.phase]}/><p>{size(state.bytes)} / {size(state.total)}</p></>}
  {!restoring&&state.result&&<dl><dt>备份文件</dt><dd>{state.result.name}</dd><dt>内容</dt><dd>{state.result.items.toLocaleString()} 首曲目 · {state.result.files} 个资料文件 · {size(state.result.bytes)}</dd><dt>快照时间</dt><dd>{new Date(state.result.createdAt).toLocaleString()}</dd><dt>内容摘要</dt><dd className="catalog-backup-digest">{state.result.sha256}</dd></dl>}
  {client.error&&<p role="alert" className="catalog-backup-error">{client.error}</p>}
  {state.held&&state.phase==='failed'&&<p className="catalog-backup-error">维护停止或释放未获确认。请退出后重新打开应用，再核对原资料。</p>}
  {!state.held&&!restoring&&<section className="catalog-backup-history" aria-labelledby="catalog-backup-history-title">
   <div className="catalog-backup-history-heading"><h3 id="catalog-backup-history-title">备份操作记录</h3><button disabled={active||loading} onClick={()=>setRefresh(n=>n+1)}>刷新记录</button></div>
   <p className="catalog-backup-note">重启后保留原操作状态。文件核对只读取原保存位置，不恢复曲库；每次核对结果只代表当次读取。</p>
   {loading&&<p role="status">正在读取记录…</p>}{historyError&&<p role="alert">{historyError}</p>}{history?.notice&&<p role="status">{history.notice}</p>}
   {history?.entries.length===0&&<p>暂无已登记的备份操作。</p>}
   <ul>{history?.entries.map(entry=><li key={entry.operationId}><strong>{entry.name||'未命名操作 '+entry.operationId.slice(0,8)}</strong><span>{historyLabels[entry.status]}</span>{entry.updatedAt&&<time dateTime={entry.updatedAt}>{new Date(entry.updatedAt).toLocaleString()}</time>}<p>{entry.message}</p><button disabled={active||loading||!entry.canVerify} onClick={()=>void verifyCatalogBackup(entry.operationId)}>核对备份文件</button></li>)}</ul>
  </section>}
  <div className="catalog-backup-actions">
   {!active&&!state.held&&!restoring&&<button onClick={()=>void startCatalogBackup()}>保存曲库备份</button>}
   {active&&<button disabled={state.cancelRequested||client.restoreApply.cancelRequested&&applying||!applying&&(state.phase==='choosing'||state.phase==='publishing')} onClick={()=>void cancelCatalogBackup()}>{state.cancelRequested||applying&&client.restoreApply.cancelRequested?'等待停止…':restoring?'停止恢复':'取消备份'}</button>}
   {!state.held&&<button onClick={()=>closeCatalogBackup()}>{active?'后台继续':'关闭'}</button>}
   {state.held&&state.phase==='failed'&&<button onClick={()=>void window.music.quitCatalogBackup()}>退出应用</button>}
  </div>
 </div></div>}</>;
}
