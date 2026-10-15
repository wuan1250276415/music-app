import {ProviderExtensionHost,type ProviderHostGrant} from './provider-extension-host.js';
import type {ProviderExtensionManifest} from '../shared/provider-extension.js';
import {acoustidPolicy} from './acoustid.js';
import {randomUUID,createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ProviderId,ProviderManifest,ProviderSettingRequest,ProviderCredentialRequest,ProviderCredentialResult,ProviderState} from '../shared/contracts.js';
import type {ProviderBroker} from './provider-broker.js';
import {musicBrainzPolicy} from './musicbrainz.js';
import {coverArtArchivePolicy} from './cover-art-archive.js';
import type {CredentialStore} from './credential-vault.js';

const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hostGrants:ProviderHostGrant[]=[
 {id:'musicbrainz',version:'1',capabilities:['isrc-lookup','recording-lookup','recording-search','recording-releases','recording-credit','release-context','release-credit'],permissions:{network:[{host:'musicbrainz.org',subdomains:false}],credentials:[]}},
 {id:'cover-art-archive',version:'2',capabilities:['release-index','release-image'],permissions:{network:[{host:'coverartarchive.org',subdomains:false},{host:'archive.org',subdomains:true}],credentials:[]}},
 {id:'acoustid',version:'1',capabilities:['lookup'],permissions:{network:[{host:'api.acoustid.org',subdomains:false}],credentials:['client-key']}}
];
function extension(id:ProviderId):ProviderExtensionManifest {
 const grant=hostGrants.find(g=>g.id===id)!;
 return {id:grant.id,version:grant.version,kind:'builtin-provider',apiVersion:{major:1,minor:0},hostApiRange:{major:1,minMinor:0,maxMinor:0},platforms:['win32'],architectures:['x64'],capabilities:[...grant.capabilities],permissions:structuredClone(grant.permissions)};
}
const manifests:ProviderManifest[]=([
 {id:'musicbrainz',name:'MusicBrainz',version:'1',ready:true,capabilities:[{kind:'metadata',ready:true,label:'录音候选、发行主署名和核心文本',retention:'查询预览仅短期内存；确认的白名单核心文本另按 CC0 快照保存'}],termsUrl:'https://musicbrainz.org/doc/MusicBrainz_API',credentialSlots:[],note:'查询按统一限速调度，需填写公开联系信息。'},
 {id:'cover-art-archive',name:'Cover Art Archive',version:'2',ready:true,capabilities:[{kind:'artwork',ready:true,label:'封面来源查询与图片选择',retention:'文字索引短期缓存；图片先预览，再明确保存为本机曲库封面，导出未开放'}],termsUrl:'https://musicbrainz.org/doc/Cover_Art_Archive',credentialSlots:[],note:'按选定发行版查询和预览图片。明确保存后保留来源与修改记录；逐图片许可未核实，不声明开放授权。'},
 {id:'acoustid',name:'AcoustID',version:'1',ready:true,capabilities:[{kind:'fingerprint',ready:true,label:'按音频指纹匹配录音',retention:'本地指纹和在线关联只作短期预览；确认字段从MusicBrainz另行读取；不提交指纹'}],termsUrl:'https://acoustid.org/webservice',credentialSlots:[{id:'client-key',label:'应用访问密钥'}],note:'本地Chromaprint按当前歌曲／CUE片段计算，仅发送指纹与时长；启用需自己的应用访问密钥。公共服务仅用于非商业用途；商业访问须按服务商方案接入。保存密钥不会开启查询，不贡献指纹。'}
] satisfies Array<Omit<ProviderManifest,'extension'>>).map(manifest=>({...manifest,extension:extension(manifest.id)}));
export function providerManifest(id:unknown):ProviderManifest{const manifest=manifests.find(value=>value.id===id);if(!manifest)throw new Error('数据源未注册');return structuredClone(manifest);}
export function registerProviders(broker:ProviderBroker):ProviderExtensionHost{for(const manifest of manifests){if(manifest.version!==manifest.extension.version||JSON.stringify(manifest.credentialSlots.map(s=>s.id).sort())!==JSON.stringify([...manifest.extension.permissions.credentials].sort()))throw new Error('数据源界面声明与宿主授权不一致');}return new ProviderExtensionHost(broker,[{manifest:extension('musicbrainz'),policy:musicBrainzPolicy},{manifest:extension('cover-art-archive'),policy:coverArtArchivePolicy},{manifest:extension('acoustid'),policy:acoustidPolicy}],hostGrants);}
export function providerBackupComponents():import('../shared/catalog-backup.js').BackupPlugin[]{return manifests.map(value=>({id:'provider.'+value.id,version:value.version})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);}
export const providerSchema=`
 CREATE TABLE provider_setting(provider_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0));
 INSERT INTO provider_setting(provider_id,enabled) VALUES('musicbrainz',CASE WHEN COALESCE((SELECT value FROM app_setting WHERE key='metadata_network_enabled'),'true')='false' THEN 0 ELSE 1 END),('cover-art-archive',0),('acoustid',0);
 CREATE TABLE provider_setting_change(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL);
 CREATE TABLE provider_credential_command(command_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,slot TEXT NOT NULL,operation TEXT NOT NULL CHECK(operation IN('set','remove')),fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','succeeded','unknown')),result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),created_at INTEGER NOT NULL);
 CREATE INDEX provider_credential_pending ON provider_credential_command(provider_id,slot,state);
 CREATE TRIGGER provider_setting_change_immutable BEFORE UPDATE ON provider_setting_change BEGIN SELECT RAISE(ABORT,'数据源设置审计不可改写'); END;
 CREATE TRIGGER provider_setting_change_no_delete BEFORE DELETE ON provider_setting_change BEGIN SELECT RAISE(ABORT,'数据源设置审计不可删除'); END;
 CREATE TRIGGER provider_credential_command_immutable BEFORE UPDATE OF command_id,provider_id,slot,operation,fingerprint,created_at ON provider_credential_command BEGIN SELECT RAISE(ABORT,'凭据操作身份不可改写'); END;
 CREATE TRIGGER provider_credential_command_no_delete BEFORE DELETE ON provider_credential_command BEGIN SELECT RAISE(ABORT,'凭据操作记录不可删除'); END;
`;
export class ProviderSettings {
 readonly scope:string;
 constructor(private readonly db:DatabaseSync){
  this.scope=(db.prepare("SELECT value FROM app_setting WHERE key='provider_credential_scope'").get() as {value:string}|undefined)?.value??'';
  if(!uuid.test(this.scope)||this.scope!==this.scope.toLowerCase())throw new Error('曲库凭据范围标识无效');
 }
 setting(id:ProviderId):{enabled:boolean;revision:number}{
  providerManifest(id);
  const row=this.db.prepare('SELECT enabled,revision FROM provider_setting WHERE provider_id=?').get(id) as {enabled:number;revision:number}|undefined;
  if(!row)throw new Error('数据源设置缺失');return {enabled:row.enabled===1,revision:row.revision};
 }
 configure(request:ProviderSettingRequest):void{
  if(!request||!uuid.test(request.commandId)||!Number.isSafeInteger(request.revision)||request.revision<0||typeof request.enabled!=='boolean')throw new Error('无效数据源设置');
  const manifest=providerManifest(request.providerId);
  if(request.enabled&&!manifest.ready)throw new Error('此数据源的能力和权限适配尚未完成，不能启用');
  const fingerprint=createHash('sha256').update(JSON.stringify(['provider-setting',request.providerId,request.revision,request.enabled])).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const prior=this.db.prepare('SELECT fingerprint FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string}|undefined;
   if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同设置');this.db.exec('COMMIT');return;}
   const current=this.setting(request.providerId);if(current.revision!==request.revision)throw new Error('数据源设置已变化，请刷新');
   this.db.prepare('UPDATE provider_setting SET enabled=?,revision=revision+1 WHERE provider_id=?').run(request.enabled?1:0,request.providerId);
   this.db.prepare('INSERT INTO provider_setting_change(id,provider_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),request.providerId,JSON.stringify(current),JSON.stringify(this.setting(request.providerId)),Date.now());
   this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(request.commandId,fingerprint,'{}',new Date().toISOString());
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}

type CredentialCommand={fingerprint:string;state:'pending'|'succeeded'|'unknown';result_json:string|null};
export class ProviderCredentials {
 private tail:Promise<void>=Promise.resolve();private queued=0;
 constructor(private readonly db:DatabaseSync,private readonly settings:ProviderSettings,private readonly vault:CredentialStore,private readonly assertCommand:(id:string)=>void=()=>{}){}
 async acoustidClientKey():Promise<Buffer>{if(this.queued||this.db.prepare("SELECT 1 FROM provider_credential_command WHERE provider_id='acoustid' AND slot='client-key' AND state!='succeeded' LIMIT 1").get())throw new Error('应用密钥操作未完成，请先在数据源设置核对');const key=await this.vault.read(this.settings.scope,'acoustid','client-key');if(!key?.length){key?.fill(0);throw new Error('请先在数据源设置保存AcoustID应用访问密钥');}return key;}
 async list():Promise<ProviderState[]>{
  const states:ProviderState[]=[];
  for(const manifest of manifests){
   const credentials=[];
   for(const slot of manifest.credentialSlots){
    const uncertain=(this.db.prepare("SELECT COUNT(*) AS count FROM provider_credential_command WHERE provider_id=? AND slot=? AND state!='succeeded'").get(manifest.id,slot.id) as {count:number}).count;
    try{credentials.push({slot:slot.id,present:this.vault.available()?await this.vault.has(this.settings.scope,manifest.id,slot.id):null,error:this.vault.available()?null:'凭据保管组件不可用',uncertain});}
    catch{credentials.push({slot:slot.id,present:null,error:'无法确认凭据状态',uncertain});}
   }
   states.push({manifest:structuredClone(manifest),...this.settings.setting(manifest.id),vaultAvailable:this.vault.available(),credentials});
  }
  return states;
 }
 execute(input:ProviderCredentialRequest):Promise<ProviderCredentialResult>{
  if(!input||!uuid.test(input.commandId)||!['set','remove'].includes(input.operation)||!providerManifest(input.providerId).credentialSlots.some(slot=>slot.id===input.slot)||input.operation==='set'&&(typeof input.secret!=='string'||!input.secret.trim()||Buffer.byteLength(input.secret,'utf8')>2048||/[\u0000-\u001f\u007f]/.test(input.secret))||input.operation==='remove'&&input.secret!==undefined)throw new Error('无效凭据请求');
  if(this.queued>=4)throw new Error('凭据操作队列已满');
  const request:ProviderCredentialRequest={commandId:input.commandId,providerId:input.providerId,slot:input.slot,operation:input.operation,secret:input.secret};
  input.secret=undefined;this.queued++;const deadline=Date.now()+30000;
  const result=this.tail.then(()=>{if(Date.now()>=deadline)throw new Error('凭据操作排队超时，尚未开始保存');return this.apply(request);});
  this.tail=result.then(()=>{},()=>{});
  return result.finally(()=>{this.queued--;request.secret=undefined;});
 }
 private async key():Promise<Buffer>{
  const candidate=randomBytes(32);
  try{const key=await this.vault.create(this.settings.scope,'aural','command-key',candidate);if(key.length!==32){key.fill(0);throw new Error('凭据命令校验密钥损坏');}return key;}
  finally{candidate.fill(0);}
 }
 private save(request:ProviderCredentialRequest,result:ProviderCredentialResult):ProviderCredentialResult{
  this.db.prepare('UPDATE provider_credential_command SET state=?,result_json=? WHERE command_id=?').run(result.state,JSON.stringify(result),request.commandId);return result;
 }
 private unknown(request:ProviderCredentialRequest):ProviderCredentialResult{
  return this.save(request,{commandId:request.commandId,providerId:request.providerId,slot:request.slot,state:'unknown',present:null,message:'凭据操作没有得到完整确认，可重试原操作核对结果'});
 }
 private async reconcile(request:ProviderCredentialRequest,secret:Buffer|null):Promise<ProviderCredentialResult>{
  const actual=await this.vault.read(this.settings.scope,request.providerId,request.slot);
  try{
   const matches=request.operation==='remove'?actual===null:actual!==null&&actual.length===secret!.length&&timingSafeEqual(actual,secret!);
   return this.save(request,{commandId:request.commandId,providerId:request.providerId,slot:request.slot,state:matches?'succeeded':'unknown',present:actual!==null,message:matches?null:'当前凭据与本次操作不能一致确认，请刷新后明确保存或移除'});
  }finally{actual?.fill(0);}
 }
 private async apply(request:ProviderCredentialRequest):Promise<ProviderCredentialResult>{
  this.assertCommand(request.commandId);
  const secret=request.operation==='set'?Buffer.from(request.secret!,'utf8'):null;let key:Buffer|undefined;
  try{
   key=await this.key();
   const fingerprint=createHmac('sha256',key).update(JSON.stringify([request.providerId,request.slot,request.operation])).update(secret??Buffer.alloc(0)).digest('hex');
   const prior=this.db.prepare('SELECT fingerprint,state,result_json FROM provider_credential_command WHERE command_id=?').get(request.commandId) as CredentialCommand|undefined;
   if(prior){
    if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同凭据操作');
    if(prior.state==='succeeded'&&prior.result_json)return {...JSON.parse(prior.result_json),replayed:true};
    // Never replay an uncertain OS write: check the current value first.
    try{return await this.reconcile(request,secret);}catch{return this.unknown(request);}
   }
   this.db.prepare("INSERT INTO provider_credential_command(command_id,provider_id,slot,operation,fingerprint,state,created_at) VALUES(?,?,?,?,?,'pending',?)").run(request.commandId,request.providerId,request.slot,request.operation,fingerprint,Date.now());
   try{
    if(secret)await this.vault.write(this.settings.scope,request.providerId,request.slot,secret);else await this.vault.remove(this.settings.scope,request.providerId,request.slot);
    return await this.reconcile(request,secret);
   }catch{return this.unknown(request);}
  }finally{key?.fill(0);secret?.fill(0);}
 }
}
