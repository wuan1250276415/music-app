import {spawn,type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {DIRECTORY_MOVE_PHASES,readDirectoryMoveRequest,readDirectoryMoveMessage,type CatalogDirectoryMoveRequest,type CatalogDirectoryMoveMessage,type CatalogDirectoryMoveProof} from '../shared/catalog-directory-move.js';
import {CatalogDirectoryMoveJournal} from './catalog-directory-move-journal.js';
type Stage=Extract<CatalogDirectoryMoveMessage,{kind:'stage'}>;
export class CatalogDirectoryMoveUncertain extends Error{}
// Private restoration primitive, never a Renderer-selected path or generic IPC.
// Call only after Main resources freeze and actual Library service exit.
export class CatalogDirectoryMover{
 private owner:ChildProcess|null=null;private flight:Promise<CatalogDirectoryMoveProof>|null=null;private uncertain=false;private closed=false;private stopControl:AbortController|null=null;
 constructor(private readonly executable:string,private readonly dataDir:string,private readonly assertStopped:(transactionId:string)=>void){}
 get quiescent():boolean{return !this.owner&&!this.flight&&!this.uncertain;}
 interrupt(reason:string):void{this.stopControl?.abort(new Error(reason));if(this.owner){try{this.owner.stdin?.end();this.owner.kill();}catch{}}}
 close():Promise<unknown>{this.closed=true;this.interrupt('应用退出，目录切换须重新核对');return this.flight?.catch(()=>{})??Promise.resolve();}
 run(value:CatalogDirectoryMoveRequest,signal:AbortSignal):Promise<CatalogDirectoryMoveProof>{
  const request=readDirectoryMoveRequest(value);signal.throwIfAborted();this.assertStopped(request.transactionId);
  if(this.closed||!this.quiescent)throw new Error('曲库目录切换仍在进行、组件已关闭或需要按实际目录核对');
  if(process.platform!=='win32'||!path.isAbsolute(this.executable)||path.basename(this.executable)!=='catalog-directory-mover.exe'||request.userData!==this.dataDir||!path.isAbsolute(request.userData)||path.resolve(request.userData)!==request.userData)throw new Error('曲库目录切换组件或当前应用位置无效');
  const control=new AbortController();this.stopControl=control;const combined=AbortSignal.any([signal,control.signal]);
  const work=Promise.resolve().then(async()=>{const journal=new CatalogDirectoryMoveJournal(request);combined.throwIfAborted();this.assertStopped(request.transactionId);await journal.reserve();combined.throwIfAborted();this.assertStopped(request.transactionId);const proof=await this.launch(request,frame=>journal.append(frame),combined);
   try{combined.throwIfAborted();this.assertStopped(request.transactionId);await journal.complete(proof);}catch(error){this.uncertain=true;throw new CatalogDirectoryMoveUncertain('目录已切换但退出回执未确认，须核对实际目录。',{cause:error});}return proof;
  });this.flight=work;void work.finally(()=>{if(this.flight===work){this.flight=null;this.stopControl=null;}}).catch(()=>{});return work;
 }
 private launch(request:CatalogDirectoryMoveRequest,onStage:(frame:Stage)=>Promise<string>,signal:AbortSignal):Promise<CatalogDirectoryMoveProof>{return new Promise((resolve,reject)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','PATH'])if(process.env[key]!==undefined)env[key]=process.env[key];
  const child=spawn(this.executable,[process.execPath,String(process.pid)],{stdio:['pipe','pipe','pipe'],windowsHide:true,env});this.owner=child;
  let pending=Buffer.alloc(0),last=0,phases=0,stderr=0,bytes=0,spawned=false,closed=false,result:CatalogDirectoryMoveProof|null=null,error:Error|null=null,stageFlight:Promise<void>|null=null,code:number|null=null,sig:NodeJS.Signals|null=null;
  const fail=(cause:unknown)=>{error??=cause instanceof Error?cause:new Error(String(cause));try{child.stdin.end();child.kill();}catch{}};
  const stop=()=>fail(signal.reason??new Error('曲库目录切换取消，须按实际文件核对'));signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();
  const deadline=setTimeout(()=>fail(new Error('曲库目录切换超过45秒，等待原进程退出')),45000),retry=setInterval(()=>{if(error&&!closed)try{child.kill();}catch{}},500);
  const send=(v:unknown)=>{const body=Buffer.from(JSON.stringify(v));if(body.length>131072)throw new Error('曲库目录命令超过预算');const frame=Buffer.alloc(body.length+4);frame.writeUInt32LE(body.length);body.copy(frame,4);return new Promise<void>((yes,no)=>child.stdin.write(frame,e=>e?no(e):yes()));};
  const decoder=new TextDecoder('utf-8',{fatal:true});
  const settle=()=>{if(!closed||stageFlight)return;if(this.owner===child)this.owner=null;
   if(spawned&&(error||code!==0||sig||pending.length||phases!==DIRECTORY_MOVE_PHASES.length||!result)){this.uncertain=true;reject(new CatalogDirectoryMoveUncertain('曲库目录切换未确认；保留原库及新库，必须按持久记录和实际目录核对。',{cause:error??undefined}));return;}
   if(!spawned||!result){reject(error??new Error('曲库目录切换进程未启动'));return;}resolve(result);
  };
  const consume=()=>{if(error||stageFlight)return;try{
   while(pending.length>=4){const size=pending.readUInt32LE();if(!size||size>65536)throw new Error('曲库目录回执大小无效');if(pending.length<size+4)return;
    this.assertStopped(request.transactionId);const frame=readDirectoryMoveMessage(JSON.parse(decoder.decode(pending.subarray(4,size+4))),request,last,phases);pending=pending.subarray(size+4);last=frame.sequence;if(result)throw new Error('目录切换完成后仍有消息');if(frame.kind==='error')throw new Error(frame.message);
    if(frame.kind==='done'){result=frame.proof;continue;}
    stageFlight=Promise.resolve().then(async()=>{const digest=await onStage(frame);signal.throwIfAborted();this.assertStopped(request.transactionId);if(closed||error||!/^[a-f0-9]{64}$/.test(digest))throw new Error('目录阶段未确认持久回执，不能继续');await send({version:1,kind:'ack',operationId:request.operationId,sequence:frame.sequence,receiptSha256:digest});phases++;}).catch(fail).finally(()=>{stageFlight=null;if(closed)settle();else consume();});return;
   }
  }catch(cause){fail(cause);}};
  child.once('spawn',()=>{spawned=true;});child.on('error',fail);child.stdin.on('error',fail);child.stdout.on('error',fail);child.stderr.on('error',fail);
  child.stderr.on('data',(v:Buffer)=>{stderr+=v.length;if(stderr>16384)fail(new Error('曲库目录诊断超过预算'));});
  child.stdout.on('data',(v:Buffer)=>{if(error)return;bytes+=v.length;if(bytes>384*1024||pending.length+v.length>65540){fail(new Error('曲库目录回执超过总预算'));return;}pending=Buffer.concat([pending,v]);consume();});
  child.once('close',(exitCode,exitSignal)=>{closed=true;code=exitCode;sig=exitSignal;clearTimeout(deadline);clearInterval(retry);signal.removeEventListener('abort',stop);settle();});void send(request).catch(fail);
 });}
}
