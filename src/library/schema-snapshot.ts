import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
export type LibrarySchemaObject={type:'table'|'index'|'trigger'|'view';name:string;table:string;sql:string|null};
export function readLibrarySchema(db:DatabaseSync,check:()=>void=()=>{}):LibrarySchemaObject[]{
 const objects:LibrarySchemaObject[]=[];let bytes=0;
 for(const raw of db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name COLLATE BINARY').iterate()){
  check();const v=raw as {type:string;name:string;tbl_name:string;sql:string|null};
  if(!['table','index','trigger','view'].includes(v.type)||typeof v.name!=='string'||!v.name||v.name.length>512||typeof v.tbl_name!=='string'||!v.tbl_name||v.tbl_name.length>512||v.sql!==null&&typeof v.sql!=='string')throw new Error('数据库结构字段无效');
  bytes+=Buffer.byteLength(v.name+v.tbl_name+(v.sql??''));if(objects.length>=4096||bytes>16*1024*1024)throw new Error('数据库结构超过4096对象或16MiB预算');
  objects.push({type:v.type as LibrarySchemaObject['type'],name:v.name,table:v.tbl_name,sql:v.sql});
 }return objects;
}
const optional=(o:LibrarySchemaObject)=>o.type==='table'&&['sqlite_stat1','sqlite_stat4'].includes(o.name);
export function verifyLibrarySchema(db:DatabaseSync,reference:LibrarySchemaObject[],check:()=>void):{objects:number;sha256:string}{
 const actual=readLibrarySchema(db,check),required=reference.filter(o=>!optional(o)),got=actual.filter(o=>!optional(o));
 if(JSON.stringify(got)!==JSON.stringify(required)){
  const first=got.find(o=>!required.some(r=>r.type===o.type&&r.name===o.name&&JSON.stringify(r)===JSON.stringify(o)))??required.find(r=>!got.some(o=>o.type===r.type&&o.name===r.name));
  throw new Error('备份的表、索引、触发器或视图定义与当前应用不一致：'+(first?.name??'结构清单'));
 }
 for(const o of actual.filter(optional))if(!reference.some(r=>JSON.stringify(r)===JSON.stringify(o)))throw new Error('备份的SQLite统计结构不受当前构建支持');
 return {objects:got.length,sha256:createHash('sha256').update(JSON.stringify(required)).digest('hex')};
}
