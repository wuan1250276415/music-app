import type {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {CATALOG_RESTORE_POLICY_KEY,CATALOG_RESTORE_POLICY_BYTES,readCatalogRestorePolicy,type CatalogRestorePolicy} from '../shared/catalog-restore-policy.js';
import {LibraryWatchStore} from './library-watch-store.js';
import {providerBackupComponents} from './providers.js';
import type {CatalogRestoreActivationRequest} from '../platform/catalog-restore-activation.js';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
// This is a persistent import policy, not an OS grant. Historical jobs, leases,
// command receipts and managed artifacts remain available for explicit review.
export class CatalogRestorePolicyRepository{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 load():CatalogRestorePolicy|null{
  const row=this.db.prepare('SELECT value FROM app_setting WHERE key=?').get(CATALOG_RESTORE_POLICY_KEY) as {value:string}|undefined;
  if(!row)return null;if(Buffer.byteLength(row.value)>CATALOG_RESTORE_POLICY_BYTES)throw new Error('恢复激活策略超过1MiB');return readCatalogRestorePolicy(JSON.parse(row.value));
 }
 rootAuthorized(root:{id:string;path:string}):boolean{
  const policy=this.load(),prior=policy?.roots.find(r=>r.id===root.id);if(!prior)return true;
  const watch=new LibraryWatchStore(this.db,this.transaction).load(root);
  return root.path===prior.path&&watch.path===root.path&&watch.revision>prior.watchRevision&&watch.anchor!==null;
 }
 assertRoot(root:{id:string;path:string}):void{if(!this.rootAuthorized(root))throw new Error('此目录来自恢复备份，请在自动更新设置中重新选择并确认目录后再读取或扫描');}
 scanAllowed(sequence:number):boolean{const policy=this.load();return !policy||sequence>policy.scanSequence;}
 scanFloor():number{return this.load()?.scanSequence??0;}
 assertTagJob(jobId:string):void{
  const policy=this.load();if(!policy)return;
  const row=this.db.prepare('SELECT rowid AS n FROM tag_write_job WHERE id=?').get(jobId) as {n:number}|undefined;
  if(!row||row.n<=policy.tagRowid)throw new Error('此写回任务来自恢复备份，旧计划和工件已隔离；请先审核恢复记录，不能重放原文件操作');
 }
 assertCredentialCommand(commandId:string):void{
  const policy=this.load();if(!policy)return;
  const row=this.db.prepare('SELECT rowid AS n FROM provider_credential_command WHERE command_id=?').get(commandId) as {n:number}|undefined;
  if(row&&row.n<=policy.credentialRowid)throw new Error('此凭据操作属于恢复前的凭据范围，请刷新后使用新操作重新设置');
 }
 apply(request:CatalogRestoreActivationRequest,sourceManifestSha256:string,origin:string):CatalogRestorePolicy{
  if(request.role!=='candidate'||!request.credentialScope)throw new Error('只有导入候选库需要新的恢复策略');
  return this.transaction(()=>{
   const previous=this.load();if(previous?.activationId===request.activationId){if(previous.requestSha256!==digest(request)||previous.sourceManifestSha256!==sourceManifestSha256||previous.origin!==origin)throw new Error('恢复激活身份已用于不同请求');return previous;}
   const oldCredentialScope=(this.db.prepare("SELECT value FROM app_setting WHERE key='provider_credential_scope'").get() as {value:string}|undefined)?.value;
   const roots=this.db.prepare('SELECT id,path FROM library_root ORDER BY id COLLATE BINARY LIMIT 4097').all() as Array<{id:string;path:string}>;
   if(roots.length>4096)throw new Error('恢复目录超过4096项审核预算');const paths=new Map(roots.map(root=>[root.id,root.path]));
   const watch=new LibraryWatchStore(this.db,this.transaction),records=roots.map(root=>watch.load(root));
   const maximum=(table:'scan_job'|'tag_write_job'|'provider_credential_command'|'metadata_observation'|'metadata_collection_observation',column:'seq'|'rowid')=>Number((this.db.prepare(`SELECT COALESCE(MAX(${column}),0) n FROM ${table}`).get() as {n:number}).n);
   const policy=readCatalogRestorePolicy({format:'aural-restored-library-policy',version:2,activationId:request.activationId,operationId:request.operationId,requestSha256:digest(request),sourceManifestSha256,origin,createdAt:new Date().toISOString(),priorPolicySha256:previous?digest(previous):null,oldCredentialScope,credentialScope:request.credentialScope,scanSequence:maximum('scan_job','seq'),tagRowid:maximum('tag_write_job','rowid'),credentialRowid:maximum('provider_credential_command','rowid'),observationRowid:maximum('metadata_observation','rowid'),collectionObservationRowid:maximum('metadata_collection_observation','rowid'),roots:records.map(r=>({id:r.rootId,path:paths.get(r.rootId)!,watchRevision:r.revision+1}))});
   const encoded=JSON.stringify(policy);if(Buffer.byteLength(encoded)>CATALOG_RESTORE_POLICY_BYTES)throw new Error('恢复激活策略超过1MiB');
   if(this.db.prepare("SELECT 1 FROM scan_job WHERE status IN('queued','running','cancelling') AND revision>=? LIMIT 1").get(Number.MAX_SAFE_INTEGER-1))throw new Error('扫描任务修订已耗尽，保留资料等待审核');
   // A new scan can be explicitly requested after directory confirmation. Old
   // checkpoints stay inspectable and cannot be resumed as imported work.
   this.db.prepare("UPDATE scan_job SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'interrupted' END,owner=NULL,lease_until=NULL,revision=revision+1,updated_at=?,message='任务来自恢复备份，检查点保留；请确认目录后重新扫描' WHERE status IN('queued','running','cancelling')").run(Date.now());
   this.db.prepare("UPDATE library_root SET status='online' WHERE status='scanning'").run();
   for(const r of records){r.revision++;r.path=paths.get(r.rootId)!;r.enabled=false;r.anchor=null;r.launch=null;r.lastCommand=null;r.paused='目录来自恢复备份，请重新选择并确认后启用';
    this.db.prepare('INSERT INTO app_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('library_watch:'+r.rootId,JSON.stringify(r));
   }
   for(const component of providerBackupComponents()){
    const id=component.id.slice('provider.'.length),before=this.db.prepare('SELECT enabled,revision FROM provider_setting WHERE provider_id=?').get(id) as {enabled:number;revision:number}|undefined;
    if(!before||!Number.isSafeInteger(before.revision)||before.revision>=Number.MAX_SAFE_INTEGER-1)throw new Error('数据源设置缺失或修订已耗尽');
    this.db.prepare('UPDATE provider_setting SET enabled=0,revision=revision+1 WHERE provider_id=?').run(id);
    this.db.prepare('INSERT INTO provider_setting_change(id,provider_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),id,JSON.stringify({enabled:before.enabled===1,revision:before.revision}),JSON.stringify({enabled:false,revision:before.revision+1}),Date.now());
   }
   const save=this.db.prepare('INSERT INTO app_setting(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
   save.run('provider_credential_scope',request.credentialScope);save.run('metadata_network_enabled','false');save.run(CATALOG_RESTORE_POLICY_KEY,encoded);return policy;
  });
 }
}
