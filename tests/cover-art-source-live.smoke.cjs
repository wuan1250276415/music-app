const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const {ProviderBroker}=require('../dist/main/library/provider-broker.js');
const {CoverArtArchiveProvider,coverArtArchivePolicy}=require('../dist/main/library/cover-art-archive.js');
async function main(){
 const report={version:require('../package.json').version,completed:false,scope:'real public CAA release JSON index through production broker/provider for official API example; no user media, no real MusicBrainz matching, no image downloads or desktop apply',releaseId:'76df3287-6cda-33eb-8e9a-044b5e15ffdd',requests:[]};
 const broker=new ProviderBroker(async(input,init)=>{const start=Date.now();const response=await fetch(input,init);report.requests.push({url:String(input),status:response.status,location:response.headers.get('location'),durationMs:Date.now()-start});return response;});broker.register(coverArtArchivePolicy);
 try{
  const provider=new CoverArtArchiveProvider(broker),value=await provider.index(report.releaseId,{fresh:true});assert.equal(value.availability,'found');assert.ok(value.entries.length);assert.ok(value.entries.some(e=>e.front));assert.equal(value.imageRights.display,false);assert.equal(value.indexRights.persist,false);
  report.result={entryCount:value.entries.length,frontImageIds:value.entries.filter(e=>e.front).map(e=>e.imageId),sourceUrl:value.sourceUrl,fetchedAt:value.fetchedAt,expiresAt:value.expiresAt,imageRights:value.imageRights};
  assert.ok(report.requests.every(r=>!r.url.includes('.jpg')&&!r.url.includes('.png')&&!r.url.includes('/front')));
  report.fingerprints=Object.fromEntries(['src/library/cover-art-archive.ts','src/library/provider-broker.ts','dist/main/library/cover-art-archive.js','dist/main/library/provider-broker.js'].map(name=>[name,createHash('sha256').update(fs.readFileSync(path.join(__dirname,'..',name))).digest('hex')]));report.completed=true;
 }catch(e){report.error=String(e);throw e;}finally{broker.dispose();if(process.env.AURAL_CAA_LIVE_REPORT)fs.writeFileSync(process.env.AURAL_CAA_LIVE_REPORT,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
