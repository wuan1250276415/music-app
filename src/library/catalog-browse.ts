import {musicFilterTimeAnchor,type MusicFilters} from '../shared/music-filters.js';
import {registerSortFunctions,SORT_ALGORITHM} from './natural-sort.js';
import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {CatalogRepository} from './catalog.js';
import {CATALOG_PAGE_SIZE,readCatalogBrowseRequest,type CatalogBrowseResponse,type CatalogBrowseQuery,type CatalogCard} from '../shared/catalog-browse.js';
import type {LibraryItem} from '../shared/contracts.js';
import {RomanTextCache} from './search-text.js';
const normalize=(v:string)=>v.normalize('NFKC').toLowerCase().trim();
type Ports={stamp:(filters?:MusicFilters,asOfMs?:number)=>string;items:(ids:string[])=>LibraryItem[];filter?:(value:MusicFilters,asOfMs:number)=>{sql:string;params:Array<string|number>}};
type Row={id:string;name:string;subtitle:string;artist:string;date:string;edition:string;country:string;label:string;catalog_no:string;context:string;track_count:number;file_count:number;release_count:number;disc_count:number;available_count:number;formats:string;representative_id:string};
export class CatalogBrowser{
 constructor(private readonly db:DatabaseSync,private readonly catalog:CatalogRepository,private readonly ports:Ports){
  registerSortFunctions(db);
  const cache=new RomanTextCache();
  db.function('aural_catalog_contains',{deterministic:true},(v,q)=>cache.matches(v,q));
  db.function('aural_catalog_artist_contains',{deterministic:true},(v,q)=>cache.matches(v,q,true));
 }
 private snapshot(q:CatalogBrowseQuery,asOfMs=musicFilterTimeAnchor()):string{return createHash('sha256').update(this.ports.stamp(q.filters,asOfMs)).update(`\ncatalog-v1:${SORT_ALGORITHM}\n`).update(JSON.stringify(q)).digest('hex');}
 page(value:unknown):CatalogBrowseResponse{
  const r=readCatalogBrowseRequest(value),q=r.query,asOfMs=musicFilterTimeAnchor(),snapshot=this.snapshot(q,asOfMs),stale=():CatalogBrowseResponse=>({version:1,status:'stale',snapshot:this.snapshot(q),offset:r.offset,total:0,items:[]});
  if(r.snapshot!==undefined&&r.snapshot!==snapshot)return stale();
  let entity:string,fields:string,join='',params:Array<string|number>=[],extra='';
  if(q.view==='artists'){
   entity='a.id';fields="a.name,COALESCE(NULLIF(a.sort_name,''),a.name) sort_name,CASE WHEN a.disambiguation IN('','local-tag-candidate','user-confirmed') THEN '' ELSE a.disambiguation END subtitle,'' artist,'' date,'' edition,'' country,'' label,'' catalog_no,'' context";
   join=`JOIN artist_credit_member c ON (c.credit_id=${q.role==='album_artist'?'r.artist_credit_id':'p.artist_credit_id'}${q.role==='album_artist'?'':this.catalog.recordingCreditCondition()}) LEFT JOIN artist_identity_binding ai ON ai.source_artist_id=c.artist_id JOIN artist a ON a.id=COALESCE(ai.identity_artist_id,c.artist_id)`;
   extra=' AND c.role=?';params.push(q.role);
  }else if(q.view==='albumGroups'){
   entity='g.id';fields="g.title name,g.title sort_name,'' subtitle,'' artist,'' date,'' edition,'' country,'' label,'' catalog_no,'' context";join='JOIN release_group g ON g.id=r.group_id';
  }else{
   entity='r.id';fields="r.title name,r.title sort_name,'' subtitle,COALESCE(ac.display_text,'') artist,COALESCE(r.date,'') date,COALESCE(r.edition,'') edition,COALESCE(r.country,'') country,COALESCE(r.label,'') label,COALESCE(r.catalog_no,'') catalog_no,r.local_context context";
  }
  if(q.filters){if(!this.ports.filter)throw new Error('分类组合筛选未配置');const filter=this.ports.filter(q.filters,asOfMs);extra+=` AND p.id IN(${filter.sql})`;params.push(...filter.params);}
  const cte=`WITH members AS(SELECT ${entity} id,${fields},p.id item_id,p.release_track_id track_id,r.id release_id,m.id medium_id,f.codec,
   CASE WHEN f.status='online' AND lr.status!='offline' THEN 1 ELSE 0 END available FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root lr ON lr.id=f.root_id
   JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id JOIN release r ON r.id=m.release_id LEFT JOIN artist_credit ac ON ac.id=r.artist_credit_id ${join} WHERE p.visible=1 AND p.library_state='active'${extra}),
   grouped AS(SELECT id,MAX(name) name,MAX(sort_name) sort_name,MAX(subtitle) subtitle,MAX(artist) artist,MAX(date) date,MAX(edition) edition,MAX(country) country,MAX(label) label,MAX(catalog_no) catalog_no,MAX(context) context,
   COUNT(DISTINCT track_id) track_count,COUNT(DISTINCT item_id) file_count,COUNT(DISTINCT release_id) release_count,COUNT(DISTINCT medium_id) disc_count,COUNT(DISTINCT CASE WHEN available=1 THEN item_id END) available_count,
   GROUP_CONCAT(DISTINCT codec) formats,COALESCE(MIN(CASE WHEN available=1 THEN item_id END),MIN(item_id)) representative_id FROM members GROUP BY id)`;
  const search=normalize(q.query);
  let where='';if(search){const contains=q.view==='artists'?'aural_catalog_artist_contains':'aural_catalog_contains';where=`WHERE (${contains}(name,?) OR ${contains}(subtitle,?) OR aural_catalog_artist_contains(artist,?) OR ${contains}(edition,?) OR ${contains}(catalog_no,?))`;params.push(...Array(5).fill(search));
   if(q.view==='artists'){where=where.slice(0,-1)+" OR EXISTS(SELECT 1 FROM artist source LEFT JOIN artist_identity_binding b ON b.source_artist_id=source.id WHERE COALESCE(b.identity_artist_id,source.id)=grouped.id AND (aural_catalog_artist_contains(source.name,?) OR aural_catalog_artist_contains(source.sort_name,?))))";params.push(search,search);}
  }
  const total=(this.db.prepare(`${cte} SELECT COUNT(*) count FROM grouped ${where}`).get(...params) as {count:number}).count;
  const direction=q.direction??(q.sort==='name'?'asc':'desc'),dir=direction==='desc'?'DESC':'ASC',name='aural_natural_key_v1(sort_name)',tail=`${name},aural_natural_key_v1(name),id`;
  const order=q.sort==='count'?`file_count ${dir},${tail}`:q.sort==='date'&&q.view==='albums'?`aural_date_known_v1(date) DESC,aural_date_${direction==='desc'?'end':'start'}_v1(date) ${dir},aural_date_precision_v1(date) DESC,${tail}`:`${name} ${dir},aural_natural_key_v1(name) ${dir},id`;
  const rows=this.db.prepare(`${cte} SELECT * FROM grouped ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params,CATALOG_PAGE_SIZE,r.offset) as unknown as Row[];
  const representatives=new Map(this.ports.items([...new Set(rows.map(row=>row.representative_id))]).map(item=>[item.id,item]));
  if(this.snapshot(q)!==snapshot)return stale();
  const items:CatalogCard[]=rows.map(row=>({id:row.id,name:row.name,subtitle:row.subtitle,artist:row.artist,date:row.date,edition:row.edition,country:row.country,label:row.label,catalogNumber:row.catalog_no,context:row.context,
   trackCount:Number(row.track_count),fileCount:Number(row.file_count),releaseCount:Number(row.release_count),discCount:Number(row.disc_count),availableCount:Number(row.available_count),formats:[...new Set(String(row.formats??'').split(',').filter(Boolean))].sort().slice(0,32),representative:representatives.get(row.representative_id)??null}));
  return {version:1,status:'ready',snapshot,offset:r.offset,total,items};
 }
}
