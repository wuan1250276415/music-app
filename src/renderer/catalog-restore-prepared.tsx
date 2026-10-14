import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {readRestoreRendererRequest,readRestoreRendererReply,type RestoreRendererRequest,type RestoreRendererReply} from '../shared/catalog-restore-renderer.js';
import {RELEASE} from '../shared/release.js';
import {captureRendererBackupPending} from './catalog-backup-pending.js';
import {catalogBackupClient} from './catalog-backup-client.js';
import './catalog-backup.css';
import {readRestoreAppRequest,restoreAppQueue,type RestoreAppRequest} from '../shared/catalog-restore-application.js';
import {restoreDocumentId as documentId,restoreWebDigest as sha,assertRestoreDocumentHeld} from './catalog-restore-document.js';

function held(request:RestoreRendererRequest):void{assertRestoreDocumentHeld(request.operationId);}
async function prepareReply(request:RestoreRendererRequest,root:HTMLElement):Promise<RestoreRendererReply>{
 const requestSha256=await sha(request),base={version:1 as const,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,documentToken:request.documentToken,documentEpoch:request.documentEpoch,documentId,appVersion:RELEASE.appVersion,requestSha256};
 try{
  held(request);if(RELEASE.appVersion!==request.appVersion||root.dataset.restoreDocument!==documentId||document.querySelector('.player-bar')||document.querySelector('.catalog-backup-app'))throw new Error('新界面版本或恢复视图未确认');
  const snapshotSha256=await sha(request.snapshot),before=captureRendererBackupPending(),pendingValuesSha256=await sha(before.values);
  if(snapshotSha256!==request.snapshotSha256||pendingValuesSha256!==request.pendingValuesSha256)throw new Error('恢复界面状态或待保存资料与原结果不同');
  await new Promise<void>(resolve=>setTimeout(resolve,0));held(request);
  if(!root.isConnected||root.dataset.restoreDocument!==documentId||JSON.stringify(captureRendererBackupPending().values)!==JSON.stringify(before.values))throw new Error('恢复界面或待保存资料在准备期间变化');
  return readRestoreRendererReply({...base,snapshotSha256,pendingValuesSha256,prepared:true,error:''});
 }catch(error){return readRestoreRendererReply({...base,snapshotSha256:null,pendingValuesSha256:null,prepared:false,error:String(error instanceof Error?error.message:error).slice(0,1024)||'恢复界面准备无法确认'});}
}

// Booted in a fresh document after Main's persisted reload intention. The
// ordinary App is deliberately not constructed while its requests are frozen.
export function CatalogRestorePrepared({request:input,onApplication}:{request:RestoreRendererRequest;onApplication:(request:RestoreAppRequest)=>void}){
 const [request]=useState(()=>readRestoreRendererRequest(input)),[error,setError]=useState(''),[sent,setSent]=useState(false),ref=useRef<HTMLDivElement|null>(null),work=useRef<Promise<void>|null>(null);
 const client=useSyncExternalStore(catalogBackupClient.subscribe,catalogBackupClient.snapshot);
 const application=useRef<{identity:string;work:Promise<void>}|null>(null);
 useEffect(()=>{
  // Install the next-stage listener before acknowledging the fresh document.
  const unsubscribe=window.music.onEvent(event=>{
   if(event.event!=='catalogRestoreApplication')return;
   try{const next=readRestoreAppRequest(event.payload),identity=JSON.stringify(next);if(application.current){if(application.current.identity!==identity)throw new Error('恢复普通应用加载原挑战不能改变');return;}
    const pending=Promise.resolve().then(async()=>{held(request);if(next.operationId!==request.operationId||next.documentId!==documentId||next.documentToken!==request.documentToken||next.documentEpoch!==request.documentEpoch||next.appVersion!==request.appVersion||next.pendingValuesSha256!==request.pendingValuesSha256||next.queueSha256!==await sha(restoreAppQueue(request.snapshot.queue)))throw new Error('普通应用加载不是当前已准备的新文档');held(request);onApplication(next);});application.current={identity,work:pending};void pending.catch(error=>setError(String(error instanceof Error?error.message:error)));
   }catch(error){setError(String(error instanceof Error?error.message:error));}
  });
  if(ref.current&&!work.current){work.current=prepareReply(request,ref.current).then(async reply=>{await window.music.catalogRestoreRendererReply(reply);if(reply.error)throw new Error(reply.error);setSent(true);}).catch(e=>{setError(String(e instanceof Error?e.message:e));});}
  return unsubscribe;
 },[request,onApplication]);
 return <main className="catalog-backup-overlay"><div className="catalog-backup-dialog" ref={ref} data-restore-document={documentId} role="status" aria-live="polite">
  <h1>恢复界面已准备</h1><p>原界面已关闭，新界面正在核对恢复后的资料。完成前，播放和界面操作继续暂停。</p>
  <dl><dt>播放列表</dt><dd>{request.snapshot.queue.entries.length} 首</dd><dt>播放模式</dt><dd>{request.snapshot.queue.shuffle?'随机播放':'顺序播放'} · {{off:'不循环',one:'单曲循环',all:'列表循环'}[request.snapshot.queue.repeat]}</dd><dt>输出方式</dt><dd>{request.snapshot.audioBackend.backend==='asio'?'ASIO':'WASAPI'}</dd></dl>
  <p>{error||client.state.phase==='failed'?'界面准备尚未获得完整确认，原资料继续保留。':sent?'界面状态已核对，等待恢复完成。':'正在核对界面状态…'}</p>
  {(error||client.state.phase==='failed')&&<><p role="alert">{error||client.state.message}</p><button onClick={()=>void window.music.quitCatalogBackup()}>退出应用</button></>}
 </div></main>;
}
