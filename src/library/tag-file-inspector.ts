import {readTagRestoreInspectionRequest,readTagRestoreInspectionMessage,type TagRestoreInspectionRequest,type TagRestoreInspectionResult,type TagRestoreInspectionMessage} from '../shared/tag-restore-recovery.js';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {readTagInspectionMessage,TAG_ARTIFACT_ROLES,type TagInspectionRequest,type TagInspectionResult,type TagInspectionMessage} from '../shared/tag-recovery.js';
import {TAG_COMMIT_ARTIFACT_ROLES,readTagCommitInspectionMessage,type TagCommitInspectionRequest,type TagCommitInspectionResult,type TagCommitInspectionMessage} from '../shared/tag-commit-recovery.js';
import {tagWriteKeys,tagWriteUuid} from '../shared/tag-write.js';
type InspectionRequest=TagInspectionRequest|TagCommitInspectionRequest|TagRestoreInspectionRequest;
type InspectionResult=TagInspectionResult|TagCommitInspectionResult|TagRestoreInspectionResult;
type InspectionProgress=Extract<TagInspectionMessage|TagCommitInspectionMessage|TagRestoreInspectionMessage,{kind:'progress'}>;
export class TagInspectionExitUnconfirmed extends Error {}
export class TagFileInspector {
 private active=false;private uncertain=false;
 constructor(private readonly executable:string){}
 get quiescent():boolean{return !this.active&&!this.uncertain;}
 run(request:TagInspectionRequest,onProgress:(v:Extract<TagInspectionMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagInspectionResult>{return this.execute(request,p=>onProgress(p as Extract<TagInspectionMessage,{kind:'progress'}>),signal) as Promise<TagInspectionResult>;}
 runCommit(request:TagCommitInspectionRequest,onProgress:(v:Extract<TagCommitInspectionMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagCommitInspectionResult>{return this.execute(request,p=>onProgress(p as Extract<TagCommitInspectionMessage,{kind:'progress'}>),signal) as Promise<TagCommitInspectionResult>;}
 runRestore(request:TagRestoreInspectionRequest,onProgress:(v:Extract<TagRestoreInspectionMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagRestoreInspectionResult>{return this.execute(request,p=>onProgress(p as Extract<TagRestoreInspectionMessage,{kind:'progress'}>),signal) as Promise<TagRestoreInspectionResult>;}
 private async execute(request:InspectionRequest,onProgress:(v:InspectionProgress)=>void,signal:AbortSignal):Promise<InspectionResult>{
  signal.throwIfAborted();if(!this.quiescent)throw new Error('文件核对进程忙碌或上次退出尚未确认');
  if(process.platform!=='win32'||!path.isAbsolute(this.executable)||path.basename(this.executable)!=='tag-file-inspector.exe')throw new Error('文件核对组件尚未配置');
  if(request.version===3)readTagRestoreInspectionRequest(request);else{
  if(!tagWriteKeys(request,['version','kind','inspectionId','sourceRoot','backupRoot','files'])||!(request.version===1&&request.kind==='inspect'||request.version===2&&request.kind==='inspect-commit')||!tagWriteUuid(request.inspectionId)||!Array.isArray(request.files)||request.files.length!==(request.version===2?4:3))throw new Error('文件核对绑定无效');
  for(const p of [request.sourceRoot,request.backupRoot,...request.files.map((f,i)=>{if(!tagWriteKeys(f,['role','path'])||f.role!==(request.version===2?TAG_COMMIT_ARTIFACT_ROLES:TAG_ARTIFACT_ROLES)[i])throw new Error('文件核对工件身份无效');return f.path;})])if(typeof p!=='string'||!path.isAbsolute(p)||p.length>32767||p.includes('\0'))throw new Error('文件核对路径无效');
  }
  const body=Buffer.from(JSON.stringify(request),'utf8');if(body.length>131072)throw new Error('文件核对请求超过预算');const frame=Buffer.alloc(body.length+4);frame.writeUInt32LE(body.length);body.copy(frame,4);
  this.active=true;try{return await this.launch(request,frame,onProgress,signal);}finally{this.active=false;}
 }
 private launch(request:InspectionRequest,frame:Buffer,onProgress:(v:InspectionProgress)=>void,signal:AbortSignal):Promise<InspectionResult>{return new Promise((resolve,reject)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
  const child=spawn(this.executable,[process.execPath,String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
  let pending=Buffer.alloc(0),last=0,spawned=false,result:InspectionResult|null=null,error:Error|null=null,stderr=0,lastActivity=performance.now(),budget=0,budgetAt=performance.now();
  const decoder=new TextDecoder('utf-8',{fatal:true});const cancel=(e:Error)=>{error??=e;child.stdin.end();};const abort=()=>cancel(signal.reason instanceof Error?signal.reason:new Error('文件核对已请求取消'));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const timer=setInterval(()=>{if(performance.now()-lastActivity>300000)cancel(new Error('文件核对五分钟无进度，等待进程退出'));},10000),deadline=setTimeout(()=>cancel(new Error('文件核对超过八小时预算，等待进程退出')),8*3600000+30000);
  child.once('spawn',()=>{spawned=true;});child.on('error',e=>cancel(e));child.stdin.on('error',()=>cancel(new Error('文件核对输入中断')));child.stdout.on('error',()=>cancel(new Error('文件核对回执管道中断')));
  child.stderr.on('data',(c:Buffer)=>{stderr+=c.length;if(stderr>16384)cancel(new Error('文件核对诊断超过预算'));});child.stderr.on('error',()=>cancel(new Error('文件核对诊断管道中断')));
  child.stdout.on('data',(c:Buffer)=>{if(error)return;try{
   const now=performance.now();if(now-budgetAt>=1000){budgetAt=now;budget=0;}budget+=c.length;if(budget>131072||pending.length+c.length>65540)throw new Error('文件核对输出超过预算');lastActivity=now;pending=Buffer.concat([pending,c]);
   while(pending.length>=4){const size=pending.readUInt32LE();if(!size||size>65536)throw new Error('文件核对帧无效');if(pending.length<size+4)break;
    const data:unknown=JSON.parse(decoder.decode(pending.subarray(4,size+4))),message=request.version===3?readTagRestoreInspectionMessage(data,request.inspectionId,last):request.version===2?readTagCommitInspectionMessage(data,request.inspectionId,last):readTagInspectionMessage(data,request.inspectionId,last);last=message.sequence;pending=pending.subarray(size+4);if(result)throw new Error('文件核对终结后仍有消息');
    if(message.kind==='error')throw new Error(message.message);if(message.kind==='progress')onProgress(message);if(message.kind==='done')result=message.version!==1?{files:message.files,roots:message.roots,parent:message.parent,exclusiveRead:true}:{files:message.files,roots:message.roots,exclusiveRead:true};
   }
  }catch(e){cancel(e instanceof Error?e:new Error(String(e)));}});
  child.once('close',(code,exitSignal)=>{
   clearInterval(timer);clearTimeout(deadline);signal.removeEventListener('abort',abort);
   if(!spawned){reject(error??new Error('文件核对进程未启动'));return;}
   if(code===null||exitSignal||![0,65,66,68,70,71].includes(code)){this.uncertain=true;reject(new TagInspectionExitUnconfirmed('文件核对进程退出尚未确认，请保留恢复占用并重启后核对'));return;}
   if(error||code!==0||pending.length||!result){reject(error??new Error('文件核对未完成或回执不完整'));return;}
   // The single-process Job cannot launch children. close follows actual exit,
   // rather than receipt delivery, so its exclusive handles are already closed.
   resolve(result);
  });
  child.stdin.write(frame,e=>{if(e)cancel(e);});
 });}
}
