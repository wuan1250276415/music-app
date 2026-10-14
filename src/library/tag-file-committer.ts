import {spawn} from 'node:child_process';
import path from 'node:path';
import {readTagCommitRequest,readTagCommitMessage,type TagCommitRequest,type TagCommitMessage,type TagCommitProof} from '../shared/tag-commit.js';
import {tagWriteHash} from '../shared/tag-write.js';

export class TagCommitExitUnconfirmed extends Error {}
type Stage=Extract<TagCommitMessage,{kind:'stage'}>;
export class TagFileCommitter {
 private active=false;private uncertain=false;
 constructor(private readonly executable:string){}
 get quiescent():boolean{return !this.active&&!this.uncertain;}
 // onStage must fsync its immutable phase proof and commit the matching DB
 // receipt before returning the receipt digest. No caller may ACK mere delivery.
 async run(value:TagCommitRequest,onStage:(stage:Stage)=>Promise<string>,onProgress:(p:Extract<TagCommitMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagCommitProof>{
  signal.throwIfAborted();if(!this.quiescent)throw new Error('文件提交组件忙碌或上次退出尚未确认');const request=readTagCommitRequest(value);
  if(process.platform!=='win32'||!path.isAbsolute(this.executable)||path.basename(this.executable)!=='tag-file-committer.exe'||[request.sourceRoot,request.backupRoot,...request.files.map(f=>f.path)].some(p=>!path.isAbsolute(p)))throw new Error('文件提交组件或授权路径无效');
  const body=Buffer.from(JSON.stringify(request));if(body.length>131072)throw new Error('提交请求超过预算');const frame=Buffer.alloc(4+body.length);frame.writeUInt32LE(body.length);body.copy(frame,4);this.active=true;
  try{return await this.launch(request,frame,onStage,onProgress,signal);}finally{this.active=false;}
 }
 private launch(request:TagCommitRequest,frame:Buffer,onStage:(stage:Stage)=>Promise<string>,onProgress:(p:Extract<TagCommitMessage,{kind:'progress'}>)=>void,signal:AbortSignal):Promise<TagCommitProof>{return new Promise((resolve,reject)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
  const child=spawn(this.executable,[process.execPath,String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});
  let pending=Buffer.alloc(0),last=0,phases=0,acknowledging=false,spawned=false,closed=false,result:TagCommitProof|null=null,error:Error|null=null,stderr=0,lastActivity=performance.now(),budget=0,budgetAt=performance.now();
  let stageFlight:Promise<void>|null=null,exitCode:number|null=null,exitSignal:NodeJS.Signals|null=null;
  const decoder=new TextDecoder('utf-8',{fatal:true}),cancel=(e:Error)=>{error??=e;child.stdin.end();},abort=()=>cancel(signal.reason instanceof Error?signal.reason:new Error('提交取消已请求，等待进程退出并核对文件'));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();const timer=setInterval(()=>{if(performance.now()-lastActivity>300000)cancel(new Error('提交五分钟无进度，保留工件等待进程退出'));},10000),deadline=setTimeout(()=>cancel(new Error('提交超过八小时预算，保留工件等待退出')),8*3600000+30000);
  child.once('spawn',()=>{spawned=true;});child.on('error',cancel);child.stdin.on('error',()=>cancel(new Error('提交输入中断')));child.stdout.on('error',()=>cancel(new Error('提交回执管道中断')));child.stderr.on('error',()=>cancel(new Error('提交诊断管道中断')));child.stderr.on('data',(c:Buffer)=>{stderr+=c.length;if(stderr>16384)cancel(new Error('提交诊断超过预算'));});
  const consume=()=>{if(error||acknowledging)return;try{
   while(pending.length>=4){const size=pending.readUInt32LE();if(!size||size>65536)throw new Error('提交帧无效');if(pending.length<size+4)return;
    const message=readTagCommitMessage(JSON.parse(decoder.decode(pending.subarray(4,size+4))),request,last,phases);last=message.sequence;pending=pending.subarray(size+4);if(result)throw new Error('提交终结后仍有回执');
    if(message.kind==='error')throw new Error(message.message);if(message.kind==='progress')onProgress(message);if(message.kind==='done')result=message.proof;
    if(message.kind==='stage'){
     acknowledging=true;stageFlight=(async()=>{const digest=await onStage(message);signal.throwIfAborted();if(closed||error||!tagWriteHash(digest))throw new Error('提交阶段未取得持久回执或进程已关闭，不能确认');
      const body=Buffer.from(JSON.stringify({version:1,kind:'ack',operationId:request.operationId,sequence:message.sequence,receiptSha256:digest})),ack=Buffer.alloc(body.length+4);ack.writeUInt32LE(body.length);body.copy(ack,4);
      await new Promise<void>((yes,no)=>child.stdin.write(ack,e=>e?no(e):yes()));phases++;
     })().catch(e=>{cancel(e instanceof Error?e:new Error(String(e)));}).finally(()=>{acknowledging=false;stageFlight=null;if(closed)settle();else consume();});return;
    }
   }
  }catch(e){cancel(e instanceof Error?e:new Error(String(e)));}};
  // Bounded original DACL archive can occur in several acknowledged phase proofs.
  child.stdout.on('data',(c:Buffer)=>{if(error)return;const now=performance.now();if(now-budgetAt>=1000){budget=0;budgetAt=now;}budget+=c.length;if(budget>524288||pending.length+c.length>65540){cancel(new Error('提交输出超过预算'));return;}lastActivity=now;pending=Buffer.concat([pending,c]);consume();});
  const settle=()=>{
   if(!closed||stageFlight)return;
   if(!spawned){reject(error??new Error('提交进程未启动'));return;}if(exitCode===null||exitSignal||![0,65,66,68,70,71].includes(exitCode)){this.uncertain=true;reject(new TagCommitExitUnconfirmed('文件提交进程退出尚未确认；保留原文件、备份、临时文件与旧文件工件，重启后核对'));return;}
   if(error||exitCode!==0||pending.length||acknowledging||phases!==5||!result){reject(error??new Error('提交未取得全部持久回执及完整退出结果，必须按实际文件恢复'));return;}resolve(result);
  };
  child.once('close',(code,sig)=>{closed=true;exitCode=code;exitSignal=sig;clearInterval(timer);clearTimeout(deadline);signal.removeEventListener('abort',abort);settle();});child.stdin.write(frame,e=>{if(e)cancel(e);});
 });}
}
