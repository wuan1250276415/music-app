import {createHash} from 'node:crypto';

export interface ProviderEndpoint {
 origin:string;path:RegExp;emptyOnNotFound?:boolean;
 method?:'POST';maxRequestBytes?:number;
 format?:'bytes';maxResponseBytes?:number;contentTypes?:string[];
 redirects?:{maxHops:number;accept:(original:URL,from:URL,to:URL)=>boolean;forwardHeaders:string[]};
}
export interface ProviderPolicy {
 id:string;capabilities:Record<string,ProviderEndpoint>;intervalMs:number;timeoutMs:number;deadlineMs:number;maxAttempts:number;maxQueued:number;
 maxResponseBytes:number;cacheMs:number;reviewMs:number;rights:{display:boolean;cache:'none'|'memory';persist:boolean;label:string;termsUrl:string;verifiedAt:string};
}
export interface ProviderTransport {
 request<T>(provider:string,capability:string,url:URL,headers:Record<string,string>,decode:(value:unknown)=>T,options?:{signal?:AbortSignal;fresh?:boolean;body?:string}):Promise<ProviderResult<T>>;
 dispose():void;
}
/** Copy mutable adapter policy before registration. Callback code remains trusted built-in code. */
export function snapshotProviderPolicy(policy:ProviderPolicy):ProviderPolicy {
 const number=(value:number,min:number,max:number)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
 if(!policy||!/^[a-z][a-z0-9-]{0,63}$/.test(policy.id)||!policy.capabilities||typeof policy.capabilities!=='object'||Array.isArray(policy.capabilities)||!Object.keys(policy.capabilities).length||Object.keys(policy.capabilities).length>32||!number(policy.intervalMs,1,86400000)||!number(policy.timeoutMs,1,600000)||!number(policy.deadlineMs,policy.timeoutMs,3600000)||!number(policy.maxAttempts,1,4)||!number(policy.maxQueued,1,64)||!number(policy.maxResponseBytes,1024,8388608)||!number(policy.cacheMs,0,600000)||!number(policy.reviewMs,policy.cacheMs,3600000)||!policy.rights||policy.rights.display!==true||policy.rights.persist!==false||!['none','memory'].includes(policy.rights.cache))throw new Error('无效在线数据源策略');
 const capabilities:Record<string,ProviderEndpoint>=Object.create(null);
 for(const [name,endpoint] of Object.entries(policy.capabilities)){
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(name)||!endpoint)throw new Error('无效在线数据源能力');
  const url=new URL(endpoint.origin);
  if(url.protocol!=='https:'||url.origin!==endpoint.origin||url.username||url.password||!(endpoint.path instanceof RegExp)||endpoint.path.global||endpoint.path.sticky||endpoint.path.source.length>4096||endpoint.emptyOnNotFound!==undefined&&typeof endpoint.emptyOnNotFound!=='boolean')throw new Error('无效在线数据源能力地址');
  if(endpoint.method!==undefined&&(endpoint.method!=='POST'||!number(endpoint.maxRequestBytes!,1,131072)||endpoint.redirects))throw new Error('无效只读POST查询策略');
  if(endpoint.format!==undefined&&endpoint.format!=='bytes'||endpoint.maxResponseBytes!==undefined&&!number(endpoint.maxResponseBytes,1024,16777216)||endpoint.format==='bytes'&&(!Array.isArray(endpoint.contentTypes)||!endpoint.contentTypes.length||endpoint.contentTypes.length>8||endpoint.contentTypes.some(type=>!/^image\/(jpeg|png|webp|gif|bmp)$/.test(type))))throw new Error('无效在线图片响应策略');
  const redirects=endpoint.redirects;
  if(redirects&&(!number(redirects.maxHops,1,4)||typeof redirects.accept!=='function'||!Array.isArray(redirects.forwardHeaders)||redirects.forwardHeaders.length>2||new Set(redirects.forwardHeaders).size!==redirects.forwardHeaders.length||redirects.forwardHeaders.some(name=>!['accept','user-agent'].includes(name))))throw new Error('无效在线数据源跳转策略');
  capabilities[name]={...endpoint,path:new RegExp(endpoint.path.source,endpoint.path.flags),...(endpoint.contentTypes?{contentTypes:[...endpoint.contentTypes]}:{}),...(redirects?{redirects:{...redirects,forwardHeaders:[...redirects.forwardHeaders]}}:{})};
 }
 return {...policy,capabilities,rights:{...policy.rights}};
}

