import {readRestoreFinalRequest,readRestoreFinalReply,type RestoreFinalReply} from '../shared/catalog-restore-finalization.js';
import type {RestoreAppRequest,RestoreAppReply} from '../shared/catalog-restore-application.js';
import {assertRestoreDocumentHeld,restoreDocumentId,restoreWebDigest} from './catalog-restore-document.js';
import {captureRendererBackupPending} from './catalog-backup-pending.js';
import {RELEASE} from '../shared/release.js';

export async function confirmRestoreFinalDocument(value:unknown,app:RestoreAppRequest,reply:RestoreAppReply|null,root:HTMLDivElement|null):Promise<RestoreFinalReply>{
 const request=readRestoreFinalRequest(value),base={version:1 as const,operationId:request.operationId,completionId:request.completionId,challenge:request.challenge,documentId:restoreDocumentId,documentToken:request.documentToken,documentEpoch:request.documentEpoch,appVersion:RELEASE.appVersion,requestSha256:await restoreWebDigest(request)};
 try{
  assertRestoreDocumentHeld(request.operationId);const boundary=root?.closest<HTMLElement>('.catalog-backup-app');
  if(request.operationId!==app.operationId||request.completionId!==app.completionId||request.documentId!==restoreDocumentId||request.documentId!==app.documentId||request.documentToken!==app.documentToken||request.documentEpoch!==app.documentEpoch||request.appVersion!==app.appVersion||request.appVersion!==RELEASE.appVersion||!reply?.applicationMounted||reply.error||!root?.isConnected||root.dataset.restoreApplication!==restoreDocumentId||!root.querySelector('.player-bar')||!boundary?.inert)throw new Error('恢复最终确认不是原正常应用或暂停文档');
  const applicationReplySha256=await restoreWebDigest(reply),before=captureRendererBackupPending().values,pendingValuesSha256=await restoreWebDigest(before);
  if(applicationReplySha256!==request.applicationReplySha256||pendingValuesSha256!==request.pendingValuesSha256||pendingValuesSha256!==app.pendingValuesSha256)throw new Error('恢复最终应用证明或待保存资料不同');
  await new Promise<void>(resolve=>setTimeout(resolve,0));assertRestoreDocumentHeld(request.operationId);
  if(!root.isConnected||!root.querySelector('.player-bar')||!boundary.inert||JSON.stringify(captureRendererBackupPending().values)!==JSON.stringify(before))throw new Error('恢复最终文档或待保存资料在确认期间变化');
  return readRestoreFinalReply({...base,applicationReplySha256,pendingValuesSha256,applicationMounted:true,userGateHeld:true,error:''});
 }catch(error){return readRestoreFinalReply({...base,applicationReplySha256:null,pendingValuesSha256:null,applicationMounted:false,userGateHeld:true,error:String(error instanceof Error?error.message:error).slice(0,1024)||'恢复最终文档状态无法确认'});}
}
