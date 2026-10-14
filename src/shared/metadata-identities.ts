import type {CatalogChangeResult,ExternalReference} from './contracts';
export type MetadataIdentityKind='recording'|'release'|'release_group'|'release_track';
export interface MetadataIdentityMapping {itemId:string;trackId:string}
export interface MetadataIdentityPreviewRequest {reviewToken:string;requestId:string;mappings:MetadataIdentityMapping[];includeReleaseTracks?:boolean}
export interface MetadataIdentityTarget {
 key:string;kind:MetadataIdentityKind;entityId:string;title:string;sourceTitle:string;sourceId:string;sourceUrl:string;affectedItems:number;affectedReleases:number;
 current:ExternalReference[];status:'ready'|'already'|'conflict';reason:string;positions:string[];
}
export interface MetadataIdentityPreview {previewToken:string;expiresAt:string;releaseTitle:string;sourceTitle:string;sourceUrl:string;warnings:string[];targets:MetadataIdentityTarget[]}
export interface MetadataIdentityApplyRequest {commandId:string;previewToken:string;targets:Array<{key:string;mode:'add'|'replace-musicbrainz'}>;confirmedRecordingScope:boolean;confirmedReleaseScope:boolean;confirmedReleaseGroupScope?:boolean;confirmedReleaseTrackScope?:boolean}
export interface MetadataIdentityChange {changeId:string;kind:MetadataIdentityKind;entityId:string;title:string}
export interface MetadataIdentityResult extends CatalogChangeResult {changes:MetadataIdentityChange[]}
export interface MetadataIdentityUndoPreview {changeId:string;kind:MetadataIdentityKind;title:string;affectedItems:number;before:ExternalReference[];after:ExternalReference[];current:ExternalReference[];status:'ready'|'conflict'|'undone';reason:string}
const uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error('无效在线身份审核请求');return v as Record<string,unknown>;}
function id(v:unknown):string{if(typeof v!=='string'||!uuid.test(v))throw new Error('无效在线身份审核标识');return v;}
export function readMetadataIdentityPreview(v:unknown):MetadataIdentityPreviewRequest {
 const x=object(v,['reviewToken','requestId','mappings','includeReleaseTracks']);if(!Array.isArray(x.mappings)||!x.mappings.length||x.mappings.length>1000)throw new Error('身份审核需选择1–1000条发行对应');const seen=new Set<string>();
 if(Object.hasOwn(x,'includeReleaseTracks')&&typeof x.includeReleaseTracks!=='boolean')throw new Error('无效发行曲目审核范围');
 const mappings=x.mappings.map(raw=>{const m=object(raw,['itemId','trackId']);if(typeof m.itemId!=='string'||!m.itemId||m.itemId.length>128||/[\u0000-\u001f\u007f]/.test(m.itemId)||seen.has(m.itemId))throw new Error('无效或重复的身份对应');seen.add(m.itemId);return {itemId:m.itemId,trackId:id(m.trackId)};}).sort((a,b)=>a.itemId.localeCompare(b.itemId,'en'));
 return {reviewToken:id(x.reviewToken),requestId:id(x.requestId),mappings,...(Object.hasOwn(x,'includeReleaseTracks')?{includeReleaseTracks:x.includeReleaseTracks as boolean}:{})};
}
export function readMetadataIdentityApply(v:unknown):MetadataIdentityApplyRequest {
 const x=object(v,['commandId','previewToken','targets','confirmedRecordingScope','confirmedReleaseScope','confirmedReleaseGroupScope','confirmedReleaseTrackScope']);if(!Array.isArray(x.targets)||!x.targets.length||x.targets.length>2002||typeof x.confirmedRecordingScope!=='boolean'||typeof x.confirmedReleaseScope!=='boolean'||Object.hasOwn(x,'confirmedReleaseGroupScope')&&typeof x.confirmedReleaseGroupScope!=='boolean'||Object.hasOwn(x,'confirmedReleaseTrackScope')&&typeof x.confirmedReleaseTrackScope!=='boolean')throw new Error('请确认所选录音、发行和专辑概念身份的影响范围');const seen=new Set<string>();
 const targets=x.targets.map(raw=>{const t=object(raw,['key','mode']),key=id(t.key);if(seen.has(key)||!['add','replace-musicbrainz'].includes(String(t.mode)))throw new Error('无效或重复的身份确认目标');seen.add(key);return {key,mode:t.mode as 'add'|'replace-musicbrainz'};}).sort((a,b)=>a.key.localeCompare(b.key,'en'));
 // Preserve the legacy request tuple: persisted 0.198 receipts omitted this key.
 return {commandId:id(x.commandId),previewToken:id(x.previewToken),targets,confirmedRecordingScope:x.confirmedRecordingScope,confirmedReleaseScope:x.confirmedReleaseScope,...(Object.hasOwn(x,'confirmedReleaseGroupScope')?{confirmedReleaseGroupScope:x.confirmedReleaseGroupScope as boolean}:{}),...(Object.hasOwn(x,'confirmedReleaseTrackScope')?{confirmedReleaseTrackScope:x.confirmedReleaseTrackScope as boolean}:{})};
}
