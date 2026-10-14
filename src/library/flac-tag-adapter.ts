import {createHash} from 'node:crypto';
import {FLAC_METADATA_LIMIT,FLAC_TAG_ADAPTER,TAG_WRITE_FIELDS,readTagFieldChanges,readFlacTagPreview,type FlacTagPreview,type TagFieldChange} from '../shared/tag-write.js';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
interface Block {type:number;bytes:Buffer}
interface Comment {vendor:Buffer;entries:Array<{key:string;raw:Buffer}>}
interface Metadata {blocks:Block[];comment:Comment|null;commentIndex:number;prefix:Buffer}
function parseComment(bytes:Buffer):Comment {
 let at=0;const u32=()=>{if(at+4>bytes.length)throw new Error('FLAC 注释长度不完整');const n=bytes.readUInt32LE(at);at+=4;return n;};
 const blob=(n:number)=>{if(n>bytes.length-at)throw new Error('FLAC 注释越界');const b=bytes.subarray(at,at+n);at+=n;return b;};
 const vendor=blob(u32());if(vendor.length>1048576)throw new Error('FLAC vendor 超过预算');utf8.decode(vendor);
 const count=u32();if(count>32768)throw new Error('FLAC 注释数量超过预算');const entries:Comment['entries']=[];
 for(let i=0;i<count;i++){
  const raw=blob(u32()),split=raw.indexOf(61);if(split<1||split>256)throw new Error('FLAC 注释名称无效');
  const name=raw.subarray(0,split);if(name.some(c=>c<32||c>126||c===61))throw new Error('FLAC 注释名称编码无效');
  // Unknown values remain opaque bytes. Selected values must be valid UTF-8.
  entries.push({key:name.toString('ascii').toUpperCase(),raw});
 }
 if(at!==bytes.length)throw new Error('FLAC 注释包含未识别的尾部数据');return {vendor,entries};
}
function parse(input:Buffer):Metadata {
 if(input.length<42||input.length>FLAC_METADATA_LIMIT||input.subarray(0,4).toString('ascii')!=='fLaC')throw new Error('仅支持标准独立 FLAC 元数据前缀');
 const prefix=Buffer.from(input),blocks:Block[]=[];let at=4,ended=false,comment:Comment|null=null,commentIndex=-1;
 while(!ended){
  if(blocks.length>=1024||at+4>prefix.length)throw new Error('FLAC 元数据块超过预算或不完整');
  const flag=prefix[at],type=flag&127,size=prefix.readUIntBE(at+1,3);at+=4;
  if(type===127||size>prefix.length-at||!blocks.length&&(type!==0||size!==34)||blocks.length>0&&type===0)throw new Error('FLAC 元数据结构无效');
  const bytes=prefix.subarray(at,at+size);if(type===1&&bytes.some(c=>c!==0))throw new Error('FLAC padding 非零');
  if(type===4){if(comment)throw new Error('FLAC 存在多个注释块');comment=parseComment(bytes);commentIndex=blocks.length;}
  blocks.push({type,bytes});at+=size;ended=Boolean(flag&128);
 }
 if(at!==prefix.length)throw new Error('FLAC 前缀混入音频或其他数据');
 const si=blocks[0].bytes,min=si.readUInt16BE(0),max=si.readUInt16BE(2),rate=si.readUIntBE(10,3)>>>4,depth=((si[12]&1)<<4|(si[13]>>>4))+1;
 if(min<16||max<min||!rate||depth<4||depth>32)throw new Error('FLAC STREAMINFO 属性无效');return {blocks,comment,commentIndex,prefix};
}
function encodeComment(vendor:Buffer,entries:Buffer[]):Buffer {
 const length=8+vendor.length+entries.reduce((n,b)=>n+4+b.length,0);if(length>0xffffff||entries.length>32768)throw new Error('FLAC 新注释块超过预算');
 const bytes=Buffer.alloc(length);bytes.writeUInt32LE(vendor.length,0);vendor.copy(bytes,4);let at=4+vendor.length;bytes.writeUInt32LE(entries.length,at);at+=4;
 for(const e of entries){bytes.writeUInt32LE(e.length,at);at+=4;e.copy(bytes,at);at+=e.length;}return bytes;
}
function encode(blocks:Block[]):Buffer {
 const length=4+blocks.reduce((n,b)=>n+4+b.bytes.length,0);if(length>FLAC_METADATA_LIMIT||blocks.length>1024)throw new Error('FLAC 新元数据超过预算');
 const out=Buffer.alloc(length);out.write('fLaC',0,'ascii');let at=4;
 for(let i=0;i<blocks.length;i++){const b=blocks[i];if(b.bytes.length>0xffffff)throw new Error('FLAC 元数据单块过大');out[at]=b.type|(i===blocks.length-1?128:0);out.writeUIntBE(b.bytes.length,at+1,3);at+=4;b.bytes.copy(out,at);at+=b.bytes.length;}return out;
}
function protectedBytes(metadata:Metadata):Buffer {return encode(metadata.blocks.filter(b=>b.type!==4));}
function originalValues(metadata:Metadata,key:string):string[]{
 const values=(metadata.comment?.entries??[]).filter(e=>e.key===key).map(e=>utf8.decode(e.raw.subarray(e.raw.indexOf(61)+1)));
 if(values.length>256||values.some(s=>s.includes('\0')||Buffer.byteLength(s,'utf8')>8192))throw new Error('选中文本原值超过预览预算');return values;
}
// Only metadata is materialized. The caller must separately stream, copy and
// hash the original audio bytes; this function never certifies audio decoding.
export function rewriteFlacMetadata(input:Buffer,audioBytes:string,changesValue:unknown):{prefix:Buffer;preview:FlacTagPreview} {
 const changes=readTagFieldChanges(changesValue),source=parse(input);
 if(!/^[1-9][0-9]{0,19}$/.test(audioBytes)||BigInt(audioBytes)+BigInt(input.length)>68719476736n)throw new Error('FLAC 音频大小超过预算');
 let beforeBytes=0;
 const fields=changes.map(c=>{const before=originalValues(source,TAG_WRITE_FIELDS[c.field]);for(const v of before)beforeBytes+=Buffer.byteLength(v,'utf8');return {...c,before,changed:JSON.stringify(before)!==JSON.stringify(c.values)};});
 if(beforeBytes>32768)throw new Error('选中原标签文本超过预算');
 const changed=fields.some(f=>f.changed),selected=new Set(changes.map(c=>TAG_WRITE_FIELDS[c.field]));
 let prefix:Buffer;
 if(!changed)prefix=Buffer.from(source.prefix);
 else {
  const entries=(source.comment?.entries??[]).filter(e=>!selected.has(e.key as typeof TAG_WRITE_FIELDS[TagFieldChange['field']])).map(e=>e.raw);
  for(const c of changes)for(const value of c.values)entries.push(Buffer.from(`${TAG_WRITE_FIELDS[c.field]}=${value}`,'utf8'));
  const replacement:Block={type:4,bytes:encodeComment(source.comment?.vendor??Buffer.from('Aural','utf8'),entries)};
  const blocks=[...source.blocks];if(source.commentIndex<0)blocks.push(replacement);else blocks[source.commentIndex]=replacement;prefix=encode(blocks);
 }
 const target=parse(prefix);
 if(!protectedBytes(source).equals(protectedBytes(target)))throw new Error('FLAC 非目标元数据改变');
 const oldEntries=(source.comment?.entries??[]).filter(e=>!selected.has(e.key as typeof TAG_WRITE_FIELDS[TagFieldChange['field']])),newEntries=(target.comment?.entries??[]).filter(e=>!selected.has(e.key as typeof TAG_WRITE_FIELDS[TagFieldChange['field']]));
 if(oldEntries.length!==newEntries.length||oldEntries.some((e,i)=>!e.raw.equals(newEntries[i].raw))||source.comment&&!source.comment.vendor.equals(target.comment!.vendor))throw new Error('FLAC 未选标签或 vendor 改变');
 for(const c of changes)if(JSON.stringify(originalValues(target,TAG_WRITE_FIELDS[c.field]))!==JSON.stringify(c.values))throw new Error('FLAC 目标标签重读不符');
 const si=source.blocks[0].bytes,payload=BigInt(audioBytes),sampleRate=si.readUIntBE(10,3)>>>4,channels=((si[12]>>>1)&7)+1,bitsPerSample=((si[12]&1)<<4|(si[13]>>>4))+1,totalSamples=String((BigInt(si[13]&15)<<32n)|BigInt(si.readUInt32BE(14)));
 const preview=readFlacTagPreview({version:1,adapter:FLAC_TAG_ADAPTER,format:'flac',certification:'pending',sourceMetadataSha256:hash(source.prefix),targetMetadataSha256:hash(prefix),preservedBlocksSha256:hash(protectedBytes(source)),streamInfoSha256:hash(si),sourceAudioOffset:String(source.prefix.length),targetAudioOffset:String(prefix.length),audioBytes,sourceFileBytes:String(BigInt(source.prefix.length)+payload),targetFileBytes:String(BigInt(prefix.length)+payload),sampleRate,channels,bitsPerSample,totalSamples,declaredPcmMd5:si.subarray(18,34).toString('hex'),metadataBlocks:source.blocks.length,pictureBlocks:source.blocks.filter(b=>b.type===6).length,unknownBlocks:source.blocks.filter(b=>b.type>=7).length,embeddedCueSheet:source.blocks.some(b=>b.type===5)||Boolean(source.comment?.entries.some(entry=>entry.key==='CUESHEET')),vendorPreserved:true,fields,changed,audioVerification:'copy-and-hash-required'},changes);
 return {prefix,preview};
}
