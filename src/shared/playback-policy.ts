export interface PlaybackCountingRule {
 version:2;countEnabled:boolean;percent:number;seconds:number;combine:'either'|'both';
 shortSeconds:number;shortPercent:number;shortRequireTail:boolean;
}
export interface PlaybackPolicySnapshot {revision:number;rule:PlaybackCountingRule}
export interface PlaybackPolicyRequest {commandId:string;baseRevision:number;rule:PlaybackCountingRule}
export interface PlaybackPolicyResult {commandId:string;status:'saved'|'rejected';value:PlaybackPolicySnapshot|null;error:string}

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fields(v:unknown,keys:string[]):Record<string,unknown>{
 if(!object(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new Error('播放统计规则字段无效');return v;
}
function integer(v:unknown,min:number,max:number):number{
 if(typeof v!=='number'||!Number.isSafeInteger(v)||v<min||v>max)throw new Error('播放统计规则数值超出范围');return v;
}
function command(v:unknown):string{
 if(typeof v!=='string'||!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v))throw new Error('播放统计操作身份无效');return v;
}
export const defaultPlaybackRule=():PlaybackCountingRule=>({version:2,countEnabled:true,percent:50,seconds:240,combine:'either',shortSeconds:30,shortPercent:95,shortRequireTail:true});
export function readPlaybackRule(value:unknown):PlaybackCountingRule{
 const v=fields(value,['version','countEnabled','percent','seconds','combine','shortSeconds','shortPercent','shortRequireTail']);
 if(v.version!==2||typeof v.countEnabled!=='boolean'||typeof v.shortRequireTail!=='boolean'||v.combine!=='either'&&v.combine!=='both')throw new Error('播放统计规则版本或选项无效');
 return {version:2,countEnabled:v.countEnabled,percent:integer(v.percent,1,100),seconds:integer(v.seconds,1,3600),combine:v.combine,shortSeconds:integer(v.shortSeconds,0,300),shortPercent:integer(v.shortPercent,1,100),shortRequireTail:v.shortRequireTail};
}
export function readPlaybackPolicy(value:unknown):PlaybackPolicySnapshot{
 const v=fields(value,['revision','rule']);return {revision:integer(v.revision,0,Number.MAX_SAFE_INTEGER-1),rule:readPlaybackRule(v.rule)};
}
export function readPlaybackPolicyRequest(value:unknown):PlaybackPolicyRequest{
 const v=fields(value,['commandId','baseRevision','rule']);return {commandId:command(v.commandId),baseRevision:integer(v.baseRevision,0,Number.MAX_SAFE_INTEGER-2),rule:readPlaybackRule(v.rule)};
}
export function readPlaybackPolicyResult(value:unknown):PlaybackPolicyResult{
 const v=fields(value,['commandId','status','value','error']);
 if(v.status!=='saved'&&v.status!=='rejected'||typeof v.error!=='string'||v.error.length>512||v.status==='saved'&&(v.value===null||v.error!=='')||v.status==='rejected'&&(v.value!==null||!v.error))throw new Error('播放统计规则回执无效');
 return {commandId:command(v.commandId),status:v.status,value:v.value===null?null:readPlaybackPolicy(v.value),error:v.error};
}
export function matchesPlaybackPolicy(value:PlaybackPolicySnapshot,request:PlaybackPolicyRequest):boolean{
 return value.revision===request.baseRevision+1&&JSON.stringify(value.rule)===JSON.stringify(request.rule);
}
export function playbackRuleThreshold(durationUs:number|null,rule:PlaybackCountingRule):{us:number;tail:boolean}{
 if(durationUs===null)return {us:rule.seconds*1000000,tail:false};
 const percent=(v:number)=>Number((BigInt(durationUs)*BigInt(v)+99n)/100n);
 if(durationUs<rule.shortSeconds*1000000)return {us:percent(rule.shortPercent),tail:rule.shortRequireTail};
 const ratio=percent(rule.percent),seconds=rule.seconds*1000000;
 return {us:rule.combine==='either'?Math.min(ratio,seconds):Math.max(ratio,seconds),tail:false};
}
export function playbackRuleSummary(rule:PlaybackCountingRule):string{
 const normal=`曲长的 ${rule.percent}% ${rule.combine==='either'?'或':'且'} ${rule.seconds} 秒${rule.combine==='either'?'（取较短者）':'（两项均达到）'}`;
 const short=rule.shortSeconds?`不足 ${rule.shortSeconds} 秒的歌曲需达到 ${rule.shortPercent}%${rule.shortRequireTail?'且进度到达该位置':''}；`:'';
 return `${rule.countEnabled?`达标条件：${normal}；${short}未知曲长按 ${rule.seconds} 秒。`:'不增加达标次数，仍保存历史与时长。'}只使用设备或驱动回报的进度，估算时长单独显示。`;
}
