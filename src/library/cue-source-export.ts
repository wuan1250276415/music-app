import {createHash} from 'node:crypto';
import {cueHash} from '../shared/cue-history.js';
import {readCueSourceBundle,CUE_SOURCE_RAW_LIMIT,type CueSourceBundle,type CueBundleInspection} from '../shared/cue-source-export.js';
import {interpretCueBytes,decodeCueBytes,type ParsedCueSource} from './cue-read.js';
import {CUE_PARSER_VERSION} from './cue.js';
import {readCueDirective,readCueFileDeclaration} from './cue-file-token.js';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function cueBundleVersion(bundle:Pick<CueSourceBundle,'fileId'|'sourceHash'|'encoding'|'requestedEncoding'|'parserVersion'|'parsedSha256'|'parseError'|'gapPolicy'>,derivation:'v42'|'v43'):string {
 const fields:unknown[]=[bundle.fileId,bundle.sourceHash,bundle.encoding,bundle.requestedEncoding,bundle.parserVersion,bundle.parsedSha256,bundle.parseError];if(derivation==='v43')fields.push(bundle.gapPolicy);return hash(JSON.stringify(fields));
}
export function checkedCueSourceBundle(value:unknown):{bundle:CueSourceBundle;raw:Buffer;snapshot:{entries:unknown[];warnings:string[]}} {
 const bundle=readCueSourceBundle(value),raw=Buffer.from(bundle.rawBase64,'base64');
 if(raw.toString('base64')!==bundle.rawBase64||raw.length!==bundle.rawBytes||hash(raw)!==bundle.sourceHash||Buffer.byteLength(bundle.parsedJson)>CUE_SOURCE_RAW_LIMIT||hash(bundle.parsedJson)!==bundle.parsedSha256||cueBundleVersion(bundle,bundle.versionDerivation)!==bundle.versionId)throw new Error('CUE 来源备份字节、解析快照或版本摘要不符');
 const snapshot=JSON.parse(bundle.parsedJson) as {entries:unknown[];warnings:string[]};
 if(!snapshot||!Array.isArray(snapshot.entries)||snapshot.entries.length>2000||!Array.isArray(snapshot.warnings)||snapshot.warnings.length>256||snapshot.warnings.some(v=>typeof v!=='string'))throw new Error('CUE 来源备份解析快照结构无效');
 return {bundle,raw,snapshot};
}
// Archive admission uses the same current linear grammar as ordinary scanning.
// Retained raw and old snapshots remain displayable if admission fails.
function checkArchiveFileGrammar(text:string):void {
 const lines=text.split(/\r\n|\n|\r/);if(lines.length>50000)throw new Error('来源备份 CUE 行数超过预算');
 for(const original of lines){if(original.length>16384)throw new Error('来源备份 CUE 单行超过预算');const directive=readCueDirective(original.trim());if(directive?.command!=='FILE')continue;
  if(!readCueFileDeclaration(directive.value))throw new Error('来源备份 FILE 声明无法完整解释，保留原文，当前解析暂停');
 }
}
export function inspectCueSourceBundle(value:unknown,name:unknown,archiveSha256:unknown):CueBundleInspection {
 if(typeof name!=='string'||!name||name.length>128||/[\u0000-\u001f\\/]/.test(name))throw new Error('CUE 来源备份名称无效');cueHash(archiveSha256);
 const {bundle,raw,snapshot}=checkedCueSourceBundle(value);let current:ParsedCueSource|null=null,currentNotice='';
 try{let sourceText:string|null=null;try{sourceText=decodeCueBytes(raw,bundle.requestedEncoding).text;}catch{/* Interpreter records strict decode failure without FILE parsing. */}if(sourceText!==null)checkArchiveFileGrammar(sourceText);current=interpretCueBytes(raw,bundle.requestedEncoding,bundle.gapPolicy);}catch(e){currentNotice=String(e instanceof Error?e.message:e).slice(0,500);}
 let text='',textError='';try{text=decodeCueBytes(raw,bundle.encoding).text;}catch(e){textError=String(e instanceof Error?e.message:e).slice(0,500);}
 const files=[...new Set(current?.document.entries.map(e=>e.file)??[])];
 return {name,archiveSha256:archiveSha256 as string,fileId:bundle.fileId,versionId:bundle.versionId,rootPath:bundle.rootPath,relativePath:bundle.relativePath,createdAt:bundle.createdAt,sourceHash:bundle.sourceHash,rawBytes:bundle.rawBytes,encoding:bundle.encoding,requestedEncoding:bundle.requestedEncoding,gapPolicy:bundle.gapPolicy,snapshotParser:bundle.parserVersion,snapshotTracks:snapshot.entries.length,snapshotNotice:(bundle.parseError||snapshot.warnings.join('；')).slice(0,500),currentParser:current?.parserVersion??CUE_PARSER_VERSION,currentTracks:current?.document.entries.length??null,currentEncoding:current?.encoding??null,currentParsed:current!==null,currentNotice:currentNotice||(current?.parseError||current?.document.warnings.join('；')||'').slice(0,500),currentInvalid:!current||Boolean(current.parseError||current.document.invalid),text:text.slice(0,131072),textTruncated:text.length>131072,textError,files:files.slice(0,64).map(f=>f.slice(0,512)),filesTruncated:files.length>64||files.some(f=>f.length>512)};
}
