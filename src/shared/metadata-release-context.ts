import {readMetadataEditionsRequest} from './metadata-editions';
import type {MetadataProviderCredit} from './contracts';
export type MetadataReleaseContextRequest={itemId:string;token:string;fingerprint:string;requestId:string;fresh?:boolean;readOnly?:boolean};
export type MetadataReleaseTrackKind='audio'|'pregap'|'data';
export interface MetadataReleaseTrack {kind?:MetadataReleaseTrackKind;id:string;position:number;number:string;title:string;recordingId:string|null;lengthMs:number|null;credits?:MetadataProviderCredit[];recordingCredits?:MetadataProviderCredit[];recordingTitle?:string|null}
export interface MetadataReleaseMedium {position:number;title:string|null;format:string|null;trackCount:number;trackListComplete:boolean;additionalTracksUnreviewed:boolean;tracks:MetadataReleaseTrack[];pregap?:MetadataReleaseTrack|null;dataTracks?:MetadataReleaseTrack[]}
export function releaseAudioTracks(medium:MetadataReleaseMedium):MetadataReleaseTrack[]{return [...(medium.pregap?[medium.pregap]:[]),...medium.tracks].filter(track=>track.kind!=='data');}
export function releaseAudioTrackCount(medium:MetadataReleaseMedium):number{return medium.trackCount+(medium.pregap?1:0);}
export function releaseTrackLocation(track:{position:number;number?:string;kind?:MetadataReleaseTrackKind},discNumber:number):string{return `第 ${discNumber} 碟／${track.kind==='pregap'||track.position===0?'隐藏前轨（0）':track.kind==='data'?`数据轨 ${track.position}`:`第 ${track.position} 轨`}`;}
export interface MetadataReleaseContext {
 releaseId:string;title:string;date:string|null;country:string|null;status:string|null;disambiguation:string|null;barcode:string|null;
 group:{id:string;title:string;primaryType:string|null;secondaryTypes:string[]}|null;
 artists:MetadataProviderCredit[];labels:Array<{id:string|null;name:string;catalogNumber:string|null}>;
 media:MetadataReleaseMedium[];
}
export interface MetadataReleaseContextResult {
 itemId:string;token:string;fingerprint:string;requestId:string;recordingId:string;
 fieldsReview?:import('./metadata-release-fields').ReleaseFieldsReview|null;
 albumReview?:import('./metadata-album-review').MetadataAlbumReviewHeader|null;
 context:MetadataReleaseContext;fetchedAt:string;expiresAt:string;cacheHit:boolean;
 local:{title:string;trackCount:number|null;media:Array<{discNumber:number;trackCount:number}>;discNumber:number|null;trackNumber:number|null;durationSeconds:number|null};
}
export function readMetadataReleaseContextRequest(value:unknown):MetadataReleaseContextRequest{
 if(value&&typeof value==='object'&&Object.hasOwn(value,'cursor'))throw new Error('专辑上下文不接受分页游标');
 if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(value,'readOnly')){const {readOnly,...request}=value as Record<string,unknown>;if(typeof readOnly!=='boolean')throw new Error('专辑上下文模式无效');return {...readMetadataEditionsRequest(request),readOnly};}
 return readMetadataEditionsRequest(value);
}
