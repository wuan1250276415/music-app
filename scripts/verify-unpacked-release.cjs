const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.env.AURAL_BUILD_OUTPUT || path.join(root, 'build-out'));
const unpacked = path.join(output, 'win-unpacked');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'release/manifest.json'), 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const same = (source, packaged) => {
  if (!fs.existsSync(packaged) || hash(source) !== hash(packaged)) {
    throw new Error(`packaged file differs: ${packaged}`);
  }
};

for (const file of ['sbom.cdx.json', 'THIRD_PARTY_NOTICES.txt']) {
  same(path.join(root, 'release', file), path.join(unpacked, 'resources', file));
}
same(path.join(root, 'LICENSE'), path.join(unpacked, 'resources/AURAL_LICENSE.txt'));
same(path.join(root, 'native/audio-host/build/audio-host.exe'), path.join(unpacked, 'resources/audio-host.exe'));
same(path.join(root, 'native/asio-probe/build/asio-probe.exe'), path.join(unpacked, 'resources/asio-probe.exe'));
same(path.join(root, 'native/credential-vault/build/credential-vault.exe'), path.join(unpacked, 'resources/credential-vault.exe'));
same(path.join(root, 'native/audio-host/build/waveform-worker.exe'), path.join(unpacked, 'resources/waveform-worker.exe'));
same(path.join(root,'native/audio-host/build/dsd-analysis-worker.exe'),path.join(unpacked,'resources/dsd-analysis-worker.exe'));
same(path.join(root, 'native/media-worker/build/media-worker.exe'), path.join(unpacked, 'resources/media-worker.exe'));
same(path.join(root,'native/tag-write-worker/build/tag-write-worker.exe'),path.join(unpacked,'resources/tag-write-worker.exe'));
same(path.join(root,'native/tag-write-worker/build/tag-file-inspector.exe'),path.join(unpacked,'resources/tag-file-inspector.exe'));
same(path.join(root,'native/tag-write-worker/build/tag-file-committer.exe'),path.join(unpacked,'resources/tag-file-committer.exe'));
same(path.join(root,'native/tag-write-worker/build/tag-file-restorer.exe'),path.join(unpacked,'resources/tag-file-restorer.exe'));
same(path.join(root,'native/tag-write-worker/build/catalog-directory-mover.exe'),path.join(unpacked,'resources/catalog-directory-mover.exe'));
same(path.join(root,'native/system-media/build/system-media.exe'),path.join(unpacked,'resources/system-media.exe'));
const ffBuild = JSON.parse(fs.readFileSync(path.join(root, 'native/ffmpeg/build-manifest.json'), 'utf8'));
const ffEvidence = [];
for (const item of ffBuild.libraries) {
  const source = path.join(root, 'native/audio-host/build', item.file);
  if (hash(source) !== item.sha256) throw new Error(`stale FFmpeg library: ${item.file}`);
  same(source, path.join(unpacked, 'resources', item.file));
  ffEvidence.push(`resources/${item.file}`);
}
const ffSourceFiles = ['lock.json', 'source-patches.json', 'build-manifest.json', ...Object.keys(ffBuild.recipe)];
for (const file of fs.readdirSync(path.join(root, 'native/ffmpeg/vendor'))) ffSourceFiles.push(`vendor/${file}`);
for (const file of new Set(ffSourceFiles)) {
  same(path.join(root, 'native/ffmpeg', file), path.join(unpacked, 'resources/ffmpeg-source', file));
  ffEvidence.push(`resources/ffmpeg-source/${file}`);
}
const webpEvidence=[];
for(const file of ['lock.json','build-manifest.json','build.ps1',...fs.readdirSync(path.join(root,'native/webp/vendor')).map(name=>`vendor/${name}`)]){
 same(path.join(root,'native/webp',file),path.join(unpacked,'resources/webp-source',file));webpEvidence.push(`resources/webp-source/${file}`);
}
for (const file of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
  if (!fs.existsSync(path.join(unpacked, file))) throw new Error(`missing installed license: ${file}`);
}
const appAsar = path.join(unpacked, 'resources/app.asar');
// ASAR directory traversal uses the host path separator, including on Windows.
const extract = file => asar.extractFile(appAsar, file.split('/').join(path.sep));
// Verify every compiled application file, including Main and Renderer entry
// points. Targeted checks below also retain the dependency/format contracts.
const compiledFiles=[];
const verifyCompiled=(directory,prefix)=>{
  for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
    const source=path.join(directory,entry.name),relative=path.posix.join(prefix,entry.name);
    if(entry.isDirectory())verifyCompiled(source,relative);
    else if(entry.isFile()&&!entry.name.endsWith('.map')){
      const sha256=hash(source);
      if(crypto.createHash('sha256').update(extract(relative)).digest('hex')!==sha256)throw new Error(`packaged compiled application differs: ${relative}`);
      compiledFiles.push({path:relative,sha256});
    }
  }
};
verifyCompiled(path.join(root,'dist'),'dist');
const packagedManifest = JSON.parse(extract( 'release/manifest.json').toString('utf8'));
if (JSON.stringify(packagedManifest) !== JSON.stringify(manifest)) throw new Error('packaged release manifest differs');
const packagedPackage = JSON.parse(extract( 'package.json').toString('utf8'));
if (packagedPackage.version !== manifest.appVersion) throw new Error('packaged app version differs');
const pinnedPinyin=JSON.parse(extract('node_modules/pinyin-pro/package.json').toString('utf8'));
if(pinnedPinyin.version!=='3.29.4'||pinnedPinyin.license!=='MIT')throw new Error('packaged pinyin dependency differs');
for(const pinyinFile of ['node_modules/pinyin-pro/dist/index.js','node_modules/pinyin-pro/LICENSE'])if(crypto.createHash('sha256').update(extract(pinyinFile)).digest('hex')!==hash(path.join(root,pinyinFile)))throw new Error(`packaged pinyin source or license differs: ${pinyinFile}`);
if(crypto.createHash('sha256').update(extract('release/media-formats.json')).digest('hex')!==hash(path.join(root,'release/media-formats.json')))throw new Error('packaged media formats differ');
if(crypto.createHash('sha256').update(extract('release/tag-write-certification.json')).digest('hex')!==hash(path.join(root,'release/tag-write-certification.json')))throw new Error('packaged tag certification catalog differs');
if(crypto.createHash('sha256').update(extract('release/tag-restore-certification.json')).digest('hex')!==hash(path.join(root,'release/tag-restore-certification.json')))throw new Error('packaged restoration certification differs');
for(const mediaModule of ['dist/main/shared/cue-version-review.js','dist/main/library/cue-version-review.js','dist/main/shared/embedded-cue-bundle.js','dist/main/library/embedded-cue-bundle.js','dist/main/main/source-json-file.js','dist/main/main/embedded-cue-files.js','dist/main/library/cue-file-token.js','dist/main/shared/cue-source-export.js','dist/main/library/cue-source-export.js','dist/main/main/source-export-file.js','dist/main/main/cue-source-files.js','dist/main/shared/embedded-cue-history.js','dist/main/library/embedded-cue-history.js','dist/main/main/embedded-cue-export.js','dist/main/library/flac-cue-text.js','dist/main/library/flac-cue-reader.js','dist/main/shared/source-sample-range.js','dist/main/library/flac-cuesheet.js','dist/main/shared/catalog-move-reconciliation.js','dist/main/main/catalog-recorded-move-review.js','dist/main/main/catalog-normal-startup-error.js','dist/main/main/catalog-recovery-relaunch.js','dist/main/shared/catalog-restore-recovery.js','dist/main/main/catalog-restore-recovery.js','dist/main/shared/catalog-restore-consent.js','dist/main/main/catalog-restore-apply.js','dist/main/shared/catalog-restore-review.js','dist/main/library/catalog-restore-review.js','dist/main/platform/catalog-restore-completion.js','dist/main/main/catalog-restore-lineage.js','dist/main/main/catalog-restore-completion.js','dist/main/shared/catalog-normal-open.js','dist/main/library/catalog-normal-open.js','dist/main/shared/catalog-restore-finalization.js','dist/main/main/catalog-restore-finalization.js','dist/main/shared/catalog-restore-application.js','dist/main/main/catalog-restore-application.js','dist/main/platform/catalog-restore-release.js','dist/main/main/catalog-restore-release.js','dist/main/platform/catalog-restore-commit.js','dist/main/main/catalog-restore-commit.js','dist/main/library/catalog-restore-state.js','dist/main/platform/catalog-restore-normal.js','dist/main/main/catalog-restore-normal.js','dist/main/shared/catalog-restore-renderer.js','dist/main/main/catalog-restore-renderer.js','dist/main/shared/catalog-restore-state.js','dist/main/platform/catalog-restore-hydration.js','dist/main/main/catalog-restore-hydration.js','dist/main/shared/catalog-restore-pending.js','dist/main/platform/catalog-restore-pending-files.js','dist/main/main/catalog-restore-pending.js','dist/main/shared/catalog-restore-policy.js','dist/main/library/catalog-restore-policy.js','dist/main/platform/catalog-restore-activation.js','dist/main/platform/catalog-restore-cutover.js','dist/main/main/catalog-restore-cutover.js','dist/main/platform/catalog-library-lifecycle.js','dist/main/main/catalog-library-lifecycle.js','dist/main/shared/catalog-restore-transaction.js','dist/main/main/catalog-restore-transaction-store.js','dist/main/main/catalog-restore-maintenance.js','dist/main/main/catalog-restore-preparation.js','dist/main/library/catalog-restore-preparation-worker.js','dist/main/main/catalog-restore-startup.js','dist/main/shared/catalog-directory-move.js','dist/main/main/catalog-directory-mover.js','dist/main/main/catalog-directory-move-journal.js','dist/main/shared/catalog-restore-compatibility.js','dist/main/library/catalog-restore-compatibility.js','dist/main/library/schema-snapshot.js','dist/main/shared/catalog-restore-history.js','dist/main/shared/catalog-restore.js','dist/main/main/catalog-restore.js','dist/main/main/catalog-restore-store.js','dist/main/library/catalog-restore-worker.js','dist/main/shared/catalog-backup-history.js','dist/main/main/catalog-backup-ledger.js','dist/main/shared/catalog-backup-ui.js','dist/main/shared/catalog-backup-worker.js','dist/main/main/catalog-backup.js','dist/main/main/catalog-backup-publication.js','dist/main/library/catalog-backup-worker.js','dist/main/main/maintenance-hold.js','dist/main/main/catalog-main-resources.js','dist/main/shared/catalog-maintenance.js','dist/main/library/catalog-maintenance.js','dist/main/library/catalog-backup-snapshot.js','dist/main/platform/catalog-backup-file.js','dist/main/shared/catalog-backup.js','dist/main/library/catalog-backup-database.js','dist/main/main/catalog-backup-file.js','dist/main/shared/history-export.js','dist/main/library/history-export-worker.js','dist/main/main/history-export.js','dist/main/main/history-export-file.js','dist/main/shared/playback-policy.js','dist/main/library/playback-policy.js','dist/main/shared/playback-history.js','dist/main/library/playback-history.js','dist/main/main/playback-history.js','dist/main/shared/smart-playlists.js','dist/main/library/smart-playlists.js','dist/main/library/library-query-plan.js','dist/main/shared/library-sort.js','dist/main/library/natural-sort.js','dist/main/shared/music-filters.js','dist/main/library/music-filters.js','dist/main/library/search-spelling.js','dist/main/shared/tag-origin-policy.js','dist/main/library/tag-origin-policy.js','dist/main/shared/tag-restore-reprobe.js','dist/main/library/tag-restore-reprobe-proof.js','dist/main/library/tag-restore-reprobe-schema.js','dist/main/shared/tag-restore-recovery.js','dist/main/library/tag-restore-recovery-schema.js','dist/main/shared/tag-restore-journal.js','dist/main/library/tag-restore-journal.js','dist/main/library/tag-restore-schema.js','dist/main/shared/tag-restore.js','dist/main/shared/tag-restore-certification.js','dist/main/library/tag-file-restorer.js','dist/main/shared/tag-commit-reprobe.js','dist/main/library/tag-commit-reprobe-proof.js','dist/main/library/tag-commit-reprobe-schema.js','dist/main/library/tag-commit-reconcile-schema.js','dist/main/shared/tag-commit-recovery.js','dist/main/library/tag-commit-recovery-schema.js','dist/main/shared/tag-commit-journal.js','dist/main/library/tag-commit-journal.js','dist/main/library/tag-commit-schema.js','dist/main/shared/tag-commit.js','dist/main/shared/tag-write-certification.js','dist/main/library/tag-file-committer.js','dist/main/shared/tag-recovery.js','dist/main/library/tag-file-inspector.js','dist/main/library/tag-recovery-schema.js','dist/main/library/tag-recovery-action-schema.js','dist/main/library/tag-write-worker-entry.js','dist/main/library/tag-write-worker-client.js','dist/main/library/tag-write-worker-protocol.js','dist/main/library/tag-write-manager.js','dist/main/library/tag-write-jobs.js','dist/main/library/tag-write-execution-schema.js','dist/main/library/file-read-gate.js','dist/main/library/flac-tag-staging.js','dist/main/library/tag-write-journal.js','dist/main/library/media-worker-entry.js','dist/main/library/artwork-worker.js','dist/main/library/flac-artwork.js','dist/main/library/id3-artwork.js','dist/main/shared/rule-transfer.js','dist/main/library/rule-transfer.js','dist/main/main/rule-transfer-files.js','dist/main/library/artwork-store.js','dist/main/library/lyrics-worker.js','dist/main/library/lyrics-loader.js','dist/main/library/lyrics-local-history.js','dist/main/main/artwork-resources.js','dist/main/main/audio-devices.js','dist/main/main/audio-output-manager.js','dist/main/library/audio-output-settings.js','dist/main/shared/audio-output.js','dist/main/main/audio-capabilities.js','dist/main/main/audio-device-watch.js','dist/main/shared/audio-capabilities.js','dist/main/shared/playback-clock.js','dist/main/shared/audio-processing.js','dist/main/shared/pipeline-plan.js','dist/main/shared/decoder-source.js','dist/main/shared/playback-file.js','dist/main/shared/desktop-preference.js','dist/main/main/desktop-lifecycle.js','dist/main/main/pause-release.js','dist/main/main/media-keys.js','dist/main/shared/search-index.js','dist/main/library/search-text.js','dist/main/library/search-index.js','dist/main/shared/catalog-browse.js','dist/main/library/catalog-browse.js','dist/main/shared/library-browse.js','dist/main/library/library-browse.js','dist/main/library/browse-clock.js','dist/main/main/window-placement.js','dist/main/shared/window-placement.js','dist/main/main/appearance.js','dist/main/shared/appearance.js','dist/main/main/desktop-files.js','dist/main/library/desktop-sources.js','dist/main/shared/desktop-files.js','dist/main/shared/media-formats.js','dist/main/main/system-media.js','dist/main/shared/system-media.js','dist/main/shared/media-key-preference.js','dist/main/library/replay-gain.js']){
 if(crypto.createHash('sha256').update(extract(mediaModule)).digest('hex')!==hash(path.join(root,mediaModule)))throw new Error(`packaged media component differs: ${mediaModule}`);
}

