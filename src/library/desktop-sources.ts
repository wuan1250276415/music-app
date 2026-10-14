import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem} from '../shared/contracts.js';
import type {DesktopFileLookup,DesktopFileMatches} from '../shared/desktop-files.js';

// Read-only catalog lookup: filenames never become a direct playback source.
export function desktopSources(db:DatabaseSync,input:unknown,items:(ids:string[])=>LibraryItem[]):DesktopFileMatches{
 if(!Array.isArray(input)||input.length>100)throw new Error('文件匹配范围无效');
 const requests=input as DesktopFileLookup[],seen=new Set<string>();
 for(const r of requests){
  if(!r||typeof r.entryId!=='string'||r.entryId.length>128||seen.has(r.entryId)||typeof r.rootId!=='string'||r.rootId.length>128||typeof r.relativePath!=='string'||!r.relativePath||r.relativePath.length>4096||r.relativePath.includes('\0')||path.isAbsolute(r.relativePath)||r.relativePath.split(/[\\/]/).includes('..')||!['audio','cue'].includes(r.kind))throw new Error('文件匹配参数无效');
  seen.add(r.entryId);
 }
 const entries:DesktopFileMatches['entries']=[],all=new Set<string>();let truncated=false;
 for(const r of requests){
  const rows=(r.kind==='cue'?db.prepare(`SELECT p.id FROM cue_document d JOIN cue_track t ON t.cue_id=d.id JOIN playable_item p ON p.id=t.item_id WHERE d.root_id=? AND d.relative_path=? ${process.platform==='win32'?'COLLATE NOCASE':''} AND p.visible=1 AND t.hidden=0 ORDER BY t.source_ordinal,p.id LIMIT 501`).all(r.rootId,r.relativePath):
   db.prepare(`SELECT p.id FROM media_file f JOIN playable_item p ON p.file_id=f.id LEFT JOIN cue_track t ON t.item_id=p.id WHERE f.root_id=? AND f.path_key=? AND p.visible=1 AND COALESCE(t.hidden,0)=0 ORDER BY CASE WHEN p.kind='file' THEN 0 ELSE 1 END,t.source_ordinal,p.id LIMIT 501`).all(r.rootId,r.relativePath.normalize('NFKC').toLocaleLowerCase().trim())) as Array<{id:string}>;
  const ids:string[]=[];
  for(const row of rows){if(!all.has(row.id)&&all.size>=500){truncated=true;continue;}all.add(row.id);ids.push(row.id);}
  if(rows.length>500)truncated=true;entries.push({entryId:r.entryId,itemIds:ids.slice(0,500)});
 }
 const clip=(s:string)=>Array.from(s.replace(/[\u0000-\u001f\u007f]/g,' ')).slice(0,256).join('');
 return {entries,items:items([...all]).map(i=>({id:i.id,title:clip(i.title),artist:clip(i.artist),album:clip(i.album),kind:i.kind,available:i.available})),truncated};
}
