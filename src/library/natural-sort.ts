import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {LibrarySort} from '../shared/library-sort.js';
import {readLibrarySort} from '../shared/library-sort.js';
import {musicReleaseYear} from './music-filters.js';

export const SORT_ALGORITHM='nfkc-lower-utf32-natural-integer-leadingzero-date-range:v1';
export const sortSchema=`
 CREATE TABLE item_sort_key(item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE CASCADE,
 algorithm TEXT NOT NULL,fingerprint TEXT NOT NULL,title_key BLOB NOT NULL,artist_key BLOB NOT NULL,album_key BLOB NOT NULL,release_key BLOB NOT NULL,
 date_known INTEGER NOT NULL CHECK(date_known IN(0,1)),date_start INTEGER NOT NULL,date_end INTEGER NOT NULL,date_precision INTEGER NOT NULL CHECK(date_precision BETWEEN 0 AND 3));
 CREATE INDEX item_sort_title ON item_sort_key(title_key,item_id);
 CREATE INDEX item_sort_artist ON item_sort_key(artist_key,album_key,item_id);
 CREATE INDEX item_sort_album ON item_sort_key(album_key,item_id);
 CREATE INDEX item_sort_date ON item_sort_key(date_known,date_start,date_end,date_precision,item_id);
`;
export type SortSource={title:string;artist:string;album:string;releaseTitle:string;date:string};

