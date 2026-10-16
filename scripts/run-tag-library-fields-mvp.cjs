// Rebuild the pinned previous source in an owned scratch directory so the MVP
// verifies a genuine old frozen plan instead of relabelling a current fixture.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync,execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const project=path.resolve(__dirname,'..'),sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let previous=process.env.AURAL_TAG_PREVIOUS_COMPILED;
if(!previous){
 const parent=path.resolve('D:/CodexTestData');fs.mkdirSync(parent,{recursive:true});const scratch=fs.mkdtempSync(path.join(parent,'aural-tag-library-prior-')),app=path.join(scratch,'app'),archive=path.join(scratch,'previous222.zip'),ref='526e4e1bffefe5a9916e5ff0baf837d15506218a';
 assert.equal(fs.realpathSync(scratch),scratch);assert.match(scratch,/^D:\\CodexTestData\\aural-tag-library-prior-[A-Za-z0-9]+$/);fs.mkdirSync(app);
 execFileSync('git',['archive','--format=zip','--output',archive,ref,'--','src','scripts','release','native','themes','package.json','package-lock.json','tsconfig.main.json'],{cwd:project,windowsHide:true});
 const unpack=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command','& { param($archivePath,$destination) $ErrorActionPreference="Stop"; Expand-Archive -LiteralPath $archivePath -DestinationPath $destination }',archive,app],{cwd:project,windowsHide:true,encoding:'utf8'});if(unpack.error)throw unpack.error;if(unpack.status!==0)throw new Error('Previous-source extraction failed: '+unpack.stderr);
 const checkpoint=JSON.parse(fs.readFileSync(path.join(project,'docs/validation/v0.222-checkpoint.json'),'utf8'));let verified=0;
 for(const [name,digest] of Object.entries(checkpoint.sourceFingerprint)){const file=path.join(app,name);if(fs.existsSync(file)){assert.equal(sha(file),digest,name);verified++;}}
 assert.ok(verified>100);assert.equal(JSON.parse(fs.readFileSync(path.join(app,'package.json'))).version,'0.222.0');fs.symlinkSync(path.join(project,'node_modules'),path.join(app,'node_modules'),'junction');
 const generated=spawnSync(process.execPath,[path.join(app,'scripts/generate-release.cjs')],{cwd:app,windowsHide:true,stdio:'inherit'});if(generated.error)throw generated.error;if(generated.status!==0)process.exit(generated.status??1);
 const build=spawnSync(process.execPath,[path.join(project,'node_modules/typescript/bin/tsc'),'-p',path.join(app,'tsconfig.main.json')],{cwd:app,windowsHide:true,stdio:'inherit'});if(build.error)throw build.error;if(build.status!==0)process.exit(build.status??1);
 previous=path.join(app,'dist/main');fs.writeFileSync(path.join(scratch,'previous-build.json'),JSON.stringify({ref,version:'0.222.0',verifiedSourceFiles:verified,compiled:previous},null,2));console.log(JSON.stringify({previousVersion:'0.222.0',verifiedSourceFiles:verified,scratch}));
}
const test=spawnSync(process.execPath,[path.join(project,'tests/tag-library-fields-mvp.smoke.cjs')],{cwd:project,env:{...process.env,AURAL_TAG_PREVIOUS_COMPILED:previous},stdio:'inherit',windowsHide:true});if(test.error)throw test.error;process.exitCode=test.status??1;
