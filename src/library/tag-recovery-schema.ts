export const tagRecoverySchema=`
 CREATE TABLE tag_recovery_inspection(id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES tag_write_job(id) ON DELETE RESTRICT,
  execution_id TEXT NOT NULL REFERENCES tag_write_execution(id) ON DELETE RESTRICT,base_revision INTEGER NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),
  state TEXT NOT NULL CHECK(state IN('running','completed','cancelled','failed','interrupted')),exit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(exit_confirmed IN(0,1)),
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),
  report_json TEXT CHECK(report_json IS NULL OR(json_valid(report_json) AND length(CAST(report_json AS BLOB))<=32768)),
  error TEXT NOT NULL DEFAULT '' CHECK(length(error)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(state<>'completed' OR(exit_confirmed=1 AND report_json IS NOT NULL)));
 CREATE UNIQUE INDEX tag_recovery_one_active ON tag_recovery_inspection(job_id) WHERE state='running';
 CREATE INDEX tag_recovery_recent ON tag_recovery_inspection(job_id,created_at DESC,id DESC);
 CREATE TRIGGER tag_recovery_owner BEFORE INSERT ON tag_recovery_inspection WHEN NOT EXISTS(SELECT 1 FROM tag_write_execution WHERE id=NEW.execution_id AND job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'恢复核对执行不属于此任务'); END;
 CREATE TRIGGER tag_recovery_binding_immutable BEFORE UPDATE OF id,job_id,execution_id,base_revision,request_json,created_at ON tag_recovery_inspection BEGIN SELECT RAISE(ABORT,'恢复核对身份不可修改'); END;
 CREATE TRIGGER tag_recovery_final_immutable BEFORE UPDATE ON tag_recovery_inspection WHEN OLD.state<>'running' BEGIN SELECT RAISE(ABORT,'恢复核对最终回执不可修改'); END;
 CREATE TRIGGER tag_recovery_no_delete BEFORE DELETE ON tag_recovery_inspection BEGIN SELECT RAISE(ABORT,'恢复核对证据需保留'); END;
`;
