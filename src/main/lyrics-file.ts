import {promises as fs} from 'node:fs';
import path from 'node:path';

// Only the native picker supplies this path. No Renderer-supplied path is accepted.
export async function readPickedLyrics(filename:string):Promise<{name:string;rawBase64:string}>{
 if(!['.lrc','.txt'].includes(path.extname(filename).toLowerCase()))throw new Error('请选择 LRC 或 TXT 歌词文件');
 const file=await fs.open(filename,'r');
 try{
  const before=await file.stat();if(!before.isFile()||before.size<1||before.size>1024*1024)throw new Error('歌词文件须为 1 MiB 以内的非空普通文件');
  const buffer=Buffer.alloc(1024*1024+1);let size=0;
  while(size<buffer.length){const read=await file.read(buffer,size,buffer.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}
  const after=await file.stat();
  if(size>1024*1024||size!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)throw new Error('歌词文件在读取期间变化，请重新选择');
  return {name:path.basename(filename).slice(0,128),rawBase64:buffer.subarray(0,size).toString('base64')};
 }finally{await file.close();}
}
