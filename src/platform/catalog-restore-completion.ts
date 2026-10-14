import {backupUuid} from '../shared/catalog-backup.js';
import {readRestoreIdentity} from '../shared/catalog-restore.js';
import {restoreTransactionFields as fields,restoreTransactionDigest as digest,restoreTransactionDate,type RestoreTransactionIntent} from '../shared/catalog-restore-transaction.js';
import {lifecycleDigest} from './catalog-library-lifecycle.js';
import type {RestoreCommitSeal,RestoreServiceReadyProof} from './catalog-restore-commit.js';
import type {RestoreFinalProof} from '../shared/catalog-restore-finalization.js';

export type RestoreCompletionParent={transactionId:string;completionId:string;recordSha256:string;libraryIdentity:string};
// The certificate is written while input is still held. It authorizes an
// ordinary next boot, not a claim that this process already opened input.
export type RestoreCompleted={version:1;operationId:string;completionId:string;role:'candidate'|'original';libraryIdentity:string;previousLibraryIdentity:string;origin:string;sealSha256:string;finalProofSha256:string;finalRecordSha256:string;completedAt:string;parent:RestoreCompletionParent|null;inputHeldAtCommit:true;restartPolicy:'normal-existing-library'};
export function readRestoreCompleted(value:unknown,intent:RestoreTransactionIntent,seal:RestoreCommitSeal,ready:RestoreServiceReadyProof,final:RestoreFinalProof,finalRecordSha256:string):RestoreCompleted{
 const v=fields(value,['version','operationId','completionId','role','libraryIdentity','previousLibraryIdentity','origin','sealSha256','finalProofSha256','finalRecordSha256','completedAt','parent','inputHeldAtCommit','restartPolicy']);
 if(v.version!==1||v.operationId!==intent.transactionId||v.completionId!==seal.completionId||v.role!==seal.role||v.libraryIdentity!==seal.libraryIdentity||v.libraryIdentity!==ready.libraryIdentity||v.previousLibraryIdentity!==intent.liveIdentity||v.origin!==ready.origin||v.sealSha256!==lifecycleDigest(seal)||v.finalProofSha256!==lifecycleDigest(final)||v.finalRecordSha256!==digest(finalRecordSha256)||v.inputHeldAtCommit!==true||v.restartPolicy!=='normal-existing-library')throw new Error('恢复完成证书与原决策、最终资源或实际目录不同');
 let parent:RestoreCompletionParent|null=null;if(v.parent!==null){const p=fields(v.parent,['transactionId','completionId','recordSha256','libraryIdentity']);parent={transactionId:backupUuid(p.transactionId),completionId:backupUuid(p.completionId),recordSha256:digest(p.recordSha256),libraryIdentity:readRestoreIdentity(p.libraryIdentity)};if(parent.transactionId===intent.transactionId||parent.completionId===seal.completionId||parent.libraryIdentity!==intent.liveIdentity)throw new Error('恢复完成前驱不能指向自身或不同原曲库');}
 return {version:1,operationId:intent.transactionId,completionId:seal.completionId,role:seal.role,libraryIdentity:seal.libraryIdentity,previousLibraryIdentity:intent.liveIdentity,origin:ready.origin,sealSha256:lifecycleDigest(seal),finalProofSha256:lifecycleDigest(final),finalRecordSha256:digest(finalRecordSha256),completedAt:restoreTransactionDate(v.completedAt),parent,inputHeldAtCommit:true,restartPolicy:'normal-existing-library'};
}
export type CompletedLineageEntry={completed:RestoreCompleted;recordSha256:string};
// Explicit predecessor IDs support rollback completions that preserve the same
// directory identity. An identity-only graph would confuse them with cycles.
export function orderCompletedLineage(entries:readonly CompletedLineageEntry[]):CompletedLineageEntry[]{
 if(entries.length>64)throw new Error('恢复完成链超过保留预算');if(!entries.length)return [];
 const byId=new Map<string,CompletedLineageEntry>(),completionIds=new Set<string>(),children=new Map<string,CompletedLineageEntry>();let root:CompletedLineageEntry|null=null;
 for(const entry of entries){const c=entry.completed;if(byId.has(c.operationId)||completionIds.has(c.completionId))throw new Error('恢复完成身份重复');byId.set(c.operationId,entry);completionIds.add(c.completionId);}
 for(const entry of entries){const c=entry.completed,p=c.parent;if(!p){if(root)throw new Error('恢复完成链存在多个起点');root=entry;continue;}const previous=byId.get(p.transactionId);
  if(!previous||previous.completed.completionId!==p.completionId||previous.recordSha256!==p.recordSha256||previous.completed.libraryIdentity!==p.libraryIdentity||c.previousLibraryIdentity!==p.libraryIdentity||children.has(p.transactionId))throw new Error('恢复完成前驱缺失、摘要不同或存在分支');children.set(p.transactionId,entry);
 }
 if(!root)throw new Error('恢复完成链没有起点');const ordered:CompletedLineageEntry[]=[],seen=new Set<string>();let next:CompletedLineageEntry|undefined=root;
 while(next){if(seen.has(next.completed.operationId))throw new Error('恢复完成链含循环');seen.add(next.completed.operationId);ordered.push(next);next=children.get(next.completed.operationId);}
 if(ordered.length!==entries.length)throw new Error('恢复完成链存在未连接事务');return ordered;
}
