export const cueSourceImportSchema=`
 CREATE TABLE cue_source_import_usage(id INTEGER PRIMARY KEY CHECK(id=1),bytes INTEGER NOT NULL DEFAULT 0 CHECK(bytes BETWEEN 0 AND 536870912),assets INTEGER NOT NULL DEFAULT 0 CHECK(assets BETWEEN 0 AND 4096),commands INTEGER NOT NULL DEFAULT 0 CHECK(commands BETWEEN 0 AND 65536));
 INSERT INTO cue_source_import_usage(id) VALUES(1);
 CREATE TABLE cue_source_import_asset(id TEXT PRIMARY KEY,archive_bytes BLOB NOT NULL CHECK(length(archive_bytes) BETWEEN 1 AND 8388608),created_at TEXT NOT NULL);
 CREATE TABLE cue_source_import_command(command_id TEXT PRIMARY KEY,target_file_id TEXT NOT NULL REFERENCES cue_source_file(id),archive_sha TEXT REFERENCES cue_source_import_asset(id),version_id TEXT REFERENCES cue_source_version(id),request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(CAST(request_json AS BLOB))<=8192),result_json TEXT NOT NULL CHECK(json_valid(result_json) AND length(CAST(result_json AS BLOB))<=262144),created_at TEXT NOT NULL,CHECK(json_extract(result_json,'$.status') IN('saved','rejected')),CHECK(json_extract(result_json,'$.status')!='saved' OR (archive_sha IS NOT NULL AND version_id IS NOT NULL)));
 CREATE INDEX cue_source_import_version ON cue_source_import_command(version_id,target_file_id);
 CREATE TRIGGER cue_source_import_owned BEFORE INSERT ON cue_source_import_command WHEN json_extract(NEW.request_json,'$.fileId')!=NEW.target_file_id OR json_extract(NEW.request_json,'$.commandId')!=NEW.command_id OR (NEW.version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cue_source_version v WHERE v.id=NEW.version_id AND v.file_id=NEW.target_file_id)) OR (NEW.archive_sha IS NOT NULL AND json_extract(NEW.request_json,'$.archiveSha256')!=NEW.archive_sha) BEGIN SELECT RAISE(ABORT,'CUE导入目标或原请求不一致'); END;
 CREATE TRIGGER cue_source_import_asset_immutable BEFORE UPDATE ON cue_source_import_asset BEGIN SELECT RAISE(ABORT,'CUE原来源备份不可修改'); END;
 CREATE TRIGGER cue_source_import_asset_no_delete BEFORE DELETE ON cue_source_import_asset BEGIN SELECT RAISE(ABORT,'CUE原来源备份不可删除'); END;
 CREATE TRIGGER cue_source_import_command_immutable BEFORE UPDATE ON cue_source_import_command BEGIN SELECT RAISE(ABORT,'CUE来源导入回执不可修改'); END;
 CREATE TRIGGER cue_source_import_command_no_delete BEFORE DELETE ON cue_source_import_command BEGIN SELECT RAISE(ABORT,'CUE来源导入回执不可删除'); END;
`;
