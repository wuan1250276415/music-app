import {captureRendererBackupPending} from './catalog-backup-pending.js';
import {readRestorePendingRequest,type RestorePendingReply} from '../shared/catalog-restore-pending.js';

const sha=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(b=>b.toString(16).padStart(2,'0')).join('');
// The caller supplies the original Storage method only for the held Main
// challenge. The immutable Main archive exists before this request is sent.
export async function settleRendererRestorePending(value:unknown,remove:(key:string)=>void):Promise<RestorePendingReply>{
 const request=readRestorePendingRequest(value),originalSha256=await sha(request.original);
 const base={version:1 as const,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,archiveSha256:request.archiveSha256,originalSha256};
 try{
  const expected=new Map(request.original.values.map(v=>[v.key,v.raw])),current=captureRendererBackupPending();
  if(current.values.some(v=>!expected.has(v.key)||expected.get(v.key)!==v.raw)||request.role==='original'&&JSON.stringify(current.values)!==JSON.stringify(request.original.values))throw new Error('界面待保存资料与原冻结快照不同，已保留原资料');
  // Missing keys are permitted only on the import path after an interrupted
  // clearing attempt. No changed or newly added key may be removed.
  if(request.role==='candidate')for(const entry of request.original.values){const raw=localStorage.getItem(entry.key);if(raw!==null){if(raw!==entry.raw)throw new Error('界面原操作内容在清理期间变化');remove(entry.key);}}
  const after=captureRendererBackupPending();if(request.role==='candidate'?after.values.length!==0:JSON.stringify(after.values)!==JSON.stringify(request.original.values))throw new Error('界面待保存资料处理后无法核对');
  return {...base,resultSha256:await sha(after.values),cleared:request.role==='candidate',error:''};
 }catch(error){return {...base,resultSha256:null,cleared:false,error:String(error instanceof Error?error.message:error).slice(0,1024)||'界面待保存资料无法核对'};}
}
