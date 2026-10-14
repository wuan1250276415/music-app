import {createHash} from 'node:crypto';
import path from 'node:path';
import {cueHash} from '../shared/cue-history.js';
import {readEmbeddedCueSourceBundle,EMBEDDED_CUE_EXPORT_LIMIT,type EmbeddedCueBundleInspection,type EmbeddedCueInterpretation,type EmbeddedCueBinaryMetadata,type EmbeddedCueTextMetadata} from '../shared/embedded-cue-bundle.js';
import {parseFlacCueBlock,type FlacCueSource} from './flac-cuesheet.js';
import {parseFlacCueText,replayFlacCueTextSource,embeddedCueView,type FlacCueTextSource,type EmbeddedCueView} from './flac-cue-text.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const withoutRaw=<T extends {rawBase64:string}>(value:T|null):Omit<T,'rawBase64'>|null=>{if(!value)return null;const {rawBase64,...metadata}=value;return metadata;};
function bytes(value:string):Buffer {const raw=Buffer.from(value,'base64');if(raw.toString('base64')!==value)throw new Error('内嵌 CUE 来源备份字节编码无效');return raw;}
function binaryMetadata(source:FlacCueSource):EmbeddedCueBinaryMetadata {const {rawBase64,tracks,...metadata}=source;return metadata;}
function textMetadata(source:FlacCueTextSource):EmbeddedCueTextMetadata {const {rawBase64,document,...metadata}=source;return metadata;}
function interpretation(binary:FlacCueSource|null,text:FlacCueTextSource|null,view:EmbeddedCueView):EmbeddedCueInterpretation {
 return {binaryParser:binary?.parserVersion??null,textParser:text?.parserVersion??null,state:!binary&&!text?'absent':view.textState==='none'?'binary':view.textState,tracks:view.entries.filter(v=>!v.hidden).length,timeBaseDen:view.timeBaseDen,sampleRate:binary?.sampleRate??text?.sampleRate??null,totalSamples:binary?.totalSamples??text?.totalSamples??null,notice:view.notice.slice(0,500)};
}
// No database or filesystem access. All paths are retained source descriptions;
// the owning FLAC name is passed to the view, never resolved as an input file.
export function inspectEmbeddedCueSourceBundle(value:unknown,name:unknown,archiveSha256:unknown):EmbeddedCueBundleInspection {
 if(typeof name!=='string'||!name||name.length>128||/[\u0000-\u001f\\/]/.test(name))throw new Error('内嵌 CUE 来源备份名称无效');cueHash(archiveSha256);
 const bundle=readEmbeddedCueSourceBundle(value),archiveJson=JSON.stringify(bundle,null,2)+'\n';
 if(Buffer.byteLength(archiveJson)>EMBEDDED_CUE_EXPORT_LIMIT||hash(archiveJson)!==archiveSha256)throw new Error('内嵌 CUE 来源备份与原文件摘要不符');
 const s=bundle.source,relative=path.relative(s.rootPath,path.resolve(s.rootPath,s.relativePath));
 if(!path.isAbsolute(s.rootPath)||path.isAbsolute(s.relativePath)||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||s.rootPath.includes('\0')||s.relativePath.includes('\0'))throw new Error('内嵌 CUE 来源备份记录的位置无效');
 let savedBinary:FlacCueSource|null=null,savedText:FlacCueTextSource|null=null,currentBinary:FlacCueSource|null=null,currentText:FlacCueTextSource|null=null;
 let binaryRaw:Buffer|null=null,textRaw:Buffer|null=null;
 if(s.binary&&bundle.binaryRawBase64!==null){
  binaryRaw=bytes(bundle.binaryRawBase64);const info=bytes(s.binary.streamInfoBase64);
  if(hash(binaryRaw)!==s.binary.sourceHash||s.binary.blockOffset+binaryRaw.length>=s.fileBytes)throw new Error('内嵌 CUE 二进制原字节摘要或范围不符');
  currentBinary=parseFlacCueBlock(binaryRaw,info,s.binary.blockOffset);savedBinary={...currentBinary,parserVersion:s.binary.parserVersion};
  if(JSON.stringify(binaryMetadata(savedBinary))!==JSON.stringify(s.binary))throw new Error('内嵌 CUE 二进制来源与原字节不符');
 }
 if(s.text&&bundle.textFieldRawBase64!==null){
  textRaw=bytes(bundle.textFieldRawBase64);const info=bytes(s.text.streamInfoBase64);
  if(hash(textRaw)!==s.text.sourceHash||s.text.commentOffset+textRaw.length>=s.fileBytes)throw new Error('内嵌 CUE 文本原字节摘要或范围不符');
  savedText=replayFlacCueTextSource(textRaw,info,s.text.commentOffset,s.text.fieldIndex,s.text.parserVersion);
  if(JSON.stringify(textMetadata(savedText))!==JSON.stringify(s.text))throw new Error('内嵌 CUE 文本来源与保存时解析不符');
  currentText=parseFlacCueText(textRaw,info,s.text.commentOffset,s.text.fieldIndex);
 }
 if(savedBinary&&savedText&&savedBinary.streamInfoBase64!==savedText.streamInfoBase64)throw new Error('内嵌 CUE 来源备份音频头不一致');
 // Reconstruct in the original payload property order, including the pinned
 // historical document order. The export deliberately omitted these trees.
 const payload={...s,binary:withoutRaw(savedBinary),text:withoutRaw(savedText)},payloadJson=JSON.stringify(payload);
 if(Buffer.byteLength(payloadJson)>2*1024*1024||hash(payloadJson)!==bundle.versionId)throw new Error('内嵌 CUE 来源备份无法重建原版本摘要');
 const file=path.basename(s.relativePath),savedView=embeddedCueView(savedBinary,savedText,file,s.artist,s.album),currentView=embeddedCueView(currentBinary,currentText,file,s.artist,s.album);
 let text='',textError='';if(textRaw)try{text=new TextDecoder('utf-8',{fatal:true}).decode(textRaw.subarray(9));}catch{textError='保存的原字段不是有效 UTF-8，原始备份仍保留完整字节。';}
 const binaryText=savedBinary?JSON.stringify({catalog:savedBinary.catalog,cd:savedBinary.cd,leadIn:savedBinary.leadIn,sampleRate:savedBinary.sampleRate,totalSamples:savedBinary.totalSamples,tracks:savedBinary.tracks.slice(0,128).map(v=>({...v,indices:v.indices.slice(0,32),indicesOmitted:Math.max(0,v.indices.length-32)})),tracksOmitted:Math.max(0,savedBinary.tracks.length-128)},null,2):'';
 const sampleRate=currentBinary?.sampleRate??currentText?.sampleRate,totalSamples=currentBinary?.totalSamples??currentText?.totalSamples;
 const sample=(frame:number|undefined):number=>{
  if(frame===undefined||!Number.isSafeInteger(frame)||frame<0||!sampleRate||!totalSamples)throw new Error('内嵌 CUE 复审范围无效');
  const numerator=BigInt(frame)*BigInt(sampleRate),denominator=BigInt(currentView.timeBaseDen);
  if(numerator%denominator!==0n)throw new Error('内嵌 CUE 复审范围不能精确表示');const result=Number(numerator/denominator);
  if(!Number.isSafeInteger(result)||result>totalSamples)throw new Error('内嵌 CUE 复审范围超出音频');return result;
 };
 const tracks=currentView.entries.slice(0,128).map(v=>{const startSample=sample(v.startFrame),endSample=sample(v.endFrame);if(startSample>=endSample)throw new Error('内嵌 CUE 复审范围为空');return {number:v.number,hidden:Boolean(v.hidden),title:v.title.slice(0,256),performer:v.performer.slice(0,256),startSample,endSample};});
 const files=[...new Set((currentText?.document.entries??[]).map(v=>v.file))];
 return {name,archiveSha256:archiveSha256 as string,versionId:bundle.versionId,capturedAt:bundle.capturedAt,fileId:s.fileId,rootId:s.rootId,rootPath:s.rootPath,relativePath:s.relativePath,fileBytes:s.fileBytes,artist:s.artist.slice(0,512),album:s.album.slice(0,512),metadataTruncated:s.artist.length>512||s.album.length>512,provenance:s.provenance,binaryHash:s.binary?.sourceHash??null,textHash:s.text?.sourceHash??null,binaryBytes:binaryRaw?.length??0,textBytes:textRaw?.length??0,saved:interpretation(savedBinary,savedText,savedView),current:interpretation(currentBinary,currentText,currentView),interpretationChanged:JSON.stringify(savedView)!==JSON.stringify(currentView),text:text.slice(0,131072),textTruncated:text.length>131072,textError,binaryText:binaryText.slice(0,131072),binaryTruncated:binaryText.length>131072||Boolean(savedBinary&&(savedBinary.tracks.length>128||savedBinary.tracks.some(v=>v.indices.length>32))),tracks,tracksTruncated:currentView.entries.length>128||currentView.entries.some(v=>v.title.length>256||v.performer.length>256),files:files.slice(0,64).map(v=>v.slice(0,512)),filesTruncated:files.length>64||files.some(v=>v.length>512)};
}
