import type {DatabaseSync} from 'node:sqlite';
import {RECOGNITION_CODES} from '../shared/metadata-recognition.js';

export const recognitionRetrySchema=`
 ALTER TABLE metadata_recognition_run ADD COLUMN retry_active INTEGER NOT NULL DEFAULT 0 CHECK(retry_active IN(0,1));
 CREATE TABLE metadata_recognition_progress(
  job_id TEXT PRIMARY KEY REFERENCES metadata_recognition_run(job_id),
  retained INTEGER NOT NULL DEFAULT 0 CHECK(retained>=0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK(failed>=0),
  retry_pending INTEGER NOT NULL DEFAULT 0 CHECK(retry_pending>=0)
 );
 INSERT INTO metadata_recognition_progress(job_id,retained,failed)
 SELECT r.job_id,(SELECT COUNT(*) FROM metadata_recognition_mapping m WHERE m.job_id=r.job_id),
 (SELECT COUNT(*) FROM metadata_recognition_item i WHERE i.job_id=r.job_id AND i.phase='failed') FROM metadata_recognition_run r;
 CREATE TABLE metadata_recognition_retry(
  job_id TEXT NOT NULL,item_id TEXT NOT NULL,code TEXT NOT NULL,
  PRIMARY KEY(job_id,item_id),FOREIGN KEY(job_id,item_id) REFERENCES metadata_workflow_item(job_id,item_id),
  FOREIGN KEY(job_id) REFERENCES metadata_recognition_run(job_id)
 );
 CREATE INDEX metadata_recognition_failure ON metadata_recognition_item(job_id,phase,item_id);
 CREATE TRIGGER metadata_recognition_progress_create AFTER INSERT ON metadata_recognition_run BEGIN
  INSERT INTO metadata_recognition_progress(job_id) VALUES(NEW.job_id);
 END;
 CREATE TRIGGER metadata_recognition_mapping_count_insert AFTER INSERT ON metadata_recognition_mapping BEGIN
  UPDATE metadata_recognition_progress SET retained=retained+1 WHERE job_id=NEW.job_id;
 END;
 CREATE TRIGGER metadata_recognition_mapping_count_delete AFTER DELETE ON metadata_recognition_mapping BEGIN
  UPDATE metadata_recognition_progress SET retained=retained-1 WHERE job_id=OLD.job_id;
 END;
 CREATE TRIGGER metadata_recognition_failure_count_insert AFTER INSERT ON metadata_recognition_item WHEN NEW.phase='failed' BEGIN
  UPDATE metadata_recognition_progress SET failed=failed+1 WHERE job_id=NEW.job_id;
 END;
 CREATE TRIGGER metadata_recognition_failure_count_delete AFTER DELETE ON metadata_recognition_item WHEN OLD.phase='failed' BEGIN
  UPDATE metadata_recognition_progress SET failed=failed-1 WHERE job_id=OLD.job_id;
 END;
 CREATE TRIGGER metadata_recognition_failure_count_update AFTER UPDATE OF phase ON metadata_recognition_item WHEN OLD.phase<>NEW.phase BEGIN
  UPDATE metadata_recognition_progress SET failed=failed+(NEW.phase='failed')-(OLD.phase='failed') WHERE job_id=NEW.job_id;
 END;
 CREATE TRIGGER metadata_recognition_retry_count_insert AFTER INSERT ON metadata_recognition_retry BEGIN
  UPDATE metadata_recognition_progress SET retry_pending=retry_pending+1 WHERE job_id=NEW.job_id;
 END;
 CREATE TRIGGER metadata_recognition_retry_count_delete AFTER DELETE ON metadata_recognition_retry BEGIN
  UPDATE metadata_recognition_progress SET retry_pending=retry_pending-1 WHERE job_id=OLD.job_id;
 END;
 CREATE TRIGGER metadata_recognition_member_handled AFTER UPDATE OF status ON metadata_workflow_item
 WHEN NEW.status IN('planned','skipped') AND OLD.status NOT IN('planned','skipped') BEGIN
  UPDATE metadata_recognition_item SET phase='handled',code=CASE WHEN NEW.status='skipped' THEN 'cancelled' ELSE code END
   WHERE job_id=NEW.job_id AND item_id=NEW.item_id AND phase<>'handled';
  DELETE FROM metadata_recognition_retry WHERE job_id=NEW.job_id AND item_id=NEW.item_id;
 END;
`;

export function validateRecognitionRetries(db:DatabaseSync,check:()=>void):void {
 for(const row of db.prepare(`SELECT r.job_id,r.retry_active,r.mode,p.retained,p.failed,p.retry_pending,
  (SELECT COUNT(*) FROM metadata_recognition_mapping m WHERE m.job_id=r.job_id) actual_retained,
  (SELECT COUNT(*) FROM metadata_recognition_item i WHERE i.job_id=r.job_id AND i.phase='failed') actual_failed,
  (SELECT COUNT(*) FROM metadata_recognition_retry q WHERE q.job_id=r.job_id) actual_retry
  FROM metadata_recognition_run r LEFT JOIN metadata_recognition_progress p ON p.job_id=r.job_id`).iterate()){
  check();if(![0,1].includes(Number(row.retry_active))||row.retry_active===1&&row.mode!=='library'||!['retained','failed','retry_pending'].every(key=>Number.isSafeInteger(row[key])&&Number(row[key])>=0)||row.retained!==row.actual_retained||row.failed!==row.actual_failed||row.retry_pending!==row.actual_retry||row.retry_active===0&&row.retry_pending!==0)throw new Error('后台识别进度或重试范围不一致');
 }
 for(const row of db.prepare('SELECT q.code,w.status FROM metadata_recognition_retry q JOIN metadata_workflow_item w ON w.job_id=q.job_id AND w.item_id=q.item_id').iterate()){
  check();if(!RECOGNITION_CODES.includes(row.code as typeof RECOGNITION_CODES[number])||['planned','skipped'].includes(String(row.status)))throw new Error('后台识别重试成员无效');
 }
 if(db.prepare('SELECT 1 FROM metadata_recognition_mapping m LEFT JOIN metadata_recognition_run r ON r.job_id=m.job_id WHERE r.job_id IS NULL LIMIT 1').get()||db.prepare('SELECT 1 FROM metadata_recognition_item i LEFT JOIN metadata_recognition_run r ON r.job_id=i.job_id WHERE r.job_id IS NULL LIMIT 1').get())throw new Error('后台识别记录缺少所属任务');
}
