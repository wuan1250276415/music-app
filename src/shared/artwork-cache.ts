// Cache successful images only. A failed or missing image remains retryable.
export class ArtworkCache<T=string> {
  private readonly entries = new Map<string,{request:Promise<T|null>;bytes:number;settled:boolean;expires:number}>();
  constructor(private readonly maxEntries=32,private readonly maxBytes=64*1024*1024,
    private readonly measure:(value:T)=>number=value=>typeof value==='string'?value.length*2:0,
    private readonly maxAgeMs=30000) {}

  clear(key?:string):void {
    if(key===undefined)this.entries.clear();else this.entries.delete(key);
  }

  clearPrefix(prefix:string):void {
    for(const key of this.entries.keys())if(key.startsWith(prefix))this.entries.delete(key);
  }

  get(key:string,load:()=>Promise<T|null>):Promise<T|null> {
    const cached=this.entries.get(key);
    if(cached&&(!cached.settled||cached.expires>Date.now())){this.entries.delete(key);this.entries.set(key,cached);return cached.request;}
    if(cached)this.entries.delete(key);
    const entry:{request:Promise<T|null>;bytes:number;settled:boolean;expires:number}={request:Promise.resolve(null),bytes:0,settled:false,expires:Infinity};
    entry.request=Promise.resolve().then(load).then(value=>{
      if(this.entries.get(key)===entry){
        if(!value)this.entries.delete(key);
        else{entry.bytes=this.measure(value);entry.settled=true;entry.expires=Date.now()+this.maxAgeMs;this.trim();}
      }
      return value;
    },error=>{
      if(this.entries.get(key)===entry)this.entries.delete(key);
      throw error;
    });
    this.entries.set(key,entry);
    this.trim();
    return entry.request;
  }

  private trim():void {
    let bytes=0;for(const entry of this.entries.values())bytes+=entry.bytes;
    for(const [key,entry] of this.entries){
      if(this.entries.size<=this.maxEntries&&bytes<=this.maxBytes)break;
      // Pending promises are small and remain shared until loading completes.
      if(!entry.settled)continue;
      this.entries.delete(key);bytes-=entry.bytes;
    }
  }
}