// Binary tokens preserve arbitrary-length integer ordering without floating point conversion.
export function naturalSortKey(value:unknown):Buffer{
 const text=(typeof value==='string'?value:'').normalize('NFKC').toLowerCase().trim(),output=Buffer.allocUnsafe(text.length*10);let written=0;
 for(let at=0;at<text.length;){
  const code=text.codePointAt(at)!;
  if(code>=48&&code<=57){let end=at+1;while(end<text.length&&text.charCodeAt(end)>=48&&text.charCodeAt(end)<=57)end++;
   const digits=text.slice(at,end).replace(/^0+/,'')||'0';
   output[written++]=1;output.writeUInt32BE(digits.length,written);written+=4;written+=output.write(digits,written,'ascii');output.writeUInt32BE(end-at,written);written+=4;at=end;
  }else{output[written++]=2;output.writeUInt32BE(code,written);written+=4;at+=code>0xffff?2:1;}
 }
 return Buffer.from(output.subarray(0,written));
}
export class NaturalSortCache{
 private readonly values=new Map<string,Buffer>();private bytes=0;
 get(value:unknown):Buffer{
  const text=typeof value==='string'?value:'',old=this.values.get(text);
  if(old){this.values.delete(text);this.values.set(text,old);return old;}
  const key=naturalSortKey(text),cost=text.length*2+key.length;
  if(cost<=8*1024*1024){while(this.values.size>=2048||this.bytes+cost>8*1024*1024){const first=this.values.keys().next().value;if(first===undefined)break;this.bytes-=first.length*2+this.values.get(first)!.length;this.values.delete(first);}this.values.set(text,key);this.bytes+=cost;}
  return key;
 }
}
export function releaseDateBounds(value:unknown):{known:number;start:number;end:number;precision:number}{
 const year=musicReleaseYear(value);if(year===null)return {known:0,start:0,end:0,precision:0};
 const [y,m,d]=(value as string).split('-').map(Number),days=[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 return {known:1,start:y*10000+(m??1)*100+(d??1),end:y*10000+(m??12)*100+(d??(m?days[m-1]:31)),precision:d?3:m?2:1};
}
export function registerSortFunctions(db:DatabaseSync):void{
 const cache=new NaturalSortCache();db.function('aural_natural_key_v1',{deterministic:true},value=>cache.get(value));
 for(const field of ['known','start','end','precision'] as const)db.function(`aural_date_${field}_v1`,{deterministic:true},value=>releaseDateBounds(value)[field]);
}
export function updateSortIndex(db:DatabaseSync,id:string,source:SortSource):boolean{
 const fingerprint=createHash('sha256').update(SORT_ALGORITHM).update(JSON.stringify(source)).digest('hex'),old=db.prepare('SELECT fingerprint,algorithm FROM item_sort_key WHERE item_id=?').get(id) as {fingerprint:string;algorithm:string}|undefined;
 if(old?.algorithm===SORT_ALGORITHM&&old.fingerprint===fingerprint)return false;
 const date=releaseDateBounds(source.date);
 db.prepare(`INSERT INTO item_sort_key VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET algorithm=excluded.algorithm,fingerprint=excluded.fingerprint,title_key=excluded.title_key,artist_key=excluded.artist_key,album_key=excluded.album_key,release_key=excluded.release_key,date_known=excluded.date_known,date_start=excluded.date_start,date_end=excluded.date_end,date_precision=excluded.date_precision`)
  .run(id,SORT_ALGORITHM,fingerprint,naturalSortKey(source.title),naturalSortKey(source.artist),naturalSortKey(source.album),naturalSortKey(source.releaseTitle),date.known,date.start,date.end,date.precision);return true;
}
export function librarySortOrder(value:LibrarySort|undefined,view:string):string{
 const sort=value===undefined?{mode:'default',direction:'asc'} as const:readLibrarySort(value),dir=sort.direction==='desc'?'DESC':'ASC';
 if(view==='playlists'){if(sort.mode!=='default')throw new Error('歌单保持原始条目顺序');return 'pj.position,pj.entry_id';}
 const current=(column:string,fallback:string)=>`CASE WHEN sk.algorithm='${SORT_ALGORITHM}' THEN sk.${column} ELSE ${fallback} END`,key=(column:string,text:string)=>current(column,`aural_natural_key_v1(${text})`);
 const title=key('title_key','COALESCE(o.title,p.title)'),artist=key('artist_key','COALESCE(o.artist,p.artist)'),album=key('album_key','COALESCE(cr.title,o.album,p.album)'),release=key('release_key',"COALESCE(cr.title,'')"),track="cm.disc_no,CASE WHEN cr.local_key LIKE 'manual-release:%' THEN ct.position ELSE p.track_number END";
 const tail=`${album},cr.id,${track},${title},p.id`;
 if(sort.mode==='title')return `${title} ${dir},${tail}`;
 if(sort.mode==='artist')return `${artist} ${dir},${tail}`;
 if(sort.mode==='album')return `${album} ${dir},cr.id,${track},${title},p.id`;
 if(sort.mode==='date')return `${current('date_known','aural_date_known_v1(cr.date)')} DESC,${current(sort.direction==='desc'?'date_end':'date_start',`aural_date_${sort.direction==='desc'?'end':'start'}_v1(cr.date)`)} ${dir},${current('date_precision','aural_date_precision_v1(cr.date)')} DESC,${tail}`;
 if(sort.mode==='added'||view==='recent')return `p.added_at ${sort.mode==='default'?'DESC':dir},p.id`;
 return `${release},cr.id,${track},${title},p.id`;
}

// The first ordering field can select complete tied buckets before we read
// release/disc/track details. Lazy scalar fallback preserves legacy/missing
// derived keys without joining the whole catalog for already-indexed rows.
export function librarySortPrefix(value:LibrarySort|undefined,view:string):{sql:string;direction:'ASC'|'DESC'}|null{
 const sort=value===undefined?{mode:'default',direction:'asc'} as const:readLibrarySort(value);
 if(view==='playlists'||(view==='recent'&&sort.mode==='default')||sort.mode==='date'||sort.mode==='added')return null;
 const releaseTitle=`(SELECT prefix_release.title FROM release_track prefix_track JOIN medium prefix_medium ON prefix_medium.id=prefix_track.medium_id JOIN release prefix_release ON prefix_release.id=prefix_medium.release_id WHERE prefix_track.id=p.release_track_id)`;
 const key=(column:string,text:string)=>`COALESCE((SELECT prefix_sort.${column} FROM item_sort_key prefix_sort ${column==='release_key'?'INDEXED BY item_sort_release_cover ':''}WHERE prefix_sort.item_id=p.id AND prefix_sort.algorithm='${SORT_ALGORITHM}'),aural_natural_key_v1(${text}))`;
 const direction=sort.direction==='desc'?'DESC':'ASC';
 if(sort.mode==='title')return {sql:key('title_key','COALESCE(o.title,p.title)'),direction};
 if(sort.mode==='artist')return {sql:key('artist_key','COALESCE(o.artist,p.artist)'),direction};
 if(sort.mode==='album')return {sql:key('album_key',`COALESCE(${releaseTitle},o.album,p.album)`),direction};
 return {sql:key('release_key',`COALESCE(${releaseTitle},'')`),direction:'ASC'};
}
