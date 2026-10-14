import {createHash} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {CueSourceHistory} from './cue-history.js';
import {resolveCueReference,type CueEntry} from './cue.js';
import {validFileObservation} from '../platform/file-observation.js';
import {CUE_REVIEW_PAGE,type CueVersionReview,type CueReferenceState,type CueReviewTrack} from '../shared/cue-version-review.js';

type Root={id:string;path:string;status:string;scan_generation:number};
type File={id:string;relative_path:string;size:number;mtime_ms:number;duration_seconds:number|null;codec:string|null;sample_rate:number|null;status:string;parse_error:string|null;observation:string|null;policy_revision:number;policy_state:string;restore_command:string|null};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
// This is a catalog snapshot review. It never reads a music file, trusts a
// catalog observation as fresh filesystem evidence, or grants an apply token.
export function reviewCueVersion(db:DatabaseSync,history:CueSourceHistory,value:unknown,context:{root:(id:string)=>Root|undefined;authorization:(root:Root)=>{allowed:boolean;sha256:string};readable:(fileId:string)=>void}):CueVersionReview {
 const {request:r,source,bundle,parsed}=history.reviewSource(value),root=context.root(source.rootId),authorization=root?context.authorization(root):null,authorized=authorization?.allowed??false;
 const doc=parsed.document,entries=[...doc.entries,...(doc.hiddenEntries??[])];if(entries.length>2000)throw new Error('CUE 复审曲目超过预算');
 const lookup=db.prepare("SELECT f.id,f.relative_path,f.size,f.mtime_ms,f.duration_seconds,f.codec,f.sample_rate,f.status,f.parse_error,o.stamp observation,COALESCE(p.revision,0) policy_revision,COALESCE(p.state,'active') policy_state,p.restore_command FROM media_file f LEFT JOIN media_file_observation o ON o.file_id=f.id AND o.algorithm='node-bigint-stat-v1' LEFT JOIN media_file_policy p ON p.file_id=f.id WHERE f.root_id=? AND f.path_key=?");
 const references=new Map<string,{reference:string;relative:string|null;file:File|null;state:CueReferenceState}>();
 const sourceFile=root?path.resolve(root.path,source.relativePath):null;
 // Check the current source anchor lexically even when no media is opened.
 if(root){const relative=path.relative(root.path,sourceFile!);if(!path.isAbsolute(root.path)||root.path.includes('\0')||path.isAbsolute(source.relativePath)||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||source.relativePath.includes('\0'))throw new Error('当前 CUE 来源路径越过曲库目录');}
 for(const entry of entries){
  if(references.has(entry.file))continue;
  const full=root&&sourceFile?resolveCueReference(root.path,sourceFile,entry.file):null,relative=full&&root?path.relative(root.path,full):null;
  const file=relative!==null&&root?lookup.get(root.id,relative.normalize('NFKC').toLocaleLowerCase().trim()) as File|undefined:undefined;
  let state:CueReferenceState=!root?'missing-record':relative===null?'outside-root':!file?'missing-record':file.policy_state==='ignored'?'ignored':file.policy_state==='removed'?'removed':file.restore_command!==null?'restore-pending':file.status!=='online'||root.status==='offline'?'offline':file.parse_error?'parse-error':!validFileObservation(file.observation)?'unobserved':'catalog-online';
  if(state==='catalog-online'&&file)try{context.readable(file.id);}catch{state='writeback-held';}
  references.set(entry.file,{reference:entry.file,relative,file:file??null,state});
 }
 const tracks=entries.map(entry=>{
  const ref=references.get(entry.file)!,file=ref.file,start=entry.startFrame??entry.index01Frame,end=entry.endFrame;
  let range:CueReviewTrack['rangeState']='unavailable';
  if(root&&authorized&&ref.state==='catalog-online'){
   const duration=file?.duration_seconds;
   range=typeof duration!=='number'||!Number.isFinite(duration)||duration<=0?'unbounded':start/75>=duration||entry.index01Frame/75>=duration||end!==undefined&&end/75>duration+0.000001||entry.indices?.some(i=>i.frame/75>=duration)?'outside-duration':'catalog-bounded';
  }
  return {entry,reference:ref,start,end,range};
 });
 const fingerprint=hash(JSON.stringify(['aural-cue-catalog-review-v1',{fileId:r.fileId,versionId:r.versionId,baseRevision:r.baseRevision,latestVersion:r.latestVersion,encoding:r.encoding,gapPolicy:r.gapPolicy},source,{root:root??null,authorization},bundle.rootPath,bundle.relativePath,bundle.createdAt,parsed.sourceHash,parsed.parserVersion,hash(JSON.stringify(doc)),[...references.values()],tracks.map(v=>({number:v.entry.number,hidden:Boolean(v.entry.hidden),file:v.entry.file,start:v.start,index01:v.entry.index01Frame,end:v.end??null,range:v.range}))]));
 if(r.expectedMappingSha256&&r.expectedMappingSha256!==fingerprint)throw new Error('曲库引用或权限记录已变化，请从第一页重新复审');
 if(r.offset>0&&r.offset>=tracks.length)throw new Error('CUE 复审分页超出当前结果');
 const displayed=tracks.slice(r.offset,r.offset+CUE_REVIEW_PAGE).map(({entry,reference:ref,start,end,range}):CueReviewTrack=>({number:entry.number,hidden:Boolean(entry.hidden),title:entry.title.slice(0,256),performer:entry.performer.slice(0,256),reference:{reference:ref.reference.slice(0,512),relativePath:ref.relative?.slice(0,1024)??null,fileId:ref.file?.id??null,state:ref.state,durationSeconds:ref.file?.duration_seconds??null,observation:validFileObservation(ref.file?.observation)?ref.file!.observation:null,policyRevision:ref.file?.policy_revision??null,omitted:ref.reference.length>512||(ref.relative?.length??0)>1024},startFrame:start,index01Frame:entry.index01Frame,endFrame:end??null,rangeState:range,omitted:entry.title.length>256||entry.performer.length>256}));
 return {request:r,mappingSha256:fingerprint,rootId:source.rootId,rootPath:root?.path??null,rootStatus:root?.status??'missing',rootAuthorized:authorized,rootPermissionSha256:authorization?.sha256??null,sourcePath:source.relativePath,savedRootPath:bundle.rootPath,savedSourcePath:bundle.relativePath,createdAt:bundle.createdAt,sourceHash:parsed.sourceHash,rawBytes:parsed.rawBytes,savedParser:bundle.parserVersion,currentParser:parsed.parserVersion,savedTracks:(JSON.parse(bundle.parsedJson) as {entries:unknown[]}).entries.length,sourcePending:source.pendingScan,currentEncoding:parsed.encoding,album:doc.title.slice(0,512),performer:doc.performer.slice(0,512),metadataOmitted:doc.title.length>512||doc.performer.length>512,parseError:parsed.parseError,invalid:Boolean(parsed.parseError||doc.invalid),warnings:doc.warnings.slice(0,16).map(v=>v.slice(0,512)),warningsOmitted:doc.warnings.length>16||doc.warnings.some(v=>v.length>512),totalTracks:tracks.length,visibleTracks:doc.entries.length,hiddenTracks:doc.hiddenEntries?.length??0,referenceCount:references.size,catalogOnlineReferences:[...references.values()].filter(v=>v.state==='catalog-online').length,boundedTracks:tracks.filter(v=>v.range==='catalog-bounded').length,unavailableTracks:tracks.filter(v=>v.range!=='catalog-bounded').length,tracks:displayed,offset:r.offset,nextOffset:r.offset+CUE_REVIEW_PAGE<tracks.length?r.offset+CUE_REVIEW_PAGE:null};
}
