import {tagWriteKeys,tagWriteUuid} from './tag-write.js';
import type {TagCommitRecoveryReport} from './tag-commit-recovery.js';
export type TagCommitReprobeMode='native-verified'|'interrupted-target';
export interface TagCommitReprobeRequest {commandId:string;jobId:string;baseRevision:number;inspectionId:string;confirmed:true}
export interface TagCommitReprobeCancel {commandId:string;reprobeId:string}
export interface TagCommitReprobeView {id:string;mode:TagCommitReprobeMode;state:'running'|'completed'|'cancelled'|'failed'|'interrupted';phase:string;bytes:string;total:string;reason:string;updatedAt:string;releaseConfirmed:boolean;fileReady:boolean}
export function tagCommitReprobeMode(state:string,exitConfirmed:boolean,report:TagCommitRecoveryReport):TagCommitReprobeMode|null {
 if(report.classification!=='replacement-observed'||!report.journalEvidence)return null;
 if(state==='native_verified'&&exitConfirmed&&report.journal==='matched'&&report.phase==='verified'&&report.journalEvidence.revision===5)return 'native-verified';
 if(state==='recovery_required'&&['matched','fs-ahead'].includes(report.journal)&&['victim_moved','replaced','verified'].includes(report.phase??'')&&report.journalEvidence.revision>=3&&report.journalEvidence.revision<=5)return 'interrupted-target';
 return null;
}
export function readTagCommitReprobeRequest(v:unknown):TagCommitReprobeRequest {
 if(!tagWriteKeys(v,['commandId','jobId','baseRevision','inspectionId','confirmed'])||![v.commandId,v.jobId,v.inspectionId].every(tagWriteUuid)||!Number.isSafeInteger(v.baseRevision)||Number(v.baseRevision)<0||v.confirmed!==true)throw new Error('曲库提交请求无效，请确认重新解析当前已写入文件');
 return {commandId:String(v.commandId).toLowerCase(),jobId:String(v.jobId).toLowerCase(),baseRevision:Number(v.baseRevision),inspectionId:String(v.inspectionId).toLowerCase(),confirmed:true};
}
export function readTagCommitReprobeCancel(v:unknown):TagCommitReprobeCancel {if(!tagWriteKeys(v,['commandId','reprobeId'])||![v.commandId,v.reprobeId].every(tagWriteUuid))throw new Error('停止重新解析请求无效');return {commandId:String(v.commandId).toLowerCase(),reprobeId:String(v.reprobeId).toLowerCase()};}
