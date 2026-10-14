import {readDopAuthorization,type DopAuthorization} from './asio-dsd.js';
export type DsdOutputMode='inherit'|'stop'|'pcm'|'native-dsd'|'dop';
export interface DopDeviceProfile extends DopAuthorization {archived:boolean}
export interface DsdOutputPreference {revision:number;mode:DsdOutputMode;selectedProfileId:string|null;profiles:DopDeviceProfile[]}
type Command={commandId:string;baseRevision:number};
export type DsdOutputRequest=Command&(
 {action:'configure';mode:DsdOutputMode;selectedProfileId:string|null}|
 {action:'save-profile';profile:DopAuthorization}|
 {action:'archive-profile';profileId:string;profileRevision:number;archived:boolean}
);
export interface DsdOutputView {preference:DsdOutputPreference;pendingRequest:DsdOutputRequest|null;playbackIntegration:'raw-dsd'}
export interface DsdOutputResult {status:'saved'|'rejected'|'unknown';view:DsdOutputView;error:string}
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const int=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0;
const mode=(v:unknown):v is DsdOutputMode=>typeof v==='string'&&['inherit','stop','pcm','native-dsd','dop'].includes(v);
const id=(v:unknown):v is string=>typeof v==='string'&&uuid.test(v);
function fields(value:unknown,names:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==names.length||names.some(name=>!Object.hasOwn(value,name)))throw new Error('DSD 设置字段无效');return value as Record<string,unknown>;
}
export const defaultDsdOutput=():DsdOutputPreference=>({revision:0,mode:'inherit',selectedProfileId:null,profiles:[]});
export function readDopDeviceProfile(value:unknown):DopDeviceProfile {
 const v=fields(value,['kind','profileId','revision','driver','driverVersion','dacName','supportedBitRates','outputChannels','evidenceText','documentConfirmed','volumeConfirmed','hardwareVerified','archived']);
 if(typeof v.archived!=='boolean')throw new Error('DoP 档案归档状态无效');const {archived,...auth}=v;const profile=readDopAuthorization(auth);
 if(profile.revision===0)throw new Error('保存的 DoP 档案缺少修订');return {...profile,archived};
}
export function readDsdOutputPreference(value:unknown):DsdOutputPreference {
 const v=fields(value,['revision','mode','selectedProfileId','profiles']);
 if(!int(v.revision)||!mode(v.mode)||(v.selectedProfileId!==null&&!id(v.selectedProfileId))||!Array.isArray(v.profiles)||v.profiles.length>32)throw new Error('DSD 设置内容无效');
 const profiles=v.profiles.map(readDopDeviceProfile),selected=v.selectedProfileId===null?null:(v.selectedProfileId as string).toLowerCase();
 if(new Set(profiles.map(p=>p.profileId)).size!==profiles.length||selected!==null&&!profiles.some(p=>p.profileId===selected&&!p.archived)||v.mode==='dop'&&selected===null)throw new Error('DoP 选用档案不存在、已归档或重复');
 return {revision:v.revision,mode:v.mode,selectedProfileId:selected,profiles};
}
export function readDsdOutputRequest(value:unknown):DsdOutputRequest {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('DSD 设置操作无效');const action=(value as {action:unknown}).action;
 const names=action==='configure'?['commandId','baseRevision','action','mode','selectedProfileId']:action==='save-profile'?['commandId','baseRevision','action','profile']:action==='archive-profile'?['commandId','baseRevision','action','profileId','profileRevision','archived']:[];
 if(!names.length)throw new Error('DSD 设置操作类型无效');const v=fields(value,names);
 if(!id(v.commandId)||!int(v.baseRevision))throw new Error('DSD 设置操作身份无效');const common={commandId:v.commandId.toLowerCase(),baseRevision:v.baseRevision};
 if(action==='save-profile')return {...common,action,profile:readDopAuthorization(v.profile)};
 if(action==='archive-profile'){
  if(!id(v.profileId)||!int(v.profileRevision)||v.profileRevision===0||typeof v.archived!=='boolean')throw new Error('DoP 档案归档操作无效');
  return {...common,action,profileId:v.profileId.toLowerCase(),profileRevision:v.profileRevision,archived:v.archived};
 }
 if(!mode(v.mode)||v.selectedProfileId!==null&&!id(v.selectedProfileId)||v.mode==='dop'&&v.selectedProfileId===null)throw new Error('DSD 输出方式或档案选择无效');
 return {...common,action:'configure',mode:v.mode,selectedProfileId:v.selectedProfileId===null?null:(v.selectedProfileId as string).toLowerCase()};
}
export function nextDsdOutput(preference:unknown,request:unknown):DsdOutputPreference {
 const p=readDsdOutputPreference(preference),r=readDsdOutputRequest(request);
 if(p.revision!==r.baseRevision)throw new Error('DSD 设置已变化，请重新读取');if(p.revision>=Number.MAX_SAFE_INTEGER)throw new Error('DSD 设置修订达到上限');
 const next={...structuredClone(p),revision:p.revision+1};
 if(r.action==='configure'){next.mode=r.mode;next.selectedProfileId=r.selectedProfileId;}
 else if(r.action==='save-profile'){
  const index=next.profiles.findIndex(profile=>profile.profileId===r.profile.profileId),old=next.profiles[index];
  if(old?.archived)throw new Error('请先恢复归档的设备档案再编辑');
  if(r.profile.revision!==(old?.revision??0))throw new Error('DoP 档案修订已变化，请重新读取');
  if(r.profile.revision>=Number.MAX_SAFE_INTEGER)throw new Error('DoP 档案修订达到上限');
  const profile={...r.profile,revision:r.profile.revision+1,archived:false};
  if(index<0){if(next.profiles.length>=32)throw new Error('设备档案已达到 32 个上限，归档记录已保留');next.profiles.push(profile);}else next.profiles[index]=profile;
 }else{
  const profile=next.profiles.find(profile=>profile.profileId===r.profileId);
  if(!profile||profile.revision!==r.profileRevision)throw new Error('DoP 档案已变化，请重新读取');
  if(profile.revision>=Number.MAX_SAFE_INTEGER)throw new Error('DoP 档案修订达到上限');profile.archived=r.archived;profile.revision++;
  if(r.archived&&next.selectedProfileId===profile.profileId){next.selectedProfileId=null;if(next.mode==='dop')next.mode='stop';}
 }
 return readDsdOutputPreference(next);
}
export function selectedDopAuthorization(preference:unknown):DopAuthorization|null {
 const p=readDsdOutputPreference(preference),profile=p.profiles.find(entry=>entry.profileId===p.selectedProfileId&&!entry.archived);
 if(!profile)return null;const {archived,...auth}=profile;return readDopAuthorization(auth);
}
export function dsdOutputAffectsPlayback(before:unknown,after:unknown):boolean {
 const a=readDsdOutputPreference(before),b=readDsdOutputPreference(after);if(a.mode!==b.mode)return true;
 return a.mode==='dop'&&JSON.stringify(selectedDopAuthorization(a))!==JSON.stringify(selectedDopAuthorization(b));
}
