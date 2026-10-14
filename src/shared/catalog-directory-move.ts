import {backupUuid} from './catalog-backup.js';
import {readRestoreIdentity} from './catalog-restore.js';
export const DIRECTORY_MOVE_PHASES=['locked','intent','moved','verified'] as const;
export const DIRECTORY_MOVE_ACTIONS=['retire-original','install-candidate','retire-candidate','restore-original'] as const;
export type DirectoryMoveAction=typeof DIRECTORY_MOVE_ACTIONS[number];
export type DirectoryMoveSlot='live'|'candidate'|'original'|'retired-candidate';
export const DIRECTORY_MOVE_SLOTS:Record<DirectoryMoveAction,readonly [DirectoryMoveSlot,DirectoryMoveSlot]>={
 'retire-original':['live','original'],'install-candidate':['candidate','live'],'retire-candidate':['live','retired-candidate'],'restore-original':['original','live']
};
export type CatalogDirectoryMoveRequest={version:1;kind:'directory-move';operationId:string;transactionId:string;action:DirectoryMoveAction;userData:string;userDataIdentity:string;transactionIdentity:string;dataIdentity:string;candidateIdentity:string;sourceIdentity:string};
export type CatalogDirectoryMoveProof={action:DirectoryMoveAction;source:DirectoryMoveSlot;target:DirectoryMoveSlot;identity:string;sourcePresent:boolean;targetPresent:boolean;roots:{userData:string;transaction:string;data:string;candidate:string}};
export type CatalogDirectoryMoveMessage={version:1;operationId:string;sequence:number}&({kind:'stage';phase:typeof DIRECTORY_MOVE_PHASES[number];proof:CatalogDirectoryMoveProof}|{kind:'done';proof:CatalogDirectoryMoveProof}|{kind:'error';message:string});
function fields(value:unknown,names:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(n=>!Object.hasOwn(value,n)))throw new Error('曲库目录切换字段无效');return value as Record<string,unknown>;}
export function readDirectoryMoveRequest(value:unknown):CatalogDirectoryMoveRequest{
 const r=fields(value,['version','kind','operationId','transactionId','action','userData','userDataIdentity','transactionIdentity','dataIdentity','candidateIdentity','sourceIdentity']);
 if(r.version!==1||r.kind!=='directory-move'||typeof r.action!=='string'||!DIRECTORY_MOVE_ACTIONS.includes(r.action as DirectoryMoveAction)||typeof r.userData!=='string'||r.userData.length>32767||!/^[a-zA-Z]:\\/.test(r.userData)||/[\u0000-\u001f]/.test(r.userData))throw new Error('曲库目录切换命令或本机根目录无效');
 for(const key of ['userDataIdentity','transactionIdentity','dataIdentity','candidateIdentity','sourceIdentity'])readRestoreIdentity(r[key]);
 return {version:1,kind:'directory-move',operationId:backupUuid(r.operationId),transactionId:backupUuid(r.transactionId),action:r.action as DirectoryMoveAction,userData:r.userData,userDataIdentity:r.userDataIdentity as string,transactionIdentity:r.transactionIdentity as string,dataIdentity:r.dataIdentity as string,candidateIdentity:r.candidateIdentity as string,sourceIdentity:r.sourceIdentity as string};
}
export function readDirectoryMoveProof(value:unknown,request:CatalogDirectoryMoveRequest,moved:boolean):CatalogDirectoryMoveProof{
 const p=fields(value,['action','source','target','identity','sourcePresent','targetPresent','roots']),roots=fields(p.roots,['userData','transaction','data','candidate']),[source,target]=DIRECTORY_MOVE_SLOTS[request.action];
 if(p.action!==request.action||p.source!==source||p.target!==target||p.identity!==request.sourceIdentity||p.sourcePresent!==!moved||p.targetPresent!==moved||roots.userData!==request.userDataIdentity||roots.transaction!==request.transactionIdentity||roots.data!==request.dataIdentity||roots.candidate!==request.candidateIdentity)throw new Error('曲库目录物理证明与原切换意图不符');
 return {action:request.action,source,target,identity:readRestoreIdentity(p.identity),sourcePresent:!moved,targetPresent:moved,roots:{userData:request.userDataIdentity,transaction:request.transactionIdentity,data:request.dataIdentity,candidate:request.candidateIdentity}};
}
export function readDirectoryMoveMessage(value:unknown,request:CatalogDirectoryMoveRequest,last:number,phases:number):CatalogDirectoryMoveMessage{
 const r=value as CatalogDirectoryMoveMessage;
 if(!r||typeof r!=='object'||Array.isArray(r)||r.version!==1||r.operationId!==request.operationId||r.sequence!==last+1||!Number.isSafeInteger(r.sequence)||r.sequence>6)throw new Error('曲库目录切换回执身份或顺序无效');
 if(r.kind==='stage'){fields(r,['version','operationId','sequence','kind','phase','proof']);if(r.phase!==DIRECTORY_MOVE_PHASES[phases])throw new Error('曲库目录切换阶段缺失或重复');return {version:1,operationId:r.operationId,sequence:r.sequence,kind:'stage',phase:r.phase,proof:readDirectoryMoveProof(r.proof,request,phases>=2)};}
 if(r.kind==='done'){fields(r,['version','operationId','sequence','kind','proof']);if(phases!==4)throw new Error('曲库目录切换尚未确认所有持久阶段');return {version:1,operationId:r.operationId,sequence:r.sequence,kind:'done',proof:readDirectoryMoveProof(r.proof,request,true)};}
 if(r.kind==='error'){fields(r,['version','operationId','sequence','kind','message']);if(typeof r.message!=='string'||!r.message||r.message.length>512)throw new Error('曲库目录切换错误无效');return {version:1,operationId:r.operationId,sequence:r.sequence,kind:'error',message:r.message};}
 throw new Error('未知曲库目录切换消息');
}
