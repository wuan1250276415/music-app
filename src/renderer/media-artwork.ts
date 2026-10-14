import type {ArtworkCandidate} from '../shared/contracts';

function decodable(url:string,timeoutMs:number):Promise<boolean> {
  return new Promise(resolve=>{
    const image=new Image();let settled=false;
    const finish=(usable:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);image.onload=null;image.onerror=null;image.removeAttribute('src');resolve(usable);};
    const timer=setTimeout(()=>finish(false),timeoutMs);
    image.onload=()=>finish(image.naturalWidth>0&&image.naturalHeight>0&&image.naturalWidth<=8192&&image.naturalHeight<=8192&&image.naturalWidth*image.naturalHeight<=32*1024*1024);
    image.onerror=()=>finish(false);image.src=url;
  });
}

async function within<T>(request:Promise<T>,milliseconds:number):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([request,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('封面读取超时，可在详情中重新读取')),milliseconds);})]);}
  finally{clearTimeout(timer);}
}

// Only supervised, normalized thumbnails reach Chromium; the resource load remains checked.
export async function loadUsableArtwork(itemId:string,thumbnailSize:256|1024=1024,refresh=false,rejectedTokens:readonly string[]=[]):Promise<ArtworkCandidate|null>{
  const rejected=[...new Set(rejectedTokens)];const deadline=Date.now()+60000;
  let retryToken:string|null=null;
  if(rejected.length>8||rejected.some(token=>!/^[0-9a-f]{64}$/.test(token)))throw new Error('封面候选无效');
  while(rejected.length<8){
    const remaining=deadline-Date.now();if(remaining<=0)throw new Error('封面读取超时');
    const candidate=await within(window.music.artworkCandidate(itemId,rejected,thumbnailSize,refresh),remaining);
    refresh=false;
    if(!candidate)return null;
    if(rejected.includes(candidate.token))return null;
    // The probe is an image consumer too. Pin before Chromium reads the resource,
    // so eviction cannot turn an embedded cover into an apparent decode failure.
    const consumer=crypto.randomUUID(),owner=candidate.leaseOwner??'';
    const retained=window.music.artworkLease(candidate.url,itemId,consumer,true,owner);
    let usable=false;
    try{
      const leaseBudget=deadline-Date.now();if(leaseBudget<=0)throw new Error('封面读取超时');
      await within(retained,leaseBudget);
      const decodeBudget=Math.min(5000,deadline-Date.now());if(decodeBudget<=0)throw new Error('封面读取超时');
      usable=await decodable(candidate.url,decodeBudget);
    }finally{
      // Also clean up a retain acknowledged after our deadline. A failed retain
      // may have taken effect in the service; release the same consumer either way.
      void retained.catch(()=>{}).then(()=>window.music.artworkLease(candidate.url,itemId,consumer,false,owner)).catch(()=>{});
    }
    if(usable)return candidate;
    // Re-register once before excluding a source; transient resource failures
    // must not immediately replace an embedded cover with a directory image.
    if(retryToken!==candidate.token){retryToken=candidate.token;continue;}
    rejected.push(candidate.token);retryToken=null;
  }
  return null;
}
