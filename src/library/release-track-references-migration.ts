import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

// Historic schema74 declarations stay unchanged. This migration replaces only
// the two closed-kind tables, retaining their exact rows and existing audits.
const externalTable=`CREATE TABLE external_ref(entity_kind TEXT NOT NULL CHECK(entity_kind IN('artist','recording','release','release_group','release_track')),
 entity_id TEXT NOT NULL,provider TEXT NOT NULL,external_id TEXT NOT NULL,url TEXT,
 PRIMARY KEY(entity_kind,entity_id,provider,external_id),UNIQUE(entity_kind,provider,external_id));
 CREATE INDEX idx_external_entity ON external_ref(entity_kind,entity_id);`;
const externalGuards=`CREATE TRIGGER external_ref_insert BEFORE INSERT ON external_ref BEGIN
 SELECT CASE WHEN NOT((NEW.entity_kind='artist' AND EXISTS(SELECT 1 FROM artist WHERE id=NEW.entity_id AND local_key IS NULL AND archived=0))
 OR(NEW.entity_kind='recording' AND EXISTS(SELECT 1 FROM recording WHERE id=NEW.entity_id))
 OR(NEW.entity_kind='release' AND EXISTS(SELECT 1 FROM release WHERE id=NEW.entity_id))
 OR(NEW.entity_kind='release_group' AND EXISTS(SELECT 1 FROM release_group WHERE id=NEW.entity_id))
 OR(NEW.entity_kind='release_track' AND EXISTS(SELECT 1 FROM release_track WHERE id=NEW.entity_id))) THEN RAISE(ABORT,'invalid external entity') END;END;
 CREATE TRIGGER external_ref_update BEFORE UPDATE ON external_ref BEGIN SELECT RAISE(ABORT,'replace external references through an owned command');END;`;
const stateTable=`CREATE TABLE entity_reference_state(entity_kind TEXT NOT NULL CHECK(entity_kind IN('recording','release','release_group','release_track')),
 entity_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=0),PRIMARY KEY(entity_kind,entity_id));`;
const stateGuards=`CREATE TRIGGER entity_reference_state_insert BEFORE INSERT ON entity_reference_state BEGIN
 SELECT CASE WHEN NOT((NEW.entity_kind='recording' AND EXISTS(SELECT 1 FROM recording WHERE id=NEW.entity_id))
 OR(NEW.entity_kind='release' AND EXISTS(SELECT 1 FROM release WHERE id=NEW.entity_id))
 OR(NEW.entity_kind='release_group' AND EXISTS(SELECT 1 FROM release_group WHERE id=NEW.entity_id))
 OR(NEW.entity_kind='release_track' AND EXISTS(SELECT 1 FROM release_track WHERE id=NEW.entity_id))) THEN RAISE(ABORT,'invalid reference entity') END;END;
 CREATE TRIGGER entity_reference_state_identity BEFORE UPDATE OF entity_kind,entity_id ON entity_reference_state BEGIN SELECT RAISE(ABORT,'reference state identity is immutable');END;
 CREATE TRIGGER track_reference_delete BEFORE DELETE ON release_track WHEN EXISTS(SELECT 1 FROM external_ref WHERE entity_kind='release_track' AND entity_id=OLD.id)
 OR EXISTS(SELECT 1 FROM entity_reference_state WHERE entity_kind='release_track' AND entity_id=OLD.id) BEGIN SELECT RAISE(ABORT,'发行曲目引用身份必须保留');END;`;

export function referenceMigrationFingerprint(db:DatabaseSync):string {
 const hash=createHash('sha256');
 for(const sql of [
  'SELECT entity_kind,entity_id,provider,external_id,url FROM external_ref ORDER BY entity_kind,entity_id,provider,external_id',
  'SELECT entity_kind,entity_id,CAST(revision AS TEXT) revision FROM entity_reference_state ORDER BY entity_kind,entity_id',
  'SELECT id,action,title,before_json,after_json,CAST(created_at AS TEXT) created_at,CAST(undone_at AS TEXT) undone_at FROM entity_reference_change ORDER BY id',
  'SELECT command_id,fingerprint,result_json,CAST(created_at AS TEXT) created_at FROM user_command_receipt ORDER BY command_id',
 ]){hash.update(sql);for(const row of db.prepare(sql).iterate())hash.update(JSON.stringify(row)+'\n');}
 return hash.digest('hex');
}
export function migrateReleaseTrackReferences(db:DatabaseSync):void {
 if(!db.isTransaction)throw new Error('发行曲目引用升级必须属于曲库迁移事务');
 const before=referenceMigrationFingerprint(db);
 db.exec(`CREATE TEMP TABLE aural_track_external_before AS SELECT * FROM main.external_ref;
 CREATE TEMP TABLE aural_track_state_before AS SELECT * FROM main.entity_reference_state;
 DROP TABLE main.external_ref;${externalTable}
 INSERT INTO main.external_ref SELECT * FROM temp.aural_track_external_before;${externalGuards}
 DROP TABLE main.entity_reference_state;${stateTable}
 INSERT INTO main.entity_reference_state SELECT * FROM temp.aural_track_state_before;${stateGuards}`);
 if(referenceMigrationFingerprint(db)!==before)throw new Error('发行曲目引用升级改变了已有引用、修订、审计或提交回执');
 if(db.prepare('PRAGMA foreign_key_check').get())throw new Error('发行曲目引用升级外键核对失败');
 db.exec('DROP TABLE temp.aural_track_external_before;DROP TABLE temp.aural_track_state_before;');
}
