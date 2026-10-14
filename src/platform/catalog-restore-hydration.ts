import {backupUuid} from '../shared/catalog-backup.js';
import {readRestoreIdentity} from '../shared/catalog-restore.js';
import {restoreTransactionFields as fields,restoreTransactionDigest,restoreTransactionCount} from '../shared/catalog-restore-transaction.js';
import {readRestoreStateSnapshot,readRestoreMainPrior,type RestoreStateSnapshot,type RestoreMainPrior} from '../shared/catalog-restore-state.js';
import {lifecycleDigest} from './catalog-library-lifecycle.js';
import type {CatalogRestoreActivationProof} from './catalog-restore-activation.js';
import type {RestorePendingSettled} from '../shared/catalog-restore-pending.js';
import {RELEASE} from '../shared/release.js';

export type RestoreHydrationRequest={version:1;operationId:string;activationId:string;challenge:string;instanceId:string;token:string;role:'candidate'|'original';libraryIdentity:string;activationSha256:string;pendingSha256:string;priorMainSha256:string};
export type RestoreHydrationIntent={request:RestoreHydrationRequest;prior:RestoreMainPrior};
export type RestoreHydrationProof={version:1;operationId:string;activationId:string;challenge:string;instanceId:string;pid:number;buildId:string;libraryIdentity:string;requestSha256:string;snapshot:RestoreStateSnapshot;snapshotSha256:string;backgroundStarted:false};
export type RestoreHydrationReady={library:RestoreHydrationProof;mainSha256:string;historyAfterSha256:string;outputReleased:true;backgroundStarted:false};
export function readRestoreHydrationRequest(value:unknown,activation?:CatalogRestoreActivationProof,pending?:RestorePendingSettled,token?:string):RestoreHydrationRequest{
 const v=fields(value,['version','operationId','activationId','challenge','instanceId','token','role','libraryIdentity','activationSha256','pendingSha256','priorMainSha256']);if(v.version!==1||v.role!=='candidate'&&v.role!=='original')throw new Error('恢复状态重建请求无效');
 const r:RestoreHydrationRequest={version:1,operationId:backupUuid(v.operationId),activationId:backupUuid(v.activationId),challenge:backupUuid(v.challenge),instanceId:backupUuid(v.instanceId),token:backupUuid(v.token),role:v.role,libraryIdentity:readRestoreIdentity(v.libraryIdentity),activationSha256:restoreTransactionDigest(v.activationSha256),pendingSha256:restoreTransactionDigest(v.pendingSha256),priorMainSha256:restoreTransactionDigest(v.priorMainSha256)};
 if(activation&&(r.operationId!==activation.operationId||r.activationId!==activation.activationId||r.instanceId!==activation.instanceId||r.libraryIdentity!==activation.libraryIdentity||r.activationSha256!==lifecycleDigest(activation))||pending&&r.pendingSha256!==lifecycleDigest(pending)||token&&r.token!==token)throw new Error('恢复状态重建与原可写准备或待保存结果不同');return r;
}
export function readRestoreHydrationIntent(value:unknown):RestoreHydrationIntent{const v=fields(value,['request','prior']),request=readRestoreHydrationRequest(v.request),prior=readRestoreMainPrior(v.prior);if(lifecycleDigest(prior)!==request.priorMainSha256)throw new Error('原 Main 使用状态归档不同');return {request,prior};}
export function readRestoreHydrationProof(value:unknown,request:RestoreHydrationRequest,currentBuild=true):RestoreHydrationProof{
 const v=fields(value,['version','operationId','activationId','challenge','instanceId','pid','buildId','libraryIdentity','requestSha256','snapshot','snapshotSha256','backgroundStarted']),snapshot=readRestoreStateSnapshot(v.snapshot),pid=restoreTransactionCount(v.pid,2147483647);
 if(v.version!==1||pid===0||v.operationId!==request.operationId||v.activationId!==request.activationId||v.challenge!==request.challenge||v.instanceId!==request.instanceId||v.libraryIdentity!==request.libraryIdentity||v.requestSha256!==lifecycleDigest(request)||typeof v.buildId!=='string'||!/^aural-main-\d+\.\d+\.\d+$/.test(v.buildId)||currentBuild&&v.buildId!==RELEASE.mainBuildId||v.snapshotSha256!==lifecycleDigest(snapshot)||v.backgroundStarted!==false)throw new Error('恢复状态读取证明与原请求不同');
 return {version:1,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,instanceId:request.instanceId,pid,buildId:v.buildId,libraryIdentity:request.libraryIdentity,requestSha256:lifecycleDigest(request),snapshot,snapshotSha256:lifecycleDigest(snapshot),backgroundStarted:false};
}
export function readRestoreHydrationReady(value:unknown,request:RestoreHydrationRequest,pending:RestorePendingSettled):RestoreHydrationReady{
 const v=fields(value,['library','mainSha256','historyAfterSha256','outputReleased','backgroundStarted']),library=readRestoreHydrationProof(v.library,request,false);
 if(v.mainSha256!==library.snapshotSha256||v.historyAfterSha256!==pending.historyAfterSha256||v.outputReleased!==true||v.backgroundStarted!==false)throw new Error('Main 状态重建结果与原曲库读取不同');return {library,mainSha256:restoreTransactionDigest(v.mainSha256),historyAfterSha256:restoreTransactionDigest(v.historyAfterSha256),outputReleased:true,backgroundStarted:false};
}
