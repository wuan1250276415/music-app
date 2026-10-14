import {createHash} from 'node:crypto';
import {readTagOriginPolicy,type TagOriginPolicy} from '../shared/tag-origin-policy.js';
export function validateTagOriginPolicy(value:unknown):TagOriginPolicy {
 const p=readTagOriginPolicy(value),hash=(hex:string)=>createHash('sha256').update(Buffer.from(hex,'hex')).digest('hex');
 if(hash(p.ownerSidHex)!==p.security.ownerSha256||hash(p.groupSidHex)!==p.security.groupSha256||p.daclHex!==null&&hash(p.daclHex)!==p.security.daclSha256)throw new Error('原权限SID或DACL内容与SHA摘要不符');return p;
}
