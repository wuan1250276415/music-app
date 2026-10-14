export type FileLibraryState='active'|'removed'|'ignored';
export interface FilePolicyRequest{commandId:string;fileId:string;baseRevision:number;action:'remove'|'ignore'|'restore';observation:string|null}
export interface FilePolicyView{fileId:string;rootId:string;rootPath:string;relativePath:string;title:string;artist:string;revision:number;state:FileLibraryState;observation:string|null;itemCount:number;cueCount:number;favoriteCount:number;playlistCount:number;restorePending:boolean}
export interface FilePolicyResult{status:'saved'|'rejected';view:FilePolicyView|null;error:string}
export interface FilePolicyPage{items:FilePolicyView[];nextCursor:string|null;error:string}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function readFilePolicyRequest(value:unknown):FilePolicyRequest{
 const r=value as FilePolicyRequest;
 if(!r||Object.keys(r).length!==5||typeof r.commandId!=='string'||!uuid.test(r.commandId)||typeof r.fileId!=='string'||!uuid.test(r.fileId)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||!['remove','ignore','restore'].includes(r.action)||r.observation!==null&&(typeof r.observation!=='string'||!/^[0-9a-f]{64}$/.test(r.observation)))throw new Error('无效音乐文件管理操作');
 return {commandId:r.commandId,fileId:r.fileId,baseRevision:r.baseRevision,action:r.action,observation:r.observation};
}
