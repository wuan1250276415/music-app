export const RESTORE_RECOVERY_REPORT_BYTES=512*1024;
export type RestoreRecoveryFailure={kind:'completed-library-startup';completionId:string;stage:'fork'|'initialize'|'receipt';detectedAt:string;message:string};
export type RestoreRecoveryRestartRequest={version:1;observedSha256:string;openExistingLibrary:true};
export function readRestoreRecoveryRestartRequest(value:unknown):RestoreRecoveryRestartRequest{
 const v=fields(value,['version','observedSha256','openExistingLibrary']);if(v.version!==1||v.openExistingLibrary!==true||typeof v.observedSha256!=='string'||! /^[a-f0-9]{64}$/.test(v.observedSha256))throw new Error('重新启动确认无效');return {version:1,observedSha256:v.observedSha256,openExistingLibrary:true};
}
export type RestoreRecoveryRecord={version:1|2;sourceId:string;records:number;lastKind:string|null;acceptedAt:string|null;completed:boolean};
export type RestoreRecoveryTransaction={transactionId:string;opening:'blocked'|'original-before-cutover'|'pre-cutover-retained'|'completed-current'|'completed-retained';error:string|null;record:RestoreRecoveryRecord|null;slots:Array<{slot:'live'|'candidate'|'original'|'retired-candidate';identity:string|null}>;moves:Array<{operationId:string;action:'retire-original'|'install-candidate'|'retire-candidate'|'restore-original';stages:number;recordedExit:boolean;namespace:'before'|'after'|'source-reoccupied'|'conflict'}>};
export type RestoreRecoveryState={version:2;active:boolean;phase:'normal'|'blocked'|'checking'|'reviewed'|'restarting';observedAt:string|null;namespaceReady:boolean;restartReady:boolean;notice:string;failure:RestoreRecoveryFailure|null;transactions:RestoreRecoveryTransaction[]};
export const normalRestoreRecoveryState:RestoreRecoveryState={version:2,active:false,phase:'normal',observedAt:null,namespaceReady:false,restartReady:false,notice:'',failure:null,transactions:[]};
function fields(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('恢复启动核对字段无效');return value as Record<string,unknown>;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error('恢复启动核对文字无效');return value;}
function choice<T extends string>(value:unknown,choices:readonly T[]):T{if(typeof value!=='string'||!choices.includes(value as T))throw new Error('恢复启动核对状态无效');return value as T;}
function count(value:unknown,max:number):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>max)throw new Error('恢复启动核对数量超过预算');return value;}
function date(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new Error('恢复启动核对时间无效');return value;}
function uuid(value:unknown):string{const s=text(value,36);if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(s))throw new Error('恢复启动核对操作身份无效');return s;}
function identity(value:unknown):string|null{if(value===null)return null;const s=text(value,256);if(!/^\d+:\d+:-?\d+$/.test(s))throw new Error('恢复启动核对目录身份无效');return s;}
export function readRestoreRecoveryState(value:unknown):RestoreRecoveryState{
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>RESTORE_RECOVERY_REPORT_BYTES)throw new Error('恢复启动核对报告超过512KiB');
 const v=fields(value,['version','active','phase','observedAt','namespaceReady','restartReady','notice','failure','transactions']);
 if(v.version!==2||typeof v.active!=='boolean'||typeof v.namespaceReady!=='boolean'||typeof v.restartReady!=='boolean'||typeof v.notice!=='string'||v.notice.length>1024||!Array.isArray(v.transactions)||v.transactions.length>64)throw new Error('恢复启动核对范围无效');
 const phase=choice(v.phase,['normal','blocked','checking','reviewed','restarting'] as const),observedAt=v.observedAt===null?null:date(v.observedAt),seen=new Set<string>();
 const transactions=v.transactions.map(raw=>{
  const t=fields(raw,['transactionId','opening','error','record','slots','moves']),transactionId=text(t.transactionId,256);if(seen.has(transactionId)||!Array.isArray(t.slots)||t.slots.length>4||!Array.isArray(t.moves)||t.moves.length>16)throw new Error('恢复启动核对事务重复或超过预算');seen.add(transactionId);
  const opening=choice(t.opening,['blocked','original-before-cutover','pre-cutover-retained','completed-current','completed-retained'] as const),error=t.error===null?null:text(t.error,512),slotsSeen=new Set<string>(),movesSeen=new Set<string>();
  const slots=t.slots.map(raw=>{const s=fields(raw,['slot','identity']),slot=choice(s.slot,['live','candidate','original','retired-candidate'] as const);if(slotsSeen.has(slot))throw new Error('恢复启动核对目录槽位重复');slotsSeen.add(slot);return {slot,identity:identity(s.identity)};});
  const moves=t.moves.map(raw=>{const m=fields(raw,['operationId','action','stages','recordedExit','namespace']),operationId=uuid(m.operationId);if(movesSeen.has(operationId)||typeof m.recordedExit!=='boolean')throw new Error('恢复启动核对切换记录重复或无效');movesSeen.add(operationId);return {operationId,action:choice(m.action,['retire-original','install-candidate','retire-candidate','restore-original'] as const),stages:count(m.stages,4),recordedExit:m.recordedExit,namespace:choice(m.namespace,['before','after','source-reoccupied','conflict'] as const)};});
  let record:RestoreRecoveryRecord|null=null;if(t.record!==null){const r=fields(t.record,['version','sourceId','records','lastKind','acceptedAt','completed']);if(r.version!==1&&r.version!==2||typeof r.completed!=='boolean')throw new Error('恢复启动核对事务版本无效');const lastKind=r.lastKind===null?null:text(r.lastKind,64);if(lastKind!==null&&!/^[a-z][a-z-]*$/.test(lastKind))throw new Error('恢复启动核对记录类型无效');record={version:r.version,sourceId:uuid(r.sourceId),records:count(r.records,48),lastKind,acceptedAt:r.acceptedAt===null?null:date(r.acceptedAt),completed:r.completed};}
  return {transactionId,opening,error,record,slots,moves};
 });
 let failure:RestoreRecoveryFailure|null=null;if(v.failure!==null){const f=fields(v.failure,['kind','completionId','stage','detectedAt','message']);if(f.kind!=='completed-library-startup')throw new Error('曲库启动失败类别无效');failure={kind:f.kind,completionId:uuid(f.completionId),stage:choice(f.stage,['fork','initialize','receipt'] as const),detectedAt:date(f.detectedAt),message:text(f.message,1024)};}
 if(!v.active?(phase!=='normal'||observedAt!==null||v.namespaceReady||v.restartReady||v.notice!==''||failure!==null||transactions.length!==0):(phase==='normal'||observedAt===null))throw new Error('恢复启动核对模式不符');
 if(v.namespaceReady&&(phase!=='reviewed'||transactions.some(t=>t.error!==null||t.opening==='blocked')))throw new Error('恢复启动核对不能把未确认目录当作通过');
 if(v.restartReady&&(!v.namespaceReady||phase!=='reviewed'||!transactions.some(t=>t.opening==='completed-current'&&t.record?.completed)))throw new Error('重新启动需要当前已完成曲库的独立核对');
 return {version:2,active:v.active,phase,observedAt,namespaceReady:v.namespaceReady,restartReady:v.restartReady,notice:v.notice,failure,transactions};
}
