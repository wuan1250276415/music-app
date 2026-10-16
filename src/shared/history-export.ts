import {readHistoryQuery,readHistoryCheckpoint,historyInstant,historyQualifies,type PlaybackHistoryCheckpoint} from './playback-history.js';
export const HISTORY_EXPORT_MAX_BYTES=512*1024*1024;
export const HISTORY_EXPORT_MAX_ROWS=1000000;
export const HISTORY_EXPORT_BATCH=32;
export const HISTORY_EXPORT_FRAME_BYTES=1024*1024;
export const HISTORY_EXPORT_DEADLINE_MS=10*60*1000;
export type HistoryExportFormat='jsonl'|'csv';
export type HistoryExportScope={query:string;itemId?:string};
export type HistoryExportRequest={operationId:string;format:HistoryExportFormat;scope:HistoryExportScope};
export type HistoryExportRecord=PlaybackHistoryCheckpoint&{id:number;counted:boolean;updatedAt:string;timeBasis:'observation'|'legacy-start'};
export type HistoryExportTotals={rows:number;plays:number;presentedUs:string;estimatedUs:string};
export type HistoryPendingObservation={observedAt:string;enabled:boolean;pending:number;error:string};
export type HistoryExportHeader={type:'header';format:'aural-playback-history';version:1;encoding:HistoryExportFormat;snapshotAt:string;origin:string;schema:68|69|70|71|72|73|74|75|76|77|78|79|80|81;scope:HistoryExportScope;pendingAtRequest:HistoryPendingObservation;ceiling:number;legacyRule:'fixed-v1'};
export type HistoryExportResult={name:string;format:HistoryExportFormat;rows:number;bytes:number;sha256:string;snapshotAt:string;pending:number;publication:'atomic-new'|'rename-existing'|'exclusive-copy'};
export type HistoryExportState={operationId:string|null;request:HistoryExportRequest|null;phase:'idle'|'choosing'|'preparing'|'running'|'stopping'|'publishing'|'completed'|'cancelled'|'failed';rows:number;bytes:number;message:string;result:HistoryExportResult|null};
export type HistoryExportFrame={operationId:string;sequence:number}&({kind:'header';header:HistoryExportHeader}|{kind:'rows';rows:HistoryExportRecord[]}|{kind:'done';totals:HistoryExportTotals}|{kind:'error';error:string});
function fields(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('历史导出字段无效');return v as Record<string,unknown>;}
const num=(v:unknown,max=Number.MAX_SAFE_INTEGER):number=>{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||v>max)throw new Error('历史导出数值无效');return v;};
export const historyExportId=(v:unknown):string=>{if(typeof v!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v))throw new Error('历史导出身份无效');return v;};
const instant=(v:unknown):string=>{if(!historyInstant(v))throw new Error('历史导出时间无效');return v;};
const format=(v:unknown):HistoryExportFormat=>{if(v!=='csv'&&v!=='jsonl')throw new Error('历史导出格式无效');return v;};
export function readHistoryExportScope(value:unknown):HistoryExportScope{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('历史导出范围无效');
 const v=fields(value,Object.hasOwn(value,'itemId')?['query','itemId']:['query']),r=readHistoryQuery(v);return {query:r.query??'',...(r.itemId?{itemId:r.itemId}:{})};
}
export function readHistoryExportRequest(value:unknown):HistoryExportRequest{const v=fields(value,['operationId','format','scope']);return {operationId:historyExportId(v.operationId),format:format(v.format),scope:readHistoryExportScope(v.scope)};}
export function readHistoryPending(value:unknown):HistoryPendingObservation{
 const v=fields(value,['observedAt','enabled','pending','error']);if(typeof v.enabled!=='boolean'||typeof v.error!=='string'||v.error.length>1024)throw new Error('历史待保存观察无效');return {observedAt:instant(v.observedAt),enabled:v.enabled,pending:num(v.pending,512),error:v.error};
}
export function readHistoryExportHeader(value:unknown):HistoryExportHeader{
 const v=fields(value,['type','format','version','encoding','snapshotAt','origin','schema','scope','pendingAtRequest','ceiling','legacyRule']);if(v.type!=='header'||v.format!=='aural-playback-history'||v.version!==1||(v.schema!==68&&v.schema!==69&&v.schema!==70&&v.schema!==71&&v.schema!==72&&v.schema!==73&&v.schema!==74&&v.schema!==75&&v.schema!==76&&v.schema!==77&&v.schema!==78&&v.schema!==79&&v.schema!==80&&v.schema!==81)||v.legacyRule!=='fixed-v1')throw new Error('历史导出文件头无效');
 return {type:'header',format:'aural-playback-history',version:1,encoding:format(v.encoding),snapshotAt:instant(v.snapshotAt),origin:historyExportId(v.origin),schema:v.schema as 68|69|70|71|72|73|74|75|76|77|78|79|80|81,scope:readHistoryExportScope(v.scope),pendingAtRequest:readHistoryPending(v.pendingAtRequest),ceiling:num(v.ceiling),legacyRule:'fixed-v1'};
}
export function readHistoryExportRecord(value:unknown):HistoryExportRecord{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==((value as {policyVersion?:unknown}).policyVersion===2?19:18))throw new Error('历史导出记录无效');
 const {id,counted,updatedAt,timeBasis,...raw}=value as Record<string,unknown>,checkpoint=readHistoryCheckpoint(raw);
 if(num(id)<1||typeof counted!=='boolean'||timeBasis!=='observation'&&timeBasis!=='legacy-start'||!historyInstant(checkpoint.observedAt)||counted&&!historyQualifies(checkpoint))throw new Error('历史导出记录身份或计次依据无效');
 return {...checkpoint,id:id as number,counted,updatedAt:instant(updatedAt),timeBasis};
}
export function readHistoryExportTotals(value:unknown):HistoryExportTotals{
 const v=fields(value,['rows','plays','presentedUs','estimatedUs']),rows=num(v.rows,HISTORY_EXPORT_MAX_ROWS),plays=num(v.plays,HISTORY_EXPORT_MAX_ROWS);
 if(plays>rows||typeof v.presentedUs!=='string'||! /^(0|[1-9]\d{0,23})$/.test(v.presentedUs)||typeof v.estimatedUs!=='string'||!/^(0|[1-9]\d{0,23})$/.test(v.estimatedUs))throw new Error('历史导出总计无效');return {rows,plays,presentedUs:v.presentedUs,estimatedUs:v.estimatedUs};
}
export function readHistoryExportFrame(value:unknown):HistoryExportFrame{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('历史导出消息无效');
 const raw=value as Record<string,unknown>,key=raw.kind==='header'?'header':raw.kind==='rows'?'rows':raw.kind==='done'?'totals':raw.kind==='error'?'error':null;if(!key)throw new Error('历史导出消息类型无效');
 const v=fields(value,['operationId','sequence','kind',key]),common={operationId:historyExportId(v.operationId),sequence:num(v.sequence,HISTORY_EXPORT_MAX_ROWS+2)};
 if(v.kind==='header')return {...common,kind:'header',header:readHistoryExportHeader(v.header)};
 if(v.kind==='done')return {...common,kind:'done',totals:readHistoryExportTotals(v.totals)};
 if(v.kind==='rows'){if(!Array.isArray(v.rows)||!v.rows.length||v.rows.length>HISTORY_EXPORT_BATCH)throw new Error('历史导出批次无效');return {...common,kind:'rows',rows:v.rows.map(readHistoryExportRecord)};}
 if(typeof v.error!=='string'||!v.error||v.error.length>1024)throw new Error('历史导出错误无效');return {...common,kind:'error',error:v.error};
}
export function readHistoryExportResult(value:unknown):HistoryExportResult{
 const v=fields(value,['name','format','rows','bytes','sha256','snapshotAt','pending','publication']);if(typeof v.name!=='string'||!v.name||v.name.length>128||typeof v.sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.sha256)||!['atomic-new','rename-existing','exclusive-copy'].includes(String(v.publication)))throw new Error('历史导出结果无效');
 return {name:v.name,format:format(v.format),rows:num(v.rows,HISTORY_EXPORT_MAX_ROWS),bytes:num(v.bytes,HISTORY_EXPORT_MAX_BYTES),sha256:v.sha256,snapshotAt:instant(v.snapshotAt),pending:num(v.pending,512),publication:v.publication as HistoryExportResult['publication']};
}
export function readHistoryExportState(value:unknown):HistoryExportState{
 const v=fields(value,['operationId','request','phase','rows','bytes','message','result']);if(!['idle','choosing','preparing','running','stopping','publishing','completed','cancelled','failed'].includes(String(v.phase))||typeof v.message!=='string'||v.message.length>1024)throw new Error('历史导出状态无效');
 const state:HistoryExportState={operationId:v.operationId===null?null:historyExportId(v.operationId),request:v.request===null?null:readHistoryExportRequest(v.request),phase:v.phase as HistoryExportState['phase'],rows:num(v.rows,HISTORY_EXPORT_MAX_ROWS),bytes:num(v.bytes,HISTORY_EXPORT_MAX_BYTES),message:v.message,result:v.result===null?null:readHistoryExportResult(v.result)};
 if(state.operationId===null?state.request!==null:state.request?.operationId!==state.operationId)throw new Error('历史导出状态与请求不符');
 if(state.result&&state.result.format!==state.request?.format)throw new Error('历史导出结果格式与请求不符');
 if(state.phase==='idle'&&(state.operationId!==null||state.rows!==0||state.bytes!==0)||state.phase!=='idle'&&state.operationId===null||state.phase==='completed'&&(!state.result||state.result.rows!==state.rows||state.result.bytes!==state.bytes)||state.phase!=='completed'&&state.result!==null)throw new Error('历史导出状态与结果不符');return state;
}
const csvColumns=['record_type','record_id','session_id','entry_id','item_id','title','artist','album','started_at','observed_at','time_basis','updated_at','counted','duration_us','presented_us','estimated_us','furthest_us','policy_version','policy_revision','policy_json','export_json'];
const csvCell=(value:unknown)=>{let text=value===null||value===undefined?'':String(value);if(/^\s*[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
const csvRow=(cells:unknown[])=>cells.map(csvCell).join(',')+'\r\n';
export function historyExportHeaderText(header:HistoryExportHeader):string{return header.encoding==='jsonl'?JSON.stringify(header)+'\n':'\uFEFF'+csvRow(csvColumns)+csvRow(['header',...Array(19).fill(''),JSON.stringify(header)]);}
export function historyExportRowsText(kind:HistoryExportFormat,rows:HistoryExportRecord[]):string{
 return rows.map(row=>kind==='jsonl'?JSON.stringify({type:'play',...row})+'\n':csvRow(['play',row.id,row.sessionId,row.entryId,row.itemId,row.title,row.artist,row.album,row.startedAt,row.observedAt,row.timeBasis,row.updatedAt,row.counted?1:0,row.durationUs,row.presentedUs,row.estimatedUs,row.furthestUs,row.policyVersion,row.policy?.revision,row.policy?JSON.stringify(row.policy.rule):JSON.stringify({version:1}),'' ])).join('');
}
export function historyExportFooterText(kind:HistoryExportFormat,totals:HistoryExportTotals,sha256:string):string{
 const footer={type:'summary',version:1,complete:true,...totals,sha256,hashScope:'all-utf8-bytes-before-summary'};return kind==='jsonl'?JSON.stringify(footer)+'\n':csvRow(['summary',...Array(19).fill(''),JSON.stringify(footer)]);
}
