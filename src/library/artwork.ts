import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {fileObservation} from '../platform/file-observation.js';
import type {IPicture} from 'music-metadata';
import type { LibraryItem } from '../shared/contracts.js';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const SIDECARS = ['cover.jpg','cover.jpeg','cover.png','cover.webp','folder.jpg','folder.jpeg','folder.png','folder.webp','front.jpg','front.jpeg','front.png','front.webp'];
export function artworkSidecars(fullPath:string):string[]{const base=path.basename(fullPath,path.extname(fullPath));return [...new Set([...['jpg','jpeg','png','webp','gif','bmp'].map(ext=>`${base}.${ext}`),...SIDECARS])];}

export function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0,4)).toString('ascii') === 'RIFF' &&
      Buffer.from(bytes.subarray(8,12)).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && ['GIF87a','GIF89a'].includes(Buffer.from(bytes.subarray(0,6)).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 54 && bytes[0]===0x42 && bytes[1]===0x4d) return 'image/bmp';
  return null;
}

export function isFront(picture:IPicture):boolean{
  const names=['front','cover','cover (front)','front cover'];
  return names.includes((picture.type??'').trim().toLowerCase())||names.includes((picture.name??'').trim().toLowerCase());
}

export async function artworkFingerprint(item:LibraryItem,sourceKind:'embedded'|'sidecar'='sidecar'):Promise<string>{
  const file=fileObservation(await fs.lstat(item.path,{bigint:true}));
  // Embedded covers depend only on the music file. In particular, a slow NAS
  // directory or an inaccessible sidecar must not delay a song's own cover.
  if(sourceKind==='embedded')return createHash('sha256').update(JSON.stringify(['embedded-first-flac-and-id3-picture-v8-rf64',item.path,file])).digest('hex');
  // Reading a permitted file must not depend on being able to inspect its directory.
  const directory=await fs.stat(path.dirname(item.path),{bigint:true}).then(value=>[value.size,value.mtimeNs,value.ctimeNs,value.dev,value.ino].map(v=>v.toString()),()=>['unavailable']);
  const sidecars:unknown[]=[];
  // Bounded conventional candidates, read sequentially. Never open a sidecar or
  // follow its symbolic link while deriving this invalidation key.
  for(const name of artworkSidecars(item.path)){
    try{const stat=await fs.lstat(path.join(path.dirname(item.path),name),{bigint:true});sidecars.push([name,stat.isFile()?fileObservation(stat):stat.isSymbolicLink()?'link':'non-file']);}
    catch(error){sidecars.push([name,(error as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unavailable']);}
  }
  // Re-probe online references selected before converter failures were kept
  // distinct from unsupported images. Offline references remain readable.
  return createHash('sha256').update(JSON.stringify(['sidecar-after-complete-flac-and-id3-v7-rf64',item.path,file,directory,sidecars])).digest('hex');
}

