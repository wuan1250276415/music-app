import {readMetadataWorkflowCommand,workflowOrigin,workflowId,readWorkflowReview} from '../shared/metadata-workflow.js';
import {readFingerprintFind,readFingerprintChoice,readFingerprintToken} from '../shared/audio-fingerprint.js';
import {AudioFingerprintWorker} from './audio-fingerprint.js';
import {AcoustidProvider} from './acoustid.js';
import {readMetadataBatchOrigin} from '../shared/metadata-batch-recheck.js';
import {readMetadataIdentityPreview,readMetadataIdentityApply} from '../shared/metadata-identities.js';
import {readMetadataAlbumBatch,readMetadataAlbumPage,readMetadataAlbumTracks} from '../shared/metadata-album-review.js';
import {readReleaseFieldsApply,readReleaseFieldsUndo} from '../shared/metadata-release-fields.js';
import {inspectCueSourceBundle} from './cue-source-export.js';
import {inspectEmbeddedCueSourceBundle} from './embedded-cue-bundle.js';
import {readRestoreLibraryReleaseRequest,readRestoreLibraryReleaseProof,type RestoreLibraryReleaseProof} from '../platform/catalog-restore-release.js';
import {restoreLibrarySnapshot} from './catalog-restore-state.js';
import {readRestoreServiceReadyRequest,readRestoreServiceReadyProof,type RestoreServiceReadyProof} from '../platform/catalog-restore-commit.js';
import {readRestoreNormalRequest,readRestoreNormalProof,type RestoreNormalProof} from '../platform/catalog-restore-normal.js';
import {CatalogRestoreTransactionStore} from '../main/catalog-restore-transaction-store.js';
import {readRestoreHydrationRequest,readRestoreHydrationProof,type RestoreHydrationProof} from '../platform/catalog-restore-hydration.js';
import {readCatalogRestoreActivationRequest,readCatalogRestoreActivationProof,type CatalogRestoreActivationProof} from '../platform/catalog-restore-activation.js';
import {CatalogMaintenance} from './catalog-maintenance.js';
import {captureQuiescedCatalog} from './catalog-backup-snapshot.js';
import {providerBackupComponents} from './providers.js';
import {RELEASE} from '../shared/release.js';
import {readMetadataEditionsRequest} from '../shared/metadata-editions.js';
import {readMetadataReleaseContextRequest} from '../shared/metadata-release-context.js';
import {readCatalogRestoreBootRequest,readCatalogRestoreBootProof,readCatalogServiceStopRequest,readCatalogServiceStopReceipt,lifecycleDigest,type CatalogServiceStopReceipt,type CatalogRestoreBootRequest} from '../platform/catalog-library-lifecycle.js';
import {restoreTransactionFields,restoreTransactionDigest,RESTORE_TRANSACTION_FRAME_BYTES} from '../shared/catalog-restore-transaction.js';
import {restoreTransactionDirectory} from '../main/catalog-restore-transaction-store.js';
import {inventoryCatalogLibraryRoot} from '../platform/catalog-backup-file.js';
import {readCatalogBackupManifest} from '../shared/catalog-backup.js';
import {CatalogRestoreCompatibilityInspector} from './catalog-restore-compatibility.js';
import {previewMusicQuery,checkMusicPreview} from './music-preview.js';
import {browseLibrary,browsePlayContext} from './library-browse.js';
import {net} from 'electron';
import {verifyCompletedNormalOpen} from './catalog-normal-open.js';
import {randomUUID} from 'node:crypto';
import type {LibraryStartupMessage,LibraryStartupPhase} from '../shared/startup-progress.js';
import {StartupRpcTrace} from '../platform/startup-rpc-trace.js';
import {ProviderBroker} from './provider-broker.js';
import { mkdirSync,promises as fs } from 'node:fs';
import path from 'node:path';
import { LibraryDatabase } from './database.js';
import {ScanManager} from './scan-manager.js';
import {LibraryWatchManager} from './library-watch-manager.js';
import {validateScanCommand} from './scan-jobs.js';
import {LocalLyricsLoader} from './lyrics-loader.js';
import {lyricsScope,validateLyricsRequest} from './lyrics-preferences.js';
import {previewLyricsImport,validateLyricsDocumentRequest,validateSavedLyricsStateRequest} from './lyrics-documents.js';
import {fileObservation} from '../platform/file-observation.js';
import {artworkFingerprint} from './artwork.js';
import {MediaParser,MediaWorkerExitUnconfirmed} from './media-worker-client.js';
import {TagWriteManager} from './tag-write-manager.js';
import {FileReadGate} from './file-read-gate.js';
import {mediaStat,sameMediaStat,insideMediaRoot,MediaBoundaryError} from './media-worker-protocol.js';
import { ArtworkCache } from '../shared/artwork-cache.js';
import {readBatchReviewItems,readBatchReviewToken} from '../shared/metadata-batch-review.js';
import {readMetadataMatchRequest} from '../shared/metadata-match-request.js';
import { MusicBrainzProvider, validContact } from './musicbrainz.js';
import {registerProviders,providerManifest,type ProviderCredentials} from './providers.js';
import {CoverArtArchiveProvider,readCandidateCoverArt,readCandidateCoverArtImage,validateCoverArtSourceRequest} from './cover-art-archive.js';
import {convertOnlineImage} from './online-image-converter.js';
import {WindowsCredentialVault} from './credential-vault.js';
import {WaveformManager} from './waveforms.js';
import type { RequestMessage, ResponseMessage, EventMessage, ListRequest, MetadataApplyRequest, QueueState, UserStateRequest, PlaylistEditRequest, ArtistRole, CatalogLinkRequest, ArtistEditRequest, ReleaseEditRequest, ArtistProfileRequest, ArtistProfileRef,ReleaseProfileRequest,EntityReferenceKind,EntityReferenceRequest,EntityReferenceRef } from '../shared/contracts.js';

type Port = { on(event: 'message', listener: (event: { data: RequestMessage }) => void): void; postMessage(value: ResponseMessage | EventMessage | LibraryStartupMessage): void };
const port = (process as typeof process & { parentPort?: Port }).parentPort;
if (!port) throw new Error('Library Service 必须由 Electron utilityProcess 启动');
const startupRpcTrace=new StartupRpcTrace('library');

let db: LibraryDatabase | undefined;
let libraryDataDir='';let runtimeParameters:unknown;
const serviceInstanceId=randomUUID();let restoreDormant=false,initClaimed=false,initializing=false;
let dormantBoot:{request:CatalogRestoreBootRequest;proof:import('../platform/catalog-library-lifecycle.js').CatalogRestoreBootProof}|null=null;
let activationWork:Promise<CatalogRestoreActivationProof>|null=null,activationKey='';
let hydrationWork:Promise<RestoreHydrationProof>|null=null,hydrationKey='';
let normalWork:Promise<RestoreNormalProof>|null=null,normalKey='';
let committedReadyWork:Promise<RestoreServiceReadyProof>|null=null,committedReadyKey='';
let committedReleaseWork:Promise<RestoreLibraryReleaseProof>|null=null,committedReleaseKey='';
let closedReceipt:CatalogServiceStopReceipt|null=null,closedAckTimer:NodeJS.Timeout|undefined;
let restoreTimer:ReturnType<typeof setInterval>|undefined;let restoreError='';
let restoreWork:Promise<void>|undefined;
function restoreFiles():void{
 if(catalogMaintenance.held||restoreWork||!db||!scans||!tagWrite||db.restorePolicy.load())return;
 const currentDb=db,currentScans=scans,currentTags=tagWrite;
 restoreWork=(async()=>{
  for(const id of currentDb.tagWriteJobs.pendingRestoreReprobeReleases()){if(catalogMaintenance.held)return;await currentTags.releaseRestoreReprobe(id);}
  if(catalogMaintenance.held||db!==currentDb||scans!==currentScans||tagWrite!==currentTags)return;
  for(const id of currentDb.tagWriteJobs.pendingReprobeReleases())currentTags.releaseReprobe(id);
  for(const id of currentDb.tagWriteJobs.pendingRecoveryReleases())currentTags.releaseResolved(id);
  for(const pending of [...currentDb.tagWriteJobs.pendingRecoveryScans(),...currentDb.filePolicy.pendingRestores(),...currentDb.cueSources.pendingScans()].slice(0,64)){
   if(currentDb.scanJobs.activeForRoot(pending.rootId)||currentDb.scanJobs.startReceipt(pending.commandId))continue;
   const result=currentScans.command({commandId:pending.commandId,rootId:pending.rootId,action:'start'},'realPath' in pending&&typeof pending.realPath==='string'?pending.realPath:undefined);if(result.status!=='saved')throw new Error(result.error);
  }restoreError='';
 })().catch(e=>{restoreError=String(e instanceof Error?e.message:e).slice(0,512);}).finally(()=>{restoreWork=undefined;});
}

let providerCredentials:ProviderCredentials|undefined;
let waveforms:WaveformManager|undefined;let fingerprints:AudioFingerprintWorker|undefined;
const networkBroker=new ProviderBroker((input,init)=>net.fetch(String(input),{...init,bypassCustomProtocolHandlers:true}),()=>networkChanged());registerProviders(networkBroker);
const musicBrainz=new MusicBrainzProvider(()=>db?.metadataContact()??'',fetch,networkBroker,itemId=>db?.metadataRecordingLookupContext(itemId).fingerprint??null,itemId=>db?.metadataReviewFingerprint(itemId)??null);
const coverArtArchive=new CoverArtArchiveProvider(networkBroker);
const acoustid=new AcoustidProvider(networkBroker,()=>providerCredentials!.acoustidClientKey(),()=>db?.providerSettings.setting('acoustid').enabled===true,id=>db?.metadataRecordingLookupContext(id).fingerprint??null,id=>db?.metadataReviewFingerprint(id)??null,(token,itemId)=>workflowReviewExpiry(token,itemId));
const workflowReviews=new Map<string,import('../shared/metadata-workflow.js').MetadataWorkflowOrigin>();
function workflowReviewExpiry(token:string,itemId:string):string{const expires=musicBrainz.checkReview(token,itemId),origin=workflowReviews.get(token);if(!origin)return expires;const claim=db!.metadataWorkflows.assertClaim(origin);if(!claim.items.some(i=>i.id===itemId))throw new Error('歌曲已不在任务审核页');return new Date(Math.min(Date.parse(expires),claim.expiresAt)).toISOString();}
function closeWorkflowReviews(jobId:string):void{for(const [token,origin] of workflowReviews)if(origin.jobId===jobId){for(const [id,q] of metadataQueries)if(q.reviewToken===token)cancelMetadataQuery(id);acoustid.closeReview(token);musicBrainz.closeReview(token);workflowReviews.delete(token);}}
const metadataQueries=new Map<string,{itemId:string;controller:AbortController;provider?:'cover-art-archive'|'acoustid';reviewToken?:string}>();
function networkState():import('../shared/contracts.js').MetadataNetworkState{return {...networkBroker.state('musicbrainz'),provider:'musicbrainz',enabled:db?.metadataNetworkEnabled()??false,retentionMode:db?.metadataRetentionMode()??'preview-only',proxy:'system'};}
function networkChanged():void{if(db)reply({event:'metadataNetwork',payload:networkState()});}
function cancelMetadataQuery(requestId:string):void{acoustid.clear(requestId);db?.releaseFields.clear(requestId);db?.metadataAlbums.clear(requestId);db?.metadataIdentities.clear(requestId);db?.metadataGroupLinks.clear(requestId);db?.metadataAlbumCredits.clear(requestId);metadataQueries.get(requestId)?.controller.abort(new Error('在线查询已取消'));musicBrainz.invalidate(requestId);}
function invalidateCoverArtNetwork():void{for(const query of metadataQueries.values())if(query.provider==='cover-art-archive')query.controller.abort(new Error('封面来源查询状态已变化'));networkBroker.clear('cover-art-archive',true);}
function invalidateMetadataNetwork():void{workflowReviews.clear();acoustid.clear();fingerprints?.clear();networkBroker.clear('acoustid',true);db?.releaseFields.clear();db?.metadataAlbums.clear();db?.metadataIdentities.clear();db?.metadataGroupLinks.clear();db?.metadataAlbumCredits.clear();for(const query of metadataQueries.values())query.controller.abort(new Error('在线查询状态已变化'));musicBrainz.invalidate();networkBroker.clear('musicbrainz',true);invalidateCoverArtNetwork();}
let scans:ScanManager|undefined;
let libraryWatch:LibraryWatchManager|undefined;
let mediaParser:MediaParser|undefined;
let tagWrite:TagWriteManager|undefined;
const serviceReads=new FileReadGate();
let localLyrics:LocalLyricsLoader|undefined;
let lastScanLibraryNotice=0;
const artworkRequests = new ArtworkCache<import('../shared/contracts.js').ArtworkCandidate>(32,64*1024*1024,value=>value.url.length*2);
const reply = (message: ResponseMessage | EventMessage) => port.postMessage(message);
let searchIndexTimer:ReturnType<typeof setTimeout>|undefined,searchIndexEpoch=0,lastSearchIndexNotice=0,searchIndexFault='';
function scheduleSearchIndex(epoch=searchIndexEpoch):void{
 if(catalogMaintenance.held||searchIndexTimer||!db||db.searchIndexState().status!=='building')return;
 searchIndexTimer=setTimeout(()=>{
  searchIndexTimer=undefined;if(catalogMaintenance.held||epoch!==searchIndexEpoch||!db)return;
  try{const state=db.stepSearchIndex();if(state.status!=='building'||Date.now()-lastSearchIndexNotice>=2000){lastSearchIndexNotice=Date.now();reply({event:'searchIndexChanged',payload:state});}
   if(state.status==='ready')reply({event:'libraryChanged',payload:{reason:'search-index-ready'}});
   else if(state.status==='building')scheduleSearchIndex(epoch);
  }catch(error){searchIndexFault=String(error instanceof Error?error.message:error).slice(0,512);reply({event:'searchIndexChanged',payload:{error:searchIndexFault}});}
 },50);searchIndexTimer.unref();
}

