export type OnlineArtworkMode='fallback'|'preferred';
export type OnlineArtworkCommand={commandId:string;itemId:string;baseRevision:number}&(
 {action:'apply';previewUrl:string;mode:OnlineArtworkMode}|
 {action:'clear'}|{action:'mode';mode:OnlineArtworkMode}|{action:'undo';changeId:string}
);
export interface OnlineArtworkSource{
 id:string;assetId:string;sourceToken:string;releaseId:string;imageId:string;sourceUrl:string;fetchedAt:string;confirmedAt:string;width:number;height:number;
 rights:{status:'unverified';display:true;persist:true;export:false;writeback:false;basis:'user-selected-local-v1'};
}
export interface OnlineArtworkState{
 itemId:string;revision:number;mode:OnlineArtworkMode;source:OnlineArtworkSource|null;
 changes:Array<{id:string;action:'apply'|'clear'|'mode'|'undo';createdAt:string;canUndo:boolean}>;
}
export interface OnlineArtworkResult{changeId:string;replayed:boolean;state:OnlineArtworkState}
export const ONLINE_ARTWORK_RIGHTS={status:'unverified',display:true,persist:true,export:false,writeback:false,basis:'user-selected-local-v1'} as const;
export function readOnlineArtworkCommand(value:unknown):OnlineArtworkCommand{
 const v=value as OnlineArtworkCommand,uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
 if(!v||typeof v!=='object'||Array.isArray(v)||typeof v.commandId!=='string'||!uuid.test(v.commandId)||typeof v.itemId!=='string'||!v.itemId||v.itemId.length>128||v.itemId.includes('\0')||!Number.isSafeInteger(v.baseRevision)||v.baseRevision<0)throw new Error('无效在线封面操作');
 const base={commandId:v.commandId,itemId:v.itemId,baseRevision:v.baseRevision};
 if(v.action==='apply'&&Object.keys(v).length===6&&['fallback','preferred'].includes(v.mode)&&typeof v.previewUrl==='string'&&/^aural-artwork:\/\/preview\/[0-9a-f]{64}\.jpg$/.test(v.previewUrl))return {...base,action:'apply',previewUrl:v.previewUrl,mode:v.mode};
 if(v.action==='clear'&&Object.keys(v).length===4)return {...base,action:'clear'};
 if(v.action==='mode'&&Object.keys(v).length===5&&['fallback','preferred'].includes(v.mode))return {...base,action:'mode',mode:v.mode};
 if(v.action==='undo'&&Object.keys(v).length===5&&typeof v.changeId==='string'&&uuid.test(v.changeId))return {...base,action:'undo',changeId:v.changeId};
 throw new Error('无效在线封面操作');
}