const installer = path.join(output, `Aural-Setup-${manifest.appVersion}-x64.exe`);
for(const file of ['dist/main/shared/file-policy.js','dist/main/shared/cue-history.js','dist/main/library/cue-history.js','dist/main/library/file-policy.js','dist/main/library/database.js','dist/main/library/service.js','dist/main/platform/file-observation.js','dist/main/library/file-observation.js','dist/main/library/scan-manager.js','dist/main/library/scan-jobs.js','dist/main/shared/library-watch.js','dist/main/library/library-watch-store.js','dist/main/library/library-watch-manager.js','dist/main/platform/file-watcher.js']){
  if(crypto.createHash('sha256').update(extract(file)).digest('hex')!==hash(path.join(root,file)))throw new Error(`packaged library watch component differs: ${file}`);
}
if (!fs.existsSync(installer)) throw new Error(`missing installer: ${installer}`);
const binaryFiles = [];
const visit = (directory, prefix = '') => {
  for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
    const relative = path.posix.join(prefix, entry.name);
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute, relative);
    else if (/\.(exe|dll)$/i.test(entry.name)) {
      binaryFiles.push({path: relative, sha256: hash(absolute)});
    }
  }
};
visit(unpacked);
binaryFiles.sort((a, b) => a.path.localeCompare(b.path, 'en'));
const report = {
  appId: manifest.appId,
  appVersion: manifest.appVersion,
  audioProtocol: manifest.audioProtocol,
  librarySchema: manifest.librarySchema,
  installer: {file: path.basename(installer), sha256: hash(installer)},
  unpackedAppAsarSha256: hash(appAsar),
  binaryFiles,
  compiledFiles,
  packagedEvidence: ['resources/sbom.cdx.json', 'resources/THIRD_PARTY_NOTICES.txt', 'resources/AURAL_LICENSE.txt', 'resources/asio-probe.exe', 'resources/credential-vault.exe', 'resources/waveform-worker.exe', 'resources/media-worker.exe', 'resources/tag-write-worker.exe', 'resources/tag-file-inspector.exe','resources/tag-file-committer.exe', 'resources/system-media.exe', 'LICENSE.electron.txt', 'LICENSES.chromium.html', ...ffEvidence,...webpEvidence]
};
const reportPath = path.join(output, `Aural-${manifest.appVersion}-distribution-hashes.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`verified unpacked release and installer; ${binaryFiles.length} executable/DLL hashes: ${reportPath}`);
