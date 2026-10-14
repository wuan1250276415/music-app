import {backupUuid} from '../shared/catalog-backup.js';
import {readRestoreIdentity} from '../shared/catalog-restore.js';
import {restoreTransactionFields as fields,restoreTransactionDigest as digest,restoreTransactionCount} from '../shared/catalog-restore-transaction.js';
import {lifecycleDigest} from './catalog-library-lifecycle.js';
import {RELEASE} from '../shared/release.js';
import type {RestoreCommitSeal,RestoreServiceReadyProof} from './catalog-restore-commit.js';

// Resource release is a separate, durable stage. None of these records means
// the normal document is mounted or the application's input gate is open.
export type RestoreLibraryReleaseRequest={version:1;operationId:string;completionId:string;challenge:string;instanceId:string;token:string;libraryIdentity:string;sealSha256:string;readySha256:string;readyRecordSha256:string;resumeWatch:boolean};
export type RestoreLibraryReleaseProof={version:1;operationId:string;completionId:string;challenge:string;instanceId:string;pid:number;buildId:string;libraryIdentity:string;requestSha256:string;phase:'released';businessGateHeld:false;backgroundReleased:true;resumeWatch:boolean};
export type RestoreMainReleaseIntent={version:1;operationId:string;completionId:string;challenge:string;libraryReleaseSha256:string;resources:string[];resumeBackground:boolean};
export type RestoreMainReleaseProof={version:1;operationId:string;completionId:string;challenge:string;requestSha256:string;resourcesSha256:string;resourcesReleased:true;playbackHeld:true;historyHeld:true;userGateHeld:true};

export function readRestoreLibraryReleaseRequest(value:unknown,seal?:RestoreCommitSeal,ready?:RestoreServiceReadyProof,token?:string,readyRecordSha256?:string):RestoreLibraryReleaseRequest{
 const v=fields(value,['version','operationId','completionId','challenge','instanceId','token','libraryIdentity','sealSha256','readySha256','readyRecordSha256','resumeWatch']);if(v.version!==1||typeof v.resumeWatch!=='boolean')throw new Error('恢复曲库释放请求无效');
 const r:RestoreLibraryReleaseRequest={version:1,operationId:backupUuid(v.operationId),completionId:backupUuid(v.completionId),challenge:backupUuid(v.challenge),instanceId:backupUuid(v.instanceId),token:backupUuid(v.token),libraryIdentity:readRestoreIdentity(v.libraryIdentity),sealSha256:digest(v.sealSha256),readySha256:digest(v.readySha256),readyRecordSha256:digest(v.readyRecordSha256),resumeWatch:v.resumeWatch};
 if(seal&&(r.operationId!==seal.operationId||r.completionId!==seal.completionId||r.libraryIdentity!==seal.libraryIdentity||r.sealSha256!==lifecycleDigest(seal)||r.resumeWatch!==seal.resumeBackground)||ready&&(r.operationId!==ready.operationId||r.completionId!==ready.completionId||r.instanceId!==ready.instanceId||r.libraryIdentity!==ready.libraryIdentity||r.readySha256!==lifecycleDigest(ready))||token&&r.token!==token||readyRecordSha256&&r.readyRecordSha256!==readyRecordSha256)throw new Error('恢复曲库释放与原决策或实际服务证明不同');return r;
}
export function readRestoreLibraryReleaseProof(value:unknown,request:RestoreLibraryReleaseRequest,ready:RestoreServiceReadyProof,currentBuild=true):RestoreLibraryReleaseProof{
 const v=fields(value,['version','operationId','completionId','challenge','instanceId','pid','buildId','libraryIdentity','requestSha256','phase','businessGateHeld','backgroundReleased','resumeWatch']),pid=restoreTransactionCount(v.pid,2147483647);
 if(v.version!==1||v.operationId!==request.operationId||v.completionId!==request.completionId||v.challenge!==request.challenge||v.instanceId!==request.instanceId||pid!==ready.pid||v.buildId!==ready.buildId||currentBuild&&v.buildId!==RELEASE.mainBuildId||v.libraryIdentity!==request.libraryIdentity||v.requestSha256!==lifecycleDigest(request)||v.phase!=='released'||v.businessGateHeld!==false||v.backgroundReleased!==true||v.resumeWatch!==request.resumeWatch)throw new Error('恢复曲库释放证明与原请求或实际实例不同');
 return {version:1,operationId:request.operationId,completionId:request.completionId,challenge:request.challenge,instanceId:request.instanceId,pid,buildId:ready.buildId,libraryIdentity:request.libraryIdentity,requestSha256:lifecycleDigest(request),phase:'released',businessGateHeld:false,backgroundReleased:true,resumeWatch:request.resumeWatch};
}
export function readRestoreMainReleaseIntent(value:unknown,library?:RestoreLibraryReleaseProof,seal?:RestoreCommitSeal):RestoreMainReleaseIntent{
 const v=fields(value,['version','operationId','completionId','challenge','libraryReleaseSha256','resources','resumeBackground']);if(v.version!==1||typeof v.resumeBackground!=='boolean'||!Array.isArray(v.resources)||!v.resources.length||v.resources.length>32||v.resources.some(name=>typeof name!=='string'||!name||name.length>80||/[\u0000-\u001f]/.test(name))||new Set(v.resources).size!==v.resources.length)throw new Error('恢复主程序释放意图无效');
 const r:RestoreMainReleaseIntent={version:1,operationId:backupUuid(v.operationId),completionId:backupUuid(v.completionId),challenge:backupUuid(v.challenge),libraryReleaseSha256:digest(v.libraryReleaseSha256),resources:[...v.resources] as string[],resumeBackground:v.resumeBackground};
 if(library&&(r.operationId!==library.operationId||r.completionId!==library.completionId||r.libraryReleaseSha256!==lifecycleDigest(library))||seal&&(r.operationId!==seal.operationId||r.completionId!==seal.completionId||r.resumeBackground!==seal.resumeBackground))throw new Error('恢复主程序释放改变了原曲库结果或恢复意图');return r;
}
export function readRestoreMainReleaseProof(value:unknown,request:RestoreMainReleaseIntent):RestoreMainReleaseProof{
 const v=fields(value,['version','operationId','completionId','challenge','requestSha256','resourcesSha256','resourcesReleased','playbackHeld','historyHeld','userGateHeld']);if(v.version!==1||v.operationId!==request.operationId||v.completionId!==request.completionId||v.challenge!==request.challenge||v.requestSha256!==lifecycleDigest(request)||v.resourcesSha256!==lifecycleDigest(request.resources)||v.resourcesReleased!==true||v.playbackHeld!==true||v.historyHeld!==true||v.userGateHeld!==true)throw new Error('恢复主程序释放证明与原请求或保留占用不同');
 return {version:1,operationId:request.operationId,completionId:request.completionId,challenge:request.challenge,requestSha256:lifecycleDigest(request),resourcesSha256:lifecycleDigest(request.resources),resourcesReleased:true,playbackHeld:true,historyHeld:true,userGateHeld:true};
}
