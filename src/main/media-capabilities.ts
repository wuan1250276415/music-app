import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {MEDIA_CAPABILITY_COMPONENTS,readMediaCapabilityManifest,type MediaCapabilityView} from '../shared/media-capabilities.js';
import {RELEASE} from '../shared/release.js';
export class MediaCapabilityRegistry {
 private flight:Promise<MediaCapabilityView>|null=null;
 constructor(private readonly manifestFile:string,private readonly host:string){}
 current():Promise<MediaCapabilityView>{if(!this.flight)this.flight=this.read().finally(()=>{this.flight=null;});return this.flight;}
 private async read():Promise<MediaCapabilityView>{try{
  const info=await fs.stat(this.manifestFile);if(!info.isFile()||info.size>1048576)throw new Error('解码验证清单超过预算');
  const manifest=readMediaCapabilityManifest(JSON.parse(await fs.readFile(this.manifestFile,'utf8')));const proofFile=path.join(path.dirname(this.manifestFile),'media-capabilities-proof.json'),proofInfo=await fs.stat(proofFile);if(!proofInfo.isFile()||proofInfo.size>1048576||createHash('sha256').update(await fs.readFile(proofFile)).digest('hex')!==manifest.reportSha256)throw new Error('解码验证原始记录不匹配');if(manifest.appVersion!==RELEASE.appVersion)throw new Error('解码验证清单不属于当前应用版本');
  for(const name of MEDIA_CAPABILITY_COMPONENTS){const file=name==='audio-host.exe'?this.host:path.join(path.dirname(this.host),name),stat=await fs.stat(file);if(!stat.isFile()||stat.size>64*1024*1024)throw new Error('解码组件无法核对');const digest=createHash('sha256').update(await fs.readFile(file)).digest('hex');if(digest!==manifest.components[name])throw new Error('解码组件已改变，旧验证清单不再适用');}
  return {status:'ready',reason:'',manifest};
 }catch(error){return {status:'unavailable',manifest:null,reason:(error as NodeJS.ErrnoException).code==='ENOENT'?'当前构建尚无匹配的解码验证清单。':error instanceof Error?error.message:'当前解码能力无法核对'};}}
}
