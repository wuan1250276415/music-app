export const CUE_ENCODINGS=['auto','utf-8','utf-16le','utf-16be','gb18030'] as const;
export type CueEncoding=typeof CUE_ENCODINGS[number];
export type CueGapPolicy='previous'|'current';
export const CUE_GAP_LABELS:Record<CueGapPolicy,string>={previous:'前间隙归前一轨尾部',current:'前间隙归本轨前奏'};
export type CueSourceSummary={id:string;documentId:string|null;documentIds:string[];rootId:string;rootPath:string;relativePath:string;revision:number;encoding:CueEncoding;gapPolicy:CueGapPolicy;observedGapPolicy:CueGapPolicy|null;latestVersion:string|null;sourceHash:string|null;observedEncoding:Exclude<CueEncoding,'auto'>|null;parserVersion:string|null;error:string;trackCount:number;pendingScan:boolean;observedAt:string|null;selectedVersion:string|null;selectionCommand:string|null;selectedApplied:boolean;registeredAt?:string|null};
export type CueSourcePage={items:CueSourceSummary[];nextCursor:string|null;error:string};
export type CueVersionSummary={id:string;fileId:string;sourceHash:string;rawBytes:number;encoding:Exclude<CueEncoding,'auto'>;requestedEncoding:CueEncoding;gapPolicy:CueGapPolicy;parserVersion:string;error:string;trackCount:number;createdAt:string;latest:boolean;applied:boolean;imported:boolean};
export type CueVersionPage={items:CueVersionSummary[];nextCursor:string|null};
export type CueSourcePreview={version:CueVersionSummary;encoding:Exclude<CueEncoding,'auto'>;text:string;truncated:boolean;error:string};
// The five-field v42 command remains replayable without rewriting its ledger.
// New clients always supply the policy; legacy fresh commands select previous.
export type CueInterpretRequest={commandId:string;fileId:string;baseRevision:number;latestVersion:string;encoding:CueEncoding;gapPolicy?:CueGapPolicy};
export type CueInterpretResult={status:'saved'|'rejected';source:CueSourceSummary|null;error:string};
export function cueId(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value))throw new Error('无效 CUE 来源标识');return value;}
export function cueHash(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw new Error('无效 CUE 原文版本');return value;}
export function cueLatest(value:unknown):string|null{return value===null?null:cueHash(value);}
export function readCueEncoding(value:unknown):CueEncoding{if(!CUE_ENCODINGS.includes(value as CueEncoding))throw new Error('无效 CUE 编码');return value as CueEncoding;}
export function readCueGapPolicy(value:unknown):CueGapPolicy{if(value!=='previous'&&value!=='current')throw new Error('无效 CUE 前间隙归属');return value;}
export function readCueInterpretRequest(value:unknown):CueInterpretRequest{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('无效 CUE 解释请求');const r=value as CueInterpretRequest;
 const policy=Object.hasOwn(r,'gapPolicy');if(Object.keys(r).length!==(policy?6:5))throw new Error('无效 CUE 解释请求');
 if(!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||r.baseRevision>=Number.MAX_SAFE_INTEGER-1)throw new Error('无效 CUE 基础修订');
 return {commandId:cueId(r.commandId),fileId:cueId(r.fileId),baseRevision:r.baseRevision,latestVersion:cueHash(r.latestVersion),encoding:readCueEncoding(r.encoding),...(policy?{gapPolicy:readCueGapPolicy(r.gapPolicy)}:{})};
}
