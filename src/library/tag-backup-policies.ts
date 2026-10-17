import type {DatabaseSync} from 'node:sqlite';
import {readTagBackupPolicy,readTagBackupPolicyRequest,TAG_BACKUP_DEFAULT_DAYS,TAG_BACKUP_DEFAULT_BYTES,type TagBackupPolicy,type TagBackupPolicyReply} from '../shared/tag-backup-storage.js';

export const tagBackupPolicySchema=`
 CREATE TABLE tag_backup_policy(revision INTEGER PRIMARY KEY CHECK(revision BETWEEN 0 AND 4095),command_id TEXT UNIQUE,request_json TEXT CHECK(request_json IS NULL OR json_valid(request_json)),keep_days INTEGER NOT NULL CHECK(keep_days BETWEEN 1 AND 36500),max_bytes TEXT NOT NULL,created_at INTEGER NOT NULL,CHECK((revision=0)=(command_id IS NULL)),CHECK((revision=0)=(request_json IS NULL)));
 INSERT INTO tag_backup_policy VALUES(0,NULL,NULL,30,'10737418240',0);
 CREATE TRIGGER tag_backup_policy_immutable BEFORE UPDATE ON tag_backup_policy BEGIN SELECT RAISE(ABORT,'备份保留设置历史不可改写'); END;
 CREATE TRIGGER tag_backup_policy_no_delete BEFORE DELETE ON tag_backup_policy BEGIN SELECT RAISE(ABORT,'备份保留设置历史需保留'); END;
`;
type Row={revision:number;command_id:string|null;request_json:string|null;keep_days:number;max_bytes:string;created_at:number};
const view=(r:Row):TagBackupPolicy=>readTagBackupPolicy({revision:r.revision,keepDays:r.keep_days,maxBytes:r.max_bytes});
export class TagBackupPolicies {
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(action:()=>T)=>T){}
 load():TagBackupPolicy {
  const row=this.db.prepare('SELECT * FROM tag_backup_policy ORDER BY revision DESC LIMIT 1').get() as Row|undefined;
  if(!row)throw new Error('备份保留设置缺失');return view(row);
 }
 configure(value:unknown):TagBackupPolicyReply {
  const q=readTagBackupPolicyRequest(value),identity=JSON.stringify(q);
  return this.transaction(()=>{
   const known=this.db.prepare('SELECT * FROM tag_backup_policy WHERE command_id=?').get(q.commandId) as Row|undefined;
   if(known){if(known.request_json!==identity)throw new Error('原备份保留操作内容已经变化');return {status:'saved',policy:view(known),message:''};}
   const current=this.load();
   if(q.baseRevision!==current.revision)return {status:'conflict',policy:current,message:'保留设置已在其他窗口改变，请核对后重新保存'};
   if(current.revision>=4095)throw new Error('备份保留设置历史达到上限，请保留原记录');
   const revision=current.revision+1;
   this.db.prepare('INSERT INTO tag_backup_policy VALUES(?,?,?,?,?,?)').run(revision,q.commandId,identity,q.keepDays,q.maxBytes,Date.now());
   return {status:'saved',policy:{revision,keepDays:q.keepDays,maxBytes:q.maxBytes},message:''};
  });
 }
}
export function validateTagBackupPolicies(db:DatabaseSync):number {
 const rows=db.prepare('SELECT * FROM tag_backup_policy ORDER BY revision').all() as Row[];
 if(!rows.length||rows.length>4096)throw new Error('恢复备份保留历史缺失或超过预算');
 for(const [i,row] of rows.entries()){
  const p=view(row);if(p.revision!==i||!Number.isSafeInteger(row.created_at)||row.created_at<0)throw new Error('恢复备份保留历史不连续');
  if(i===0){if(row.command_id!==null||row.request_json!==null||p.keepDays!==TAG_BACKUP_DEFAULT_DAYS||p.maxBytes!==TAG_BACKUP_DEFAULT_BYTES||row.created_at!==0)throw new Error('恢复备份保留默认值已改变');continue;}
  if(!row.request_json||Buffer.byteLength(row.request_json)>2048)throw new Error('恢复备份保留原操作无效');
  const q=readTagBackupPolicyRequest(JSON.parse(row.request_json));
  if(q.commandId!==row.command_id||q.baseRevision!==i-1||q.keepDays!==p.keepDays||q.maxBytes!==p.maxBytes||JSON.stringify(q)!==row.request_json)throw new Error('恢复备份保留设置与原操作不一致');
 }
 return rows.length;
}
