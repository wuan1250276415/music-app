import type {DatabaseSync} from 'node:sqlite';
import {defaultAsioOutput,sameAsioDriver,validateAsioOutputPreference,validateAsioOutputRequest,validateAsioDriverIdentity,type AsioDriverIdentity,type AsioOutputPreference} from '../shared/asio-output.js';
export const asioOutputSettingsSchema=`
 CREATE TABLE asio_output_setting(id INTEGER PRIMARY KEY CHECK(id=1),value_json TEXT NOT NULL CHECK(json_valid(value_json)));
 CREATE TABLE asio_output_change(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),value_json TEXT NOT NULL CHECK(json_valid(value_json)),created_at TEXT NOT NULL);
 CREATE TRIGGER asio_output_change_immutable BEFORE UPDATE ON asio_output_change BEGIN SELECT RAISE(ABORT,'ASIO 设置回执不可修改'); END;
 CREATE TRIGGER asio_output_change_no_delete BEFORE DELETE ON asio_output_change BEGIN SELECT RAISE(ABORT,'ASIO 设置回执不可删除'); END;
`;
export class AsioOutputSettings {
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 load():AsioOutputPreference{const row=this.db.prepare('SELECT value_json FROM asio_output_setting WHERE id=1').get() as {value_json:string}|undefined;return row?validateAsioOutputPreference(JSON.parse(row.value_json)):defaultAsioOutput();}
 receipt(value:unknown):AsioOutputPreference|null{
  const r=validateAsioOutputRequest(value),row=this.db.prepare('SELECT request_json,value_json FROM asio_output_change WHERE command_id=?').get(r.commandId) as {request_json:string;value_json:string}|undefined;
  if(!row)return null;if(JSON.stringify(validateAsioOutputRequest(JSON.parse(row.request_json)))!==JSON.stringify(r))throw new Error('ASIO 操作 ID 已用于其他内容');
  const p=validateAsioOutputPreference(JSON.parse(row.value_json));
  if(p.revision!==r.baseRevision+1||!sameAsioDriver(p.driver,r.driver)||p.bufferFrames!==r.bufferFrames||p.allowConversion!==r.allowConversion||JSON.stringify(p.outputChannels)!==JSON.stringify(r.outputChannels))throw new Error('ASIO 保存回执无效');return p;
 }
 save(value:unknown,driver:AsioDriverIdentity|null):AsioOutputPreference{
  const r=validateAsioOutputRequest(value),identity=driver===null?null:validateAsioDriverIdentity(driver);
  if(!sameAsioDriver(r.driver,identity))throw new Error('ASIO 保存驱动身份不一致');
  return this.transaction(()=>{
   const old=this.receipt(r);if(old)return old;const p=this.load();if(p.revision!==r.baseRevision)throw new Error('ASIO 配置已变化，请重新读取');if(p.revision>=Number.MAX_SAFE_INTEGER)throw new Error('ASIO 配置修订达到上限');
   const count=this.db.prepare('SELECT COUNT(*) count FROM asio_output_change').get() as {count:number};if(count.count>=65536)throw new Error('ASIO 配置历史达到上限，旧回执已保留');
   const next=validateAsioOutputPreference({revision:p.revision+1,driver:identity,outputChannels:r.outputChannels,bufferFrames:r.bufferFrames,allowConversion:r.allowConversion}),json=JSON.stringify(next);
   this.db.prepare('INSERT INTO asio_output_setting VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(json);
   this.db.prepare('INSERT INTO asio_output_change VALUES(?,?,?,?)').run(r.commandId,JSON.stringify(r),json,new Date().toISOString());return next;
  });
 }
}
