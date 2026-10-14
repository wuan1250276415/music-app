import type {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {defaultPlaybackRule,readPlaybackPolicy,readPlaybackPolicyRequest,matchesPlaybackPolicy,type PlaybackPolicyRequest,type PlaybackPolicyResult,type PlaybackPolicySnapshot} from '../shared/playback-policy.js';

export const playbackPolicySchema=`
 CREATE TABLE playback_counting_policy(revision INTEGER PRIMARY KEY CHECK(revision BETWEEN 0 AND 9007199254740990),value_json TEXT NOT NULL CHECK(json_valid(value_json) AND length(value_json)<=4096),command_id TEXT UNIQUE REFERENCES user_command_receipt(command_id) ON DELETE RESTRICT,created_at TEXT NOT NULL);
 CREATE TABLE playback_counting_setting(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL REFERENCES playback_counting_policy(revision) ON DELETE RESTRICT);
 CREATE TRIGGER playback_counting_policy_immutable BEFORE UPDATE ON playback_counting_policy BEGIN SELECT RAISE(ABORT,'播放统计规则历史不可修改');END;
 CREATE TRIGGER playback_counting_policy_no_delete BEFORE DELETE ON playback_counting_policy BEGIN SELECT RAISE(ABORT,'播放统计规则历史不可删除');END;
 CREATE TRIGGER playback_counting_policy_budget BEFORE INSERT ON playback_counting_policy WHEN (SELECT COUNT(*) FROM playback_counting_policy)>=65536 BEGIN SELECT RAISE(ABORT,'播放统计规则历史达到预算');END;
 CREATE TRIGGER playback_counting_setting_monotonic BEFORE UPDATE ON playback_counting_setting WHEN NEW.id<>OLD.id OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'播放统计设置修订不连续');END;
 CREATE TRIGGER playback_counting_setting_no_delete BEFORE DELETE ON playback_counting_setting BEGIN SELECT RAISE(ABORT,'播放统计设置不可删除');END;
`;
export function initializePlaybackPolicy(db:DatabaseSync):void{
 const initial={revision:0,rule:defaultPlaybackRule()};
 db.prepare('INSERT INTO playback_counting_policy VALUES(0,?,NULL,?)').run(JSON.stringify(initial),new Date().toISOString());
 db.exec('INSERT INTO playback_counting_setting VALUES(1,0)');
}
type Receipt={fingerprint:string;result_json:string};
const fingerprint=(r:PlaybackPolicyRequest)=>createHash('sha256').update('playback-counting-policy-v2:').update(JSON.stringify(r)).digest('hex');
export class PlaybackPolicies {
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(fn:()=>T)=>T){}
 load():PlaybackPolicySnapshot{
  const row=this.db.prepare('SELECT p.revision,p.value_json FROM playback_counting_setting s JOIN playback_counting_policy p ON p.revision=s.revision WHERE s.id=1').get() as {revision:number;value_json:string}|undefined;
  if(!row)throw new Error('播放统计设置缺失');const value=readPlaybackPolicy(JSON.parse(row.value_json));if(value.revision!==row.revision)throw new Error('播放统计设置身份不符');return value;
 }
 assertSnapshot(value:PlaybackPolicySnapshot):void{
  const snapshot=readPlaybackPolicy(value),row=this.db.prepare('SELECT value_json FROM playback_counting_policy WHERE revision=?').get(snapshot.revision) as {value_json:string}|undefined;
  if(!row||JSON.stringify(readPlaybackPolicy(JSON.parse(row.value_json)))!==JSON.stringify(snapshot))throw new Error('播放记录中的统计规则与持久历史不符');
 }
 private receipt(id:string):Receipt|undefined{return this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(id) as Receipt|undefined;}
 private readReceipt(row:Receipt,r:PlaybackPolicyRequest):PlaybackPolicySnapshot{
  if(row.fingerprint!==fingerprint(r))throw new Error('操作身份已用于另一请求');
  const value=readPlaybackPolicy(JSON.parse(row.result_json));if(!matchesPlaybackPolicy(value,r))throw new Error('播放统计规则回执与原请求不符');return value;
 }
 result(value:unknown):PlaybackPolicyResult&{changed:boolean}{
  const r=readPlaybackPolicyRequest(value);
  try{
   const saved=this.transaction(()=>{
    const prior=this.receipt(r.commandId);if(prior)return {value:this.readReceipt(prior,r),changed:false};
    const old=this.load();if(old.revision!==r.baseRevision)throw new Error('统计规则已变化，请重新读取后编辑');
    const next=readPlaybackPolicy({revision:old.revision+1,rule:r.rule}),now=new Date().toISOString();
    // Parent receipt precedes its referencing immutable policy; the transaction publishes both.
    this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(r.commandId,fingerprint(r),JSON.stringify(next),now);
    this.db.prepare('INSERT INTO playback_counting_policy VALUES(?,?,?,?)').run(next.revision,JSON.stringify(next),r.commandId,now);
    this.db.prepare('UPDATE playback_counting_setting SET revision=? WHERE id=1 AND revision=?').run(next.revision,old.revision);
    return {value:this.load(),changed:true};
   });return {commandId:r.commandId,status:'saved',error:'',...saved};
  }catch(error){
   if(this.db.isTransaction)throw error;
   // Failure to read the receipt remains unresolved; never acknowledge a rejection without evidence.
   const prior=this.receipt(r.commandId);
   if(prior?.fingerprint===fingerprint(r))return {commandId:r.commandId,status:'saved',value:this.readReceipt(prior,r),error:'',changed:false};
   return {commandId:r.commandId,status:'rejected',value:null,error:String(error instanceof Error?error.message:error).slice(0,512)||'播放统计规则未保存',changed:false};
  }
 }
}
