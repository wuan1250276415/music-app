export const FLAC_TAG_ADAPTER='aural-flac-vorbis-preserve-v1' as const;
export const FLAC_METADATA_LIMIT=32*1024*1024;
export const TAG_PREVIEW_RESPONSE_LIMIT=131072;
export const TAG_WRITE_FIELDS={title:'TITLE',artists:'ARTIST',album:'ALBUM',albumArtists:'ALBUMARTIST',genres:'GENRE',date:'DATE',trackNumber:'TRACKNUMBER',discNumber:'DISCNUMBER',comment:'COMMENT',copyright:'COPYRIGHT',isrc:'ISRC'} as const;
export type TagWriteField=keyof typeof TAG_WRITE_FIELDS;
export interface TagFieldChange {field:TagWriteField;values:string[]}
export interface TagFieldDifference extends TagFieldChange {before:string[];changed:boolean}
export interface FlacTagPreview {
 version:1;adapter:typeof FLAC_TAG_ADAPTER;format:'flac';certification:'pending';
 sourceMetadataSha256:string;targetMetadataSha256:string;preservedBlocksSha256:string;streamInfoSha256:string;
 sourceAudioOffset:string;targetAudioOffset:string;audioBytes:string;sourceFileBytes:string;targetFileBytes:string;
 sampleRate:number;channels:number;bitsPerSample:number;totalSamples:string;declaredPcmMd5:string;
 metadataBlocks:number;pictureBlocks:number;unknownBlocks:number;embeddedCueSheet:boolean;vendorPreserved:boolean;
 fields:TagFieldDifference[];changed:boolean;audioVerification:'copy-and-hash-required';
}
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
export function tagWriteKeys(v:unknown,names:readonly string[]):v is Record<string,unknown>{return record(v)&&Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));}
export const tagWriteHash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
export const tagWriteInteger=(v:unknown):v is string=>typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=18446744073709551615n;
const utf8Length=(s:string)=>new TextEncoder().encode(s).length;
const unicode=(s:string)=>!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
export function readTagFieldChanges(value:unknown):TagFieldChange[]{
 if(!Array.isArray(value)||!value.length||value.length>11)throw new Error('请选择支持的写回字段');
 const seen=new Set<string>();let bytes=0;
 return value.map(v=>{
  if(!tagWriteKeys(v,['field','values'])||typeof v.field!=='string'||!Object.hasOwn(TAG_WRITE_FIELDS,v.field)||seen.has(v.field)||!Array.isArray(v.values)||v.values.length>32)throw new Error('写回字段无效或重复');seen.add(v.field);
  const values=v.values.map(s=>{if(typeof s!=='string'||!s.length||s.includes('\0')||!unicode(s)||utf8Length(s)>8192)throw new Error('写回文本编码或长度无效');bytes+=utf8Length(s);return s;});
  if(bytes>24576)throw new Error('选中写回文本超过预算');return {field:v.field as TagWriteField,values};
 });
}
export function readFlacTagPreview(value:unknown,changesValue:unknown):FlacTagPreview {
 const changes=readTagFieldChanges(changesValue),names=['version','adapter','format','certification','sourceMetadataSha256','targetMetadataSha256','preservedBlocksSha256','streamInfoSha256','sourceAudioOffset','targetAudioOffset','audioBytes','sourceFileBytes','targetFileBytes','sampleRate','channels','bitsPerSample','totalSamples','declaredPcmMd5','metadataBlocks','pictureBlocks','unknownBlocks','embeddedCueSheet','vendorPreserved','fields','changed','audioVerification'];
 if(!tagWriteKeys(value,names)||value.version!==1||value.adapter!==FLAC_TAG_ADAPTER||value.format!=='flac'||value.certification!=='pending'||value.audioVerification!=='copy-and-hash-required'||!['sourceMetadataSha256','targetMetadataSha256','preservedBlocksSha256','streamInfoSha256'].every(k=>tagWriteHash(value[k]))||!['sourceAudioOffset','targetAudioOffset','audioBytes','sourceFileBytes','targetFileBytes','totalSamples'].every(k=>tagWriteInteger(value[k]))||typeof value.declaredPcmMd5!=='string'||!/^[0-9a-f]{32}$/.test(value.declaredPcmMd5)||typeof value.embeddedCueSheet!=='boolean'||typeof value.vendorPreserved!=='boolean'||value.vendorPreserved!==true||typeof value.changed!=='boolean'||!Array.isArray(value.fields)||value.fields.length!==changes.length)throw new Error('FLAC 标签预览证据无效');
 for(const [k,min,max] of [['sampleRate',1,1048575],['channels',1,8],['bitsPerSample',4,32],['metadataBlocks',1,1024],['pictureBlocks',0,1024],['unknownBlocks',0,1024]] as const)if(!Number.isSafeInteger(value[k])||Number(value[k])<min||Number(value[k])>max)throw new Error('FLAC 标签技术属性无效');
 const start=BigInt(value.sourceAudioOffset as string),target=BigInt(value.targetAudioOffset as string),audio=BigInt(value.audioBytes as string);
 if(start<42n||target<42n||start>BigInt(FLAC_METADATA_LIMIT)||target>BigInt(FLAC_METADATA_LIMIT)||audio<1n||start+audio!==BigInt(value.sourceFileBytes as string)||target+audio!==BigInt(value.targetFileBytes as string)||start+audio>68719476736n||target+audio>68719476736n||BigInt(value.totalSamples as string)>68719476735n||Number(value.pictureBlocks)+Number(value.unknownBlocks)>=Number(value.metadataBlocks))throw new Error('FLAC 标签范围无效');
 let beforeBytes=0,changed=false;
 for(let i=0;i<changes.length;i++){
  const v=value.fields[i],c=changes[i];if(!tagWriteKeys(v,['field','values','before','changed'])||v.field!==c.field||JSON.stringify(v.values)!==JSON.stringify(c.values)||!Array.isArray(v.before)||v.before.length>256||v.before.some(s=>typeof s!=='string'||s.includes('\0')||!unicode(s)||utf8Length(s)>8192)||typeof v.changed!=='boolean'||v.changed!==(JSON.stringify(v.before)!==JSON.stringify(c.values)))throw new Error('FLAC 标签差异与原请求不符');
  for(const s of v.before as string[])beforeBytes+=utf8Length(s);changed ||=v.changed;
 }
 if(beforeBytes>32768||changed!==value.changed||!changed&&value.sourceMetadataSha256!==value.targetMetadataSha256)throw new Error('FLAC 标签差异或预算无效');
 return structuredClone(value) as unknown as FlacTagPreview;
}
export type TagWriteStage='planned'|'validated'|'backup_ready'|'temp_written'|'replaced'|'verified'|'committed'|'failed'|'recovery_required';
export interface TagWriteFileEvidence {sha256:string;audioSha256:string;metadataSha256:string;byteLength:string;audioOffset:string;audioBytes:string}
export function readTagWriteFileEvidence(value:unknown):TagWriteFileEvidence {
 if(!tagWriteKeys(value,['sha256','audioSha256','metadataSha256','byteLength','audioOffset','audioBytes'])||!['sha256','audioSha256','metadataSha256'].every(k=>tagWriteHash(value[k]))||!['byteLength','audioOffset','audioBytes'].every(k=>tagWriteInteger(value[k]))||BigInt(value.audioOffset as string)<42n||BigInt(value.audioBytes as string)<1n||BigInt(value.byteLength as string)!==BigInt(value.audioOffset as string)+BigInt(value.audioBytes as string)||BigInt(value.byteLength as string)>68719476736n)throw new Error('写回文件证据无效');
 return {sha256:value.sha256 as string,audioSha256:value.audioSha256 as string,metadataSha256:value.metadataSha256 as string,byteLength:value.byteLength as string,audioOffset:value.audioOffset as string,audioBytes:value.audioBytes as string};
}
// Recovery consumes actual reopened file hashes. A database stage alone never
// proves which filesystem mutation finished before a crash.
export function classifyTagWriteRecovery(source:TagWriteFileEvidence,staged:TagWriteFileEvidence|null,actual:{original:TagWriteFileEvidence|null;backup:TagWriteFileEvidence|null;temporary:TagWriteFileEvidence|null;replacementVictim:TagWriteFileEvidence|null}):'unchanged'|'staged'|'replacement-verified'|'restore-available'|'recovery-required' {
 const s=readTagWriteFileEvidence(source),t=staged?readTagWriteFileEvidence(staged):null;
 const equal=(a:TagWriteFileEvidence|null,b:TagWriteFileEvidence|null)=>Boolean(a&&b&&JSON.stringify(readTagWriteFileEvidence(a))===JSON.stringify(readTagWriteFileEvidence(b)));
 if(equal(actual.original,s))return t&&equal(actual.temporary,t)&&equal(actual.backup,s)?'staged':'unchanged';
 if(t&&equal(actual.original,t)&&equal(actual.backup,s)&&equal(actual.replacementVictim,s))return 'replacement-verified';
 if(actual.original===null&&equal(actual.backup,s))return 'restore-available';
 return 'recovery-required';
}
export interface TagWritePlan {version:1;jobId:string;itemId:string;fileId:string;contentRevision:number;adapter:typeof FLAC_TAG_ADAPTER;certificateId:string|null;preview:FlacTagPreview;changes:TagFieldChange[]}
export type TagWriteTransition={commandId:string}&(
 {stage:'validated';source:TagWriteFileEvidence;leaseId:string;leaseRevision:number}|
 {stage:'backup_ready';artifactId:string;backup:TagWriteFileEvidence}|
 {stage:'temp_written';artifactId:string;temporary:TagWriteFileEvidence}|
 {stage:'replaced';artifactId:string;victim:TagWriteFileEvidence;destination:TagWriteFileEvidence;leaseId:string;leaseRevision:number}|
 {stage:'verified';destination:TagWriteFileEvidence}|
 {stage:'committed';contentRevision:number;databaseReceiptId:string}|
 {stage:'failed'|'recovery_required';code:'cancelled'|'source-changed'|'lease-lost'|'space'|'io'|'verification'|'uncertified'|'process-lost'}
);
export const tagWriteUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(v);
export function readTagWritePlan(value:unknown):TagWritePlan {
 if(!tagWriteKeys(value,['version','jobId','itemId','fileId','contentRevision','adapter','certificateId','preview','changes'])||value.version!==1||value.adapter!==FLAC_TAG_ADAPTER||!['jobId','itemId','fileId'].every(k=>tagWriteUuid(value[k]))||!Number.isSafeInteger(value.contentRevision)||Number(value.contentRevision)<0||Number(value.contentRevision)>=Number.MAX_SAFE_INTEGER||value.certificateId!==null&&(typeof value.certificateId!=='string'||!value.certificateId.length||value.certificateId.length>128||/[\x00-\x1f\x7f]/.test(value.certificateId)))throw new Error('写回冻结计划无效');
 const changes=readTagFieldChanges(value.changes),preview=readFlacTagPreview(value.preview,changes);if(!preview.changed||preview.embeddedCueSheet)throw new Error('没有标签差异，或 FLAC 内含多轨 CUE，不适用单曲写回');
 return {...structuredClone(value),changes,preview} as unknown as TagWritePlan;
}
export function readTagWriteTransition(value:unknown):TagWriteTransition {
 if(!record(value)||!tagWriteUuid(value.commandId)||typeof value.stage!=='string')throw new Error('写回阶段身份无效');
 const names:Record<string,string[]>={validated:['source','leaseId','leaseRevision'],backup_ready:['artifactId','backup'],temp_written:['artifactId','temporary'],replaced:['artifactId','victim','destination','leaseId','leaseRevision'],verified:['destination'],committed:['contentRevision','databaseReceiptId'],failed:['code'],recovery_required:['code']};
 if(!Object.hasOwn(names,value.stage)||!tagWriteKeys(value,['commandId','stage',...names[value.stage]]))throw new Error('写回阶段字段无效');
 for(const k of ['source','backup','temporary','victim','destination'])if(Object.hasOwn(value,k))readTagWriteFileEvidence(value[k]);
 for(const k of ['artifactId','leaseId','databaseReceiptId'])if(Object.hasOwn(value,k)&&!tagWriteUuid(value[k]))throw new Error('写回工件或租约身份无效');
 for(const k of ['leaseRevision','contentRevision'])if(Object.hasOwn(value,k)&&(!Number.isSafeInteger(value[k])||Number(value[k])<1))throw new Error('写回阶段修订无效');
 if(Object.hasOwn(value,'code')&&(typeof value.code!=='string'||!['cancelled','source-changed','lease-lost','space','io','verification','uncertified','process-lost'].includes(value.code)))throw new Error('写回失败类型无效');
 return structuredClone(value) as unknown as TagWriteTransition;
}
export function validateTagWriteAdvance(planValue:TagWritePlan,history:TagWriteTransition[],transitionValue:unknown):TagWriteTransition {
 const plan=readTagWritePlan(planValue),t=readTagWriteTransition(transitionValue),current=history.at(-1)?.stage??'planned';
 if(['committed','failed','recovery_required'].includes(current))throw new Error('写回操作已终结，不能重放旧阶段');
 const chain=['planned','validated','backup_ready','temp_written','replaced','verified','committed'];
 if(t.stage==='failed'||t.stage==='recovery_required'){
  if(t.stage==='failed'&&['replaced','verified'].includes(current))throw new Error('替换后的失败必须保留恢复状态');return t;
 }
 if(chain.indexOf(t.stage)!==chain.indexOf(current)+1)throw new Error('写回阶段跳跃或倒退');
 const v=history.find(h=>h.stage==='validated') as Extract<TagWriteTransition,{stage:'validated'}>|undefined;
 const temp=history.find(h=>h.stage==='temp_written') as Extract<TagWriteTransition,{stage:'temp_written'}>|undefined;
 const equal=(a:TagWriteFileEvidence,b:TagWriteFileEvidence)=>JSON.stringify(readTagWriteFileEvidence(a))===JSON.stringify(readTagWriteFileEvidence(b));
 if(t.stage==='validated'&&(t.source.metadataSha256!==plan.preview.sourceMetadataSha256||t.source.byteLength!==plan.preview.sourceFileBytes||t.source.audioOffset!==plan.preview.sourceAudioOffset||t.source.audioBytes!==plan.preview.audioBytes))throw new Error('写回来源不属于预览快照');
 if(t.stage==='backup_ready'&&(!v||!equal(t.backup,v.source)))throw new Error('备份与已验证原文件不一致');
 if(t.stage==='temp_written'&&(!v||t.temporary.metadataSha256!==plan.preview.targetMetadataSha256||t.temporary.byteLength!==plan.preview.targetFileBytes||t.temporary.audioOffset!==plan.preview.targetAudioOffset||t.temporary.audioBytes!==v.source.audioBytes||t.temporary.audioSha256!==v.source.audioSha256||history.some(h=>'artifactId'in h&&h.artifactId===t.artifactId)))throw new Error('临时文件标签、音频或工件不符');
 if(t.stage==='replaced'&&(plan.certificateId===null||!v||!temp||!equal(t.victim,v.source)||!equal(t.destination,temp.temporary)||t.leaseId!==v.leaseId||t.leaseRevision!==v.leaseRevision||history.some(h=>'artifactId'in h&&h.artifactId===t.artifactId)))throw new Error('替换缺少格式认证、当前租约或实际被替换文件证据');
 if(t.stage==='verified'&&(!temp||!equal(t.destination,temp.temporary)))throw new Error('替换后的目标重读不符');
 if(t.stage==='committed'&&t.contentRevision!==plan.contentRevision+1)throw new Error('写回数据库提交修订不符');
 return t;
}
