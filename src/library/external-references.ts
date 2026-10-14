import type {ExternalReference} from '../shared/contracts.js';
export type ReferenceKind='artist'|'recording'|'release'|'release_group'|'release_track';
const labels:Record<ReferenceKind,string>={artist:'艺人',recording:'录音',release:'发行版',release_group:'专辑概念',release_track:'发行曲目'};
export const referenceOrder=(a:ExternalReference,b:ExternalReference):number=>a.provider!==b.provider?(a.provider<b.provider?-1:1):a.externalId===b.externalId?0:a.externalId<b.externalId?-1:1;
export function safeReferenceUrl(value:unknown):string|null{
 if(value===null||value==='')return null;
 if(typeof value!=='string'||value.length>2048||/[\u0000-\u0020]/.test(value))throw new Error('外部链接需为有效 HTTPS 地址');
 let url:URL;try{url=new URL(value);}catch{throw new Error('外部链接需为有效 HTTPS 地址');}
 if(url.protocol!=='https:'||url.username||url.password)throw new Error('外部链接需为无账号信息的 HTTPS 地址');return url.href;
}
export function normalizedReferences(kind:ReferenceKind,values:ExternalReference[]):ExternalReference[]{
 if(!Object.hasOwn(labels,kind)||!Array.isArray(values)||values.length>32)throw new Error('最多保存 32 条有效实体外部引用');
 const unique=new Set<string>();
 return values.map(ref=>{
  if(!ref||typeof ref.provider!=='string'||typeof ref.externalId!=='string')throw new Error('无效外部引用');
  if(/[\u0000-\u001f]/.test(ref.provider)||/[\u0000-\u001f]/.test(ref.externalId))throw new Error('外部来源和 ID 无效');
  const provider=ref.provider.trim().toLowerCase();let externalId=ref.externalId.trim(),url=safeReferenceUrl(ref.url);
  if(!/^[a-z0-9][a-z0-9._-]{0,47}$/.test(provider)||!externalId||externalId.length>512||/[\u0000-\u001f]/.test(externalId))throw new Error('外部来源和 ID 无效');
  if(provider==='musicbrainz'){
   if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(externalId))throw new Error(`MusicBrainz ${labels[kind]} ID 需为 MBID`);
   externalId=externalId.toLowerCase();const expected=`https://musicbrainz.org/${kind==='release_group'?'release-group':kind==='release_track'?'track':kind}/${externalId}`;
   if(url&&url!==expected)throw new Error(`MusicBrainz 链接应对应同一个${labels[kind]} MBID`);url=expected;
  }
  const key=JSON.stringify([provider,externalId]);if(unique.has(key))throw new Error('外部引用重复');unique.add(key);return {provider,externalId,url};
 }).sort(referenceOrder);
}
