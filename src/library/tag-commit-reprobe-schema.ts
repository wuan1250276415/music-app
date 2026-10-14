export const tagCommitReprobeSchema=`
 CREATE TABLE tag_commit_reprobe(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES tag_commit_operation(id) ON DELETE RESTRICT,job_id TEXT NOT NULL REFERENCES tag_write_job(id) ON DELETE RESTRICT,file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE RESTRICT,
  inspection_id TEXT NOT NULL REFERENCES tag_commit_inspection(id) ON DELETE RESTRICT,base_revision INTEGER NOT NULL CHECK(base_revision>=0),lease_id TEXT NOT NULL,lease_revision INTEGER NOT NULL CHECK(lease_revision>=1),
  request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=4096),state TEXT NOT NULL CHECK(state IN('running','completed','cancelled','failed','interrupted')),
  progress_json TEXT CHECK(progress_json IS NULL OR(json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),proof_json TEXT CHECK(proof_json IS NULL OR(json_valid(proof_json) AND length(CAST(proof_json AS BLOB))<=3145728)),
  reason TEXT NOT NULL CHECK(length(reason)<=512),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,CHECK(state<>'completed' OR proof_json IS NOT NULL));
 CREATE UNIQUE INDEX tag_commit_reprobe_active ON tag_commit_reprobe(operation_id) WHERE state='running';
 CREATE UNIQUE INDEX tag_commit_reprobe_completed ON tag_commit_reprobe(operation_id) WHERE state='completed';
 CREATE INDEX tag_commit_reprobe_recent ON tag_commit_reprobe(job_id,created_at DESC,id DESC);
 CREATE TRIGGER tag_commit_reprobe_owner BEFORE INSERT ON tag_commit_reprobe WHEN NOT EXISTS(SELECT 1 FROM tag_commit_operation c JOIN tag_commit_inspection i ON i.operation_id=c.id WHERE c.id=NEW.operation_id AND c.job_id=NEW.job_id AND c.file_id=NEW.file_id AND c.lease_id=NEW.lease_id AND c.lease_revision=NEW.lease_revision AND i.id=NEW.inspection_id AND i.job_id=NEW.job_id) BEGIN SELECT RAISE(ABORT,'重新解析不属于当前提交及核对'); END;
 CREATE TRIGGER tag_commit_reprobe_identity BEFORE UPDATE OF id,operation_id,job_id,file_id,inspection_id,base_revision,lease_id,lease_revision,request_json,created_at ON tag_commit_reprobe BEGIN SELECT RAISE(ABORT,'重新解析身份不可修改'); END;
 CREATE TRIGGER tag_commit_reprobe_final BEFORE UPDATE ON tag_commit_reprobe WHEN OLD.state<>'running' BEGIN SELECT RAISE(ABORT,'重新解析最终证据不可修改'); END;
 CREATE TRIGGER tag_commit_reprobe_no_delete BEFORE DELETE ON tag_commit_reprobe BEGIN SELECT RAISE(ABORT,'重新解析证据需保留'); END;
 CREATE TABLE tag_commit_reprobe_release(action_id TEXT PRIMARY KEY REFERENCES tag_commit_reprobe(id) ON DELETE RESTRICT,created_at TEXT NOT NULL);
 CREATE TRIGGER tag_commit_reprobe_release_owner BEFORE INSERT ON tag_commit_reprobe_release WHEN NOT EXISTS(SELECT 1 FROM tag_commit_reprobe WHERE id=NEW.action_id AND state='completed') BEGIN SELECT RAISE(ABORT,'曲库提交尚未完成'); END;
 CREATE TRIGGER tag_commit_reprobe_release_immutable BEFORE UPDATE ON tag_commit_reprobe_release BEGIN SELECT RAISE(ABORT,'曲库提交释放证据不可修改'); END;
 CREATE TRIGGER tag_commit_reprobe_release_no_delete BEFORE DELETE ON tag_commit_reprobe_release BEGIN SELECT RAISE(ABORT,'曲库提交释放证据需保留'); END;
`;
