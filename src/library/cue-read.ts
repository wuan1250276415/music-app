import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {parseCue,CUE_PARSER_VERSION,type CueSheet} from './cue.js';
import {readCueEncoding,readCueGapPolicy,type CueEncoding,type CueGapPolicy} from '../shared/cue-history.js';
export interface ParsedCueSource {document:CueSheet;sourceHash:string;encoding:Exclude<CueEncoding,'auto'>;parserVersion:typeof CUE_PARSER_VERSION;rawBase64:string;rawBytes:number;requestedEncoding:CueEncoding;gapPolicy:CueGapPolicy;parseError:string}
function selectedEncoding(bytes:Uint8Array,mode:CueEncoding):ParsedCueSource['encoding']{
 readCueEncoding(mode);
 let encoding:ParsedCueSource['encoding']=mode==='auto'?'utf-8':mode;
 if(mode==='auto'){
  if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';
  else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
  else{try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{encoding='gb18030';}}
 }
 return encoding;
}
export function decodeCueBytes(bytes:Uint8Array,mode:CueEncoding):{text:string;encoding:ParsedCueSource['encoding']}{
 const encoding=selectedEncoding(bytes,mode);
 return {text:new TextDecoder(encoding,{fatal:true}).decode(bytes),encoding};
}
export function interpretCueBytes(bytes:Uint8Array,mode:CueEncoding,gapPolicy:CueGapPolicy='previous'):ParsedCueSource{
 if(bytes.length>2*1024*1024)throw new Error('CUE 超过 2 MiB 限额');readCueEncoding(mode);readCueGapPolicy(gapPolicy);
 let encoding=selectedEncoding(bytes,mode);
 let document:CueSheet,parseError='';
 try{const decoded=decodeCueBytes(bytes,mode);encoding=decoded.encoding;document=parseCue(decoded.text,gapPolicy);}
 catch(error){parseError=String(error instanceof Error?error.message:error).replaceAll('\0','').slice(0,500)||'CUE 解码或解析失败';document={title:'',performer:'',entries:[],hiddenEntries:[],fields:[],warnings:[parseError],invalid:true,gapPolicy};}
 return {document,sourceHash:createHash('sha256').update(bytes).digest('hex'),encoding,parserVersion:CUE_PARSER_VERSION,rawBase64:Buffer.from(bytes).toString('base64'),rawBytes:bytes.length,requestedEncoding:mode,gapPolicy,parseError};
}
export async function readCueSource(handle:FileHandle,size:number,mode:CueEncoding='auto',gapPolicy:CueGapPolicy='previous'):Promise<ParsedCueSource>{
 if(!Number.isSafeInteger(size)||size<0||size>2*1024*1024)throw new Error('CUE 超过 2 MiB 限额');
 const buffer=Buffer.alloc(size+1);let length=0;
 while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
 if(length!==size)throw new Error('CUE 文件读取期间变化');
 return interpretCueBytes(buffer.subarray(0,length),mode,gapPolicy);
}
