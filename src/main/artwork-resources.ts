import {MaintenanceHold} from './maintenance-hold.js';
import {createHash,randomUUID} from 'node:crypto';
import type {ArtworkCandidate,CoverArtImagePreview} from '../shared/contracts.js';

export type ArtworkQuery={itemId:string;rejectedTokens?:string[];thumbnailSize?:256|1024};
type Resource={query:ArtworkQuery;candidate:ArtworkCandidate;bytes?:Buffer};
type Lease={id:string;itemId:string};
const ADDRESS=/^aural-artwork:\/\/image\/([0-9a-f]{64})\.jpg$/;
const PREVIEW_ADDRESS=/^aural-artwork:\/\/preview\/([0-9a-f]{64})\.jpg$/;
const MAX_BYTES=64*1024*1024;
export class ArtworkResources{
 private readonly maintenance=new MaintenanceHold();
 private readonly resources=new Map<string,Resource>();
 private readonly loading=new Map<string,Promise<Buffer|null>>();
 private readonly leases=new Map<string,Lease>();
 private readonly previews=new Map<string,{bytes:Buffer;itemId:string;expires:number;timer:NodeJS.Timeout;descriptor:CoverArtImagePreview}>();private previewGeneration=0;
 private epoch=0;private resetAfterMaintenance=false;private readonly resetting=new Set<Promise<unknown>>();
 private owner=randomUUID();private closing=false;private closeWork:Promise<void>|null=null;
 constructor(private readonly reload:(query:ArtworkQuery)=>Promise<ArtworkCandidate|null>,
  private readonly fetchResource:(itemId:string,id:string)=>Promise<Uint8Array|null>,
  private readonly setLease:(itemId:string,id:string,consumer:string,retain:boolean)=>Promise<unknown>,
  private readonly clearLeases:()=>Promise<unknown>){}
 private pinned(id:string):boolean{return [...this.leases.values()].some(lease=>lease.id===id);}
 capturePreviewOwner():string{this.maintenance.assertAvailable();if(this.closing)throw new Error('应用正在退出');return `${this.owner}:${this.previewGeneration}`;}
 clearPreviews(itemId?:string):void{
  if(itemId!==undefined){for(const [id,value] of this.previews)if(value.itemId===itemId){clearTimeout(value.timer);this.previews.delete(id);}return;}
  this.previewGeneration++;for(const value of this.previews.values())clearTimeout(value.timer);this.previews.clear();
 }
 releasePreview(url:string,itemId?:string):void{
  const match=PREVIEW_ADDRESS.exec(url);if(!match)throw new Error('无效在线图片预览地址');const value=this.previews.get(match[1]);if(!value)return;
  if(itemId!==undefined&&value.itemId!==itemId)throw new Error('图片预览不属于当前曲目');clearTimeout(value.timer);this.previews.delete(match[1]);
 }
 async reconcilePreviews(readFingerprint:(itemId:string)=>Promise<string>):Promise<void>{
  const reads=new Map<string,Promise<string|null>>();
  await Promise.all([...this.previews.entries()].map(async([id,entry])=>{
   let read=reads.get(entry.itemId);if(!read){read=Promise.resolve().then(()=>readFingerprint(entry.itemId)).catch(()=>null);reads.set(entry.itemId,read);}
   const fingerprint=await read;
   if(this.previews.get(id)===entry&&fingerprint!==entry.descriptor.fingerprint)this.releasePreview(`aural-artwork://preview/${id}.jpg`);
  }));
 }
 registerPreview(value:CoverArtImagePreview,owner:string):CoverArtImagePreview{
  if(owner!==this.capturePreviewOwner())throw new Error('图片预览所属窗口或曲库状态已变化');
  if(!value||typeof value.expiresAt!=='string')throw new Error('无效在线图片预览内容');
  const expires=Date.parse(value.expiresAt),prefix='data:image/jpeg;base64,';
  if(!value||!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+600000||typeof value.url!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.url)||value.url.length>3*1024*1024||!Number.isSafeInteger(value.width)||value.width<1||value.width>1024||!Number.isSafeInteger(value.height)||value.height<1||value.height>1024||!/^[0-9a-f]{64}$/.test(value.token)||value.rights?.display!==true||value.rights?.persist!==false||value.rights?.export!==false)throw new Error('无效在线图片预览内容');
  const encoded=value.url.slice(prefix.length),bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>2097152||bytes.toString('base64')!==encoded||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new Error('在线图片预览字节无效');
  const id=createHash('sha256').update(bytes).update(randomUUID()).digest('hex'),url=`aural-artwork://preview/${id}.jpg`;
  const timer=setTimeout(()=>this.releasePreview(url),Math.max(1,expires-Date.now()));timer.unref();this.previews.set(id,{bytes,itemId:value.itemId,expires,timer,descriptor:{...value,url:''}});
  let size=[...this.previews.values()].reduce((n,entry)=>n+entry.bytes.length,0);while(this.previews.size>16||size>32*1024*1024){const oldest=this.previews.entries().next().value!;size-=oldest[1].bytes.length;this.releasePreview(`aural-artwork://preview/${oldest[0]}.jpg`);}
  return {...value,url};
 }
 previewForSave(url:string,itemId:string):CoverArtImagePreview{
  this.capturePreviewOwner();const match=PREVIEW_ADDRESS.exec(url),entry=match?this.previews.get(match[1]):undefined;
  if(!entry||entry.itemId!==itemId||entry.expires<=Date.now())throw new Error('图片预览已关闭、到期或不属于当前曲目');
  return {...entry.descriptor,url:`data:image/jpeg;base64,${entry.bytes.toString('base64')}`};
 }
 register(candidate:ArtworkCandidate|null,query:ArtworkQuery):ArtworkCandidate|null{
  if(this.closing)return null;this.maintenance.assertAvailable();if(!candidate)return null;const match=ADDRESS.exec(candidate.url);
  if(!match||!Number.isSafeInteger(candidate.width)||!Number.isSafeInteger(candidate.height)||!candidate.width||!candidate.height||candidate.width<1||candidate.height<1||candidate.width>1024||candidate.height>1024||!/^[0-9a-f]{64}$/.test(candidate.token)||!['embedded','sidecar','online'].includes(candidate.sourceKind)||!candidate.label||candidate.label.length>512)throw new Error('封面资源描述无效');
  const id=match[1],previous=this.resources.get(id);
  this.resources.delete(id);this.resources.set(id,{bytes:previous?.bytes,candidate:{...candidate},query:{...query,rejectedTokens:query.rejectedTokens?[...query.rejectedTokens]:undefined}});
  this.trim();return {...candidate,leaseOwner:this.owner};
 }
 private trim():void{
  for(const id of this.resources.keys()){if(this.resources.size<=512)break;if(!this.pinned(id))this.resources.delete(id);}
  let total=0;for(const value of this.resources.values())total+=value.bytes?.length??0;
  for(const value of this.resources.values()){if(total<=MAX_BYTES)break;total-=value.bytes?.length??0;value.bytes=undefined;}
 }
 private leaseAddress(url:string,itemId:string,consumer:string,retain:boolean):string{
  const match=ADDRESS.exec(url);if(!match||typeof itemId!=='string'||!itemId||itemId.length>128||typeof retain!=='boolean'||typeof consumer!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(consumer))throw new Error('无效封面资源租约');return match[1];
 }
 lease(url:string,itemId:string,consumer:string,retain:boolean,owner:string):Promise<void>{
  if(this.closing){try{this.leaseAddress(url,itemId,consumer,retain);if(retain)throw new Error('应用正在退出，不能保留新的封面资源');return Promise.resolve();}catch(error){return Promise.reject(error);}}
  return this.maintenance.run(()=>this.leaseNow(url,itemId,consumer,retain,owner));
 }
 private async leaseNow(url:string,itemId:string,consumer:string,retain:boolean,owner:string):Promise<void>{
  const id=this.leaseAddress(url,itemId,consumer,retain);if(this.closing){if(retain)throw new Error('应用正在退出，不能保留新的封面资源');return;}const existing=this.leases.get(consumer);
  if(retain&&owner!==this.owner)throw new Error('封面租约属于旧窗口文档');
  if(existing&&(existing.id!==id||existing.itemId!==itemId))throw new Error('封面租约不能改绑');
  if(!retain){await this.setLease(itemId,id,consumer,false);this.leases.delete(consumer);this.trim();return;}
  if(existing)return;
  const resource=this.resources.get(id);if(!resource||this.leases.size>=256)throw new Error('封面资源未注册或租约已满');
  const epoch=this.epoch;await this.setLease(itemId,id,consumer,true);
  if(epoch!==this.epoch){
   // Close invalidates the epoch while waiting for this original retain.
   // Undo the service lease before finishing; document navigation still
   // rejects stale retention, while shutdown has no surviving UI consumer.
   await this.setLease(itemId,id,consumer,false);if(this.closing)return;
   throw new Error('封面租约所属窗口文档已变化，请重新读取');
  }
  this.leases.set(consumer,{id,itemId});
  if(!this.resources.has(id))this.resources.set(id,resource);this.trim();
 }
 resetLeases():void{
  this.clearPreviews();
  if(this.closing)return;
  if(this.maintenance.held){this.resetAfterMaintenance=true;return;}
  this.epoch++;this.owner=randomUUID();this.leases.clear();
  // The service has one UI owner. Clear even a retain whose acknowledgment was lost.
  const work=Promise.resolve().then(()=>this.clearLeases()).catch(()=>{});this.resetting.add(work);void work.finally(()=>this.resetting.delete(work));
  this.trim();
 }
 read(url:string):Promise<Buffer|null>{if(this.closing)return Promise.resolve(null);return this.maintenance.run(()=>this.readNow(url));}
 async response(url:string,method='GET'):Promise<Response>{
  if(method!=='GET')return new Response(null,{status:405});const bytes=await this.read(url);
  return bytes?new Response(new Uint8Array(bytes),{headers:{'Content-Type':'image/jpeg','Content-Length':String(bytes.length),'Cache-Control':PREVIEW_ADDRESS.test(url)?'no-store':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}}):new Response(null,{status:404});
 }
 private async readNow(url:string):Promise<Buffer|null>{
  if(this.closing)return null;
  const preview=PREVIEW_ADDRESS.exec(url);if(preview){const entry=this.previews.get(preview[1]);if(!entry)return null;if(entry.expires<=Date.now()){this.releasePreview(url);return null;}return entry.bytes;}
  const match=ADDRESS.exec(url);if(!match)return null;
  const id=match[1],entry=this.resources.get(id);if(!entry)return null;
  this.resources.delete(id);this.resources.set(id,entry);if(entry.bytes)return entry.bytes;
  const existing=this.loading.get(id);if(existing)return existing;if(this.loading.size>=16)return null;
  const owner=[...this.leases.values()].find(lease=>lease.id===id)?.itemId??entry.query.itemId;
  const promise=(async()=>{
   let raw=await this.fetchResource(owner,id);
   if(!raw){const candidate=await this.reload(entry.query);if(!candidate||candidate.url!==url||candidate.token!==entry.candidate.token)return null;raw=await this.fetchResource(entry.query.itemId,id);}
   if(!(raw instanceof Uint8Array)||!raw.length||raw.length>2*1024*1024)return null;
   const bytes=Buffer.from(raw);if(bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||createHash('sha256').update(bytes).digest('hex')!==id)return null;
   if(this.resources.get(id)===entry){entry.bytes=bytes;this.trim();}return bytes;
  })().catch(()=>null).finally(()=>this.loading.delete(id));
  this.loading.set(id,promise);return promise;
 }
 beginMaintenance(owner:string):Promise<void>{return this.maintenance.begin(owner,async()=>{
  this.clearPreviews();
  await this.maintenance.waitRequests();await Promise.allSettled([...this.loading.values(),...this.resetting]);
  if(this.loading.size||this.resetting.size)throw new Error('封面资源读取尚未确认停止');
 });}
 endMaintenance(owner:string):void{this.maintenance.end(owner);if(this.resetAfterMaintenance){this.resetAfterMaintenance=false;this.resetLeases();}}
 close():Promise<void>{
  this.clearPreviews();
  if(this.closeWork)return this.closeWork;this.closing=true;this.epoch++;this.owner=randomUUID();
  const work=(async()=>{await this.maintenance.waitRequests();await Promise.allSettled([...this.loading.values(),...this.resetting]);
   if(this.loading.size||this.resetting.size)throw new Error('封面资源退出前仍有读取或租约清理尚未结束');
   await this.clearLeases();this.leases.clear();this.resources.clear();this.resetAfterMaintenance=false;
  })();this.closeWork=work;void work.catch(()=>{});return work;
 }
}
