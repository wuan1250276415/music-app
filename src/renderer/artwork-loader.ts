import type {ArtworkCandidate} from '../shared/contracts';
import {ArtworkCache} from '../shared/artwork-cache';
import {loadUsableArtwork} from './media-artwork';

type Waiting={key:string;itemId:string;size:256|1024;rejectedTokens:readonly string[];resolve:(value:ArtworkCandidate|null)=>void;reject:(error:Error)=>void};
// Keep one lane available for the player. Queued rows leave the queue when unmounted.
class ArtworkRequests {
  private readonly cache=new ArtworkCache<ArtworkCandidate>(32,64*1024*1024,value=>value.url.length*2);
  private readonly consumers=new Map<string,{count:number;foreground:number}>();
  private readonly waiting=new Map<string,Waiting>();
  private running=0;
  private backgroundRunning=0;

  acquire(key:string,itemId:string,foreground:boolean,rejectedTokens:readonly string[]=[]):{promise:Promise<ArtworkCandidate|null>;release:()=>void}{
    const consumers=this.consumers.get(key)??{count:0,foreground:0};
    consumers.count++;if(foreground)consumers.foreground++;this.consumers.set(key,consumers);
    const promise=this.cache.get(key,()=>new Promise<ArtworkCandidate|null>((resolve,reject)=>{
      if(!this.consumers.has(key)){reject(new Error('封面请求已取消'));return;}
      this.waiting.set(key,{key,itemId,size:foreground?1024:256,rejectedTokens:[...rejectedTokens],resolve,reject});this.pump();
    }));
    this.pump();let released=false,resource:string|null=null,owner='',retained:Promise<void>|null=null;
    const consumer=crypto.randomUUID();
    const visible=promise.then(async candidate=>{
      if(!candidate||released)return null;
      resource=candidate.url;owner=candidate.leaseOwner??'';
      retained=window.music.artworkLease(resource,itemId,consumer,true,owner);
      // Keep the resource pinned before exposing its address to the visible image.
      await retained;
      return released?null:candidate;
    });
    return {promise:visible,release:()=>{
      if(released)return;released=true;
      if(resource&&retained){const url=resource;void retained.catch(()=>{}).then(()=>window.music.artworkLease(url,itemId,consumer,false,owner)).catch(()=>{});}
      consumers.count--;if(foreground)consumers.foreground--;
      if(!consumers.count){
        this.consumers.delete(key);const waiting=this.waiting.get(key);
        if(waiting){this.waiting.delete(key);this.cache.clear(key);waiting.reject(new Error('封面请求已取消'));}
      }
      this.pump();
    }};
  }
  clear(key:string):void{this.cache.clear(key);}
  private pump():void{
    while(this.running<2){
      const queued=[...this.waiting.values()];
      const foreground=queued.find(job=>(this.consumers.get(job.key)?.foreground??0)>0);
      const job=foreground??(this.backgroundRunning===0?queued[0]:undefined);
      if(!job)return;
      this.waiting.delete(job.key);const background=!foreground;
      this.running++;if(background)this.backgroundRunning++;
      void loadUsableArtwork(job.itemId,job.size,false,job.rejectedTokens).then(job.resolve,job.reject).finally(()=>{
        this.running--;if(background)this.backgroundRunning--;this.pump();
      });
    }
  }
}
export const artworkRequests=new ArtworkRequests();
