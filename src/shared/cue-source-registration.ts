import {cueId,cueHash} from './cue-history.js';
export interface CueSourceRegisterRequest {commandId:string;rootId:string;rootPath:string;relativePath:string;archiveSha256:string}
export function readCueSourceRegisterRequest(value:unknown):CueSourceRegisterRequest {
 const keys=['commandId','rootId','rootPath','relativePath','archiveSha256'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('新CUE来源登记请求无效');const r=value as CueSourceRegisterRequest;
 if(typeof r.rootPath!=='string'||!r.rootPath||r.rootPath.length>32767||r.rootPath.includes('\0')||typeof r.relativePath!=='string'||!r.relativePath||r.relativePath.length>4096||/[\u0000-\u001f]/.test(r.relativePath))throw new Error('新CUE来源目录或相对路径无效');
 return {commandId:cueId(r.commandId),rootId:cueId(r.rootId),rootPath:r.rootPath,relativePath:r.relativePath,archiveSha256:cueHash(r.archiveSha256)};
}
