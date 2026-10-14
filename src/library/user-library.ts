import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import type { ItemUserState, PlaylistEditRequest, PlaylistPlaybackContext, PlaylistSummary, UserStateRequest } from '../shared/contracts.js';

const MAX_PLAYLIST_ENTRIES=500;
function checkedId(value:unknown):asserts value is string {
  if(typeof value!=='string'||!value.length||value.length>128)throw new Error('无效曲目或歌单 ID');
}
function checkedRevision(value:unknown):asserts value is number {
  if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('无效基础版本');
}
function checkedName(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.trim().length>120||/[\u0000-\u001f]/.test(value))throw new Error('歌单名称需为 1–120 个字符');
  return value.trim();
}

export class UserLibraryRepository {
  constructor(private readonly db:DatabaseSync){}

  private command<T>(commandId:unknown,identity:unknown,action:()=>T):T {
    if(typeof commandId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效用户数据命令 ID');
    const fingerprint=createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const receipt=this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as {fingerprint:string;result_json:string}|undefined;
      if(receipt){
        if(receipt.fingerprint!==fingerprint)throw new Error('用户数据命令 ID 已用于不同操作');
        const result=JSON.parse(receipt.result_json) as T;this.db.exec('COMMIT');return result;
      }
      const result=action();
      this.db.prepare('INSERT INTO user_command_receipt(command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?)')
        .run(commandId,fingerprint,JSON.stringify(result),new Date().toISOString());
      this.db.exec('COMMIT');return result;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  state(itemId:string):ItemUserState {
    checkedId(itemId);
    if(!this.db.prepare('SELECT id FROM playable_item WHERE id=?').get(itemId))throw new Error('曲目不存在');
    const row=this.db.prepare('SELECT favorite,rating,revision FROM item_user_state WHERE item_id=?').get(itemId) as {favorite:number;rating:number;revision:number}|undefined;
    return {itemId,favorite:row?.favorite===1,rating:row?.rating??0,revision:row?.revision??0};
  }

  setState(request:UserStateRequest):ItemUserState {
    if(!request||typeof request!=='object')throw new Error('无效用户状态');
    checkedId(request.itemId);checkedRevision(request.baseRevision);
    if(request.favorite===undefined&&request.rating===undefined)throw new Error('缺少用户状态变更');
    if(request.favorite!==undefined&&typeof request.favorite!=='boolean')throw new Error('无效收藏状态');
    if(request.rating!==undefined&&(!Number.isInteger(request.rating)||request.rating<0||request.rating>5))throw new Error('评分需为 0–5');
    return this.command(request.commandId,['state',request.itemId,request.baseRevision,request.favorite??null,request.rating??null],()=>{
      const before=this.state(request.itemId);
      if(before.revision!==request.baseRevision)throw new Error('曲目用户状态已变化，请刷新后重试');
      const after={...before,favorite:request.favorite??before.favorite,rating:request.rating??before.rating,revision:before.revision+1};
      this.db.prepare(`INSERT INTO item_user_state(item_id,favorite,rating,revision,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET favorite=excluded.favorite,rating=excluded.rating,revision=excluded.revision,updated_at=excluded.updated_at`)
        .run(after.itemId,after.favorite?1:0,after.rating,after.revision,new Date().toISOString());
      return after;
    });
  }

  playlists():PlaylistSummary[] {
    const rows=this.db.prepare(`SELECT p.id,p.name,p.revision,p.created_at createdAt,p.updated_at updatedAt,COUNT(e.entry_id) count
      FROM playlist p LEFT JOIN playlist_item e ON e.playlist_id=p.id WHERE p.kind='static' GROUP BY p.id ORDER BY p.created_at,p.id`).all() as unknown as PlaylistSummary[];
    return rows.map(row=>({...row}));
  }

  playlist(id:string):PlaylistSummary {
    checkedId(id);
    const row=this.db.prepare(`SELECT p.id,p.name,p.revision,p.created_at createdAt,p.updated_at updatedAt,
      (SELECT COUNT(*) FROM playlist_item WHERE playlist_id=p.id) count FROM playlist p WHERE p.id=? AND p.kind='static'`).get(id) as PlaylistSummary|undefined;
    if(!row)throw new Error('歌单不存在');
    return {...row};
  }

  create(name:string,commandId:string,itemIds:string[]=[]):PlaylistSummary {
    const clean=checkedName(name);
    if(!Array.isArray(itemIds)||itemIds.length>MAX_PLAYLIST_ENTRIES)throw new Error('歌单最多可添加 500 项');
    itemIds.forEach(checkedId);
    return this.command(commandId,['create',clean,itemIds],()=>{
      const id=randomUUID(),now=new Date().toISOString();
      this.db.prepare("INSERT INTO playlist(id,name,kind,revision,created_at,updated_at) VALUES(?,?,'static',0,?,?)").run(id,clean,now,now);
      const insert=this.db.prepare('INSERT INTO playlist_item(playlist_id,entry_id,item_id,position) VALUES(?,?,?,?)');
      itemIds.forEach((itemId,index)=>{
        if(!this.db.prepare('SELECT id FROM playable_item WHERE id=?').get(itemId))throw new Error('待添加曲目不存在');
        insert.run(id,randomUUID(),itemId,index);
      });
      return this.playlist(id);
    });
  }

  edit(request:PlaylistEditRequest):PlaylistSummary|null {
    if(!request||typeof request!=='object')throw new Error('无效歌单变更');
    checkedId(request.playlistId);checkedRevision(request.baseRevision);
    if(!['rename','delete','add','remove','move'].includes(request.action))throw new Error('无效歌单操作');
    const name=request.action==='rename'?checkedName(request.name):null;
    if(request.action==='add'){
      if(!Array.isArray(request.itemIds)||!request.itemIds.length||request.itemIds.length>MAX_PLAYLIST_ENTRIES)throw new Error('一次可添加 1–500 个曲目');
      request.itemIds.forEach(checkedId);
    }
    if(request.action==='remove'||request.action==='move')checkedId(request.entryId);
    if(request.action==='move'&&request.direction!==-1&&request.direction!==1)throw new Error('无效移动方向');
    const identity=request.action==='rename'?['rename',name]:request.action==='add'?['add',request.itemIds]:
      request.action==='delete'?['delete']:[request.action,request.entryId,request.action==='move'?request.direction:null];
    return this.command(request.commandId,[request.playlistId,request.baseRevision,...identity],()=>{
      const before=this.playlist(request.playlistId);
      if(before.revision!==request.baseRevision)throw new Error('歌单版本已变化，请刷新后重试');
      if(request.action==='delete'){
        this.db.prepare('DELETE FROM playlist WHERE id=?').run(before.id);return null;
      }
      if(request.action==='rename')this.db.prepare('UPDATE playlist SET name=? WHERE id=?').run(name!,before.id);
      if(request.action==='add'){
        if(before.count+request.itemIds.length>MAX_PLAYLIST_ENTRIES)throw new Error('当前歌单最多 500 项，未添加任何曲目');
        const insert=this.db.prepare('INSERT INTO playlist_item(playlist_id,entry_id,item_id,position) VALUES(?,?,?,?)');
        request.itemIds.forEach((itemId,index)=>{
          if(!this.db.prepare('SELECT id FROM playable_item WHERE id=?').get(itemId))throw new Error('待添加曲目不存在');
          insert.run(before.id,randomUUID(),itemId,before.count+index);
        });
      }
      if(request.action==='remove'||request.action==='move'){
        const entries=this.db.prepare('SELECT entry_id FROM playlist_item WHERE playlist_id=? ORDER BY position').all(before.id) as unknown as Array<{entry_id:string}>;
        const index=entries.findIndex(entry=>entry.entry_id===request.entryId);
        if(index<0)throw new Error('歌单条目不存在');
        if(request.action==='remove'){
          this.db.prepare('DELETE FROM playlist_item WHERE playlist_id=? AND entry_id=?').run(before.id,request.entryId);entries.splice(index,1);
        }else{
          const target=index+request.direction;
          if(target<0||target>=entries.length)throw new Error('无法移动歌单条目');
          [entries[index],entries[target]]=[entries[target],entries[index]];
        }
        // Move every position out of the final range before assigning unique dense positions.
        this.db.prepare('UPDATE playlist_item SET position=position+1000 WHERE playlist_id=?').run(before.id);
        const position=this.db.prepare('UPDATE playlist_item SET position=? WHERE playlist_id=? AND entry_id=?');
        entries.forEach((entry,index)=>position.run(index,before.id,entry.entry_id));
      }
      this.db.prepare('UPDATE playlist SET revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(),before.id);
      return this.playlist(before.id);
    });
  }

  playbackContext(playlistId:string,entryId:string,revision:number):PlaylistPlaybackContext {
    checkedId(entryId);checkedRevision(revision);
    this.db.exec('BEGIN');
    try{
    const playlist=this.playlist(playlistId);
    if(playlist.revision!==revision)throw new Error('歌单版本已变化，请刷新后重试');
    const entries=this.db.prepare('SELECT entry_id id,item_id itemId FROM playlist_item WHERE playlist_id=? ORDER BY position').all(playlistId) as unknown as Array<{id:string;itemId:string}>;
    if(entries.length>MAX_PLAYLIST_ENTRIES)throw new Error('歌单超过当前播放队列容量');
    const startIndex=entries.findIndex(entry=>entry.id===entryId);
    if(startIndex<0)throw new Error('歌单条目不存在');
    const context={playlistId,revision,entries,startIndex};this.db.exec('COMMIT');return context;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}
