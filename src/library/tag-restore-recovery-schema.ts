export const tagRestoreRecoverySchema=`
 CREATE TABLE tag_restore_inspection(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES tag_restore_operation(id) ON DELETE RESTRICT,job_id TEXT NOT NULL REFERENCES tag_write_job(id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK(base_revision>=0),lease_id TEXT NOT NULL,lease_revision INTEGER NOT NULL CHECK(lease_revision>=1),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),
  state TEXT NOT NULL CHECK(state IN('running','completed','cancelled','failed','interrupted')),exit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(exit_confirmed IN(0,1)),
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),
  report_json TEXT CHECK(report_json IS NULL OR(json_valid(report_json) AND length(CAST(report_json AS BLOB))<=65536)),
  error TEXT NOT NULL DEFAULT '' CHECK(length(error)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(state<>'completed' OR(exit_confirmed=1 AND report_json IS NOT NULL)));
 CREATE UNIQUE INDEX tag_restore_inspection_active ON tag_restore_inspection(operation_id) WHERE state='running';
 CREATE INDEX tag_restore_inspection_recent ON tag_restore_inspection(job_id,created_at DESC,id DESC);
 CREATE TRIGGER tag_restore_inspection_owner BEFORE INSERT ON tag_restore_inspection WHEN NOT EXISTS(SELECT 1 FROM tag_restore_operation o JOIN tag_write_job j ON j.id=o.job_id JOIN tag_write_file_state f ON f.file_id=o.file_id WHERE o.id=NEW.operation_id AND o.job_id=NEW.job_id AND o.lease_id=NEW.lease_id AND o.lease_revision=NEW.lease_revision AND o.state IN('native_restored','recovery_required') AND j.state='recovery_required' AND j.revision=NEW.base_revision AND f.lease_state='recovery' AND f.lease_job_id=o.job_id AND f.lease_id=o.lease_id AND f.lease_revision=o.lease_revision) BEGIN SELECT RAISE(ABORT,'六文件核对不属于当前恢复租约'); END;
 CREATE TRIGGER tag_restore_inspection_identity BEFORE UPDATE OF id,operation_id,job_id,base_revision,lease_id,lease_revision,request_json,created_at ON tag_restore_inspection BEGIN SELECT RAISE(ABORT,'六文件核对身份不可修改'); END;
 CREATE TRIGGER tag_restore_inspection_final BEFORE UPDATE ON tag_restore_inspection WHEN OLD.state<>'running' BEGIN SELECT RAISE(ABORT,'六文件核对终结证据不可修改'); END;
 CREATE TRIGGER tag_restore_inspection_no_delete BEFORE DELETE ON tag_restore_inspection BEGIN SELECT RAISE(ABORT,'六文件核对需保留恢复证据'); END;
`;
