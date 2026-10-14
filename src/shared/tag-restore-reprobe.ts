import {tagWriteKeys,tagWriteUuid} from './tag-write.js';
import type {TagRestoreRecoveryReport} from './tag-restore-recovery.js';
export type TagRestoreReprobeMode='native-restored'|'interrupted-source';
export interface TagRestoreReprobeRequest {commandId:string;jobId:string;baseRevision:number;inspectionId:string;confirmed:true}
export interface TagRestoreReprobeCancel {commandId:string;reprobeId:string}
export interface TagRestoreReprobeView {id:string;mode:TagRestoreReprobeMode;state:'running'|'completed'|'cancelled'|'failed'|'interrupted';phase:string;bytes:string;total:string;reason:string;updatedAt:string;releaseConfirmed:boolean;fileReady:boolean}
export function tagRestoreReprobeMode(state:string,exitConfirmed:boolean,report:TagRestoreRecoveryReport):TagRestoreReprobeMode|null {
 if(report.classification!=='restored-source'||!report.journalEvidence)return null;
 if(state==='native_restored'&&exitConfirmed&&report.journal==='matched'&&report.phase==='verified'&&report.journalEvidence.revision===6)return 'native-restored';
 if(state==='recovery_required'&&['matched','fs-ahead'].includes(report.journal)&&['displaced','restored','verified'].includes(report.phase??'')&&report.journalEvidence.revision>=4&&report.journalEvidence.revision<=6)return 'interrupted-source';
 return null;
}
export function readTagRestoreReprobeRequest(value:unknown):TagRestoreReprobeRequest {
 if(!tagWriteKeys(value,['commandId','jobId','baseRevision','inspectionId','confirmed'])||![value.commandId,value.jobId,value.inspectionId].every(tagWriteUuid)||!Number.isSafeInteger(value.baseRevision)||Number(value.baseRevision)<0||value.confirmed!==true)throw new Error('曲库恢复请求无效，请确认重新解析已恢复的原来源文件');
 return {commandId:String(value.commandId).toLowerCase(),jobId:String(value.jobId).toLowerCase(),baseRevision:Number(value.baseRevision),inspectionId:String(value.inspectionId).toLowerCase(),confirmed:true};
}
export function readTagRestoreReprobeCancel(value:unknown):TagRestoreReprobeCancel {if(!tagWriteKeys(value,['commandId','reprobeId'])||![value.commandId,value.reprobeId].every(tagWriteUuid))throw new Error('停止恢复来源重新解析请求无效');return {commandId:String(value.commandId).toLowerCase(),reprobeId:String(value.reprobeId).toLowerCase()};}
