// Test fixtures only: reverse recent CUE additions before older schema stripping.
function stripRecentCueSchemas(db){
 const version=db.prepare('PRAGMA user_version').get().user_version;if(version<=68)return;if(version>72)throw new Error('Unsupported modern fixture schema');
 const owned=['cue_source_register_command','cue_source_import_command','cue_source_import_asset','cue_source_selection_command','embedded_cue_version','embedded_cue_file','embedded_cue_asset'];
 for(const table of owned)if(db.prepare('SELECT name FROM sqlite_schema WHERE type=\'table\' AND name=?').get(table)&&db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n)throw new Error('Only empty modern CUE fixtures can be downgraded');
 db.exec('BEGIN IMMEDIATE');try{
  if(version>=72)db.exec('DROP TABLE cue_source_register_command; DROP INDEX cue_source_file_activity_page; ALTER TABLE cue_source_file DROP COLUMN registered_at;');
  if(version>=71)db.exec('DROP TABLE cue_source_import_command; DROP TABLE cue_source_import_asset; DROP TABLE cue_source_import_usage;');
  if(version>=70){for(const {name} of db.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND tbl_name='cue_source_file' AND (name LIKE 'cue_source_selected_%' OR name LIKE 'cue_source_choice_%')").all())db.exec(`DROP TRIGGER "${name}"`);db.exec('DROP INDEX cue_source_selected; ALTER TABLE cue_source_file DROP COLUMN selected_version; ALTER TABLE cue_source_file DROP COLUMN choice_command; DROP TABLE cue_source_selection_command;');}
  if(version>=69)db.exec('DROP TABLE embedded_cue_version; DROP TABLE embedded_cue_file; DROP TABLE embedded_cue_asset; DROP TABLE embedded_cue_usage;');
  db.exec('PRAGMA user_version=68; COMMIT;');
 }catch(error){db.exec('ROLLBACK');throw error;}
}
exports.stripV68=db=>{stripRecentCueSchemas(db);if(db.prepare('SELECT COUNT(*) n FROM playback_history').get().n||db.prepare('SELECT COUNT(*) n FROM playback_counting_policy').get().n!==1||db.prepare('SELECT revision FROM playback_counting_setting WHERE id=1').get().revision!==0)throw new Error('Only empty/default playback-policy fixtures can be downgraded');db.exec('BEGIN IMMEDIATE; DROP TRIGGER playback_counting_setting_monotonic; DROP TRIGGER playback_counting_setting_no_delete; DROP TABLE playback_counting_setting; DROP TRIGGER playback_counting_policy_immutable; DROP TRIGGER playback_counting_policy_no_delete; DROP TRIGGER playback_counting_policy_budget; DROP TABLE playback_counting_policy; PRAGMA user_version=67; COMMIT;');};
exports.stripV67=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=68)exports.stripV68(db);if(db.prepare('SELECT COUNT(*) n FROM rule_transfer_audit').get().n)throw new Error('Only empty rule-transfer fixtures can be downgraded');db.exec('BEGIN IMMEDIATE; DROP TRIGGER rule_transfer_audit_immutable; DROP TRIGGER rule_transfer_audit_no_delete; DROP TRIGGER rule_transfer_audit_budget; DROP TABLE rule_transfer_audit; DROP TRIGGER rule_transfer_origin_immutable; DROP TRIGGER rule_transfer_origin_no_delete; DROP TABLE rule_transfer_origin; PRAGMA user_version=66; COMMIT;');};
exports.stripV66=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=67)exports.stripV67(db);if(db.prepare('SELECT COUNT(*) n FROM playlist_smart_history').get().n)throw new Error('Only empty smart-history fixtures can be downgraded');db.exec(`BEGIN IMMEDIATE; DROP TRIGGER playlist_smart_history_immutable; DROP TRIGGER playlist_smart_history_no_delete; DROP TABLE playlist_smart_history; CREATE TABLE playlist_smart_history(playlist_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),action TEXT NOT NULL CHECK(action IN('create','update','delete')),command_id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),created_at TEXT NOT NULL,PRIMARY KEY(playlist_id,revision)); CREATE TRIGGER playlist_smart_history_immutable BEFORE UPDATE ON playlist_smart_history BEGIN SELECT RAISE(ABORT,'智能歌单历史不可修改'); END; CREATE TRIGGER playlist_smart_history_no_delete BEFORE DELETE ON playlist_smart_history BEGIN SELECT RAISE(ABORT,'智能歌单历史不可删除'); END; PRAGMA user_version=65; COMMIT;`);};
exports.stripV65=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=66)exports.stripV66(db);if(db.prepare('SELECT revision FROM music_filter_preset_clock WHERE id=1').get().revision!==0||db.prepare('SELECT COUNT(*) n FROM music_filter_preset').get().n)throw new Error('Only empty filter-preset fixtures can be downgraded');db.exec('BEGIN IMMEDIATE; DROP TRIGGER music_filter_preset_budget; DROP TRIGGER music_filter_preset_insert; DROP TRIGGER music_filter_preset_update; DROP TRIGGER music_filter_preset_delete; DROP TABLE music_filter_preset; DROP TABLE music_filter_preset_clock; PRAGMA user_version=64; COMMIT;');};
exports.stripV64=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=65)exports.stripV65(db);if(db.prepare('SELECT COUNT(*) n FROM playback_history').get().n||db.prepare('SELECT COUNT(*) n FROM playback_item_stats').get().n)throw new Error('Only empty statistics fixtures can be downgraded');db.exec('BEGIN IMMEDIATE; DROP INDEX playback_stats_count; DROP INDEX playback_stats_recency; ALTER TABLE playback_history DROP COLUMN last_observed_at; ALTER TABLE playback_history DROP COLUMN observed_basis; ALTER TABLE playback_item_stats DROP COLUMN last_played_basis; PRAGMA user_version=63; COMMIT;');};
exports.stripV63=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=64)exports.stripV64(db);if(db.prepare('SELECT COUNT(*) n FROM playback_history').get().n||db.prepare('SELECT COUNT(*) n FROM playback_history_checkpoint').get().n||db.prepare('SELECT COUNT(*) n FROM playback_item_stats').get().n)throw new Error('Only empty playback-history fixtures can be downgraded');db.exec('BEGIN IMMEDIATE; DROP TRIGGER playback_checkpoint_immutable; DROP TABLE playback_history_checkpoint; DROP TABLE playback_history; DROP TABLE playback_item_stats; PRAGMA user_version=62; COMMIT;');};
exports.stripV62=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=63)exports.stripV63(db);if(db.prepare("SELECT COUNT(*) n FROM playlist WHERE kind='smart'").get().n||db.prepare('SELECT COUNT(*) n FROM playlist_smart_history').get().n)throw new Error('Only empty smart-playlist fixtures can be downgraded');db.exec(`BEGIN IMMEDIATE;
CREATE TABLE playlist_prev(id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),kind TEXT NOT NULL CHECK(kind='static'),revision INTEGER NOT NULL CHECK(revision>=0),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO playlist_prev SELECT id,name,kind,revision,created_at,updated_at FROM playlist;
CREATE TABLE playlist_item_prev(playlist_id TEXT NOT NULL REFERENCES playlist_prev(id) ON DELETE CASCADE,entry_id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE RESTRICT,position INTEGER NOT NULL CHECK(position>=0),UNIQUE(playlist_id,position));
INSERT INTO playlist_item_prev SELECT * FROM playlist_item;DROP TABLE playlist_item;DROP TABLE playlist;DROP TABLE playlist_smart_history;
ALTER TABLE playlist_prev RENAME TO playlist;ALTER TABLE playlist_item_prev RENAME TO playlist_item;CREATE INDEX idx_playlist_item_ref ON playlist_item(item_id);PRAGMA user_version=61;COMMIT;`);};
exports.stripV61=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=62)exports.stripV62(db);db.exec('BEGIN IMMEDIATE; DROP TABLE item_sort_key; PRAGMA user_version=60; COMMIT;');};
exports.stripV60=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=61)exports.stripV61(db);db.exec('BEGIN IMMEDIATE; DROP INDEX media_file_filter_parameters; DROP INDEX release_filter_date; PRAGMA user_version=59; COMMIT;');};
exports.stripV59=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=60)exports.stripV60(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER search_item_word_orphan; DROP INDEX search_item_word_lookup; DROP TABLE search_item_word; DROP TABLE search_word_gram; DROP TABLE search_word; PRAGMA user_version=58; COMMIT;');};
exports.stripV58=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=59)exports.stripV59(db);db.exec('PRAGMA user_version=57');};
exports.stripV57=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=58)exports.stripV58(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_restore_reprobe_release_owner; DROP TRIGGER tag_restore_reprobe_release_immutable; DROP TRIGGER tag_restore_reprobe_release_no_delete; DROP TABLE tag_restore_reprobe_release; DROP TRIGGER tag_restore_reprobe_owner; DROP TRIGGER tag_restore_reprobe_identity; DROP TRIGGER tag_restore_reprobe_final; DROP TRIGGER tag_restore_reprobe_no_delete; DROP TABLE tag_restore_reprobe; PRAGMA user_version=56; COMMIT;");};
exports.stripV56=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=57)exports.stripV57(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_restore_inspection_owner; DROP TRIGGER tag_restore_inspection_identity; DROP TRIGGER tag_restore_inspection_final; DROP TRIGGER tag_restore_inspection_no_delete; DROP TABLE tag_restore_inspection; PRAGMA user_version=55; COMMIT;");};
exports.stripV55=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=56)exports.stripV56(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_restore_receipt_immutable; DROP TRIGGER tag_restore_receipt_no_delete; DROP TABLE tag_restore_receipt; DROP TRIGGER tag_restore_owner; DROP TRIGGER tag_restore_identity; DROP TRIGGER tag_restore_binding; DROP TRIGGER tag_restore_final; DROP TRIGGER tag_restore_monotonic; DROP TRIGGER tag_restore_no_delete; DROP TABLE tag_restore_operation; PRAGMA user_version=54; COMMIT;");};
exports.stripV54=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=55)exports.stripV55(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_commit_reprobe_mode_identity; DROP TRIGGER tag_commit_reprobe_mode_owner; ALTER TABLE tag_commit_reprobe DROP COLUMN mode; PRAGMA user_version=53; COMMIT;");};
exports.stripV53=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=54)exports.stripV54(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_commit_reprobe_release_owner; DROP TRIGGER tag_commit_reprobe_release_immutable; DROP TRIGGER tag_commit_reprobe_release_no_delete; DROP TABLE tag_commit_reprobe_release; DROP TRIGGER tag_commit_reprobe_owner; DROP TRIGGER tag_commit_reprobe_identity; DROP TRIGGER tag_commit_reprobe_final; DROP TRIGGER tag_commit_reprobe_no_delete; DROP TABLE tag_commit_reprobe; PRAGMA user_version=52; COMMIT;");};
exports.stripV52=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=53)exports.stripV53(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_commit_inspection_owner; DROP TRIGGER tag_commit_inspection_identity; DROP TRIGGER tag_commit_inspection_final; DROP TRIGGER tag_commit_inspection_no_delete; DROP TABLE tag_commit_inspection; PRAGMA user_version=51; COMMIT;");};
exports.stripV51=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=52)exports.stripV52(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_commit_receipt_immutable; DROP TRIGGER tag_commit_receipt_no_delete; DROP TABLE tag_commit_receipt; DROP TRIGGER tag_commit_owner; DROP TRIGGER tag_commit_identity; DROP TRIGGER tag_commit_binding; DROP TRIGGER tag_commit_final; DROP TRIGGER tag_commit_monotonic; DROP TRIGGER tag_commit_no_delete; DROP TABLE tag_commit_operation; PRAGMA user_version=50; COMMIT;");};
exports.stripV50=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=51)exports.stripV51(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_recovery_release_owner; DROP TRIGGER tag_recovery_release_immutable; DROP TRIGGER tag_recovery_release_no_delete; DROP TABLE tag_recovery_release; DROP TRIGGER tag_recovery_action_owner; DROP TRIGGER tag_recovery_action_immutable; DROP TRIGGER tag_recovery_action_final; DROP TRIGGER tag_recovery_action_no_delete; DROP TABLE tag_recovery_action; PRAGMA user_version=49; COMMIT;");};
exports.stripV49=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=50)exports.stripV50(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_recovery_owner; DROP TRIGGER tag_recovery_binding_immutable; DROP TRIGGER tag_recovery_final_immutable; DROP TRIGGER tag_recovery_no_delete; DROP TABLE tag_recovery_inspection; PRAGMA user_version=48; COMMIT;");};
exports.stripV48=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=49)exports.stripV49(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_write_stage_receipt_immutable; DROP TRIGGER tag_write_stage_receipt_no_delete; DROP TABLE tag_write_stage_receipt; DROP TRIGGER tag_write_execution_immutable; DROP TRIGGER tag_write_execution_no_delete; DROP TABLE tag_write_execution; PRAGMA user_version=47; COMMIT;");};
exports.stripV47=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=48)exports.stripV48(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER tag_write_lease_file_insert; DROP TRIGGER tag_write_lease_file_update; DROP TRIGGER tag_write_revision_monotonic; DROP TABLE tag_write_file_state; DROP TRIGGER tag_write_command_immutable; DROP TRIGGER tag_write_command_no_delete; DROP TABLE tag_write_command; DROP TRIGGER tag_write_plan_immutable; DROP TRIGGER tag_write_job_no_delete; DROP TABLE tag_write_job; PRAGMA user_version=46; COMMIT;");};
exports.stripV46=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=47)exports.stripV47(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER dsd_output_change_immutable; DROP TRIGGER dsd_output_change_no_delete; DROP TABLE dsd_output_change; DROP TABLE dsd_output_setting; PRAGMA user_version=45; COMMIT;");};
exports.stripV45=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=46)exports.stripV46(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER audio_backend_change_immutable; DROP TRIGGER audio_backend_change_no_delete; DROP TABLE audio_backend_change; DROP TABLE audio_backend_setting; PRAGMA user_version=44; COMMIT;");};
exports.stripV44=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=45)exports.stripV45(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER asio_output_change_immutable; DROP TRIGGER asio_output_change_no_delete; DROP TABLE asio_output_change; DROP TABLE asio_output_setting; PRAGMA user_version=43; COMMIT;");};
exports.stripV43=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=44)exports.stripV44(db);db.exec("BEGIN IMMEDIATE; DROP INDEX playable_item_cue_identity; ALTER TABLE cue_source_file DROP COLUMN gap_policy; ALTER TABLE cue_source_version DROP COLUMN gap_policy; ALTER TABLE cue_document DROP COLUMN gap_policy; PRAGMA user_version=42; COMMIT;");};
exports.stripV42=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=43)exports.stripV43(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER cue_source_asset_immutable; DROP TRIGGER cue_source_asset_no_delete; DROP TRIGGER cue_source_version_immutable; DROP TRIGGER cue_source_version_no_delete; DROP TRIGGER cue_interpret_command_immutable; DROP TRIGGER cue_interpret_command_no_delete; DROP INDEX cue_document_path_key_lookup; UPDATE cue_source_file SET latest_version=NULL; DROP TABLE cue_source_version; DROP TABLE cue_source_file; DROP TABLE cue_source_asset; DROP TABLE cue_interpret_command; DROP TABLE cue_source_usage; PRAGMA user_version=41; COMMIT;');};
exports.stripV41=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=42)exports.stripV42(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER file_policy_command_immutable; DROP TRIGGER file_policy_command_no_delete; DROP TRIGGER file_policy_insert; DROP TRIGGER file_policy_update; DROP TRIGGER file_policy_item_insert; DROP TRIGGER file_policy_item_rebind; DROP TABLE file_policy_command; DROP TABLE media_file_policy; DROP INDEX playable_item_library_state; ALTER TABLE playable_item DROP COLUMN library_state; PRAGMA user_version=40; COMMIT;');};
exports.stripV40=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=41)exports.stripV41(db);db.exec('BEGIN IMMEDIATE; DROP TABLE media_file_observation; ALTER TABLE scan_entry DROP COLUMN observation_hash; ALTER TABLE scan_entry DROP COLUMN observed_at; PRAGMA user_version=39; COMMIT;');};
exports.stripV39=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=40)exports.stripV40(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER search_latin_delete; DROP TABLE search_latin; DROP TABLE search_latin_fts; DROP TABLE search_index_state; PRAGMA user_version=38; COMMIT;');};
exports.stripV38=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=39)exports.stripV39(db);db.exec('PRAGMA user_version=37');};
exports.stripV37=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=38)exports.stripV38(db);db.exec('BEGIN IMMEDIATE; ALTER TABLE media_file DROP COLUMN replay_gain_json; PRAGMA user_version=36; COMMIT;');};
exports.stripV36=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=37)exports.stripV37(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER audio_output_change_immutable; DROP TRIGGER audio_output_change_no_delete; DROP TABLE audio_output_change; DROP TABLE audio_output_setting; PRAGMA user_version=35; COMMIT;');};
exports.stripV35=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=36)exports.stripV36(db);db.exec('BEGIN IMMEDIATE; DROP INDEX lyrics_local_version_global_page; PRAGMA user_version=34; COMMIT;');};
exports.stripV34=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=35)exports.stripV35(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER lyrics_document_local_origin_no_delete; DROP TRIGGER lyrics_document_local_origin_immutable; DROP TRIGGER lyrics_local_version_no_delete; DROP TRIGGER lyrics_local_version_immutable; DROP TABLE lyrics_document_local_origin; DROP TABLE lyrics_local_latest; DROP TABLE lyrics_local_version; PRAGMA user_version=33; COMMIT;');};
exports.stripV33=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=34)exports.stripV34(db);db.exec('BEGIN IMMEDIATE; DELETE FROM artwork_asset; PRAGMA user_version=32; COMMIT;');};
// Historical fixtures discard derived thumbnails when reverting the algorithm contract.
exports.stripV32=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=33)exports.stripV33(db);db.exec('BEGIN IMMEDIATE; DELETE FROM artwork_asset; PRAGMA user_version=31; COMMIT;');};
exports.stripV31=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=32)exports.stripV32(db);db.exec('BEGIN IMMEDIATE; DROP TABLE artwork_reference; DROP TABLE artwork_claim; DROP TABLE artwork_asset; PRAGMA user_version=30; COMMIT;');};
exports.stripV30=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=31)exports.stripV31(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER cue_track_owner_insert; DROP TRIGGER cue_track_owner_update; DROP TRIGGER cue_item_source_update; DROP TABLE cue_track; ALTER TABLE cue_document DROP COLUMN source_hash; ALTER TABLE cue_document DROP COLUMN encoding; ALTER TABLE cue_document DROP COLUMN parser_version; ALTER TABLE cue_document DROP COLUMN fields_json; PRAGMA user_version=29; COMMIT;');};
exports.stripV29=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=30)exports.stripV30(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER scan_command_immutable; DROP TRIGGER scan_command_no_delete; DROP TRIGGER scan_job_identity; DROP TABLE scan_command; DROP TABLE scan_entry; DROP TABLE scan_job; PRAGMA user_version=28; COMMIT;");};
exports.stripV28=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=29)exports.stripV29(db);db.exec("BEGIN IMMEDIATE; PRAGMA user_version=27; COMMIT;");};
exports.stripV27=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=28)exports.stripV28(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER lyrics_document_context_immutable; DROP TRIGGER lyrics_document_context_no_delete; DROP TABLE lyrics_document_context; DROP INDEX lyrics_document_change_document; PRAGMA user_version=26; COMMIT;");};
exports.stripV26=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=27)exports.stripV27(db);db.exec("BEGIN IMMEDIATE; DROP INDEX lyrics_document_saved_page; DROP INDEX lyrics_document_state_filter; DROP INDEX lyrics_document_import_origin; PRAGMA user_version=25; COMMIT;");};
exports.stripV25=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=26)exports.stripV26(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER lyrics_document_immutable; DROP TRIGGER lyrics_document_no_delete; DROP TRIGGER lyrics_document_change_immutable; DROP TRIGGER lyrics_document_change_no_delete; DROP TABLE lyrics_document_change; DROP TABLE lyrics_document_state; DROP TABLE lyrics_document; DROP TABLE lyrics_document_scope; PRAGMA user_version=24; COMMIT;");};
exports.stripV24=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=25)exports.stripV25(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER lyrics_preference_receipt_immutable; DROP TRIGGER lyrics_preference_receipt_no_delete; DROP TABLE lyrics_preference_receipt; DROP TABLE lyrics_preference; PRAGMA user_version=23; COMMIT;");};
exports.stripV23=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=24)exports.stripV24(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER waveform_job_identity; DROP TABLE waveform_job; DROP TABLE waveform_reference; DROP TABLE waveform_cache; PRAGMA user_version=22; COMMIT;");};
exports.stripV22=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=23)exports.stripV23(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER provider_retention_change_immutable; DROP TRIGGER provider_retention_change_no_delete; DROP TABLE provider_retention_change; DROP TABLE provider_retention; DROP INDEX metadata_change_provider_page; DROP INDEX metadata_observation_source_count; DROP INDEX metadata_collection_observation_source_count; DROP INDEX metadata_collection_change_source_count; PRAGMA user_version=21; COMMIT;");};
exports.stripV21=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=22)exports.stripV22(db);db.exec("BEGIN IMMEDIATE; DROP TRIGGER provider_credential_command_immutable; DROP TRIGGER provider_credential_command_no_delete; DROP TRIGGER provider_setting_change_immutable; DROP TRIGGER provider_setting_change_no_delete; DROP TABLE provider_credential_command; DROP TABLE provider_setting_change; DROP TABLE provider_setting; DELETE FROM app_setting WHERE key='provider_credential_scope'; PRAGMA user_version=20; COMMIT;");};
exports.stripV20=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=21)exports.stripV21(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER metadata_undo_member_owner; DROP TRIGGER metadata_compensation_owner; DROP TRIGGER metadata_compensation_immutable; DROP TRIGGER metadata_compensation_no_delete; DROP TRIGGER metadata_undo_member_immutable; DROP TRIGGER metadata_undo_member_no_delete; DROP TABLE metadata_undo_member; DROP TABLE metadata_compensation; ALTER TABLE metadata_batch_row DROP COLUMN undo_result_json; PRAGMA user_version=19; COMMIT;');};
exports.stripV19=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=20)exports.stripV20(db);db.exec('BEGIN IMMEDIATE; DROP TRIGGER metadata_batch_plan_immutable; DROP TRIGGER metadata_batch_row_immutable; DROP TABLE metadata_batch_row; DROP TABLE metadata_batch; PRAGMA user_version=18; COMMIT;');};
exports.stripV18=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=19)exports.stripV19(db);db.exec('BEGIN IMMEDIATE; ALTER TABLE artist_credit_member DROP COLUMN credited_name; PRAGMA user_version=17; COMMIT;');};
exports.stripV17=db=>{
 if(db.prepare('PRAGMA user_version').get().user_version>=18)exports.stripV18(db);
 db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 DROP TRIGGER genre_alias_immutable_update; DROP TRIGGER genre_alias_immutable_delete; DROP TRIGGER genre_identity_restrict;
 DROP TRIGGER genre_parent_insert; DROP TRIGGER genre_parent_update; DROP TRIGGER genre_alias_insert; DROP TRIGGER genre_alias_update;
 DROP TRIGGER item_genre_active; DROP TRIGGER release_genre_active;
 DROP TRIGGER item_genre_active_update; DROP TRIGGER release_genre_active_update;
 DROP TABLE genre_change; DROP TABLE genre_name_alias; DROP INDEX idx_genre_parent; DROP INDEX idx_release_genre_reverse;
 ALTER TABLE genre DROP COLUMN revision; ALTER TABLE genre DROP COLUMN customized; ALTER TABLE genre DROP COLUMN archived;
 PRAGMA user_version=16; COMMIT;`);
};
exports.stripV16=db=>{
 if(db.prepare('PRAGMA user_version').get().user_version>=17)exports.stripV17(db);
 db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;');
 try{
  for(const table of ['metadata_change','artist_profile_change','release_profile_change','recording_profile_change','metadata_policy_change','metadata_selection_change'])
   db.exec(`UPDATE ${table} SET before_json=json_remove(before_json,'$.provenance.collections'),after_json=json_remove(after_json,'$.provenance.collections');`);
  for(const row of db.prepare('SELECT id,before_json,after_json FROM artist_change').all()){
   const before=JSON.parse(row.before_json),after=JSON.parse(row.after_json);
   for(const snapshot of [before,after])for(const item of snapshot.items??[])delete item.collections;
   db.prepare('UPDATE artist_change SET before_json=?,after_json=? WHERE id=?').run(JSON.stringify(before),JSON.stringify(after),row.id);
  }
  db.exec(`DROP TRIGGER artist_archive_collection; DROP TRIGGER playable_item_collection_restrict; DROP TRIGGER recording_collection_restrict; DROP TRIGGER release_collection_restrict;
   DROP TABLE metadata_collection_change; DROP TABLE metadata_collection_state; DROP TABLE metadata_collection_observation;
   PRAGMA user_version=15; COMMIT;`);
 }catch(error){db.exec('ROLLBACK');throw error;}
};
exports.stripV15=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=16)exports.stripV16(db);db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 UPDATE metadata_change SET before_json=json_remove(before_json,'$.provenance.selections'),after_json=json_remove(after_json,'$.provenance.selections');
 UPDATE artist_profile_change SET before_json=json_remove(before_json,'$.provenance.selections'),after_json=json_remove(after_json,'$.provenance.selections');
 UPDATE release_profile_change SET before_json=json_remove(before_json,'$.provenance.selections'),after_json=json_remove(after_json,'$.provenance.selections');
 UPDATE recording_profile_change SET before_json=json_remove(before_json,'$.provenance.selections'),after_json=json_remove(after_json,'$.provenance.selections');
 UPDATE metadata_policy_change SET before_json=json_remove(before_json,'$.provenance.selections'),after_json=json_remove(after_json,'$.provenance.selections');
 DROP TABLE metadata_selection; DROP TABLE metadata_auto_source; DROP TABLE metadata_selection_change;
 PRAGMA user_version=14; COMMIT;`);};
