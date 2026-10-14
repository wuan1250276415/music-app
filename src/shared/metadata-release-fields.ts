import type {CatalogChangeResult} from './contracts';
export const releaseOnlineFields=['date','country','barcode','label','catalogNumber'] as const;
export type ReleaseOnlineField=typeof releaseOnlineFields[number];
export const releaseOnlineLabels:Record<ReleaseOnlineField,string>={date:'发行日期',country:'国家／地区',barcode:'条码',label:'唱片公司',catalogNumber:'目录号'};
export interface ReleaseFieldsReview {
 reviewToken:string;itemId:string;releaseId:string;title:string;fileCount:number;sourceUrl:string;expiresAt:string;
 current:Record<ReleaseOnlineField,string|null>;locked:ReleaseOnlineField[];
 proposed:{date:string|null;country:string|null;barcode:string|null;labels:Array<{name:string;catalogNumber:string|null}>};
}
export interface ReleaseFieldsApply {commandId:string;itemId:string;reviewToken:string;fields:ReleaseOnlineField[];labelIndex?:number;confirmedReleaseScope:true}
export interface ReleaseFieldsUndoPreview {
 changeId:string;title:string;fileCount:number;fingerprint:string;complete:boolean;
 fields:Array<{field:ReleaseOnlineField;before:string|null;after:string|null;current:string|null;status:'ready'|'conflict'|'undone';reason:string}>;
}
export interface ReleaseFieldsUndo {commandId:string;changeId:string;fingerprint:string;fields:ReleaseOnlineField[];confirmedReleaseScope:true}
export interface ReleaseFieldsUndoResult extends CatalogChangeResult {updated:ReleaseOnlineField[];remaining:ReleaseOnlineField[]}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function object(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('无效发行字段请求');return value as Record<string,unknown>;}
function id(v:unknown):string{if(typeof v!=='string'||!uuid.test(v))throw new Error('无效发行字段标识');return v;}
function fields(v:unknown):ReleaseOnlineField[]{if(!Array.isArray(v)||!v.length||v.length>5||new Set(v).size!==v.length||v.some(f=>!releaseOnlineFields.includes(f)))throw new Error('请选择有效且不重复的发行字段');return [...v].sort() as ReleaseOnlineField[];}
export function readReleaseFieldsApply(value:unknown):ReleaseFieldsApply{
 const v=object(value,['commandId','itemId','reviewToken','fields','labelIndex','confirmedReleaseScope']);if(typeof v.itemId!=='string'||!v.itemId||v.itemId.length>128||v.confirmedReleaseScope!==true||v.labelIndex!==undefined&&(!Number.isSafeInteger(v.labelIndex)||Number(v.labelIndex)<0||Number(v.labelIndex)>=64))throw new Error('请确认本地专辑的更新范围');
 return {commandId:id(v.commandId),itemId:v.itemId,reviewToken:id(v.reviewToken),fields:fields(v.fields),...(v.labelIndex===undefined?{}:{labelIndex:Number(v.labelIndex)}),confirmedReleaseScope:true};
}
export function readReleaseFieldsUndo(value:unknown):ReleaseFieldsUndo{
 const v=object(value,['commandId','changeId','fingerprint','fields','confirmedReleaseScope']);if(typeof v.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(v.fingerprint)||v.confirmedReleaseScope!==true)throw new Error('请重新读取并确认撤销范围');
 return {commandId:id(v.commandId),changeId:id(v.changeId),fingerprint:v.fingerprint,fields:fields(v.fields),confirmedReleaseScope:true};
}
