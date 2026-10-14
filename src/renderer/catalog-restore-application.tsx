import {useEffect,useRef,useState,type ReactNode} from 'react';
import {RESTORE_APP_READ_KEYS,readRestoreAppRequest,readRestoreAppReply,restoreAppQueue,type RestoreAppRequest,type RestoreAppData,type RestoreAppReads,type RestoreAppReply} from '../shared/catalog-restore-application.js';
import {restoreDocumentId,restoreWebDigest,assertRestoreDocumentHeld} from './catalog-restore-document.js';
import {captureRendererBackupPending} from './catalog-backup-pending.js';
import {CatalogBackupBoundary} from './catalog-backup-boundary.js';
import {confirmRestoreFinalDocument} from './catalog-restore-finalization.js';
import {RELEASE} from '../shared/release.js';

export function CatalogRestoreApplication({request:input,renderApplication}:{request:RestoreAppRequest;renderApplication:(ready:(data:RestoreAppData)=>void,failed:(error:unknown)=>void)=>ReactNode}){
 const [request]=useState(()=>readRestoreAppRequest(input)),ref=useRef<HTMLDivElement|null>(null),work=useRef<Promise<void>|null>(null),[error,setError]=useState('');
 const appReply=useRef<RestoreAppReply|null>(null),finalWork=useRef<{identity:string;work:Promise<void>}|null>(null);
 useEffect(()=>window.music.onEvent(event=>{
  if(event.event!=='catalogRestoreFinalization')return;
  const identity=JSON.stringify(event.payload);if(finalWork.current){if(finalWork.current.identity!==identity)setError('恢复最终挑战已改变，交互继续暂停');return;}
  const work=confirmRestoreFinalDocument(event.payload,request,appReply.current,ref.current).then(async reply=>{await window.music.catalogRestoreFinalizationReply(reply);if(reply.error)throw new Error(reply.error);}).catch(error=>setError(String(error instanceof Error?error.message:error)));
  finalWork.current={identity,work};
 }),[request]);
 async function send(data:RestoreAppData|null,cause:unknown=null):Promise<void>{
  const base={version:1 as const,operationId:request.operationId,completionId:request.completionId,challenge:request.challenge,documentId:restoreDocumentId,documentToken:request.documentToken,documentEpoch:request.documentEpoch,appVersion:RELEASE.appVersion,requestSha256:await restoreWebDigest(request)};
  let reply;
  try{
   if(cause)throw cause;if(!data)throw new Error('恢复应用缺少实际读取资料');assertRestoreDocumentHeld(request.operationId);const root=ref.current,boundary=root?.closest<HTMLElement>('.catalog-backup-app');
   if(!root?.isConnected||root.dataset.restoreApplication!==restoreDocumentId||!root.querySelector('.player-bar')||!boundary?.inert||request.documentId!==restoreDocumentId||request.appVersion!==RELEASE.appVersion)throw new Error('恢复后的普通应用或暂停交互状态没有获得确认');
   const queueSha256=await restoreWebDigest(restoreAppQueue(data.queue)),before=captureRendererBackupPending(),pendingValuesSha256=await restoreWebDigest(before.values),reads=Object.fromEntries(await Promise.all(RESTORE_APP_READ_KEYS.map(async key=>[key,await restoreWebDigest(data[key])]))) as RestoreAppReads;
   if(queueSha256!==request.queueSha256||pendingValuesSha256!==request.pendingValuesSha256)throw new Error('普通应用实际队列或待保存资料不同');
   await new Promise<void>(resolve=>setTimeout(resolve,0));assertRestoreDocumentHeld(request.operationId);
   if(!root.isConnected||ref.current!==root||!boundary.inert||JSON.stringify(captureRendererBackupPending().values)!==JSON.stringify(before.values))throw new Error('普通应用文档或待保存资料在确认期间变化');
   reply=readRestoreAppReply({...base,reads,queueSha256,pendingValuesSha256,applicationMounted:true,userGateHeld:true,error:''});
  }catch(error){reply=readRestoreAppReply({...base,reads:null,queueSha256:null,pendingValuesSha256:null,applicationMounted:false,userGateHeld:true,error:String(error instanceof Error?error.message:error).slice(0,1024)||'恢复应用读取或加载无法确认'});}
  appReply.current=reply;await window.music.catalogRestoreApplicationReply(reply);if(reply.error)throw new Error(reply.error);
 }
 const start=(data:RestoreAppData|null,cause:unknown=null)=>{if(work.current)return;work.current=send(data,cause).catch(error=>setError(String(error instanceof Error?error.message:error)));};
 return <CatalogBackupBoundary><div ref={ref} data-restore-application={restoreDocumentId} style={{display:'contents'}}>{renderApplication(data=>start(data),error=>start(null,error))}{error&&<p role="alert">{error}</p>}</div></CatalogBackupBoundary>;
}
