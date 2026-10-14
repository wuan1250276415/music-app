import {validQueueState} from './queue-state.js';
import type {QueueState} from './contracts.js';
import {validateAudioOutputPreference,validateAudioOutputRequest} from './audio-output.js';
import {validateAsioOutputPreference,validateAsioOutputRequest} from './asio-output.js';
import {readAudioBackendPreference,readAudioBackendRequest} from './audio-backend.js';
import {readDsdOutputPreference,readDsdOutputRequest} from './dsd-output.js';
import {readAppearancePreference,readAppearanceRequest,ZOOM_PERCENTAGES} from './appearance.js';
import {readWindowPlacementPreference} from './window-placement.js';
import {readDesktopPreference} from './desktop-preference.js';
import {readMediaKeyPreference} from './media-key-preference.js';
import {readPlaybackPolicy,type PlaybackPolicySnapshot} from './playback-policy.js';
import {restoreTransactionFields as fields} from './catalog-restore-transaction.js';

export const RESTORE_STATE_BYTES=1024*1024;
export type RestoreStateSnapshot={version:1;queue:QueueState;audioOutput:ReturnType<typeof validateAudioOutputPreference>;asioOutput:ReturnType<typeof validateAsioOutputPreference>;audioBackend:ReturnType<typeof readAudioBackendPreference>;dsdOutput:ReturnType<typeof readDsdOutputPreference>;appearance:ReturnType<typeof readAppearancePreference>;windowPlacement:ReturnType<typeof readWindowPlacementPreference>;desktop:ReturnType<typeof readDesktopPreference>;mediaKeys:ReturnType<typeof readMediaKeyPreference>;historyPolicy:PlaybackPolicySnapshot|null};
export type RestoreMainPrior={snapshot:RestoreStateSnapshot;pending:{audioOutput:ReturnType<typeof validateAudioOutputRequest>|null;asioOutput:ReturnType<typeof validateAsioOutputRequest>|null;audioBackend:ReturnType<typeof readAudioBackendRequest>|null;dsdOutput:ReturnType<typeof readDsdOutputRequest>|null;appearance:ReturnType<typeof readAppearanceRequest>|null;desiredZoom:number|null}};
export const emptyRestoreQueue=():QueueState=>({entries:[],currentEntryId:null,repeat:'off',shuffle:false,order:[],orderCursor:-1,history:[],historyCursor:-1,revision:0});
function budget(value:unknown):void{if(new TextEncoder().encode(JSON.stringify(value)).length>RESTORE_STATE_BYTES)throw new Error('恢复使用状态超过预算');}
export function readRestoreStateSnapshot(value:unknown,allowMissingPolicy=false):RestoreStateSnapshot{
 budget(value);const v=fields(value,['version','queue','audioOutput','asioOutput','audioBackend','dsdOutput','appearance','windowPlacement','desktop','mediaKeys','historyPolicy']);
 if(v.version!==1||!validQueueState(v.queue)||v.historyPolicy===null&&!allowMissingPolicy)throw new Error('恢复队列或统计策略无效');
 return {version:1,queue:structuredClone(v.queue),audioOutput:validateAudioOutputPreference(v.audioOutput),asioOutput:validateAsioOutputPreference(v.asioOutput),audioBackend:readAudioBackendPreference(v.audioBackend),dsdOutput:readDsdOutputPreference(v.dsdOutput),appearance:readAppearancePreference(v.appearance),windowPlacement:readWindowPlacementPreference(v.windowPlacement),desktop:readDesktopPreference(v.desktop),mediaKeys:readMediaKeyPreference(v.mediaKeys),historyPolicy:v.historyPolicy===null?null:readPlaybackPolicy(v.historyPolicy)};
}
export function readRestoreMainPrior(value:unknown):RestoreMainPrior{
 budget(value);const v=fields(value,['snapshot','pending']),p=fields(v.pending,['audioOutput','asioOutput','audioBackend','dsdOutput','appearance','desiredZoom']);
 if(p.desiredZoom!==null&&(typeof p.desiredZoom!=='number'||!(ZOOM_PERCENTAGES as readonly number[]).includes(p.desiredZoom)))throw new Error('原缩放草稿无效');
 return {snapshot:readRestoreStateSnapshot(v.snapshot,true),pending:{audioOutput:p.audioOutput===null?null:validateAudioOutputRequest(p.audioOutput),asioOutput:p.asioOutput===null?null:validateAsioOutputRequest(p.asioOutput),audioBackend:p.audioBackend===null?null:readAudioBackendRequest(p.audioBackend),dsdOutput:p.dsdOutput===null?null:readDsdOutputRequest(p.dsdOutput),appearance:p.appearance===null?null:readAppearanceRequest(p.appearance),desiredZoom:p.desiredZoom}};
}
