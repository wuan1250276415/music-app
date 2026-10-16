// Builds a test-only composition in an owned directory; never edits production certificates.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const project=path.resolve(__dirname,'..'),parent=path.resolve('D:/CodexTestData');
fs.mkdirSync(parent,{recursive:true});const scratch=fs.mkdtempSync(path.join(parent,'aural-tag-cert-mvp-'));
const build=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(project,'tests/helpers/build-tag-certification-candidate.ps1'),'-Scratch',scratch],{cwd:project,stdio:'inherit',windowsHide:true});
if(build.error)throw build.error;
if(build.status!==0)process.exit(build.status??1);
const suite=process.argv.includes('--coordinator')?'tag-coordinator-mvp.smoke.cjs':'native-tag-commit-recovery-mvp.smoke.cjs';
const result=spawnSync(process.execPath,[path.join(project,'tests',suite)],{cwd:project,env:{...process.env,AURAL_TAG_CANDIDATE_MANIFEST:path.join(scratch,'candidate-build.json')},stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;
process.exitCode=result.status??1;
