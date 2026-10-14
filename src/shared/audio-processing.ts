import type {AudioProcessing,ReplayGainTags,ProcessingPlan,OpusGainInfo} from './contracts.js';
export const defaultProcessing=():AudioProcessing=>({volumeDb:0,muted:false,replayGain:'off',preampDb:0,preventClipping:true,opusPolicy:'r128',opusTargetLUFS:-23});
export const emptyReplayGain=(source:ReplayGainTags['source']='file-tags'):ReplayGainTags=>({source,trackGainDb:null,albumGainDb:null,trackPeak:null,albumPeak:null});
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const finite=(v:unknown,min:number,max:number)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const integer=(v:unknown,min:number,max:number)=>finite(v,min,max)&&Number.isSafeInteger(v);
export function validateProcessing(value:unknown):AudioProcessing{
 if(!record(value))throw new Error('无效音量或 ReplayGain 设置');
 // Immutable pre-v38 preferences/receipts retain their original bytes; normalize only when reading.
 const historical=Object.keys(value).length===5&&!('opusPolicy' in value)&&!('opusTargetLUFS' in value);
 const v=historical?{...value,opusPolicy:'r128',opusTargetLUFS:-23}:value;
 if(Object.keys(v).length!==7||!finite(v.volumeDb,-60,0)||typeof v.muted!=='boolean'||!['off','track','album'].includes(String(v.replayGain))||!finite(v.preampDb,-12,12)||typeof v.preventClipping!=='boolean'||!['r128','header-only','legacy-before-header','legacy-after-header'].includes(String(v.opusPolicy))||![-23,-18].includes(Number(v.opusTargetLUFS))||typeof v.opusTargetLUFS!=='number')throw new Error('无效音量或 ReplayGain 设置');
 return {volumeDb:Number(v.volumeDb),muted:v.muted,replayGain:v.replayGain as AudioProcessing['replayGain'],preampDb:Number(v.preampDb),preventClipping:v.preventClipping,opusPolicy:v.opusPolicy as AudioProcessing['opusPolicy'],opusTargetLUFS:v.opusTargetLUFS as -23|-18};
}
export function validateReplayGain(value:unknown):ReplayGainTags{
 if(!record(value)||Object.keys(value).length!==5||!['file-tags','cue'].includes(String(value.source)))throw new Error('无效 ReplayGain 标签');
 for(const field of ['trackGainDb','albumGainDb'])if(value[field]!==null&&!finite(value[field],-60,60))throw new Error('ReplayGain 增益超出范围');
 for(const field of ['trackPeak','albumPeak'])if(value[field]!==null&&(!finite(value[field],0,64)||value[field]===0))throw new Error('ReplayGain 峰值超出范围');
 return {source:value.source as ReplayGainTags['source'],trackGainDb:value.trackGainDb as number|null,albumGainDb:value.albumGainDb as number|null,trackPeak:value.trackPeak as number|null,albumPeak:value.albumPeak as number|null};
}
export function validateOpusGain(value:unknown):OpusGainInfo{
 if(!record(value)||Object.keys(value).length!==17||value.version!==1||!integer(value.headerGainQ78,-32768,32767)||value.decoder!=='ffmpeg-native-opus'||value.headerApplied!==true||value.referenceLUFS!==-23||value.packetValidation!=='ogg-crc-and-opushead-match'||value.hardwareVerified!==false||typeof value.legacyPresent!=='boolean'||!integer(value.streamIndex,0,15)||!integer(value.streamSerial,0,4294967295)||!integer(value.pageCount,1,4096)||!integer(value.tagBytes,16,16*1024*1024))throw new Error('Opus 增益来源回执无效');
 for(const part of ['Track','Album']){const status=value[`r128${part}Status`],gain=value[`r128${part}Q78`];if(!['missing','valid','invalid'].includes(String(status))||(status==='valid'?!integer(gain,-32768,32767):gain!==null))throw new Error('Opus R128 标签回执无效');}
 const legacyTags=validateReplayGain(value.legacyTags);if(legacyTags.source!=='file-tags'||!value.legacyPresent&&Object.values(legacyTags).slice(1).some(v=>v!==null))throw new Error('Opus 传统增益来源无效');
 return {version:1,headerGainQ78:Number(value.headerGainQ78),r128TrackQ78:value.r128TrackQ78 as number|null,r128AlbumQ78:value.r128AlbumQ78 as number|null,r128TrackStatus:value.r128TrackStatus as OpusGainInfo['r128TrackStatus'],r128AlbumStatus:value.r128AlbumStatus as OpusGainInfo['r128AlbumStatus'],legacyTags,legacyPresent:value.legacyPresent,decoder:'ffmpeg-native-opus',headerApplied:true,referenceLUFS:-23,packetValidation:'ogg-crc-and-opushead-match',streamIndex:Number(value.streamIndex),streamSerial:Number(value.streamSerial),pageCount:Number(value.pageCount),tagBytes:Number(value.tagBytes),hardwareVerified:false};
}
export function processingEnabled(settings:AudioProcessing):boolean{return settings.volumeDb!==0||settings.muted||settings.replayGain!=='off';}
export function processingPlan(value:AudioProcessing,raw:ReplayGainTags|null,opus:OpusGainInfo|null=null):ProcessingPlan{
 const settings=validateProcessing(value),codecGain=opus?validateOpusGain(opus):null,tags=codecGain?codecGain.legacyTags:raw?validateReplayGain(raw):null;
 let selection:ProcessingPlan['selection']='none',gain=0,peak:number|null=null,referenceOffsetDb=0;
 const codecGainDb=(codecGain?.headerGainQ78??0)/256;
 let gainBasis:ProcessingPlan['gainBasis']=codecGain?'opus-header-only':'none';
 if(settings.replayGain!=='off'&&codecGain&&settings.opusPolicy==='r128'){
  gainBasis='opus-r128';
  if(settings.replayGain==='album'&&codecGain.r128AlbumQ78!==null){selection='album';gain=codecGain.r128AlbumQ78/256;}
  else if(codecGain.r128TrackQ78!==null){selection='track';gain=codecGain.r128TrackQ78/256;}
  if(selection!=='none')referenceOffsetDb=settings.opusTargetLUFS-(-23);
 }else if(settings.replayGain!=='off'&&(!codecGain||settings.opusPolicy!=='header-only')&&tags){
  gainBasis=codecGain?settings.opusPolicy==='legacy-before-header'?'opus-legacy-before-header':'opus-legacy-after-header':'file-replaygain';
  if(settings.replayGain==='album'&&tags.albumGainDb!==null){selection='album';gain=tags.albumGainDb;peak=tags.albumPeak;}
  else if(tags.trackGainDb!==null){selection='track';gain=tags.trackGainDb;peak=tags.trackPeak;}
  if(codecGain&&settings.opusPolicy==='legacy-before-header'&&peak!==null)peak*=10**(codecGainDb/20);
 }
 const normalizationGainDb=selection==='none'?0:gain+referenceOffsetDb-(gainBasis==='opus-legacy-before-header'?codecGainDb:0);
 const requestedGainDb=settings.volumeDb+(selection==='none'?0:normalizationGainDb+settings.preampDb);
 const ceilingDb=-20*Math.log10(peak??1);
 const effectiveGainDb=settings.preventClipping?Math.min(requestedGainDb,ceilingDb):requestedGainDb;
 return {version:3,application:'callback-linear-envelope',rampMs:20,settings,tags,enabled:processingEnabled(settings),selection,reason:settings.replayGain==='off'?'disabled':codecGain&&settings.opusPolicy==='header-only'?'header-only':selection==='none'?gainBasis==='opus-r128'?'missing-r128':'missing-tags':selection!==settings.replayGain?'album-fallback-track':'selected',peak,requestedGainDb,effectiveGainDb,linearGain:settings.muted?0:10**(effectiveGainDb/20),peakLimited:effectiveGainDb<requestedGainDb,peakEvidence:peak===null?'assumed-full-scale':'tag',samplePolicy:settings.preventClipping?'hard-clip':'preserve-float',invalidSamplePolicy:'zero',dither:'none',hardwareVerified:false,codecGain,gainBasis,codecGainDb,normalizationGainDb,referenceOffsetDb,totalRequestedGainDb:codecGainDb+requestedGainDb,totalEffectiveGainDb:codecGainDb+effectiveGainDb};
}
export function readProcessingPlan(value:unknown,expected:ProcessingPlan):ProcessingPlan{
 if(!record(value)||Object.keys(value).length!==Object.keys(expected).length)throw new Error('音频处理计划回执无效');
 for(const key of Object.keys(expected) as Array<keyof ProcessingPlan>){
  const a=value[key],b=expected[key];
  if(typeof b==='number'){if(typeof a!=='number'||!Number.isFinite(a)||Math.abs(a-b)>1e-9*Math.max(1,Math.abs(b)))throw new Error('音频处理增益回执不符');}
  else if(key==='settings'){if(!record(a)||Object.keys(a).length!==7||JSON.stringify(validateProcessing(a))!==JSON.stringify(b))throw new Error('音频处理设置回执不符');}
  else if(key==='tags'){if(JSON.stringify(a===null?null:validateReplayGain(a))!==JSON.stringify(b))throw new Error('音频处理标签回执不符');}
  else if(key==='codecGain'){if(JSON.stringify(a===null?null:validateOpusGain(a))!==JSON.stringify(b))throw new Error('Opus 增益来源不符');}
  else if(a!==b)throw new Error('音频处理计划回执不符');
 }
 return {...expected,settings:{...expected.settings},tags:expected.tags?{...expected.tags}:null,codecGain:expected.codecGain?validateOpusGain(expected.codecGain):null};
}
