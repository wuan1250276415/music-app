import {catalogBackupClient} from './catalog-backup-client.js';
export const restoreDocumentId=crypto.randomUUID();
export const restoreWebDigest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
export function assertRestoreDocumentHeld(operationId:string):void{const state=catalogBackupClient.snapshot().state;if(!state.held||state.operationId!==operationId)throw new Error('恢复界面尚未确认原维护占用');}
