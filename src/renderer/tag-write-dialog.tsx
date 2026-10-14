import React,{useEffect,useRef,useState} from 'react';
import {TAG_FIELD_LABELS,type TagWriteContext,type TagWriteDraft,type TagWritePreview,type TagWritePrepareRequest,type TagWriteCancelRequest,type TagWriteJobPage} from '../shared/tag-write-ui';
import type {TagWriteField} from '../shared/tag-write';
import {trap,useFocus} from './dialog-focus';
import './tag-write.css';
import {TagRecoveryResult} from './tag-recovery-result';
import {TagRecoveryActions} from './tag-recovery-actions';
import {TagCommitRecovery} from './tag-commit-recovery';
import {TagRestoreRecovery} from './tag-restore-recovery';
import type {TagRecoveryCancelRequest} from '../shared/tag-recovery';

type Edit={enabled:boolean;origin:'manual'|'library';text:string;clear:boolean};
const status={prepared:'待写入',running:'正在写入',cancelled:'已取消',failed:'失败',recovery_required:'等待恢复',completed:'已完成'};
const phaseLabels:Record<string,string>={starting:'等待文件读取组件退出',planned:'开始核对文件',source:'核对原文件',backup:'生成备份',temporary:'生成临时文件',verify:'回读校验',validated:'源文件已核对',backup_ready:'备份已校验',temp_written:'临时文件已校验',staged:'暂存完成',recovery_required:'等待恢复'};
export function TagWriteDialog({itemId,onClose}:{itemId:string;onClose:()=>void}):React.JSX.Element {
 const dialog=useRef<HTMLDivElement|null>(null);useFocus(dialog);
 const epoch=useRef(0),previewRequest=useRef<string|null>(null),attempt=useRef<TagWritePrepareRequest|null>(null),cancelAttempts=useRef(new Map<string,TagWriteCancelRequest>());
 const stageAttempts=useRef(new Map<string,TagWriteCancelRequest>());
 const inspectionAttempts=useRef(new Map<string,TagWriteCancelRequest>()),inspectionStops=useRef(new Map<string,TagRecoveryCancelRequest>());
 const [context,setContext]=useState<TagWriteContext|null>(null),[edits,setEdits]=useState<Partial<Record<TagWriteField,Edit>>>({}),[preview,setPreview]=useState<TagWritePreview|null>(null),[page,setPage]=useState<TagWriteJobPage|null>(null);
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[manualConfirmed,setManualConfirmed]=useState(false),[reviewed,setReviewed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[reload,setReload]=useState(0),[now,setNow]=useState(Date.now());
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>window.music.onEvent(message=>{
  if(['libraryChanged','providersChanged'].includes(message.event)){epoch.current++;setStale(true);setReviewed(false);}
  if(['tagWriteJobsChanged','scanJobsChanged','libraryChanged'].includes(message.event))void window.music.tagWriteJobs().then(setPage).catch(e=>setError(String(e)));
 }),[]);
 useEffect(()=>{
  let alive=true;const marker=epoch.current;setLoading(true);setError('');setNotice('');setPreview(null);setReviewed(false);setManualConfirmed(false);setEdits({});setStale(false);
  void Promise.all([window.music.tagWriteContext(itemId),window.music.tagWriteJobs()]).then(([c,p])=>{if(alive){setContext(c);setPage(p);setStale(marker!==epoch.current);}}).catch(e=>{if(alive)setError(String(e));}).finally(()=>{if(alive)setLoading(false);});
  return()=>{alive=false;if(previewRequest.current)void window.music.tagWritePreviewCancel(previewRequest.current).catch(()=>{});};
 },[itemId,reload]);
 function edit(field:TagWriteField,patch:Partial<Edit>):void {if(attempt.current)return;setEdits(values=>({...values,[field]:{enabled:false,origin:'manual',text:'',clear:false,...values[field],...patch}}));setPreview(null);setReviewed(false);setManualConfirmed(false);setNotice('');}
 const selected=context?.fields.filter(f=>edits[f.field]?.enabled)??[],hasManual=selected.some(f=>edits[f.field]?.origin==='manual');
 async function makePreview():Promise<void> {
  if(!context||busy||stale||!context.eligible||!selected.length||attempt.current)return;
  setBusy(true);setError('');setNotice('');setPreview(null);setReviewed(false);
  const requestId=crypto.randomUUID(),marker=epoch.current;previewRequest.current=requestId;
  const draft:TagWriteDraft={requestId,itemId,fingerprint:context.fingerprint,manualConfirmed,fields:selected.map(f=>{const e=edits[f.field]!;return {field:f.field,origin:e.origin,values:e.origin==='library'?[...f.values]:e.clear?[]:e.text.split('\n')};})};
  try{const result=await window.music.tagWritePreview(draft);setPreview(result);setStale(epoch.current!==marker);}
  catch(e){setError(String(e));}finally{setBusy(false);}
 }
 async function save():Promise<void> {
  if(busy||!preview||!attempt.current&&(stale||!reviewed||now>=preview.expiresAt||!preview.preview.changed))return;
  attempt.current??={commandId:crypto.randomUUID(),token:preview.token};setBusy(true);setError('');
  try{const result=await window.music.tagWritePrepare(attempt.current);attempt.current=null;setNotice(`${result.title}：待写入任务已保存。音乐文件尚未修改。`);setPreview(null);setReviewed(false);setPage(await window.music.tagWriteJobs());}
  catch(e){setError(`保存结果尚待确认：${String(e)}。请重试原操作，重试不会生成重复任务。`);}finally{setBusy(false);}
 }
 async function cancelJob(id:string,revision:number):Promise<void> {
  if(busy||attempt.current)return;const request=cancelAttempts.current.get(id)??{commandId:crypto.randomUUID(),jobId:id,baseRevision:revision};cancelAttempts.current.set(id,request);setBusy(true);setError('');
  try{const result=await window.music.tagWriteCancel(request);cancelAttempts.current.delete(id);setNotice(`${result.title}：待写入任务已取消。`);setPage(await window.music.tagWriteJobs());}
  catch(e){setError(`${String(e)}。再次点击将查询或重试原取消操作。`);}finally{setBusy(false);}
 }
 async function inspectJob(id:string,revision:number):Promise<void>{
  if(busy||attempt.current)return;const request=inspectionAttempts.current.get(id)??{commandId:crypto.randomUUID(),jobId:id,baseRevision:revision};inspectionAttempts.current.set(id,request);setBusy(true);setError('');
  try{await window.music.tagWriteInspect(request);inspectionAttempts.current.delete(id);setNotice('已保存恢复核对请求。文件及恢复占用继续保留。');setPage(await window.music.tagWriteJobs());}catch(e){setError(`${String(e)}。再次点击将查询或重试原核对请求。`);}finally{setBusy(false);}
 }
 async function stopInspection(id:string):Promise<void>{
  if(busy||attempt.current)return;const request=inspectionStops.current.get(id)??{commandId:crypto.randomUUID(),inspectionId:id};inspectionStops.current.set(id,request);setBusy(true);setError('');
  try{await window.music.tagWriteInspectCancel(request);inspectionStops.current.delete(id);setNotice('已请求停止核对，等待进程退出。');setPage(await window.music.tagWriteJobs());}catch(e){setError(`${String(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}
 }
 async function stageJob(id:string,revision:number,stop=false):Promise<void> {
  if(busy||attempt.current)return;const key=`${stop?'stop':'start'}:${id}`,request=stageAttempts.current.get(key)??{commandId:crypto.randomUUID(),jobId:id,baseRevision:revision};stageAttempts.current.set(key,request);setBusy(true);setError('');
  try{const result=await (stop?window.music.tagWriteStageCancel(request):window.music.tagWriteStage(request));stageAttempts.current.delete(key);setNotice(stop?`${result.title}：已请求停止暂存，正在等待进程退出。`:`${result.title}：备份与暂存任务已启动，原文件不会被替换。`);setPage(await window.music.tagWriteJobs());}
  catch(e){setError(`${String(e)}。请确认原操作结果，避免再次创建暂存工件。`);}finally{setBusy(false);}
 }
 const locked=busy||loading||stale||!context?.eligible||Boolean(attempt.current);
 return <div className="collection-backdrop"><div ref={dialog} className="catalog-dialog collection-dialog tag-write-dialog" role="dialog" aria-modal="true" aria-label="编辑文件标签预览" onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>文件标签预览</h2><button disabled={busy} aria-label="关闭文件标签预览" onClick={onClose}>×</button></header>
  <p className="collection-note">先核对原标签与修改内容，再保存待写入任务。当前可准备独立 FLAC 文件；文件写入组件和格式校验开放前，歌曲文件不会被修改。</p>
  {loading&&<p role="status">正在读取歌曲资料与任务…</p>}
  {context&&<><h3>{context.title}</h3>{context.reason&&<p role="status" className="collection-error">{context.reason}</p>}
   <div className="tag-write-fields">{context.fields.map(f=>{const e=edits[f.field]??{enabled:false,origin:'manual',text:'',clear:false};return <section key={f.field}>
    <label className="tag-write-field-toggle"><input type="checkbox" checked={e.enabled} disabled={locked} onChange={event=>edit(f.field,{enabled:event.target.checked})}/><strong>{TAG_FIELD_LABELS[f.field]}</strong></label>
    {e.enabled&&<><label>输入方式<select value={e.origin} disabled={locked} onChange={event=>edit(f.field,{origin:event.target.value as Edit['origin'],clear:false})}><option value="manual">手工输入</option><option value="library" disabled={!f.libraryAllowed}>已允许写回的曲库值</option></select></label>
     {e.origin==='library'?<p className="tag-write-values">{f.values.join('\n')||'空值'}</p>:<><label><input type="checkbox" checked={e.clear} disabled={locked} onChange={event=>edit(f.field,{clear:event.target.checked})}/>清空此标签</label><label className="tag-write-text-label">修改后的值<textarea value={e.text} disabled={locked||e.clear} rows={2} maxLength={24576} placeholder="每行一个值；保留原有空格" onChange={event=>edit(f.field,{text:event.target.value})}/></label></>}
     <small>{f.reason}</small>
    </>}
   </section>;})}</div>
   {hasManual&&<label className="tag-write-confirm"><input type="checkbox" checked={manualConfirmed} disabled={locked} onChange={event=>{setManualConfirmed(event.target.checked);setPreview(null);setReviewed(false);}}/>我确认手工输入内容可用于这些本地文件标签</label>}
  </>}
  {preview&&<section className="tag-write-preview"><h3>文件标签差异</h3>{preview.preview.fields.map(f=><div className="tag-write-difference" key={f.field}><strong>{TAG_FIELD_LABELS[f.field]}{f.changed?'':'（无变化）'}</strong><div><span>原值</span><pre>{f.before.length?f.before.join('\n'):'无标签'}</pre></div><div><span>拟写入</span><pre>{f.values.length?f.values.join('\n'):'清空标签'}</pre></div></div>)}
   <p className="collection-note">原文件含 {preview.preview.pictureBlocks} 个图片块。适配器保留内嵌封面及未选择的元数据；音频完整性将在实际暂存和写入时另行校验。</p>
   {now>=preview.expiresAt&&!attempt.current&&<p className="collection-error">此预览已过期，请重新预览。</p>}
   <label className="tag-write-confirm"><input type="checkbox" checked={reviewed} disabled={busy||stale||Boolean(attempt.current)||!preview.preview.changed||now>=preview.expiresAt} onChange={event=>setReviewed(event.target.checked)}/>已核对差异，保存待写入任务</label>
  </section>}
  {stale&&!attempt.current&&<p role="alert" className="collection-error">歌曲资料或来源设置已变化，请重新读取后再预览。</p>}{error&&<p role="alert" className="collection-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <footer><button disabled={busy} onClick={onClose}>关闭</button><button disabled={busy||Boolean(attempt.current)} onClick={()=>setReload(n=>n+1)}>重新读取</button><button disabled={locked||!selected.length||hasManual&&!manualConfirmed} onClick={()=>void makePreview()}>预览标签差异</button><button className="primary-button" disabled={busy||!preview||!attempt.current&&(stale||!reviewed||!preview.preview.changed||now>=preview.expiresAt)} onClick={()=>void save()}>{busy?'正在处理…':attempt.current?'确认原保存结果':'保存待写入任务'}</button></footer>
  <section className="tag-write-jobs"><h3>最近的标签任务</h3><p className="collection-note">生成备份与临时文件时，会停止此文件的播放并等待读取组件退出。暂存不替换歌曲文件；取消或中断会保留已有工件，需核对后恢复。</p>{page?.jobs.length? page.jobs.map(job=><article key={job.id}>
   <div><strong>{job.title}</strong><span>{job.nativeRestore?(job.nativeRestoreReprobe?.state==='completed'?'原来源及曲库已恢复':{reserved:'等待恢复文件核对',running:'正在恢复原文件',native_restored:'原文件已核对，等待曲库恢复',recovery_required:'文件恢复中断，等待核对'}[job.nativeRestore.state]):job.nativeCommit?({reserved:'等待文件核对',running:'正在提交标签',native_verified:'文件已核对，等待曲库更新',recovery_required:'提交中断，等待恢复核对',committed:'标签及曲库已更新',reconciled:'目标及曲库已恢复'}[job.nativeCommit.state]):job.staging?.state==='staged'?'已备份并暂存':job.state==='running'?'正在备份与暂存':status[job.state]}</span></div>
   <small>{new Date(job.createdAt).toLocaleString()} · {job.preview.fields.map(f=>TAG_FIELD_LABELS[f.field]).join('、')}</small><p>{job.reason}</p>
   {!job.nativeCommit&&job.staging&&job.state==='running'&&<div className="tag-write-progress"><span>{phaseLabels[job.staging.phase]??job.staging.phase}</span><progress aria-label="当前暂存步骤进度" max={1} value={Number(job.staging.bytes)/Math.max(1,Number(job.staging.total))}/><small>{(Number(job.staging.bytes)/1048576).toFixed(1)} / {(Number(job.staging.total)/1048576).toFixed(1)} MiB</small></div>}
   {job.nativeRestore&&<TagRestoreRecovery key={job.nativeRestore.id} job={job} disabled={busy||Boolean(attempt.current)} onError={setError} onChange={async()=>setPage(await window.music.tagWriteJobs())}/>}{job.nativeRestore&&<p role="status">{job.nativeRestoreReprobe?.state==='completed'?'原恢复历史：':''}{job.nativeRestore.reason} · {job.nativeRestore.exitConfirmed?'原恢复进程已退出':'原恢复进程退出尚待确认'}。{job.nativeRestoreReprobe?.state==='completed'?'曲库已独立恢复，原历史及全部工件保留。':'恢复记录保留，完成后仍需重新核对和更新曲库。'}</p>}
   {job.nativeCommit&&<p role="status">{job.nativeRestore?'原提交历史：':''}{job.nativeCommit.reason} · {job.nativeCommit.state==='reconciled'?(job.nativeCommit.exitConfirmed?'历史记录：原提交进程已退出':'历史记录：原提交最终退出回执缺失'):job.nativeCommit.exitConfirmed?'文件进程已退出':'文件进程退出尚待确认'}</p>}
   {job.nativeCommit&&!job.nativeRestore&&<TagCommitRecovery key={job.nativeCommit.id} job={job} disabled={busy||Boolean(attempt.current)} onError={setError} onChange={async()=>setPage(await window.music.tagWriteJobs())}/>}
   <div className="tag-write-job-actions">
    {!job.nativeCommit&&job.state==='recovery_required'&&job.recoveryAction?.state!=='running'&&(job.recovery?.state!=='running'||inspectionAttempts.current.has(job.id))&&<button disabled={busy||Boolean(attempt.current)} onClick={()=>void inspectJob(job.id,job.revision)}>{inspectionAttempts.current.has(job.id)?'确认原核对请求':job.recovery?'重新核对实际文件':'核对原文件、备份与临时文件'}</button>}
    {!job.nativeCommit&&job.recovery&&(job.recovery.state==='running'||inspectionStops.current.has(job.recovery.id))&&<button disabled={busy||Boolean(attempt.current)} onClick={()=>void stopInspection(job.recovery!.id)}>{inspectionStops.current.has(job.recovery.id)?'确认原停止核对请求':'停止文件核对'}</button>}
    {stageAttempts.current.has(`start:${job.id}`)?<button disabled={busy} onClick={()=>void stageJob(job.id,job.revision)}>确认原暂存请求</button>:job.state==='prepared'&&!job.staging&&<button disabled={busy||Boolean(attempt.current)} onClick={()=>void stageJob(job.id,job.revision)}>生成备份与临时文件</button>}
    {!job.nativeCommit&&(job.state==='running'||stageAttempts.current.has(`stop:${job.id}`))&&<button disabled={busy||Boolean(attempt.current)} onClick={()=>void stageJob(job.id,job.revision,true)}>{stageAttempts.current.has(`stop:${job.id}`)?'确认原停止请求':'停止暂存并保留工件'}</button>}
    {job.state==='prepared'&&<button disabled={busy||Boolean(attempt.current)} onClick={()=>void cancelJob(job.id,job.revision)}>{cancelAttempts.current.has(job.id)?'确认原取消结果':job.staging?'取消待写入任务并保留工件':'取消待写入任务'}</button>}
   </div>
   {job.recovery&&<TagRecoveryResult value={job.recovery} resolved={job.state==='cancelled'&&job.recoveryAction?.state==='completed'}/>}
   {!job.nativeCommit&&job.recovery&&<TagRecoveryActions key={`${job.id}:${job.recovery.id}`} job={job} disabled={busy||Boolean(attempt.current)} onError={setError} onChange={async()=>setPage(await window.music.tagWriteJobs())}/>}
  </article>):<p>尚无标签任务。</p>}
   {page?.nextCursor&&<button disabled={busy} onClick={()=>{setBusy(true);void window.music.tagWriteJobs(page.nextCursor!).then(setPage).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>查看更早的任务</button>}<button disabled={busy} onClick={()=>{void window.music.tagWriteJobs().then(setPage).catch(e=>setError(String(e)));}}>刷新最近任务</button>
  </section>
 </div></div>;
}
