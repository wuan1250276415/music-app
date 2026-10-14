import type {DatabaseSync} from 'node:sqlite';
import type {AudioOutputPreference,AudioOutputRequest} from '../shared/contracts.js';
import {defaultAudioOutput,validateAudioOutputPreference,validateAudioOutputRequest} from '../shared/audio-output.js';
export const audioOutputSettingsSchema=`
 CREATE TABLE audio_output_setting(id INTEGER PRIMARY KEY CHECK(id=1),value_json TEXT NOT NULL CHECK(json_valid(value_json)));
 CREATE TABLE audio_output_change(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),value_json TEXT NOT NULL CHECK(json_valid(value_json)),created_at TEXT NOT NULL);
 CREATE TRIGGER audio_output_change_immutable BEFORE UPDATE ON audio_output_change BEGIN SELECT RAISE(ABORT,'输出设置回执不可修改'); END;
 CREATE TRIGGER audio_output_change_no_delete BEFORE DELETE ON audio_output_change BEGIN SELECT RAISE(ABORT,'输出设置回执不可删除'); END;
`;
export class AudioOutputSettings{
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 load():AudioOutputPreference{const row=this.db.prepare('SELECT value_json FROM audio_output_setting WHERE id=1').get() as {value_json:string}|undefined;return row?validateAudioOutputPreference(JSON.parse(row.value_json)):defaultAudioOutput();}
 receipt(value:unknown):AudioOutputPreference|null{
  const r=validateAudioOutputRequest(value),row=this.db.prepare('SELECT request_json,value_json FROM audio_output_change WHERE command_id=?').get(r.commandId) as {request_json:string;value_json:string}|undefined;
  if(!row)return null;if(JSON.stringify(validateAudioOutputRequest(JSON.parse(row.request_json)))!==JSON.stringify(r))throw new Error('输出设置操作 ID 已用于其他内容');const p=validateAudioOutputPreference(JSON.parse(row.value_json));
  if(p.revision!==r.baseRevision+1||p.deviceId!==r.deviceId||p.mode!==r.mode||p.dsdPolicy!==r.dsdPolicy||JSON.stringify(p.processing)!==JSON.stringify(r.processing))throw new Error('输出设置回执无效');return p;
 }
 save(value:unknown,deviceName:string|null):AudioOutputPreference{
  const r=validateAudioOutputRequest(value);return this.transaction(()=>{
   const old=this.receipt(r);if(old)return old;const before=this.load();if(before.revision!==r.baseRevision)throw new Error('输出设置已变化，请重新读取');if(before.revision>=Number.MAX_SAFE_INTEGER)throw new Error('输出设置修订达到上限');
   const p=validateAudioOutputPreference({revision:before.revision+1,backend:'wasapi',deviceId:r.deviceId,deviceName,mode:r.mode,dsdPolicy:r.dsdPolicy,processing:r.processing}),json=JSON.stringify(p);
   this.db.prepare('INSERT INTO audio_output_setting VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(json);
   this.db.prepare('INSERT INTO audio_output_change VALUES(?,?,?,?)').run(r.commandId,JSON.stringify(r),json,new Date().toISOString());return p;
  });
 }
}
