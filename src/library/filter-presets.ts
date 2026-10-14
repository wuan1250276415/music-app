import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {FILTER_PRESET_LIMIT,FILTER_PRESET_PAGE_SIZE,filterPresetId,readFilterPresetDefinition,readFilterPresetDetail,readFilterPresetMutation,readFilterPresetPageRequest,type FilterPresetDetail,type FilterPresetMutation,type FilterPresetPage,type FilterPresetResult,type FilterPresetSummary} from '../shared/filter-presets.js';

export const filterPresetSchema=`
 CREATE TABLE music_filter_preset(id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740990),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,definition_json TEXT NOT NULL CHECK(json_valid(definition_json) AND length(definition_json)<=16384));
 CREATE TABLE music_filter_preset_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991));
 INSERT INTO music_filter_preset_clock VALUES(1,0);
 CREATE TRIGGER music_filter_preset_budget BEFORE INSERT ON music_filter_preset WHEN (SELECT COUNT(*) FROM music_filter_preset)>=1024 BEGIN SELECT RAISE(ABORT,'筛选预设最多1024个'); END;
 CREATE TRIGGER music_filter_preset_insert AFTER INSERT ON music_filter_preset BEGIN UPDATE music_filter_preset_clock SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER music_filter_preset_update AFTER UPDATE ON music_filter_preset BEGIN UPDATE music_filter_preset_clock SET revision=revision+1 WHERE id=1; END;
 CREATE TRIGGER music_filter_preset_delete AFTER DELETE ON music_filter_preset BEGIN UPDATE music_filter_preset_clock SET revision=revision+1 WHERE id=1; END;
`;
type Row=FilterPresetSummary&{definition_json:string};
type Receipt={fingerprint:string;result_json:string};
function fingerprint(request:FilterPresetMutation):string{
 return createHash('sha256').update('music-filter-preset-v1:').update(JSON.stringify(request)).digest('hex');
}
export class FilterPresets {
 private readonly epoch=randomUUID();
 constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(fn:()=>T)=>T){}
 private stamp():string{
  const row=this.db.prepare('SELECT revision FROM music_filter_preset_clock WHERE id=1').get() as {revision:number}|undefined;
  if(!row)throw new Error('筛选预设目录修订缺失');
  const external=this.db.prepare('PRAGMA main.data_version').get() as {data_version:number};
  return createHash('sha256').update(`filter-presets-v1:${this.epoch}:${row.revision}:${external.data_version}`).digest('hex');
 }
 get(value:unknown):FilterPresetDetail{
  const row=this.db.prepare('SELECT id,name,revision,created_at createdAt,updated_at updatedAt,definition_json FROM music_filter_preset WHERE id=?').get(filterPresetId(value)) as Row|undefined;
  if(!row)throw new Error('筛选预设不存在或已删除');
  const {definition_json,...summary}=row;
  return readFilterPresetDetail({...summary,definition:readFilterPresetDefinition(JSON.parse(definition_json))});
 }
 list(value:unknown):FilterPresetPage{
  const request=readFilterPresetPageRequest(value),before=this.stamp();
  const stale=():FilterPresetPage=>({version:1,status:'stale',snapshot:this.stamp(),offset:request.offset,total:0,items:[]});
  if(request.snapshot&&request.snapshot!==before)return stale();
  const total=Number((this.db.prepare('SELECT COUNT(*) n FROM music_filter_preset').get() as {n:number}).n);
  const items=this.db.prepare('SELECT id,name,revision,created_at createdAt,updated_at updatedAt FROM music_filter_preset ORDER BY aural_natural_key_v1(name),id LIMIT ? OFFSET ?').all(FILTER_PRESET_PAGE_SIZE,request.offset) as FilterPresetSummary[];
  return this.stamp()===before?{version:1,status:'ready',snapshot:before,offset:request.offset,total,items}:stale();
 }
 result(value:unknown):FilterPresetResult&{changed:boolean}{
  const request=readFilterPresetMutation(value);
  try{
   const result=this.mutate(request);
   return {commandId:request.commandId,status:'saved',value:result.value,error:'',changed:result.changed};
  }catch(error){
   if(this.db.isTransaction)throw error;
   // A commit can succeed before its caller observes success. Reconcile the original receipt.
   const receipt=this.receipt(request.commandId);
   if(receipt?.fingerprint===fingerprint(request))return {commandId:request.commandId,status:'saved',value:this.readReceipt(receipt),error:'',changed:false};
   return {commandId:request.commandId,status:'rejected',value:null,error:String(error instanceof Error?error.message:error).slice(0,512),changed:false};
  }
 }
 private receipt(commandId:string):Receipt|undefined{
  return this.db.prepare('SELECT fingerprint,result_json FROM user_command_receipt WHERE command_id=?').get(commandId) as Receipt|undefined;
 }
 private readReceipt(receipt:Receipt):FilterPresetDetail|null{
  const value:unknown=JSON.parse(receipt.result_json);return value===null?null:readFilterPresetDetail(value);
 }
 private mutate(request:FilterPresetMutation):{value:FilterPresetDetail|null;changed:boolean}{
  return this.transaction(()=>{
   const digest=fingerprint(request),receipt=this.receipt(request.commandId);
   if(receipt){if(receipt.fingerprint!==digest)throw new Error('操作身份已用于另一请求');return {value:this.readReceipt(receipt),changed:false};}
   const before=request.action==='create'?null:this.get(request.id);
   if(request.action!=='create'&&before!.revision!==request.baseRevision)throw new Error('筛选预设已变化，请重新读取后编辑');
   if(request.action==='update'&&before&&before.revision>=Number.MAX_SAFE_INTEGER-1)throw new Error('筛选预设修订已到上限');
   const id=before?.id??randomUUID(),now=new Date().toISOString();
   if(request.action==='create'){
    const count=Number((this.db.prepare('SELECT COUNT(*) n FROM music_filter_preset').get() as {n:number}).n);
    if(count>=FILTER_PRESET_LIMIT)throw new Error('筛选预设最多1024个，请删除不用的预设后再保存');
    this.db.prepare('INSERT INTO music_filter_preset VALUES(?,?,0,?,?,?)').run(id,request.name,now,now,JSON.stringify(request.definition));
   }else if(request.action==='update'){
    this.db.prepare('UPDATE music_filter_preset SET name=?,revision=revision+1,updated_at=?,definition_json=? WHERE id=? AND revision=?').run(request.name,now,JSON.stringify(request.definition),id,request.baseRevision);
   }else this.db.prepare('DELETE FROM music_filter_preset WHERE id=? AND revision=?').run(id,request.baseRevision);
   const result=request.action==='delete'?null:this.get(id);
   this.db.prepare('INSERT INTO user_command_receipt VALUES(?,?,?,?)').run(request.commandId,digest,JSON.stringify(result),now);
   return {value:result,changed:true};
  });
 }
}
