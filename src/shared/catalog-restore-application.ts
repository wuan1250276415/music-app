import {backupUuid} from './catalog-backup.js';
import {restoreTransactionFields as fields,restoreTransactionDigest as digest,restoreTransactionCount} from './catalog-restore-transaction.js';
import {validQueueState} from './queue-state.js';
import {readBrowseQuery,type BrowseQuery} from './library-browse.js';
import type {PlaybackState,QueueState,QueueView,LibraryStats,PlaylistSummary} from './contracts.js';
import type {RestoreRendererIntent} from './catalog-restore-renderer.js';

export const RESTORE_APP_READ_KEYS=['playback','queue','stats','roots','playlists','browse'] as const;
export type RestoreAppReadKey=typeof RESTORE_APP_READ_KEYS[number];
export type RestoreAppReads=Record<RestoreAppReadKey,string>;
export type RestoreAppData={playback:PlaybackState;queue:QueueView;stats:LibraryStats;roots:Array<{id:string;path:string;status:string}>;playlists:PlaylistSummary[];browse:{query:BrowseQuery;snapshot:string;total:number}};
export type RestoreAppRequest={version:1;operationId:string;completionId:string;challenge:string;documentId:string;documentToken:string;documentEpoch:number;appVersion:string;mainReleaseSha256:string;rendererReadySha256:string;queueSha256:string;pendingValuesSha256:string};
export type RestoreAppReply={version:1;operationId:string;completionId:string;challenge:string;documentId:string;documentToken:string;documentEpoch:number;appVersion:string;requestSha256:string;reads:RestoreAppReads|null;queueSha256:string|null;pendingValuesSha256:string|null;applicationMounted:boolean;userGateHeld:boolean;error:string};
export type RestoreAppReady={reply:RestoreAppReply;navigation:{webContentsId:number;documentEpoch:number;url:string};readsObserved:true};

// QueueView adds items. Normalize only the nine queue fields and entry key order
// so original JSON property order cannot alter a state comparison.
export function restoreAppQueue(value:unknown):QueueState{
 if(!validQueueState(value))throw new Error('恢复应用播放队列无效');return {entries:value.entries.map(entry=>({id:entry.id,itemId:entry.itemId,...(entry.playlistEntryId===undefined?{}:{playlistEntryId:entry.playlistEntryId})})),currentEntryId:value.currentEntryId,repeat:value.repeat,shuffle:value.shuffle,order:[...value.order],orderCursor:value.orderCursor,history:[...value.history],historyCursor:value.historyCursor,revision:value.revision};
}
export function restoreAppBrowse(query:unknown,snapshot:unknown,total:unknown):RestoreAppData['browse']{return {query:readBrowseQuery(query),snapshot:digest(snapshot),total:restoreTransactionCount(total,1_000_000_000)};}
export function readRestoreAppRequest(value:unknown):RestoreAppRequest{
 const v=fields(value,['version','operationId','completionId','challenge','documentId','documentToken','documentEpoch','appVersion','mainReleaseSha256','rendererReadySha256','queueSha256','pendingValuesSha256']),documentEpoch=restoreTransactionCount(v.documentEpoch,Number.MAX_SAFE_INTEGER);if(v.version!==1||!documentEpoch||typeof v.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(v.appVersion))throw new Error('恢复应用加载请求无效');
 return {version:1,operationId:backupUuid(v.operationId),completionId:backupUuid(v.completionId),challenge:backupUuid(v.challenge),documentId:backupUuid(v.documentId),documentToken:backupUuid(v.documentToken),documentEpoch,appVersion:v.appVersion,mainReleaseSha256:digest(v.mainReleaseSha256),rendererReadySha256:digest(v.rendererReadySha256),queueSha256:digest(v.queueSha256),pendingValuesSha256:digest(v.pendingValuesSha256)};
}
export function readRestoreAppReply(value:unknown):RestoreAppReply{
 const v=fields(value,['version','operationId','completionId','challenge','documentId','documentToken','documentEpoch','appVersion','requestSha256','reads','queueSha256','pendingValuesSha256','applicationMounted','userGateHeld','error']);if(v.version!==1||typeof v.applicationMounted!=='boolean'||typeof v.userGateHeld!=='boolean'||typeof v.appVersion!=='string'||!/^\d+\.\d+\.\d+$/.test(v.appVersion)||typeof v.error!=='string'||v.error.length>1024||v.error.includes('\0')||v.applicationMounted!==!Boolean(v.error)||v.applicationMounted&&(!v.userGateHeld||v.reads===null||v.queueSha256===null||v.pendingValuesSha256===null)||!v.applicationMounted&&(v.reads!==null||v.queueSha256!==null||v.pendingValuesSha256!==null))throw new Error('恢复应用加载回执无效');
 let reads:RestoreAppReads|null=null;if(v.reads!==null){const r=fields(v.reads,[...RESTORE_APP_READ_KEYS]);reads=Object.fromEntries(RESTORE_APP_READ_KEYS.map(key=>[key,digest(r[key])])) as RestoreAppReads;}
 return {version:1,operationId:backupUuid(v.operationId),completionId:backupUuid(v.completionId),challenge:backupUuid(v.challenge),documentId:backupUuid(v.documentId),documentToken:backupUuid(v.documentToken),documentEpoch:restoreTransactionCount(v.documentEpoch,Number.MAX_SAFE_INTEGER),appVersion:v.appVersion,requestSha256:digest(v.requestSha256),reads,queueSha256:v.queueSha256===null?null:digest(v.queueSha256),pendingValuesSha256:v.pendingValuesSha256===null?null:digest(v.pendingValuesSha256),applicationMounted:v.applicationMounted,userGateHeld:v.userGateHeld,error:v.error};
}
export function readRestoreAppReady(value:unknown,request:RestoreAppRequest,requestSha256:string,renderer:RestoreRendererIntent):RestoreAppReady{
 const v=fields(value,['reply','navigation','readsObserved']),reply=readRestoreAppReply(v.reply),n=fields(v.navigation,['webContentsId','documentEpoch','url']);if(!reply.applicationMounted||!reply.userGateHeld||reply.error||reply.operationId!==request.operationId||reply.completionId!==request.completionId||reply.challenge!==request.challenge||reply.documentId!==request.documentId||reply.documentToken!==request.documentToken||reply.documentEpoch!==request.documentEpoch||reply.appVersion!==request.appVersion||reply.requestSha256!==digest(requestSha256)||reply.queueSha256!==request.queueSha256||reply.pendingValuesSha256!==request.pendingValuesSha256||n.webContentsId!==renderer.webContentsId||n.documentEpoch!==request.documentEpoch||n.url!==renderer.url||v.readsObserved!==true)throw new Error('恢复应用就绪证明与当前原文档或资料不同');
 return {reply,navigation:{webContentsId:renderer.webContentsId,documentEpoch:request.documentEpoch,url:renderer.url},readsObserved:true};
}
