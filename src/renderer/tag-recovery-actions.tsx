import React,{useRef,useState} from 'react';
import type {TagWriteJob} from '../shared/tag-write-ui';
import type {TagRecoveryActionRequest,TagRecoveryActionCancelRequest} from '../shared/tag-recovery';

const scanLabels={'directory-changed':'授权目录已变化，请核对目录设置；不会改扫其他位置',waiting:'等待目录中的其他扫描结束',queued:'已安排重新扫描',running:'正在重新扫描',cancelling:'扫描正在停止',succeeded:'扫描已完成',failed:'扫描失败，请在扫描任务中处理',cancelled:'扫描已取消',interrupted:'扫描中断，请在扫描任务中处理','file-unavailable':'扫描完成，当前文件仍不可用','file-ready':'文件已重新解析，可正常使用'};
export function TagRecoveryActions({job,disabled,onChange,onError}:{job:TagWriteJob;disabled:boolean;onChange:()=>Promise<void>;onError:(message:string)=>void}):React.JSX.Element {
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false);
 const attempts=useRef(new Map<TagRecoveryActionRequest['action'],TagRecoveryActionRequest>()),stop=useRef<TagRecoveryActionCancelRequest|null>(null);
 const recovery=job.recovery,report=recovery?.report,current=report?.actual.files[0],active=job.recoveryAction;
 const eligible=job.state==='recovery_required'&&recovery?.state==='completed'&&recovery.exitConfirmed&&current?.state==='present'&&Boolean(current.flac)&&active?.state!=='running';
 const unchanged=eligible&&Boolean(report&&['unchanged','staged'].includes(report.classification)&&['matched','fs-ahead'].includes(report.journal));
 async function resolve(action:TagRecoveryActionRequest['action']):Promise<void> {
  if(busy||disabled||!recovery||!attempts.current.has(action)&&(!eligible||!confirmed))return;
  const request=attempts.current.get(action)??{commandId:crypto.randomUUID(),jobId:job.id,baseRevision:job.revision,inspectionId:recovery.id,action,confirmed:true};attempts.current.set(action,request);setBusy(true);onError('');
  try{await window.music.tagWriteRecover(request);attempts.current.delete(action);setConfirmed(false);await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原处理请求。`);}finally{setBusy(false);}
 }
 async function cancel():Promise<void> {
  if(busy||disabled||!active)return;stop.current??={commandId:crypto.randomUUID(),actionId:active.id};setBusy(true);onError('');
  try{await window.music.tagWriteRecoverCancel(stop.current);stop.current=null;await onChange();}catch(e){onError(`${String(e)}。再次点击将查询或重试原停止请求。`);}finally{setBusy(false);}
 }
 return <section className="tag-recovery-result" aria-label="恢复处理">
  {active&&<><h4>{active.state==='running'?'正在重新核对文件':active.state==='completed'?'当前文件已保留，标签任务已取消':active.state==='interrupted'?'恢复处理中断':active.state==='cancelled'?'恢复处理已停止':'恢复处理未完成'}</h4><p role="status">{active.reason}</p>
   {active.state==='running'&&<div className="tag-write-progress"><progress aria-label="恢复处理核对进度" max={1} value={Number(active.bytes)/Math.max(1,Number(active.total))}/><small>{(Number(active.bytes)/1048576).toFixed(1)} / {(Number(active.total)/1048576).toFixed(1)} MiB</small></div>}
   {active.scan&&<p role="status">{scanLabels[active.scan.state]}</p>}
   {(active.state==='running'||stop.current)&&<button disabled={busy||disabled} onClick={()=>void cancel()}>{stop.current?'确认原停止请求':'停止重新核对'}</button>}
  </>}
  {eligible&&<><h4>保留当前文件并取消标签任务</h4><p>处理前会重新读取文件。备份和临时文件保留；曲目须重新扫描成功后才能使用。</p><label className="tag-write-confirm"><input type="checkbox" checked={confirmed} disabled={busy||disabled||attempts.current.size>0} onChange={event=>setConfirmed(event.target.checked)}/>我确认保留当前原文件并取消标签任务；选择“保留当前文件”不代表已证明旧音频内容一致</label></>}
  <div className="tag-write-job-actions">
   {(unchanged||attempts.current.has('cancel-unchanged'))&&<button disabled={busy||disabled||!attempts.current.has('cancel-unchanged')&&!confirmed} onClick={()=>void resolve('cancel-unchanged')}>{attempts.current.has('cancel-unchanged')?'确认原取消并重扫请求':'原文件一致，取消任务并重扫'}</button>}
   {(eligible||attempts.current.has('keep-current'))&&<button disabled={busy||disabled||!attempts.current.has('keep-current')&&!confirmed} onClick={()=>void resolve('keep-current')}>{attempts.current.has('keep-current')?'确认原保留文件请求':'保留当前文件并重新扫描'}</button>}
  </div>
 </section>;
}
