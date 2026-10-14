import {validateAsioDriverKey,validateAsioDriverIdentity,sameAsioDriver,type AsioDriverKey,type AsioDriverIdentity} from './asio-output.js';
export type AsioPanelPhase='idle'|'opening'|'calling'|'returned'|'finishing'|'closed'|'failed'|'cancelled'|'release-unknown';
export interface AsioPanelRequest {commandId:string;driver:AsioDriverKey}
export interface AsioPanelState {revision:number;operationId:string|null;driver:AsioDriverIdentity|null;phase:AsioPanelPhase;message:string;observedAt:number;processReleased:boolean;driverReleased:boolean;hardwareVerified:false}
export interface AsioPanelReply {sequence:number;identity:AsioDriverIdentity;phase:'calling'|'returned'|'closed'|'failed';message:string;driverReleased:boolean;buffersCreated:false;playbackStarted:false;hardwareVerified:false}
export const asioPanelActive=(s:AsioPanelState):boolean=>!s.processReleased;
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const object=(v:unknown,names:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
export function readAsioPanelRequest(value:unknown):AsioPanelRequest{
 if(!object(value,['commandId','driver'])||typeof value.commandId!=='string'||!uuid.test(value.commandId))throw new Error('ASIO 面板操作身份无效');return {commandId:value.commandId,driver:validateAsioDriverKey(value.driver)};
}
export function readAsioPanelOperation(value:unknown):string{if(typeof value!=='string'||!uuid.test(value))throw new Error('ASIO 面板会话身份无效');return value;}
export function readAsioPanelReply(value:unknown,driver:AsioDriverKey,previousSequence:number):AsioPanelReply{
 if(!object(value,['sequence','identity','phase','message','driverReleased','buffersCreated','playbackStarted','hardwareVerified'])||!Number.isSafeInteger(value.sequence)||value.sequence!==previousSequence+1||!['calling','returned','closed','failed'].includes(String(value.phase))||typeof value.message!=='string'||!value.message||value.message.length>512||/[\u0000-\u001f\u007f]/.test(value.message)||typeof value.driverReleased!=='boolean'||value.driverReleased!==(value.phase==='closed'||value.phase==='failed')||value.buffersCreated!==false||value.playbackStarted!==false||value.hardwareVerified!==false)throw new Error('ASIO 面板阶段回执无效');
 const identity=validateAsioDriverIdentity(value.identity);if(!sameAsioDriver(identity,driver))throw new Error('ASIO 面板来自其他驱动');return {...value,identity} as unknown as AsioPanelReply;
}
