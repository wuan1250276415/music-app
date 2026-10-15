// Explicit reverse DDL for constructing historical schema78/77/76 fixtures.
// The independent schema72 digest test remains the authority for the older baseline.
exports.DROP_RETRY_SCHEMA=`
 DROP TRIGGER IF EXISTS metadata_recognition_member_handled;
 DROP TABLE metadata_recognition_retry;
 DROP TABLE metadata_recognition_progress;
 DROP INDEX metadata_recognition_failure;
 DROP TRIGGER IF EXISTS metadata_recognition_progress_create;
 DROP TRIGGER IF EXISTS metadata_recognition_mapping_count_insert;
 DROP TRIGGER IF EXISTS metadata_recognition_mapping_count_delete;
 DROP TRIGGER IF EXISTS metadata_recognition_failure_count_insert;
 DROP TRIGGER IF EXISTS metadata_recognition_failure_count_delete;
 DROP TRIGGER IF EXISTS metadata_recognition_failure_count_update;
 DROP TRIGGER IF EXISTS metadata_recognition_retry_count_insert;
 DROP TRIGGER IF EXISTS metadata_recognition_retry_count_delete;
 ALTER TABLE metadata_recognition_run DROP COLUMN retry_active;
`;
