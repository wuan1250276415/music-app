import {readPlaybackPolicy,playbackRuleThreshold,type PlaybackPolicySnapshot} from './playback-policy.js';
export const HISTORY_POLICY_VERSION=2;
export const HISTORY_MAX_US=315576000000000; // Ten years, safely representable by JS and SQLite.
export interface PlaybackHistoryCheckpoint {
 sessionId:string;entryId:string;itemId:string;title:string;artist:string;album:string;durationUs:number|null;
 policyVersion:1|2;policy?:PlaybackPolicySnapshot;checkpoint:number;presentedUs:number;estimatedUs:number;furthestUs:number;startedAt:string;
 observedAt?:string;
}
export interface HistoryCursor {ceiling:number;before:number;scope:string}
export interface PlaybackHistoryQuery {query?:string;itemId?:string;cursor?:HistoryCursor}
export interface PlaybackHistoryRow extends PlaybackHistoryCheckpoint {id:number;counted:boolean;updatedAt:string;available:boolean;timeBasis:'observation'|'legacy-start'}
export interface PlaybackHistoryPage {
 items:PlaybackHistoryRow[];nextCursor:HistoryCursor|null;
 totals:{sessions:number;plays:number;presentedUs:number;estimatedUs:number};
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const integer=(v:unknown,min=0,max=HISTORY_MAX_US):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f]/.test(v);
export const historyInstant=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function readHistoryCheckpoint(v:unknown):PlaybackHistoryCheckpoint {
 const fields=['sessionId','entryId','itemId','title','artist','album','durationUs','policyVersion','checkpoint','presentedUs','estimatedUs','furthestUs','startedAt'];
 if(!object(v)||Object.keys(v).length!==fields.length+(Object.hasOwn(v,'observedAt')?1:0)+(v.policyVersion===2?1:0)||fields.some(k=>!Object.hasOwn(v,k))||!uuid(v.sessionId)||!id(v.entryId)||!id(v.itemId)||v.policyVersion!==1&&v.policyVersion!==2||v.policyVersion===1&&Object.hasOwn(v,'policy')||v.policyVersion===2&&!Object.hasOwn(v,'policy')||!integer(v.checkpoint,1,Number.MAX_SAFE_INTEGER)||!integer(v.presentedUs)||!integer(v.estimatedUs)||!integer(v.furthestUs)||v.durationUs!==null&&!integer(v.durationUs,1)||!historyInstant(v.startedAt)||Object.hasOwn(v,'observedAt')&&!historyInstant(v.observedAt))throw new Error('播放历史检查点无效');
 for(const key of ['title','artist','album'])if(typeof v[key]!=='string'||(v[key] as string).length>2048||/[\u0000-\u001f]/.test(v[key] as string))throw new Error('播放历史曲目信息无效');
 if(v.policyVersion===2&&!historyInstant(v.observedAt))throw new Error('新版播放历史缺少观察时间');
 // Old 13-field journal payloads retain their exact canonical fingerprint.
 return {...Object.fromEntries(fields.map(key=>[key,v[key]])),...(v.policyVersion===2?{policy:readPlaybackPolicy(v.policy)}:{}),...(Object.hasOwn(v,'observedAt')?{observedAt:v.observedAt}:{})} as unknown as PlaybackHistoryCheckpoint;
}
export function readHistoryQuery(v:unknown):PlaybackHistoryQuery {
 if(!object(v)||Object.keys(v).some(k=>!['query','itemId','cursor'].includes(k))||v.query!==undefined&&(typeof v.query!=='string'||v.query.length>256)||v.itemId!==undefined&&!id(v.itemId))throw new Error('播放历史检索无效');
 const scope=JSON.stringify([(v.query as string|undefined)?.trim()??'',v.itemId??null]);
 if(v.cursor!==undefined&&(!validCursor(v.cursor)||v.cursor.scope!==scope))throw new Error('播放历史游标与检索范围不符');
 return {query:(v.query as string|undefined)?.trim()??'',...(v.itemId===undefined?{}:{itemId:v.itemId as string}),...(v.cursor===undefined?{}:{cursor:v.cursor as PlaybackHistoryQuery['cursor']})};
}
function validCursor(v:unknown):v is HistoryCursor{return object(v)&&Object.keys(v).length===3&&integer(v.ceiling,1,Number.MAX_SAFE_INTEGER)&&integer(v.before,1,Number.MAX_SAFE_INTEGER)&&(v.before as number)<=(v.ceiling as number)&&typeof v.scope==='string'&&v.scope.length<=1024;}
export function historyQualifies(c:PlaybackHistoryCheckpoint):boolean {
 if(c.policyVersion===2){
  if(!c.policy)throw new Error('播放记录缺少冻结统计规则');
  const rule=c.policy.rule;if(!rule.countEnabled)return false;
  const threshold=playbackRuleThreshold(c.durationUs,rule);return c.presentedUs>=threshold.us&&(!threshold.tail||c.furthestUs>=threshold.us);
 }
 const duration=c.durationUs,threshold=duration===null?240000000:duration<30000000?Math.ceil(duration*0.95):Math.min(Math.ceil(duration/2),240000000);
 return c.presentedUs>=threshold&&(duration===null||duration>=30000000||c.furthestUs>=threshold);
}
export function readHistoryPage(v:unknown):PlaybackHistoryPage {
 if(!object(v)||Object.keys(v).length!==3||!['items','nextCursor','totals'].every(k=>Object.hasOwn(v,k))||!Array.isArray(v.items)||v.items.length>50||!object(v.totals)||Object.keys(v.totals).length!==4||['sessions','plays','presentedUs','estimatedUs'].some(k=>!integer((v.totals as Record<string,unknown>)[k],0,Number.MAX_SAFE_INTEGER))||(v.totals.plays as number)>(v.totals.sessions as number))throw new Error('播放历史响应无效');
 const items=v.items.map(raw=>{
  if(!object(raw)||Object.keys(raw).length!==(raw.policyVersion===2?20:19)||!integer(raw.id,1,Number.MAX_SAFE_INTEGER)||typeof raw.counted!=='boolean'||typeof raw.available!=='boolean'||!historyInstant(raw.updatedAt)||!historyInstant(raw.observedAt)||typeof raw.timeBasis!=='string'||!['observation','legacy-start'].includes(raw.timeBasis))throw new Error('播放历史条目无效');
  const {id,counted,available,updatedAt,timeBasis,...checkpoint}=raw;return {...readHistoryCheckpoint(checkpoint),id,counted,available,updatedAt,timeBasis} as PlaybackHistoryRow;
 });
 if(v.nextCursor!==null&&!validCursor(v.nextCursor))throw new Error('播放历史响应游标无效');
 const cursor=v.nextCursor as HistoryCursor|null;
 if(items.some((item,i)=>i>0&&items[i-1].id<=item.id)||cursor&&(items.length!==50||cursor.before!==items[items.length-1].id||cursor.ceiling<items[0].id))throw new Error('播放历史页顺序或游标不符');
 return {items,nextCursor:cursor,totals:v.totals as unknown as PlaybackHistoryPage['totals']};
}
