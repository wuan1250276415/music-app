import {backupUuid} from './catalog-backup.js';
import {restoreTransactionFields as fields,restoreTransactionDigest,restoreTransactionCount} from './catalog-restore-transaction.js';
import {readRestoreStateSnapshot,type RestoreStateSnapshot} from './catalog-restore-state.js';

export type RestoreRendererRequest={version:1;operationId:string;activationId:string;challenge:string;documentToken:string;documentEpoch:number;appVersion:string;hydrationSha256:string;snapshot:RestoreStateSnapshot;snapshotSha256:string;pendingValuesSha256:string};
export type RestoreRendererIntent={request:RestoreRendererRequest;webContentsId:number;previousEpoch:number;url:string};
export type RestoreRendererReply={version:1;operationId:string;activationId:string;challenge:string;documentToken:string;documentEpoch:number;documentId:string;appVersion:string;requestSha256:string;snapshotSha256:string|null;pendingValuesSha256:string|null;prepared:boolean;error:string};
export type RestoreRendererReady={reply:RestoreRendererReply;navigation:{webContentsId:number;documentEpoch:number;url:string;crossDocument:true}};
export function readRestoreRendererRequest(value:unknown):RestoreRendererRequest{
 const v=fields(value,['version','operationId','activationId','challenge','documentToken','documentEpoch','appVersion','hydrationSha256','snapshot','snapshotSha256','pendingValuesSha256']);if(v.version!==1||typeof v.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(v.appVersion))throw new Error('恢复界面准备请求无效');const documentEpoch=restoreTransactionCount(v.documentEpoch,Number.MAX_SAFE_INTEGER);if(!documentEpoch)throw new Error('恢复界面文档代次无效');
 return {version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),documentToken:backupUuid(v.documentToken),documentEpoch,appVersion:v.appVersion,hydrationSha256:restoreTransactionDigest(v.hydrationSha256),snapshot:readRestoreStateSnapshot(v.snapshot),snapshotSha256:restoreTransactionDigest(v.snapshotSha256),pendingValuesSha256:restoreTransactionDigest(v.pendingValuesSha256)};
}
export function readRestoreRendererIntent(value:unknown):RestoreRendererIntent{
 const v=fields(value,['request','webContentsId','previousEpoch','url']),request=readRestoreRendererRequest(v.request),webContentsId=restoreTransactionCount(v.webContentsId,2147483647),previousEpoch=restoreTransactionCount(v.previousEpoch,Number.MAX_SAFE_INTEGER-1);
 if(!webContentsId||request.documentEpoch!==previousEpoch+1||typeof v.url!=='string'||v.url.length>131072||!v.url.startsWith('file:')||/[\u0000-\u001f]/.test(v.url))throw new Error('恢复界面重载登记无效');return {request,webContentsId,previousEpoch,url:v.url};
}
export function readRestoreRendererReply(value:unknown):RestoreRendererReply{
 const v=fields(value,['version','operationId','activationId','challenge','documentToken','documentEpoch','documentId','appVersion','requestSha256','snapshotSha256','pendingValuesSha256','prepared','error']);
 if(v.version!==1||typeof v.prepared!=='boolean'||typeof v.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(v.appVersion)||typeof v.error!=='string'||v.error.length>1024||v.error.includes('\0')||v.prepared!==!Boolean(v.error)||v.prepared&&(v.snapshotSha256===null||v.pendingValuesSha256===null)||!v.prepared&&(v.snapshotSha256!==null||v.pendingValuesSha256!==null))throw new Error('恢复界面准备回执无效');
 return {version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),documentToken:backupUuid(v.documentToken),documentEpoch:restoreTransactionCount(v.documentEpoch,Number.MAX_SAFE_INTEGER),documentId:backupUuid(v.documentId),appVersion:v.appVersion,requestSha256:restoreTransactionDigest(v.requestSha256),snapshotSha256:v.snapshotSha256===null?null:restoreTransactionDigest(v.snapshotSha256),pendingValuesSha256:v.pendingValuesSha256===null?null:restoreTransactionDigest(v.pendingValuesSha256),prepared:v.prepared,error:v.error};
}
export function readRestoreRendererReady(value:unknown,intent:RestoreRendererIntent):RestoreRendererReady{
 const v=fields(value,['reply','navigation']),reply=readRestoreRendererReply(v.reply),n=fields(v.navigation,['webContentsId','documentEpoch','url','crossDocument']);
 if(!reply.prepared||n.webContentsId!==intent.webContentsId||n.documentEpoch!==intent.request.documentEpoch||n.url!==intent.url||n.crossDocument!==true)throw new Error('恢复界面实际导航证明不同');return {reply,navigation:{webContentsId:intent.webContentsId,documentEpoch:intent.request.documentEpoch,url:intent.url,crossDocument:true}};
}