function startScan(rootId:string,commandId:string=randomUUID(),authorizedRealPath?:string):{rootId:string;jobId:string}{
 const result=scans!.command({commandId,action:'start',rootId},authorizedRealPath);if(result.status!=='saved'||!result.job)throw new Error(result.error);return {rootId,jobId:result.job.id};
}

function constructLibraryRuntime(params:unknown,folder:string,paused:boolean):void{
 const currentDb=db;if(!currentDb)throw new Error('曲库连接尚未准备好');
 const vaultPath=(params as {credentialVaultPath?:string}).credentialVaultPath;if(typeof vaultPath!=='string'||!path.isAbsolute(vaultPath))throw new Error('凭据保管组件路径无效');
    providerCredentials=currentDb.providerCredentials(new WindowsCredentialVault(vaultPath));
    const waveformPath=(params as {waveformPath?:string}).waveformPath;if(typeof waveformPath!=='string'||!path.isAbsolute(waveformPath))throw new Error('波形分析组件路径无效');
    const mediaWorkerPath=(params as {mediaWorkerPath?:string}).mediaWorkerPath;if(typeof mediaWorkerPath!=='string'||!path.isAbsolute(mediaWorkerPath))throw new Error('媒体监督组件路径无效');
    waveforms=new WaveformManager(currentDb.waveforms,waveformPath,id=>currentDb.waveformSource(id),id=>currentDb.itemFileId(id),paused);
    const fingerprintPath=(params as {fingerprintPath?:string}).fingerprintPath;if(typeof fingerprintPath!=='string'||!path.isAbsolute(fingerprintPath))throw new Error('指纹组件路径无效');fingerprints=new AudioFingerprintWorker(fingerprintPath,id=>currentDb.waveformSource(id));
    mediaParser=new MediaParser(mediaWorkerPath);
    const tagWorkerPath=(params as {tagWorkerPath?:string}).tagWorkerPath;if(typeof tagWorkerPath!=='string'||!path.isAbsolute(tagWorkerPath))throw new Error('标签暂存监督组件路径无效');
    tagWrite=new TagWriteManager(currentDb,mediaParser,{dataDir:folder,executable:tagWorkerPath,quiesce:async(fileId,filename,owner)=>{await Promise.all([serviceReads.quiesce(filename,owner),scans!.quiesceFile(filename,owner),waveforms!.quiesceFile(fileId),fingerprints!.quiesceFile(fileId)]);},release:(filename,owner)=>{serviceReads.release(filename,owner);scans!.releaseFile(filename,owner);},releaseRecovered:(filename,owner)=>{serviceReads.releaseRecovered(filename,owner);scans!.releaseRecoveredFile(filename,owner);},invalidated:jobId=>{artworkRequests.clear();reply({event:'libraryChanged',payload:{jobId,reason:'tag-commit-review'}});},recovered:jobId=>{artworkRequests.clear();reply({event:'libraryChanged',payload:{jobId,reason:'tag-recovery-rescan'}});},changed:(jobId,error)=>reply({event:'tagWriteJobsChanged',payload:{jobId,...(error?{error}:{})}})});
    localLyrics=new LocalLyricsLoader(mediaParser);
    scans=new ScanManager(currentDb,state=>reply({event:'scan',payload:state}),(jobId,final)=>{reply({event:'scanJobsChanged',payload:{jobId}});libraryWatch?.observeScan(jobId);if(final||Date.now()-lastScanLibraryNotice>=2000){lastScanLibraryNotice=Date.now();if(final)artworkRequests.clear();reply({event:'libraryChanged',payload:{jobId}});}},mediaParser);
    libraryWatch=new LibraryWatchManager(currentDb,scans,state=>reply({event:'libraryWatchChanged',payload:state}),rootId=>{artworkRequests.clear();reply({event:'libraryChanged',payload:{rootId,reason:'local-files-changed'}});},[folder,path.resolve(__dirname,'../../..')]);
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  if (method === 'init'||method==='catalogRestoreInit') {
    if(db)throw new Error('曲库已初始化，不能替换活动连接');
    const restore=method==='catalogRestoreInit'?readCatalogRestoreBootRequest((params as {restore?:unknown})?.restore):null;
    if(!restore&&(params as {restore?:unknown})?.restore!==undefined)throw new Error('普通启动不能包含恢复启动指令');
    tagWrite?.close();
    libraryWatch?.close();
    const folder = String((params as { dataDir: string }).dataDir);
    if(!path.isAbsolute(folder)||folder.length>32767)throw new Error('曲库目录无效');libraryDataDir=folder;
    if(restore){if(path.basename(folder)!=='library'||path.resolve(folder)!==folder||await restoreTransactionDirectory(folder)!==restore.libraryIdentity)throw new Error('恢复启动目标不是原请求中的固定曲库');}
    const existing=restore?null:(params as {existingLibrary?:unknown}).existingLibrary;const normalPermission=existing===undefined||existing===null?null:await verifyCompletedNormalOpen(folder,existing);
    if(!restore&&!normalPermission)mkdirSync(folder,{recursive:true});
    const vaultPath=(params as {credentialVaultPath?:string}).credentialVaultPath;
    if(typeof vaultPath!=='string'||!path.isAbsolute(vaultPath))throw new Error('凭据保管组件路径无效');
    let compatibility:import('../shared/catalog-restore-compatibility.js').CatalogRestoreCompatibility|undefined;
    if(restore){compatibility=await verifyDormantLibrary(folder,restore);restoreDormant=true;}
    const progress=restore?undefined:(phase:LibraryStartupPhase)=>port!.postMessage({startupProgress:phase});
    progress?.('library-open');
    db = new LibraryDatabase(path.join(folder,'library.db'),{restoreDormant:Boolean(restore),startupProgress:progress});
    if(normalPermission&&(db.historyExportOrigin()!==normalPermission.origin||await restoreTransactionDirectory(folder)!==normalPermission.libraryIdentity))throw new Error('普通数据库构建后已完成恢复的来源或目录不同');
    if(searchIndexTimer)clearTimeout(searchIndexTimer);searchIndexTimer=undefined;searchIndexEpoch++;lastSearchIndexNotice=0;searchIndexFault='';
    progress?.('library-runtime');
    runtimeParameters=params;constructLibraryRuntime(params,folder,Boolean(restore));
    if(restore){
      const lease=await catalogMaintenance.begin({operationId:restore.operationId});if(lease.phase!=='frozen'||!lease.token)throw new Error('恢复只读启动未确认后台资源冻结');
      const metadata=db.catalogMetadata();if(metadata.origin!==restore.manifest.origin||JSON.stringify(metadata.counts)!==JSON.stringify(restore.manifest.counts)||!compatibility)throw new Error('恢复只读连接的来源或计数不同');
      if(JSON.stringify(await inventoryCatalogLibraryRoot(folder))!==JSON.stringify(restore.manifest.files.filter(file=>file.path.startsWith('library/')))||await restoreTransactionDirectory(folder)!==restore.libraryIdentity)throw new Error('恢复只读连接构建后的完整资料不同');
      const proof=readCatalogRestoreBootProof({version:1,operationId:restore.operationId,challenge:restore.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:restore.libraryIdentity,manifestSha256:lifecycleDigest(restore.manifest),token:lease.token,compatibility,readOnly:true,backgroundStarted:false},restore);dormantBoot={request:restore,proof};return proof;
    }
    scans!.recover();libraryWatch!.start();if(restoreTimer)clearInterval(restoreTimer);restoreFiles();restoreTimer=setInterval(restoreFiles,5000);restoreTimer.unref();
    scheduleSearchIndex();return {version:1,ready:true,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,...(normalPermission?{existingLibrary:{permissionSha256:lifecycleDigest(normalPermission),libraryIdentity:normalPermission.libraryIdentity,origin:normalPermission.origin}}:{})};
  }
  if (!db) throw new Error('音乐库尚未初始化');
  switch (method) {
    case 'tagWriteContext':return db.tagWriteContext(params);
    case 'tagWritePreview':return tagWrite!.preview(params);
    case 'tagWritePreviewCancel':tagWrite!.cancel(params);return null;
    case 'tagWritePrepare':{const result=await tagWrite!.prepare(params);reply({event:'tagWriteJobsChanged',payload:{jobId:result.id}});return result;}
    case 'tagWriteJobs':return db.tagWriteJobs.list(params);
    case 'tagWriteCancel':{const result=db.tagWriteJobs.cancel(params);reply({event:'tagWriteJobsChanged',payload:{jobId:result.id}});return result;}
    case 'tagWriteStageReceipt':return db.tagWriteJobs.stageReceipt(params);
    case 'tagWriteStageTarget':return tagWrite!.stageTarget(params);
    case 'tagWriteStage':return tagWrite!.startStage(params);
    case 'tagWriteStageCancel':return tagWrite!.cancelStage(params);
    case 'tagWriteInspect':return tagWrite!.startInspection(params);
    case 'tagWriteInspectCancel':return tagWrite!.cancelInspection(params);
    case 'tagRestoreReprobe':return tagWrite!.startRestoreReprobe(params);
    case 'tagRestoreReprobeCancel':return tagWrite!.cancelRestoreReprobe(params);
    case 'tagRestoreInspect':return tagWrite!.startRestoreInspection(params);
    case 'tagRestoreInspectCancel':return tagWrite!.cancelRestoreInspection(params);
    case 'tagCommitInspect':return tagWrite!.startCommitInspection(params);
    case 'tagCommitInspectCancel':return tagWrite!.cancelCommitInspection(params);
    case 'tagCommitReprobe':return tagWrite!.startReprobe(params);
    case 'tagCommitReprobeCancel':return tagWrite!.cancelReprobe(params);
    case 'tagWriteRecover':return tagWrite!.startRecoveryAction(params);
    case 'tagWriteRecoverCancel':return tagWrite!.cancelRecoveryAction(params);
    case 'libraryWatchState':return libraryWatch!.state();
    case 'libraryWatchReceipt':return libraryWatch!.receipt(params);
    case 'libraryWatchCommand':{const r=params as {request:unknown;confirmed?:import('../shared/library-watch.js').WatchAnchor};return libraryWatch!.command(r?.request,r?.confirmed);}
    case 'libraryWatchSuspend':libraryWatch!.suspend();return null;
    case 'libraryWatchResume':libraryWatch!.resume();return null;
    case 'browseCatalog':return db.browseCatalog(params);
    case 'searchIndexState':if(searchIndexFault)throw new Error(searchIndexFault);return db.searchIndexState();
    case 'retrySearchIndex':{const state=db.retrySearchIndex();searchIndexFault='';scheduleSearchIndex();return state;}
    case 'loadCatalogViewPreference':return db.loadCatalogViewPreference();
    case 'saveCatalogViewPreference':return db.saveCatalogViewPreference(params);
    case 'loadWindowPlacementPreference':return db.loadWindowPlacementPreference();
    case 'saveWindowPlacementPreference':return db.saveWindowPlacementPreference(params);
    case 'loadAppearancePreference':return db.loadAppearancePreference();
    case 'saveAppearancePreference':return db.saveAppearancePreference(params);
    case 'loadMediaKeyPreference':return db.loadMediaKeyPreference();
    case 'saveMediaKeyPreference':return db.saveMediaKeyPreference(params);
    case 'loadDesktopPreference':return db.loadDesktopPreference();
    case 'saveDesktopPreference':return db.saveDesktopPreference(params);
    case 'loadAudioOutput':return db.audioOutputSettings.load();
    case 'loadAudioBackend':return db.audioBackendSettings.load();
    case 'audioBackendReceipt':return db.audioBackendSettings.receipt(params);
    case 'saveAudioBackend':return db.audioBackendSettings.save(params);
    case 'loadDsdOutput':return db.dsdOutputSettings.load();
    case 'dsdOutputReceipt':return db.dsdOutputSettings.receipt(params);
    case 'saveDsdOutput':return db.dsdOutputSettings.save(params);
    case 'loadAsioOutput':return db.asioOutputSettings.load();
    case 'asioOutputReceipt':return db.asioOutputSettings.receipt(params);
    case 'saveAsioOutput':{const r=params as {request:unknown;driver:import('../shared/asio-output.js').AsioDriverIdentity|null};return db.asioOutputSettings.save(r?.request,r?.driver);}
    case 'audioOutputReceipt':return db.audioOutputSettings.receipt(params);
    case 'saveAudioOutput':{const r=params as {request:unknown;deviceName:string|null};return db.audioOutputSettings.save(r?.request,r?.deviceName);}
    case 'waveformRequest': {const request=params as {itemId:string;commandId:string};if(!request)throw new Error('无效波形请求');return waveforms!.request(request.itemId,request.commandId);}
    case 'waveformJob': return waveforms!.view(params as string);
    case 'waveformCancel': return waveforms!.cancel(params as string);
    case 'waveformJobs': return waveforms!.list();
    case 'desktopFiles':return db.desktopFiles(params);
    case 'desktopFileSource':return db.mediaSource(params as string);
    case 'desktopScanReceipt':{const found=db.scanJobs.startReceipt(params);return found?{status:'saved',...found,error:''}:null;}
    case 'importDesktopFolder':{
     const r=params as {path:string;existingRootId:string|null;commandId:string;realPath:string};
     if(!r||typeof r.path!=='string'||!path.isAbsolute(r.path)||r.path.length>4096||r.path.includes('\0')||typeof r.realPath!=='string'||!path.isAbsolute(r.realPath)||r.realPath.length>4096||r.realPath.includes('\0')||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId))throw new Error('无效文件扫描请求');
     const receipt=db.scanJobs.startReceipt(r.commandId);if(receipt)return {status:'saved',...receipt,error:''};
     let rootId:string|null=null;
     try{
      const stat=await fs.lstat(r.path),real=await fs.realpath(r.path),normalized=process.platform==='win32'?real.toLocaleLowerCase():real;
      if(stat.isSymbolicLink()||!stat.isDirectory()||normalized!==(process.platform==='win32'?r.realPath.toLocaleLowerCase():r.realPath))throw new Error('已确认的扫描目录目标发生变化');
      if(r.existingRootId!==null){const root=db.getRoot(r.existingRootId);if(!root||root.path!==r.path)throw new Error('音乐目录已变化');rootId=root.id;}
      else rootId=db.addRoot(r.path);
      const result=startScan(rootId,r.commandId,normalized);reply({event:'libraryChanged',payload:{rootId}});return {status:'saved',...result,error:''};
     }catch(e){const receipt=db.scanJobs.startReceipt(r.commandId);return receipt?{status:'saved',...receipt,error:''}:{status:'rejected',rootId,jobId:null,error:String(e instanceof Error?e.message:e).slice(0,500)};}
    }
    case 'addRoot': {
      const rootId = db.addRoot(String((params as { folder: string }).folder));
      return startScan(rootId);
    }
    case 'rescanRoot': {const r=params as {rootId:string;commandId:string};return startScan(r.rootId,r.commandId);}
    case 'scanCommand': return scans!.command(validateScanCommand(params));
    case 'scanJobs': return db.scanJobs.list((params as {cursor?:string})?.cursor);
    case 'scanJob': return db.scanJobs.get(params as string);
    case 'scanIssues': {const r=params as {jobId:string;cursor?:string};return db.scanJobs.issues(r.jobId,r.cursor);}
    case 'stats': return db.stats();
    case 'roots': return db.roots();
    case 'previewMusicQuery':return previewMusicQuery(db,params);
    case 'checkMusicPreview':return checkMusicPreview(db,params);
    case 'browseLibrary':return browseLibrary(db,params);
    case 'browsePlayContext':return browsePlayContext(db,params);
    case 'list': return db.list(params as ListRequest);
    case 'versions': {
      const request=params as {itemId:string;limit?:number;offset?:number};
      return db.versions(request.itemId,request.limit,request.offset);
    }
    case 'linkCatalog': {
      const result=db.associations.link(params as CatalogLinkRequest);
      reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'catalogChanges': {
      const request=params as {limit?:number;offset?:number};return db.catalogChanges(request.limit,request.offset);
    }
    case 'genres': return db.genres.list(params as import('../shared/contracts.js').GenreListRequest);
    case 'genre': return db.genres.get(params as string);
    case 'editGenre': {const result=db.genres.edit(params as import('../shared/contracts.js').GenreEditRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'undoCatalog': {
      const request=params as {changeId:string;commandId:string};
      const result=db.undoCatalog(request.changeId,request.commandId);
      reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'artistCandidates': {
      const request=params as {query?:string;limit?:number;offset?:number};return db.artists.candidates(request.query,request.limit,request.offset);
    }
    case 'editArtists': {
      const result=db.artists.edit(params as ArtistEditRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'artistProfiles': {
      const request=params as {query?:string;limit?:number;offset?:number};return db.profiles.list(request.query,request.limit,request.offset);
    }
    case 'artistProfile': {
      const request=params as {artistId:string;limit?:number;offset?:number};return db.artistProfile(request.artistId,request.limit,request.offset);
    }
    case 'editArtistProfile': {
      const result=db.profiles.edit(params as ArtistProfileRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'artistReferenceUrl': {
      const request=params as {artist:ArtistProfileRef;provider:string;externalId:string};return db.profiles.referenceUrl(request.artist,request.provider,request.externalId);
    }
    case 'releaseCandidates': {
      const request=params as {query?:string;limit?:number;offset?:number};return db.releases.candidates(request.query,request.limit,request.offset);
    }
    case 'releaseDetail': {
      const request=params as {releaseId:string;limit?:number;offset?:number};return db.releaseDetail(request.releaseId,request.limit,request.offset);
    }
    case 'editReleases': {
      const result=db.releases.edit(params as ReleaseEditRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'editReleaseProfile': {
      const result=db.releaseProfiles.edit(params as ReleaseProfileRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'entityReferences': {const request=params as {kind:EntityReferenceKind;entityId:string};return db.references.get(request.kind,request.entityId);}
    case 'recordingProfile': return db.recordingProfiles.get(params as string);
    case 'editRecordingProfile': {const result=db.recordingProfiles.edit(params as import('../shared/contracts.js').RecordingProfileRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'editEntityReferences': {const result=db.references.edit(params as EntityReferenceRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'entityReferenceUrl': {const request=params as {entity:EntityReferenceRef;provider:string;externalId:string};return db.references.referenceUrl(request.entity,request.provider,request.externalId);}
    case 'facets': {
      const {view,artistRole} = params as {view:'artists'|'albums'|'albumGroups'|'genres';artistRole?:ArtistRole};
      if (!['artists','albums','albumGroups','genres'].includes(view)) throw new Error('无效分类');
      return db.facets(view,artistRole);
    }
    case 'getItem': return db.getItem(String(params));
    case 'getPlaybackItem':{const item=db.getItem(String(params));if(item)db.mediaSource(item.id);return item;}
    case 'getPlaybackItems':{const items=db.getItems(params as string[]);for(const item of items)db.tagWriteJobs.assertReadable(item.fileId);return items;}
    case 'playbackHistoryCheckpoint':{const {statistics,...receipt}=db.playbackHistory.checkpoint(params);if(statistics.counts||statistics.recency)reply({event:'playbackStatisticsChanged',payload:statistics});return receipt;}
    case 'playbackHistory':return db.playbackHistory.list(params);
    case 'historyExportOrigin':return db.historyExportOrigin();
    case 'playbackPolicy':return db.playbackPolicies.load();
    case 'configurePlaybackPolicy':{const {changed,...result}=db.playbackPolicies.result(params);if(changed)reply({event:'playbackPolicyChanged',payload:db.playbackPolicies.load()});return result;}
    case 'exportRules':return db.ruleTransfers.export(params);
    case 'inspectRuleImport':return db.ruleTransfers.inspect(params);
    case 'ruleReferenceTargets':return db.ruleTransfers.search(params);
    case 'importRules':{const {changed,...result}=db.ruleTransfers.import(params);if(changed){if(result.value!.created.some(item=>item.kind==='smart'))reply({event:'libraryChanged',payload:{smartPlaylist:true,ruleImport:true}});if(result.value!.created.some(item=>item.kind==='preset'))reply({event:'filterPresetsChanged',payload:{}});}return result;}
    case 'filterPresets':return db.filterPresets.list(params);
    case 'filterPreset':return db.filterPresets.get(params);
    case 'mutateFilterPreset':{const {changed,...result}=db.filterPresets.result(params);if(changed)reply({event:'filterPresetsChanged',payload:{}});return result;}
    case 'smartPlaylistHistory':return db.smartPlaylistHistory.list(params);
    case 'smartPlaylistHistoryDetail':return db.smartPlaylistHistory.detail(params);
    case 'restoreSmartPlaylist':{const {changed,...result}=db.smartPlaylistHistory.restore(params);if(changed)reply({event:'libraryChanged',payload:{smartPlaylist:true,smartPlaylistRestored:true,playlistId:result.value!.id}});return result;}
    case 'smartPlaylists':return db.smartPlaylists.list(params);
    case 'smartPlaylist':return db.smartPlaylists.get(params);
    case 'mutateSmartPlaylist':{const result=db.smartPlaylists.result(params);if(result.status==='saved')reply({event:'libraryChanged',payload:{smartPlaylist:true,playlistId:result.value?.id??(params as {id?:string}).id}});return result;}
    case 'playlists': return db.user.playlists();
    case 'setUserState': {
      const result=db.user.setState(params as UserStateRequest);
      reply({event:'libraryChanged',payload:{itemId:result.itemId}});return result;
    }
    case 'createPlaylist': {
      const request=params as {name:string;commandId:string;itemIds?:string[]};
      const result=db.user.create(request.name,request.commandId,request.itemIds);
      reply({event:'libraryChanged',payload:{playlistId:result.id}});return result;
    }
    case 'editPlaylist': {
      const request=params as PlaylistEditRequest;
      const result=db.user.edit(request);
      reply({event:'libraryChanged',payload:{playlistId:request.playlistId}});return result;
    }
    case 'playlistContext': {
      const request=params as {playlistId:string;entryId:string;revision:number};
      return db.user.playbackContext(request.playlistId,request.entryId,request.revision);
    }
    case 'getItems': return db.getItems(params as string[]);
    case 'loadQueue': return db.loadQueue();
    case 'saveQueue': {
      const request=params as {state:QueueState;baseRevision:number};
      if(!request||!Number.isSafeInteger(request.baseRevision)||request.baseRevision<0)
        throw new Error('无效队列基础版本');
      db.saveQueue(request.state,request.baseRevision);return null;
    }
    case 'lyricsImportPreview': {
      const input=params as import('../shared/contracts.js').LyricsImportInput;
      const item=db.getItem(input?.itemId);if(!item)throw new Error('曲目不存在');
      db.lyricsDocuments.checkOrigin(input);return previewLyricsImport(item,input);
    }
    case 'savedLyrics': return db.lyricsDocuments.savedPage(params,id=>db!.getItem(id)??null);
    case 'savedLocalLyrics': return db.localLyricsHistory.savedPage(params,id=>db!.getItem(id)??null);
    case 'savedLocalLyricsVersion': return db.localLyricsHistory.savedVersion(params as string,id=>db!.getItem(id)??null);
    case 'savedLyricsDocument': return db.lyricsDocuments.savedDocument(params,id=>db!.getItem(id)??null);
    case 'savedLyricsChanges': {const r=params as {documentId:string;cursor?:string};return db.lyricsDocuments.savedChanges(r?.documentId,r?.cursor);}
    case 'editSavedLyrics': {
      try{
        const request=validateSavedLyricsStateRequest(params),result=db.lyricsDocuments.editSaved(request);
        try{reply({event:'lyricsChanged',payload:{itemId:request.itemId}});}catch{/* Durable receipt stays saved when event delivery fails. */}return result;
      }catch(error){return {status:'rejected',documentId:null,revision:null,error:error instanceof Error?error.message:String(error)};}
    }
    case 'localLyricsVersions':{
      const r=params as {itemId:string;cursor?:string};if(!r||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128)throw new Error('无效曲目');const item=db.getItem(r.itemId);if(!item)throw new Error('曲目不存在');return db.localLyricsHistory.page(item,r.cursor);
    }
    case 'localLyricsVersion':{
      const r=params as {itemId:string;id:string};if(!r||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||typeof r.id!=='string')throw new Error('无效歌词原文版本');const item=db.getItem(r.itemId);if(!item)throw new Error('曲目不存在');return db.localLyricsHistory.version(item,r.id);
    }
    case 'lyricsDocuments': {
      const request=params as {itemId:string;cursor?:string};
      if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128)throw new Error('无效曲目');
      const item=db.getItem(request.itemId);if(!item)throw new Error('曲目不存在');return db.lyricsDocuments.page(item,request.cursor);
    }
    case 'lyricsDocumentChanges': {
      const request=params as {itemId:string;cursor?:string};
      if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128)throw new Error('无效曲目');
      const item=db.getItem(request.itemId);if(!item)throw new Error('曲目不存在');return db.lyricsDocuments.changes(item,request.cursor);
    }
    case 'lyricsDocument': {
      const request=params as {itemId:string;documentId:string};
      if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128)throw new Error('无效曲目');
      const item=db.getItem(request.itemId);if(!item)throw new Error('曲目不存在');return db.lyricsDocuments.document(item,request.documentId);
    }
    case 'editLyricsDocument': {
      try{
        const request=validateLyricsDocumentRequest(params),receipt=db.lyricsDocuments.receipt(request);
        if(receipt)return receipt;
        const item=db.getItem(request.itemId);if(!item)throw new Error('曲目不存在');
        const result=db.lyricsDocuments.edit(item,request);
        try{reply({event:'lyricsChanged',payload:{itemId:item.id}});}catch{/* A committed receipt remains saved even if the notification channel closes. */}return result;
      }catch(error){return {status:'rejected',documentId:null,revision:null,error:error instanceof Error?error.message:String(error)};}
    }
    case 'embeddedCueForItem':return db.embeddedCueSources.forItem(params);
    case 'embeddedCueSource':return db.embeddedCueSources.source(params);
    case 'embeddedCueSources':{const r=params as {query:string;cursor?:string};return db.embeddedCueSources.files(r?.query,r?.cursor);}
    case 'embeddedCueVersions':{const r=params as {fileId:string;cursor?:string};return db.embeddedCueSources.versions(r?.fileId,r?.cursor);}
    case 'embeddedCuePreview':return db.embeddedCueSources.preview(params);
    case 'embeddedCueExport':return db.embeddedCueSources.export(params);
    case 'inspectEmbeddedCueBundle':{const r=params as {bundle:unknown;name:unknown;archiveSha256:unknown};return inspectEmbeddedCueSourceBundle(r?.bundle,r?.name,r?.archiveSha256);}
    case 'cueSourceForItem':return db.cueSources.forItem(params);
    case 'cueSource':return db.cueSources.source(params);
    case 'cueSources':{const r=params as {query:string;cursor?:string};const page=db.cueSources.files(r?.query,r?.cursor);page.error=restoreError;return page;}
    case 'cueSourceVersions':{const r=params as {fileId:string;cursor?:string};return db.cueSources.versions(r?.fileId,r?.cursor);}
    case 'cueSourcePreview':{const r=params as {fileId:string;versionId:string;encoding:unknown};return db.cueSources.preview(r?.fileId,r?.versionId,r?.encoding);}
    case 'cueSourceExport':return db.cueSources.export(params);
    case 'cueSourceOrigins':return db.cueSources.origins(params);
    case 'inspectCueOrigin':return db.cueSources.inspectOrigin(params);
    case 'exportCueOrigin':return db.cueSources.exportOrigin(params);
    case 'inspectCueSourceBundle':{const r=params as {bundle:unknown;name:unknown;archiveSha256:unknown};return inspectCueSourceBundle(r?.bundle,r?.name,r?.archiveSha256);}
    case 'cueSourceReceipt':return db.cueSources.receipt(params);
    case 'reviewCueVersion':return db.reviewCueVersion(params);
    case 'cueSourceSelectionReceipt':return db.cueSources.selectionReceipt(params);
    case 'cueSourceSelectionScope':return db.cueSourceSelectionScope(params);
    case 'cueSourceImportReceipt':return db.cueSources.importReceipt(params);
    case 'cueSourceRegisterReceipt':return db.cueSources.registerReceipt(params);
    case 'registerCueSource':{const result=db.registerCueSource(params);if(result.status==='saved')reply({event:'libraryChanged',payload:{cueSource:result.source?.id}});return result;}
    case 'importCueSource':{const result=db.importCueSource(params);if(result.status==='saved')reply({event:'libraryChanged',payload:{cueSource:result.source?.id}});return result;}
    case 'selectCueSource':{const result=db.selectCueSource(params);if(result.status==='saved'){restoreFiles();reply({event:'libraryChanged',payload:{cueSource:result.source?.id}});}return result;}
    case 'configureCueSource':{const result=db.cueSources.configure(params);if(result.status==='saved'){restoreFiles();reply({event:'libraryChanged',payload:{cueSource:result.source?.id}});}return result;}
    case 'filePolicy':return db.filePolicy.view(params);
    case 'filePolicies':return {...db.filePolicy.list(params as string|undefined),error:restoreError};
    case 'filePolicyReceipt':return db.filePolicy.receipt(params);
    case 'configureFilePolicy':{const result=db.filePolicy.command(params);if(result.status==='saved'){artworkRequests.clear();restoreFiles();reply({event:'libraryChanged',payload:{filePolicy:result.view?.fileId}});}return result;}
    case 'lyrics':
    case 'lyricsBundle':
    case 'saveLyricsPreference': {
      const request=method==='saveLyricsPreference'?validateLyricsRequest(params):null;
      try{
      const itemId=request?.itemId??params;
      if(typeof itemId!=='string'||!itemId||itemId.length>128)throw new Error('无效曲目 ID');
      const item=db.getItem(itemId);if(!item){if(request)throw new Error('曲目不存在');return null;}
      const replay=request?db.lyricsPreferences.receipt(request):false;
      if(request&&!replay&&request.scope!==lyricsScope(item))throw new Error('曲目或 CUE 范围已变化，请重新读取歌词');
      const {rootPath}=db.mediaSource(item.id),local=await localLyrics!.load(item,rootPath),latest=db.getItem(itemId);
      if(!latest||lyricsScope(latest)!==lyricsScope(item)||latest.available!==item.available||latest.title!==item.title||latest.fileStamp!==item.fileStamp||latest.fileObservation!==item.fileObservation)throw new Error('曲目已变化，请重新读取歌词');
      let localHistoryChanged=false;
      try{localHistoryChanged=db.localLyricsHistory.observe(latest,local.documents,local.observations);}catch(error){local.notice=[local.notice,`本地原文历史未完成保存：${String(error instanceof Error?error.message:error).slice(0,300)}`].filter(Boolean).join(' ');}
      if(localHistoryChanged)try{reply({event:'lyricsChanged',payload:{itemId}});}catch{/* Raw history is already committed; notification delivery does not roll it back. */}
      const sources=[...db.lyricsDocuments.sources(latest),...local.documents];
      if(request&&!replay){db.lyricsPreferences.save(latest,sources,request);try{reply({event:'lyricsChanged',payload:{itemId}});}catch{/* Saving has already committed its durable receipt. */}}
      const bundle=db.lyricsPreferences.bundle(latest,sources);
      bundle.notice=[bundle.notice,local.notice].filter(Boolean).join(' ');
      return request?{status:'saved',bundle,error:''}:method==='lyrics'?bundle.sources.find(source=>source.id===bundle.primaryId)??null:bundle;
      }catch(error){
        if(!request)throw error;
        if(db.lyricsPreferences.receipt(request))return {status:'saved',bundle:null,error:''};
        return {status:'rejected',bundle:null,error:error instanceof Error?error.message:String(error)};
      }
    }
    case 'artworkResource':{
      const input=params as {itemId:string;assetId:string};if(!input||typeof input.itemId!=='string'||input.itemId.length>128||typeof input.assetId!=='string'||!/^[0-9a-f]{64}$/.test(input.assetId))throw new Error('无效封面资源请求');
      const fileId=db.itemFileId(input.itemId);return fileId?db.onlineArtwork.read(input.itemId,input.assetId)??db.artworkStore.read(fileId,input.assetId):null;
    }
    case 'artworkLease':{
      const input=params as {itemId:string;assetId:string;consumer:string;retain:boolean};if(!input||typeof input.itemId!=='string'||input.itemId.length>128||typeof input.assetId!=='string'||typeof input.consumer!=='string'||typeof input.retain!=='boolean')throw new Error('无效封面资源租约');
      const fileId=input.retain?db.itemFileId(input.itemId):null;if(input.retain&&!fileId)throw new Error('封面歌曲不存在');
      if(input.retain&&db.onlineArtwork.owns(input.itemId,input.assetId))db.onlineArtwork.lease(input.consumer,input.itemId,input.assetId,true);
      else db.artworkStore.lease(input.consumer,fileId??'',input.assetId,input.retain);
      if(!input.retain)db.onlineArtwork.lease(input.consumer,input.itemId,input.assetId,false);return null;
    }
    case 'artworkResetLeases':db.artworkStore.resetLeases();db.onlineArtwork.resetLeases();return null;
    case 'onlineArtwork':return db.onlineArtwork.state(params as string);
    case 'onlineArtworkReceipt':return db.onlineArtwork.receipt(params);
    case 'onlineArtworkCommand':{
      const {request,image}=params as {request:import('../shared/online-artwork.js').OnlineArtworkCommand;image?:import('../shared/contracts.js').CoverArtImagePreview};
      const prior=db.onlineArtwork.receipt(request);if(prior)return prior;
      if(request.action==='apply'){
       const candidate=image?musicBrainz.resolve(request.itemId,image.candidateToken):null;
       if(!image||!candidate||candidate.releaseId?.toLowerCase()!==image.releaseId||!db.metadataNetworkEnabled()||!db.providerSettings.setting('cover-art-archive').enabled||db.metadataReviewFingerprint(request.itemId)!==image.fingerprint)throw new Error('封面候选、来源或歌曲资料已变化，请重新匹配');
      }
      const result=db.onlineArtwork.command(request,image);reply({event:'libraryChanged',payload:{itemId:request.itemId,action:request.action,changeId:result.changeId,reason:'online-artwork-changed'}});return result;
    }
    case 'artworkCandidate':
    case 'artwork': {
      const requestParams=typeof params==='string'?{itemId:params,refresh:false}:params as {itemId:string;refresh?:boolean;rejectedTokens?:string[];thumbnailSize?:256|1024};
      if(!requestParams||typeof requestParams.itemId!=='string'||requestParams.refresh!==undefined&&typeof requestParams.refresh!=='boolean')throw new Error('无效封面请求');
      if(requestParams.rejectedTokens!==undefined&&(!Array.isArray(requestParams.rejectedTokens)||requestParams.rejectedTokens.length>8||requestParams.rejectedTokens.some(token=>typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token))))throw new Error('无效封面候选');
      const thumbnailSize=requestParams.thumbnailSize??1024;if(thumbnailSize!==256&&thumbnailSize!==1024)throw new Error('无效封面尺寸');
      const item=db.getItem(requestParams.itemId);
      if (!item) return null;
      const rejected=new Set(requestParams.rejectedTokens??[]);
      const coverRevision=db.onlineArtwork.revision(item.id),preferred=db.onlineArtwork.lookup(item.id,rejected,'preferred',item.available?'stored':'offline');if(preferred)return method==='artworkCandidate'?preferred:preferred.url;
      const online=(state:'stored'|'offline'|'stale')=>db!.onlineArtwork.lookup(item.id,rejected,'fallback',state);
      const saved=(state:'offline'|'stale')=>db!.artworkStore.lookup(item.fileId,thumbnailSize,rejected,undefined,state)??online(state);
      if(!item.available)return saved('offline');
      const ensureCurrent=()=>{const latest=db!.getItem(item.id);if(!latest||latest.fileId!==item.fileId||latest.path!==item.path||latest.fileStamp!==item.fileStamp||latest.fileObservation!==item.fileObservation||latest.available!==item.available||db!.onlineArtwork.revision(item.id)!==coverRevision)throw new Error('封面曲目资料已变化，请重新读取');};
      const prefix=`${item.fileId}:`;
      if(requestParams.refresh)artworkRequests.clearPrefix(prefix);
      // File changes select a new cache entry; transient offline reads never become cached misses.
      let musicFingerprint:string;try{musicFingerprint=await artworkFingerprint(item,'embedded');}catch{ensureCurrent();return saved('offline');}ensureCurrent();
      const load=async(sourceKind:'embedded'|'sidecar',fingerprint:string)=>{
        const {rootPath}=db!.mediaSource(item.id),realRootPath=await fs.realpath(rootPath),handle=await fs.open(item.path,'r');
        try{
        const observation=fileObservation(await handle.stat({bigint:true}));
        const before=await handle.stat();if(!before.isFile()||fileObservation(await handle.stat({bigint:true}))!==observation)throw new Error('音乐文件类型或属性已变化');
        const image=await mediaParser!.artwork({rootPath,realRootPath,fullPath:item.path,relativePath:path.relative(rootPath,item.path),before:mediaStat(before),thumbnailSize,rejectedTokens:[...rejected],artworkSource:sourceKind},new AbortController().signal);
        const after=await handle.stat();if(!sameMediaStat(mediaStat(before),mediaStat(after))||!sameMediaStat(mediaStat(after),mediaStat(await fs.stat(item.path)))||fileObservation(await handle.stat({bigint:true}))!==observation||fileObservation(await fs.lstat(item.path,{bigint:true}))!==observation)throw new Error('音乐文件已变化，请重新读取封面');
        const normalize=(value:string)=>process.platform==='win32'?value.toLowerCase():value;
        if(normalize(await fs.realpath(rootPath))!==normalize(realRootPath)||!insideMediaRoot(normalize(realRootPath),normalize(await fs.realpath(item.path))))throw new MediaBoundaryError('音乐文件已越过授权目录');
        if(await artworkFingerprint(item,'embedded')!==musicFingerprint||sourceKind==='sidecar'&&await artworkFingerprint(item,'sidecar')!==fingerprint)throw new Error('音乐文件或封面已变化，请重新读取封面');
        ensureCurrent();if(image)return db!.artworkStore.save(item.fileId,thumbnailSize,fingerprint,image,rejected.size===0);
        return null;
        }finally{await handle.close();}
      };
      // Share each fallback request across list/player/detail without replacing the first candidate.
      let image:import('../shared/contracts.js').ArtworkCandidate|null;
      try{
        // No directory/image attribute reads occur before the embedded phase.
        image=!requestParams.refresh?db.artworkStore.lookup(item.fileId,thumbnailSize,rejected,musicFingerprint,'stored','embedded'):null;
        const suffix=`${item.fileObservation??'legacy'}:${thumbnailSize}:${[...rejected].sort().join(',')}`;
        if(!image)image=await artworkRequests.get(`${prefix}embedded:${musicFingerprint}:${suffix}`,()=>load('embedded',musicFingerprint));
        if(!image){
          // A metadata failure throws above; only a completed empty selection
          // permits directory fingerprints, cached sidecars or image reading.
          if(await artworkFingerprint(item,'embedded')!==musicFingerprint)throw new Error('音乐文件已变化，请重新读取封面');ensureCurrent();
          const fingerprint=await artworkFingerprint(item,'sidecar');
          if(await artworkFingerprint(item,'embedded')!==musicFingerprint)throw new Error('音乐文件已变化，请重新读取封面');ensureCurrent();
          image=!requestParams.refresh?db.artworkStore.lookup(item.fileId,thumbnailSize,rejected,fingerprint,'stored','sidecar'):null;
          if(!image)image=await artworkRequests.get(`${prefix}sidecar:${fingerprint}:${suffix}`,()=>load('sidecar',fingerprint));
        }
        if(await artworkFingerprint(item,'embedded')!==musicFingerprint)throw new Error('音乐文件已变化，请重新读取封面');
        ensureCurrent();if(!image&&rejected.size===0)db.artworkStore.clearSelection(item.fileId,thumbnailSize);
      }catch(error){if(error instanceof MediaWorkerExitUnconfirmed||error instanceof MediaBoundaryError)throw error;const fallback=saved('stale');if(!fallback)throw error;image=fallback;}
      ensureCurrent();image??=online('stored');return method==='artworkCandidate'?image:image?.url??null;
    }
    case 'metadataContact': return db.metadataContact();
    case 'metadataSources': return db.metadataProvenance.forItem(params as string);
    case 'metadataReviewState': {const itemId=params as string;if(!db.getItem(itemId))throw new Error('曲目不存在');return {itemId,revision:db.metadataRevision(itemId),fingerprint:db.metadataReviewFingerprint(itemId)};}
    case 'metadataSource': {const request=params as {kind:import('../shared/contracts.js').MetadataEntityKind;entityId:string};if(!request)throw new Error('无效元数据实体');return db.metadataProvenance.get(request.kind,request.entityId);}
    case 'editMetadataLocks': {const result=db.metadataProvenance.edit(params as import('../shared/contracts.js').MetadataLockRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'metadataHistory': {const request=params as {kind:import('../shared/contracts.js').MetadataEntityKind;entityId:string;field:string;cursor?:string};if(!request)throw new Error('无效来源历史请求');return db.metadataProvenance.history(request.kind,request.entityId,request.field,request.cursor);}
    case 'selectMetadataSources': {const result=db.metadataProvenance.select(params as import('../shared/contracts.js').MetadataSelectionRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'metadataCollection': {const request=params as {kind:import('../shared/contracts.js').MetadataCollectionKind;entityId:string;field:import('../shared/contracts.js').MetadataCollectionField;cursor?:string};if(!request)throw new Error('无效集合请求');return db.metadataCollections.get(request.kind,request.entityId,request.field,request.cursor);}
    case 'editMetadataCollection': {const result=db.metadataCollections.edit(params as import('../shared/contracts.js').MetadataCollectionRequest);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'setMetadataContact': {
      const contact=String(params ?? '').trim();
      if (!validContact(contact)) throw new Error('请输入有效的公开邮箱或 HTTPS 项目网址');
      const changed=contact!==db.metadataContact();db.setMetadataContact(contact);if(changed)invalidateMetadataNetwork();
      return null;
    }
    case 'metadataNetworkState': return networkState();
    case 'providers': return providerCredentials!.list();
    case 'providerEnabled': return db.providerSettings.setting(params as import('../shared/contracts.js').ProviderId).enabled;
    case 'providerRetention': return db.providerRetention.get(params as import('../shared/contracts.js').ProviderId);
    case 'providerStoredChanges': {const request=params as {providerId:import('../shared/contracts.js').ProviderId;cursor?:string};if(!request)throw new Error('无效来源修订查询');return db.providerRetention.storedChanges(request.providerId,request.cursor);}
    case 'configureProviderRetention': {
      const request=params as import('../shared/contracts.js').ProviderRetentionRequest;
      try{return db.providerRetention.configure(request);}
      finally{
        if(request?.providerId==='musicbrainz'){invalidateMetadataNetwork();networkChanged();}
        reply({event:'providersChanged',payload:{providerId:request?.providerId}});
      }
    }
    case 'providerTerms': return providerManifest(params).termsUrl;
    case 'configureProvider': {
      const request=params as import('../shared/contracts.js').ProviderSettingRequest;
      db.providerSettings.configure(request);
      if(request.providerId==='musicbrainz'){invalidateMetadataNetwork();networkChanged();}
      if(request.providerId==='cover-art-archive')invalidateCoverArtNetwork();if(request.providerId==='acoustid')invalidateMetadataNetwork();
      reply({event:'providersChanged',payload:{providerId:request.providerId}});
      return providerCredentials!.list();
    }
    case 'providerCredential': {
      const request=params as import('../shared/contracts.js').ProviderCredentialRequest;
      try{return await providerCredentials!.execute(request);}
      finally{if(request?.providerId==='acoustid')invalidateMetadataNetwork();if(request&&typeof request==='object')request.secret=undefined;reply({event:'providersChanged',payload:{providerId:request?.providerId}});}
    }
    case 'setMetadataNetworkEnabled': {if(typeof params!=='boolean')throw new Error('无效在线查询设置');db.setMetadataNetworkEnabled(params);invalidateMetadataNetwork();networkChanged();reply({event:'providersChanged',payload:{providerId:'musicbrainz'}});return null;}
    case 'clearMetadataNetworkCache': invalidateMetadataNetwork();return null;
    case 'cancelMetadataMatch': {if(typeof params!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params))throw new Error('无效在线查询 ID');cancelMetadataQuery(params);return null;}
    case 'fingerprintClose': acoustid.close(readFingerprintToken(params));return null;
    case 'fingerprintFind': {
      const request=readFingerprintFind(params);if(request.reviewToken)workflowReviewExpiry(request.reviewToken,request.itemId);if(!db.providerSettings.setting('acoustid').enabled)throw new Error('请先在数据源设置启用AcoustID');if(metadataQueries.has(request.requestId))throw new Error('查询身份已在使用');const item=db.getItem(request.itemId);if(!item)throw new Error('歌曲不存在');const authority=db.metadataRecordingLookupContext(item.id).fingerprint,metadata=db.metadataReviewFingerprint(item.id),controller=new AbortController();for(const [id,q] of metadataQueries)if(q.itemId===item.id)cancelMetadataQuery(id);metadataQueries.set(request.requestId,{itemId:item.id,controller,provider:'acoustid',reviewToken:request.reviewToken});
      try{const summary=await fingerprints!.compute(item.id,controller.signal,request.fresh);const result=await acoustid.identify(item.id,request.requestId,summary,authority,metadata,controller.signal,request.fresh,request.reviewToken);await fingerprints!.validateSource(item.id);controller.signal.throwIfAborted();if(db.metadataReviewFingerprint(item.id)!==metadata)throw new Error('识别期间资料已变化，请重新识别');if(request.reviewToken)musicBrainz.retainReview(request.reviewToken,item.id,[],authority,metadata);return result;}catch(e){acoustid.clear(request.requestId);throw e;}finally{metadataQueries.delete(request.requestId);}
    }
    case 'fingerprintChoose': {
      const request=readFingerprintChoice(params);if(!db.metadataNetworkEnabled())throw new Error('请先开启MusicBrainz在线查询');if(metadataQueries.has(request.requestId))throw new Error('查询身份已在使用');const choice=acoustid.choose(request),item=db.getItem(choice.itemId);if(!item)throw new Error('歌曲不存在');const revision=db.metadataRevision(item.id),lockedFields=db.lockedMetadataFields(item.id),controller=new AbortController();for(const [id,q] of metadataQueries)if(q.itemId===item.id)cancelMetadataQuery(id);metadataQueries.set(request.requestId,{itemId:item.id,controller,provider:'acoustid',reviewToken:request.reviewToken});
      try{await fingerprints!.validateSource(item.id);let candidates=await musicBrainz.search(item,{requestId:request.requestId,signal:controller.signal,recordingAuthority:{fingerprint:choice.authority,selectedId:choice.recording.recordingId},fingerprintEvidence:{kind:'fingerprint',recordingId:choice.recording.recordingId,acoustidId:choice.recording.acoustidId,score:choice.recording.score,algorithm:choice.algorithm,metadata:choice.metadata,expiresAt:choice.expiresAt}});await fingerprints!.validateSource(item.id);controller.signal.throwIfAborted();acoustid.choose(request);if(db.metadataRevision(item.id)!==revision||db.metadataReviewFingerprint(item.id)!==choice.metadata)throw new Error('录音读取期间资料已变化，请重新识别');if(request.reviewToken)candidates=musicBrainz.retainReview(request.reviewToken,item.id,candidates,choice.authority,choice.metadata);const refs=db.metadataRecordingLookupContext(item.id).references;for(const c of candidates)if(refs.length&&!refs.includes(c.recordingId))c.matchEvidence?.warnings.push('指纹候选与本地已确认录音不同，不能据此覆盖录音关联');return {itemId:item.id,item,revision,fingerprint:choice.metadata,candidates,lockedFields,requestId:request.requestId,cacheHit:candidates[0]?.cacheHit};}catch(e){musicBrainz.invalidate(request.requestId);throw e;}finally{metadataQueries.delete(request.requestId);}
    }
    case 'metadataBatchReviewStart': {if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停');const request=Array.isArray(params)?{itemIds:readBatchReviewItems(params),workflow:undefined}:readWorkflowReview(params),ids=request.itemIds;for(const id of ids)if(!db.getItem(id))throw new Error('审核曲目不存在');const claim=request.workflow?db.metadataWorkflows.assertClaim(request.workflow):null;if(claim&&(claim.items.length!==ids.length||ids.some(id=>!claim.items.some(i=>i.id===id))))throw new Error('预览曲目与任务审核页不一致');const lease=musicBrainz.beginReview(ids,claim?.expiresAt);if(request.workflow)workflowReviews.set(lease.reviewToken,request.workflow);return lease;}
    case 'metadataBatchReviewStatus':return musicBrainz.reviewStatus(readBatchReviewToken(params));
    case 'metadataBatchReviewClose':{const token=readBatchReviewToken(params);for(const [id,q] of metadataQueries)if(q.reviewToken===token)cancelMetadataQuery(id);acoustid.closeReview(token);musicBrainz.closeReview(token);workflowReviews.delete(token);return null;}
    case 'metadataMatch': {
      const request=readMetadataMatchRequest(typeof params==='string'?{itemId:params,requestId:randomUUID(),fresh:false}:params);
      if(!request||typeof request.itemId!=='string'||request.itemId.length>128||typeof request.requestId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.requestId)||request.fresh!==undefined&&typeof request.fresh!=='boolean')throw new Error('无效在线查询');
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请先开启');if(metadataQueries.has(request.requestId))throw new Error('在线查询 ID 已在使用');
      if(request.reviewToken)workflowReviewExpiry(request.reviewToken,request.itemId);
      const item=db.getItem(request.itemId);if(!item)throw new Error('曲目不存在');
      const revision=db.metadataRevision(item.id),fingerprint=db.metadataReviewFingerprint(item.id),lockedFields=db.lockedMetadataFields(item.id),controller=new AbortController();
      const referenceContext=db.metadataRecordingLookupContext(item.id),selectedId=request.isrc?undefined:request.recordingId??(referenceContext.references.length===1?referenceContext.references[0]:undefined),recordingLookup={references:referenceContext.references,selectedId:selectedId??null,requiresChoice:referenceContext.references.length>1&&!selectedId&&!request.isrc};
      if(selectedId&&!referenceContext.references.includes(selectedId))throw new Error('所选录音标识不属于该歌曲当前已确认的录音');
      if(request.isrc&&!referenceContext.isrcs.includes(request.isrc))throw new Error('所选录音编码不属于该歌曲当前有效来源');
      const waitingISRC=!selectedId&&!request.isrc&&referenceContext.isrcs.length>0&&(!item.title.trim()||item.title==='未知标题'),isrcLookup={codes:referenceContext.isrcs,source:referenceContext.isrcSource,selectedCode:request.isrc??null,requiresChoice:waitingISRC,notices:referenceContext.notices};
      for(const [id,query] of metadataQueries)if(query.itemId===item.id)cancelMetadataQuery(id);
      metadataQueries.set(request.requestId,{itemId:item.id,controller,reviewToken:request.reviewToken});
      try{let candidates=recordingLookup.requiresChoice||waitingISRC?[]:await musicBrainz.search(item,{signal:controller.signal,fresh:request.fresh,requestId:request.requestId,recordingAuthority:{fingerprint:referenceContext.fingerprint,selectedId,isrc:request.isrc}});controller.signal.throwIfAborted();if(db.metadataRevision(item.id)!==revision||db.metadataReviewFingerprint(item.id)!==fingerprint||db.metadataRecordingLookupContext(item.id).fingerprint!==referenceContext.fingerprint){musicBrainz.invalidate(request.requestId);throw new Error('查询期间歌曲资料已变化，请重新匹配');}if(request.isrc&&referenceContext.references.length)for(const candidate of candidates)if(!referenceContext.references.includes(candidate.recordingId))candidate.matchEvidence?.warnings.push('编码候选与本地已确认录音不同，不能据此覆盖录音关联');if(request.reviewToken)candidates=musicBrainz.retainReview(request.reviewToken,item.id,candidates,referenceContext.fingerprint,fingerprint);return {itemId:item.id,item,revision,fingerprint,candidates,lockedFields,requestId:request.requestId,cacheHit:candidates[0]?.cacheHit,recordingLookup,isrcLookup};}
      finally{metadataQueries.delete(request.requestId);}
    }
    case 'metadataReleaseContext': {
      const request=readMetadataReleaseContextRequest(params);if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请先开启');if(metadataQueries.has(request.requestId))throw new Error('在线查询 ID 已在使用');
      const candidate=musicBrainz.resolve(request.itemId,request.token),item=db.getItem(request.itemId);if(!candidate||!item)throw new Error('候选已过期或曲目不存在');if(db.metadataReviewFingerprint(item.id)!==request.fingerprint)throw new Error('歌曲资料已变化，请重新匹配');
      const localRelease=item.catalog?.releaseId?db.releaseDetail(item.catalog.releaseId,1).release:null,localSnapshot=JSON.stringify(localRelease);
      const controller=new AbortController();metadataQueries.set(request.requestId,{itemId:item.id,controller});
      try{const value=await musicBrainz.releaseContext(item.id,request.token,{requestId:request.requestId,fresh:request.fresh,signal:controller.signal});controller.signal.throwIfAborted();
        if(!db.metadataNetworkEnabled()||musicBrainz.resolve(item.id,request.token)!==candidate||db.metadataReviewFingerprint(item.id)!==request.fingerprint||JSON.stringify(item.catalog?.releaseId?db.releaseDetail(item.catalog.releaseId,1).release:null)!==localSnapshot)throw new Error('歌曲或专辑资料已变化，请重新读取');
        return {itemId:item.id,token:request.token,fingerprint:request.fingerprint,requestId:request.requestId,recordingId:candidate.recordingId,...value,albumReview:localRelease&&!request.readOnly?db.metadataAlbums.review({itemId:item.id,releaseId:localRelease.releaseId,itemFingerprint:request.fingerprint,candidateToken:request.token,requestId:request.requestId,recordingId:candidate.recordingId,context:value.context,fetchedAt:value.fetchedAt,expiresAt:value.expiresAt}):null,fieldsReview:localRelease&&!request.readOnly?db.releaseFields.review({itemId:item.id,releaseId:localRelease.releaseId,itemFingerprint:request.fingerprint,candidateToken:request.token,requestId:request.requestId,recordingId:candidate.recordingId,context:value.context,fetchedAt:value.fetchedAt,expiresAt:value.expiresAt}):null,local:{title:item.album,trackCount:localRelease?.trackCount??null,media:localRelease?.media??[],discNumber:item.discNumber,trackNumber:item.trackNumber,durationSeconds:item.durationSeconds}};
      }finally{metadataQueries.delete(request.requestId);}
    }
    case 'metadataIdentityPreview': {const request=readMetadataIdentityPreview(params);if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新审核');return db.metadataIdentities.preview(request,(id,token,fingerprint)=>Boolean(musicBrainz.resolve(id,token))&&db!.metadataReviewFingerprint(id)===fingerprint);}
    case 'metadataIdentityApply': {const request=readMetadataIdentityApply(params),prior=db.metadataIdentities.receipt(request);if(prior)return prior;if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新审核');const result=db.metadataIdentities.apply(request,(id,token,fingerprint)=>Boolean(musicBrainz.resolve(id,token))&&db!.metadataReviewFingerprint(id)===fingerprint);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'metadataAlbumCreditsPreview': {if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停');return db.metadataAlbumCredits.preview(params as import('../shared/metadata-album-credits.js').MetadataAlbumCreditsPreviewRequest,(id,token,fp)=>Boolean(musicBrainz.resolve(id,token))&&db!.metadataReviewFingerprint(id)===fp);}
    case 'metadataAlbumCreditsApply': {const raw=params as import('../shared/metadata-album-credits.js').MetadataAlbumCreditsApplyRequest,prior=db.metadataAlbumCredits.receipt(raw);if(prior)return prior;if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停');const result=db.metadataAlbumCredits.apply(raw,(id,token,fp)=>Boolean(musicBrainz.resolve(id,token))&&db!.metadataReviewFingerprint(id)===fp);reply({event:'libraryChanged',payload:{reason:'album-credits',changeId:result.changeId}});reply({event:'providersChanged',payload:{providerId:'musicbrainz'}});return result;}
    case 'metadataAlbumCreditUndoPreview': return db.metadataCollections.albumCreditUndoPreview(params as string);
    case 'metadataIdentityUndoPreview': return db.references.identityUndoPreview(params as string);
    case 'metadataGroupLinkUndoPreview': return db.metadataGroupLinks.undoPreview(params as string);
    case 'metadataGroupLinkPreview': {if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新审核');return db.metadataGroupLinks.preview(params as import('../shared/metadata-group-link.js').MetadataGroupLinkPreviewRequest,(itemId,token,fingerprint)=>Boolean(musicBrainz.resolve(itemId,token))&&db!.metadataReviewFingerprint(itemId)===fingerprint);}
    case 'metadataGroupLinkApply': {const request=params as import('../shared/metadata-group-link.js').MetadataGroupLinkApplyRequest;const receipt=db.metadataGroupLinks.receipt(request);if(receipt)return receipt;if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新审核');const result=db.metadataGroupLinks.apply(request,(itemId,token,fingerprint)=>Boolean(musicBrainz.resolve(itemId,token))&&db!.metadataReviewFingerprint(itemId)===fingerprint);reply({event:'libraryChanged',payload:{reason:'online-group-link'}});reply({event:'providersChanged',payload:{providerId:'musicbrainz'}});return result;}
    case 'metadataAlbumPage': return db.metadataAlbums.page(readMetadataAlbumPage(params));
    case 'metadataAlbumTracks': return db.metadataAlbums.trackPage(readMetadataAlbumTracks(params));
    case 'metadataAlbumBatchCreate': {
      const request=readMetadataAlbumBatch(params),prior=db.metadataAlbums.receipt(request);if(prior)return prior;
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新审核');
      const result=db.metadataAlbums.create(request,(itemId,token,fingerprint)=>Boolean(musicBrainz.resolve(itemId,token))&&db!.metadataReviewFingerprint(itemId)===fingerprint);reply({event:'metadataBatch',payload:{id:result.id}});return result;
    }
    case 'releaseFieldsApply': {
      const request=readReleaseFieldsApply(params),receipt=db.releaseFields.receipt(request);if(receipt)return receipt;
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新读取');
      const result=db.releaseFields.apply(request,(itemId,token,fingerprint)=>Boolean(musicBrainz.resolve(itemId,token))&&db!.metadataReviewFingerprint(itemId)===fingerprint);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'releaseFieldsUndoPreview': return db.releaseFields.preview(params as string);
    case 'releaseFieldsUndoApply': {const result=db.releaseFields.undo(readReleaseFieldsUndo(params));reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;}
    case 'metadataEditions': {
      const request=readMetadataEditionsRequest(params);if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请先开启');if(metadataQueries.has(request.requestId))throw new Error('在线查询 ID 已在使用');
      const candidate=musicBrainz.resolve(request.itemId,request.token);if(!candidate)throw new Error('候选已过期，请重新匹配');if(db.metadataReviewFingerprint(request.itemId)!==request.fingerprint)throw new Error('歌曲资料已变化，请重新匹配');
      const controller=new AbortController();metadataQueries.set(request.requestId,{itemId:request.itemId,controller});
      try{const page=await musicBrainz.releaseEditions(request.itemId,request.token,{requestId:request.requestId,cursor:request.cursor,fresh:request.fresh,signal:controller.signal});controller.signal.throwIfAborted();if(!db.metadataNetworkEnabled()||musicBrainz.resolve(request.itemId,request.token)!==candidate||db.metadataReviewFingerprint(request.itemId)!==request.fingerprint)throw new Error('歌曲资料或候选已变化，请重新匹配');return {itemId:request.itemId,token:request.token,fingerprint:request.fingerprint,requestId:request.requestId,recordingId:candidate.recordingId,...page};}
      catch(error){musicBrainz.invalidate(request.requestId);throw error;}finally{metadataQueries.delete(request.requestId);}
    }
    case 'metadataApply': {
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新启用并匹配');
      const request=params as MetadataApplyRequest;
      if (!request || typeof request.itemId!=='string' || typeof request.token!=='string' || !Array.isArray(request.fields)) throw new Error('无效元数据变更');
      const candidate=musicBrainz.resolve(request.itemId,request.token);
      if (!candidate) throw new Error('候选已过期，请重新匹配');
      const result=db.applyMetadata(request.itemId,request.revision,candidate,request.fields);
      reply({event:'libraryChanged',payload:{itemId:request.itemId}});
      return result;
    }
    case 'metadataWorkflow':return db.metadataWorkflows.get(workflowId(params));
    case 'metadataWorkflowReceipt':return db.metadataWorkflows.receipt(readMetadataWorkflowCommand(params));
    case 'metadataWorkflows':return db.metadataWorkflows.list((params as {before?:number})?.before);
    case 'metadataWorkflowCommand':{const request=readMetadataWorkflowCommand(params),result=db.metadataWorkflows.command(request);if(request.action!=='start')for(const origin of workflowReviews.values())if(origin.jobId===result.job.id)try{db.metadataWorkflows.assertClaim(origin);}catch{closeWorkflowReviews(result.job.id);break;}if(!result.replayed)reply({event:'metadataBatch',payload:{workflowId:result.job.id}});return result;}
    case 'metadataWorkflowIssues':{const r=params as {jobId:string;after?:number};return db.metadataWorkflows.issues(workflowId(r?.jobId),r.after);}
    case 'metadataBatches': return db.metadataBatches.list((params as {cursor?:string})?.cursor);
    case 'metadataBatch': return db.metadataBatches.get(params as string);
    case 'metadataBatchRecheck': return db.metadataBatches.recheck(params);
    case 'metadataBatchCreate': {
      const request=params as import('../shared/contracts.js').MetadataBatchCreateRequest;
      if(!request||!Array.isArray(request.entries)||request.entries.length<1||request.entries.length>100)throw new Error('每次批量审核需选择 1–100 首歌曲');
      if(request.workflow!==undefined)workflowOrigin(request.workflow);if(request.retryOf!==undefined)readMetadataBatchOrigin(request.retryOf);const prior=db.metadataBatches.creationReceipt(request);if(prior)return prior;
      db.requireMetadataRetention();
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新审核');
      const candidates=request.entries.map(entry=>{if(!entry||typeof entry.itemId!=='string'||entry.itemId.length>128||typeof entry.token!=='string'||entry.token.length>128)throw new Error('无效审核成员');const candidate=musicBrainz.batchCandidate(entry.itemId,entry.token);if(!candidate)throw new Error('候选已过期或取消，请重新搜索');return candidate;});
      const result=request.workflow?db.metadataWorkflows.save(request,()=>db!.metadataBatches.create(request,candidates)):db.metadataBatches.create(request,candidates);if(request.workflow)closeWorkflowReviews(request.workflow.jobId);reply({event:'metadataBatch',payload:{id:result.id}});return result;
    }
    case 'metadataBatchCommand': {
      const request=params as import('../shared/contracts.js').MetadataBatchCommand;const result=db.metadataBatches.execute(request);
      reply({event:'metadataBatch',payload:{id:result.id}});reply({event:'libraryChanged',payload:{batchId:result.id}});return result;
    }
    case 'coverArtImagePreview':
    case 'coverArtSourceIndex': {
      const request=validateCoverArtSourceRequest(params);
      if(metadataQueries.has(request.requestId))throw new Error('在线查询 ID 已在使用');
      const controller=new AbortController();metadataQueries.set(request.requestId,{itemId:request.itemId,controller,provider:'cover-art-archive'});
      const deadline=method==='coverArtImagePreview'?setTimeout(()=>controller.abort(new Error('图片预览等待或处理超过期限，请重新查询')),80000):undefined;deadline?.unref();
      try{const dependencies={resolve:(id:string,token:string)=>musicBrainz.resolve(id,token),fingerprint:(id:string)=>db!.metadataReviewFingerprint(id),enabled:()=>db!.metadataNetworkEnabled()&&db!.providerSettings.setting('cover-art-archive').enabled};
       return method==='coverArtImagePreview'?await readCandidateCoverArtImage(request as import('../shared/contracts.js').CoverArtImageRequest,coverArtArchive,{...dependencies,convert:(bytes,signal)=>convertOnlineImage(mediaParser!,bytes,signal)},controller.signal):await readCandidateCoverArt(request,coverArtArchive,dependencies,controller.signal);}
      finally{if(deadline)clearTimeout(deadline);metadataQueries.delete(request.requestId);}
    }
    case 'metadataCreditPreview': {
      const request=params as {itemId:string;token:string;requestId:string;fresh?:boolean};
      if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128||typeof request.token!=='string'||request.token.length>128||typeof request.requestId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(request.requestId)||request.fresh!==undefined&&typeof request.fresh!=='boolean')throw new Error('无效在线署名预览');
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停');if(metadataQueries.has(request.requestId))throw new Error('在线查询 ID 已在使用');
      const targets=db.metadataCreditTargets(request.itemId),controller=new AbortController();for(const [id,query] of metadataQueries)if(query.itemId===request.itemId)cancelMetadataQuery(id);metadataQueries.set(request.requestId,{itemId:request.itemId,controller});
      try{const candidate=await musicBrainz.creditDetails(request.itemId,request.token,{signal:controller.signal,fresh:request.fresh,requestId:request.requestId});controller.signal.throwIfAborted();
       return {itemId:request.itemId,token:candidate.token,expiresAt:candidate.expiresAt,recordingTitle:candidate.title,releaseTitle:candidate.album,sourceUrl:candidate.sourceUrl,releaseUrl:candidate.releaseId?`https://musicbrainz.org/release/${candidate.releaseId}`:null,targets:targets.map(target=>({...target,candidates:db!.metadataCreditMembers(target.ref.kind==='release'?candidate.releaseCredits??[]:candidate.recordingCredits??[])}))};
      }finally{metadataQueries.delete(request.requestId);}
    }
    case 'metadataCreditApply': {
      const request=params as import('../shared/contracts.js').MetadataCreditApplyRequest;if(!request||typeof request.itemId!=='string'||request.itemId.length>128||typeof request.token!=='string'||request.token.length>128||!Array.isArray(request.entries)||request.entries.length>64)throw new Error('无效在线署名变更');
      const prior=db.metadataCollections.onlineReceipt(request);if(prior)return prior;
      if(!db.metadataNetworkEnabled())throw new Error('在线查询已暂停，请重新匹配');const candidate=musicBrainz.resolve(request.itemId,request.token);if(!candidate)throw new Error('署名候选已过期或取消，请重新预览');
      const result=db.metadataCollections.onlineCredit(request,candidate);reply({event:'libraryChanged',payload:{changeId:result.changeId}});return result;
    }
    case 'metadataUndoPreview': return db.metadataUndo.preview(params as string);
    case 'metadataUndoApply': {const result=db.metadataUndo.apply(params as import('../shared/contracts.js').MetadataUndoRequest);reply({event:'libraryChanged',payload:{changeId:result.undoId}});return result;}
    case 'metadataUndo': {
      const result=db.undoMetadata(String(params));
      reply({event:'libraryChanged',payload:{changeId:params}});
      return result;
    }
    default: throw new Error(`未知命令 ${method}`);
  }
}

async function freezeLibraryResources(owner:string,waitRequests:()=>Promise<void>):Promise<void>{
  if(!db||!scans||!libraryWatch||!mediaParser||!waveforms||!tagWrite)throw new Error('曲库尚未就绪，不能进入维护');
  if(searchIndexTimer)clearTimeout(searchIndexTimer);searchIndexTimer=undefined;searchIndexEpoch++;
  if(restoreTimer)clearInterval(restoreTimer);restoreTimer=undefined;
  tagWrite.close();invalidateMetadataNetwork();networkBroker.beginMaintenance(owner);
  // Register all drains immediately, then await every result; one failure cannot
  // release other owners or leave an unobserved rejecting drain.
  const drains=[libraryWatch.beginMaintenance(owner),scans.beginMaintenance(owner),waveforms.beginMaintenance(owner),fingerprints!.beginMaintenance(owner),mediaParser.beginMaintenance(owner),serviceReads.quiesceAll(owner),networkBroker.waitMaintenance(owner),restoreWork??Promise.resolve(),waitRequests()];
  const results=await Promise.allSettled(drains);
  const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failure)throw failure.reason;
  await tagWrite.beginMaintenance(owner);networkBroker.assertMaintenanceIdle(owner);
}
const catalogMaintenance=new CatalogMaintenance({
 freeze:freezeLibraryResources,
 release:async(owner,resumeWatch)=>{
  if(!db||!scans||!libraryWatch||!mediaParser||!waveforms||!tagWrite)throw new Error('曲库维护组件已退出');
  tagWrite.endMaintenance(owner);networkBroker.endMaintenance(owner);mediaParser.endMaintenance(owner);serviceReads.releaseAll(owner);
  libraryWatch.endMaintenance(owner,resumeWatch);waveforms.endMaintenance(owner);fingerprints!.endMaintenance(owner);scans.endMaintenance(owner);
  // Start on a later turn, after the global maintenance gate has published release.
  setImmediate(()=>{if(catalogMaintenance.held)return;scheduleSearchIndex();restoreFiles();if(!restoreTimer){restoreTimer=setInterval(restoreFiles,5000);restoreTimer.unref();}});
 },
 capture:(request,check)=>{if(!db||!libraryDataDir)throw new Error('曲库维护来源已退出');return captureQuiescedCatalog({db,dataDir:libraryDataDir,request,appVersion:RELEASE.appVersion,components:[{id:'aural.core',version:RELEASE.appVersion},...providerBackupComponents()],check});}
});

const registeredMediaReads=new Set(['artwork','artworkCandidate','lyrics','lyricsBundle','saveLyricsPreference','tagWritePreview']);
async function verifyDormantLibrary(folder:string,request:CatalogRestoreBootRequest):Promise<import('../shared/catalog-restore-compatibility.js').CatalogRestoreCompatibility>{
 const signal=AbortSignal.timeout(45*60*1000),before=await restoreTransactionDirectory(folder);if(before!==request.libraryIdentity)throw new Error('恢复启动原曲库身份不同');
 const inspector=new CatalogRestoreCompatibilityInspector(),compatibility=inspector.inspect(path.join(folder,'library.db'),request.manifest,signal);
 if(JSON.stringify(await inventoryCatalogLibraryRoot(folder,{signal}))!==JSON.stringify(request.manifest.files.filter(file=>file.path.startsWith('library/')))||await restoreTransactionDirectory(folder)!==before)throw new Error('恢复启动的完整曲库资料与原清单不符');return compatibility;
}
function prepareWritableRestore(value:unknown):Promise<CatalogRestoreActivationProof>{
 if(!dormantBoot||!restoreDormant)throw new Error('当前服务不是已核对的恢复只读实例');
 const request=readCatalogRestoreActivationRequest(value,dormantBoot.proof),key=lifecycleDigest(request);
 if(activationWork){if(key!==activationKey)throw new Error('原激活请求不能改变内容');return activationWork;}activationKey=key;
 const boot=dormantBoot;
 const work=catalogMaintenance.prepareFrozen(request,async()=>{
  if(!db||request.instanceId!==serviceInstanceId||catalogMaintenance.snapshot().token!==request.token)throw new Error('恢复激活实例或冻结租约已变化');
  await verifyDormantLibrary(libraryDataDir,boot.request);networkBroker.assertMaintenanceIdle(request.token);
  libraryWatch?.close();tagWrite?.close();db.close();db=undefined;
  let policy:import('../shared/catalog-restore-policy.js').CatalogRestorePolicy|null=null,metadata:import('./catalog-backup-database.js').BackupDatabaseMetadata;
  const writable=new LibraryDatabase(path.join(libraryDataDir,'library.db'),{restoreWritablePaused:true});
  try{if(request.role==='candidate')policy=writable.restorePolicy.apply(request,lifecycleDigest(boot.request.manifest),boot.request.manifest.origin);metadata=writable.catalogMetadata();}finally{writable.close();}
  const signal=AbortSignal.timeout(45*60*1000),files=await inventoryCatalogLibraryRoot(libraryDataDir,{signal});
  const manifest=readCatalogBackupManifest({...boot.request.manifest,backupId:request.operationId,appVersion:RELEASE.appVersion,plugins:[{id:'aural.core',version:RELEASE.appVersion},...providerBackupComponents()],counts:metadata.counts,files:[...files,...boot.request.manifest.files.filter(f=>!f.path.startsWith('library/'))].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
  const compatibility=new CatalogRestoreCompatibilityInspector().inspect(path.join(libraryDataDir,'library.db'),manifest,signal);
  db=new LibraryDatabase(path.join(libraryDataDir,'library.db'),{restoreWritablePaused:true});
  constructLibraryRuntime(runtimeParameters,libraryDataDir,true);await freezeLibraryResources(request.token,async()=>{});
  if(await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity||JSON.stringify(await inventoryCatalogLibraryRoot(libraryDataDir,{signal}))!==JSON.stringify(files)||request.role==='candidate'&&JSON.stringify(db.restorePolicy.load())!==JSON.stringify(policy))throw new Error('可写暂停连接构建后曲库身份或完整资料不同');
  return readCatalogRestoreActivationProof({version:1,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:request.libraryIdentity,requestSha256:key,sourceManifestSha256:lifecycleDigest(boot.request.manifest),manifest,policy,compatibility,writable:true,backgroundStarted:false},request,boot.request);
 });activationWork=work;void work.catch(()=>{});return work;
}

async function prepareRestoreHydration(value:unknown):Promise<RestoreHydrationProof>{
 if(!restoreDormant||!dormantBoot||!activationWork||!db)throw new Error('恢复曲库尚未完成可写准备');const activation=await activationWork,request=readRestoreHydrationRequest(value,activation,undefined,dormantBoot.proof.token),key=lifecycleDigest(request);
 if(request.role!==(activation.policy===null?'original':'candidate'))throw new Error('恢复状态重建角色不同');if(hydrationWork){if(key!==hydrationKey)throw new Error('同一曲库不能改变恢复状态请求');return hydrationWork;}hydrationKey=key;
 const work=catalogMaintenance.prepareFrozen(request,async()=>{
  if(!db||closedReceipt||request.instanceId!==serviceInstanceId||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity)throw new Error('恢复状态重建实例或目录不同');networkBroker.assertMaintenanceIdle(request.token);
  const expected=activation.manifest.files.filter(f=>f.path.startsWith('library/')),signal=AbortSignal.timeout(45*60*1000);
  if(JSON.stringify(await inventoryCatalogLibraryRoot(libraryDataDir,{signal}))!==JSON.stringify(expected))throw new Error('读取恢复设置前完整曲库资料变化');
  const snapshot=restoreLibrarySnapshot(db);
  if(JSON.stringify(await inventoryCatalogLibraryRoot(libraryDataDir,{signal}))!==JSON.stringify(expected)||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity)throw new Error('读取恢复设置后曲库资料变化');
  return readRestoreHydrationProof({version:1,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:request.libraryIdentity,requestSha256:key,snapshot,snapshotSha256:lifecycleDigest(snapshot),backgroundStarted:false},request);
 });hydrationWork=work;void work.catch(()=>{});return work;
}

async function prepareRestoreNormal(value:unknown):Promise<RestoreNormalProof>{
 if(!restoreDormant||!dormantBoot||!activationWork||!hydrationWork||!db)throw new Error('普通服务准备缺少原可写和状态准备');
 const activation=await activationWork,hydrated=await hydrationWork,request=readRestoreNormalRequest(value,activation,undefined,undefined,dormantBoot.proof.token),key=lifecycleDigest(request);
 if(request.role!==(activation.policy===null?'original':'candidate'))throw new Error('普通服务准备角色不同');if(normalWork){if(normalKey!==key)throw new Error('同一实例的普通服务准备请求不能改变');return normalWork;}normalKey=key;
 const work=catalogMaintenance.prepareFrozen(request,async()=>{
  const store=new CatalogRestoreTransactionStore(path.dirname(libraryDataDir)),loaded=await store.load(request.operationId),record=loaded.cutover.normal,ready=loaded.cutover.hydration?.ready,renderer=loaded.cutover.renderer?.ready;
  if(!record||record.proof||lifecycleDigest(record.request)!==key||!ready||!renderer||loaded.records.at(-1)?.kind!=='normal-intent'||!loaded.cutover.activation?.proof||lifecycleDigest(loaded.cutover.activation.proof)!==lifecycleDigest(activation)||lifecycleDigest(ready.library)!==lifecycleDigest(hydrated))throw new Error('普通服务准备没有当前全局持久意图');
  readRestoreNormalRequest(request,activation,ready,renderer,dormantBoot!.proof.token);
  if(!db||closedReceipt||request.instanceId!==serviceInstanceId||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity||restoreTimer||searchIndexTimer||restoreWork)throw new Error('普通服务准备实例或后台暂停不同');networkBroker.assertMaintenanceIdle(request.token);
  const signal=AbortSignal.timeout(45*60*1000),expected=activation.manifest.files.filter(f=>f.path.startsWith('library/'));
  if(JSON.stringify(await inventoryCatalogLibraryRoot(libraryDataDir,{signal}))!==JSON.stringify(expected))throw new Error('普通服务准备前曲库完整资料变化');
  const snapshot=()=>{if(!db)throw new Error('恢复连接已关闭');return restoreLibrarySnapshot(db);};
  const priorPolicy=lifecycleDigest(db.restorePolicy.load());if(lifecycleDigest(snapshot())!==hydrated.snapshotSha256)throw new Error('普通服务准备前使用状态不同');
  libraryWatch?.close();tagWrite?.close();db.close();db=undefined;
  db=new LibraryDatabase(path.join(libraryDataDir,'library.db'),{restoreNormalPaused:true});db.prepareRestoreNormal();
  const metadata=db.catalogMetadata(),policy=db.restorePolicy.load(),snapshotSha256=lifecycleDigest(snapshot());
  if(metadata.origin!==activation.manifest.origin||JSON.stringify(metadata.counts)!==JSON.stringify(activation.manifest.counts)||lifecycleDigest(policy)!==priorPolicy||snapshotSha256!==hydrated.snapshotSha256)throw new Error('普通服务准备改变曲库来源、数量、权限或使用状态');
  db.close();db=undefined;const files=await inventoryCatalogLibraryRoot(libraryDataDir,{signal});
  const manifest=readCatalogBackupManifest({...activation.manifest,counts:metadata.counts,files:[...files,...activation.manifest.files.filter(f=>!f.path.startsWith('library/'))].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
  const compatibility=new CatalogRestoreCompatibilityInspector().inspect(path.join(libraryDataDir,'library.db'),manifest,signal);
  db=new LibraryDatabase(path.join(libraryDataDir,'library.db'),{restoreNormalPaused:true});constructLibraryRuntime(runtimeParameters,libraryDataDir,true);await freezeLibraryResources(request.token,async()=>{});networkBroker.assertMaintenanceIdle(request.token);
  if(await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity||JSON.stringify(await inventoryCatalogLibraryRoot(libraryDataDir,{signal}))!==JSON.stringify(files)||lifecycleDigest(snapshot())!==snapshotSha256||lifecycleDigest(db.restorePolicy.load())!==priorPolicy||restoreTimer||searchIndexTimer||restoreWork)throw new Error('普通服务准备后实际曲库或冻结状态不同');
  return readRestoreNormalProof({version:1,operationId:request.operationId,activationId:request.activationId,challenge:request.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:request.libraryIdentity,requestSha256:key,manifest,compatibility,snapshotSha256,policySha256:policy===null?null:lifecycleDigest(policy),normalPrepared:true,backgroundStarted:false},request,activation,hydrated.snapshotSha256);
 });normalWork=work;void work.catch(()=>{});return work;
}

async function prepareCommittedService(value:unknown):Promise<RestoreServiceReadyProof>{
 if(!restoreDormant||!dormantBoot||!normalWork||!db)throw new Error('完成后服务准备缺少原暂停连接');const normal=await normalWork,request=readRestoreServiceReadyRequest(value,undefined,normal,dormantBoot.proof.token),key=lifecycleDigest(request);
 if(committedReadyWork){if(committedReadyKey!==key)throw new Error('同一实例的完成后服务请求不能改变');return committedReadyWork;}committedReadyKey=key;
 const work=catalogMaintenance.prepareFrozen(request,async()=>{
  const store=new CatalogRestoreTransactionStore(path.dirname(libraryDataDir)),loaded=await store.load(request.operationId),commit=loaded.cutover.commit,record=loaded.records.find(record=>record.kind==='decision-sealed');
  if(!commit?.request||commit.proof||!record||loaded.records.at(-1)?.kind!=='service-ready-intent'||lifecycleDigest(commit.request)!==key||lifecycleDigest(loaded.cutover.normal?.proof)!==lifecycleDigest(normal))throw new Error('服务就绪缺少原全局封存决策或意图');
  readRestoreServiceReadyRequest(request,commit.seal,normal,dormantBoot!.proof.token,record.sha256);
  if(!db||closedReceipt||request.instanceId!==serviceInstanceId||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity||restoreTimer||searchIndexTimer||restoreWork)throw new Error('服务就绪实例或后台暂停不同');networkBroker.assertMaintenanceIdle(request.token);
  const signal=AbortSignal.timeout(45*60*1000),expected=normal.manifest.files.filter(f=>f.path.startsWith('library/'));
  if(JSON.stringify(await inventoryCatalogLibraryRoot(libraryDataDir,{signal}))!==JSON.stringify(expected))throw new Error('WAL转换前实际曲库与封存清单不同');
  const before=restoreLibrarySnapshot(db),policy=db.restorePolicy.load();if(lifecycleDigest(before)!==normal.snapshotSha256||(policy===null?null:lifecycleDigest(policy))!==normal.policySha256)throw new Error('WAL转换前使用状态或权限不同');
  const evidence=db.prepareRestoreWal(),metadata=db.catalogMetadata(),after=restoreLibrarySnapshot(db);
  const held=catalogMaintenance.snapshot();if(await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity||lifecycleDigest(after)!==normal.snapshotSha256||(db.restorePolicy.load()===null?null:lifecycleDigest(db.restorePolicy.load()))!==normal.policySha256||metadata.origin!==normal.manifest.origin||lifecycleDigest(metadata.counts)!==lifecycleDigest(normal.manifest.counts)||restoreTimer||searchIndexTimer||restoreWork||held.operationId!==request.operationId||held.token!==request.token||held.phase!=='frozen')throw new Error('WAL转换后曲库、使用状态或后台暂停不同');networkBroker.assertMaintenanceIdle(request.token);
  return readRestoreServiceReadyProof({version:1,operationId:request.operationId,completionId:request.completionId,challenge:request.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:request.libraryIdentity,requestSha256:key,origin:metadata.origin,countsSha256:lifecycleDigest(metadata.counts),snapshotSha256:lifecycleDigest(after),policySha256:normal.policySha256,...evidence,businessGateHeld:true,backgroundStarted:false},request,normal);
 });committedReadyWork=work;void work.catch(()=>{});return work;
}

async function releaseCommittedService(value:unknown):Promise<RestoreLibraryReleaseProof>{
 if(!dormantBoot||!committedReadyWork||!db)throw new Error('恢复曲库释放缺少原就绪连接');const ready=await committedReadyWork,request=readRestoreLibraryReleaseRequest(value,undefined,ready,dormantBoot.proof.token),key=lifecycleDigest(request);
 if(committedReleaseWork){if(committedReleaseKey!==key)throw new Error('原曲库释放请求不能改变');return committedReleaseWork;}if(!restoreDormant)throw new Error('曲库恢复实例已改变模式');committedReleaseKey=key;
 const work=Promise.resolve().then(async()=>{
  await catalogMaintenance.prepareFrozen(request,async()=>{
   const store=new CatalogRestoreTransactionStore(path.dirname(libraryDataDir)),loaded=await store.load(request.operationId),release=loaded.cutover.libraryRelease,commit=loaded.cutover.commit,record=loaded.records.find(record=>record.kind==='service-ready-held');
   if(!release||release.proof||!commit?.proof||!record||loaded.records.at(-1)?.kind!=='library-release-intent'||lifecycleDigest(release.request)!==key||lifecycleDigest(commit.proof)!==lifecycleDigest(ready))throw new Error('曲库释放缺少原全局意图或独立就绪记录');readRestoreLibraryReleaseRequest(request,commit.seal,ready,dormantBoot!.proof.token,record.sha256);
   if(!db||closedReceipt||request.instanceId!==serviceInstanceId||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity||restoreTimer||searchIndexTimer||restoreWork)throw new Error('曲库释放前实际实例、目录或后台占用不同');db.assertRestoreWalReady();networkBroker.assertMaintenanceIdle(request.token);
   const metadata=db.catalogMetadata(),policy=db.restorePolicy.load();if(metadata.origin!==ready.origin||lifecycleDigest(metadata.counts)!==ready.countsSha256||lifecycleDigest(restoreLibrarySnapshot(db))!==ready.snapshotSha256||(policy===null?null:lifecycleDigest(policy))!==ready.policySha256)throw new Error('曲库释放前原资料或授权状态不同');
  });
  const released=await catalogMaintenance.release({operationId:request.operationId,token:request.token,resumeWatch:request.resumeWatch});
  if(released.operationId!==request.operationId||released.token!==request.token||released.phase!=='released'||catalogMaintenance.held||!db||closedReceipt||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity)throw new Error('曲库未确认释放原维护占用');
  // Timers and background managers may now run. Do not compare the old DELETE
  // manifest, counts or frozen snapshot after this resource release.
  restoreDormant=false;return readRestoreLibraryReleaseProof({version:1,operationId:request.operationId,completionId:request.completionId,challenge:request.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:request.libraryIdentity,requestSha256:key,phase:'released',businessGateHeld:false,backgroundReleased:true,resumeWatch:request.resumeWatch},request,ready);
 });committedReleaseWork=work;void work.catch(()=>{});return work;
}

async function closeFrozenService(value:unknown):Promise<CatalogServiceStopReceipt>{
 if(activationWork)throw new Error('可写准备已经开始，不能按旧只读关闭协议操作，须恢复核对');
 const request=readCatalogServiceStopRequest(value);if(request.instanceId!==serviceInstanceId||request.mode!==(restoreDormant?'dormant':'original'))throw new Error('关闭请求不属于当前曲库服务实例及模式');
 return catalogMaintenance.closeFrozen(request,async()=>{
  if(!db||await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity)throw new Error('受控关闭的原数据库或目录身份不同');
  networkBroker.assertMaintenanceIdle(request.token);const metadata=db.catalogMetadata();if(metadata.origin!==request.manifest.origin||JSON.stringify(metadata.counts)!==JSON.stringify(request.manifest.counts))throw new Error('受控关闭前曲库资料与恢复前快照不同');
  if(!restoreDormant)db.normalizeBeforeRestoreClose();db.close();db=undefined;
  libraryWatch?.close();if(searchIndexTimer)clearTimeout(searchIndexTimer);searchIndexTimer=undefined;if(restoreTimer)clearInterval(restoreTimer);restoreTimer=undefined;
  const signal=AbortSignal.timeout(45*60*1000),files=await inventoryCatalogLibraryRoot(libraryDataDir,{signal});if(await restoreTransactionDirectory(libraryDataDir)!==request.libraryIdentity)throw new Error('数据库关闭后的曲库目录身份不同');
  const manifest=readCatalogBackupManifest({...request.manifest,backupId:request.operationId,appVersion:RELEASE.appVersion,plugins:[{id:'aural.core',version:RELEASE.appVersion},...providerBackupComponents()],files:[...files,...request.manifest.files.filter(file=>!file.path.startsWith('library/'))].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)});
  const receipt=readCatalogServiceStopReceipt({version:1,operationId:request.operationId,token:request.token,challenge:request.challenge,instanceId:serviceInstanceId,pid:process.pid,buildId:RELEASE.mainBuildId,libraryIdentity:request.libraryIdentity,manifest,closed:true},request);
  closedReceipt=receipt;closedAckTimer=setTimeout(()=>process.exit(70),30000);return receipt;
 });
}
async function dispatchWithReadRegistration(method:string,params:unknown):Promise<unknown>{
 const itemId=typeof params==='string'?params:(params as {itemId?:unknown}|null)?.itemId;
 if(db&&registeredMediaReads.has(method)&&typeof itemId==='string'){const item=db.getItem(itemId);if(item)return serviceReads.run(item.path,()=>dispatch(method,params));}
 return dispatch(method,params);
}
port.on('message',event => {
  const request = event.data;
  if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') return;
  const trace=startupRpcTrace.begin(request.method);
  if(request.method==='catalogServiceStopAck'){
    try{const ack=restoreTransactionFields(request.params,['operationId','challenge','receiptSha256','recordSha256']);restoreTransactionDigest(ack.recordSha256);if(!closedReceipt||ack.operationId!==closedReceipt.operationId||ack.challenge!==closedReceipt.challenge||ack.receiptSha256!==lifecycleDigest(closedReceipt))throw new Error('原关闭回执尚未确认持久记录');if(closedAckTimer)clearTimeout(closedAckTimer);process.exit(0);}catch(error){reply({id:request.id,ok:false,error:String(error)});}return;
  }
  let work:Promise<unknown>;
  try{
    if(['catalogRestoreInit','catalogServiceStop','catalogRestoreActivate','catalogRestoreHydrate','catalogRestorePrepareNormal','catalogRestoreServiceReady','catalogRestoreRelease'].includes(request.method)&&Buffer.byteLength(JSON.stringify(request.params))>RESTORE_TRANSACTION_FRAME_BYTES)throw new Error('私有服务生命周期消息超过预算');
    if(request.method==='init'||request.method==='catalogRestoreInit'){if(initClaimed||db)throw new Error('同一曲库服务实例只能初始化一次');initClaimed=true;initializing=true;work=(request.method==='catalogRestoreInit'?Promise.resolve().then(()=>dispatch(request.method,request.params)):catalogMaintenance.run(()=>dispatchWithReadRegistration(request.method,request.params))).finally(()=>{initializing=false;});}
    else{if(initializing)throw new Error('曲库服务正在初始化');if(restoreDormant&&['catalogMaintenanceCapture','catalogMaintenanceRelease'].includes(request.method))throw new Error('恢复只读启动尚未激活，不能捕获或释放后台任务');
      work=request.method==='catalogRestoreRelease'?releaseCommittedService(request.params):request.method==='catalogRestoreServiceReady'?prepareCommittedService(request.params):request.method==='catalogRestorePrepareNormal'?prepareRestoreNormal(request.params):request.method==='catalogRestoreHydrate'?prepareRestoreHydration(request.params):request.method==='catalogRestoreActivate'?prepareWritableRestore(request.params):request.method==='catalogServiceStop'?Promise.resolve().then(()=>closeFrozenService(request.params)):request.method==='catalogMaintenanceState'?Promise.resolve(catalogMaintenance.snapshot()):request.method==='catalogMaintenanceBegin'?Promise.resolve().then(()=>catalogMaintenance.begin(request.params)):request.method==='catalogMaintenanceCapture'?Promise.resolve().then(()=>catalogMaintenance.capture(request.params)):request.method==='catalogMaintenanceRelease'?Promise.resolve().then(()=>catalogMaintenance.release(request.params)):catalogMaintenance.run(()=>dispatchWithReadRegistration(request.method,request.params));
    }
  }catch(error){work=Promise.reject(error);}
  void work
    .then(result => {trace?.(true);reply({id:request.id,ok:true,result});})
    .catch(error => {trace?.(false);reply({id:request.id,ok:false,error:String(error instanceof Error ? error.message : error)});});
});
