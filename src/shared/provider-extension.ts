/** Versioned contract for compiled, trusted providers. This is not a public plugin sandbox. */
export const PROVIDER_API = {major:1,minor:0} as const;
export interface ProviderDomain {host:string;subdomains:boolean}
export interface ProviderPermissions {network:ProviderDomain[];credentials:string[]}
export interface ProviderExtensionManifest {
 id:string;version:string;kind:'builtin-provider';
 apiVersion:{major:number;minor:number};
 hostApiRange:{major:number;minMinor:number;maxMinor:number};
 platforms:Array<'win32'|'darwin'|'linux'>;architectures:Array<'x64'|'arm64'>;
 capabilities:string[];permissions:ProviderPermissions;
}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(value);
function keys(value:unknown,names:string[]):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===names.length&&Object.keys(value).every(name=>names.includes(name));}
function strings(value:unknown,allowed?:(value:string)=>boolean):value is string[]{return Array.isArray(value)&&value.length<=32&&new Set(value).size===value.length&&value.every(v=>typeof v==='string'&&(!allowed||allowed(v)));}
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=65535;
export function readProviderExtension(value:unknown):ProviderExtensionManifest {
 if(!keys(value,['id','version','kind','apiVersion','hostApiRange','platforms','architectures','capabilities','permissions'])||!id(value.id)||typeof value.version!=='string'||!/^[0-9]{1,5}(?:\.[0-9]{1,5}){0,2}$/.test(value.version)||value.kind!=='builtin-provider')throw new Error('数据源扩展清单无效');
 const api=value.apiVersion,range=value.hostApiRange,permissions=value.permissions;
 if(!keys(api,['major','minor'])||!integer(api.major)||!integer(api.minor)||!keys(range,['major','minMinor','maxMinor'])||!integer(range.major)||!integer(range.minMinor)||!integer(range.maxMinor)||range.minMinor>range.maxMinor)throw new Error('数据源扩展接口版本无效');
 if(!strings(value.platforms,p=>['win32','darwin','linux'].includes(p))||!value.platforms.length||!strings(value.architectures,a=>['x64','arm64'].includes(a))||!value.architectures.length||!strings(value.capabilities,id)||!value.capabilities.length)throw new Error('数据源扩展能力或平台声明无效');
 if(!keys(permissions,['network','credentials'])||!strings(permissions.credentials,id)||!Array.isArray(permissions.network)||!permissions.network.length||permissions.network.length>16)throw new Error('数据源扩展权限声明无效');
 const domains=new Set<string>();
 for(const domain of permissions.network){
  if(!keys(domain,['host','subdomains'])||typeof domain.host!=='string'||domain.host.length>253||! /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain.host)||/\.(?:local|internal|localhost)$/.test(domain.host)||typeof domain.subdomains!=='boolean'||domains.has(domain.host))throw new Error('数据源扩展网络范围无效');
  domains.add(domain.host);
 }
 return structuredClone(value) as unknown as ProviderExtensionManifest;
}
export function assertProviderExtensionCompatible(manifest:ProviderExtensionManifest,platform:string,architecture:string):void {
 const range=manifest.hostApiRange;
 if(manifest.apiVersion.major!==PROVIDER_API.major||manifest.apiVersion.minor>PROVIDER_API.minor||range.major!==PROVIDER_API.major||PROVIDER_API.minor<range.minMinor||PROVIDER_API.minor>range.maxMinor)throw new Error('数据源扩展与当前接口版本不兼容');
 if(!manifest.platforms.includes(platform as ProviderExtensionManifest['platforms'][number])||!manifest.architectures.includes(architecture as ProviderExtensionManifest['architectures'][number]))throw new Error('数据源扩展不支持当前平台或处理器');
}
export function providerDomainAllows(domains:ReadonlyArray<ProviderDomain>,url:URL):boolean {
 return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&!url.hash&&domains.some(domain=>url.hostname===domain.host||domain.subdomains&&url.hostname.endsWith('.'+domain.host));
}
