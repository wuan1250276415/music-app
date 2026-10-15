import {readProviderExtension,assertProviderExtensionCompatible,providerDomainAllows,type ProviderExtensionManifest,type ProviderPermissions} from '../shared/provider-extension.js';
import {snapshotProviderPolicy,type ProviderBroker,type ProviderPolicy,type ProviderTransport} from './provider-broker.js';

export interface ProviderHostGrant {id:string;version:string;capabilities:string[];permissions:ProviderPermissions}
export interface BuiltinProviderDefinition {manifest:ProviderExtensionManifest;policy:ProviderPolicy}
type Admitted={manifest:ProviderExtensionManifest;active:boolean;controllers:Set<AbortController>};
/** Only the composition root supplies grants. No IPC accepts adapters, policies or grants. */
export class ProviderExtensionHost {
 private readonly admitted=new Map<string,Admitted>();
 constructor(private readonly broker:ProviderBroker,definitions:ReadonlyArray<BuiltinProviderDefinition>,grants:ReadonlyArray<ProviderHostGrant>,platform:string=process.platform,architecture:string=process.arch){
  if(!definitions.length||definitions.length>32||new Set(grants.map(g=>g.id)).size!==grants.length)throw new Error('数据源宿主登记范围无效');
  const policies:ProviderPolicy[]=[];
  for(const definition of definitions){
   const manifest=readProviderExtension(definition.manifest),grant=grants.find(g=>g.id===manifest.id);
   assertProviderExtensionCompatible(manifest,platform,architecture);
   if(this.admitted.has(manifest.id)||!grant||grant.version!==manifest.version||manifest.capabilities.some(c=>!grant.capabilities.includes(c))||manifest.permissions.credentials.some(c=>!grant.permissions.credentials.includes(c)))throw new Error('数据源扩展未取得宿主能力授权');
   if(manifest.permissions.network.some(d=>!grant.permissions.network.some(g=>d.host===g.host&&(!d.subdomains||g.subdomains)||g.subdomains&&d.host.endsWith('.'+g.host))))throw new Error('数据源扩展网络范围超出宿主授权');
   const policy=snapshotProviderPolicy(definition.policy),capabilities=Object.keys(policy.capabilities);
   if(policy.id!==manifest.id||capabilities.length!==manifest.capabilities.length||capabilities.some(c=>!manifest.capabilities.includes(c)))throw new Error('数据源扩展声明与实际接口不一致');
   for(const endpoint of Object.values(policy.capabilities)){
    if(!providerDomainAllows(manifest.permissions.network,new URL(endpoint.origin)))throw new Error('数据源接口地址超出授权范围');
    if(endpoint.redirects){const accept=endpoint.redirects.accept,domains=structuredClone(manifest.permissions.network);endpoint.redirects={...endpoint.redirects,accept:(original,from,to)=>providerDomainAllows(domains,original)&&providerDomainAllows(domains,from)&&providerDomainAllows(domains,to)&&accept(original,from,to)};}
   }
   policies.push(policy);this.admitted.set(manifest.id,{manifest,active:true,controllers:new Set()});
  }
  // Validate the whole group before changing the broker; an invalid adapter cannot leave a partial registration.
  broker.registerBatch(policies);
 }
 manifest(id:string):ProviderExtensionManifest {const entry=this.admitted.get(id);if(!entry)throw new Error('数据源扩展未注册');return structuredClone(entry.manifest);}
 client(id:string):ProviderTransport {
  const entry=this.admitted.get(id);if(!entry||!entry.active)throw new Error('数据源扩展已关闭或未注册');
  return Object.freeze({request:<T>(provider:string,capability:string,url:URL,headers:Record<string,string>,decode:(value:unknown)=>T,options:Parameters<ProviderTransport['request']>[5]={})=>{
   if(!entry.active||provider!==id||!entry.manifest.capabilities.includes(capability)||!providerDomainAllows(entry.manifest.permissions.network,url))return Promise.reject(new Error('数据源请求超出所属扩展授权'));
   if(entry.controllers.size>=65)return Promise.reject(new Error('数据源扩展请求超过预算'));
   if(options.signal?.aborted)return Promise.reject(options.signal.reason??new Error('在线查询已取消'));
   const controller=new AbortController(),signal=options.signal?AbortSignal.any([controller.signal,options.signal]):controller.signal,target=new URL(url.href);entry.controllers.add(controller);
   return Promise.resolve().then(()=>this.broker.request(provider,capability,target,{...headers},decode,{...options,signal})).finally(()=>entry.controllers.delete(controller));
  },dispose:()=>this.revoke(id)});
 }
 revoke(id:string):void {const entry=this.admitted.get(id);if(!entry)throw new Error('数据源扩展未注册');if(!entry.active)return;entry.active=false;for(const controller of entry.controllers)controller.abort(new Error('数据源扩展已关闭'));this.broker.clear(id,true);}
 dispose():void {for(const id of this.admitted.keys())this.revoke(id);}
}
