const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const {compose}=require('./tag-coordinator-composition.cjs');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function composeUI(project,manifest){
 const composition=compose(project,manifest),{app,compiled,runRoot}=composition;
 fs.cpSync(path.join(project,'src'),path.join(app,'src'),{recursive:true,errorOnExist:true,force:false});
 fs.copyFileSync(path.join(project,'vite.config.mts'),path.join(app,'vite.config.mts'),fs.constants.COPYFILE_EXCL);
 const sourceHashes={},except=new Set(['shared/tag-write-certification.ts','shared/tag-restore-certification.ts']);
 function collect(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())collect(file);else{const relative=path.relative(path.join(app,'src'),file).replaceAll('\\','/');if(except.has(relative))continue;const digest=sha(fs.readFileSync(file));assert.equal(digest,sha(fs.readFileSync(path.join(project,'src',relative))));sourceHashes[relative]=digest;}}}collect(path.join(app,'src'));
 for(const [name,field] of [['tag-write-certification','TAG_WRITE_CERTIFICATES'],['tag-restore-certification','TAG_RESTORE_CERTIFICATES']]){const values=require(path.join(compiled,'shared',name+'.js'))[field];fs.writeFileSync(path.join(app,'src/shared',name+'.ts'),'export const '+field+' = '+JSON.stringify(values)+' as const;\n');}
 const native=path.join(app,'native');fs.mkdirSync(native);
 for(const name of ['audio-host','media-worker','credential-vault','system-media'])fs.symlinkSync(path.join(project,'native',name),path.join(native,name),'junction');
 fs.mkdirSync(path.join(native,'tag-write-worker'));fs.symlinkSync(path.dirname(composition.candidate.commitExe),path.join(native,'tag-write-worker/build'),'junction');
 const built=spawnSync(process.execPath,[path.join(project,'node_modules/vite/bin/vite.js'),'build','--config',path.join(app,'vite.config.mts')],{cwd:app,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
 fs.writeFileSync(path.join(runRoot,'renderer-build.log'),(built.stdout??'')+(built.stderr??''));assert.equal(built.status,0,String(built.error??built.stderr));
 return {...composition,sourceHashes,verify(){composition.verify();for(const [relative,digest] of Object.entries(sourceHashes)){assert.equal(sha(fs.readFileSync(path.join(app,'src',relative))),digest);assert.equal(sha(fs.readFileSync(path.join(project,'src',relative))),digest);}}};
}
module.exports={composeUI};
