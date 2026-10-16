import {randomUUID} from 'node:crypto';
import type {TagStageBatchClaim,TagStageBatchDrive} from '../shared/tag-stage-batch.js';
type Ports={available:()=>boolean;run:<T>(action:()=>Promise<T>)=>Promise<T>;call:<T>(method:string,value?:unknown,timeout?:number)=>Promise<T>;stageFile:<T>(fileId:string,observation:string,action:()=>Promise<T>)=>Promise<T>;fault:(message:string)=>void};
// Main owns playback release. Library owns durable scope, claims and every file
// operation; a renderer disappearing cannot leave a batch tied to its window.
export class TagStageBatchController {
 private readonly owner=randomUUID();private timer:ReturnType<typeof setInterval>|undefined;private flight:Promise<void>|null=null;private closed=false;private lastFault='';
 constructor(private readonly ports:Ports){}
 start():void{if(this.closed||this.timer)return;this.timer=setInterval(()=>this.poke(),1000);this.timer.unref();this.poke();}
 poke():void{if(this.closed||this.flight||!this.ports.available())return;const work=Promise.resolve().then(()=>this.ports.run(()=>this.advance())).then(()=>{this.lastFault='';}).catch(error=>{const message=String(error instanceof Error?error.message:error).slice(0,600);if(message!==this.lastFault){this.lastFault=message;this.ports.fault(message);}}).finally(()=>{if(this.flight===work)this.flight=null;});this.flight=work;}
 private async advance():Promise<void>{const result=await this.ports.call<TagStageBatchDrive>('tagStageBatchDrive',this.owner);if(!result.claim)return;const claim:TagStageBatchClaim=result.claim;
  try{const target=await this.ports.call<{fileId:string;observation:string}>('tagStageBatchTarget',claim,60000);await this.ports.stageFile(target.fileId,target.observation,()=>this.ports.call('tagStageBatchStartItem',claim,60000));}
  catch(error){await this.ports.call('tagStageBatchRefuse',{claim,message:String(error instanceof Error?error.message:error).slice(0,600)});}
 }
 async close():Promise<void>{this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.flight;}
}
