import {smartPlaylistId,readSmartPlaylistDefinition,readSmartPlaylistDetail,type SmartPlaylistDefinition,type SmartPlaylistDetail} from './smart-playlists.js';

export const SMART_HISTORY_PAGE_SIZE=20;
export type SmartHistoryAction='create'|'update'|'delete'|'restore';
export type SmartHistorySummary={ordinal:number;playlistId:string;revision:number;action:SmartHistoryAction;name:string;createdAt:string;fingerprint:string;sourceRevision:number|null;sourceFingerprint:string|null};
export type SmartHistoryRecord=SmartHistorySummary&{definition:SmartPlaylistDefinition};
export type SmartHistoryRequest={playlistId?:string;cursor?:string};
export type SmartHistoryPage={version:1;playlistId:string|null;watermark:number;items:SmartHistorySummary[];nextCursor:string|null};
export type SmartHistoryDetailRequest={playlistId:string;revision:number};
export type SmartHistoryDetail={version:1;record:SmartHistoryRecord;headRevision:number;current:SmartPlaylistDetail|null};
export type SmartPlaylistRestoreRequest={commandId:string;playlistId:string;sourceRevision:number;sourceFingerprint:string;headRevision:number;baseRevision:number|null};
export type SmartPlaylistRestoreResult={commandId:string;status:'saved'|'rejected';value:SmartPlaylistDetail|null;error:string};

function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('无效智能规则历史字段');
 return value as Record<string,unknown>;
}
export function smartHistoryNumber(value:unknown,min=0):number{
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min)throw new Error('无效智能规则历史位置或修订');return value;
}
export function smartHistoryFingerprint(value:unknown):string{
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error('无效智能规则历史摘要');return value;
}
export function smartHistoryCursor(value:unknown):string{
 if(typeof value!=='string'||value.length>512||!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(value))throw new Error('无效智能规则历史游标');return value;
}
export function readSmartHistoryRequest(value:unknown):SmartHistoryRequest{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>key!=='playlistId'&&key!=='cursor'))throw new Error('无效智能规则历史请求');
 const r=value as Record<string,unknown>;
 return {...(r.playlistId!==undefined?{playlistId:smartPlaylistId(r.playlistId)}:{}),...(r.cursor!==undefined?{cursor:smartHistoryCursor(r.cursor)}:{})};
}
export function readSmartHistoryDetailRequest(value:unknown):SmartHistoryDetailRequest{
 const r=object(value,['playlistId','revision']);return {playlistId:smartPlaylistId(r.playlistId),revision:smartHistoryNumber(r.revision)};
}
function summary(value:unknown):SmartHistorySummary{
 const r=object(value,['ordinal','playlistId','revision','action','name','createdAt','fingerprint','sourceRevision','sourceFingerprint']);
 const revision=smartHistoryNumber(r.revision);
 if(typeof r.action!=='string'||!['create','update','delete','restore'].includes(r.action)||typeof r.name!=='string'||!r.name.trim()||r.name.length>120||/[\u0000-\u001f]/.test(r.name)||typeof r.createdAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.createdAt)||!Number.isFinite(Date.parse(r.createdAt))||new Date(r.createdAt).toISOString()!==r.createdAt)throw new Error('无效智能规则历史资料');
 const sourceRevision=r.sourceRevision===null?null:smartHistoryNumber(r.sourceRevision),sourceFingerprint=r.sourceFingerprint===null?null:smartHistoryFingerprint(r.sourceFingerprint);
 if(r.action==='restore'?(sourceRevision===null||sourceFingerprint===null||sourceRevision>=revision):(sourceRevision!==null||sourceFingerprint!==null))throw new Error('智能规则恢复来源不完整');
 return {ordinal:smartHistoryNumber(r.ordinal,1),playlistId:smartPlaylistId(r.playlistId),revision,action:r.action as SmartHistoryAction,name:r.name,createdAt:r.createdAt,fingerprint:smartHistoryFingerprint(r.fingerprint),sourceRevision,sourceFingerprint};
}
export function readSmartHistoryPage(value:unknown):SmartHistoryPage{
 const r=object(value,['version','playlistId','watermark','items','nextCursor']);
 if(r.version!==1||!Array.isArray(r.items)||r.items.length>SMART_HISTORY_PAGE_SIZE)throw new Error('无效智能规则历史分页');
 const playlistId=r.playlistId===null?null:smartPlaylistId(r.playlistId),watermark=smartHistoryNumber(r.watermark),items=r.items.map(summary),nextCursor=r.nextCursor===null?null:smartHistoryCursor(r.nextCursor);
 if(items.some((item,index)=>item.ordinal>watermark||playlistId!==null&&item.playlistId!==playlistId||index>0&&item.ordinal>=items[index-1].ordinal)||nextCursor!==null&&items.length!==SMART_HISTORY_PAGE_SIZE)throw new Error('智能规则历史范围不一致');
 return {version:1,playlistId,watermark,items,nextCursor};
}
export function readSmartHistoryDetail(value:unknown):SmartHistoryDetail{
 const r=object(value,['version','record','headRevision','current']);if(r.version!==1)throw new Error('不支持的智能规则历史响应');
 const h=object(r.record,['ordinal','playlistId','revision','action','name','createdAt','fingerprint','sourceRevision','sourceFingerprint','definition']),{definition,...rest}=h;
 const record={...summary(rest),definition:readSmartPlaylistDefinition(definition)},headRevision=smartHistoryNumber(r.headRevision),current=r.current===null?null:readSmartPlaylistDetail(r.current);
 if(record.revision>headRevision||current!==null&&(current.id!==record.playlistId||current.revision!==headRevision))throw new Error('智能规则历史与当前修订不一致');
 return {version:1,record,headRevision,current};
}
export function readSmartPlaylistRestoreRequest(value:unknown):SmartPlaylistRestoreRequest{
 const r=object(value,['commandId','playlistId','sourceRevision','sourceFingerprint','headRevision','baseRevision']),headRevision=smartHistoryNumber(r.headRevision),sourceRevision=smartHistoryNumber(r.sourceRevision),baseRevision=r.baseRevision===null?null:smartHistoryNumber(r.baseRevision);
 if(headRevision>=Number.MAX_SAFE_INTEGER||sourceRevision>headRevision||baseRevision!==null&&baseRevision!==headRevision)throw new Error('无效智能规则恢复基础修订');
 return {commandId:smartPlaylistId(r.commandId),playlistId:smartPlaylistId(r.playlistId),sourceRevision,sourceFingerprint:smartHistoryFingerprint(r.sourceFingerprint),headRevision,baseRevision};
}
export function readSmartPlaylistRestoreResult(value:unknown):SmartPlaylistRestoreResult{
 const r=object(value,['commandId','status','value','error']);
 if(r.status!=='saved'&&r.status!=='rejected'||typeof r.error!=='string'||r.error.length>512||r.status==='saved'&&(r.value===null||r.error!=='')||r.status==='rejected'&&r.value!==null)throw new Error('无效智能规则恢复回执');
 return {commandId:smartPlaylistId(r.commandId),status:r.status,value:r.value===null?null:readSmartPlaylistDetail(r.value),error:r.error};
}
