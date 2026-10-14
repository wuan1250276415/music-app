export const tagRestoreSchema=`
 CREATE TABLE tag_restore_operation(id TEXT PRIMARY KEY,commit_operation_id TEXT NOT NULL UNIQUE REFERENCES tag_commit_operation(id) ON DELETE RESTRICT,job_id TEXT NOT NULL UNIQUE REFERENCES tag_write_job(id) ON DELETE RESTRICT,file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE RESTRICT,
  inspection_id TEXT NOT NULL REFERENCES tag_commit_inspection(id) ON DELETE RESTRICT,base_revision INTEGER NOT NULL CHECK(base_revision>=0),certificate_id TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN('victim','backup')),
  lease_id TEXT NOT NULL,lease_revision INTEGER NOT NULL CHECK(lease_revision>=1),replacement_artifact_id TEXT NOT NULL,displaced_artifact_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),binding_json TEXT CHECK(binding_json IS NULL OR(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=1048576)),
  state TEXT NOT NULL CHECK(state IN('reserved','running','native_restored','recovery_required')),journal_revision INTEGER NOT NULL DEFAULT -1 CHECK(journal_revision BETWEEN -1 AND 6),journal_sha256 TEXT,
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),final_json TEXT CHECK(final_json IS NULL OR(json_valid(final_json) AND length(CAST(final_json AS BLOB))<=65536)),exit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(exit_confirmed IN(0,1)),
  reason TEXT NOT NULL CHECK(length(reason)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(state<>'native_restored' OR(binding_json IS NOT NULL AND journal_revision=6 AND final_json IS NOT NULL AND exit_confirmed=1)));
 CREATE INDEX tag_restore_recent ON tag_restore_operation(created_at DESC,id DESC);
 CREATE TRIGGER tag_restore_owner BEFORE INSERT ON tag_restore_operation WHEN NOT EXISTS(SELECT 1 FROM tag_commit_operation c JOIN tag_commit_inspection i ON i.operation_id=c.id JOIN tag_write_job j ON j.id=c.job_id WHERE c.id=NEW.commit_operation_id AND c.job_id=NEW.job_id AND c.file_id=NEW.file_id AND i.id=NEW.inspection_id AND i.base_revision=NEW.base_revision AND i.state='completed' AND i.exit_confirmed=1 AND j.revision=NEW.base_revision AND j.state='recovery_required') BEGIN SELECT RAISE(ABORT,'恢复操作不属于当前提交及核对'); END;
 CREATE TRIGGER tag_restore_identity BEFORE UPDATE OF id,commit_operation_id,job_id,file_id,inspection_id,base_revision,certificate_id,mode,lease_id,lease_revision,replacement_artifact_id,displaced_artifact_id,request_json,created_at ON tag_restore_operation BEGIN SELECT RAISE(ABORT,'恢复操作身份不可修改'); END;
 CREATE TRIGGER tag_restore_binding BEFORE UPDATE OF binding_json ON tag_restore_operation WHEN OLD.binding_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'恢复冻结绑定不可修改'); END;
 CREATE TRIGGER tag_restore_final BEFORE UPDATE OF final_json,exit_confirmed ON tag_restore_operation WHEN OLD.final_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'恢复最终证明不可修改'); END;
 CREATE TRIGGER tag_restore_monotonic BEFORE UPDATE OF journal_revision ON tag_restore_operation WHEN NEW.journal_revision<OLD.journal_revision BEGIN SELECT RAISE(ABORT,'恢复持久阶段不可倒退'); END;
 CREATE TRIGGER tag_restore_no_delete BEFORE DELETE ON tag_restore_operation BEGIN SELECT RAISE(ABORT,'恢复操作需保留证据'); END;
 CREATE TABLE tag_restore_receipt(operation_id TEXT NOT NULL REFERENCES tag_restore_operation(id) ON DELETE RESTRICT,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 6),sha256 TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=1048576),created_at TEXT NOT NULL,PRIMARY KEY(operation_id,revision));
 CREATE TRIGGER tag_restore_receipt_immutable BEFORE UPDATE ON tag_restore_receipt BEGIN SELECT RAISE(ABORT,'恢复阶段回执不可修改'); END;
 CREATE TRIGGER tag_restore_receipt_no_delete BEFORE DELETE ON tag_restore_receipt BEGIN SELECT RAISE(ABORT,'恢复阶段回执不可删除'); END;
`;
