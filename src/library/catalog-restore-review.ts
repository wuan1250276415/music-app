import {inspectCatalogBackupDatabase} from './catalog-backup-database.js';
import {bindRestoreReviewEvidence,RESTORE_REVIEW_BYTES,type RestoreReviewEvidence} from '../shared/catalog-restore-review.js';
import type {CatalogBackupManifest} from '../shared/catalog-backup.js';
import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';

// Offline snapshot only: no repositories, migrations, credentials, directory
// probes, imported task execution, or writes. The worker hashes all files again
// after this read before it sends its final, acknowledged result.
export async function inspectRestoreReview(filename:string,manifest:CatalogBackupManifest,pendingKeys:string[],signal:AbortSignal):Promise<RestoreReviewEvidence>{
 const evidence:RestoreReviewEvidence={version:1,origin:manifest.origin,databaseSha256:manifest.files.find(f=>f.role==='database')!.sha256,roots:[],providers:[],tasks:{scans:0,tagWrites:0,credentialCommands:0,metadataObservations:0},pendingKeys,historyPendingBytes:manifest.files.filter(f=>f.role==='history-pending').reduce((n,f)=>n+f.bytes,0)};
 let bytes=0;const expected=manifest.files.find(f=>f.role==='database')!;const before=await fs.lstat(filename,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size!==BigInt(expected.bytes))throw new Error('恢复审核数据库身份或尺寸不符');
 const handle=await fs.open(filename,'r');
 const stable=async()=>{signal.throwIfAborted();const held=await handle.stat({bigint:true}),named=await fs.lstat(filename,{bigint:true});if(named.isSymbolicLink()||named.nlink!==1n||fileObservation(held)!==fileObservation(before)||fileObservation(named)!==fileObservation(before))throw new Error('恢复审核数据库在读取期间变化');};
 try{
  await stable();const hash=createHash('sha256'),chunk=Buffer.alloc(256*1024);let at=0;
  while(at<expected.bytes){signal.throwIfAborted();const read=await handle.read(chunk,0,Math.min(chunk.length,expected.bytes-at),at);if(!read.bytesRead)throw new Error('恢复审核数据库截断');hash.update(chunk.subarray(0,read.bytesRead));at+=read.bytesRead;}
  if(hash.digest('hex')!==expected.sha256)throw new Error('恢复审核数据库内容与原清单不同');await stable();
  inspectCatalogBackupDatabase(filename,manifest,undefined,db=>{
  for(const row of db.prepare('SELECT id,path FROM library_root ORDER BY id COLLATE BINARY LIMIT 4097').iterate()){
   signal.throwIfAborted();if(evidence.roots.length>=4096||typeof row.id!=='string'||typeof row.path!=='string')throw new Error('恢复目录超过审核预算或内容无效');
   bytes+=Buffer.byteLength(row.id)+Buffer.byteLength(row.path)+128;if(bytes>RESTORE_REVIEW_BYTES-32768)throw new Error('恢复目录审核文字超过预算');evidence.roots.push({id:row.id,path:row.path});
  }
  for(const row of db.prepare('SELECT provider_id,enabled FROM provider_setting ORDER BY provider_id COLLATE BINARY LIMIT 129').iterate()){
   signal.throwIfAborted();if(evidence.providers.length>=128||typeof row.provider_id!=='string'||row.enabled!==0&&row.enabled!==1)throw new Error('恢复数据源审核内容无效');evidence.providers.push({id:row.provider_id,enabled:row.enabled===1});
  }
  // All SQL identifiers are fixed; imported values never become SQL or paths.
  const total=(table:'scan_job'|'tag_write_job'|'provider_credential_command'|'metadata_observation')=>{signal.throwIfAborted();return Number((db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as {n:number}).n);};
  evidence.tasks={scans:total('scan_job'),tagWrites:total('tag_write_job'),credentialCommands:total('provider_credential_command'),metadataObservations:total('metadata_observation')};
  });
  await stable();
 }finally{await handle.close();}
 signal.throwIfAborted();return bindRestoreReviewEvidence(evidence,manifest,pendingKeys.length);
}