export interface ProviderBrokerState {provider:string;active:number;queued:number;cacheEntries:number;retryAt:number|null;blocked:boolean}
export interface ProviderResult<T> {value:T;fetchedAt:string;expiresAt:string;cacheHit:boolean;rights:ProviderPolicy['rights']}
type Cache={value:unknown;fetchedAt:string;expires:number;reviewUntil:string;bytes:number;provider:string;epoch:number};
type Job={url:string;body?:string;endpoint:ProviderEndpoint;headers:Record<string,string>;decode:(value:unknown)=>unknown;controller:AbortController;signal:AbortSignal;epoch:number;key:string;fresh:boolean;
 resolve:(value:ProviderResult<unknown>)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout;unlink:()=>void;abort:()=>void;done:boolean;started:boolean};
type Lane={policy:ProviderPolicy;queue:Job[];running:Job|null;nextAt:number;failures:number;blocked:boolean;epoch:number};
class ProviderError extends Error {constructor(message:string,readonly retryable=false,readonly auth=false){super(message);}}
const aborted=(signal:AbortSignal)=>signal.reason instanceof Error?signal.reason:new Error('在线查询已取消');
function wait(ms:number,signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(aborted(signal));return;}const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},Math.max(0,ms));const cancel=()=>{clearTimeout(timer);reject(aborted(signal));};signal.addEventListener('abort',cancel,{once:true});});}
function untilAbort<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{return new Promise((resolve,reject)=>{if(signal.aborted){reject(aborted(signal));return;}const cancel=()=>reject(aborted(signal));signal.addEventListener('abort',cancel,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',cancel));});}
function retryAfter(value:string|null):number|null{
 if(!value)return null;const text=value.trim(),delay=/^\d+(?:\.\d+)?$/.test(text)?Number(text)*1000:Date.parse(text)-Date.now();return Number.isFinite(delay)?Math.max(0,delay):null;
}
function cacheLifetime(headers:Headers,maximum:number):number{
 const control=headers.get('cache-control')??'';if(/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control))return 0;
 const age=Number(headers.get('age')??0),maxAge=/(?:^|,)\s*max-age\s*=\s*"?(\d+)/i.exec(control),expires=Date.parse(headers.get('expires')??'');
 let ttl=maximum;if(maxAge)ttl=Math.min(ttl,Math.max(0,Number(maxAge[1])*1000-(Number.isFinite(age)?age*1000:0)));if(Number.isFinite(expires))ttl=Math.min(ttl,Math.max(0,expires-Date.now()));return ttl;
}
export class ProviderBroker {
 private readonly flights=new Set<Promise<void>>();
 private maintenanceOwner:string|null=null;
 beginMaintenance(owner:string):void{if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('数据源维护身份不符');this.maintenanceOwner=owner;for(const id of this.lanes.keys())this.clear(id,true);}
 assertMaintenanceIdle(owner:string):void{if(this.maintenanceOwner!==owner||[...this.lanes.values()].some(lane=>lane.running||lane.queue.length))throw new Error('在线查询仍未结束或维护身份不符');}
 async waitMaintenance(owner:string):Promise<void>{await Promise.allSettled([...this.flights]);this.assertMaintenanceIdle(owner);if(this.flights.size)throw new Error('仍有在线处理没有结束');}
 endMaintenance(owner:string):void{this.assertMaintenanceIdle(owner);this.maintenanceOwner=null;}
 private readonly lanes=new Map<string,Lane>();private readonly cache=new Map<string,Cache>();private cacheBytes=0;private closed=false;
 private readonly cleanup:NodeJS.Timeout;
 constructor(private readonly fetcher:typeof fetch=fetch,private readonly changed:()=>void=()=>{}){this.cleanup=setInterval(()=>this.prune(),15000);this.cleanup.unref();}
 register(policy:ProviderPolicy):void{this.registerBatch([policy]);}
 registerBatch(policies:ReadonlyArray<ProviderPolicy>):void{
  if(this.closed||!policies.length||policies.length>32)throw new Error('无效在线数据源登记');
  const snapshots=policies.map(snapshotProviderPolicy),ids=new Set<string>();
  for(const policy of snapshots){if(this.lanes.has(policy.id)||ids.has(policy.id))throw new Error('在线数据源已注册');ids.add(policy.id);}
  for(const policy of snapshots){
   for(const endpoint of Object.values(policy.capabilities)){if(endpoint.redirects){Object.freeze(endpoint.redirects.forwardHeaders);Object.freeze(endpoint.redirects);}if(endpoint.contentTypes)Object.freeze(endpoint.contentTypes);Object.freeze(endpoint.path);Object.freeze(endpoint);}
   Object.freeze(policy.rights);Object.freeze(policy.capabilities);Object.freeze(policy);
   this.lanes.set(policy.id,{policy,queue:[],running:null,nextAt:0,failures:0,blocked:false,epoch:0});
  }
 }

 private remove(key:string):void{const old=this.cache.get(key);if(old)this.cacheBytes-=old.bytes;this.cache.delete(key);}
 private prune():void{let removed=false;for(const [key,entry] of this.cache)if(entry.expires<=Date.now()){this.remove(key);removed=true;}if(removed)this.changed();}
 state(provider:string):ProviderBrokerState{const lane=this.lanes.get(provider);if(!lane)throw new Error('在线数据源未注册');this.prune();return {provider,active:lane.running?1:0,queued:lane.queue.length,cacheEntries:[...this.cache.values()].filter(entry=>entry.provider===provider).length,retryAt:lane.nextAt>Date.now()?lane.nextAt:null,blocked:lane.blocked};}
 clear(provider:string,cancel=false):void{
  const lane=this.lanes.get(provider);if(!lane)throw new Error('在线数据源未注册');lane.epoch++;lane.failures=0;lane.blocked=false;
  // Clearing content does not bypass a provider-requested retry delay or rate limit.
  for(const [key,entry] of this.cache)if(entry.provider===provider)this.remove(key);
  if(cancel){lane.running?.controller.abort(new Error('在线查询已取消'));for(const job of [...lane.queue])job.controller.abort(new Error('在线查询已取消'));}this.changed();
 }
 dispose():void{this.closed=true;clearInterval(this.cleanup);for(const provider of this.lanes.keys())this.clear(provider,true);}
 request<T>(provider:string,capability:string,url:URL,headers:Record<string,string>,decode:(value:unknown)=>T,options:{signal?:AbortSignal;fresh?:boolean;body?:string}={}):Promise<ProviderResult<T>>{
  if(this.maintenanceOwner)return Promise.reject(new Error('曲库维护期间暂停新的在线请求'));
  if(this.closed)return Promise.reject(new Error('在线数据源服务已关闭'));const lane=this.lanes.get(provider),allowed=lane?.policy.capabilities[capability];if(!lane||!allowed||url.origin!==allowed.origin||url.protocol!=='https:'||url.username||url.password||url.hash||!allowed.path.test(url.pathname))return Promise.reject(new Error('请求不属于已注册的数据源能力'));
  if(allowed.method==='POST'?(url.search||typeof options.body!=='string'||!options.body||Buffer.byteLength(options.body)>allowed.maxRequestBytes!):options.body!==undefined)return Promise.reject(new Error('请求正文不属于已注册的只读查询能力'));
  if(options.signal?.aborted)return Promise.reject(aborted(options.signal));if(lane.blocked)return Promise.reject(new Error('数据源拒绝访问，请检查联系信息后重新启用查询'));this.prune();
  const key=createHash('sha256').update(JSON.stringify([provider,capability,url.href,headers,lane.epoch,...(allowed.method==='POST'?[options.body]:[])])).digest('hex'),cached=this.cache.get(key);
  if(!options.fresh&&cached&&cached.expires>Date.now()&&cached.epoch===lane.epoch){this.cache.delete(key);this.cache.set(key,cached);return Promise.resolve({value:structuredClone(cached.value) as T,fetchedAt:cached.fetchedAt,expiresAt:cached.reviewUntil,cacheHit:true,rights:{...lane.policy.rights}});}
  if(lane.queue.length+(lane.running?1:0)>=lane.policy.maxQueued)return Promise.reject(new Error('在线查询队列已满，请稍后重试'));
  return new Promise<ProviderResult<T>>((resolve,reject)=>{
   const controller=new AbortController(),cancel=()=>controller.abort(options.signal?.reason??new Error('在线查询已取消'));
   const job:Job={url:url.href,body:options.body,endpoint:allowed,headers:{...headers},decode,controller,signal:controller.signal,epoch:lane.epoch,key,fresh:options.fresh===true,resolve:resolve as (value:ProviderResult<unknown>)=>void,reject,
    timer:setTimeout(()=>controller.abort(new Error('在线查询等待或处理超时，请稍后重试')),lane.policy.deadlineMs),unlink:()=>options.signal?.removeEventListener('abort',cancel),abort:()=>{},done:false,started:false};
   job.abort=()=>{if(!job.started){const index=lane.queue.indexOf(job);if(index>=0)lane.queue.splice(index,1);this.finish(job,aborted(job.signal));}else if(!job.done){job.done=true;job.reject(aborted(job.signal));clearTimeout(job.timer);job.unlink();}this.changed();};
   job.signal.addEventListener('abort',job.abort,{once:true});options.signal?.addEventListener('abort',cancel,{once:true});lane.queue.push(job);this.changed();void this.pump(lane);
  });
 }
 private finish(job:Job,error?:Error,result?:ProviderResult<unknown>):void{
  clearTimeout(job.timer);job.unlink();job.signal.removeEventListener('abort',job.abort);job.body=undefined;if(job.done)return;job.done=true;if(error)job.reject(error);else job.resolve(result!);
 }
 private pump(lane:Lane):Promise<void>{if(lane.running||this.maintenanceOwner)return Promise.resolve();const work=this.runLane(lane).finally(()=>{this.flights.delete(work);});this.flights.add(work);return work;}
 private async runLane(lane:Lane):Promise<void>{
  if(lane.running)return;const job=lane.queue.shift();if(!job)return;lane.running=job;job.started=true;this.changed();
  try{if(job.signal.aborted)throw aborted(job.signal);if(lane.blocked)throw new ProviderError('数据源拒绝访问，请检查联系信息后重新启用查询');
   const cached=this.cache.get(job.key),result=!job.fresh&&cached&&cached.expires>Date.now()&&cached.epoch===lane.epoch?{value:structuredClone(cached.value),fetchedAt:cached.fetchedAt,expiresAt:cached.reviewUntil,cacheHit:true,rights:{...lane.policy.rights}}:await this.execute(lane,job);
   job.signal.throwIfAborted();if(job.epoch!==lane.epoch)throw new Error('查询状态已变化，请重新搜索');this.finish(job,undefined,result);
  }catch(error){this.finish(job,error instanceof Error?error:new Error('在线查询失败'));}finally{lane.running=null;this.changed();void this.pump(lane);}
 }
 private async execute(lane:Lane,job:Job):Promise<ProviderResult<unknown>>{
  const {policy}=lane;let failure:Error=new Error('在线查询失败');
  for(let attempt=0;attempt<policy.maxAttempts;attempt++){
   job.signal.throwIfAborted();while(lane.nextAt>Date.now())await wait(Math.min(60000,lane.nextAt-Date.now()),job.signal);job.signal.throwIfAborted();lane.nextAt=Date.now()+policy.intervalMs;this.changed();
   const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new ProviderError('数据源响应超时',true)),policy.timeoutMs),signal=AbortSignal.any([job.signal,timeout.signal]);
   try{
    const response=await this.fetchResponse(lane,job,signal),empty=response.status===404&&job.endpoint.emptyOnNotFound===true;
    if(!response.ok&&!empty){void response.body?.cancel().catch(()=>{});const auth=[401,403,407].includes(response.status),retryable=[408,429,500,502,503,504].includes(response.status),delay=retryAfter(response.headers.get('retry-after'));
     if(retryable&&delay!==null)lane.nextAt=Math.min(Number.MAX_SAFE_INTEGER,Math.max(lane.nextAt,Date.now()+delay));throw new ProviderError(`数据源请求失败（HTTP ${response.status}）`,retryable,auth);}
    let payload:unknown=null;
    if(empty){void response.body?.cancel().catch(()=>{});}else{
     const contentType=response.headers.get('content-type'),binary=job.endpoint.format==='bytes';
     if(binary?!contentType||!job.endpoint.contentTypes!.includes(contentType.split(';')[0].trim().toLowerCase()):contentType&&!/\b(?:application\/json|application\/[^;]+\+json)\b/i.test(contentType)){void response.body?.cancel().catch(()=>{});throw new ProviderError('数据源返回了不支持的内容类型');}
     const bytes=await this.readBytes(response,signal,job.endpoint.maxResponseBytes??policy.maxResponseBytes);
     if(binary)payload=bytes;else{let body:string;try{body=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ProviderError('数据源响应编码无效');}try{payload=JSON.parse(body);}catch{throw new ProviderError('数据源返回了无效 JSON');}}
    }
    const value=job.decode(payload);job.signal.throwIfAborted();if(job.epoch!==lane.epoch)throw new ProviderError('查询状态已变化，请重新搜索');
    const fetchedAt=new Date().toISOString(),reviewUntil=new Date(Date.now()+policy.reviewMs).toISOString(),result={value,fetchedAt,expiresAt:reviewUntil,cacheHit:false,rights:{...policy.rights}};
    lane.failures=0;lane.blocked=false;const ttl=empty||job.endpoint.format==='bytes'?0:cacheLifetime(response.headers,policy.cacheMs),serialized=ttl?JSON.stringify(value):'',bytes=Buffer.byteLength(serialized??'');
    if(ttl>0&&policy.rights.cache==='memory'&&bytes<=4*1024*1024){this.remove(job.key);this.cache.set(job.key,{value:structuredClone(value),fetchedAt,expires:Date.now()+ttl,reviewUntil,bytes,provider:policy.id,epoch:lane.epoch});this.cacheBytes+=bytes;
     while(this.cache.size>64||this.cacheBytes>16*1024*1024){const first=this.cache.keys().next().value;if(first===undefined)break;this.remove(first);}}
    return result;
   }catch(error){
    if(job.signal.aborted)throw aborted(job.signal);failure=timeout.signal.aborted?aborted(timeout.signal):error instanceof Error?error:new Error('在线查询失败');
    const retryable=failure instanceof ProviderError?failure.retryable:failure instanceof TypeError;
    if(failure instanceof ProviderError&&failure.auth){lane.blocked=true;throw failure;}
    if(!retryable)throw failure;
    if(attempt+1<policy.maxAttempts){lane.nextAt=Math.max(lane.nextAt,Date.now()+Math.min(8000,1000*2**attempt)+Math.floor(Math.random()*300));this.changed();}
   }finally{clearTimeout(timer);}
  }
  lane.failures++;if(lane.failures>=3)lane.nextAt=Math.max(lane.nextAt,Date.now()+Math.min(120000,30000*2**(lane.failures-3)));this.changed();throw failure;
 }
 private async fetchResponse(lane:Lane,job:Job,signal:AbortSignal):Promise<Response>{
  const original=new URL(job.url),seen=new Set([original.href]);let url=original,headers=job.headers;
  for(let hop=0;;hop++){
   const response=await untilAbort(this.fetcher(url.href,{method:job.endpoint.method??'GET',...(job.body===undefined?{}:{body:job.body}),headers,signal,redirect:'manual',credentials:'omit',cache:'no-store'}),signal);
   if(![301,302,303,307,308].includes(response.status))return response;
   void response.body?.cancel().catch(()=>{});
   const rules=job.endpoint.redirects,location=response.headers.get('location');
   if(!rules||hop>=rules.maxHops||!location||location.length>2048)throw new ProviderError('数据源返回了未允许的跳转');
   let target:URL;try{target=new URL(location,url);}catch{throw new ProviderError('数据源跳转地址无效');}
   if(target.protocol!=='https:'||target.username||target.password||target.hash||target.port||seen.has(target.href)||!rules.accept(original,url,target))throw new ProviderError('数据源跳转不属于当前来源条目');
   // Only the public application identifier and JSON accept header may cross hosts.
   if(target.origin!==url.origin)headers=Object.fromEntries(Object.entries(headers).filter(([name])=>rules.forwardHeaders.includes(name.toLowerCase())));
   seen.add(target.href);url=target;
   while(lane.nextAt>Date.now())await wait(Math.min(60000,lane.nextAt-Date.now()),signal);
   signal.throwIfAborted();lane.nextAt=Date.now()+lane.policy.intervalMs;this.changed();
  }
 }
 private async readBytes(response:Response,signal:AbortSignal,maxBytes:number):Promise<Buffer>{
  const size=Number(response.headers.get('content-length'));if(Number.isFinite(size)&&size>maxBytes){void response.body?.cancel().catch(()=>{});throw new ProviderError('数据源响应过大');}
  if(!response.body)throw new ProviderError('数据源返回了空响应');const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const chunk=await untilAbort(reader.read(),signal);signal.throwIfAborted();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>maxBytes)throw new ProviderError('数据源响应过大');chunks.push(chunk.value);}return Buffer.concat(chunks,bytes);}
  finally{void reader.cancel().catch(()=>{});}
 }
}
