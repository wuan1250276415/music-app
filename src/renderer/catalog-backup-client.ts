import {readRestorePendingRequest,type RestorePendingReply} from '../shared/catalog-restore-pending.js';
import {settleRendererRestorePending} from './catalog-restore-pending.js';
import {CATALOG_BACKUP_PENDING_KEYS,backupUuid} from '../shared/catalog-backup.js';
import {readBackupFreeze,readBackupState,type CatalogBackupState,type CatalogBackupFrozen} from '../shared/catalog-backup-ui.js';
import {captureRendererBackupPending} from './catalog-backup-pending.js';
import {readBackupHistory,type CatalogBackupHistory} from '../shared/catalog-backup-history.js';
import {readRestoreAppRequest} from '../shared/catalog-restore-application.js';
import {initialRestoreApplyState,readRestoreApplyState,restoreApplyActive,type CatalogRestoreApplyState} from '../shared/catalog-restore-consent';
type Client={restoreApply:CatalogRestoreApplyState;state:CatalogBackupState;open:boolean;error:string;restoreOperationId:string|null};
let value:Client={restoreApply:{...initialRestoreApplyState},state:{operationId:null,phase:'idle',held:false,cancelRequested:false,bytes:0,total:0,message:'',result:null},open:false,error:'',restoreOperationId:null};
const listeners=new Set<()=>void>();let hold:string|null=null,initialized=false,lastAck:CatalogBackupFrozen|null=null;
let removeHeldPending:((key:string)=>void)|null=null,pendingWork:Promise<RestorePendingReply>|null=null,pendingIdentity='';
const notify=()=>{for(const listener of listeners)listener();};
function change(patch:Partial<Client>):void{value={...value,...patch};notify();}
export const catalogBackupClient={subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},snapshot:()=>value};
export function openCatalogBackup():void{change({open:true,error:'',...(hold?{}:{restoreOperationId:null})});}
export function closeCatalogBackup():void{if(!hold)change({open:false,error:''});}
function protectedKey(key:string):boolean{return (CATALOG_BACKUP_PENDING_KEYS as readonly string[]).includes(key)||key.startsWith('aural-playback-policy-pending-v2.invalid.');}
function installStorageFreeze():void{
 const storage=localStorage,set=Storage.prototype.setItem,remove=Storage.prototype.removeItem,clear=Storage.prototype.clear;
 removeHeldPending=key=>remove.call(storage,key);
 Storage.prototype.setItem=function(key:string,raw:string):void{if(this===storage&&hold&&protectedKey(String(key)))throw new Error('备份快照期间待核对资料已冻结，请稍后重试原操作');return set.call(this,key,raw);};
 Storage.prototype.removeItem=function(key:string):void{if(this===storage&&hold&&protectedKey(String(key)))throw new Error('备份快照期间保留原操作资料，请稍后重试核对');return remove.call(this,key);};
 Storage.prototype.clear=function():void{if(this===storage&&hold)throw new Error('曲库备份快照期间不能清空界面资料');return clear.call(this);};
}
function applyState(state:CatalogBackupState):void{
 hold=state.held?state.operationId:null;change({state,open:value.open||state.held||state.phase==='failed'});
}
export async function initializeCatalogBackupClient():Promise<void>{
 if(initialized)return;initialized=true;
 try{
  installStorageFreeze();let events=0,applyEvents=0;
  window.music.onEvent(event=>{
   if(event.event==='catalogRestoreApplyChanged'){applyEvents++;try{const state=readRestoreApplyState(event.payload);change({restoreApply:state,...(state.operationId?{restoreOperationId:state.operationId}:{}),...(restoreApplyActive(state)?{open:true}:{}),...(state.phase==='interrupted'?{open:true,error:state.message}:{})});}catch(error){change({error:String(error),open:true});}return;}
   if(event.event==='catalogRestoreApplication'){try{const request=readRestoreAppRequest(event.payload);if(hold!==request.operationId)throw new Error('恢复界面没有原维护占用');change({restoreOperationId:request.operationId});}catch(error){change({error:String(error),open:true});}return;}
   if(event.event==='catalogBackupChanged'){events++;try{applyState(readBackupState(event.payload));}catch(error){change({error:String(error),open:true});}return;}
   if(event.event==='catalogRestorePending'){
    try{const request=readRestorePendingRequest(event.payload);if(hold!==request.operationId||!lastAck?.pending||lastAck.operationId!==request.operationId||JSON.stringify(lastAck.pending)!==JSON.stringify(request.original))throw new Error('当前界面尚未确认原待保存资料冻结');change({restoreOperationId:request.operationId});
     const identity=JSON.stringify(request);if(pendingWork&&identity!==pendingIdentity)throw new Error('原恢复资料挑战不能改变内容');
     if(!pendingWork){pendingIdentity=identity;pendingWork=settleRendererRestorePending(request,key=>{if(hold!==request.operationId||!removeHeldPending||!protectedKey(key))throw new Error('界面资料冻结身份已变化');removeHeldPending(key);});}
     void pendingWork.then(reply=>window.music.catalogRestorePendingReply(reply)).catch(error=>change({error:String(error),open:true}));
    }catch(error){change({error:String(error),open:true});}return;
   }
   if(event.event==='catalogBackupThaw'){
    try{const v=event.payload as {operationId:unknown};const operationId=backupUuid(v.operationId);if(hold===operationId&&!value.state.held)hold=null;notify();}catch{/* Invalid events cannot release a current hold. */}return;
   }
   if(event.event!=='catalogBackupFreeze')return;
   try{
    const request=readBackupFreeze(event.payload);if(hold&&hold!==request.operationId)throw new Error('已有其他界面资料冻结');if(lastAck?.operationId!==request.operationId){pendingWork=null;pendingIdentity='';}hold=request.operationId;change({open:true,error:''});
    if(lastAck?.operationId!==request.operationId||lastAck.challenge!==request.challenge){
     try{lastAck={...request,pending:captureRendererBackupPending(),error:''};}catch(error){lastAck={...request,pending:null,error:String(error instanceof Error?error.message:error).slice(0,1024)||'界面资料无法冻结'};}
    }
    void window.music.catalogBackupFrozen(lastAck).catch(error=>{if(value.state.held&&!value.state.cancelRequested&&value.state.operationId===request.operationId)change({error:String(error),open:true});});
   }catch(error){change({error:String(error),open:true});}
  });
  const applyObserved=applyEvents,apply=readRestoreApplyState(await window.music.catalogRestoreApplyState());if(applyEvents===applyObserved)change({restoreApply:apply,...(apply.operationId?{restoreOperationId:apply.operationId}:{}),...(restoreApplyActive(apply)?{open:true}:{})});
  const observed=events,state=readBackupState(await window.music.catalogBackupState());if(events===observed){applyState(state);if(!['idle','completed','checked','failed','cancelled'].includes(state.phase))change({open:true});}
 }catch(error){hold='boot-unknown';change({open:true,error:'维护状态无法核对，请退出后重新打开应用：'+String(error),state:{...value.state,phase:'failed',operationId:crypto.randomUUID(),held:true,message:'当前界面尚未确认可以修改资料。'}});}
}
export async function startCatalogBackup():Promise<void>{
 change({error:'',open:true});try{await window.music.startCatalogBackup(crypto.randomUUID());}catch(error){change({error:String(error),open:true});}
}
export async function cancelCatalogBackup():Promise<void>{const operationId=restoreApplyActive(value.restoreApply)?value.restoreApply.operationId:value.state.operationId;if(!operationId)return;try{if(value.restoreOperationId===operationId)await window.music.cancelCatalogRestore(operationId);else await window.music.cancelCatalogBackup(operationId);}catch(error){change({error:String(error)});}}
export async function readCatalogBackupHistory():Promise<CatalogBackupHistory>{return readBackupHistory(await window.music.catalogBackupHistory());}
export async function verifyCatalogBackup(operationId:string):Promise<void>{change({error:'',open:true});try{await window.music.verifyCatalogBackup(backupUuid(operationId));}catch(error){change({error:String(error),open:true});}}
