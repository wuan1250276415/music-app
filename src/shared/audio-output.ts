import type {AudioOutputRequest,AudioOutputPreference} from './contracts.js';
import {defaultProcessing,validateProcessing,processingEnabled} from './audio-processing.js';
export const validEndpoint=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\u0000-\u001f\u007f]/.test(value);
export function validateAudioOutputRequest(value:unknown):AudioOutputRequest{
 const r=value as AudioOutputRequest;
 if(!r||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.deviceId!==null&&!validEndpoint(r.deviceId)||!['shared','exclusive','exclusive-convert'].includes(r.mode)||!['stop','pcm'].includes(r.dsdPolicy))throw new Error('无效输出设备设置');
 const processing=validateProcessing(r.processing===undefined?defaultProcessing():r.processing);
 if(r.mode==='exclusive'&&processingEnabled(processing))throw new Error('原始格式独占模式不允许数字音量、静音或 ReplayGain，请选择共享或允许转换的独占模式');
 return {commandId:r.commandId,baseRevision:r.baseRevision,deviceId:r.deviceId,mode:r.mode,dsdPolicy:r.dsdPolicy,processing};
}
export function validateAudioOutputPreference(value:unknown):AudioOutputPreference{
 const p=value as AudioOutputPreference;
 if(!p||p.backend!=='wasapi'||!Number.isSafeInteger(p.revision)||p.revision<0||p.deviceId!==null&&!validEndpoint(p.deviceId)||p.deviceName!==null&&(typeof p.deviceName!=='string'||!p.deviceName||p.deviceName.length>255||/[\u0000-\u001f\u007f]/.test(p.deviceName))||p.deviceId===null&&p.deviceName!==null||!['shared','exclusive','exclusive-convert'].includes(p.mode)||!['stop','pcm'].includes(p.dsdPolicy))throw new Error('保存的输出设置无效');
 const processing=validateProcessing(p.processing===undefined?defaultProcessing():p.processing);
 if(p.mode==='exclusive'&&processingEnabled(processing))throw new Error('保存的原始格式模式与音频处理设置冲突');
 return {revision:p.revision,backend:'wasapi',deviceId:p.deviceId,deviceName:p.deviceName,mode:p.mode,dsdPolicy:p.dsdPolicy,processing};
}
export const defaultAudioOutput=():AudioOutputPreference=>({revision:0,backend:'wasapi',deviceId:null,deviceName:null,mode:'shared',dsdPolicy:'stop',processing:defaultProcessing()});
