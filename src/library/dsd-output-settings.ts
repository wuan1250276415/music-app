import type {DatabaseSync} from 'node:sqlite';
import {defaultDsdOutput,nextDsdOutput,readDsdOutputPreference,readDsdOutputRequest,type DsdOutputPreference} from '../shared/dsd-output.js';
export const dsdOutputSettingsSchema=`
 CREATE TABLE dsd_output_setting(id INTEGER PRIMARY KEY CHECK(id=1),value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(CAST(value_json AS BLOB))<=262144));
 CREATE TABLE dsd_output_change(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=16384),previous_json TEXT NOT NULL CHECK(json_valid(previous_json) AND length(CAST(previous_json AS BLOB))<=262144),value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(CAST(value_json AS BLOB))<=262144),created_at TEXT NOT NULL);
 CREATE TRIGGER dsd_output_change_immutable BEFORE UPDATE ON dsd_output_change BEGIN SELECT RAISE(ABORT,'DSD 设置回执不可修改'); END;
 CREATE TRIGGER dsd_output_change_no_delete BEFORE DELETE ON dsd_output_change BEGIN SELECT RAISE(ABORT,'DSD 设置回执不可删除'); END;
`;
export class DsdOutputSettings {
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 load():DsdOutputPreference{const row=this.db.prepare('SELECT value_json FROM dsd_output_setting WHERE id=1').get() as {value_json:string}|undefined;return row?readDsdOutputPreference(JSON.parse(row.value_json)):defaultDsdOutput();}
 receipt(value:unknown):DsdOutputPreference|null {
  const r=readDsdOutputRequest(value),row=this.db.prepare('SELECT request_json,previous_json,value_json FROM dsd_output_change WHERE command_id=?').get(r.commandId) as {request_json:string;previous_json:string;value_json:string}|undefined;
  if(!row)return null;if(JSON.stringify(readDsdOutputRequest(JSON.parse(row.request_json)))!==JSON.stringify(r))throw new Error('DSD 操作 ID 已用于其他内容');
  const result=readDsdOutputPreference(JSON.parse(row.value_json)),expected=nextDsdOutput(JSON.parse(row.previous_json),r);
  if(JSON.stringify(result)!==JSON.stringify(expected))throw new Error('DSD 保存回执与原操作不一致');return result;
 }
 save(value:unknown):DsdOutputPreference {
  const r=readDsdOutputRequest(value);return this.transaction(()=>{
   const existing=this.receipt(r);if(existing)return existing;
   const before=this.load(),after=nextDsdOutput(before,r),request=JSON.stringify(r),previous=JSON.stringify(before),saved=JSON.stringify(after);
   if(Buffer.byteLength(request,'utf8')>16384||Buffer.byteLength(previous,'utf8')>262144||Buffer.byteLength(saved,'utf8')>262144)throw new Error('DSD 设置超过保存预算');
   const totals=this.db.prepare('SELECT COUNT(*) count,COALESCE(SUM(length(CAST(request_json AS BLOB))+length(CAST(previous_json AS BLOB))+length(CAST(value_json AS BLOB))),0) bytes FROM dsd_output_change').get() as {count:number;bytes:number};
   if(totals.count>=65536||totals.bytes+Buffer.byteLength(request+previous+saved,'utf8')>256*1024*1024)throw new Error('DSD 设置回执达到容量上限，原历史已保留');
   this.db.prepare('INSERT INTO dsd_output_setting VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(saved);
   this.db.prepare('INSERT INTO dsd_output_change VALUES(?,?,?,?,?)').run(r.commandId,request,previous,saved,new Date().toISOString());return after;
  });
 }
}
