import {validateRecognitionRetries} from './recognition-retry.js';
import {validateRecognitionMappings} from './recognition-mapping.js';
import {validateMetadataRecognitionDatabase} from './metadata-recognition.js';
import {validateMetadataWorkflowDatabase} from './metadata-workflow.js';
import {CATALOG_RESTORE_POLICY_KEY,readCatalogRestorePolicy} from '../shared/catalog-restore-policy.js';
import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {LibraryDatabase} from './database.js';
import {validateOnlineArtworkDatabase} from './online-artwork-store.js';
import {verifyLibrarySchema,type LibrarySchemaObject} from './schema-snapshot.js';
import {inspectCatalogBackupDatabase} from './catalog-backup-database.js';
import {providerBackupComponents,providerManifest,ProviderSettings} from './providers.js';
import {retentionState} from './provider-retention.js';
import {LibraryWatchStore} from './library-watch-store.js';
import {PlaybackPolicies} from './playback-policy.js';
import {validateGenreTree} from './genres.js';
import {readLyricsPreference} from './lyrics-preferences.js';
import {validQueueState} from '../shared/queue-state.js';
import {readMediaKeyPreference} from '../shared/media-key-preference.js';
import {readCatalogViewPreference} from '../shared/catalog-browse.js';
import {readAppearancePreference} from '../shared/appearance.js';
import {readWindowPlacementPreference} from '../shared/window-placement.js';
import {readDesktopPreference} from '../shared/desktop-preference.js';
import {validateAudioOutputPreference} from '../shared/audio-output.js';
import {validateAsioOutputPreference} from '../shared/asio-output.js';
import {readAudioBackendPreference} from '../shared/audio-backend.js';
import {readDsdOutputPreference} from '../shared/dsd-output.js';
import {readSmartPlaylistDefinition} from '../shared/smart-playlists.js';
import {readFilterPresetDetail} from '../shared/filter-presets.js';
import {readPlaybackPolicy,readPlaybackPolicyRequest} from '../shared/playback-policy.js';
import {backupUuid,readCatalogBackupManifest,type CatalogBackupManifest} from '../shared/catalog-backup.js';
import {RELEASE} from '../shared/release.js';
import {assertRestoreCompatibility,restoreAppVersionSupported,RESTORE_DOMAIN_SCOPES,type CatalogRestoreCompatibility,type RestoreDomainScope} from '../shared/catalog-restore-compatibility.js';

