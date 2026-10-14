import type {CatalogChangeResult,EntityReferences} from './contracts';
import {readMetadataIdentityPreview,type MetadataIdentityPreviewRequest} from './metadata-identities';
export type MetadataGroupLinkPreviewRequest=MetadataIdentityPreviewRequest;
export interface MetadataGroupLinkPreview {
 previewToken:string;expiresAt:string;action:'create'|'attach'|'already';releaseTitle:string;sourceTitle:string;sourceId:string;sourceUrl:string;
 release:EntityReferences;previous:EntityReferences|null;target:EntityReferences|null;previousEditions:string[];targetEditions:string[];warnings:string[];
}
export interface MetadataGroupLinkApplyRequest {commandId:string;previewToken:string;confirmedReleaseScope:boolean;confirmedTargetScope:boolean;confirmedPreviousScope:boolean}
export interface MetadataGroupLinkUndoPreview {changeId:string;title:string;groupTitle:string;affectedItems:number;status:'ready'|'conflict'|'undone';reason:string;createdGroup:boolean}
export const readMetadataGroupLinkPreview=readMetadataIdentityPreview;
export function readMetadataGroupLinkApply(raw:unknown):MetadataGroupLinkApplyRequest {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('无效专辑概念关联请求');
 const v=raw as Record<string,unknown>,keys=['commandId','previewToken','confirmedReleaseScope','confirmedTargetScope','confirmedPreviousScope'];
 if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))||typeof v.commandId!=='string'||typeof v.previewToken!=='string'||![v.commandId,v.previewToken].every(s=>/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s))||keys.slice(2).some(k=>typeof v[k]!=='boolean'))throw new Error('无效专辑概念关联请求');
 return {commandId:v.commandId,previewToken:v.previewToken,confirmedReleaseScope:v.confirmedReleaseScope as boolean,confirmedTargetScope:v.confirmedTargetScope as boolean,confirmedPreviousScope:v.confirmedPreviousScope as boolean};
}
export interface MetadataGroupLinkResult extends CatalogChangeResult {groupId:string}
