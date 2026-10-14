export const tagRecoveryActionSchema=`
 CREATE TABLE tag_recovery_action(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES tag_write_job(id) ON DELETE RESTRICT,file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES tag_write_execution(id) ON DELETE RESTRICT,inspection_id TEXT NOT NULL REFERENCES tag_recovery_inspection(id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK(base_revision>=0),lease_revision INTEGER NOT NULL CHECK(lease_revision>=1),root_id TEXT NOT NULL,scan_command TEXT NOT NULL UNIQUE,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),
  state TEXT NOT NULL CHECK(state IN('running','completed','cancelled','failed','interrupted')),
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),
  proof_json TEXT CHECK(proof_json IS NULL OR(json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=32768)),
  reason TEXT NOT NULL CHECK(length(reason)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(state<>'completed' OR proof_json IS NOT NULL));
 CREATE UNIQUE INDEX tag_recovery_action_active ON tag_recovery_action(job_id) WHERE state='running';
 CREATE UNIQUE INDEX tag_recovery_action_resolved ON tag_recovery_action(job_id) WHERE state='completed';
 CREATE INDEX tag_recovery_action_recent ON tag_recovery_action(job_id,created_at DESC,id DESC);
 CREATE INDEX tag_recovery_action_scan ON tag_recovery_action(state,created_at,scan_command);
 CREATE TRIGGER tag_recovery_action_owner BEFORE INSERT ON tag_recovery_action WHEN NOT EXISTS(SELECT 1 FROM tag_write_execution e JOIN tag_recovery_inspection i ON i.execution_id=e.id WHERE e.id=NEW.execution_id AND e.job_id=NEW.job_id AND i.id=NEW.inspection_id AND i.job_id=NEW.job_id) OR NOT EXISTS(SELECT 1 FROM tag_write_job WHERE id=NEW.job_id AND file_id=NEW.file_id) BEGIN SELECT RAISE(ABORT,'恢复处理绑定不属于此任务'); END;
 CREATE TRIGGER tag_recovery_action_immutable BEFORE UPDATE OF id,job_id,file_id,execution_id,inspection_id,base_revision,lease_revision,root_id,scan_command,request_json,created_at ON tag_recovery_action BEGIN SELECT RAISE(ABORT,'恢复处理身份不可修改'); END;
 CREATE TRIGGER tag_recovery_action_final BEFORE UPDATE ON tag_recovery_action WHEN OLD.state<>'running' BEGIN SELECT RAISE(ABORT,'恢复处理最终证据不可修改'); END;
 CREATE TRIGGER tag_recovery_action_no_delete BEFORE DELETE ON tag_recovery_action BEGIN SELECT RAISE(ABORT,'恢复处理证据需保留'); END;
 CREATE TABLE tag_recovery_release(action_id TEXT PRIMARY KEY REFERENCES tag_recovery_action(id) ON DELETE RESTRICT,created_at TEXT NOT NULL);
 CREATE TRIGGER tag_recovery_release_owner BEFORE INSERT ON tag_recovery_release WHEN NOT EXISTS(SELECT 1 FROM tag_recovery_action WHERE id=NEW.action_id AND state='completed') BEGIN SELECT RAISE(ABORT,'恢复释放尚未提交'); END;
 CREATE TRIGGER tag_recovery_release_immutable BEFORE UPDATE ON tag_recovery_release BEGIN SELECT RAISE(ABORT,'恢复释放回执不可修改'); END;
 CREATE TRIGGER tag_recovery_release_no_delete BEFORE DELETE ON tag_recovery_release BEGIN SELECT RAISE(ABORT,'恢复释放回执需保留'); END;
`;
