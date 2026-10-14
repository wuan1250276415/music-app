import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogRepository} from './catalog.js';
import type {GenreRef,GenreSummary,GenreDetail,GenreListRequest,GenrePage,GenreEditRequest,CatalogChangeResult} from '../shared/contracts.js';

export const normalizeGenre=(name:string):string=>name.normalize('NFKC').toLowerCase().trim();
const id=(value:unknown):void=>{if(typeof value!=='string'||!value.length||value.length>128)throw new Error('无效风格 ID');};
const memberships=`SELECT ig.item_id,ig.genre_id,ig.source,ig.revision FROM item_genre ig
 UNION ALL SELECT p.id,rg.genre_id,'release:'||rg.source,rg.revision FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release_genre rg ON rg.release_id=m.release_id`;
const subtree=`WITH RECURSIVE descendants(id) AS (SELECT id FROM genre WHERE id=? UNION SELECT g.id FROM genre g JOIN descendants d ON g.parent_id=d.id)`;

export const genreSchema=`
 ALTER TABLE genre ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0);
 ALTER TABLE genre ADD COLUMN customized INTEGER NOT NULL DEFAULT 0 CHECK(customized IN(0,1));
 ALTER TABLE genre ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1));
 CREATE INDEX idx_genre_parent ON genre(parent_id,normalized_name,id);
 CREATE INDEX idx_release_genre_reverse ON release_genre(genre_id,release_id);
 CREATE TABLE genre_name_alias(normalized_name TEXT PRIMARY KEY,genre_id TEXT NOT NULL REFERENCES genre(id) ON DELETE RESTRICT,name TEXT NOT NULL);
 CREATE INDEX idx_genre_alias_owner ON genre_name_alias(genre_id,normalized_name);
 INSERT INTO genre_name_alias SELECT normalized_name,id,name FROM genre;
 CREATE TRIGGER genre_alias_immutable_update BEFORE UPDATE ON genre_name_alias BEGIN SELECT RAISE(ABORT,'genre alias is immutable'); END;
 CREATE TRIGGER genre_alias_immutable_delete BEFORE DELETE ON genre_name_alias BEGIN SELECT RAISE(ABORT,'genre alias is immutable'); END;
 CREATE TRIGGER genre_identity_restrict BEFORE DELETE ON genre BEGIN SELECT RAISE(ABORT,'archive genre instead of deleting identity'); END;
 CREATE TRIGGER genre_parent_insert BEFORE INSERT ON genre BEGIN
  SELECT CASE WHEN NEW.parent_id=NEW.id OR EXISTS(SELECT 1 FROM genre WHERE id=NEW.parent_id AND archived=1) THEN RAISE(ABORT,'invalid genre parent') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM genre_name_alias WHERE normalized_name=NEW.normalized_name AND genre_id<>NEW.id) THEN RAISE(ABORT,'genre name is reserved') END;
 END;
 CREATE TRIGGER genre_parent_update BEFORE UPDATE ON genre BEGIN
  SELECT CASE WHEN NEW.parent_id=NEW.id OR EXISTS(SELECT 1 FROM genre WHERE id=NEW.parent_id AND archived=1) THEN RAISE(ABORT,'invalid genre parent') END;
  SELECT CASE WHEN EXISTS(WITH RECURSIVE parents(id,parent_id) AS (SELECT id,parent_id FROM genre WHERE id=NEW.parent_id UNION SELECT g.id,g.parent_id FROM genre g JOIN parents p ON g.id=p.parent_id) SELECT 1 FROM parents WHERE id=NEW.id) THEN RAISE(ABORT,'genre cycle') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM genre_name_alias WHERE normalized_name=NEW.normalized_name AND genre_id<>NEW.id) THEN RAISE(ABORT,'genre name is reserved') END;
  SELECT CASE WHEN NEW.archived=1 AND (EXISTS(SELECT 1 FROM genre WHERE parent_id=NEW.id) OR EXISTS(SELECT 1 FROM item_genre WHERE genre_id=NEW.id) OR EXISTS(SELECT 1 FROM release_genre WHERE genre_id=NEW.id)) THEN RAISE(ABORT,'genre still has members or children') END;
 END;
 CREATE TRIGGER genre_alias_insert AFTER INSERT ON genre BEGIN INSERT OR IGNORE INTO genre_name_alias VALUES(NEW.normalized_name,NEW.id,NEW.name); END;
 CREATE TRIGGER genre_alias_update AFTER UPDATE OF name,normalized_name ON genre BEGIN INSERT OR IGNORE INTO genre_name_alias VALUES(NEW.normalized_name,NEW.id,NEW.name); END;
 CREATE TRIGGER item_genre_active BEFORE INSERT ON item_genre BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM genre WHERE id=NEW.genre_id AND archived=1) THEN RAISE(ABORT,'genre is archived') END; END;
 CREATE TRIGGER release_genre_active BEFORE INSERT ON release_genre BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM genre WHERE id=NEW.genre_id AND archived=1) THEN RAISE(ABORT,'genre is archived') END; END;
 CREATE TRIGGER item_genre_active_update BEFORE UPDATE OF genre_id ON item_genre BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM genre WHERE id=NEW.genre_id AND archived=1) THEN RAISE(ABORT,'genre is archived') END; END;
 CREATE TRIGGER release_genre_active_update BEFORE UPDATE OF genre_id ON release_genre BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM genre WHERE id=NEW.genre_id AND archived=1) THEN RAISE(ABORT,'genre is archived') END; END;
 CREATE TABLE genre_change(id TEXT PRIMARY KEY,action TEXT NOT NULL CHECK(action IN('genre-create','genre-profile','genre-archive','undo')),title TEXT NOT NULL,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),after_json TEXT NOT NULL CHECK(json_valid(after_json)),created_at INTEGER NOT NULL,undone_at INTEGER);
`;

