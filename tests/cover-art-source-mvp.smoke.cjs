const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
const {ProviderBroker}=require('../dist/main/library/provider-broker.js');
const {registerProviders,providerManifest}=require('../dist/main/library/providers.js');
const {MusicBrainzProvider}=require('../dist/main/library/musicbrainz.js');
const {CoverArtArchiveProvider,coverArtArchivePolicy,readCandidateCoverArt}=require('../dist/main/library/cover-art-archive.js');
const {LibraryDatabase}=require('../dist/main/library/database.js'),{scanRoot}=require('../dist/main/library/scanner.js');
const releaseId='76df3287-6cda-33eb-8e9a-044b5e15ffdd',otherId='00000000-0000-0000-0000-000000000001';
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json','Cache-Control':'max-age=60'}});
const row={id:829521842,front:true,back:false,approved:true,types:['Front'],comment:'fixture <script> text',image:'http://127.0.0.1/private',thumbnails:{large:'https://evil.invalid/cover.jpg'}};
const index=(id=releaseId)=>({release:`https://musicbrainz.org/release/${id}`,images:[row,{...row,id:'829521843',front:false,back:true,types:['Back']}]});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function main(){
 const project=path.resolve(__dirname,'..'),parent=path.resolve('D:/CodexTestData');fs.mkdirSync(parent,{recursive:true});
 const scratch=fs.mkdtempSync(path.join(parent,'aural-cover-source-mvp-')),media=path.join(scratch,'music');fs.mkdirSync(media);
 const report={version:require('../package.json').version,completed:false,scope:'real SQLite catalog/scanner + production matching/provider/coordinator with synthetic network; no real MusicBrainz match, no online image requests or image application',cases:[],scratch};
 const beforeMedia=fs.readFileSync(path.join(__dirname,'fixtures/embedded-cover.mp3'));fs.writeFileSync(path.join(media,'song.mp3'),beforeMedia);
 let db,broker,mb;const calls=[];
 try{
  db=new LibraryDatabase(path.join(scratch,'library.db'));const root=db.addRoot(media);await scanRoot(db,root,()=>{});const item=db.list({view:'all'}).items[0];assert.ok(item);
  assert.equal(db.providerSettings.setting('cover-art-archive').enabled,false);assert.equal(providerManifest('cover-art-archive').ready,true);
  let mode='normal',pauseResolve;
  const fetcher=async(url,init)=>{
   calls.push({url:String(url),time:Date.now(),headers:{...init.headers},redirect:init.redirect,credentials:init.credentials});
   if(String(url).startsWith('https://musicbrainz.org/ws/2/'))return json({recordings:[{id:otherId,title:'fixture candidate',score:93,'artist-credit':[{name:'fixture artist'}],releases:[{id:releaseId,title:'chosen edition'}]}]});
   if(mode==='pause')return await new Promise(resolve=>{pauseResolve=()=>resolve(json(index()));});
   if(mode==='404')return new Response(null,{status:404});
   if(mode==='wrong-identity')return json(index(otherId));
   if(mode==='bad-entry')return json({...index(),images:[{...row,id:Number.MAX_SAFE_INTEGER+2}]});
   if(mode==='duplicate')return json({...index(),images:[row,row]});
   if(mode==='too-many')return json({...index(),images:Array(257).fill(row)});
   if(mode==='html')return new Response('<html>bad</html>',{headers:{'Content-Type':'text/html'}});
   if(mode==='oversize')return new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'2000001'}});
   if(mode==='large-stream')return new Response(' '.repeat(2000001),{headers:{'Content-Type':'application/json'}});
   if(mode==='retry'){if(!fetcher.retried){fetcher.retried=true;return new Response(null,{status:429,headers:{'Retry-After':'0.02'}});}return json(index());}
   const destination={evil:'https://evil.invalid/index.json',local:'https://127.0.0.1/index.json',wrong:`https://archive.org/download/mbid-${otherId}/index.json`,insecure:`http://archive.org/download/mbid-${releaseId}/index.json`,query:`https://archive.org/download/mbid-${releaseId}/index.json?url=private`,userinfo:`https://name:secret@archive.org/download/mbid-${releaseId}/index.json`,port:`https://archive.org:444/download/mbid-${releaseId}/index.json`,loop:`https://coverartarchive.org/release/${releaseId}/`,suffix:`https://archive.org.evil.invalid/download/mbid-${releaseId}/index.json`,image:`https://archive.org/download/mbid-${releaseId}/829521842.jpg`}[mode];
   if(destination)return new Response(null,{status:307,headers:{Location:destination}});
   if(String(url).startsWith('https://coverartarchive.org/'))return new Response(null,{status:307,headers:{Location:`https://archive.org/download/mbid-${releaseId}/index.json`}});
   if(String(url).startsWith('https://archive.org/'))return new Response(null,{status:302,headers:{Location:`https://ia601604.us.archive.org/28/items/mbid-${releaseId}/index.json`}});
   return json(index());
  };
  broker=new ProviderBroker(fetcher);registerProviders(broker);mb=new MusicBrainzProvider(()=>'https://example.invalid/fixture-only',fetcher,broker);
  const searchId=randomUUID(),candidates=await mb.search(item,{requestId:searchId});let candidate=candidates[0];assert.ok(candidate);
  const provider=new CoverArtArchiveProvider(broker),request=()=>({itemId:item.id,token:candidate.token,fingerprint:db.metadataReviewFingerprint(item.id),requestId:randomUUID(),fresh:true});
  const enabled=()=>db.metadataNetworkEnabled()&&db.providerSettings.setting('cover-art-archive').enabled,deps={resolve:(id,token)=>mb.resolve(id,token),fingerprint:id=>db.metadataReviewFingerprint(id),enabled};
  const signal=new AbortController().signal;
  const noNetwork=calls.length;await assert.rejects(readCandidateCoverArt(request(),provider,deps,signal),/启用/);assert.equal(calls.length,noNetwork);report.cases.push('default disabled before network');
  const setting=db.providerSettings.setting('cover-art-archive');db.providerSettings.configure({commandId:randomUUID(),providerId:'cover-art-archive',revision:setting.revision,enabled:true});
  db.setMetadataNetworkEnabled(true);
  const result=await readCandidateCoverArt(request(),provider,deps,signal);assert.equal(result.entries.length,2);assert.equal(result.entries[0].front,true);assert.deepEqual(result.imageRights,{status:'unverified',display:false,cache:false,export:false,preview:'on-request'});assert.equal(JSON.stringify(result).includes('127.0.0.1'),false);assert.equal(JSON.stringify(result).includes('evil.invalid'),false);assert.equal(result.sourceUrl,`https://musicbrainz.org/release/${releaseId}/cover-art`);
  const chain=calls.filter(c=>!c.url.includes('musicbrainz.org/ws/'));assert.equal(chain.length,3);assert.ok(chain[1].time-chain[0].time>=1000);assert.ok(chain[2].time-chain[1].time>=1000);assert.ok(chain.every(c=>c.redirect==='manual'&&c.credentials==='omit'));
  report.cases.push('chosen recording/release token + live fingerprint + two redirect chain + rate + no image URLs');report.redirectGaps=chain.slice(1).map((c,i)=>c.time-chain[i].time);
  const beforeCache=calls.length,cached=await readCandidateCoverArt({...request(),fresh:false},provider,deps,signal);assert.equal(cached.cacheHit,true);assert.equal(calls.length,beforeCache);report.cases.push('ephemeral index cache');
  broker.dispose();mb.dispose();
  // Reuse actual adapters with shorter scheduling for the negative/fault matrix only.
  broker=new ProviderBroker(fetcher);broker.register({...coverArtArchivePolicy,intervalMs:1,timeoutMs:3000,deadlineMs:10000});
  const fastProvider=new CoverArtArchiveProvider(broker);
  mode='404';assert.equal((await fastProvider.index(releaseId)).availability,'not-found');assert.equal(broker.state('cover-art-archive').cacheEntries,0);report.cases.push('404 is empty and not negatively cached');
  for(const m of ['evil','local','wrong','insecure','query','userinfo','port','loop','suffix','image']){mode=m;const start=calls.length;await assert.rejects(fastProvider.index(releaseId,{fresh:true}),/跳转/);assert.equal(calls.length,start+1);report.cases.push('blocked redirect: '+m);}
  for(const m of ['wrong-identity','bad-entry','duplicate','too-many','html','oversize','large-stream']){mode=m;await assert.rejects(fastProvider.index(releaseId,{fresh:true}));report.cases.push('rejected response: '+m);}
  mode='normal';let stableFingerprint=db.metadataReviewFingerprint(item.id),currentCandidate=candidate;
  const state={resolve:(id,token)=>id===item.id&&token===candidate.token?currentCandidate:null,fingerprint:()=>stableFingerprint,enabled:()=>enabled()};
  let r=request();await assert.rejects(readCandidateCoverArt({...r,itemId:'foreign'},fastProvider,state,signal),/过期/);await assert.rejects(readCandidateCoverArt({...r,fingerprint:'a'.repeat(64)},fastProvider,state,signal),/变化/);report.cases.push('foreign item and stale review rejected');
  const waitPaused=async()=>{const end=Date.now()+3000;while(!pauseResolve){if(Date.now()>end)throw new Error('pause not reached');await new Promise(r=>setTimeout(r,10));}};
  for(const action of ['cancel','candidate-invalidated','fingerprint-changed','source-disabled']){
   mode='pause';pauseResolve=null;stableFingerprint=db.metadataReviewFingerprint(item.id);currentCandidate=candidate;const controller=new AbortController();
   const pending=readCandidateCoverArt(request(),fastProvider,state,controller.signal);const rejected=assert.rejects(pending);await waitPaused();
   if(action==='cancel')controller.abort(new Error('fixture cancel'));if(action==='candidate-invalidated')currentCandidate=null;if(action==='fingerprint-changed')stableFingerprint='b'.repeat(64);
   if(action==='source-disabled'){const s=db.providerSettings.setting('cover-art-archive');db.providerSettings.configure({commandId:randomUUID(),providerId:'cover-art-archive',revision:s.revision,enabled:false});}
   pauseResolve();await rejected;report.cases.push('late reply discarded: '+action);
   if(!enabled()){const s=db.providerSettings.setting('cover-art-archive');db.providerSettings.configure({commandId:randomUUID(),providerId:'cover-art-archive',revision:s.revision,enabled:true});}
  }
  mode='retry';await fastProvider.index(releaseId,{fresh:true});assert.equal(fetcher.retried,true);report.cases.push('429 retry');
  mode='normal';await broker.request('cover-art-archive','release-index',new URL(`https://coverartarchive.org/release/${releaseId}/`),{Authorization:'fixture-private',Cookie:'fixture-private',Accept:'application/json','User-Agent':'fixture-public'},v=>v,{fresh:true});
  assert.equal(calls.at(-1).headers.Authorization,undefined);assert.equal(calls.at(-1).headers.Cookie,undefined);assert.equal(calls.at(-1).headers['User-Agent'],'fixture-public');report.cases.push('cross-host private headers dropped');
  broker.beginMaintenance('owned-mvp');await broker.waitMaintenance('owned-mvp');await assert.rejects(fastProvider.index(releaseId,{fresh:true}),/维护/);broker.endMaintenance('owned-mvp');report.cases.push('maintenance clears all CAA flights/cache');
  assert.equal(hash(fs.readFileSync(path.join(media,'song.mp3'))),hash(beforeMedia));assert.equal(db.getItem(item.id).title,item.title);report.mediaUnchanged=true;report.localMetadataUnchanged=true;
  const names=['src/library/cover-art-archive.ts','src/library/provider-broker.ts','src/library/providers.ts','src/library/service.ts','src/shared/contracts.ts','src/main/main.ts','src/main/preload.ts','src/renderer/cover-art-source-panel.tsx','src/renderer/main.tsx','dist/main/library/cover-art-archive.js','dist/main/library/provider-broker.js'];
  report.fingerprints=Object.fromEntries(names.map(name=>[name,hash(fs.readFileSync(path.join(project,name)))]));report.completed=true;
 }finally{
  broker?.dispose();mb?.dispose();db?.close();if(process.env.AURAL_CAA_MVP_REPORT)fs.writeFileSync(process.env.AURAL_CAA_MVP_REPORT,JSON.stringify(report,null,2));
  if(report.completed&&path.dirname(scratch)===parent&&path.basename(scratch).startsWith('aural-cover-source-mvp-')&&fs.realpathSync(scratch)===scratch)fs.rmSync(scratch,{recursive:true,force:true});
 }
 console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
