const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {ProviderBroker}=require('../dist/main/library/provider-broker.js');
const {CoverArtArchiveProvider,coverArtArchivePolicy,readCandidateCoverArtImage}=require('../dist/main/library/cover-art-archive.js');
const {MediaParser}=require('../dist/main/library/media-worker-client.js'),{convertOnlineImage}=require('../dist/main/library/online-image-converter.js');
const {ArtworkResources}=require('../dist/main/main/artwork-resources.js');
const id='76df3287-6cda-33eb-8e9a-044b5e15ffdd',imageId='829521842',other='00000000-0000-0000-0000-000000000001';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function waitFor(check,label){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw new Error(label);await new Promise(r=>setTimeout(r,10));}}
async function main(){
 const project=path.resolve(__dirname,'..'),parent=path.resolve('D:/CodexTestData');fs.mkdirSync(parent,{recursive:true});const beforeTemps=new Set(fs.readdirSync(parent).filter(n=>n.startsWith('aural-online-image-')));
 const report={version:require('../package.json').version,completed:false,scope:'production binary broker/coordinator + real Windows supervised neutral image conversion + production Main memory resources; synthetic CAA network/candidate; no persistent library cover application',cases:[]};
 const red=fs.readFileSync(path.join(__dirname,'fixtures/embedded-red.png')),parser=new MediaParser();let mode='normal',pauseResolve,readerCancelled=false,streamStarted=false,converted=0,currentFingerprint='a'.repeat(64),enabled=true;
 const candidate={releaseId:id,expiresAt:new Date(Date.now()+600000).toISOString()},calls=[];
 const index={release:`https://musicbrainz.org/release/${id}`,images:[{id:Number(imageId),front:true,back:false,approved:true,types:['Front'],comment:''}]};
 const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
 const target=(root,cover=imageId)=>`${root}/mbid-${id}/mbid-${id}-${cover}_thumb1200.jpg`;
 const fetcher=async(url,init)=>{
  calls.push(String(url));if(String(url).endsWith(`/${id}/`))return json(index);
  if(mode==='pause')return new Promise(resolve=>{pauseResolve=()=>resolve(new Response(red,{headers:{'Content-Type':'image/png'}}));});
  if(mode==='stream'){streamStarted=true;return new Response(new ReadableStream({cancel(){readerCancelled=true;}}),{headers:{'Content-Type':'image/png'}});}
  if(mode==='oversize')return new Response(red,{headers:{'Content-Type':'image/png','Content-Length':'16777217'}});
  if(mode==='large-stream')return new Response(new Uint8Array(16777217),{headers:{'Content-Type':'image/png'}});
  if(mode==='html')return new Response('<html>bad</html>',{headers:{'Content-Type':'text/html'}});
  if(mode==='false-mime')return new Response('<html>bad</html>',{headers:{'Content-Type':'image/jpeg'}});
  if(mode==='bad-image')return new Response(Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]),{headers:{'Content-Type':'image/png'}});
  if(mode==='404')return new Response(null,{status:404});
  const illegal={wrong:target('https://archive.org/download','829521843'),other:`https://archive.org/download/mbid-${other}/mbid-${other}-${imageId}_thumb1200.jpg`,evil:target('https://evil.invalid/download'),insecure:target('http://archive.org/download'),query:target('https://archive.org/download')+'?x=private',original:`https://archive.org/download/mbid-${id}/mbid-${id}-${imageId}.jpg`,traversal:`https://archive.org/download/mbid-${id}/../private.jpg`,suffix:target('https://archive.org.evil.invalid/download')}[mode];
  if(illegal)return new Response(null,{status:307,headers:{Location:illegal}});
  if(String(url).startsWith('https://coverartarchive.org/'))return new Response(null,{status:307,headers:{Location:target('https://archive.org/download')}});
  if(String(url).startsWith('https://archive.org/'))return new Response(null,{status:302,headers:{Location:target('https://ia601604.us.archive.org/28/items')}});
  return new Response(red,{headers:{'Content-Type':'image/png'}});
 };
 const broker=new ProviderBroker(fetcher);broker.register({...coverArtArchivePolicy,intervalMs:1,timeoutMs:5000,deadlineMs:10000});const provider=new CoverArtArchiveProvider(broker);
 const request=(cover=imageId)=>({itemId:'fixture-item',token:'11111111-1111-1111-1111-111111111111',fingerprint:'a'.repeat(64),requestId:randomUUID(),imageId:cover,fresh:true});
 const deps={resolve:(item,token)=>item==='fixture-item'&&token==='11111111-1111-1111-1111-111111111111'?candidate:null,fingerprint:()=>currentFingerprint,enabled:()=>enabled,convert:async(bytes,signal)=>{converted++;return convertOnlineImage(parser,bytes,signal,parent);}};
 const resources=new ArtworkResources(async()=>{throw new Error('preview must not reload a local cover');},async()=>{throw new Error('preview must not read DB content');},async()=>{},async()=>{});
 try{
  const value=await readCandidateCoverArtImage(request(),provider,deps,new AbortController().signal);assert.equal(value.token,hash(red));assert.match(value.url,/^data:image\/jpeg;base64,/);assert.ok(value.width<=1024&&value.height<=1024);assert.equal(value.rights.persist,false);assert.equal(value.imageId,imageId);assert.equal(converted,1);assert.equal(broker.state('cover-art-archive').cacheEntries,1);report.cases.push('selected index entry -> binary two-hop -> supervised native JPEG -> no broker binary cache');
  const stored=resources.registerPreview(value,resources.capturePreviewOwner());assert.match(stored.url,/^aural-artwork:\/\/preview\/[0-9a-f]{64}\.jpg$/);const bytes=await resources.read(stored.url);assert.ok(bytes&&bytes[0]===255&&bytes[1]===216);report.cases.push('ephemeral protocol bytes do not read or mutate catalog');
  resources.releasePreview(stored.url);assert.equal(await resources.read(stored.url),null);report.cases.push('explicit release removes resource');
  const expired=resources.registerPreview({...value,expiresAt:new Date(Date.now()+80).toISOString()},resources.capturePreviewOwner());await new Promise(r=>setTimeout(r,120));assert.equal(await resources.read(expired.url),null);report.cases.push('expiry removes resource');
  const owner=resources.capturePreviewOwner();resources.clearPreviews();assert.throws(()=>resources.registerPreview(value,owner),/变化/);report.cases.push('stale document/library epoch rejected');
  const old=resources.registerPreview(value,resources.capturePreviewOwner());const maintenanceOwner=randomUUID();await resources.beginMaintenance(maintenanceOwner);resources.endMaintenance(maintenanceOwner);assert.equal(await resources.read(old.url),null);report.cases.push('maintenance purges preview bytes');
  const quota=[];for(let i=0;i<17;i++)quota.push(resources.registerPreview(value,resources.capturePreviewOwner()).url);assert.equal(await resources.read(quota[0]),null);assert.ok(await resources.read(quota.at(-1)));report.cases.push('16 preview resource bound');resources.clearPreviews();
  const n=calls.length;await assert.rejects(readCandidateCoverArtImage(request('829521843'),provider,deps,new AbortController().signal),/不属于/);assert.equal(calls.length,n+1);report.cases.push('unlisted image rejected before binary request');
  for(const m of ['wrong','other','evil','insecure','query','original','traversal','suffix']){mode=m;const before=calls.length;await assert.rejects(provider.image(id,imageId,new AbortController().signal),/跳转/);assert.equal(calls.length,before+1);report.cases.push('image redirect rejected: '+m);}
  for(const m of ['oversize','large-stream','html','false-mime','404']){mode=m;await assert.rejects(provider.image(id,imageId,new AbortController().signal));report.cases.push('image response rejected: '+m);}
  mode='bad-image';await assert.rejects(readCandidateCoverArtImage(request(),provider,deps,new AbortController().signal),/图片/);report.cases.push('malformed image rejected by real native converter');
  mode='stream';const controller=new AbortController(),pending=provider.image(id,imageId,controller.signal),rejected=assert.rejects(pending);await waitFor(()=>streamStarted,'stream pending');controller.abort(new Error('fixture cancel'));await rejected;await waitFor(()=>readerCancelled,'reader cancelled');report.cases.push('stream cancel closes body reader');
  mode='pause';pauseResolve=null;const delayed=readCandidateCoverArtImage(request(),provider,deps,new AbortController().signal),lateRejected=assert.rejects(delayed);await waitFor(()=>pauseResolve,'binary pending');currentFingerprint='b'.repeat(64);const beforeConverted=converted;pauseResolve();await lateRejected;assert.equal(converted,beforeConverted);currentFingerprint='a'.repeat(64);report.cases.push('changed metadata rejects binary before conversion');
  mode='normal';const lateController=new AbortController();await assert.rejects(readCandidateCoverArtImage(request(),provider,{...deps,convert:async(bytes,signal)=>{const out=await deps.convert(bytes,signal);lateController.abort(new Error('cancel after native conversion'));return out;}},lateController.signal),/cancel after/);report.cases.push('cancel after conversion never returns a preview');
  enabled=false;const beforeDisabled=calls.length;await assert.rejects(readCandidateCoverArtImage(request(),provider,deps,new AbortController().signal),/启用/);assert.equal(calls.length,beforeDisabled);report.cases.push('source disabled before network');
  const afterTemps=fs.readdirSync(parent).filter(n=>n.startsWith('aural-online-image-')&&!beforeTemps.has(n));assert.deepEqual(afterTemps,[]);report.stagingFilesRemoved=true;report.cases.push('owned staging removed on success, decode failure and cancellation');
  report.fingerprints=Object.fromEntries(['src/library/provider-broker.ts','src/library/cover-art-archive.ts','src/library/online-image-converter.ts','src/library/artwork-worker.ts','src/library/media-worker-protocol.ts','src/library/media-worker-client.ts','src/library/media-worker-entry.ts','src/main/artwork-resources.ts','dist/main/library/cover-art-archive.js','dist/main/library/online-image-converter.js','dist/main/library/media-worker-entry.js','native/media-worker/build/media-worker.exe'].map(name=>[name,hash(fs.readFileSync(path.join(project,name)))]));report.completed=true;
 }finally{broker.dispose();await resources.close();if(process.env.AURAL_CAA_IMAGE_REPORT)fs.writeFileSync(process.env.AURAL_CAA_IMAGE_REPORT,JSON.stringify(report,null,2));}
 console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
