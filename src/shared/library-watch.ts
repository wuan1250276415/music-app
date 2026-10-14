export const WATCH_PERIODS=[0,15,30,60] as const;
export type WatchAction='enable'|'disable'|'retry'|'confirm';
export type WatchStatus='disabled'|'starting'|'watching'|'pending'|'scanning'|'waiting'|'offline'|'error'|'paused'|'capacity';
export interface LibraryWatchRequest {commandId:string;rootId:string;revision:number;action:WatchAction;periodicMinutes:number}
export interface LibraryWatchRoot {rootId:string;path:string;revision:number;enabled:boolean;periodicMinutes:number;status:WatchStatus;message:string;pending:boolean;jobId:string|null;lastSuccessAt:number|null}
export interface LibraryWatchState {version:1;session:string;revision:number;capacity:number;roots:LibraryWatchRoot[];suspended:boolean;error:string}
export interface LibraryWatchResult {status:'saved'|'rejected';state:LibraryWatchState;error:string}
export interface WatchAnchor {realPath:string;dev:string;ino:string}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function readLibraryWatchRequest(value:unknown):LibraryWatchRequest{
 const r=value as LibraryWatchRequest;
 if(!r||typeof r!=='object'||Object.keys(r).length!==6||typeof r.commandId!=='string'||!uuid.test(r.commandId)||typeof r.rootId!=='string'||!r.rootId||r.rootId.length>128||r.rootId.includes('\0')||!Number.isSafeInteger(r.revision)||r.revision<0||!['enable','disable','retry','confirm'].includes(r.action)||!WATCH_PERIODS.includes(r.periodicMinutes as typeof WATCH_PERIODS[number]))throw new Error('自动更新操作无效');
 return {commandId:r.commandId,rootId:r.rootId,revision:r.revision,action:r.action,periodicMinutes:r.periodicMinutes};
}
export function readLibraryWatchState(value:unknown):LibraryWatchState{
 const s=value as LibraryWatchState;
 const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!v.includes('\0');
 if(!s||Object.keys(s).length!==7||s.version!==1||typeof s.session!=='string'||!uuid.test(s.session)||!Number.isSafeInteger(s.revision)||s.revision<0||s.capacity!==64||typeof s.suspended!=='boolean'||!text(s.error,512)||!Array.isArray(s.roots)||s.roots.length>128)throw new Error('自动更新状态无效');
 const ids=new Set<string>();
 for(const r of s.roots){if(!r||Object.keys(r).length!==10||!text(r.rootId,128)||!r.rootId||ids.has(r.rootId)||!text(r.path,32768)||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.enabled!=='boolean'||!WATCH_PERIODS.includes(r.periodicMinutes as typeof WATCH_PERIODS[number])||!['disabled','starting','watching','pending','scanning','waiting','offline','error','paused','capacity'].includes(r.status)||!text(r.message,512)||typeof r.pending!=='boolean'||r.jobId!==null&&(typeof r.jobId!=='string'||!uuid.test(r.jobId))||r.lastSuccessAt!==null&&(!Number.isSafeInteger(r.lastSuccessAt)||r.lastSuccessAt<0))throw new Error('目录自动更新状态无效');ids.add(r.rootId);}
 return {...s,roots:s.roots.map(r=>({...r}))};
}
