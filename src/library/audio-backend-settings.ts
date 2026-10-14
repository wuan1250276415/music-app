import type {DatabaseSync} from 'node:sqlite';
import {defaultAudioBackend,readAudioBackendPreference,readAudioBackendRequest,matchesAudioBackendRequest,type AudioBackendPreference} from '../shared/audio-backend.js';
export const audioBackendSettingsSchema=`
 CREATE TABLE audio_backend_setting(id INTEGER PRIMARY KEY CHECK(id=1),value_json TEXT NOT NULL CHECK(json_valid(value_json)));
 CREATE TABLE audio_backend_change(command_id TEXT PRIMARY KEY,request_json TEXT NOT NULL CHECK(json_valid(request_json)),value_json TEXT NOT NULL CHECK(json_valid(value_json)),created_at TEXT NOT NULL);
 CREATE TRIGGER audio_backend_change_immutable BEFORE UPDATE ON audio_backend_change BEGIN SELECT RAISE(ABORT,'音频后端回执不可修改'); END;
 CREATE TRIGGER audio_backend_change_no_delete BEFORE DELETE ON audio_backend_change BEGIN SELECT RAISE(ABORT,'音频后端回执不可删除'); END;
`;
export class AudioBackendSettings {
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 load():AudioBackendPreference{const row=this.db.prepare('SELECT value_json FROM audio_backend_setting WHERE id=1').get() as {value_json:string}|undefined;return row?readAudioBackendPreference(JSON.parse(row.value_json)):defaultAudioBackend();}
 receipt(value:unknown):AudioBackendPreference|null{
  const r=readAudioBackendRequest(value),row=this.db.prepare('SELECT request_json,value_json FROM audio_backend_change WHERE command_id=?').get(r.commandId) as {request_json:string;value_json:string}|undefined;
  if(!row)return null;if(JSON.stringify(readAudioBackendRequest(JSON.parse(row.request_json)))!==JSON.stringify(r))throw new Error('音频后端操作 ID 已用于其他内容');const p=readAudioBackendPreference(JSON.parse(row.value_json));if(!matchesAudioBackendRequest(p,r))throw new Error('音频后端回执与请求不符');return p;
 }
 save(value:unknown):AudioBackendPreference{
  const r=readAudioBackendRequest(value);return this.transaction(()=>{
   const old=this.receipt(r);if(old)return old;const p=this.load();if(p.revision!==r.baseRevision)throw new Error('音频后端设置已变化，请重新读取');if(p.revision>=Number.MAX_SAFE_INTEGER)throw new Error('音频后端修订达到上限');
   const count=this.db.prepare('SELECT COUNT(*) count FROM audio_backend_change').get() as {count:number};if(count.count>=65536)throw new Error('音频后端回执历史达到上限，旧回执已保留');
   const next=readAudioBackendPreference({revision:p.revision+1,backend:r.backend,asioProcessing:r.asioProcessing,asioDsdPolicy:r.asioDsdPolicy}),json=JSON.stringify(next);
   this.db.prepare('INSERT INTO audio_backend_setting VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value_json=excluded.value_json').run(json);
   this.db.prepare('INSERT INTO audio_backend_change VALUES(?,?,?,?)').run(r.commandId,JSON.stringify(r),json,new Date().toISOString());return next;
  });
 }
}
