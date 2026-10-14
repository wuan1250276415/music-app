import {useEffect,useRef,useState} from 'react';
import type {CatalogRestoreReview} from '../shared/catalog-restore-review';
import type {CatalogRestoreApplyState,RestoreApplyRequest} from '../shared/catalog-restore-consent';
import {restoreApplyActive} from '../shared/catalog-restore-consent';
import {restoreWebDigest} from './catalog-restore-document';
export function CatalogRestoreConfirm({review,state,onStart}:{review:CatalogRestoreReview;state:CatalogRestoreApplyState;onStart:(request:RestoreApplyRequest)=>Promise<void>}){
 const [replace,setReplace]=useState(false),[access,setAccess]=useState(false),[pending,setPending]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState('');
 const request=useRef<RestoreApplyRequest|null>(null),current=useRef(review),mounted=useRef(true);current.current=review;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{setReplace(false);setAccess(false);setPending(false);setError('');request.current=null;},[review.checkSha256]);
 const active=restoreApplyActive(state),submit=async()=>{
  if(sending||active||!replace||!access||!pending)return;const expected=review;setSending(true);setError('');
  try{const reviewSha256=await restoreWebDigest(expected);if(!mounted.current||current.current!==expected)return;
   request.current??={version:1,transactionId:crypto.randomUUID(),sourceId:expected.preview.operationId,reviewSha256,replaceLibrary:true,confirmAccessReset:true,keepPendingForReview:true};await onStart(request.current);
  }catch(error){if(mounted.current)setError(String(error));}finally{if(mounted.current)setSending(false);}
 };
 return <section className="catalog-backup-history" aria-labelledby="catalog-restore-confirm-title"><h3 id="catalog-restore-confirm-title">确认恢复</h3>
  <p>恢复将以“{review.preview.name}”中的资料替换当前曲库。当前曲库会建立一致快照并保留。</p>
  <fieldset disabled={active||sending} className="catalog-restore-confirm-options"><legend>请确认本次处理方式</legend>
   <label><input type="checkbox" checked={replace} onChange={event=>setReplace(event.target.checked)}/>用此备份替换当前曲库，并保留当前曲库和恢复记录</label>
   <label><input type="checkbox" checked={access} onChange={event=>setAccess(event.target.checked)}/>恢复后停止播放，重新确认音乐目录、自动更新和在线登录设置</label>
   <label><input type="checkbox" checked={pending} onChange={event=>setPending(event.target.checked)}/>待处理资料和旧任务保留供审核，不自动继续原操作</label>
  </fieldset>
  {error&&<p role="alert">{error}</p>}<div className="catalog-backup-actions"><button disabled={sending||active||!replace||!access||!pending} onClick={()=>void submit()}>{sending?'正在提交确认…':'恢复此备份'}</button></div>
 </section>;
}
