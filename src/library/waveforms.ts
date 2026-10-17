import {PCM_ANALYSIS_REVISION} from '../shared/pcm-analysis-revision.js';
import {samplePlayRange} from '../shared/source-sample-range.js';
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import type {LibraryItem,WaveformSummary,WaveformJob} from '../shared/contracts.js';
import {validDsdPcmConversion} from '../shared/dsd-pcm.js';
const algorithm='minmax-f32-v4-sample-span-ma-0.11.25-ff-8.1.3-dsdpcm-v1',uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,hex=/^[0-9a-f]{64}$/;
const fingerprint=(item:LibraryItem)=>createHash('sha256').update(JSON.stringify([PCM_ANALYSIS_REVISION,algorithm,item.fileId,item.path,item.kind,item.sourceStartCueFrame,item.sourceEndCueFrame,item.sourceStartSeconds,item.sourceEndSeconds,item.sourceSampleRange??null])).digest('hex');
export const waveformSchema=`
 CREATE TABLE waveform_cache(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),bytes INTEGER NOT NULL CHECK(bytes>0),last_access INTEGER NOT NULL);
 CREATE TABLE waveform_reference(fingerprint TEXT PRIMARY KEY,cache_id TEXT NOT NULL REFERENCES waveform_cache(id) ON DELETE CASCADE);
 CREATE TABLE waveform_job(id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('queued','running','cancelling','completed','failed','cancelled','interrupted')),phase TEXT NOT NULL CHECK(phase IN('waiting','hashing','decoding','done')),progress REAL NOT NULL DEFAULT 0 CHECK(progress>=0 AND progress<=1),cache_id TEXT REFERENCES waveform_cache(id) ON DELETE SET NULL,cached INTEGER NOT NULL DEFAULT 0 CHECK(cached IN(0,1)),message TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
 CREATE INDEX waveform_cache_lru ON waveform_cache(last_access,id);
 CREATE INDEX waveform_job_recent ON waveform_job(created_at DESC,id DESC);
 CREATE INDEX waveform_job_active ON waveform_job(status) WHERE status IN('queued','running','cancelling');
 CREATE TRIGGER waveform_job_identity BEFORE UPDATE OF id,item_id,fingerprint,created_at ON waveform_job BEGIN SELECT RAISE(ABORT,'分析任务身份不可改写'); END;
`;
function validSummary(value:unknown):value is WaveformSummary{
 if(!value||typeof value!=='object')return false;const data=value as WaveformSummary;
 if(!data.decoder||!['miniaudio','ffmpeg-8.1.3'].includes(data.decoder.backend)||typeof data.decoder.codec!=='string'||data.decoder.codec.length>64||data.decoder.certification!=='pending')return false;
 if(data.dsdConversion!=null&&(!validDsdPcmConversion(data.dsdConversion)||data.decoder.backend!=='ffmpeg-8.1.3'||!data.decoder.codec.startsWith('dsd_')||data.sampleRate!==176400)||data.decoder.codec.startsWith('dsd_')&&!data.dsdConversion)return false;
 const decimal=(n:unknown):n is string=>typeof n==='string'&&/^\d{1,16}$/.test(n)&&BigInt(n)<=BigInt(Number.MAX_SAFE_INTEGER);
 if(data.version!==1||data.algorithm!==algorithm||!hex.test(data.sha256)||!Number.isInteger(data.sampleRate)||data.sampleRate<1||data.sampleRate>1536000||!Number.isInteger(data.channels)||data.channels<1||data.channels>16||!decimal(data.startFrame)||!decimal(data.endFrame)||BigInt(data.startFrame)>=BigInt(data.endFrame)||!decimal(data.invalidSamples)||!Number.isFinite(data.durationSeconds)||data.durationSeconds<=0||Math.abs(data.durationSeconds-Number(BigInt(data.endFrame)-BigInt(data.startFrame))/data.sampleRate)>1e-6||!Number.isFinite(data.peakDb)||data.peakDb< -96||data.peakDb>24||!Number.isFinite(data.rmsDb)||data.rmsDb< -96||data.rmsDb>data.peakDb+0.01||!Array.isArray(data.levels)||!data.levels.length||data.levels.length>4)return false;
 let last=0;for(const level of data.levels){if(!Number.isInteger(level.points)||level.points<=last||level.points>8192||(level.points&(level.points-1))!==0||!Array.isArray(level.values)||level.values.length!==level.points||!level.values.every(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=16)&&pair[0]<=pair[1]))return false;last=level.points;}return true;
}
type Row={id:string;item_id:string;fingerprint:string;status:WaveformJob['status'];phase:WaveformJob['phase'];progress:number;cache_id:string|null;cached:number;message:string|null;created_at:number;updated_at:number};
export class WaveformRepository{
 constructor(private readonly db:DatabaseSync){}
 interrupted():void{this.db.prepare("UPDATE waveform_job SET status='interrupted',message='应用已重启，未完成的分析需要重新发起',updated_at=? WHERE status IN('queued','running','cancelling')").run(Date.now());}
 row(id:string):Row{if(typeof id!=='string'||!uuid.test(id))throw new Error('无效分析任务');const value=this.db.prepare('SELECT * FROM waveform_job WHERE id=?').get(id) as Row|undefined;if(!value)throw new Error('分析任务不存在');return value;}
 prior(id:string):Row|undefined{return this.db.prepare('SELECT * FROM waveform_job WHERE id=?').get(id) as Row|undefined;}
 create(id:string,item:LibraryItem):void{const now=Date.now();this.db.prepare("INSERT INTO waveform_job(id,item_id,fingerprint,status,phase,created_at,updated_at) VALUES(?,?,?,'queued','waiting',?,?)").run(id,item.id,fingerprint(item),now,now);}
 cache(key:string):WaveformSummary|null{const row=this.db.prepare('SELECT payload_json FROM waveform_reference r JOIN waveform_cache c ON c.id=r.cache_id WHERE r.fingerprint=?').get(key) as {payload_json:string}|undefined;try{const value=row?JSON.parse(row.payload_json):null;return validSummary(value)?value:null;}catch{return null;}}
 view(id:string,includeSummary=true):WaveformJob{const row=this.row(id),cache=includeSummary&&row.cache_id?this.db.prepare('SELECT payload_json FROM waveform_cache WHERE id=?').get(row.cache_id) as {payload_json:string}|undefined:undefined;let summary:WaveformSummary|null=null;try{const value=cache?JSON.parse(cache.payload_json):null;if(validSummary(value))summary=value;}catch{}return {id:row.id,itemId:row.item_id,status:row.status,phase:row.phase,progress:row.progress,cached:row.cached===1,message:includeSummary&&row.status==='completed'&&!summary?'缓存不可用，请重新分析':row.message,createdAt:row.created_at,updatedAt:row.updated_at,summary:row.status==='completed'?summary:null};}
 list():WaveformJob[]{return (this.db.prepare('SELECT id FROM waveform_job ORDER BY created_at DESC,id DESC LIMIT 20').all() as {id:string}[]).map(row=>this.view(row.id,false));}
 state(id:string,status:WaveformJob['status'],message:string|null=null):void{this.db.prepare("UPDATE waveform_job SET status=?,message=?,updated_at=? WHERE id=? AND status NOT IN('completed','cancelled','failed','interrupted')").run(status,message,Date.now(),id);}
 progress(id:string,phase:'hashing'|'decoding',progress:number,stage?:'measuring'|'positioning'|'building'):void{const row=this.row(id);if(row.status!=='running'||row.phase==='decoding'&&phase==='hashing'||row.phase===phase&&progress<row.progress)return;const message=stage==='measuring'?'统计实际音频帧（进度为文件读取估计）':stage==='positioning'?'读取当前曲目起点':null;this.db.prepare('UPDATE waveform_job SET phase=?,progress=?,message=?,updated_at=? WHERE id=?').run(phase,progress,message,Date.now(),id);}
 complete(id:string,summary:WaveformSummary,cached:boolean):void{
  if(!validSummary(summary))throw new Error('无效波形结果');const row=this.row(id);if(row.status!=='running')throw new Error('分析已取消');
  const payload=JSON.stringify(summary),bytes=Buffer.byteLength(payload);if(bytes>524288)throw new Error('波形结果超限');const key=createHash('sha256').update(JSON.stringify([PCM_ANALYSIS_REVISION,algorithm,summary.sha256,summary.sampleRate,summary.channels,summary.startFrame,summary.endFrame])).digest('hex');
  this.db.exec('BEGIN IMMEDIATE');try{
   const now=Date.now();this.db.prepare('INSERT INTO waveform_cache VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json,bytes=excluded.bytes,last_access=excluded.last_access').run(key,summary.sha256,payload,bytes,now);
   this.db.prepare('INSERT INTO waveform_reference VALUES(?,?) ON CONFLICT(fingerprint) DO UPDATE SET cache_id=excluded.cache_id').run(row.fingerprint,key);
   this.db.prepare("UPDATE waveform_job SET status='completed',phase='done',progress=1,cache_id=?,cached=?,message=NULL,updated_at=? WHERE id=?").run(key,cached?1:0,now,id);
   const totals=this.db.prepare('SELECT COALESCE(SUM(bytes),0) bytes,COUNT(*) entries FROM waveform_cache').get() as {bytes:number;entries:number};let total=Number(totals.bytes),entries=Number(totals.entries);
   if(total>32*1024*1024||entries>1024)for(const value of this.db.prepare('SELECT id,bytes FROM waveform_cache WHERE id<>? ORDER BY last_access,id').all(key) as {id:string;bytes:number}[]){if(total<=32*1024*1024&&entries<=1024)break;this.db.prepare('DELETE FROM waveform_cache WHERE id=?').run(value.id);total-=value.bytes;--entries;}
   this.db.exec('COMMIT');
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
}
type Source={item:LibraryItem;rootPath:string};
type Active={id:string;child:ChildProcessWithoutNullStreams|null;cancelled:boolean;finished:Promise<void>;finish:()=>void};
export class WaveformManager{
 private queue:string[]=[];private active:Active|null=null;
 private maintenanceOwner:string|null=null;
 async beginMaintenance(owner:string):Promise<void>{
  if(!owner||this.maintenanceOwner&&this.maintenanceOwner!==owner)throw new Error('波形维护身份不符');this.maintenanceOwner=owner;
  const active=this.active;if(active){this.cancel(active.id);await active.finished;}if(this.active)throw new Error('波形进程尚未退出，不能建立快照');
 }
 endMaintenance(owner:string):void{if(this.maintenanceOwner!==owner||this.active)throw new Error('波形维护尚未完成或身份不符');this.maintenanceOwner=null;void this.pump();}
 constructor(private readonly repo:WaveformRepository,private readonly executable:string,private readonly resolve:(id:string)=>Source,private readonly fileIdForItem?:(itemId:string)=>string|undefined,deferRecovery=false){if(!deferRecovery)repo.interrupted();}
 async quiesceFile(fileId:string):Promise<void>{
  if(!this.fileIdForItem)throw new Error('波形读取尚未配置文件身份协调');
  for(const id of [...this.queue])if(this.fileIdForItem(this.repo.row(id).item_id)===fileId)this.cancel(id);
  const active=this.active;if(active&&this.fileIdForItem(this.repo.row(active.id).item_id)===fileId){this.cancel(active.id);await active.finished;}
 }
 request(itemId:string,id:string):WaveformJob{
  if(this.maintenanceOwner)throw new Error('曲库正在维护，暂不开始波形分析');
  if(typeof id!=='string'||!uuid.test(id)||typeof itemId!=='string'||!itemId||itemId.length>128)throw new Error('无效波形请求');
  const prior=this.repo.prior(id);if(prior){if(prior.item_id!==itemId)throw new Error('分析任务 ID 已用于不同曲目');return this.repo.view(id);}
  const {item}=this.resolve(itemId);if(!item.available)throw new Error('音乐文件当前不可用');if(!['.flac','.wav','.wave','.mp3','.m4a','.aac','.ogg','.oga','.opus','.dsf','.dff'].includes(path.extname(item.path).toLowerCase()))throw new Error('当前格式尚未接入整曲波形分析');
  if(this.queue.length+(this.active?1:0)>=3)throw new Error('分析任务已满，请等待或取消已有任务');this.repo.create(id,item);this.queue.push(id);void this.pump();return this.repo.view(id);
 }
 view(id:string):WaveformJob{return this.repo.view(id);}
 list():WaveformJob[]{return this.repo.list();}
 cancel(id:string):WaveformJob{const row=this.repo.row(id);if(this.active?.id===id&&row.status!=='completed'){this.active.cancelled=true;this.repo.state(id,'cancelling','已请求取消，正在等待分析进程退出');this.active.child?.kill();}else if(row.status==='queued'){this.queue=this.queue.filter(value=>value!==id);this.repo.state(id,'cancelled','分析已取消');}return this.repo.view(id);}
 private async pump():Promise<void>{
  if(this.active||this.maintenanceOwner)return;const id=this.queue.shift();if(!id)return;let finish!:()=>void;const finished=new Promise<void>(resolve=>{finish=resolve;});const active:Active={id,child:null,cancelled:false,finished,finish};this.active=active;
  try{this.repo.state(id,'running');await this.run(active);if(active.cancelled)this.repo.state(id,'cancelled','分析已取消');}
  catch{try{this.repo.state(id,active.cancelled?'cancelled':'failed',active.cancelled?'分析已取消':'音乐文件不可用、分析组件缺失、内容损坏或任务中断');}catch{/* A failed durable update must not crash the library service. */}}
  finally{active.finish();if(this.active===active)this.active=null;void this.pump();}
 }
 private async run(active:Active):Promise<void>{
  const row=this.repo.row(active.id),source=this.resolve(row.item_id);if(!source.item.available||fingerprint(source.item)!==row.fingerprint)throw new Error('曲目范围已变化');
  const [filename,root]=await Promise.all([realpath(source.item.path),realpath(source.rootPath)]);const relative=path.relative(root,filename);
  if(!relative||relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative)||!(await stat(filename)).isFile())throw new Error('文件不属于当前曲库目录');if(active.cancelled)return;
  const cached=this.repo.cache(row.fingerprint),item=source.item;
  const exactRange=samplePlayRange(item);
  const request={version:2,algorithm,parentPid:process.pid,path:filename,rootPath:root,...(exactRange?{sampleRange:exactRange}:{}),startSeconds:item.sourceStartSeconds,endSeconds:item.sourceEndSeconds??-1,startCueFrame:item.sourceStartCueFrame,endCueFrame:item.sourceEndCueFrame,cachedSha256:cached?.sha256??''};
  const encode=(value:unknown)=>{const body=Buffer.from(JSON.stringify(value));if(body.length>131072)throw new Error('分析请求超限');const result=Buffer.allocUnsafe(body.length+4);result.writeUInt32LE(body.length);body.copy(result,4);return result;};
  const input=encode(request);
  await new Promise<void>((resolve,reject)=>{
   const child=spawn(this.executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});active.child=child;
   let pending=Buffer.alloc(0),error=false,complete=false,events=0,stderr=0;const decoder=new TextDecoder('utf-8',{fatal:true});
   const abort=()=>{error=true;child.kill();};
   const timer=setTimeout(abort,30*60*1000);
   child.on('error',()=>{error=true;});child.stdin.on('error',abort);
   child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>4096)abort();});
   child.stdout.on('data',(chunk:Buffer)=>{try{
    pending=Buffer.concat([pending,chunk]);if(pending.length>1048576)throw new Error();
    while(pending.length>=4){const size=pending.readUInt32LE();if(!size||size>524288)throw new Error();if(pending.length<size+4)break;const message=JSON.parse(decoder.decode(pending.subarray(4,size+4)));pending=pending.subarray(size+4);if(++events>5000||complete||!message||typeof message!=='object')throw new Error();
     if(message.kind==='progress'){if(!['hashing','decoding'].includes(message.phase)||typeof message.progress!=='number'||!Number.isFinite(message.progress)||message.progress<0||message.progress>1||message.stage!==undefined&&(!['measuring','positioning','building'].includes(message.stage)||message.phase!=='decoding'))throw new Error();this.repo.progress(active.id,message.phase,message.progress,message.stage);}
     else if(message.kind==='complete'){
      const current=this.resolve(row.item_id).item;
      if(active.cancelled||!current.available||typeof message.cached!=='boolean'||typeof message.sha256!=='string'||!hex.test(message.sha256)||fingerprint(current)!==row.fingerprint)throw new Error();
      const summary=message.cached?cached:message.summary;if(!validSummary(summary)||summary.sha256!==message.sha256||exactRange&&(summary.sampleRate!==exactRange.sampleRate||summary.startFrame!==exactRange.startFrame||summary.endFrame!==exactRange.endFrame))throw new Error();this.repo.complete(active.id,summary,message.cached);complete=true;child.stdin.end(encode({kind:'commit'}));
     }else throw new Error();
    }
   }catch{abort();}});
   child.once('close',code=>{clearTimeout(timer);active.child=null;if(!error&&complete&&code===0&&!pending.length)resolve();else reject(new Error('分析未完成'));});
   child.stdin.write(input);if(active.cancelled)child.kill();
  });
 }
}
