import {tagWriteKeys,tagWriteHash,tagWriteInteger} from './tag-write.js';
export interface TagOriginSecurity {ownerSha256:string;groupSha256:string;daclSha256:string|null;present:boolean;protected:boolean}
export interface TagOriginPolicy {version:1;ownerSidHex:string;groupSidHex:string;daclHex:string|null;security:TagOriginSecurity;creation:string;modified:string;lastAccess:string;attributes:number;streams:'unnamed-only';audit:'not-certified'}
const bytes=(value:unknown,max:number):Uint8Array=>{if(typeof value!=='string'||!value.length||value.length%2||value.length>max*2||!/^[a-f0-9]+$/.test(value))throw new Error('原权限二进制长度或编码无效');return Uint8Array.from(value.match(/../g)!,v=>parseInt(v,16));};
const sid=(value:unknown)=>{const b=bytes(value,68);if(b.length<8||b[0]!==1||b[1]>15||b.length!==8+b[1]*4)throw new Error('原所有者或组SID结构无效');};
export function readTagOriginSecurity(value:unknown):TagOriginSecurity {
 if(!tagWriteKeys(value,['ownerSha256','groupSha256','daclSha256','present','protected'])||![value.ownerSha256,value.groupSha256].every(tagWriteHash)||value.daclSha256!==null&&!tagWriteHash(value.daclSha256)||typeof value.present!=='boolean'||typeof value.protected!=='boolean')throw new Error('原文件权限摘要无效');return value as unknown as TagOriginSecurity;
}
export function readTagOriginPolicy(value:unknown):TagOriginPolicy {
 if(!tagWriteKeys(value,['version','ownerSidHex','groupSidHex','daclHex','security','creation','modified','lastAccess','attributes','streams','audit'])||value.version!==1||![value.creation,value.modified,value.lastAccess].every(tagWriteInteger)||['creation','modified','lastAccess'].some(k=>BigInt(value[k] as string)>9223372036854775807n)||!Number.isSafeInteger(value.attributes)||Number(value.attributes)<0||Number(value.attributes)>4294967295||value.streams!=='unnamed-only'||value.audit!=='not-certified')throw new Error('原文件权限与时间记录无效');
 sid(value.ownerSidHex);sid(value.groupSidHex);const security=readTagOriginSecurity(value.security);
 if(value.daclHex===null){if(security.daclSha256!==null)throw new Error('原DACL空值与摘要不符');}
 else{
  const b=bytes(value.daclHex,16384),u16=(at:number)=>b[at]+b[at+1]*256;
  if(b.length<8||![2,4].includes(b[0])||u16(2)!==b.length||!security.present||security.daclSha256===null)throw new Error('原DACL头部或存在标记无效');
  let at=8;for(let i=0;i<u16(4);i++){if(at+4>b.length)throw new Error('原DACL条目缺失');const n=u16(at+2);if(n<4||n%4||at+n>b.length)throw new Error('原DACL条目长度无效');at+=n;}
 }
 return value as unknown as TagOriginPolicy;
}
