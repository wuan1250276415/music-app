export const tagWriteExecutionSchema=`
 CREATE TABLE tag_write_execution(id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE REFERENCES tag_write_job(id) ON DELETE RESTRICT,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=524288),
  state TEXT NOT NULL CHECK(state IN('starting','planned','validated','backup_ready','temp_written','staged','recovery_required')),
  journal_revision INTEGER NOT NULL DEFAULT -1 CHECK(journal_revision>=-1 AND journal_revision<=31),journal_sha256 TEXT,
  progress_json TEXT CHECK(progress_json IS NULL OR (json_valid(progress_json) AND length(CAST(progress_json AS BLOB))<=1024)),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB))<=16384)),updated_at TEXT NOT NULL);
 CREATE TRIGGER tag_write_execution_immutable BEFORE UPDATE OF id,job_id,descriptor_json ON tag_write_execution BEGIN SELECT RAISE(ABORT,'标签执行身份和工件绑定不可修改'); END;
 CREATE TRIGGER tag_write_execution_no_delete BEFORE DELETE ON tag_write_execution BEGIN SELECT RAISE(ABORT,'标签暂存执行需保留恢复证据'); END;
 CREATE TABLE tag_write_stage_receipt(execution_id TEXT NOT NULL REFERENCES tag_write_execution(id) ON DELETE RESTRICT,revision INTEGER NOT NULL CHECK(revision>=0 AND revision<=31),
  sha256 TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=16384),created_at TEXT NOT NULL,PRIMARY KEY(execution_id,revision));
 CREATE TRIGGER tag_write_stage_receipt_immutable BEFORE UPDATE ON tag_write_stage_receipt BEGIN SELECT RAISE(ABORT,'标签暂存阶段回执不可修改'); END;
 CREATE TRIGGER tag_write_stage_receipt_no_delete BEFORE DELETE ON tag_write_stage_receipt BEGIN SELECT RAISE(ABORT,'标签暂存阶段回执不可删除'); END;
`;
