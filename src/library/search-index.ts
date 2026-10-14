import {sqlStatement} from './sql-statements.js';
import {updateSortIndex,SORT_ALGORITHM,type SortSource} from './natural-sort.js';
import {updateSpellingIndex,deleteSpellingIndex} from './search-spelling.js';
import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {SEARCH_ALGORITHM,RomanTextCache} from './search-text.js';
import type {SearchIndexState} from '../shared/search-index.js';
import {literalSearchVariants,shortHanSearchGrams} from './search-normalization.js';
export function updateLiteralSearchIndex(db:DatabaseSync,itemId:string,fields:string[],freshItem=false):void{
 if(!freshItem){sqlStatement(db,'DELETE FROM search_fts WHERE item_id=?').run(itemId);
 sqlStatement(db,'DELETE FROM search_gram WHERE item_id=?').run(itemId);}
 sqlStatement(db,'INSERT INTO search_fts(item_id,title,artist,album,genre) VALUES(?,?,?,?,?)').run(itemId,...fields.map(field=>literalSearchVariants(field).join('\n')));
 const insert=sqlStatement(db,'INSERT OR IGNORE INTO search_gram(gram,item_id) VALUES(?,?)');
 for(const gram of new Set(fields.flatMap(field=>[...shortHanSearchGrams(field)])))insert.run(gram,itemId);
}
export const searchIndexSchema=`
 CREATE TABLE search_latin(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE CASCADE,algorithm TEXT NOT NULL,fingerprint TEXT NOT NULL);
 CREATE VIRTUAL TABLE search_latin_fts USING fts5(item_id UNINDEXED,roman,initials,tokenize='trigram');
 CREATE TRIGGER search_latin_delete AFTER DELETE ON search_latin BEGIN DELETE FROM search_latin_fts WHERE item_id=OLD.item_id; END;
 CREATE TABLE search_index_state(id INTEGER PRIMARY KEY CHECK(id=1),algorithm TEXT NOT NULL,cursor TEXT NOT NULL,processed INTEGER NOT NULL CHECK(processed BETWEEN 0 AND 9007199254740991),status TEXT NOT NULL CHECK(status IN('building','ready','error')),message TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),content_revision INTEGER NOT NULL CHECK(content_revision BETWEEN 0 AND 9007199254740991));
 INSERT INTO search_index_state VALUES(1,'','',0,'building','',0,0);
`;
type Row={algorithm:string;cursor:string;processed:number;status:SearchIndexState['status'];message:string;revision:number;content_revision:number};
export type SearchSource={id:string;fields:string[];sort:SortSource};
type Ports={transaction:<T>(action:()=>T)=>T;sources:(ids:string[])=>SearchSource[]};
export class SearchIndex{
 private readonly cache=new RomanTextCache();
 constructor(private readonly db:DatabaseSync,private readonly ports:Ports,deferAlgorithm=false){
  if(deferAlgorithm)return;
  this.prepareAlgorithm();
 }
 prepareAlgorithm():void{const row=this.row();if(row.algorithm!==SEARCH_ALGORITHM)this.ports.transaction(()=>sqlStatement(this.db,"UPDATE search_index_state SET algorithm=?,cursor='',processed=0,status='building',message='',revision=revision+1,content_revision=content_revision+1 WHERE id=1").run(SEARCH_ALGORITHM));}
 private row():Row{return sqlStatement(this.db,'SELECT algorithm,cursor,processed,status,message,revision,content_revision FROM search_index_state WHERE id=1').get() as Row;}
 state():SearchIndexState{const r=this.row();return {version:1,algorithm:r.algorithm,revision:Number(r.revision),status:r.status,processed:Number(r.processed),message:r.message};}
 contentRevision():number{return Number(this.row().content_revision);}
 put(itemId:string,fields:string[],sort?:SortSource,freshItem=false):void{
  const source=sort??this.ports.sources([itemId])[0]?.sort;if(!source)throw new Error('排序索引源条目不完整');
  const sortChanged=updateSortIndex(this.db,itemId,source);
  const fingerprint=createHash('sha256').update(SEARCH_ALGORITHM).update(JSON.stringify(fields)).digest('hex');
  const old=sqlStatement(this.db,'SELECT algorithm,fingerprint FROM search_latin WHERE item_id=?').get(itemId) as {algorithm:string;fingerprint:string}|undefined;
  if(old?.algorithm===SEARCH_ALGORITHM&&old.fingerprint===fingerprint){if(sortChanged)sqlStatement(this.db,'UPDATE search_index_state SET revision=revision+1,content_revision=content_revision+1 WHERE id=1').run();return;}
  const inserting=freshItem&&!old;updateLiteralSearchIndex(this.db,itemId,fields,inserting);
  updateSpellingIndex(this.db,itemId,fields);
  const normal=fields.map(field=>this.cache.get(field)),artist=this.cache.get(fields[1]??'',true);
  // Newlines keep separate indexed fields apart; the extra surname form is only for artist text.
  if(!inserting)sqlStatement(this.db,'DELETE FROM search_latin_fts WHERE item_id=?').run(itemId);
  if(normal.some(value=>value.full)||artist.full)sqlStatement(this.db,'INSERT INTO search_latin_fts(item_id,roman,initials) VALUES(?,?,?)').run(itemId,[...normal.map(v=>v.full),artist.full].join('\n'),[...normal.map(v=>v.initials),artist.initials].join('\n'));
  sqlStatement(this.db,'INSERT INTO search_latin(item_id,algorithm,fingerprint) VALUES(?,?,?) ON CONFLICT(item_id) DO UPDATE SET algorithm=excluded.algorithm,fingerprint=excluded.fingerprint').run(itemId,SEARCH_ALGORITHM,fingerprint);
  sqlStatement(this.db,'UPDATE search_index_state SET revision=revision+1,content_revision=content_revision+1 WHERE id=1').run();
 }
 delete(itemId:string):void{sqlStatement(this.db,'DELETE FROM item_sort_key WHERE item_id=?').run(itemId);deleteSpellingIndex(this.db,itemId);const result=sqlStatement(this.db,'DELETE FROM search_latin WHERE item_id=?').run(itemId);if(result.changes)sqlStatement(this.db,'UPDATE search_index_state SET revision=revision+1,content_revision=content_revision+1 WHERE id=1').run();}
 retry():SearchIndexState{this.ports.transaction(()=>sqlStatement(this.db,"UPDATE search_index_state SET status='building',message='',revision=revision+1 WHERE id=1 AND status='error'").run());return this.state();}
 step():SearchIndexState{
  if(this.row().status!=='building')return this.state();
  try{this.ports.transaction(()=>{
   const started=performance.now(),state=this.row(),rows=sqlStatement(this.db,'SELECT p.id,l.algorithm,s.algorithm sort_algorithm FROM playable_item p LEFT JOIN search_latin l ON l.item_id=p.id LEFT JOIN item_sort_key s ON s.item_id=p.id WHERE p.id>? ORDER BY p.id LIMIT 64').all(state.cursor) as Array<{id:string;algorithm:string|null;sort_algorithm:string|null}>;
   if(!rows.length){sqlStatement(this.db,"UPDATE search_index_state SET status='ready',message='',revision=revision+1 WHERE id=1").run();return;}
   const needs=(r:typeof rows[number])=>r.algorithm!==SEARCH_ALGORITHM||r.sort_algorithm!==SORT_ALGORITHM;
   const missing=rows.filter(needs).map(r=>r.id),sources=this.ports.sources(missing);
   if(sources.length!==missing.length)throw new Error('检索索引源条目不完整');
   const found=new Map(sources.map(source=>[source.id,source]));let checked=0,cursor=state.cursor;
   for(const row of rows){
    // Cooperative budget: a synchronous source read or one conversion cannot be preempted.
    if(checked&&performance.now()-started>=25)break;
    if(needs(row))this.put(row.id,found.get(row.id)!.fields,found.get(row.id)!.sort);
    checked++;cursor=row.id;
   }
   sqlStatement(this.db,'UPDATE search_index_state SET cursor=?,processed=processed+?,revision=revision+1 WHERE id=1').run(cursor,checked);
  });}catch(e){this.ports.transaction(()=>sqlStatement(this.db,"UPDATE search_index_state SET status='error',message=?,revision=revision+1 WHERE id=1").run(String(e instanceof Error?e.message:e).replace(/\0/g,'').slice(0,512)||'拼音索引构建失败'));}
  return this.state();
 }
}
