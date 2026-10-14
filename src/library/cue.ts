import path from 'node:path';
import {readCueGapPolicy,type CueGapPolicy} from '../shared/cue-history.js';
import {readCueDirective,readCueFileDeclaration,readCueFileDeclarationLegacy3,type CueFileDeclaration} from './cue-file-token.js';

export const CUE_PARSER_VERSION='aural-cue-4';
export interface CueField {command:string;value:string;line:number}
export interface CueEntry {
 number:number;file:string;title:string;performer:string;
 index00Frame?:number;index01Frame:number;startFrame?:number;endFrame?:number;
 sourceOrdinal?:number;hidden?:boolean;fileType?:string;performerOrigin?:'cue'|'missing';
 pregapFrame?:number;postgapFrame?:number;songwriter?:string;isrc?:string;
 indices?:Array<{number:number;frame:number}>;flags?:string[];fields?:CueField[];
}
export interface CueSheet {
 title:string;performer:string;entries:CueEntry[];warnings:string[];gapPolicy:CueGapPolicy;
 songwriter?:string;catalog?:string;cdTextFile?:string;fields?:CueField[];hiddenEntries?:CueEntry[];invalid?:boolean;
}
function decodeValue(raw:string):string{const value=raw.trim();return value.startsWith('"')&&value.endsWith('"')?value.slice(1,-1).replace(/\\"/g,'"'):value;}
function parseIndex(value:string):number|undefined{
 const match=/^(\d+):(\d{2}):(\d{2})$/.exec(value);if(!match)return undefined;
 const minutes=Number(match[1]),seconds=Number(match[2]),frames=Number(match[3]),tick=(minutes*60+seconds)*75+frames;
 return seconds<60&&frames<75&&Number.isSafeInteger(tick)?tick:undefined;
}
export function parseCue(text:string,gapPolicy:CueGapPolicy='previous'):CueSheet{
 return parseWithFileGrammar(text,gapPolicy,readCueFileDeclaration);
}
// Retained FLAC text parser1 snapshots bind the old parser3 FILE language.
// Replay it without restoring the old exponential regexp implementation.
export function parseCueLegacy3(text:string,gapPolicy:CueGapPolicy='previous'):CueSheet{
 return parseWithFileGrammar(text,gapPolicy,readCueFileDeclarationLegacy3);
}
function parseWithFileGrammar(text:string,gapPolicy:CueGapPolicy,fileDeclaration:(value:string)=>CueFileDeclaration|null):CueSheet{
 readCueGapPolicy(gapPolicy);
 if(text.includes('\0')||Buffer.byteLength(text,'utf8')>2*1024*1024)throw new Error('CUE 内容超过预算或包含空字符');
 const result:CueSheet={title:'',performer:'',entries:[],warnings:[],fields:[],hiddenEntries:[],invalid:false,gapPolicy};
 const issue=(message:string)=>{result.invalid=true;if(result.warnings.length<256)result.warnings.push(message);};
 let currentFile='',fileType='',current:Partial<CueEntry>|undefined,ordinal=0;
 const trackNumbers=new Set<number>(),files=new Set<string>();
 const seenFields=new Set<string>();
 const finalize=(line:number)=>{
  if(!current)return;
  if(current.index01Frame===undefined||!current.file||current.number===undefined)issue(`第 ${line} 行前的 TRACK 缺少 FILE 或 INDEX 01`);
  else if(current.index00Frame!==undefined&&current.index00Frame>current.index01Frame)issue(`第 ${line} 行前的 TRACK INDEX 00 晚于 INDEX 01`);
  else result.entries.push({...current,number:current.number,file:current.file,index01Frame:current.index01Frame,
   title:current.title||`音轨 ${String(current.number).padStart(2,'0')}`,performer:current.performer||result.performer||'未知艺术家',performerOrigin:current.performer||result.performer?'cue':'missing'});
  current=undefined;seenFields.clear();
 };
 const lines=text.replace(/^\uFEFF/,'').split(/\r\n|\n|\r/);if(lines.length>50000)throw new Error('CUE 行数超过预算');
 for(const [index,line] of lines.entries()){
  if(line.length>16384)throw new Error('CUE 单行超过预算');
  const trimmed=line.trim();if(!trimmed)continue;
  const directive=readCueDirective(trimmed);if(!directive){issue(`第 ${index+1} 行指令无法解析`);continue;}
  const {command,value}=directive;
  if(command==='FILE'){
   finalize(index+1);const fileMatch=fileDeclaration(value);
   if(!fileMatch){currentFile='';issue(`第 ${index+1} 行 FILE 无法解析`);continue;}
   currentFile=decodeValue(fileMatch.token);fileType=fileMatch.type;const key=currentFile.replaceAll('\\','/').toLowerCase();
   if(files.has(key))issue(`第 ${index+1} 行重复 FILE 编排尚需明确范围`);files.add(key);
   if(!['WAVE','MP3','AIFF','BINARY','MOTOROLA'].includes(fileType))issue(`第 ${index+1} 行 FILE 类型不支持`);
   continue;
  }
  if(command==='TRACK'){
   finalize(index+1);const track=/^(\d{1,3})\s+AUDIO$/i.exec(value),number=track?Number(track[1]):0;
   if(ordinal>=1000)throw new Error('CUE 音轨数超过预算');
   current=track&&number>0?{number,file:currentFile,fileType,sourceOrdinal:ordinal,indices:[],flags:[],fields:[]}:undefined;ordinal++;
   if(!current){issue(`第 ${index+1} 行不是有效 AUDIO TRACK`);continue;}
   if(trackNumbers.has(number))issue(`第 ${index+1} 行 TRACK 序号重复`);trackNumbers.add(number);continue;
  }
  const fields=current?.fields??result.fields!;
  if(fields.length>=128)throw new Error('CUE 字段数超过预算');fields.push({command,value,line:index+1});
  if(command==='REM')continue;
  if(command==='INDEX'){
   const idx=/^(\d{2})\s+(\S+)$/.exec(value),frame=idx?parseIndex(idx[2]):undefined;
   if(!current||!idx||frame===undefined){issue(`第 ${index+1} 行 INDEX 无效`);continue;}
   const number=Number(idx[1]),previous=current.indices!.at(-1);
   if(previous&&(number<=previous.number||frame<previous.frame||number>1&&frame===previous.frame)){issue(`第 ${index+1} 行 INDEX 重复或非递增`);continue;}
   current.indices!.push({number,frame});if(number===0)current.index00Frame=frame;else if(number===1)current.index01Frame=frame;
   continue;
  }
  if(command==='PREGAP'||command==='POSTGAP'){
   const frame=parseIndex(value);if(!current||frame===undefined||seenFields.has(command)){issue(`第 ${index+1} 行 ${command} 无效或重复`);continue;}
   seenFields.add(command);if(command==='PREGAP')current.pregapFrame=frame;else current.postgapFrame=frame;continue;
  }
  if(command==='FLAGS'){
   const flags=value.toUpperCase().split(/\s+/);if(!current||seenFields.has(command)||flags.some(flag=>!['DCP','4CH','PRE','SCMS'].includes(flag))||new Set(flags).size!==flags.length)issue(`第 ${index+1} 行 FLAGS 无效或重复`);
   else{current.flags=flags;seenFields.add(command);}continue;
  }
  const decoded=decodeValue(value);
  if(command==='TITLE'){if(current)current.title=decoded;else result.title=decoded;}
  else if(command==='PERFORMER'){if(current)current.performer=decoded;else result.performer=decoded;}
  else if(command==='SONGWRITER'){if(current)current.songwriter=decoded;else result.songwriter=decoded;}
  else if(command==='CATALOG'){if(current||!/^\d{13}$/.test(decoded))issue(`第 ${index+1} 行 CATALOG 无效`);else result.catalog=decoded;}
  else if(command==='ISRC'){if(!current||!/^([A-Z]{2}[A-Z0-9]{3}\d{7})$/i.test(decoded))issue(`第 ${index+1} 行 ISRC 无效`);else current.isrc=decoded.toUpperCase();}
  else if(command==='CDTEXTFILE'){if(current)issue(`第 ${index+1} 行 CDTEXTFILE 作用域无效`);else result.cdTextFile=decoded;}
  else issue(`第 ${index+1} 行指令 ${command} 尚不支持`);
 }
 finalize(lines.length+1);
 // Keep original indices intact. The effective start and adjacent end express
 // ownership without duplicating or discarding the recorded INDEX00 audio.
 const byFile=new Map<string,CueEntry[]>();
 for(const entry of result.entries){entry.startFrame=gapPolicy==='current'?entry.index00Frame??entry.index01Frame:entry.index01Frame;const key=entry.file.replaceAll('\\','/').toLowerCase(),group=byFile.get(key)??[];group.push(entry);byFile.set(key,group);}
 for(const group of byFile.values()){
  for(let i=0;i<group.length-1;i++){
   const here=group[i],next=group[i+1];
   if(next.index01Frame<=here.index01Frame||next.index00Frame!==undefined&&next.index00Frame<=here.index01Frame){issue(`TRACK ${next.number} 的边界非递增或与上一轨重叠`);continue;}
   here.endFrame=next.startFrame!;
   if(here.indices?.some(value=>value.frame>=here.endFrame!&&value.number>1))issue(`TRACK ${here.number} 的子索引越过下一轨`);
  }
  const first=group[0];if(first.startFrame!>0)result.hiddenEntries!.push({number:0,file:first.file,fileType:first.fileType,title:first===result.entries[0]?'首轨隐藏音频':`文件前导音频 · ${path.basename(first.file)}`,performer:first.performer,performerOrigin:first.performerOrigin,index01Frame:0,startFrame:0,endFrame:first.startFrame,sourceOrdinal:first.sourceOrdinal,hidden:true,indices:[{number:1,frame:0}],flags:[],fields:[]});
 }
 return result;
}

export function resolveCueReference(root: string, cuePath: string, reference: string): string | null {
  if (!reference || path.isAbsolute(reference)) return null;
  const target = path.resolve(path.dirname(cuePath), reference.replaceAll('\\', path.sep));
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return target;
}
