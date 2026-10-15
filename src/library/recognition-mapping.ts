import type {DatabaseSync} from 'node:sqlite';
import {readRecognitionMapping,type RecognitionMapping} from '../shared/recognition-mapping.js';
export const recognitionMappingSchema=`
 ALTER TABLE metadata_recognition_run ADD COLUMN mode TEXT NOT NULL DEFAULT 'page' CHECK(mode IN('page','library'));
 ALTER TABLE metadata_recognition_run ADD COLUMN cursor INTEGER NOT NULL DEFAULT -1 CHECK(cursor>=-1);
 CREATE TABLE metadata_recognition_mapping(
  job_id TEXT NOT NULL,item_id TEXT NOT NULL,
  mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json) AND length(CAST(mapping_json AS BLOB))<=32768),
  PRIMARY KEY(job_id,item_id),
  FOREIGN KEY(job_id,item_id) REFERENCES metadata_workflow_item(job_id,item_id)
 );
`;
export function validateRecognitionMappings(db:DatabaseSync,check:()=>void):void {
 for(const row of db.prepare('SELECT job_id,item_id,mapping_json FROM metadata_recognition_mapping').iterate()){
  check();if(typeof row.mapping_json!=='string'||Buffer.byteLength(row.mapping_json)>32768)throw new Error('识别依据超过读取预算');readRecognitionMapping(JSON.parse(row.mapping_json));
 }
 for(const row of db.prepare('SELECT r.mode,r.cursor,w.total FROM metadata_recognition_run r JOIN metadata_workflow w ON w.id=r.job_id').iterate()){
  check();if(!['page','library'].includes(String(row.mode))||!Number.isSafeInteger(row.cursor)||Number(row.cursor)<-1||Number(row.cursor)>=Number(row.total))throw new Error('整库识别位置无效');
 }
}
export function loadRecognitionMapping(db:DatabaseSync,jobId:string,itemId:string):RecognitionMapping|null {
 const row=db.prepare('SELECT mapping_json FROM metadata_recognition_mapping WHERE job_id=? AND item_id=?').get(jobId,itemId) as {mapping_json:string}|undefined;
 return row?readRecognitionMapping(JSON.parse(row.mapping_json)):null;
}
