export const tagCommitSchema=`
 CREATE TABLE tag_commit_operation(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES tag_write_job(id) ON DELETE RESTRICT,file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE RESTRICT,execution_id TEXT NOT NULL REFERENCES tag_write_execution(id) ON DELETE RESTRICT,
  base_revision INTEGER NOT NULL CHECK(base_revision>=0),certificate_id TEXT NOT NULL,lease_id TEXT NOT NULL,lease_revision INTEGER NOT NULL CHECK(lease_revision>=1),victim_artifact_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),binding_json TEXT CHECK(binding_json IS NULL OR(json_valid(binding_json) AND length(CAST(binding_json AS BLOB))<=524288)),
  state TEXT NOT NULL CHECK(state IN('reserved','running','native_verified','recovery_required','committed')),journal_revision INTEGER NOT NULL DEFAULT -1 CHECK(journal_revision BETWEEN -1 AND 5),journal_sha256 TEXT,
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),final_json TEXT CHECK(final_json IS NULL OR(json_valid(final_json) AND length(CAST(final_json AS BLOB))<=65536)),exit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(exit_confirmed IN(0,1)),
  reason TEXT NOT NULL CHECK(length(reason)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
  CHECK(state NOT IN('native_verified','committed') OR(binding_json IS NOT NULL AND journal_revision=5 AND final_json IS NOT NULL AND exit_confirmed=1)));
 CREATE INDEX tag_commit_recent ON tag_commit_operation(created_at DESC,id DESC);
 CREATE TRIGGER tag_commit_owner BEFORE INSERT ON tag_commit_operation WHEN NOT EXISTS(SELECT 1 FROM tag_write_execution e JOIN tag_write_job j ON j.id=e.job_id WHERE e.id=NEW.execution_id AND e.job_id=NEW.job_id AND j.file_id=NEW.file_id) BEGIN SELECT RAISE(ABORT,'提交操作不属于当前文件任务'); END;
 CREATE TRIGGER tag_commit_identity BEFORE UPDATE OF id,job_id,file_id,execution_id,base_revision,certificate_id,lease_id,lease_revision,victim_artifact_id,request_json,created_at ON tag_commit_operation BEGIN SELECT RAISE(ABORT,'提交操作身份不可修改'); END;
 CREATE TRIGGER tag_commit_binding BEFORE UPDATE OF binding_json ON tag_commit_operation WHEN OLD.binding_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'提交冻结证据不可修改'); END;
 CREATE TRIGGER tag_commit_final BEFORE UPDATE OF final_json,exit_confirmed ON tag_commit_operation WHEN OLD.final_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'提交最终证据不可修改'); END;
 CREATE TRIGGER tag_commit_monotonic BEFORE UPDATE OF journal_revision ON tag_commit_operation WHEN NEW.journal_revision<OLD.journal_revision BEGIN SELECT RAISE(ABORT,'提交阶段不可倒退'); END;
 CREATE TRIGGER tag_commit_no_delete BEFORE DELETE ON tag_commit_operation BEGIN SELECT RAISE(ABORT,'提交操作需保留恢复证据'); END;
 CREATE TABLE tag_commit_receipt(operation_id TEXT NOT NULL REFERENCES tag_commit_operation(id) ON DELETE RESTRICT,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 5),sha256 TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=524288),created_at TEXT NOT NULL,PRIMARY KEY(operation_id,revision));
 CREATE TRIGGER tag_commit_receipt_immutable BEFORE UPDATE ON tag_commit_receipt BEGIN SELECT RAISE(ABORT,'提交阶段回执不可修改'); END;
 CREATE TRIGGER tag_commit_receipt_no_delete BEFORE DELETE ON tag_commit_receipt BEGIN SELECT RAISE(ABORT,'提交阶段回执需保留'); END;
`;
