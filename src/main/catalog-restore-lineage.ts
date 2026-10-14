import path from 'node:path';
import {orderCompletedLineage,type CompletedLineageEntry} from '../platform/catalog-restore-completion.js';
import type {DirectoryMoveSlot} from '../shared/catalog-directory-move.js';

export type RestoreLineageRow={transactionId:string;previousIdentity:string;candidateIdentity:string|null;completed:CompletedLineageEntry|null;lastSha256:string;nativeMoves:number;globalMoves:number;allMovesCompleted:boolean;installed:boolean;slots:Record<DirectoryMoveSlot,string|null>};
export type RestoreOpening='blocked'|'original-before-cutover'|'pre-cutover-retained'|'completed-current'|'completed-retained';
// Pure namespace projection. Mutable WAL/library contents are never compared
// against an obsolete pre-release snapshot. Normal Library startup still owns
// its database validation/migration; this layer certifies directory selection.
export function planRestoreLineage(userData:string,rows:readonly RestoreLineageRow[]):{openings:Map<string,RestoreOpening>;locations:Map<string,string>;head:CompletedLineageEntry|null}{
 const ordered=orderCompletedLineage(rows.flatMap(row=>row.completed?[row.completed]:[])),byId=new Map(rows.map(row=>[row.transactionId,row])),live=path.join(userData,'library'),locations=new Map<string,string>(),accepted=new Set<string>(),openings=new Map<string,RestoreOpening>();
 const first=ordered[0];let current=first?.completed.previousLibraryIdentity??rows[0]?.slots.live??null;if(!current)throw new Error('恢复登记没有可核对的当前曲库目录');locations.set(current,live);accepted.add(current);
 for(const entry of ordered){const c=entry.completed,row=byId.get(c.operationId)!;if(c.previousLibraryIdentity!==current||row.previousIdentity!==current||!row.candidateIdentity||!row.allMovesCompleted||row.nativeMoves!==row.globalMoves)throw new Error('恢复完成链原目录或移动登记不同');
  const data=path.join(userData,'backups','restore-transactions',c.operationId,'data');
  if(c.role==='candidate'){
   if(c.libraryIdentity!==row.candidateIdentity||locations.has(c.libraryIdentity)||row.slots.original!==current||row.slots.candidate!==null||row.slots['retired-candidate']!==null)throw new Error('已完成候选恢复的保留目录不同');locations.set(current,path.join(data,'original-library'));locations.set(c.libraryIdentity,live);
  }else{
   if(c.libraryIdentity!==current||locations.has(row.candidateIdentity)||row.slots.original!==null||row.slots.candidate!==(row.installed?null:row.candidateIdentity)||row.slots['retired-candidate']!==(row.installed?row.candidateIdentity:null))throw new Error('已完成原库回滚的保留目录不同');
   locations.set(row.candidateIdentity,row.installed?path.join(data,'retired-candidate'):path.join(data,'candidate','library'));locations.set(current,live);
  }
  current=c.libraryIdentity;accepted.add(current);
 }
 const head=ordered.at(-1)??null;
 for(const row of rows){if(row.slots.live!==current)throw new Error('当前曲库目录不是完成链的最终目录');
  if(row.completed){openings.set(row.transactionId,row.transactionId===head?.completed.operationId?'completed-current':'completed-retained');continue;}
  if(row.nativeMoves||row.globalMoves||row.slots.original!==null||row.slots['retired-candidate']!==null||!accepted.has(row.previousIdentity))throw new Error('存在未完成移动或无法归属的恢复事务');
  if(row.candidateIdentity&&row.slots.candidate!==row.candidateIdentity)throw new Error('未切换候选目录身份不同');openings.set(row.transactionId,row.previousIdentity===current?'original-before-cutover':'pre-cutover-retained');
 }
 return {openings,locations,head};
}
