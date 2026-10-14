const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {ProviderBroker}=require('../dist/main/library/provider-broker.js');
const {CoverArtArchiveProvider,coverArtArchivePolicy}=require('../dist/main/library/cover-art-archive.js');
const {MediaParser}=require('../dist/main/library/media-worker-client.js'),{convertOnlineImage}=require('../dist/main/library/online-image-converter.js');
const {ArtworkResources}=require('../dist/main/main/artwork-resources.js');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
 const project=path.resolve(__dirname,'..'),report={version:require('../package.json').version,completed:false,scope:'real public CAA official example release index + selected front image binary + actual supervised JPEG conversion + production memory resource response; no user song/MusicBrainz search/desktop matching or persistent application',releaseId:'76df3287-6cda-33eb-8e9a-044b5e15ffdd',requests:[]};
 const broker=new ProviderBroker(async(input,init)=>{const start=Date.now(),response=await fetch(input,init);report.requests.push({url:String(input),status:response.status,type:response.headers.get('content-type'),location:response.headers.get('location'),durationMs:Date.now()-start});return response;});broker.register(coverArtArchivePolicy);
 const resources=new ArtworkResources(async()=>null,async()=>null,async()=>{},async()=>{}),controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('live example deadline')),80000);
 try{
  const provider=new CoverArtArchiveProvider(broker),index=await provider.index(report.releaseId,{signal:controller.signal,fresh:true}),front=index.entries.find(entry=>entry.front);assert.ok(front);assert.equal(front.imageId,'829521842');
  const source=await provider.image(report.releaseId,front.imageId,controller.signal),converted=await convertOnlineImage(new MediaParser(),source.value.bytes,controller.signal);assert.equal(source.value.token,converted.token);
  const candidate={...converted,itemId:'official-example',candidateToken:'11111111-1111-1111-1111-111111111111',fingerprint:'a'.repeat(64),releaseId:report.releaseId,imageId:front.imageId,sourceUrl:index.sourceUrl,fetchedAt:source.fetchedAt,expiresAt:index.expiresAt,rights:{status:'unverified',display:true,cache:'session',persist:false,export:false}};
  const preview=resources.registerPreview(candidate,resources.capturePreviewOwner()),response=await resources.response(preview.url);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const jpeg=new Uint8Array(await response.arrayBuffer());assert.equal(jpeg[0],255);assert.equal(jpeg[1],216);resources.releasePreview(preview.url);assert.equal((await resources.response(preview.url)).status,404);
  report.result={imageId:front.imageId,sourceBytes:source.value.bytes.length,sourceSha256:source.value.token,jpegBytes:jpeg.length,jpegSha256:hash(jpeg),width:converted.width,height:converted.height,indexEntries:index.entries.length,sourceUrl:index.sourceUrl,rights:candidate.rights,released:true};
  report.fingerprints=Object.fromEntries(['src/library/cover-art-archive.ts','src/library/provider-broker.ts','src/library/online-image-converter.ts','src/main/artwork-resources.ts','dist/main/library/cover-art-archive.js','dist/main/library/online-image-converter.js','dist/main/main/artwork-resources.js','native/media-worker/build/media-worker.exe'].map(name=>[name,hash(fs.readFileSync(path.join(project,name)))]));report.completed=true;
 }catch(error){report.error=String(error);throw error;}finally{clearTimeout(timer);broker.dispose();await resources.close();if(process.env.AURAL_CAA_IMAGE_LIVE_REPORT)fs.writeFileSync(process.env.AURAL_CAA_IMAGE_LIVE_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
