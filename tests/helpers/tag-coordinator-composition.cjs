// Isolated test composition: production JS is copied unchanged except generated certificate catalogs.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function compose(project,manifestFile){
 const candidate=JSON.parse(fs.readFileSync(manifestFile)),root=path.resolve(candidate.root);
 assert.match(root,/^D:\\CodexTestData\\aural-tag-cert-mvp-[A-Za-z0-9]+$/);
 assert.equal(fs.realpathSync(root),root);
 for(const [relative,digest] of Object.entries(candidate.sourceHashes))assert.equal(sha(fs.readFileSync(path.join(project,relative))),digest);
 const runRoot=fs.mkdtempSync(path.join(root,'coordinator-run-')),app=path.join(runRoot,'app');fs.mkdirSync(app);
 const compiled=path.join(app,'dist/main');fs.cpSync(path.join(project,'dist/main'),compiled,{recursive:true,errorOnExist:true,force:false});
 fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({private:true,type:'commonjs'}),{flag:'wx'});
 fs.symlinkSync(path.join(project,'node_modules'),path.join(app,'node_modules'),'junction');
 const hashes={},overrides=new Set(['shared/tag-write-certification.js','shared/tag-restore-certification.js']);
 function collect(folder){for(const item of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())collect(file);else{const relative=path.relative(compiled,file).replaceAll('\\','/');if(overrides.has(relative))continue;const digest=sha(fs.readFileSync(file));assert.equal(digest,sha(fs.readFileSync(path.join(project,'dist/main',relative))));hashes[relative]=digest;}}}collect(compiled);
 const evidenceSha256=sha(JSON.stringify({native:candidate.sourceHashes,compiled:hashes}));
 const certificate={id:candidate.commitId,adapter:'aural-flac-vorbis-preserve-v1',filesystem:'local-ntfs',scheme:'exclusive-handle-rename-pair-v1',evidenceSha256};
 fs.writeFileSync(path.join(compiled,'shared/tag-write-certification.js'),'exports.TAG_WRITE_CERTIFICATES='+JSON.stringify([certificate])+';\n');
 fs.writeFileSync(path.join(compiled,'shared/tag-restore-certification.js'),'exports.TAG_RESTORE_CERTIFICATES='+JSON.stringify(['victim','backup'].map(mode=>({id:candidate[mode+'Id'],adapter:'aural-flac-restore-v2',filesystem:'local-ntfs',scheme:`exclusive-handle-restore-${mode}-original-policy-v2`,mode,evidenceSha256})))+';\n');
 const native=path.dirname(candidate.commitExe);
 for(const name of ['tag-file-committer.exe','tag-file-restorer.exe'])assert.equal(sha(fs.readFileSync(path.join(native,name))),candidate.binaries[name]);
 for(const name of ['tag-write-worker.exe','tag-file-inspector.exe']){const from=path.join(project,'native/tag-write-worker/build',name),to=path.join(native,name);if(fs.existsSync(to))assert.equal(sha(fs.readFileSync(to)),sha(fs.readFileSync(from)));else fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);}
 return {candidate,root,runRoot,app,compiled,hashes,evidenceSha256,verify(){for(const [relative,digest] of Object.entries(hashes)){assert.equal(sha(fs.readFileSync(path.join(compiled,relative))),digest);assert.equal(sha(fs.readFileSync(path.join(project,'dist/main',relative))),digest);}assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project,'release/tag-write-certification.json'))).certificates,[]);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project,'release/tag-restore-certification.json'))).certificates,[]);}};
}
module.exports={compose};
