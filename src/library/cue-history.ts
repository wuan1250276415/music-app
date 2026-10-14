import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {cueId,cueHash,readCueEncoding,readCueGapPolicy,readCueInterpretRequest,type CueGapPolicy,type CueEncoding,type CueSourceSummary,type CueSourcePage,type CueVersionSummary,type CueVersionPage,type CueSourcePreview,type CueInterpretResult} from '../shared/cue-history.js';
import {decodeCueBytes,interpretCueBytes,type ParsedCueSource} from './cue-read.js';
import {readCueVersionReviewRequest} from '../shared/cue-version-review.js';
import {readCueSourceSelectionRequest,type CueSourceSelectionResult,type CueSourceApplication} from '../shared/cue-source-selection.js';
import {readCueSourceImportRequest,type CueSourceImportRequest,type CueSourceImportResult} from '../shared/cue-source-import.js';
import {readCueSourceRegisterRequest,type CueSourceRegisterRequest} from '../shared/cue-source-registration.js';
import {readCueSourceOriginsRequest,readCueSourceOriginRequest,type CueSourceOriginsPage} from '../shared/cue-source-origins.js';
import {inspectCueSourceBundle} from './cue-source-export.js';
import {readCueSourceExportRequest,CUE_SOURCE_EXPORT_LIMIT,type CueSourceExportData,type CueSourceBundle} from '../shared/cue-source-export.js';
import {cueBundleVersion,checkedCueSourceBundle} from './cue-source-export.js';
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const cuePathKey=(value:string)=>value.normalize('NFKC').toLowerCase().trim();
const pathKey=cuePathKey;
export const cueHistorySchema=`
 CREATE INDEX cue_document_path_key_lookup ON cue_document(root_id,aural_cue_path_key_v1(relative_path));
 CREATE TABLE cue_source_asset(id TEXT PRIMARY KEY CHECK(length(id)=64),raw_bytes BLOB NOT NULL CHECK(typeof(raw_bytes)='blob' AND length(raw_bytes)<=2097152),created_at TEXT NOT NULL);
 CREATE TABLE cue_source_file(id TEXT PRIMARY KEY,root_id TEXT NOT NULL,root_path TEXT NOT NULL,relative_path TEXT NOT NULL,path_key TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740990),encoding TEXT NOT NULL CHECK(encoding IN('auto','utf-8','utf-16le','utf-16be','gb18030')),latest_version TEXT REFERENCES cue_source_version(id),observation TEXT NOT NULL,scan_command TEXT,observed_at TEXT NOT NULL,UNIQUE(root_id,path_key));
 CREATE TABLE cue_source_version(id TEXT PRIMARY KEY CHECK(length(id)=64),file_id TEXT NOT NULL REFERENCES cue_source_file(id),asset_id TEXT NOT NULL REFERENCES cue_source_asset(id),encoding TEXT NOT NULL,requested_encoding TEXT NOT NULL,parser_version TEXT NOT NULL,parsed_json TEXT NOT NULL CHECK(json_valid(parsed_json) AND length(CAST(parsed_json AS BLOB))<=2097152),parsed_sha256 TEXT NOT NULL,parse_error TEXT NOT NULL,root_snapshot TEXT NOT NULL,path_snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE INDEX cue_source_version_page ON cue_source_version(file_id,created_at DESC,id DESC);
 CREATE INDEX cue_source_file_page ON cue_source_file(observed_at DESC,id DESC);
 CREATE INDEX cue_source_file_pending ON cue_source_file(scan_command) WHERE scan_command IS NOT NULL;
 CREATE TABLE cue_source_usage(id INTEGER PRIMARY KEY CHECK(id=1),raw_bytes INTEGER NOT NULL CHECK(typeof(raw_bytes)='integer' AND raw_bytes BETWEEN 0 AND 536870912),assets INTEGER NOT NULL CHECK(typeof(assets)='integer' AND assets BETWEEN 0 AND 32768),parsed_bytes INTEGER NOT NULL CHECK(typeof(parsed_bytes)='integer' AND parsed_bytes BETWEEN 0 AND 536870912),versions INTEGER NOT NULL CHECK(typeof(versions)='integer' AND versions BETWEEN 0 AND 65536),commands INTEGER NOT NULL CHECK(typeof(commands)='integer' AND commands BETWEEN 0 AND 65536),generation INTEGER NOT NULL CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740990));
 INSERT INTO cue_source_usage VALUES(1,0,0,0,0,0,0);
 CREATE TABLE cue_interpret_command(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),result_json TEXT NOT NULL CHECK(json_valid(result_json)),created_at TEXT NOT NULL);
 CREATE TRIGGER cue_source_asset_immutable BEFORE UPDATE ON cue_source_asset BEGIN SELECT RAISE(ABORT,'CUE 原文字节不可修改'); END;
 CREATE TRIGGER cue_source_asset_no_delete BEFORE DELETE ON cue_source_asset BEGIN SELECT RAISE(ABORT,'CUE 原文不可作为缓存清理'); END;
 CREATE TRIGGER cue_source_version_immutable BEFORE UPDATE ON cue_source_version BEGIN SELECT RAISE(ABORT,'CUE 原文版本不可修改'); END;
 CREATE TRIGGER cue_source_version_no_delete BEFORE DELETE ON cue_source_version BEGIN SELECT RAISE(ABORT,'CUE 原文版本不可删除'); END;
 CREATE TRIGGER cue_interpret_command_immutable BEFORE UPDATE ON cue_interpret_command BEGIN SELECT RAISE(ABORT,'CUE 解释回执不可修改'); END;
 CREATE TRIGGER cue_interpret_command_no_delete BEFORE DELETE ON cue_interpret_command BEGIN SELECT RAISE(ABORT,'CUE 解释回执不可删除'); END;
`;
type FileRow={id:string;root_id:string;root_path:string;relative_path:string;path_key:string;revision:number;encoding:CueEncoding;gap_policy:CueGapPolicy;latest_version:string|null;observation:string;scan_command:string|null;observed_at:string;selected_version:string|null;choice_command:string|null;registered_at:string};
type VersionRow={id:string;file_id:string;asset_id:string;encoding:CueVersionSummary['encoding'];requested_encoding:CueEncoding;gap_policy:CueGapPolicy;parser_version:string;parsed_json:string;parsed_sha256:string;parse_error:string;root_snapshot:string;path_snapshot:string;created_at:string;raw_size:number;latest:number;applied:number;imported:number};
const versionSelect=`SELECT v.*,length(a.raw_bytes) raw_size,(f.latest_version=v.id) latest,EXISTS(SELECT 1 FROM cue_document c WHERE c.root_id=f.root_id AND aural_cue_path_key_v1(c.relative_path)=f.path_key AND c.source_hash=v.asset_id AND c.encoding=v.encoding AND c.parser_version=v.parser_version AND c.gap_policy=v.gap_policy) applied,EXISTS(SELECT 1 FROM cue_source_import_command i WHERE i.version_id=v.id AND i.target_file_id=v.file_id) OR EXISTS(SELECT 1 FROM cue_source_register_command i WHERE i.version_id=v.id AND i.target_file_id=v.file_id) imported FROM cue_source_version v JOIN cue_source_asset a ON a.id=v.asset_id JOIN cue_source_file f ON f.id=v.file_id`;
export class CueSourceHistory{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 private file(id:unknown):FileRow{const row=this.db.prepare('SELECT * FROM cue_source_file WHERE id=?').get(cueId(id)) as FileRow|undefined;if(!row)throw new Error('CUE 来源记录不存在，请重新扫描');return row;}
 private bump():void{const result=this.db.prepare('UPDATE cue_source_usage SET generation=generation+1 WHERE id=1 AND generation<9007199254740990').run();if(Number(result.changes)!==1)throw new Error('CUE 历史修订已耗尽');}
 private saveVersion(file:FileRow,source:ParsedCueSource,rootPath:string,relative:string,now:string):string {
  const raw=Buffer.from(source.rawBase64,'base64'),parsed=JSON.stringify(source.document),parsedBytes=Buffer.byteLength(parsed);
  if(raw.length!==source.rawBytes||raw.length>2097152||raw.toString('base64')!==source.rawBase64||digest(raw)!==source.sourceHash||parsedBytes>2097152||source.document.gapPolicy!==source.gapPolicy)throw new Error('CUE 原文版本内容无效');
  const asset=this.db.prepare('SELECT raw_bytes FROM cue_source_asset WHERE id=?').get(source.sourceHash) as {raw_bytes:Uint8Array}|undefined;
  if(asset){if(!Buffer.from(asset.raw_bytes).equals(raw))throw new Error('CUE 原文资产与摘要不一致');}
  else{const reserved=this.db.prepare('UPDATE cue_source_usage SET raw_bytes=raw_bytes+?,assets=assets+1 WHERE id=1 AND raw_bytes+?<=536870912 AND assets<32768').run(raw.length,raw.length);if(Number(reserved.changes)!==1)throw new Error('CUE 原文历史容量已满，旧版本保留');this.db.prepare('INSERT INTO cue_source_asset VALUES(?,?,?)').run(source.sourceHash,raw,now);}
  const id=digest(JSON.stringify([file.id,source.sourceHash,source.encoding,source.requestedEncoding,source.parserVersion,digest(parsed),source.parseError,source.gapPolicy]));
  const old=this.db.prepare('SELECT parsed_json,parsed_sha256 FROM cue_source_version WHERE id=?').get(id) as {parsed_json:string;parsed_sha256:string}|undefined;
  if(old){if(old.parsed_json!==parsed||old.parsed_sha256!==digest(parsed))throw new Error('CUE 解析历史版本与摘要不一致');}
  else{const n=Number((this.db.prepare('SELECT count(*) n FROM cue_source_version WHERE file_id=?').get(file.id) as {n:number}).n);if(n>=128)throw new Error('此 CUE 已保存 128 个版本，原文保留，请先处理历史容量');const reserved=this.db.prepare('UPDATE cue_source_usage SET parsed_bytes=parsed_bytes+?,versions=versions+1 WHERE id=1 AND parsed_bytes+?<=536870912 AND versions<65536').run(parsedBytes,parsedBytes);if(Number(reserved.changes)!==1)throw new Error('CUE 解析历史容量已满，旧版本保留');this.db.prepare('INSERT INTO cue_source_version(id,file_id,asset_id,encoding,requested_encoding,parser_version,parsed_json,parsed_sha256,parse_error,root_snapshot,path_snapshot,created_at,gap_policy) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,file.id,source.sourceHash,source.encoding,source.requestedEncoding,source.parserVersion,parsed,digest(parsed),source.parseError,rootPath,relative,now,source.gapPolicy);}
  return id;
 }
 selectionReceipt(value:unknown):CueSourceSelectionResult|null {
  const r=readCueSourceSelectionRequest(value),old=this.db.prepare('SELECT request_json,result_json FROM cue_source_selection_command WHERE command_id=?').get(r.commandId) as {request_json:string;result_json:string}|undefined;
  if(!old)return null;if(old.request_json!==JSON.stringify(r))throw new Error('同一CUE原文选择操作不可改写');return JSON.parse(old.result_json) as CueSourceSelectionResult;
 }
 importReceipt(value:unknown):CueSourceImportResult|null {
  const r=readCueSourceImportRequest(value),row=this.db.prepare('SELECT request_json,result_json FROM cue_source_import_command WHERE command_id=?').get(r.commandId) as {request_json:string;result_json:string}|undefined;
  if(!row)return null;if(row.request_json!==JSON.stringify(r))throw new Error('同一CUE来源导入操作不可改写');return JSON.parse(row.result_json) as CueSourceImportResult;
 }
 registerReceipt(value:unknown):CueSourceImportResult|null {
  const r=readCueSourceRegisterRequest(value),row=this.db.prepare('SELECT request_json,result_json FROM cue_source_register_command WHERE command_id=?').get(r.commandId) as {request_json:string;result_json:string}|undefined;
  if(!row)return null;if(row.request_json!==JSON.stringify(r))throw new Error('同一新CUE来源操作不可改写');return JSON.parse(row.result_json) as CueSourceImportResult;
 }
 private storeArchive(sha256:string,archive:Buffer):void {
  if(archive.length>CUE_SOURCE_EXPORT_LIMIT||digest(archive)!==sha256)throw new Error('原CUE备份规范字节与摘要不一致');
  const asset=this.db.prepare('SELECT archive_bytes FROM cue_source_import_asset WHERE id=?').get(sha256) as {archive_bytes:Uint8Array}|undefined;
  if(asset){if(!Buffer.from(asset.archive_bytes).equals(archive))throw new Error('原CUE备份资产与摘要不一致');}
  else{if(Number(this.db.prepare('UPDATE cue_source_import_usage SET bytes=bytes+?,assets=assets+1 WHERE id=1 AND bytes+?<=536870912 AND assets<4096').run(archive.length,archive.length).changes)!==1)throw new Error('CUE来源备份历史容量已满，原资料保留');this.db.prepare('INSERT INTO cue_source_import_asset VALUES(?,?,?)').run(sha256,archive,new Date().toISOString());}
 }
 private recordRegistration(request:CueSourceRegisterRequest,result:CueSourceImportResult):CueSourceImportResult {
  if(Number(this.db.prepare('UPDATE cue_source_import_usage SET commands=commands+1 WHERE id=1 AND commands<65536').run().changes)!==1)throw new Error('CUE来源登记及导入命令容量已满，原记录保留');
  this.db.prepare('INSERT INTO cue_source_register_command VALUES(?,?,?,?,?,?,?,?)').run(request.commandId,request.rootId,result.source?.id??null,result.status==='saved'?request.archiveSha256:null,result.versionId,JSON.stringify(request),JSON.stringify(result),new Date().toISOString());return result;
 }
 registerBundle(value:unknown,bundleValue:unknown,validate:()=>void):CueSourceImportResult {
  const request=readCueSourceRegisterRequest(value),old=this.registerReceipt(request);if(old)return old;
  const {bundle,raw}=checkedCueSourceBundle(bundleValue),archive=Buffer.from(JSON.stringify(bundle,null,2)+'\n');
  if(archive.length>CUE_SOURCE_EXPORT_LIMIT||digest(archive)!==request.archiveSha256)throw new Error('新CUE来源的原备份完整摘要不符');
  const parsed=interpretCueBytes(raw,bundle.requestedEncoding,bundle.gapPolicy);
  return this.transaction(()=>{
   for(const table of ['cue_source_import_command','cue_source_selection_command','cue_interpret_command','scan_command'])if(this.db.prepare('SELECT 1 FROM '+table+' WHERE command_id=?').get(request.commandId))throw new Error('新CUE来源UUID已用于既有操作');
   let relative:string;
   try{
    validate();const original=request.relativePath.replace(/[\\/]/g,path.sep);relative=path.normalize(original);const full=path.resolve(request.rootPath,relative),scope=path.relative(request.rootPath,full);
    if(!path.isAbsolute(request.rootPath)||path.isAbsolute(relative)||relative!==original||scope==='..'||scope.startsWith('..'+path.sep)||path.isAbsolute(scope)||!scope||path.extname(relative).toLowerCase()!=='.cue')throw new Error('请填写目录内规范的CUE相对路径，例如 Disc 1/album.cue');
    if(process.platform==='win32'&&relative.split(path.sep).some(part=>/[<>:"|?*]/.test(part)||/[. ]$/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[. ]|$)/i.test(part)))throw new Error('CUE来源相对路径含Windows保留名称或无效字符');
   }catch(error){return this.recordRegistration(request,{status:'rejected',source:null,versionId:null,error:(error instanceof Error?error.message:String(error)).slice(0,512)});}
   const existing=this.db.prepare('SELECT id FROM cue_source_file WHERE root_id=? AND path_key=?').get(request.rootId,pathKey(relative)) as {id:string}|undefined;
   if(existing)return this.recordRegistration(request,{status:'rejected',source:this.source(existing.id),versionId:null,error:'此位置已有CUE来源，请打开它后明确添加备份到其历史'});
   const id=randomUUID(),now=new Date().toISOString();
   this.db.prepare("INSERT INTO cue_source_file(id,root_id,root_path,relative_path,path_key,revision,encoding,latest_version,observation,scan_command,observed_at,registered_at) VALUES(?,?,?,?,?,1,'auto',NULL,'',NULL,'',?)").run(id,request.rootId,request.rootPath,relative,pathKey(relative),now);
   this.storeArchive(request.archiveSha256,archive);const versionId=this.saveVersion(this.file(id),parsed,request.rootPath,relative,now);this.bump();
   return this.recordRegistration(request,{status:'saved',source:this.source(id),versionId,error:''});
  });
 }
 private recordImport(request:CueSourceImportRequest,result:CueSourceImportResult):CueSourceImportResult {
  if(Number(this.db.prepare('UPDATE cue_source_import_usage SET commands=commands+1 WHERE id=1 AND commands<65536').run().changes)!==1)throw new Error('CUE来源导入命令容量已满，原记录保留');
  this.db.prepare('INSERT INTO cue_source_import_command VALUES(?,?,?,?,?,?,?)').run(request.commandId,request.fileId,result.status==='saved'?request.archiveSha256:null,result.versionId,JSON.stringify(request),JSON.stringify(result),new Date().toISOString());return result;
 }
 importBundle(value:unknown,bundleValue:unknown,validate:(source:CueSourceSummary)=>void):CueSourceImportResult {
  const request=readCueSourceImportRequest(value),old=this.importReceipt(request);if(old)return old;
  const {bundle,raw}=checkedCueSourceBundle(bundleValue),archive=Buffer.from(JSON.stringify(bundle,null,2)+'\n');
  if(archive.length>CUE_SOURCE_EXPORT_LIMIT||digest(archive)!==request.archiveSha256)throw new Error('导入CUE备份的完整规范字节与原选择摘要不符');
  const parsed=interpretCueBytes(raw,bundle.requestedEncoding,bundle.gapPolicy);
  return this.transaction(()=>{
   if(this.db.prepare('SELECT 1 FROM cue_interpret_command WHERE command_id=?').get(request.commandId)||this.db.prepare('SELECT 1 FROM cue_source_selection_command WHERE command_id=?').get(request.commandId)||this.db.prepare('SELECT 1 FROM scan_command WHERE command_id=?').get(request.commandId)||this.db.prepare('SELECT 1 FROM cue_source_register_command WHERE command_id=?').get(request.commandId))throw new Error('CUE导入UUID已用于既有操作');
   const current=this.source(request.fileId);
   if(current.revision!==request.baseRevision||current.latestVersion!==request.latestVersion)return this.recordImport(request,{status:'rejected',source:current,versionId:null,error:'目标CUE来源已变化，请重新读取后明确导入'});
   try{validate(current);}catch(error){return this.recordImport(request,{status:'rejected',source:current,versionId:null,error:(error instanceof Error?error.message:String(error)).slice(0,512)});}
   this.storeArchive(request.archiveSha256,archive);
   const file=this.file(request.fileId),versionId=this.saveVersion(file,parsed,file.root_path,file.relative_path,new Date().toISOString());
   if(Number(this.db.prepare('UPDATE cue_source_file SET revision=revision+1 WHERE id=? AND revision=? AND latest_version IS ?').run(request.fileId,request.baseRevision,request.latestVersion).changes)!==1)throw new Error('导入时目标来源修订已变化');this.bump();
   return this.recordImport(request,{status:'saved',source:this.source(request.fileId),versionId,error:''});
  });
 }
 private recordSelection(request:import('../shared/cue-source-selection.js').CueSourceSelectionRequest,result:CueSourceSelectionResult):CueSourceSelectionResult {
  const reserved=this.db.prepare('UPDATE cue_source_usage SET commands=commands+1 WHERE id=1 AND commands<65536').run();if(Number(reserved.changes)!==1)throw new Error('CUE操作历史容量已满，旧记录保留');
  this.db.prepare('INSERT INTO cue_source_selection_command VALUES(?,?,?,?)').run(request.commandId,JSON.stringify(request),JSON.stringify(result),new Date().toISOString());return result;
 }
 selectSource(value:unknown,validate:()=>void):CueSourceSelectionResult {
  const r=readCueSourceSelectionRequest(value),old=this.selectionReceipt(r);if(old)return old;
  return this.transaction(()=>{
   if(this.db.prepare('SELECT 1 FROM cue_interpret_command WHERE command_id=?').get(r.commandId))throw new Error('原文选择UUID已用于另一种CUE操作');
   if(this.db.prepare('SELECT 1 FROM scan_command WHERE command_id=?').get(r.commandId))throw new Error('原文选择UUID已用于既有扫描');
   if(this.db.prepare('SELECT 1 FROM cue_source_import_command WHERE command_id=?').get(r.commandId))throw new Error('原文选择UUID已用于来源导入');if(this.db.prepare('SELECT 1 FROM cue_source_register_command WHERE command_id=?').get(r.commandId))throw new Error('原文选择UUID已用于来源登记');
   const current=this.source(r.fileId);if(current.revision!==r.baseRevision||current.latestVersion!==r.latestVersion)return this.recordSelection(r,{status:'rejected',source:current,error:'CUE来源或设置已变化，请重新复审'});
   try{if(r.selectedVersion!==null)this.versionRow(r.fileId,r.selectedVersion);validate();}
   catch(error){return this.recordSelection(r,{status:'rejected',source:current,error:(error instanceof Error?error.message:String(error)).slice(0,512)});}
   const result:CueSourceSelectionResult={status:'saved',source:{...current,revision:current.revision+1,encoding:r.encoding,gapPolicy:r.gapPolicy,pendingScan:true,selectedVersion:r.selectedVersion,selectionCommand:r.commandId,selectedApplied:false},error:''};
   this.recordSelection(r,result);
   const changed=this.db.prepare('UPDATE cue_source_file SET selected_version=?,choice_command=?,encoding=?,gap_policy=?,scan_command=?,revision=revision+1 WHERE id=? AND revision=? AND latest_version IS ?').run(r.selectedVersion,r.commandId,r.encoding,r.gapPolicy,r.commandId,r.fileId,r.baseRevision,r.latestVersion);if(Number(changed.changes)!==1)throw new Error('CUE选择提交的来源修订已变化');this.bump();
   if(JSON.stringify(this.source(r.fileId))!==JSON.stringify(result.source))throw new Error('CUE选择回执与实际来源不一致');return result;
  });
 }
 private choice(file:FileRow):import('../shared/cue-source-selection.js').CueSourceSelectionRequest|null {
  if(file.choice_command===null){if(file.selected_version!==null)throw new Error('CUE历史选择缺少原命令');return null;}
  const row=this.db.prepare('SELECT request_json FROM cue_source_selection_command WHERE command_id=?').get(file.choice_command) as {request_json:string}|undefined;if(!row)throw new Error('CUE原文选择回执不存在');
  const r=readCueSourceSelectionRequest(JSON.parse(row.request_json));if(r.commandId!==file.choice_command||r.fileId!==file.id||r.selectedVersion!==file.selected_version||r.encoding!==file.encoding||r.gapPolicy!==file.gap_policy)throw new Error('CUE原文选择与当前设置不一致');return r;
 }
 effectiveSource(fileId:string,disk?:ParsedCueSource):{source:ParsedCueSource;application:CueSourceApplication;pendingCommand:string|null} {
  const file=this.file(fileId),choice=this.choice(file);let source=disk,interpretedVersion=file.latest_version;
  if(file.selected_version!==null){const review=this.reviewSource({fileId,versionId:file.selected_version,baseRevision:file.revision,latestVersion:file.latest_version,encoding:file.encoding,gapPolicy:file.gap_policy,offset:0});source=review.parsed;interpretedVersion=this.transaction(()=>this.saveVersion(file,review.parsed,file.root_path,file.relative_path,new Date().toISOString()));}
  if(!source||!interpretedVersion)throw new Error('磁盘CUE缺失且尚未选择历史原文');return {source,application:{fileId,selectedVersion:file.selected_version,interpretedVersion,selectionCommand:choice?.commandId??null},pendingCommand:file.scan_command};
 }
 retainedSources(rootId:unknown,after=''):Array<{id:string;relativePath:string}> {
  const root=cueId(rootId);if(after)cueId(after);
  return (this.db.prepare('SELECT id,relative_path FROM cue_source_file WHERE root_id=? AND (selected_version IS NOT NULL OR scan_command IS NOT NULL) AND id>? ORDER BY id LIMIT 128').all(root,after) as Array<{id:string;relative_path:string}>).map(row=>({id:row.id,relativePath:row.relative_path}));
 }
 retainedAt(rootId:unknown,relative:string):string|null {
  const root=cueId(rootId);const row=this.db.prepare('SELECT id FROM cue_source_file WHERE root_id=? AND path_key=? AND selected_version IS NOT NULL').get(root,pathKey(relative)) as {id:string}|undefined;return row?.id??null;
 }
 interpretation(rootId:string,relative:string):{revision:number;encoding:CueEncoding;gapPolicy:CueGapPolicy}{const r=this.db.prepare('SELECT revision,encoding,gap_policy FROM cue_source_file WHERE root_id=? AND path_key=?').get(rootId,pathKey(relative)) as {revision:number;encoding:CueEncoding;gap_policy:CueGapPolicy}|undefined;return r?{revision:r.revision,encoding:r.encoding,gapPolicy:readCueGapPolicy(r.gap_policy)}:{revision:0,encoding:'auto',gapPolicy:'previous'};}
 observe(rootId:string,rootPath:string,relative:string,observation:string,source:ParsedCueSource,expected:{revision:number;encoding:CueEncoding;gapPolicy:CueGapPolicy}):string{
  cueId(rootId);cueHash(observation);const resolved=path.relative(rootPath,path.resolve(rootPath,relative));if(!relative||path.isAbsolute(relative)||resolved==='..'||resolved.startsWith(`..${path.sep}`)||path.isAbsolute(resolved))throw new Error('CUE 历史路径无效');
  const raw=Buffer.from(source.rawBase64,'base64'),parsed=JSON.stringify(source.document),parsedBytes=Buffer.byteLength(parsed);
  if(raw.length!==source.rawBytes||raw.length>2097152||raw.toString('base64')!==source.rawBase64||digest(raw)!==source.sourceHash||parsedBytes>2097152||source.requestedEncoding!==expected.encoding||source.gapPolicy!==expected.gapPolicy||source.document.gapPolicy!==source.gapPolicy)throw new Error('CUE 原文观察无效');
  return this.transaction(()=>{
   const current=this.interpretation(rootId,relative);if(current.revision!==expected.revision||current.encoding!==expected.encoding||current.gapPolicy!==expected.gapPolicy)throw new Error('CUE 解释设置已变化，等待重新扫描');
   let row=this.db.prepare('SELECT * FROM cue_source_file WHERE root_id=? AND path_key=?').get(rootId,pathKey(relative)) as FileRow|undefined;const now=new Date().toISOString();
   if(!row){const id=randomUUID();this.db.prepare("INSERT INTO cue_source_file(id,root_id,root_path,relative_path,path_key,revision,encoding,latest_version,observation,scan_command,observed_at,registered_at) VALUES(?,?,?,?,?,0,'auto',NULL,'',NULL,?,?)").run(id,rootId,rootPath,relative,pathKey(relative),now,now);row=this.file(id);}
   if(row.revision>=Number.MAX_SAFE_INTEGER-1)throw new Error('CUE 来源修订已耗尽');
   const id=this.saveVersion(row,source,rootPath,relative,now);
   if(row.latest_version!==id||row.observation!==observation||row.root_path!==rootPath||row.relative_path!==relative){this.db.prepare('UPDATE cue_source_file SET latest_version=?,observation=?,revision=revision+1,root_path=?,relative_path=?,observed_at=? WHERE id=?').run(id,observation,rootPath,relative,now,row.id);this.bump();}
   return row.id;
  });
 }
 applied(fileId:string):void{const row=this.file(fileId);if(row.scan_command!==null){if(row.revision>=Number.MAX_SAFE_INTEGER-1)throw new Error('CUE 来源修订已耗尽');this.db.prepare('UPDATE cue_source_file SET scan_command=NULL,revision=revision+1 WHERE id=?').run(fileId);this.bump();}}
 source(id:unknown):CueSourceSummary {
  const row=this.file(id);this.choice(row);
  const version=row.latest_version?this.versionRow(row.id,row.latest_version):null,doc=version?JSON.parse(version.parsed_json):null,arrangements=this.db.prepare('SELECT id FROM cue_document WHERE root_id=? AND aural_cue_path_key_v1(relative_path)=? ORDER BY seen_generation DESC,id LIMIT 1001').all(row.root_id,pathKey(row.relative_path)) as {id:string}[];
  if(arrangements.length>1000)throw new Error('同路径 CUE 编排记录超过预算');
  const selectedApplied=row.selected_version!==null&&row.scan_command===null&&Boolean(this.db.prepare("SELECT 1 FROM cue_document d JOIN cue_source_version v ON v.id=json_extract(d.fields_json,'$.cueSelection.interpretedVersion') JOIN cue_source_version chosen ON chosen.id=? WHERE d.root_id=? AND aural_cue_path_key_v1(d.relative_path)=? AND json_extract(d.fields_json,'$.cueSelection.fileId')=? AND json_extract(d.fields_json,'$.cueSelection.selectedVersion')=? AND json_extract(d.fields_json,'$.cueSelection.selectionCommand')=? AND v.file_id=? AND chosen.file_id=v.file_id AND d.source_hash=chosen.asset_id AND v.asset_id=d.source_hash AND v.encoding=d.encoding AND v.parser_version=d.parser_version AND v.requested_encoding=? AND v.gap_policy=? AND d.gap_policy=v.gap_policy LIMIT 1").get(row.selected_version,row.root_id,row.path_key,row.id,row.selected_version,row.choice_command,row.id,row.encoding,row.gap_policy));
  return {id:row.id,documentId:arrangements[0]?.id??null,documentIds:arrangements.map(v=>v.id),rootId:row.root_id,rootPath:row.root_path,relativePath:row.relative_path,revision:row.revision,encoding:row.encoding,gapPolicy:readCueGapPolicy(row.gap_policy),observedGapPolicy:version?readCueGapPolicy(version.gap_policy):null,latestVersion:row.latest_version,sourceHash:version?.asset_id??null,observedEncoding:version?.encoding??null,parserVersion:version?.parser_version??null,error:version?(version.parse_error||doc.warnings.join('；').slice(0,500)):'',trackCount:doc?.entries.length??0,pendingScan:row.scan_command!==null,observedAt:version?row.observed_at:null,selectedVersion:row.selected_version,selectionCommand:row.choice_command,selectedApplied,registeredAt:row.registered_at||null};
 }
 forItem(itemId:unknown):CueSourceSummary|null{if(typeof itemId!=='string'||!itemId||itemId.length>128)throw new Error('无效 CUE 曲目');const cue=this.db.prepare("SELECT c.root_id,c.relative_path FROM playable_item p JOIN cue_document c ON c.id=substr(p.cue_key,1,36) WHERE p.id=? AND p.kind='cue'").get(itemId) as {root_id:string;relative_path:string}|undefined;if(!cue)return null;const f=this.db.prepare('SELECT id FROM cue_source_file WHERE root_id=? AND path_key=?').get(cue.root_id,pathKey(cue.relative_path)) as {id:string}|undefined;return f?this.source(f.id):null;}
 private versionRow(fileId:unknown,id:unknown):VersionRow{const row=this.db.prepare(versionSelect+' WHERE v.file_id=? AND v.id=?').get(cueId(fileId),cueHash(id)) as VersionRow|undefined;if(!row)throw new Error('CUE 原文版本不存在');if(digest(row.parsed_json)!==row.parsed_sha256)throw new Error('CUE 解析历史校验失败');return row;}
 private summary(v:VersionRow):CueVersionSummary{const doc=JSON.parse(v.parsed_json);return {id:v.id,fileId:v.file_id,sourceHash:v.asset_id,rawBytes:v.raw_size,encoding:v.encoding,requestedEncoding:v.requested_encoding,gapPolicy:readCueGapPolicy(v.gap_policy),parserVersion:v.parser_version,error:v.parse_error||doc.warnings.join('；').slice(0,500),trackCount:doc.entries.length,createdAt:v.created_at,latest:!!v.latest,applied:!!v.applied,imported:!!v.imported};}
 private cursor(cursor:unknown,snapshot:string):{at:string;id:string}|null{if(cursor===undefined)return null;if(typeof cursor!=='string'||cursor.length>1024)throw new Error('无效 CUE 分页');try{const c=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(c.snapshot!==snapshot||typeof c.at!=='string'||c.at.length>32||typeof c.id!=='string'||c.id.length>64)throw new Error();return c;}catch{throw new Error('CUE 历史列表已变化，请重新读取');}}
 private next(snapshot:string,at:string,id:string):string{return Buffer.from(JSON.stringify({snapshot,at,id})).toString('base64url');}
 files(query:unknown='',cursor?:unknown):CueSourcePage{
  if(typeof query!=='string'||query.length>256||query.includes('\0'))throw new Error('无效CUE来源检索');
  const q=query.trim(),stamp=String((this.db.prepare('SELECT generation FROM cue_source_usage WHERE id=1').get() as {generation:number}).generation)+':'+q,c=this.cursor(cursor,stamp),term='%'+q.replace(/[\\%_]/g,'\\$&')+'%',activity="COALESCE(NULLIF(observed_at,''),registered_at)";
  const rows=this.db.prepare(`SELECT id,${activity} activity_at FROM cue_source_file WHERE EXISTS(SELECT 1 FROM cue_source_version v WHERE v.file_id=cue_source_file.id) AND relative_path LIKE ? ESCAPE '\\' AND (? IS NULL OR ${activity}<? OR (${activity}=? AND id<?)) ORDER BY ${activity} DESC,id DESC LIMIT 51`).all(term,c?.at??null,c?.at??'',c?.at??'',c?.id??'') as {id:string;activity_at:string}[];
  return {items:rows.slice(0,50).map(row=>this.source(row.id)),nextCursor:rows.length>50?this.next(stamp,rows[49].activity_at,rows[49].id):null,error:''};
 }

 versions(fileId:unknown,cursor?:unknown):CueVersionPage{const file=this.file(fileId),stamp=file.id+':'+file.revision+':'+String((this.db.prepare('SELECT count(*) n FROM cue_source_version WHERE file_id=?').get(file.id) as {n:number}).n),c=this.cursor(cursor,stamp);const rows=this.db.prepare(versionSelect+' WHERE v.file_id=? AND (? IS NULL OR v.created_at<? OR (v.created_at=? AND v.id<?)) ORDER BY v.created_at DESC,v.id DESC LIMIT 21').all(file.id,c?.at??null,c?.at??'',c?.at??'',c?.id??'') as VersionRow[];return {items:rows.slice(0,20).map(row=>this.summary(row)),nextCursor:rows.length>20?this.next(stamp,rows[19].created_at,rows[19].id):null};}
 preview(fileId:unknown,id:unknown,mode:unknown):CueSourcePreview{const v=this.versionRow(fileId,id),encoding=readCueEncoding(mode),row=this.db.prepare('SELECT raw_bytes FROM cue_source_asset WHERE id=?').get(v.asset_id) as {raw_bytes:Uint8Array};if(row.raw_bytes.length!==v.raw_size||digest(row.raw_bytes)!==v.asset_id)throw new Error('CUE 原文字节校验失败');let text='',error='',actual=encoding==='auto'?v.encoding:encoding;try{const decoded=decodeCueBytes(row.raw_bytes,encoding);actual=decoded.encoding;text=decoded.text;}catch(e){error=String(e instanceof Error?e.message:e).slice(0,500);}return {version:this.summary(v),encoding:actual,text:text.slice(0,131072),truncated:text.length>131072,error};}
 private sourceBundle(v:VersionRow,file:FileRow,raw:Buffer):CueSourceBundle {
  const bundle:CueSourceBundle={format:'aural-cue-source',version:1,fileId:v.file_id,versionId:v.id,versionDerivation:'v43',rootId:file.root_id,rootPath:v.root_snapshot,relativePath:v.path_snapshot,createdAt:v.created_at,sourceHash:v.asset_id,rawBytes:raw.length,rawBase64:raw.toString('base64'),encoding:v.encoding,requestedEncoding:v.requested_encoding,gapPolicy:readCueGapPolicy(v.gap_policy),parserVersion:v.parser_version,parseError:v.parse_error,parsedJson:v.parsed_json,parsedSha256:v.parsed_sha256};
  if(cueBundleVersion(bundle,'v43')!==v.id){if(bundle.gapPolicy!=='previous'||cueBundleVersion(bundle,'v42')!==v.id)throw new Error('CUE 来源版本摘要无效');bundle.versionDerivation='v42';}
  checkedCueSourceBundle(bundle);return bundle;
 }
 // Private Library value: full source never becomes a Renderer-controlled
 // write or play capability. The public review returns only bounded facts.
 reviewSource(value:unknown):{request:import('../shared/cue-version-review.js').CueVersionReviewRequest;source:CueSourceSummary;bundle:CueSourceBundle;parsed:ParsedCueSource} {
  const request=readCueVersionReviewRequest(value),source=this.source(request.fileId);
  if(source.revision!==request.baseRevision||source.latestVersion!==request.latestVersion)throw new Error('CUE 来源或解释设置已变化，请重新读取后复审');
  const file=this.file(request.fileId),v=this.versionRow(request.fileId,request.versionId),row=this.db.prepare('SELECT raw_bytes FROM cue_source_asset WHERE id=?').get(v.asset_id) as {raw_bytes:Uint8Array}|undefined;
  if(!row||row.raw_bytes.length!==v.raw_size||row.raw_bytes.length>2097152||digest(row.raw_bytes)!==v.asset_id)throw new Error('CUE 历史复审原文字节校验失败');
  const raw=Buffer.from(row.raw_bytes),bundle=this.sourceBundle(v,file,raw),parsed=interpretCueBytes(raw,request.encoding,request.gapPolicy);
  return {request,source,bundle,parsed};
 }
 export(value:unknown):CueSourceExportData {
  const request=readCueSourceExportRequest(value),v=this.versionRow(request.fileId,request.versionId),file=this.file(request.fileId),row=this.db.prepare('SELECT raw_bytes FROM cue_source_asset WHERE id=?').get(v.asset_id) as {raw_bytes:Uint8Array}|undefined;
  if(!row||row.raw_bytes.length!==v.raw_size||row.raw_bytes.length>2097152||digest(row.raw_bytes)!==v.asset_id)throw new Error('CUE 导出原文字节校验失败');
  const raw=Buffer.from(row.raw_bytes);let bytes=raw;
  if(request.kind==='bundle'){
   const bundle=this.sourceBundle(v,file,raw);bytes=Buffer.from(JSON.stringify(bundle,null,2)+'\n','utf8');
  }
  if(bytes.length>CUE_SOURCE_EXPORT_LIMIT)throw new Error('CUE 来源导出超过8MiB，请分别导出原文');return {...request,rawBase64:bytes.toString('base64'),sha256:digest(bytes),bytes:bytes.length};
 }
 origins(value:unknown):CueSourceOriginsPage {
  const r=readCueSourceOriginsRequest(value),file=this.file(r.fileId);this.versionRow(file.id,r.versionId);
  const stamp=file.id+':origins:'+r.versionId+':'+file.revision,c=this.cursor(r.cursor,stamp);
  const rows=this.db.prepare(`SELECT o.command_id,o.archive_sha,o.created_at,
   json_extract(CAST(a.archive_bytes AS TEXT),'$.versionId') original_version,
   json_extract(CAST(a.archive_bytes AS TEXT),'$.fileId') original_file,
   json_extract(CAST(a.archive_bytes AS TEXT),'$.rootId') original_root,
   json_extract(CAST(a.archive_bytes AS TEXT),'$.createdAt') original_at,
   substr(json_extract(CAST(a.archive_bytes AS TEXT),'$.rootPath'),1,1024) root_path,
   substr(json_extract(CAST(a.archive_bytes AS TEXT),'$.relativePath'),1,1024) relative_path,
   length(json_extract(CAST(a.archive_bytes AS TEXT),'$.rootPath')) root_length,
   length(json_extract(CAST(a.archive_bytes AS TEXT),'$.relativePath')) path_length,
   json_extract(CAST(a.archive_bytes AS TEXT),'$.sourceHash') source_hash,
   json_extract(CAST(a.archive_bytes AS TEXT),'$.rawBytes') raw_bytes
   FROM (SELECT command_id,archive_sha,created_at FROM cue_source_import_command WHERE target_file_id=? AND version_id=?
    UNION ALL SELECT command_id,archive_sha,created_at FROM cue_source_register_command WHERE target_file_id=? AND version_id=?) o
   JOIN cue_source_import_asset a ON a.id=o.archive_sha
   WHERE (? IS NULL OR o.created_at<? OR (o.created_at=? AND o.command_id<?)) ORDER BY o.created_at DESC,o.command_id DESC LIMIT 21`)
   .all(file.id,r.versionId,file.id,r.versionId,c?.at??null,c?.at??'',c?.at??'',c?.id??'') as Array<{command_id:string;archive_sha:string;created_at:string;original_version:string;original_file:string;original_root:string;original_at:string;root_path:string;relative_path:string;root_length:number;path_length:number;source_hash:string;raw_bytes:number}>;
  return {items:rows.slice(0,20).map(row=>({commandId:cueId(row.command_id),archiveSha256:cueHash(row.archive_sha),createdAt:row.created_at,originalVersionId:cueHash(row.original_version),originalFileId:cueId(row.original_file),originalRootId:cueId(row.original_root),originalCreatedAt:row.original_at,rootPath:row.root_path,relativePath:row.relative_path,sourceHash:cueHash(row.source_hash),rawBytes:row.raw_bytes,omitted:row.root_length>1024||row.path_length>1024})),nextCursor:rows.length>20?this.next(stamp,rows[19].created_at,rows[19].command_id):null};
 }
 private originArchive(value:unknown):{request:ReturnType<typeof readCueSourceOriginRequest>;bytes:Buffer;bundle:CueSourceBundle} {
  const request=readCueSourceOriginRequest(value);this.versionRow(request.fileId,request.versionId);
  const row=this.db.prepare(`SELECT a.id,a.archive_bytes FROM cue_source_import_asset a WHERE a.id IN(
   SELECT archive_sha FROM cue_source_import_command WHERE command_id=? AND target_file_id=? AND version_id=?
   UNION ALL SELECT archive_sha FROM cue_source_register_command WHERE command_id=? AND target_file_id=? AND version_id=?) LIMIT 2`)
   .all(request.commandId,request.fileId,request.versionId,request.commandId,request.fileId,request.versionId) as Array<{id:string;archive_bytes:Uint8Array}>;
  if(row.length!==1)throw new Error('原备份与所选来源、版本和导入命令不匹配');const bytes=Buffer.from(row[0].archive_bytes);
  if(bytes.length>CUE_SOURCE_EXPORT_LIMIT||digest(bytes)!==row[0].id)throw new Error('保存的原备份完整字节摘要不符');
  const text=bytes.toString('utf8');if(!Buffer.from(text,'utf8').equals(bytes))throw new Error('原备份不是完整UTF-8');
  const {bundle}=checkedCueSourceBundle(JSON.parse(text));if(!Buffer.from(JSON.stringify(bundle,null,2)+'\n').equals(bytes))throw new Error('原备份规范字节不符');return {request,bytes,bundle};
 }
 inspectOrigin(value:unknown):{inspection:import('../shared/cue-source-export.js').CueBundleInspection;bundle:CueSourceBundle;archiveSha256:string} {
  const {bytes,bundle}=this.originArchive(value),archiveSha256=digest(bytes);return {inspection:inspectCueSourceBundle(bundle,'已保存的原来源备份.json',archiveSha256),bundle,archiveSha256};
 }
 exportOrigin(value:unknown):CueSourceExportData {
  const {request,bytes}=this.originArchive(value);return {fileId:request.fileId,versionId:request.versionId,kind:'bundle',rawBase64:bytes.toString('base64'),sha256:digest(bytes),bytes:bytes.length};
 }
 receipt(value:unknown):CueInterpretResult|null{const r=readCueInterpretRequest(value),old=this.db.prepare('SELECT request_json,result_json FROM cue_interpret_command WHERE command_id=?').get(r.commandId) as {request_json:string;result_json:string}|undefined;if(!old)return null;if(old.request_json!==JSON.stringify(r))throw new Error('同一 CUE 操作不可改写');const result=JSON.parse(old.result_json) as CueInterpretResult;if(result.source)result.source={...result.source,gapPolicy:readCueGapPolicy(result.source.gapPolicy??'previous'),observedGapPolicy:readCueGapPolicy(result.source.observedGapPolicy??'previous'),selectedVersion:result.source.selectedVersion??null,selectionCommand:result.source.selectionCommand??null,selectedApplied:result.source.selectedApplied??false};return result;}
 configure(value:unknown):CueInterpretResult{const r=readCueInterpretRequest(value),old=this.receipt(r);if(old)return old;return this.transaction(()=>{if(this.db.prepare('SELECT 1 FROM cue_source_selection_command WHERE command_id=?').get(r.commandId))throw new Error('CUE解释UUID已用于原文选择');if(this.db.prepare('SELECT 1 FROM cue_source_import_command WHERE command_id=?').get(r.commandId))throw new Error('CUE解释UUID已用于来源导入');if(this.db.prepare('SELECT 1 FROM cue_source_register_command WHERE command_id=?').get(r.commandId))throw new Error('CUE解释UUID已用于来源登记');const current=this.source(r.fileId);if(current.revision!==r.baseRevision||current.latestVersion!==r.latestVersion)return {status:'rejected',source:current,error:'CUE 原文或设置已变化，请重新读取'};const reserved=this.db.prepare('UPDATE cue_source_usage SET commands=commands+1 WHERE id=1 AND commands<65536').run();if(Number(reserved.changes)!==1)throw new Error('CUE 操作历史容量已满，已有回执保留');this.db.prepare('UPDATE cue_source_file SET encoding=?,gap_policy=?,selected_version=NULL,choice_command=NULL,revision=revision+1,scan_command=? WHERE id=?').run(r.encoding,r.gapPolicy??'previous',r.commandId,r.fileId);this.bump();const result:CueInterpretResult={status:'saved',source:this.source(r.fileId),error:''};this.db.prepare('INSERT INTO cue_interpret_command VALUES(?,?,?,?)').run(r.commandId,JSON.stringify(r),JSON.stringify(result),new Date().toISOString());return result;});}
 pendingScans():Array<{rootId:string;commandId:string}>{return this.db.prepare('SELECT f.root_id rootId,min(f.scan_command) commandId FROM cue_source_file f WHERE f.scan_command IS NOT NULL AND NOT EXISTS(SELECT 1 FROM scan_command c WHERE c.command_id=f.scan_command) GROUP BY f.root_id ORDER BY min(f.observed_at),f.root_id LIMIT 64').all() as Array<{rootId:string;commandId:string}>;}
}
