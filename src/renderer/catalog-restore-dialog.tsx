import {useEffect,useRef,useState} from 'react';
import {useFocus,trap} from './dialog-focus';
import {readRestoreState,type CatalogRestoreState} from '../shared/catalog-restore';
import {readRestoreHistory,type CatalogRestoreHistory} from '../shared/catalog-restore-history';
import {readCatalogRestoreReview,type CatalogRestoreReview} from '../shared/catalog-restore-review';
import {CatalogRestoreConfirm} from './catalog-restore-confirm';
import {initialRestoreApplyState,readRestoreApplyState,restoreApplyActive,type RestoreApplyRequest} from '../shared/catalog-restore-consent';
import {CatalogRestoreReviewPanel} from './catalog-restore-review';
import './catalog-backup.css';
const labels:Record<CatalogRestoreState['phase'],string>={idle:'曲库恢复预览',choosing:'选择备份文件',verifying:'校验备份内容',staging:'准备恢复资料',inspecting:'检查暂存内容',ready:'恢复资料已准备',failed:'恢复预览未完成',cancelled:'恢复预览已取消'};
const initial:CatalogRestoreState={operationId:null,phase:'idle',bytes:0,total:0,message:'',preview:null,cancelRequested:false};
const size=(n:number)=>n<1024**3?(n/1024**2).toFixed(1)+' MiB':(n/1024**3).toFixed(2)+' GiB';
export function CatalogRestoreDialog({onClose}:{onClose:()=>void}){
 const [state,setState]=useState(initial),[error,setError]=useState(''),[loading,setLoading]=useState(true),ref=useRef<HTMLDivElement|null>(null);useFocus(ref);
 const [review,setReview]=useState<CatalogRestoreReview|null>(null),[reviewError,setReviewError]=useState(''),[reviewLoading,setReviewLoading]=useState(false),[reviewRefresh,setReviewRefresh]=useState(0);
 useEffect(()=>{let current=true;setReview(null);setReviewError('');setReviewLoading(false);if(state.phase!=='ready'||!state.preview||!state.operationId)return;const expected=state.preview,operationId=state.operationId;setReviewLoading(true);void window.music.catalogRestoreReview(operationId).then(raw=>{const value=readCatalogRestoreReview(raw);if(value.preview.operationId!==operationId||JSON.stringify(value.preview)!==JSON.stringify(expected))throw new Error('恢复审核与当前预览不符');if(current)setReview(value);}).catch(error=>{if(current)setReviewError(String(error));}).finally(()=>{if(current)setReviewLoading(false);});return()=>{current=false;};},[state.phase,state.operationId,state.preview,reviewRefresh]);
 const [applyState,setApplyState]=useState(initialRestoreApplyState);
 useEffect(()=>{let current=true,events=0;const unsubscribe=window.music.onEvent(event=>{if(event.event==='catalogRestoreApplyChanged'){events++;try{if(current)setApplyState(readRestoreApplyState(event.payload));}catch(error){if(current)setError(String(error));}}});const observed=events;void window.music.catalogRestoreApplyState().then(value=>{if(current&&events===observed)setApplyState(readRestoreApplyState(value));}).catch(error=>{if(current)setError(String(error));});return()=>{current=false;unsubscribe();};},[]);
 const applying=restoreApplyActive(applyState),active=!['idle','ready','failed','cancelled'].includes(state.phase)||applying,preview=state.preview;
 const startApply=async(request:RestoreApplyRequest)=>{const accepted=readRestoreApplyState(await window.music.applyCatalogRestore(request));if(accepted.operationId!==request.transactionId||accepted.sourceId!==request.sourceId)throw new Error('恢复确认回执不属于原选择');if(accepted.phase==='interrupted')throw new Error(accepted.message);};
 const [history,setHistory]=useState<CatalogRestoreHistory|null>(null),[historyError,setHistoryError]=useState(''),[refresh,setRefresh]=useState(0),[historyLoading,setHistoryLoading]=useState(false);
 useEffect(()=>{if(active)return;let current=true;setHistoryLoading(true);setHistoryError('');void window.music.catalogRestoreHistory().then(v=>{if(current)setHistory(readRestoreHistory(v));}).catch(e=>{if(current){setHistory(null);setHistoryError(String(e));}}).finally(()=>{if(current)setHistoryLoading(false);});return()=>{current=false;};},[active,state.operationId,state.phase,refresh]);
 useEffect(()=>{let current=true,events=0;const unsubscribe=window.music.onEvent(event=>{if(event.event==='catalogRestoreChanged'){events++;try{if(current)setState(readRestoreState(event.payload));}catch(e){if(current)setError(String(e));}}});const observed=events;void window.music.catalogRestoreState().then(v=>{if(current&&observed===events)setState(readRestoreState(v));}).catch(e=>{if(current)setError(String(e));}).finally(()=>{if(current)setLoading(false);});return()=>{current=false;unsubscribe();};},[]);
 const choose=async()=>{setError('');try{await window.music.prepareCatalogRestore(crypto.randomUUID());}catch(e){setError(String(e));}};
 const cancel=async()=>{const operationId=applying?applyState.operationId:state.operationId;if(!operationId)return;try{await window.music.cancelCatalogRestore(operationId);}catch(e){setError(String(e));}};
 const recheck=async(operationId:string)=>{setError('');try{await window.music.recheckCatalogRestore(operationId);}catch(e){setError(String(e));}};
 return <div className="catalog-backup-overlay"><div className="catalog-backup-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-restore-title" ref={ref} tabIndex={-1} onKeyDown={event=>trap(event,ref.current,onClose)}>
  <h2 id="catalog-restore-title">{labels[state.phase]}</h2>
  <p>选择 Aural 曲库备份，核对其中的资料，并独立准备恢复内容。</p>
  <p className="catalog-backup-note">预览阶段保留当前曲库。音乐目录中的源文件和系统登录凭据不在备份内；标签文件的恢复资料会保留。</p>
  {loading&&<p role="status">正在核对恢复任务状态…</p>}{state.message&&<p role="status" aria-live="polite">{state.message}</p>}
  {state.total>0&&<><progress max={state.total} value={state.bytes} aria-label={labels[state.phase]}/><p>{size(state.bytes)} / {size(state.total)}</p></>}
  {preview&&<><dl><dt>备份文件</dt><dd>{preview.name}</dd><dt>快照时间</dt><dd>{new Date(preview.createdAt).toLocaleString()}</dd><dt>来源版本</dt><dd>Aural {preview.appVersion}</dd><dt>曲目</dt><dd>{preview.counts.playable_item.toLocaleString()}</dd><dt>歌单</dt><dd>{preview.counts.playlist.toLocaleString()}</dd><dt>歌词文档</dt><dd>{preview.counts.lyrics_document.toLocaleString()}</dd><dt>播放历史</dt><dd>{preview.counts.playback_history.toLocaleString()}</dd><dt>资料大小</dt><dd>{preview.files} 个文件 · {size(preview.bytes)}</dd><dt>内容摘要</dt><dd className="catalog-backup-digest">{preview.sha256}</dd></dl>
   {(preview.pendingValues>0||preview.writebackFiles>0)&&<p className="catalog-backup-note">包含 {preview.pendingValues} 项待核对资料和 {preview.writebackFiles} 个标签文件恢复工件，恢复后仍需分别核对原操作。</p>}
   <p>恢复暂存已准备，当前曲库尚未替换。</p></>}
  {reviewLoading&&<p role="status">正在读取本次恢复审核…</p>}{reviewError&&<p role="alert">{reviewError}</p>}{review&&<><CatalogRestoreReviewPanel review={review}/><CatalogRestoreConfirm review={review} state={applyState} onStart={startApply}/></>}
  {applyState.sourceId===state.operationId&&applyState.phase!=='idle'&&<p role="status" aria-live="polite">{applyState.message}</p>}
  {applyState.phase==='interrupted'&&applyState.sourceId===state.operationId&&<p className="catalog-backup-note">原操作未确认完成。若曲库已停止，请退出后重新打开并核对恢复记录。</p>}
  {state.phase==='ready'&&<button disabled={reviewLoading||applying} onClick={()=>setReviewRefresh(n=>n+1)}>刷新审核</button>}
  {error&&<p role="alert">{error}</p>}
  <section className="catalog-backup-history" aria-labelledby="catalog-restore-history-title"><div className="catalog-backup-history-heading"><h3 id="catalog-restore-history-title">保留的恢复资料</h3><button disabled={active||historyLoading} onClick={()=>setRefresh(n=>n+1)}>刷新列表</button></div>
   <p className="catalog-backup-note">记录表示此前准备或核对的结果；重新打开后，使用前请再次核对当前暂存内容。</p>
   {historyLoading&&<p role="status">正在读取保留资料…</p>}{historyError&&<p role="alert">{historyError}</p>}{history?.notice&&<p role="status">{history.notice}</p>}{history?.entries.length===0&&<p>暂无已登记的恢复资料。</p>}
   <ul>{history?.entries.map(entry=><li key={entry.operationId}><strong>{entry.name||'未命名操作 '+entry.operationId.slice(0,8)}</strong><span>{{prepared:'已准备，使用前须核对',checked:'此前核对通过',interrupted:'原准备未完成',invalid:'记录损坏或资料变化'}[entry.status]}</span>{entry.checkedAt&&<time dateTime={entry.checkedAt}>{new Date(entry.checkedAt).toLocaleString()}</time>}<p>{entry.message}</p><button disabled={loading||active||historyLoading||!entry.preview} onClick={()=>void recheck(entry.operationId)}>重新核对并预览</button></li>)}</ul>
  </section>
  <div className="catalog-backup-actions">{!active&&<button disabled={loading} onClick={()=>void choose()}>{preview?'核对另一个备份':'选择备份文件'}</button>}{active&&<button disabled={state.cancelRequested||applyState.cancelRequested||state.phase==='choosing'} onClick={()=>void cancel()}>{state.cancelRequested||applyState.cancelRequested?'等待停止…':applying?'停止恢复':'取消预览'}</button>}<button onClick={onClose}>{active?'后台继续':'关闭'}</button></div>
 </div></div>;
}
