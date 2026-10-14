import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';

export interface CredentialStore {
 available():boolean;
 read(scope:string,provider:string,slot:string):Promise<Buffer|null>;
 create(scope:string,provider:string,slot:string,secret:Buffer):Promise<Buffer>;
 has(scope:string,provider:string,slot:string):Promise<boolean>;
 write(scope:string,provider:string,slot:string,secret:Buffer):Promise<void>;
 remove(scope:string,provider:string,slot:string):Promise<void>;
}

export class WindowsCredentialVault implements CredentialStore {
 constructor(private readonly executable:string){}
 available():boolean{return process.platform==='win32'&&existsSync(this.executable);}
 private async operation(op:number,scope:string,provider:string,slot:string,secret?:Buffer):Promise<Buffer|null>{
  if(!this.available())throw new Error('当前系统的凭据保管组件不可用');
  if(!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(scope)||![provider,slot].every(value=>/^[a-z][a-z0-9-]{0,63}$/.test(value))||secret&&(!secret.length||secret.length>2048))throw new Error('无效凭据操作');
  const parts=[Buffer.from(scope),Buffer.from(provider),Buffer.from(slot)],header=Buffer.alloc(15);header.write('AUR1',0,'ascii');header[4]=op;parts.forEach((value,index)=>header.writeUInt16LE(value.length,5+index*2));header.writeUInt32LE(secret?.length??0,11);const packet=Buffer.concat([header,...parts,...(secret?[secret]:[])]);
  try{return await new Promise<Buffer|null>((resolve,reject)=>{
   const child=spawn(this.executable,[],{windowsHide:true,stdio:['pipe','pipe','pipe']}),chunks:Buffer[]=[];let bytes=0,done=false,stderrBytes=0;
   const finish=(error?:Error,value:Buffer|null=null)=>{if(done){value?.fill(0);return;}done=true;clearTimeout(timer);for(const chunk of chunks)chunk.fill(0);if(error)reject(error);else resolve(value);};
   const timer=setTimeout(()=>{child.kill();finish(new Error('凭据操作超时，保存结果需要重新确认'));},8000);
   child.on('error',()=>finish(new Error('凭据组件无法启动')));child.stdin.on('error',()=>{child.kill();finish(new Error('凭据请求传输失败，结果需要重新确认'));});
   child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>2060){child.kill();finish(new Error('凭据组件响应格式无效'));chunk.fill(0);}else if(!done)chunks.push(chunk);else chunk.fill(0);});
   child.stderr.on('data',(chunk:Buffer)=>{stderrBytes+=chunk.length;chunk.fill(0);if(stderrBytes>1024){child.kill();finish(new Error('凭据组件异常退出'));}});
   child.on('close',code=>{if(done)return;const output=Buffer.concat(chunks);try{if(code!==0||output.length<12||output.toString('ascii',0,4)!=='AUR1'||output.readUInt32LE(8)!==output.length-12)throw new Error('凭据组件响应格式无效');const status=output.readUInt32LE(4);if(status===1168&&(op===1||op===4)){finish(undefined,null);return;}if(status!==0)throw new Error(`Windows 凭据操作失败（${status}）`);finish(undefined,Buffer.from(output.subarray(12)));}catch(error){finish(error instanceof Error?error:new Error('凭据操作失败'));}finally{output.fill(0);}});
   child.stdin.end(packet);
  });}finally{packet.fill(0);}
 }
 read(scope:string,provider:string,slot:string):Promise<Buffer|null>{return this.operation(1,scope,provider,slot);}
 async create(scope:string,provider:string,slot:string,secret:Buffer):Promise<Buffer>{const response=await this.operation(5,scope,provider,slot,secret);if(!response?.length)throw new Error('凭据校验密钥初始化失败');return response;}
 async has(scope:string,provider:string,slot:string):Promise<boolean>{const value=await this.operation(4,scope,provider,slot);try{if(value===null)return false;if(value.length!==1||value[0]!==1)throw new Error('凭据状态响应无效');return true;}finally{value?.fill(0);}}
 async write(scope:string,provider:string,slot:string,secret:Buffer):Promise<void>{const response=await this.operation(2,scope,provider,slot,secret);try{if(response===null||response.length!==0)throw new Error('凭据保存响应无效');}finally{response?.fill(0);}}
 async remove(scope:string,provider:string,slot:string):Promise<void>{const response=await this.operation(3,scope,provider,slot);try{if(response===null||response.length!==0)throw new Error('凭据移除响应无效');}finally{response?.fill(0);}}
}