export function validateGenreTree(db:DatabaseSync):void{
 // The depth bound also detects pre-existing cycles without unbounded recursion.
 const invalid=db.prepare(`WITH RECURSIVE ancestors(start,id,parent_id,depth) AS (SELECT id,id,parent_id,0 FROM genre UNION ALL SELECT a.start,g.id,g.parent_id,a.depth+1 FROM ancestors a JOIN genre g ON g.id=a.parent_id WHERE a.depth<63) SELECT 1 FROM ancestors WHERE parent_id=start OR depth=63 AND parent_id IS NOT NULL LIMIT 1`).get();
 if(invalid)throw new Error('原有风格层级存在循环或超过 64 层，升级已停止');
}

export function ensureGenre(db:DatabaseSync,name:string,aliases=false):{id:string;name:string}{
 const normalized=normalizeGenre(name);
 const old=db.prepare(aliases?'SELECT g.id,g.name,g.archived FROM genre_name_alias a JOIN genre g ON g.id=a.genre_id WHERE a.normalized_name=?':'SELECT id,name FROM genre WHERE normalized_name=?').get(normalized) as {id:string;name:string;archived?:number}|undefined;
 if(old){
  // A newly assigned tag explicitly uses an existing identity again; its custom parent/name stay intact.
  if(old.archived===1)db.prepare('UPDATE genre SET archived=0,revision=revision+1 WHERE id=?').run(old.id);
  return {id:old.id,name:old.name};
 }
 const genreId=randomUUID();db.prepare('INSERT INTO genre(id,name,normalized_name) VALUES(?,?,?)').run(genreId,name,normalized);return {id:genreId,name};
}

