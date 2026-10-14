import {backupUuid} from './catalog-backup.js';
import {restoreTransactionFields as fields,restoreTransactionDigest as digest,restoreTransactionCount} from './catalog-restore-transaction.js';
import type {RestoreAppRequest,RestoreAppReady} from './catalog-restore-application.js';

export type RestoreFinalRequest={version:1;operationId:string;completionId:string;challenge:string;documentId:string;documentToken:string;documentEpoch:number;appVersion:string;applicationReadySha256:string;applicationReplySha256:string;pendingValuesSha256:string};
export type RestoreFinalReply={version:1;operationId:string;completionId:string;challenge:string;documentId:string;documentToken:string;documentEpoch:number;appVersion:string;requestSha256:string;applicationReplySha256:string|null;pendingValuesSha256:string|null;applicationMounted:boolean;userGateHeld:boolean;error:string};
export const RESTORE_FINAL_MAIN_KEYS=['displayReadsDrained','ordinaryGateReleased','playbackMaintenanceReleased','historyMaintenanceReleased','historyTimerPaused','inputBarrierHeld','playbackStopped'] as const;
export type RestoreFinalProof={requestSha256:string;reply:RestoreFinalReply;main:Record<typeof RESTORE_FINAL_MAIN_KEYS[number],true>;historyPendingSha256:string};

function document(v:Record<string,unknown>){const documentEpoch=restoreTransactionCount(v.documentEpoch,Number.MAX_SAFE_INTEGER);if(v.version!==1||!documentEpoch||typeof v.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(v.appVersion))throw new Error('恢复最终准备文档无效');return {version:1 as const,operationId:backupUuid(v.operationId),completionId:backupUuid(v.completionId),challenge:backupUuid(v.challenge),documentId:backupUuid(v.documentId),documentToken:backupUuid(v.documentToken),documentEpoch,appVersion:v.appVersion};}
export function readRestoreFinalRequest(value:unknown):RestoreFinalRequest{
 const v=fields(value,['version','operationId','completionId','challenge','documentId','documentToken','documentEpoch','appVersion','applicationReadySha256','applicationReplySha256','pendingValuesSha256']);return {...document(v),applicationReadySha256:digest(v.applicationReadySha256),applicationReplySha256:digest(v.applicationReplySha256),pendingValuesSha256:digest(v.pendingValuesSha256)};
}
export function readRestoreFinalReply(value:unknown):RestoreFinalReply{
 const v=fields(value,['version','operationId','completionId','challenge','documentId','documentToken','documentEpoch','appVersion','requestSha256','applicationReplySha256','pendingValuesSha256','applicationMounted','userGateHeld','error']);
 if(typeof v.error!=='string'||v.error.length>1024||v.error.includes('\0')||typeof v.applicationMounted!=='boolean'||typeof v.userGateHeld!=='boolean'||v.applicationMounted!==!Boolean(v.error)||v.applicationMounted&&(!v.userGateHeld||v.applicationReplySha256===null||v.pendingValuesSha256===null)||!v.applicationMounted&&(v.applicationReplySha256!==null||v.pendingValuesSha256!==null))throw new Error('恢复最终文档确认无效');
 return {...document(v),requestSha256:digest(v.requestSha256),applicationReplySha256:v.applicationReplySha256===null?null:digest(v.applicationReplySha256),pendingValuesSha256:v.pendingValuesSha256===null?null:digest(v.pendingValuesSha256),applicationMounted:v.applicationMounted,userGateHeld:v.userGateHeld,error:v.error};
}
export function bindRestoreFinalRequest(request:RestoreFinalRequest,app:RestoreAppRequest,ready:RestoreAppReady,readySha256:string,replySha256:string):void{
 if(request.operationId!==app.operationId||request.completionId!==app.completionId||request.documentId!==app.documentId||request.documentToken!==app.documentToken||request.documentEpoch!==app.documentEpoch||request.appVersion!==app.appVersion||request.applicationReadySha256!==digest(readySha256)||request.applicationReplySha256!==digest(replySha256)||request.pendingValuesSha256!==ready.reply.pendingValuesSha256)throw new Error('恢复最终意图与原实际应用证明不同');
}
export function bindRestoreFinalReply(reply:RestoreFinalReply,request:RestoreFinalRequest,requestSha256:string):void{
 if(reply.operationId!==request.operationId||reply.completionId!==request.completionId||reply.challenge!==request.challenge||reply.documentId!==request.documentId||reply.documentToken!==request.documentToken||reply.documentEpoch!==request.documentEpoch||reply.appVersion!==request.appVersion||reply.requestSha256!==digest(requestSha256))throw new Error('恢复最终文档回执与原挑战不同');
 if(!reply.error&&(reply.applicationReplySha256!==request.applicationReplySha256||reply.pendingValuesSha256!==request.pendingValuesSha256))throw new Error('恢复最终文档资料与原应用证明不同');
}
export function readRestoreFinalProof(value:unknown,request:RestoreFinalRequest,requestSha256:string,historySha256:string):RestoreFinalProof{
 const v=fields(value,['requestSha256','reply','main','historyPendingSha256']),reply=readRestoreFinalReply(v.reply),main=fields(v.main,[...RESTORE_FINAL_MAIN_KEYS]);bindRestoreFinalReply(reply,request,requestSha256);
 if(v.requestSha256!==requestSha256||reply.error||!reply.applicationMounted||!reply.userGateHeld||RESTORE_FINAL_MAIN_KEYS.some(key=>main[key]!==true)||v.historyPendingSha256!==digest(historySha256))throw new Error('恢复最终资源证明未确认原资料及独立交互占用');
 return {requestSha256:digest(v.requestSha256),reply,main:Object.fromEntries(RESTORE_FINAL_MAIN_KEYS.map(key=>[key,true])) as RestoreFinalProof['main'],historyPendingSha256:digest(v.historyPendingSha256)};
}
