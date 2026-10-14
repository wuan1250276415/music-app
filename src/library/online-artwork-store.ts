import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ArtworkCandidate,CoverArtImagePreview} from '../shared/contracts.js';
import {ONLINE_ARTWORK_RIGHTS,readOnlineArtworkCommand,type OnlineArtworkCommand,type OnlineArtworkMode,type OnlineArtworkSource,type OnlineArtworkState,type OnlineArtworkResult} from '../shared/online-artwork.js';
import {retentionState} from './provider-retention.js';

export const onlineArtworkSchema=`
 CREATE TABLE online_artwork_asset(id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1024),height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1024),bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 2097152),content BLOB NOT NULL CHECK(typeof(content)='blob' AND length(content)=bytes));
 CREATE TABLE online_artwork_source(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,asset_id TEXT NOT NULL REFERENCES online_artwork_asset(id),source_token TEXT NOT NULL CHECK(length(source_token)=64 AND source_token NOT GLOB '*[^0-9a-f]*'),release_id TEXT NOT NULL,image_id TEXT NOT NULL,source_url TEXT NOT NULL,fetched_at TEXT NOT NULL,confirmed_at TEXT NOT NULL,rights_json TEXT NOT NULL CHECK(json_valid(rights_json)));
 CREATE TABLE online_artwork_selection(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE CASCADE,revision INTEGER NOT NULL CHECK(revision>=1),source_id TEXT REFERENCES online_artwork_source(id),mode TEXT NOT NULL CHECK(mode IN('fallback','preferred')));
 CREATE TABLE online_artwork_change(id TEXT PRIMARY KEY,item_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN('apply','clear','mode','undo')),revision INTEGER NOT NULL CHECK(revision>=1),before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),undo_of TEXT UNIQUE REFERENCES online_artwork_change(id),created_at TEXT NOT NULL,command_id TEXT NOT NULL UNIQUE REFERENCES user_command_receipt(command_id) DEFERRABLE INITIALLY DEFERRED,request_json TEXT NOT NULL CHECK(json_valid(request_json)),UNIQUE(item_id,revision));
 CREATE INDEX online_artwork_source_owner ON online_artwork_source(item_id,asset_id);
 CREATE INDEX online_artwork_change_page ON online_artwork_change(item_id,revision DESC);
 CREATE TRIGGER online_artwork_source_immutable BEFORE UPDATE ON online_artwork_source BEGIN SELECT RAISE(ABORT,'封面来源不可改写'); END;
 CREATE TRIGGER online_artwork_source_no_delete BEFORE DELETE ON online_artwork_source BEGIN SELECT RAISE(ABORT,'封面来源不可删除'); END;
 CREATE TRIGGER online_artwork_change_immutable BEFORE UPDATE ON online_artwork_change BEGIN SELECT RAISE(ABORT,'封面修改记录不可改写'); END;
 CREATE TRIGGER online_artwork_change_no_delete BEFORE DELETE ON online_artwork_change BEGIN SELECT RAISE(ABORT,'封面修改记录不可删除'); END;
`;
type Selection={sourceId:string|null;mode:OnlineArtworkMode};
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const LIMIT_BYTES=256*1024*1024,LIMIT_ASSETS=8192,LIMIT_CHANGES=32768;
export class OnlineArtworkStore{
 private readonly leases=new Map<string,{itemId:string;assetId:string}>();
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 private item(itemId:string):void{if(typeof itemId!=='string'||!itemId||itemId.length>128||!this.db.prepare('SELECT 1 FROM playable_item WHERE id=?').get(itemId))throw new Error('封面曲目不存在');}
 private selection(itemId:string):{revision:number;value:Selection}{const row=this.db.prepare('SELECT revision,source_id,mode FROM online_artwork_selection WHERE item_id=?').get(itemId) as {revision:number;source_id:string|null;mode:OnlineArtworkMode}|undefined;return row?{revision:row.revision,value:{sourceId:row.source_id,mode:row.mode}}:{revision:0,value:{sourceId:null,mode:'fallback'}};}
 revision(itemId:string):number{return this.selection(itemId).revision;}
 private source(id:string|null):OnlineArtworkSource|null{
  if(!id)return null;const row=this.db.prepare('SELECT s.*,a.width,a.height FROM online_artwork_source s JOIN online_artwork_asset a ON a.id=s.asset_id WHERE s.id=?').get(id) as Record<string,any>|undefined;if(!row)throw new Error('在线封面来源缺失');
  const rights=JSON.parse(row.rights_json);if(JSON.stringify(rights)!==JSON.stringify(ONLINE_ARTWORK_RIGHTS))throw new Error('在线封面操作范围无效');
  return {id:row.id,assetId:row.asset_id,sourceToken:row.source_token,releaseId:row.release_id,imageId:row.image_id,sourceUrl:row.source_url,fetchedAt:row.fetched_at,confirmedAt:row.confirmed_at,width:row.width,height:row.height,rights};
 }
 state(itemId:string):OnlineArtworkState{
  this.item(itemId);const current=this.selection(itemId);
  const changes=this.db.prepare('SELECT c.id,c.action,c.created_at,c.revision,u.id undo_id FROM online_artwork_change c LEFT JOIN online_artwork_change u ON u.undo_of=c.id WHERE c.item_id=? ORDER BY c.revision DESC LIMIT 30').all(itemId) as Array<{id:string;action:'apply'|'clear'|'mode'|'undo';created_at:string;revision:number;undo_id:string|null}>;
  return {itemId,revision:current.revision,mode:current.value.mode,source:this.source(current.value.sourceId),changes:changes.map(row=>({id:row.id,action:row.action,createdAt:row.created_at,canUndo:row.revision===current.revision&&!row.undo_id}))};
 }
 private identity(request:OnlineArtworkCommand):string{return onlineArtworkCommandFingerprint(request);}
 receipt(raw:unknown):OnlineArtworkResult|null{
  const request=readOnlineArtworkCommand(raw),row=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(request.commandId) as {fingerprint:string;result_json:string}|undefined;if(!row)return null;
  if(row.fingerprint!==this.identity(request))throw new Error('命令 ID 已用于不同封面操作');const result=JSON.parse(row.result_json);
  if(!result||!uuid.test(result.changeId)||!this.db.prepare('SELECT 1 FROM online_artwork_change WHERE id=? AND item_id=?').get(result.changeId,request.itemId))throw new Error('封面操作回执无效');
  return {changeId:result.changeId,replayed:true,state:this.state(request.itemId)};
 }
 command(raw:unknown,image?:CoverArtImagePreview):OnlineArtworkResult{
  const request=readOnlineArtworkCommand(raw);return this.transaction(()=>{
   const replay=this.receipt(request);if(replay)return replay;this.item(request.itemId);
   const before=this.selection(request.itemId);if(before.revision!==request.baseRevision)throw new Error('封面修订已变化，请刷新');
   if(Number(this.db.prepare('SELECT COUNT(*) n FROM online_artwork_change').get()!.n)>=LIMIT_CHANGES)throw new Error('已保存封面历史达到上限，请管理曲库空间');
   const now=new Date().toISOString();let after:Selection={sourceId:null,mode:'fallback'},undoOf:string|null=null;
   if(request.action==='apply'){
    if(retentionState(this.db,'cover-art-archive').mode!=='reviewed')throw new Error('请在来源保存设置中允许保存明确选定的封面');
    const validated=validateOnlineArtworkImage(image,request.itemId),assetId=digest(validated.bytes);
    const existing=this.db.prepare('SELECT width,height,content FROM online_artwork_asset WHERE id=?').get(assetId) as {width:number;height:number;content:Uint8Array}|undefined;
    if(existing){if(existing.width!==image!.width||existing.height!==image!.height||!Buffer.from(existing.content).equals(validated.bytes))throw new Error('在线封面资源与已有内容不同');}
    else this.db.prepare('INSERT INTO online_artwork_asset VALUES(?,?,?,?,?)').run(assetId,image!.width,image!.height,validated.bytes.length,validated.bytes);
    const totals=this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) n FROM online_artwork_asset').get()!;if(Number(totals.bytes)>LIMIT_BYTES||Number(totals.n)>LIMIT_ASSETS)throw new Error('确认保存的封面空间已满；当前封面与历史保持');
    const sourceId=randomUUID();this.db.prepare('INSERT INTO online_artwork_source VALUES(?,?,?,?,?,?,?,?,?,?)').run(sourceId,request.itemId,assetId,image!.token,image!.releaseId,image!.imageId,image!.sourceUrl,image!.fetchedAt,now,JSON.stringify(ONLINE_ARTWORK_RIGHTS));
    after={sourceId,mode:request.mode};
   }else if(request.action==='mode'){
    if(!before.value.sourceId)throw new Error('当前尚未保存在线封面');after={sourceId:before.value.sourceId,mode:request.mode};
   }else if(request.action==='undo'){
    const change=this.db.prepare('SELECT item_id,revision,before_json,after_json FROM online_artwork_change WHERE id=?').get(request.changeId) as {item_id:string;revision:number;before_json:string;after_json:string}|undefined;
    if(!change||change.item_id!==request.itemId||change.revision!==before.revision||change.after_json!==JSON.stringify(before.value)||this.db.prepare('SELECT 1 FROM online_artwork_change WHERE undo_of=?').get(request.changeId))throw new Error('此修改之后已有封面变化，不能覆盖当前选择');
    after=readOnlineArtworkSelection(JSON.parse(change.before_json));if(after.sourceId){const owner=this.db.prepare('SELECT item_id FROM online_artwork_source WHERE id=?').get(after.sourceId);if(owner?.item_id!==request.itemId)throw new Error('旧封面来源不属于当前曲目');this.source(after.sourceId);}undoOf=request.changeId;
   }
   const revision=before.revision+1,changeId=randomUUID();
   this.db.prepare('INSERT INTO online_artwork_selection VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET revision=excluded.revision,source_id=excluded.source_id,mode=excluded.mode').run(request.itemId,revision,after.sourceId,after.mode);
   this.db.prepare('INSERT INTO online_artwork_change VALUES(?,?,?,?,?,?,?,?,?,?)').run(changeId,request.itemId,request.action,revision,JSON.stringify(before.value),JSON.stringify(after),undoOf,now,request.commandId,JSON.stringify(request));
   this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(request.commandId,this.identity(request),JSON.stringify({changeId}),now);
   return {changeId,replayed:false,state:this.state(request.itemId)};
  });
 }
 lookup(itemId:string,rejected:ReadonlySet<string>,mode:OnlineArtworkMode,state:ArtworkCandidate['cacheState']='stored'):ArtworkCandidate|null{
  const current=this.selection(itemId);if(current.value.mode!==mode||!current.value.sourceId)return null;const source=this.source(current.value.sourceId)!;
  if(rejected.has(source.sourceToken)||!this.read(itemId,source.assetId))return null;
  return {url:`aural-artwork://image/${source.assetId}.jpg`,token:source.sourceToken,sourceKind:'online',label:mode==='preferred'?'用户选定的在线封面':'补缺的在线封面',width:source.width,height:source.height,cacheState:state};
 }
 owns(itemId:string,assetId:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM online_artwork_source WHERE item_id=? AND asset_id=? LIMIT 1').get(itemId,assetId));}
 read(itemId:string,assetId:string):Buffer|null{
  if(!/^[0-9a-f]{64}$/.test(assetId)||!this.owns(itemId,assetId))return null;const row=this.db.prepare('SELECT bytes,content,width,height FROM online_artwork_asset WHERE id=? AND bytes BETWEEN 1 AND 2097152 AND length(content)=bytes').get(assetId) as {bytes:number;content:Uint8Array;width:number;height:number}|undefined;if(!row)return null;
  const bytes=Buffer.from(row.content);if(bytes.length!==row.bytes||digest(bytes)!==assetId||!validConvertedJpeg(bytes,row.width,row.height))throw new Error('已保存在线封面字节无效');return bytes;
 }
 lease(consumer:string,itemId:string,assetId:string,retain:boolean):void{
  if(!uuid.test(consumer)||!/^[0-9a-f]{64}$/.test(assetId))throw new Error('无效在线封面租约');const prior=this.leases.get(consumer);
  if(prior&&(prior.itemId!==itemId&&retain||prior.assetId!==assetId))throw new Error('封面租约不能改绑');
  if(!retain){this.leases.delete(consumer);return;}if(prior)return;
  this.item(itemId);if(!this.owns(itemId,assetId)||this.leases.size>=256)throw new Error('在线封面不属于当前曲目或租约已满');this.leases.set(consumer,{itemId,assetId});
 }
 resetLeases():void{this.leases.clear();}
}
export function readOnlineArtworkSelection(value:unknown):Selection{
 const v=value as Selection;if(!v||typeof v!=='object'||Object.keys(v).length!==2||v.sourceId!==null&&(typeof v.sourceId!=='string'||!uuid.test(v.sourceId))||!['fallback','preferred'].includes(v.mode))throw new Error('在线封面选择记录无效');return {sourceId:v.sourceId,mode:v.mode};
}
export function validateOnlineArtworkImage(value:CoverArtImagePreview|undefined,itemId:string):{bytes:Buffer}{
 if(!value||value.itemId!==itemId||!uuid.test(value.candidateToken)||!/^[0-9a-f]{64}$/.test(value.fingerprint)||!uuid.test(value.releaseId)||value.releaseId!==value.releaseId.toLowerCase()||!/^[1-9][0-9]{0,19}$/.test(value.imageId)||value.sourceUrl!==`https://musicbrainz.org/release/${value.releaseId}/cover-art`||!Number.isFinite(Date.parse(value.fetchedAt))||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.now()||Date.parse(value.fetchedAt)>Date.now()+1000||value.rights?.status!=='unverified'||value.rights.display!==true||value.rights.persist!==false||value.rights.export!==false||!/^[0-9a-f]{64}$/.test(value.token)||!Number.isSafeInteger(value.width)||value.width<1||value.width>1024||!Number.isSafeInteger(value.height)||value.height<1||value.height>1024||typeof value.url!=='string'||value.url.length>3*1024*1024||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.url))throw new Error('在线封面保存预览无效或已到期');
 const encoded=value.url.slice('data:image/jpeg;base64,'.length),bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>2097152||bytes.toString('base64')!==encoded||!validConvertedJpeg(bytes,value.width,value.height))throw new Error('在线封面保存字节无效');return {bytes};
}
export function onlineArtworkCommandFingerprint(request:OnlineArtworkCommand):string{return digest('online-artwork-v1:'+JSON.stringify(readOnlineArtworkCommand(request)));}
function validConvertedJpeg(bytes:Buffer,width:number,height:number):boolean{
 if(bytes.length<15||bytes.length>2097152||bytes[0]!==255||bytes[1]!==216||!Number.isSafeInteger(width)||width<1||width>1024||!Number.isSafeInteger(height)||height<1||height>1024)return false;
 for(let at=2,segments=0;at<bytes.length&&segments++<1024;){
  if(bytes[at++]!==255)return false;while(bytes[at]===255)at++;const marker=bytes[at++];if(marker===0xda||marker===0xd9||marker===undefined)return false;if(marker===1||marker>=0xd0&&marker<=0xd7)continue;
  if(at+2>bytes.length)return false;const length=bytes.readUInt16BE(at);if(length<2||at+length>bytes.length)return false;
  if([0xc0,0xc1,0xc2].includes(marker))return length>=8&&bytes[at+2]===8&&bytes.readUInt16BE(at+3)===height&&bytes.readUInt16BE(at+5)===width;
  at+=length;
 }return false;
}
export function validateOnlineArtworkDatabase(db:DatabaseSync,check:()=>void):number{
 let rows=0;const step=()=>{check();if(++rows>200000)throw new Error('在线封面恢复资料超过检查预算');};
 for(const [table,columns] of [['online_artwork_source',['id','item_id','source_token','release_id','image_id','source_url','fetched_at','confirmed_at','rights_json']],['online_artwork_change',['id','item_id','before_json','after_json','command_id','request_json']],['online_artwork_selection',['item_id','source_id','mode']]] as Array<[string,string[]]>)for(const column of columns){check();if(db.prepare(`SELECT 1 FROM ${table} WHERE length(CAST(${column} AS BLOB))>4096 LIMIT 1`).get())throw new Error('在线封面恢复字段超过预算');}
 if(db.prepare('SELECT 1 FROM online_artwork_change c JOIN user_command_receipt r ON r.command_id=c.command_id WHERE length(CAST(r.result_json AS BLOB))>4096 LIMIT 1').get())throw new Error('在线封面恢复操作回执超过预算');
 const totals=db.prepare('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) n FROM online_artwork_asset').get()!;
 if(Number(totals.bytes)>LIMIT_BYTES||Number(totals.n)>LIMIT_ASSETS||db.prepare('SELECT 1 FROM online_artwork_asset WHERE bytes NOT BETWEEN 1 AND 2097152 OR length(content)<>bytes LIMIT 1').get())throw new Error('在线封面恢复资源超过预算');
 for(const row of db.prepare('SELECT id,width,height,content FROM online_artwork_asset').iterate()){
  step();const bytes=Buffer.from(row.content as Uint8Array);if(digest(bytes)!==row.id||!validConvertedJpeg(bytes,Number(row.width),Number(row.height)))throw new Error('在线封面恢复图片指纹或尺寸无效');
 }
 for(const row of db.prepare('SELECT * FROM online_artwork_source').iterate()){
  step();if(!uuid.test(String(row.id))||typeof row.item_id!=='string'||!row.item_id||row.item_id.length>128||!/^[0-9a-f]{64}$/.test(String(row.source_token))||!uuid.test(String(row.release_id))||row.release_id!==String(row.release_id).toLowerCase()||!/^[1-9][0-9]{0,19}$/.test(String(row.image_id))||row.source_url!==`https://musicbrainz.org/release/${row.release_id}/cover-art`||!Number.isFinite(Date.parse(String(row.fetched_at)))||!Number.isFinite(Date.parse(String(row.confirmed_at)))||String(row.rights_json).length>4096||JSON.stringify(JSON.parse(String(row.rights_json)))!==JSON.stringify(ONLINE_ARTWORK_RIGHTS))throw new Error('在线封面恢复来源或操作范围无效');
 }
 const sources=(itemId:string,value:Selection)=>{if(value.sourceId&&db.prepare('SELECT item_id FROM online_artwork_source WHERE id=?').get(value.sourceId)?.item_id!==itemId)throw new Error('在线封面恢复选择不属于曲目');};
 const previous=new Map<string,{revision:number;after:string}>();let changes=0;
 for(const row of db.prepare('SELECT c.*,r.fingerprint,r.result_json FROM online_artwork_change c LEFT JOIN user_command_receipt r ON r.command_id=c.command_id ORDER BY c.item_id,c.revision').iterate()){
  step();if(++changes>LIMIT_CHANGES||!uuid.test(String(row.id))||typeof row.item_id!=='string'||row.item_id.length>128||!Number.isFinite(Date.parse(String(row.created_at)))||[row.before_json,row.after_json,row.request_json,row.result_json].some(v=>typeof v!=='string'||v.length>4096))throw new Error('在线封面恢复修改记录无效');
  const itemId=row.item_id,before=readOnlineArtworkSelection(JSON.parse(row.before_json as string)),after=readOnlineArtworkSelection(JSON.parse(row.after_json as string)),request=readOnlineArtworkCommand(JSON.parse(row.request_json as string)),prior=previous.get(itemId);
  if(row.revision!==(prior?.revision??0)+1||row.before_json!==(prior?.after??JSON.stringify({sourceId:null,mode:'fallback'}))||request.itemId!==itemId||request.action!==row.action||request.baseRevision!==Number(row.revision)-1||request.commandId!==row.command_id||row.fingerprint!==onlineArtworkCommandFingerprint(request)||JSON.parse(String(row.result_json)).changeId!==row.id)throw new Error('在线封面恢复修订链或原操作回执不符');
  sources(itemId,before);sources(itemId,after);
  if(request.action==='undo'){
   const original=db.prepare('SELECT item_id,revision,before_json,after_json FROM online_artwork_change WHERE id=?').get(request.changeId);
   if(row.undo_of!==request.changeId||!original||original.item_id!==itemId||original.revision!==Number(row.revision)-1||original.after_json!==row.before_json||original.before_json!==row.after_json)throw new Error('在线封面恢复撤销链无效');
  }else if(row.undo_of!==null||request.action==='apply'&&(after.sourceId===null||after.mode!==request.mode)||request.action==='clear'&&(after.sourceId!==null||after.mode!=='fallback')||request.action==='mode'&&(!before.sourceId||after.sourceId!==before.sourceId||after.mode!==request.mode))throw new Error('在线封面恢复操作与选择不符');
  previous.set(itemId,{revision:Number(row.revision),after:row.after_json as string});
 }
 for(const row of db.prepare('SELECT * FROM online_artwork_selection').iterate()){
  step();const value={sourceId:row.source_id as string|null,mode:row.mode as OnlineArtworkMode},prior=previous.get(String(row.item_id));readOnlineArtworkSelection(value);sources(String(row.item_id),value);
  if(!prior||row.revision!==prior.revision||JSON.stringify(value)!==prior.after)throw new Error('在线封面恢复当前选择不是最后修订');
 }
 // Deleted playable items may retain immutable history, but live items must have their last selection.
 if(db.prepare('SELECT 1 FROM online_artwork_change c JOIN playable_item p ON p.id=c.item_id LEFT JOIN online_artwork_selection s ON s.item_id=c.item_id WHERE s.item_id IS NULL LIMIT 1').get())throw new Error('在线封面恢复缺少当前选择');return rows;
}