type Row=Record<string,SQLInputValue>;
const forbidWrite=<T>(_action:()=>T):T=>{throw new Error('恢复兼容性检查禁止修改数据库');};
function revision(v:unknown):void{if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)throw new Error('恢复资料修订无效');}
function text(v:unknown,max:number):string{if(typeof v!=='string'||!v||v.length>max||v.includes('\0'))throw new Error('恢复资料文字无效');return v;}
// Created inside a supervised restore worker or the private dormant Library,
// from this build's trusted empty migrations. Candidate inspection stays read-only;
// a dormant Library connection is constructed only after these checks pass.
export class CatalogRestoreCompatibilityInspector{
 private readonly reference:LibrarySchemaObject[];
 constructor(){this.reference=LibraryDatabase.restoreSchemaReference();}
 inspect(filename:string,rawManifest:CatalogBackupManifest,signal:AbortSignal):CatalogRestoreCompatibility{
  const manifest=readCatalogBackupManifest(rawManifest),providersSupported=providerBackupComponents(),components=[{id:'aural.core',version:manifest.appVersion},...providersSupported];
  if(manifest.schema!==80)throw new Error('此备份为旧schema68/69/70/71/72/73/74/75/76/77/78/79，可核对和保留；整库应用需要先显式迁移，暂停恢复流程不会自动迁移');
  if(!restoreAppVersionSupported(manifest.appVersion))throw new Error('备份来自更高版本应用，当前版本不能恢复');
  if(JSON.stringify(components)!==JSON.stringify(manifest.plugins))throw new Error('备份数据源组件及版本与当前构建不一致');
  const rows=Object.fromEntries(RESTORE_DOMAIN_SCOPES.map(id=>[id,0])) as Record<RestoreDomainScope,number>;let totalRows=0,totalBytes=0,schema:{objects:number;sha256:string}|undefined;
  const check=()=>signal.throwIfAborted();
  const walk=(db:DatabaseSync,scope:RestoreDomainScope,sql:string,validate:(row:Row)=>void)=>{
   for(const row of db.prepare(sql).iterate()){
    check();if(++totalRows>5000000)throw new Error('恢复领域资料超过500万条检查预算');rows[scope]++;
    for(const value of Object.values(row))if(typeof value==='string'){if(Buffer.byteLength(value)>1024*1024)throw new Error('恢复领域单字段超过1MiB检查预算');totalBytes+=Buffer.byteLength(value);}
    if(totalBytes>512*1024*1024)throw new Error('恢复领域资料超过512MiB读取预算');validate(row);
   }
  };
  inspectCatalogBackupDatabase(filename,manifest,db=>{check();schema=verifyLibrarySchema(db,this.reference,check);},db=>{
   // Fixed identifiers only. Check byte lengths in SQL before JS materialization.
   const bounded=(table:string,column:string,limit=1024*1024)=>{check();if(db.prepare(`SELECT 1 FROM ${table} WHERE length(CAST(${column} AS BLOB))>? LIMIT 1`).get(limit))throw new Error('恢复资料超过字段预算：'+table+'.'+column);};
   bounded('app_setting','key',1024);bounded('app_setting','value');
   bounded('library_root','id',512);bounded('library_root','path',131072);
   for(const [table,columns] of [['playlist',['id','name']],['playlist_smart_history',['playlist_id','name']],['music_filter_preset',['id','name','created_at','updated_at']],['lyrics_preference',['scope']]] as Array<[string,string[]]>)for(const column of columns)bounded(table,column,1024);
   for(const table of ['provider_setting','provider_retention'])bounded(table,'provider_id',512);
   for(const table of ['metadata_recognition_run','metadata_recognition_item','metadata_recognition_command','metadata_recognition_mapping','metadata_recognition_progress','metadata_recognition_retry'])walk(db,'background-recognition',`SELECT * FROM ${table}`,()=>{});validateMetadataRecognitionDatabase(db,check);validateRecognitionMappings(db,check);validateRecognitionRetries(db,check);
   for(const table of ['metadata_workflow','metadata_workflow_item','metadata_workflow_command'])walk(db,'metadata-workflows',`SELECT * FROM ${table}`,()=>{});validateMetadataWorkflowDatabase(db,check);
   const watch=new LibraryWatchStore(db,forbidWrite),settings=new ProviderSettings(db);
   const readers:Record<string,(v:unknown)=>unknown>={media_key_preference:readMediaKeyPreference,catalog_view_preference:readCatalogViewPreference,appearance_preference:readAppearancePreference,window_placement:readWindowPlacementPreference,desktop_preference:readDesktopPreference};
   walk(db,'settings','SELECT key,value FROM app_setting',r=>{
    const key=text(r.key,256);if(typeof r.value!=='string')throw new Error('恢复设置值无效');const value=r.value;
    if(Object.hasOwn(readers,key)){readers[key](JSON.parse(value));return;}
    if(key==='playback_queue'){if(value.length>200000||!validQueueState(JSON.parse(value)))throw new Error('恢复播放队列无效');return;}
    if(key==='provider_credential_scope'){if(value!==settings.scope)throw new Error('恢复凭据范围无效');return;}
    if(key===CATALOG_RESTORE_POLICY_KEY){const policy=readCatalogRestorePolicy(JSON.parse(value));if(policy.origin!==manifest.origin||policy.credentialScope!==settings.scope)throw new Error('恢复激活策略与曲库来源或凭据范围不同');return;}
    if(key==='metadata_network_enabled'){if(!['true','false'].includes(value))throw new Error('恢复网络设置无效');return;}
    if(key==='musicbrainz_contact')return;
    if(key.startsWith('library_watch:')){const id=key.slice('library_watch:'.length),root=db.prepare('SELECT id,path FROM library_root WHERE id=?').get(id) as {id:string;path:string}|undefined;if(!root)throw new Error('恢复监听记录缺少原目录');watch.load(root);return;}
    throw new Error('备份含当前构建不识别的设置：'+key);
   });
   const outputs:Array<[string,(v:unknown)=>unknown]>=[['audio_output_setting',validateAudioOutputPreference],['asio_output_setting',validateAsioOutputPreference],['audio_backend_setting',readAudioBackendPreference],['dsd_output_setting',readDsdOutputPreference]];
   for(const [table,reader] of outputs){bounded(table,'value_json',262144);let n=0;walk(db,'outputs',`SELECT id,value_json FROM ${table}`,r=>{if(++n>1||r.id!==1)throw new Error('恢复输出设置身份无效');reader(JSON.parse(text(r.value_json,262144)));});}
   const providerIds=providersSupported.map(c=>c.id.slice('provider.'.length));let providers=0,retentions=0;
   walk(db,'providers','SELECT provider_id,enabled,revision FROM provider_setting',r=>{const id=text(r.provider_id,128);if(!providerIds.includes(id))throw new Error('恢复数据源未注册');const m=providerManifest(id as Parameters<typeof providerManifest>[0]);revision(r.revision);if(r.enabled!==0&&r.enabled!==1||r.enabled===1&&!m.ready)throw new Error('恢复数据源启用状态无效');providers++;});
   walk(db,'providers','SELECT provider_id,mode,revision FROM provider_retention',r=>{const id=text(r.provider_id,128);if(!providerIds.includes(id))throw new Error('恢复保存策略数据源未注册');const state=retentionState(db,id as Parameters<typeof retentionState>[1]);if(state.mode==='reviewed'&&!providerManifest(id as Parameters<typeof providerManifest>[0]).ready)throw new Error('恢复保存策略尚不受当前数据源支持');retentions++;});
   if(providers!==providersSupported.length||retentions!==providersSupported.length)throw new Error('恢复数据源或保存策略缺失');
   for(const [table,column] of [['playlist','filter_json'],['playlist_smart_history','definition_json'],['music_filter_preset','definition_json']] as const)bounded(table,column,65536);
   walk(db,'playlists','SELECT id,name,kind,revision,filter_json FROM playlist',r=>{backupUuid(r.id);text(r.name,120);revision(r.revision);if(r.kind==='smart')readSmartPlaylistDefinition(JSON.parse(text(r.filter_json,65536)));else if(r.kind!=='static'||r.filter_json!==null)throw new Error('恢复歌单类型或规则无效');});
   if(db.prepare("SELECT 1 FROM playlist_item i JOIN playlist p ON p.id=i.playlist_id WHERE p.kind!='static' LIMIT 1").get()||db.prepare('SELECT 1 FROM playlist_item GROUP BY playlist_id HAVING MIN(position)<>0 OR MAX(position)<>COUNT(*)-1 LIMIT 1').get())throw new Error('恢复静态歌单条目或顺序无效');
   walk(db,'playlists','SELECT playlist_id,revision,name,definition_json FROM playlist_smart_history',r=>{backupUuid(r.playlist_id);revision(r.revision);text(r.name,120);readSmartPlaylistDefinition(JSON.parse(text(r.definition_json,65536)));});
   walk(db,'filter-presets','SELECT id,name,revision,created_at,updated_at,definition_json FROM music_filter_preset',r=>{if(rows['filter-presets']>1024)throw new Error('恢复筛选预设超过1024条');readFilterPresetDetail({id:r.id,name:r.name,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,definition:JSON.parse(text(r.definition_json,65536))});});
   bounded('playback_counting_policy','value_json',16384);const policies=new PlaybackPolicies(db,forbidWrite);let last=-1;
   if(db.prepare('SELECT 1 FROM playback_counting_policy p JOIN user_command_receipt r ON r.command_id=p.command_id WHERE length(CAST(r.result_json AS BLOB))>16384 OR length(CAST(r.fingerprint AS BLOB))>64 LIMIT 1').get())throw new Error('恢复统计口径回执超过预算');
   walk(db,'counting-policy','SELECT p.revision,p.value_json,p.command_id,r.fingerprint,r.result_json FROM playback_counting_policy p LEFT JOIN user_command_receipt r ON r.command_id=p.command_id ORDER BY p.revision',r=>{
    if(rows['counting-policy']>65536||r.revision!==last+1)throw new Error('恢复统计口径历史不连续');const policy=readPlaybackPolicy(JSON.parse(text(r.value_json,16384)));
    if(policy.revision!==r.revision||policy.revision===0&&r.command_id!==null||policy.revision>0&&r.command_id===null)throw new Error('恢复统计口径身份无效');
    if(policy.revision>0){const request=readPlaybackPolicyRequest({commandId:r.command_id,baseRevision:policy.revision-1,rule:policy.rule}),fingerprint=createHash('sha256').update('playback-counting-policy-v2:').update(JSON.stringify(request)).digest('hex');if(r.fingerprint!==fingerprint||JSON.stringify(readPlaybackPolicy(JSON.parse(text(r.result_json,16384))))!==JSON.stringify(policy))throw new Error('恢复统计口径与原操作回执不符');}last=policy.revision;
   });
   if(last<0||policies.load().revision!==last)throw new Error('恢复当前统计口径不是最新已保存修订');
   bounded('lyrics_preference','preference_json',65536);
   walk(db,'lyrics-preferences','SELECT scope,revision,preference_json FROM lyrics_preference',r=>{if(typeof r.scope!=='string'||!/^[a-f0-9]{64}$/.test(r.scope))throw new Error('恢复歌词设置范围无效');revision(r.revision);readLyricsPreference(JSON.parse(text(r.preference_json,65536)));});
   rows['online-artwork']=validateOnlineArtworkDatabase(db,check);totalRows+=rows['online-artwork'];
   check();validateGenreTree(db);
   if(db.prepare('SELECT 1 FROM genre g WHERE g.archived=1 AND (EXISTS(SELECT 1 FROM genre c WHERE c.parent_id=g.id) OR EXISTS(SELECT 1 FROM item_genre i WHERE i.genre_id=g.id) OR EXISTS(SELECT 1 FROM release_genre r WHERE r.genre_id=g.id)) LIMIT 1').get())throw new Error('恢复归档风格仍有成员或子项');
   rows['genre-tree']=Number((db.prepare('SELECT COUNT(*) n FROM genre').get() as {n:number}).n);totalRows+=rows['genre-tree'];if(totalRows>5000000)throw new Error('恢复领域资料超过500万条检查预算');check();
  });
  if(!schema)throw new Error('恢复结构检查未完成');return assertRestoreCompatibility({version:1,appVersion:RELEASE.appVersion,schema:80,schemaSha256:schema.sha256,schemaObjects:schema.objects,databaseSha256:manifest.files.find(f=>f.role==='database')!.sha256,components,domains:RESTORE_DOMAIN_SCOPES.map(id=>({id,rows:rows[id]}))},manifest);
 }
}