type GenreRow={id:string;name:string;normalized_name:string;parent_id:string|null;revision:number;customized:number;archived:number};
type Snapshot={genre:GenreRow|null;ref:GenreRef|null;items:Array<{itemId:string;revision:number}>};
export class GenreRepository{
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly refreshSearch:(itemId:string)=>void){}
 private row(genreId:string):GenreRow{id(genreId);const row=this.db.prepare('SELECT * FROM genre WHERE id=?').get(genreId) as GenreRow|undefined;if(!row)throw new Error('风格不存在');return row;}
 private summary(row:GenreRow):GenreSummary{
  const parent=row.parent_id?this.row(row.parent_id):null;
  const count=(this.db.prepare(`SELECT COUNT(DISTINCT j.item_id) n FROM (${memberships}) j JOIN playable_item p ON p.id=j.item_id WHERE j.genre_id=? AND p.visible=1 AND p.library_state='active'`).get(row.id) as {n:number}).n;
  const childCount=(this.db.prepare('SELECT COUNT(*) n FROM genre WHERE parent_id=? AND archived=0').get(row.id) as {n:number}).n;
  return {id:row.id,name:row.name,parentId:row.parent_id,parentName:parent?.name??null,customized:row.customized===1,archived:row.archived===1,childCount,count};
 }
 private fingerprint(row:GenreRow):string{
  const hash=createHash('sha256');hash.update(JSON.stringify(row));
  for(const value of this.db.prepare('SELECT normalized_name,name FROM genre_name_alias WHERE genre_id=? ORDER BY normalized_name').iterate(row.id))hash.update(JSON.stringify(value));
  for(const value of this.db.prepare(`${subtree} SELECT g.id,g.revision,g.parent_id,g.archived FROM genre g JOIN descendants d ON d.id=g.id ORDER BY g.id`).iterate(row.id))hash.update(JSON.stringify(value));
  for(const value of this.db.prepare(`${subtree} SELECT j.*,p.visible,COALESCE(s.revision,0) item_revision FROM (${memberships}) j JOIN descendants d ON d.id=j.genre_id JOIN playable_item p ON p.id=j.item_id LEFT JOIN item_catalog_state s ON s.item_id=p.id ORDER BY j.item_id,j.genre_id,j.source,j.revision`).iterate(row.id))hash.update(JSON.stringify(value));
  // Unused release classifications must also participate in dependency checks.
  for(const value of this.db.prepare(`${subtree} SELECT rg.* FROM release_genre rg JOIN descendants d ON d.id=rg.genre_id ORDER BY rg.release_id,rg.genre_id,rg.source`).iterate(row.id))hash.update(JSON.stringify(value));
  let parentId=row.parent_id;for(let depth=0;parentId&&depth<64;depth++){const parent=this.row(parentId);hash.update(JSON.stringify([parent.id,parent.revision,parent.parent_id,parent.archived]));parentId=parent.parent_id;}
  return hash.digest('hex');
 }
 private reference(row:GenreRow):GenreRef{return {genreId:row.id,revision:row.revision,fingerprint:this.fingerprint(row)};}
 private checked(ref:GenreRef):GenreRow{if(!ref||!Number.isSafeInteger(ref.revision)||ref.revision<0||typeof ref.fingerprint!=='string')throw new Error('无效风格修订');const row=this.row(ref.genreId);if(row.revision!==ref.revision||this.fingerprint(row)!==ref.fingerprint)throw new Error('风格、层级或关联曲目已变化，请刷新后重新确认');return row;}
 list(request:GenreListRequest={}):GenrePage{
  if(!request||typeof request!=='object'||request.query!==undefined&&(typeof request.query!=='string'||request.query.length>256)||request.includeArchived!==undefined&&typeof request.includeArchived!=='boolean')throw new Error('无效风格查询');
  const query=normalizeGenre(request.query??''),scope=JSON.stringify([query,request.parentId??null,request.parentId!==undefined,request.includeArchived===true]);
  const params:Array<string|number|null>=[],where:string[]=[];
  if(!request.includeArchived)where.push('g.archived=0');
  if(query){where.push("(g.normalized_name LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM genre_name_alias a WHERE a.genre_id=g.id AND a.normalized_name LIKE ? ESCAPE '\\'))");const pattern=`%${query.replace(/[\\%_]/g,'\\$&')}%`;params.push(pattern,pattern);}
  if(request.parentId!==undefined){if(request.parentId!==null)id(request.parentId);where.push('g.parent_id IS ?');params.push(request.parentId);}
  if(request.cursor!==undefined){if(typeof request.cursor!=='string'||request.cursor.length>8192)throw new Error('无效风格分页');let cursor:unknown;try{cursor=JSON.parse(Buffer.from(request.cursor,'base64url').toString('utf8'));}catch{throw new Error('无效风格分页');}if(!Array.isArray(cursor)||cursor.length!==3||cursor[0]!==scope||typeof cursor[1]!=='string'||typeof cursor[2]!=='string')throw new Error('分页条件已变化，请从第一页读取');where.push('(g.normalized_name>? OR g.normalized_name=? AND g.id>?)');params.push(cursor[1],cursor[1],cursor[2]);}
  const rows=this.db.prepare(`SELECT g.* FROM genre g ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY g.normalized_name,g.id LIMIT 51`).all(...params) as unknown as GenreRow[];
  const more=rows.length>50;rows.splice(50);const last=rows.at(-1);return {items:rows.map(row=>this.summary(row)),nextCursor:more&&last?Buffer.from(JSON.stringify([scope,last.normalized_name,last.id])).toString('base64url'):null};
 }
 get(genreId:string):GenreDetail{
  const row=this.row(genreId),ancestors:Array<{id:string;name:string}>=[];let parentId=row.parent_id;
  for(let depth=0;parentId&&depth<64;depth++){const parent=this.row(parentId);ancestors.unshift({id:parent.id,name:parent.name});parentId=parent.parent_id;}
  const subtreeCount=(this.db.prepare(`${subtree} SELECT COUNT(DISTINCT j.item_id) n FROM (${memberships}) j JOIN descendants d ON d.id=j.genre_id JOIN playable_item p ON p.id=j.item_id WHERE p.visible=1 AND p.library_state='active'`).get(genreId) as {n:number}).n;
  const aliases=(this.db.prepare('SELECT name FROM genre_name_alias WHERE genre_id=? ORDER BY normalized_name').all(genreId) as unknown as Array<{name:string}>).map(value=>value.name);
  return {...this.reference(row),genre:this.summary(row),parent:row.parent_id?this.reference(this.row(row.parent_id)):null,ancestors,aliases,subtreeCount};
 }
 private members(genreId:string):string[]{return (this.db.prepare(`${subtree} SELECT DISTINCT j.item_id FROM (${memberships}) j JOIN descendants d ON d.id=j.genre_id ORDER BY j.item_id LIMIT 5001`).all(genreId) as unknown as Array<{item_id:string}>).map(row=>row.item_id);}
 private snapshot(genreId:string,items:string[]):Snapshot{const genre=this.row(genreId);return {genre,ref:this.reference(genre),items:items.map(itemId=>({itemId,revision:this.catalog.project([itemId]).get(itemId)?.revision??0}))};}
 private refresh(items:string[]):void{for(const itemId of items){this.catalog.refreshRevision(itemId);this.refreshSearch(itemId);}}
 private name(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.trim().length>240||/[\u0000-\u001f\u007f]/.test(value))throw new Error('风格名称需为 1–240 个字符');return value.trim();}
 private parent(ref:GenreRef|null,genreId?:string):string|null{
  if(ref===null)return null;const parent=this.checked(ref);if(parent.archived===1)throw new Error('父级风格已归档');
  let current:string|null=parent.id,depth=0;while(current){if(current===genreId)throw new Error('不能将风格移动到自己或自己的子风格下');depth++;if(depth>=64)throw new Error('风格层级最多 64 层');current=this.row(current).parent_id;}
  if(genreId){const height=(this.db.prepare(`WITH RECURSIVE d(id,depth) AS (SELECT id,1 FROM genre WHERE id=? UNION ALL SELECT g.id,d.depth+1 FROM genre g JOIN d ON g.parent_id=d.id) SELECT MAX(depth) height FROM d`).get(genreId) as {height:number}).height;if(depth+height>64)throw new Error('移动后风格层级将超过 64 层');}
  return parent.id;
 }
 private command(commandId:string,identity:unknown,action:()=>CatalogChangeResult):CatalogChangeResult{
  if(typeof commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效风格命令 ID');const fingerprint=createHash('sha256').update(JSON.stringify(['genre',identity])).digest('hex');this.db.exec('BEGIN IMMEDIATE');
  try{const prior=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;if(prior){if(prior.fingerprint!==fingerprint)throw new Error('命令 ID 已用于不同操作');this.db.exec('COMMIT');return JSON.parse(prior.result_json);}const result=action();this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)').run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 private save(action:string,title:string,before:Snapshot,genreId:string,items:string[]):CatalogChangeResult{const after=this.snapshot(genreId,items),changeId=randomUUID();this.db.prepare('INSERT INTO genre_change(id,action,title,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(changeId,action,title,JSON.stringify(before),JSON.stringify(after),Date.now());return {changeId,genreId,items:after.items};}
 edit(request:GenreEditRequest):CatalogChangeResult{
  if(!request||!['genre-create','genre-profile','genre-archive'].includes(request.action))throw new Error('无效风格操作');return this.command(request.commandId,request,()=>{
   if(request.action==='genre-create'){const name=this.name(request.name),parentId=this.parent(request.parent);if(this.db.prepare('SELECT 1 FROM genre_name_alias WHERE normalized_name=?').get(normalizeGenre(name)))throw new Error('名称已被现有风格或旧标签使用，请选择现有分类');const genreId=randomUUID();this.db.prepare('INSERT INTO genre(id,name,normalized_name,parent_id,customized) VALUES(?,?,?,?,1)').run(genreId,name,normalizeGenre(name),parentId);return this.save(request.action,name,{genre:null,ref:null,items:[]},genreId,[]);}
   const row=this.checked(request.genre),items=this.members(row.id);if(items.length>5000)throw new Error('该分类关联超过 5000 首曲目，需要批量任务支持后再编辑');const before=this.snapshot(row.id,items);
   if(request.action==='genre-archive'){if(typeof request.archived!=='boolean')throw new Error('无效归档状态');if(row.archived===Number(request.archived))throw new Error('风格归档状态没有变化');if(request.archived&&this.db.prepare('SELECT 1 FROM genre WHERE parent_id=? UNION ALL SELECT 1 FROM item_genre WHERE genre_id=? UNION ALL SELECT 1 FROM release_genre WHERE genre_id=? LIMIT 1').get(row.id,row.id,row.id))throw new Error('风格仍有关联曲目、发行分类或子分类，不能归档');this.db.prepare('UPDATE genre SET archived=?,customized=1,revision=revision+1 WHERE id=?').run(Number(request.archived),row.id);}
   else{if(row.archived)throw new Error('请先恢复已归档风格');const name=this.name(request.name),parentId=this.parent(request.parent,row.id);if(name===row.name&&parentId===row.parent_id)throw new Error('风格资料没有变化');const reserved=this.db.prepare('SELECT genre_id FROM genre_name_alias WHERE normalized_name=?').get(normalizeGenre(name)) as {genre_id:string}|undefined;if(reserved&&reserved.genre_id!==row.id)throw new Error('名称已被其他风格或旧标签使用，请选择不同名称');this.db.prepare('UPDATE genre SET name=?,normalized_name=?,parent_id=?,customized=1,revision=revision+1 WHERE id=?').run(name,normalizeGenre(name),parentId,row.id);}
   this.refresh(items);return this.save(request.action,row.name,before,row.id,items);
  });
 }
 owns(changeId:string):boolean{id(changeId);return Boolean(this.db.prepare('SELECT 1 FROM genre_change WHERE id=?').get(changeId));}
 undo(changeId:string,commandId:string):CatalogChangeResult{return this.command(commandId,['undo',changeId],()=>{
  const change=this.db.prepare('SELECT * FROM genre_change WHERE id=?').get(changeId) as {action:string;title:string;before_json:string;after_json:string;undone_at:number|null}|undefined;
  if(!change||change.action==='undo'||change.undone_at!==null)throw new Error('风格修订不存在或已撤销');const before:Snapshot=JSON.parse(change.before_json),after:Snapshot=JSON.parse(change.after_json);if(!after.genre||!after.ref)throw new Error('风格审计不完整');const row=this.checked(after.ref),items=after.items.map(value=>value.itemId),current=this.snapshot(row.id,items);
  if(before.genre){const original=before.genre;this.parent(original.parent_id?this.reference(this.row(original.parent_id)):null,row.id);this.db.prepare('UPDATE genre SET name=?,normalized_name=?,parent_id=?,customized=?,archived=?,revision=revision+1 WHERE id=?').run(original.name,original.normalized_name,original.parent_id,original.customized,original.archived,row.id);}
  else this.db.prepare('UPDATE genre SET archived=1,revision=revision+1 WHERE id=?').run(row.id);
  this.refresh(items);this.db.prepare('UPDATE genre_change SET undone_at=? WHERE id=?').run(Date.now(),changeId);return this.save('undo',`撤销 ${change.title}`,current,row.id,items);
 });}
}
