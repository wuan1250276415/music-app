import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {ArtworkCandidate} from '../shared/contracts.js';

const MAX_BYTES=512*1024*1024,MAX_ASSETS=16384,MAX_CLAIMS=32768;
const hash=/^[0-9a-f]{64}$/;
const algorithm='wic-webp-srgb-jpeg-v3';
const readableAlgorithms=new Set(['wic-jpeg-v1','wic-webp-jpeg-v2',algorithm]);
export const artworkStoreSchema=`
 CREATE TABLE artwork_asset(id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),algorithm TEXT NOT NULL CHECK(length(algorithm) BETWEEN 1 AND 64),width INTEGER NOT NULL CHECK(typeof(width)='integer' AND width BETWEEN 1 AND 1024),height INTEGER NOT NULL CHECK(typeof(height)='integer' AND height BETWEEN 1 AND 1024),bytes INTEGER NOT NULL CHECK(typeof(bytes)='integer' AND bytes BETWEEN 1 AND 2097152),content BLOB NOT NULL CHECK(typeof(content)='blob' AND length(content)=bytes),created_at INTEGER NOT NULL,last_access INTEGER NOT NULL);
 CREATE INDEX artwork_asset_lru ON artwork_asset(last_access,id);
 CREATE TABLE artwork_claim(file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,asset_id TEXT NOT NULL REFERENCES artwork_asset(id) ON DELETE CASCADE,last_access INTEGER NOT NULL,PRIMARY KEY(file_id,asset_id));
 CREATE INDEX artwork_claim_lru ON artwork_claim(last_access,file_id,asset_id);
 CREATE TABLE artwork_reference(file_id TEXT NOT NULL,thumbnail_size INTEGER NOT NULL CHECK(thumbnail_size IN(256,1024)),asset_id TEXT NOT NULL,source_token TEXT NOT NULL CHECK(length(source_token)=64 AND source_token NOT GLOB '*[^0-9a-f]*'),source_kind TEXT NOT NULL CHECK(source_kind IN('embedded','sidecar')),label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 512),observation TEXT NOT NULL CHECK(length(observation)=64 AND observation NOT GLOB '*[^0-9a-f]*'),verified_at INTEGER NOT NULL,PRIMARY KEY(file_id,thumbnail_size),FOREIGN KEY(file_id,asset_id) REFERENCES artwork_claim(file_id,asset_id) ON DELETE CASCADE);
`;
type Reference={thumbnail_size:256|1024;asset_id:string;source_token:string;source_kind:'embedded'|'sidecar';label:string;observation:string;verified_at:number;width:number;height:number;algorithm:string};
type Pin={fileId:string;assetId:string};
export class ArtworkStore{
 private readonly pins=new Map<string,Pin>();
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 private assetPinned(id:string):boolean{return [...this.pins.values()].some(pin=>pin.assetId===id);}
 private claimPinned(fileId:string,assetId:string):boolean{return [...this.pins.values()].some(pin=>pin.fileId===fileId&&pin.assetId===assetId);}
 private resourceUrl(id:string):string{return `aural-artwork://image/${id}.jpg`;}
 private mapped(image:ArtworkCandidate,id:string,state:ArtworkCandidate['cacheState']):ArtworkCandidate{return {...image,url:this.resourceUrl(id),cacheState:state};}
 private content(id:string):Buffer|null{
  const meta=this.db.prepare('SELECT algorithm,bytes,length(content) actual FROM artwork_asset WHERE id=?').get(id) as {algorithm:string;bytes:number;actual:number}|undefined;
  if(!meta)return null;
  if(!readableAlgorithms.has(meta.algorithm)||!Number.isSafeInteger(meta.bytes)||meta.bytes<1||meta.bytes>2097152||meta.actual!==meta.bytes){this.invalidate(id);return null;}
  const row=this.db.prepare('SELECT content FROM artwork_asset WHERE id=?').get(id) as {content:Uint8Array};
  const bytes=Buffer.from(row.content);
  if(bytes.length!==meta.bytes||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||createHash('sha256').update(bytes).digest('hex')!==id){this.invalidate(id);return null;}
  return bytes;
 }
 private invalidate(id:string):void{this.db.prepare('DELETE FROM artwork_asset WHERE id=?').run(id);}
 lookup(fileId:string,size:256|1024,rejected:ReadonlySet<string>,observation:string|undefined,state:'stored'|'offline'|'stale',sourceKind:'embedded'|'sidecar'|null=null):ArtworkCandidate|null{
  // Source priority also applies to offline/stale recovery. An exact-size
  // directory thumbnail must not hide an available embedded image of another size.
  const rows=this.db.prepare('SELECT r.*,a.width,a.height,a.algorithm FROM artwork_reference r JOIN artwork_asset a ON a.id=r.asset_id WHERE r.file_id=? AND (? IS NULL OR r.source_kind=?) AND (r.thumbnail_size=? OR ?=1) ORDER BY (r.source_kind=\'embedded\') DESC,(r.thumbnail_size=?) DESC,r.thumbnail_size DESC LIMIT 2').all(fileId,sourceKind,sourceKind,size,observation===undefined?1:0,size) as Reference[];
  for(const row of rows){
   if(rejected.has(row.source_token)||observation!==undefined&&(row.algorithm!==algorithm||row.observation!==observation||row.source_kind==='sidecar'&&Date.now()-row.verified_at>30000)||!this.content(row.asset_id))continue;
   this.touch(fileId,row.asset_id);
   const label=row.thumbnail_size===size?row.label:`${row.label} · 已保存的${row.thumbnail_size<size?'较小':'较大'}封面`;
   return {url:this.resourceUrl(row.asset_id),token:row.source_token,sourceKind:row.source_kind,label,width:row.width,height:row.height,cacheState:state};
  }
  return null;
 }
 save(fileId:string,size:256|1024,observation:string,image:ArtworkCandidate,primary:boolean):ArtworkCandidate{
  if(!hash.test(observation)||!hash.test(image.token)||!Number.isSafeInteger(image.width)||!Number.isSafeInteger(image.height)||!image.width||!image.height||image.width<1||image.height<1||image.width>size||image.height>size||!['embedded','sidecar'].includes(image.sourceKind)||!image.label||image.label.length>512||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.url)||image.url.length>3*1024*1024)throw new Error('无效封面缓存内容');
  const encoded=image.url.slice('data:image/jpeg;base64,'.length),bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>2097152||bytes.toString('base64')!==encoded||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new Error('封面缓存字节无效');
  const id=createHash('sha256').update(bytes).digest('hex'),now=Date.now();
  this.transaction(()=>{
   this.db.prepare('INSERT INTO artwork_asset VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET algorithm=excluded.algorithm,content=excluded.content,bytes=excluded.bytes,width=excluded.width,height=excluded.height,last_access=excluded.last_access').run(id,algorithm,image.width!,image.height!,bytes.length,bytes,now,now);
   this.db.prepare('INSERT INTO artwork_claim VALUES(?,?,?) ON CONFLICT(file_id,asset_id) DO UPDATE SET last_access=excluded.last_access').run(fileId,id,now);
   if(primary)this.db.prepare('INSERT INTO artwork_reference VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(file_id,thumbnail_size) DO UPDATE SET asset_id=excluded.asset_id,source_token=excluded.source_token,source_kind=excluded.source_kind,label=excluded.label,observation=excluded.observation,verified_at=excluded.verified_at').run(fileId,size,id,image.token,image.sourceKind,image.label,observation,now);
   this.prune(fileId,id);
  });
  return this.mapped(image,id,'fresh');
 }
 clearSelection(fileId:string,size:256|1024):void{this.db.prepare('DELETE FROM artwork_reference WHERE file_id=? AND thumbnail_size=?').run(fileId,size);}
 private touch(fileId:string,id:string):void{
  this.transaction(()=>{const now=Date.now();this.db.prepare('UPDATE artwork_asset SET last_access=? WHERE id=?').run(now,id);
  this.db.prepare('UPDATE artwork_claim SET last_access=? WHERE file_id=? AND asset_id=?').run(now,fileId,id);});
 }
 read(fileId:string,id:string):Buffer|null{
  if(!hash.test(id)||!this.db.prepare('SELECT 1 FROM artwork_claim WHERE file_id=? AND asset_id=?').get(fileId,id))return null;
  const bytes=this.content(id);if(bytes)this.touch(fileId,id);return bytes;
 }
 lease(consumer:string,fileId:string,id:string,retain:boolean):void{
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(consumer)||!hash.test(id))throw new Error('无效封面资源租约');
  const current=this.pins.get(consumer);
  if(!retain){if(current&&current.assetId!==id)throw new Error('封面租约身份不符');if(current)this.touch(current.fileId,current.assetId);this.pins.delete(consumer);return;}
  if(current){if(current.fileId!==fileId||current.assetId!==id)throw new Error('封面租约不能改绑');return;}
  if(this.pins.size>=256)throw new Error('封面资源租约已满');
  if(!this.db.prepare('SELECT 1 FROM artwork_claim WHERE file_id=? AND asset_id=?').get(fileId,id))throw new Error('封面资源不属于当前歌曲');
  this.pins.set(consumer,{fileId,assetId:id});this.touch(fileId,id);
 }
 resetLeases():void{try{this.transaction(()=>{for(const pin of this.pins.values())this.touch(pin.fileId,pin.assetId);});}finally{this.pins.clear();}}
 private prune(protectedFile:string,protectedId:string):void{
  const totals=this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) entries FROM artwork_asset').get() as {bytes:number;entries:number};let bytes=totals.bytes,entries=totals.entries;
  if(bytes>MAX_BYTES||entries>MAX_ASSETS){
   for(const row of this.db.prepare('SELECT id,bytes FROM artwork_asset ORDER BY last_access,id').all() as {id:string;bytes:number}[]){
    if(bytes<=MAX_BYTES&&entries<=MAX_ASSETS)break;if(row.id===protectedId||this.assetPinned(row.id))continue;
    this.db.prepare('DELETE FROM artwork_asset WHERE id=?').run(row.id);bytes-=row.bytes;entries--;
   }
  }
  let claims=Number((this.db.prepare('SELECT COUNT(*) n FROM artwork_claim').get() as {n:number}).n);
  if(claims>MAX_CLAIMS)for(const row of this.db.prepare('SELECT file_id,asset_id FROM artwork_claim ORDER BY last_access,file_id,asset_id').all() as {file_id:string;asset_id:string}[]){
   if(claims<=MAX_CLAIMS)break;if(row.file_id===protectedFile&&row.asset_id===protectedId||this.claimPinned(row.file_id,row.asset_id))continue;
   this.db.prepare('DELETE FROM artwork_claim WHERE file_id=? AND asset_id=?').run(row.file_id,row.asset_id);claims--;
  }
  if(bytes>MAX_BYTES||entries>MAX_ASSETS||claims>MAX_CLAIMS)throw new Error('封面缓存空间被使用中的资源占满');
 }
}
