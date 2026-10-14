import {spawn} from 'node:child_process';
import path from 'node:path';
import {readTagWorkerStart,readTagWorkerMessage,tagWorkerFrame,type TagWorkerStart,type TagWorkerMessage} from './tag-write-worker-protocol.js';
export class TagWorkerExitUnconfirmed extends Error {}
export type TagWorkerDone=Extract<TagWorkerMessage,{kind:'done'}>;
export class TagWriteWorker {
 private active=false;private uncertain=false;
 constructor(private readonly executable:string){}
 get quiescent():boolean{return !this.active&&!this.uncertain;}
 async run(input:TagWorkerStart,onStage:(value:Extract<TagWorkerMessage,{kind:'stage'}>)=>Promise<void>,onProgress:(value:Extract<TagWorkerMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagWorkerDone> {
  signal.throwIfAborted();if(this.active||this.uncertain)throw new Error('暂存进程忙碌或上次退出尚未确认');if(process.platform!=='win32'||!path.isAbsolute(this.executable))throw new Error('标签暂存监督组件尚未配置');
  const request=readTagWorkerStart(input),frame=tagWorkerFrame(request);this.active=true;
  try{return await this.launch(request,frame,onStage,onProgress,signal);}finally{this.active=false;}
 }
 private launch(request:TagWorkerStart,frame:Buffer,onStage:(value:Extract<TagWorkerMessage,{kind:'stage'}>)=>Promise<void>,onProgress:(value:Extract<TagWorkerMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagWorkerDone> {
  return new Promise((resolve,reject)=>{
   const env:NodeJS.ProcessEnv={ELECTRON_RUN_AS_NODE:'1'};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
   const child=spawn(this.executable,[process.execPath,path.resolve(__dirname,'tag-write-worker-entry.js'),String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
   let pending=Buffer.alloc(0),last=0,stages=0,queued=0,closed=false,spawned=false,done:TagWorkerDone|null=null,error:Error|null=null,chain:Promise<void>=Promise.resolve(),stderr=0,budget=0,budgetAt=performance.now(),lastActivity=performance.now();
   const decoder=new TextDecoder('utf-8',{fatal:true});
   const cancel=(e:Error)=>{error??=e;child.stdin.end();};
   const abort=()=>cancel(signal.reason instanceof Error?signal.reason:new Error('标签暂存已请求取消'));
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   const timer=setInterval(()=>{if(performance.now()-lastActivity>5*60*1000)cancel(new Error('标签暂存超过五分钟无进度，等待进程退出'));},10000);
   const deadline=setTimeout(()=>cancel(new Error('标签暂存超过八小时预算，等待进程退出')),8*60*60*1000+30000);
   child.once('spawn',()=>{spawned=true;});child.on('error',e=>cancel(e));child.stdin.on('error',()=>cancel(new Error('标签暂存输入中断')));
   child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.length;if(stderr>16384)cancel(new Error('标签暂存诊断输出超过预算'));});child.stderr.on('error',()=>cancel(new Error('标签暂存诊断管道中断')));
   child.stdout.on('data',(chunk:Buffer)=>{
    if(error)return;
    try{
     const now=performance.now();if(now-budgetAt>=1000){budgetAt=now;budget=0;}budget+=chunk.length;if(budget>128*1024||pending.length+chunk.length>65540)throw new Error('标签暂存输出超过预算');pending=Buffer.concat([pending,chunk]);lastActivity=now;
     while(pending.length>=4){const size=pending.readUInt32LE();if(!size||size>65536)throw new Error('标签暂存输出帧大小无效');if(pending.length<size+4)break;
      if(last>=131072||queued>=16)throw new Error('标签暂存消息数量超过预算');const message=readTagWorkerMessage(JSON.parse(decoder.decode(pending.subarray(4,size+4))),request.executionId,last);last=message.sequence;pending=pending.subarray(size+4);queued++;
      chain=chain.then(async()=>{
       if(error)return;if(done)throw new Error('标签暂存终结后仍有消息');
       if(message.kind==='error')throw new Error(message.message);
       if(message.kind==='progress'){if(message.total!==request.plan.preview.sourceFileBytes&&message.total!==request.plan.preview.audioBytes&&message.total!==request.plan.preview.targetFileBytes)throw new Error('标签暂存进度总量不属于计划');onProgress(message);}
       if(message.kind==='stage'){
        if(message.stage!==['validated','backup_ready','temp_written'][stages])throw new Error('标签暂存阶段跳跃或重复');await onStage(message);signal.throwIfAborted();if(closed||error)throw new Error('标签暂存进程已关闭，不能确认阶段');
        await new Promise<void>((yes,no)=>child.stdin.write(tagWorkerFrame({version:1,kind:'ack',executionId:request.executionId,sequence:message.sequence},4096),e=>e?no(e):yes()));stages++;
       }
       if(message.kind==='done'){if(stages!==3)throw new Error('标签暂存完成前缺少阶段日志');done=message;}
      }).catch(e=>cancel(e instanceof Error?e:new Error(String(e)))).finally(()=>{queued--;});
     }
    }catch(e){cancel(e instanceof Error?e:new Error(String(e)));}
   });
   child.stdout.on('error',()=>cancel(new Error('标签暂存回执管道中断')));
   child.once('close',(code,exitSignal)=>{
    closed=true;clearInterval(timer);clearTimeout(deadline);signal.removeEventListener('abort',abort);
    void chain.then(()=>{
     if(!spawned){reject(error??new Error('标签暂存进程未启动'));return;}
     if(code===null||exitSignal||![0,65,66,67,68,69,70,71].includes(code)){this.uncertain=true;reject(new TagWorkerExitUnconfirmed('标签暂存监督进程退出不明确，保留文件租约等待恢复'));return;}
     if(error||code!==0||!done||pending.length){reject(error??new Error('标签暂存未完成或回执不完整'));return;}resolve(done);
    }).catch(reject);
   });
   child.stdin.write(frame,e=>{if(e)cancel(e);});
  });
 }
}
