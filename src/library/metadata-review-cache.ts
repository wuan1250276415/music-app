import {randomUUID} from 'node:crypto';
import {readBatchReviewItems,readBatchReviewToken,type MetadataBatchReviewLease,type MetadataBatchReviewStatus} from '../shared/metadata-batch-review.js';
import type {MusicBrainzEntry} from './musicbrainz.js';
type Row={tokens:string[];authority:string|null;metadata:string|null;expired:boolean};
type Lease={expires:number;bytes:number;rows:Map<string,Row>};
export class MetadataReviewCache {
 private readonly leases=new Map<string,Lease>();private readonly entries=new Map<string,MusicBrainzEntry>();
 constructor(private readonly authority:(id:string)=>string|null,private readonly metadata:(id:string)=>string|null){}
 start(raw:unknown):MetadataBatchReviewLease {this.prune();const ids=readBatchReviewItems(raw);if(this.leases.size>=4)throw new Error('批量预览会话已达到4份，请先关闭其他审核');const token=randomUUID(),expires=Date.now()+600000;this.leases.set(token,{expires,bytes:0,rows:new Map(ids.map(id=>[id,{tokens:[],authority:null,metadata:null,expired:false}]))});return {reviewToken:token,expiresAt:new Date(expires).toISOString()};}
 check(raw:unknown,itemId?:string):Lease {this.prune();const token=readBatchReviewToken(raw),lease=this.leases.get(token);if(!lease||itemId!==undefined&&!lease.rows.has(itemId))throw new Error('批量预览已过期、关闭或不包含该歌曲，请重新查询');return lease;}
 get(token:string):MusicBrainzEntry|undefined {return this.entries.get(token);}
 private size(entries:MusicBrainzEntry[]):number{return entries.length?Buffer.byteLength(JSON.stringify(entries)):0;}
 retain(token:string,itemId:string,values:MusicBrainzEntry[],authority:string,metadata:string,append=false):MusicBrainzEntry[] {
  const lease=this.check(token,itemId),row=lease.rows.get(itemId)!;if(this.authority(itemId)!==authority||this.metadata(itemId)!==metadata)throw new Error('批量查询期间资料或来源已变化，请重新查询');
  const old=row.tokens.map(t=>this.entries.get(t)).filter((e):e is MusicBrainzEntry=>Boolean(e));
  const incoming=values.map(value=>{if(value.itemId!==itemId||value.authority!==authority||value.expires<=Date.now())throw new Error('批量预览候选与来源不符');const entry=structuredClone(value);entry.reviewToken=token;entry.metadataFingerprint=metadata;entry.expires=Math.min(entry.expires,lease.expires);entry.candidate.expiresAt=new Date(entry.expires).toISOString();return entry;});
  const next=append?[...old,...incoming]:incoming,priorBytes=this.size(old),nextBytes=this.size(next),delta=nextBytes-priorBytes;
  if([...this.leases.values()].reduce((sum,l)=>sum+l.bytes,0)+delta>16777216)throw new Error('批量候选预览超过16MiB预算，请缩小审核范围；已有预览保留');
  for(const id of row.tokens)this.entries.delete(id);for(const e of next)this.entries.set(e.candidate.token,e);lease.bytes+=delta;row.tokens=next.map(e=>e.candidate.token);row.authority=authority;row.metadata=metadata;row.expired=false;return incoming;
 }
 close(raw:unknown):void {const token=readBatchReviewToken(raw),lease=this.leases.get(token);if(lease)for(const row of lease.rows.values())for(const id of row.tokens)this.entries.delete(id);this.leases.delete(token);}
 clear():void {this.entries.clear();this.leases.clear();}
 invalidate(requestId:string):void {for(const [token,lease] of this.leases)for(const [itemId,row] of lease.rows){const old=row.tokens.map(t=>this.entries.get(t)).filter((e):e is MusicBrainzEntry=>Boolean(e)),next=old.filter(e=>e.requestId!==requestId);if(next.length!==old.length){for(const e of old)if(e.requestId===requestId)this.entries.delete(e.candidate.token);lease.bytes+=this.size(next)-this.size(old);row.tokens=next.map(e=>e.candidate.token);if(!next.length){row.authority=null;row.metadata=null;}}}}
 prune():void {for(const [token,l] of this.leases){if(l.expires<=Date.now()){this.close(token);continue;}for(const row of l.rows.values()){const old=row.tokens.map(t=>this.entries.get(t)).filter((e):e is MusicBrainzEntry=>Boolean(e)),next=old.filter(e=>e.expires>Date.now());if(next.length!==old.length){for(const e of old)if(e.expires<=Date.now())this.entries.delete(e.candidate.token);l.bytes+=this.size(next)-this.size(old);row.tokens=next.map(e=>e.candidate.token);row.expired=true;}}}}
 status(raw:unknown):MetadataBatchReviewStatus {
  this.prune();const token=readBatchReviewToken(raw),lease=this.leases.get(token);if(!lease)return {reviewToken:token,expiresAt:new Date(0).toISOString(),valid:false,rows:[]};
  const rows=[...lease.rows].map(([itemId,row])=>{let state:'pending'|'ready'|'changed'|'expired'=row.metadata===null?'pending':'ready',reason='';try{if(row.metadata!==null&&(this.authority(itemId)!==row.authority||this.metadata(itemId)!==row.metadata)){state='changed';reason='资料、录音引用或编码来源已变化，请重查此曲';}else if(row.expired||row.tokens.some(t=>!this.entries.has(t)||this.entries.get(t)!.expires<=Date.now())){state='expired';reason='候选已过期，请重查此曲';}}catch{state='changed';reason='歌曲不可读取，请重查此曲';}return {itemId,state,reason};});
  return {reviewToken:token,expiresAt:new Date(lease.expires).toISOString(),valid:true,rows};
 }
}
