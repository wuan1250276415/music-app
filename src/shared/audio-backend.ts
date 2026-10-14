import type {AudioProcessing} from './contracts.js';
import {defaultProcessing,validateProcessing} from './audio-processing.js';
export interface AudioBackendPreference {revision:number;backend:'wasapi'|'asio';asioProcessing:AudioProcessing;asioDsdPolicy:'stop'|'pcm'}
export interface AudioBackendRequest {commandId:string;baseRevision:number;backend:'wasapi'|'asio';asioProcessing:AudioProcessing;asioDsdPolicy:'stop'|'pcm'}
export interface AudioBackendView {preference:AudioBackendPreference;pendingRequest:AudioBackendRequest|null}
export interface AudioBackendResult {status:'saved'|'rejected'|'unknown';view:AudioBackendView;error:string}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function fields(v:unknown,names:string[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==names.length||names.some(k=>!Object.hasOwn(v,k)))throw new Error('音频后端设置字段无效');return v as Record<string,unknown>;
}
function content(v:Record<string,unknown>):Pick<AudioBackendPreference,'backend'|'asioProcessing'|'asioDsdPolicy'>{
 if(!['wasapi','asio'].includes(String(v.backend))||!['stop','pcm'].includes(String(v.asioDsdPolicy)))throw new Error('音频后端或 ASIO DSD 策略无效');
 return {backend:v.backend as 'wasapi'|'asio',asioProcessing:validateProcessing(v.asioProcessing),asioDsdPolicy:v.asioDsdPolicy as 'stop'|'pcm'};
}
export const defaultAudioBackend=():AudioBackendPreference=>({revision:0,backend:'wasapi',asioProcessing:defaultProcessing(),asioDsdPolicy:'stop'});
export function readAudioBackendPreference(value:unknown):AudioBackendPreference{
 const v=fields(value,['revision','backend','asioProcessing','asioDsdPolicy']);if(!Number.isSafeInteger(v.revision)||(v.revision as number)<0)throw new Error('音频后端修订无效');return {revision:v.revision as number,...content(v)};
}
export function readAudioBackendRequest(value:unknown):AudioBackendRequest{
 const v=fields(value,['commandId','baseRevision','backend','asioProcessing','asioDsdPolicy']);if(typeof v.commandId!=='string'||!uuid.test(v.commandId)||!Number.isSafeInteger(v.baseRevision)||(v.baseRevision as number)<0)throw new Error('音频后端操作身份无效');return {commandId:v.commandId,baseRevision:v.baseRevision as number,...content(v)};
}
export function matchesAudioBackendRequest(p:AudioBackendPreference,r:AudioBackendRequest):boolean{return p.revision===r.baseRevision+1&&p.backend===r.backend&&p.asioDsdPolicy===r.asioDsdPolicy&&JSON.stringify(p.asioProcessing)===JSON.stringify(r.asioProcessing);}
