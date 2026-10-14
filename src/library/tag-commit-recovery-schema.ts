export const tagCommitRecoverySchema=`
 CREATE TABLE tag_commit_inspection(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES tag_commit_operation(id) ON DELETE RESTRICT,job_id TEXT NOT NULL REFERENCES tag_write_job(id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK(base_revision>=0),lease_id TEXT NOT NULL,lease_revision INTEGER NOT NULL CHECK(lease_revision>=1),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),
  state TEXT NOT NULL CHECK(state IN('running','completed','cancelled','failed','interrupted')),exit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(exit_confirmed IN(0,1)),
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),
  report_json TEXT CHECK(report_json IS NULL OR(json_valid(report_json) AND length(CAST(report_json AS BLOB))<=65536)),
  error TEXT NOT NULL DEFAULT '' CHECK(length(error)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(state<>'completed' OR(exit_confirmed=1 AND report_json IS NOT NULL)));
 CREATE UNIQUE INDEX tag_commit_inspection_active ON tag_commit_inspection(operation_id) WHERE state='running';
 CREATE INDEX tag_commit_inspection_recent ON tag_commit_inspection(job_id,created_at DESC,id DESC);
 CREATE TRIGGER tag_commit_inspection_owner BEFORE INSERT ON tag_commit_inspection WHEN NOT EXISTS(SELECT 1 FROM tag_commit_operation WHERE id=NEW.operation_id AND job_id=NEW.job_id AND lease_id=NEW.lease_id AND lease_revision=NEW.lease_revision) BEGIN SELECT RAISE(ABORT,'四工件核对不属于当前提交租约'); END;
 CREATE TRIGGER tag_commit_inspection_identity BEFORE UPDATE OF id,operation_id,job_id,base_revision,lease_id,lease_revision,request_json,created_at ON tag_commit_inspection BEGIN SELECT RAISE(ABORT,'四工件核对身份不可修改'); END;
 CREATE TRIGGER tag_commit_inspection_final BEFORE UPDATE ON tag_commit_inspection WHEN OLD.state<>'running' BEGIN SELECT RAISE(ABORT,'四工件核对终结证据不可修改'); END;
 CREATE TRIGGER tag_commit_inspection_no_delete BEFORE DELETE ON tag_commit_inspection BEGIN SELECT RAISE(ABORT,'四工件核对需保留恢复证据'); END;
`;