exports.stripV14=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=15)exports.stripV15(db);db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 UPDATE metadata_change SET before_json=json_remove(before_json,'$.provenance'),after_json=json_remove(after_json,'$.provenance');
 UPDATE artist_profile_change SET before_json=json_remove(before_json,'$.provenance'),after_json=json_remove(after_json,'$.provenance');
 UPDATE release_profile_change SET before_json=json_remove(before_json,'$.provenance'),after_json=json_remove(after_json,'$.provenance');
 UPDATE recording_profile_change SET before_json=json_remove(before_json,'$.provenance'),after_json=json_remove(after_json,'$.provenance');
 DROP TRIGGER playable_item_metadata_restrict; DROP TRIGGER artist_metadata_restrict; DROP TRIGGER recording_metadata_restrict; DROP TRIGGER release_metadata_restrict; DROP TRIGGER release_group_metadata_restrict;
 DROP TABLE field_decision; DROP TABLE metadata_observation; DROP TABLE metadata_field_revision; DROP TABLE metadata_policy_state; DROP TABLE metadata_policy_change; DROP TABLE provider_rights;
 PRAGMA user_version=13; COMMIT;`);};
// Reconstruct pre-user-data schema only inside isolated test databases.
exports.stripV13=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=14)exports.stripV14(db);db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 DROP TRIGGER recording_credit_active_insert; DROP TRIGGER recording_credit_active_update; DROP TRIGGER artist_archive_recording;
 DROP TABLE recording_profile_change; DROP TABLE recording_profile_state; PRAGMA user_version=12; COMMIT;`);};
