import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';

// Attribute evidence only: neither a byte hash nor a permanent file identity.
export const FILE_OBSERVATION_ALGORITHM='node-bigint-stat-v1';
export const validFileObservation=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
export function fileObservation(stat:BigIntStats):string{
 if(!stat.isFile()||stat.size<0n||stat.size>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('音乐文件类型或大小无效');
 return createHash('sha256').update(JSON.stringify([FILE_OBSERVATION_ALGORITHM,...[stat.size,stat.mtimeNs,stat.ctimeNs,stat.birthtimeNs,stat.dev,stat.ino,stat.mode].map(value=>value.toString())])).digest('hex');
}
export function requireFileObservation(expected:string|undefined,stat:BigIntStats):string{
 const actual=fileObservation(stat);
 if(expected!==undefined&&(!validFileObservation(expected)||actual!==expected))throw new Error('音乐文件与扫描资料已不一致，请重新扫描后再读取或播放');
 return actual;
}