exports.stripV12=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=13)exports.stripV13(db);db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 DROP TRIGGER recording_reference_delete; DROP TRIGGER release_reference_delete; DROP TRIGGER group_reference_delete;
 DROP TRIGGER entity_reference_state_insert; DROP TRIGGER entity_reference_state_identity;
 DROP TABLE entity_reference_change; DROP TABLE entity_reference_state; PRAGMA user_version=11; COMMIT;`);};
exports.stripV11=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=12)exports.stripV12(db);db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
 DROP TRIGGER release_credit_active_insert; DROP TRIGGER release_credit_active_update;
 DROP TABLE release_profile_change; DROP TABLE release_profile_state; PRAGMA user_version=10; COMMIT;`);};
exports.stripV10=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=11)exports.stripV11(db);db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
  DROP TRIGGER external_ref_insert; DROP TRIGGER external_ref_update;
  DROP TRIGGER artist_identity_active_insert; DROP TRIGGER artist_identity_active_update;
  DROP TRIGGER artist_credit_active_insert; DROP TRIGGER artist_credit_active_update;
  DROP TRIGGER playable_credit_active_update; DROP TRIGGER playable_release_active_update;
  DROP TRIGGER playable_credit_active_insert; DROP TRIGGER playable_release_active_insert; DROP TRIGGER artist_archive_current;
  DROP TABLE artist_profile_change; DROP TABLE external_ref; DROP INDEX idx_artist_active;
  ALTER TABLE artist DROP COLUMN archived; PRAGMA user_version=9; COMMIT;`);};
exports.stripV9=db=>{if(db.prepare('PRAGMA user_version').get().user_version>=10)exports.stripV10(db);
db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DROP TABLE release_change; PRAGMA user_version=8; COMMIT;`);};
exports.stripV8=db=>{
if(db.prepare('PRAGMA user_version').get().user_version>=9)exports.stripV9(db);
db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
  DROP TABLE artist_change; DROP TABLE item_credit_binding; DROP TABLE artist_identity_state; DROP TABLE artist_identity_binding;
  PRAGMA user_version=7; COMMIT;`);};
exports.stripV7=db=>{
if(db.prepare('PRAGMA user_version').get().user_version>=8)exports.stripV8(db);
db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
  DROP TABLE item_catalog_binding; DROP TABLE item_catalog_state; DROP TABLE catalog_change; DROP INDEX idx_item_recording;
  DROP INDEX idx_track_recording;
  PRAGMA user_version=6; COMMIT;`);};
exports.stripV6=db=>{
if(db.prepare('PRAGMA user_version').get().user_version>=7)exports.stripV7(db);
db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
  DROP INDEX idx_item_release_track;
  ALTER TABLE playable_item DROP COLUMN recording_id;
  ALTER TABLE playable_item DROP COLUMN release_track_id;
  ALTER TABLE playable_item DROP COLUMN artist_credit_id;
  DROP TABLE item_catalog_source; DROP TABLE item_genre; DROP TABLE release_genre;
  DROP TABLE release_track; DROP TABLE recording; DROP TABLE medium; DROP TABLE release; DROP TABLE release_group;
  DROP TABLE artist_credit_member; DROP TABLE artist_credit; DROP TABLE artist; DROP TABLE genre;
  PRAGMA user_version=5; COMMIT;`);};
exports.stripV5=db=>{
if(db.prepare('PRAGMA user_version').get().user_version>=6)exports.stripV6(db);
db.exec(`PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;
  DROP TABLE playlist_item; DROP TABLE playlist; DROP TABLE item_user_state; DROP TABLE user_command_receipt;
  DROP INDEX idx_item_added; ALTER TABLE playable_item DROP COLUMN added_at;
  PRAGMA user_version=4; COMMIT;`);};
