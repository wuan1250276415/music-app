import {MediaCapabilityRegistry} from './media-capabilities.js';
import {TagStageBatchController} from './tag-stage-batch-controller.js';
import {readFingerprintFind,readFingerprintChoice,readFingerprintToken} from '../shared/audio-fingerprint.js';
import {readMetadataBatchOrigin} from '../shared/metadata-batch-recheck.js';
import {readRecognitionCommand,readRecognitionIssueRequest,readRecognitionResultRequest} from '../shared/metadata-recognition.js';
import {readMetadataWorkflowCommand,workflowId,readWorkflowReview} from '../shared/metadata-workflow.js';
import {readBatchReviewItems,readBatchReviewToken} from '../shared/metadata-batch-review.js';
import {readMetadataMatchRequest} from '../shared/metadata-match-request.js';
import {readMetadataAlbumCreditsPreview,readMetadataAlbumCreditsApply} from '../shared/metadata-album-credits.js';
import {readMetadataGroupLinkPreview,readMetadataGroupLinkApply} from '../shared/metadata-group-link.js';
import {readMetadataIdentityPreview,readMetadataIdentityApply} from '../shared/metadata-identities.js';
import {readMetadataAlbumBatch,readMetadataAlbumPage,readMetadataAlbumTracks} from '../shared/metadata-album-review.js';
import {readReleaseFieldsApply,readReleaseFieldsUndo} from '../shared/metadata-release-fields.js';
import {readSmartHistoryRequest,readSmartHistoryDetailRequest,readSmartPlaylistRestoreRequest} from '../shared/smart-playlist-history.js';
import {readMusicPreviewRequest,readMusicPreviewCheckRequest} from '../shared/music-preview.js';
import {readFilterPresetPageRequest,readFilterPresetMutation,filterPresetId} from '../shared/filter-presets.js';
import {readSmartPlaylistPageRequest,readSmartPlaylistMutation,smartPlaylistId} from '../shared/smart-playlists.js';
import {readFilePolicyRequest} from '../shared/file-policy.js';
import {readTagWriteCancelRequest} from '../shared/tag-write-ui.js';
import {readTagRestoreStart,readTagRestoreCancel} from '../shared/tag-restore-journal.js';
import {readTagCommitStart,readTagCommitCancel} from '../shared/tag-commit-journal.js';
import {readCatalogBrowseRequest,readCatalogViewSave} from '../shared/catalog-browse.js';
import {readLibraryWatchRequest,type LibraryWatchState,type LibraryWatchResult} from '../shared/library-watch.js';
import {probeWatchRoot,normalizedWatchPath} from '../platform/file-watcher.js';
import {readBrowseRequest,readBrowsePlayRequest,type BrowsePlayContext} from '../shared/library-browse.js';
import {readRuleExportRequest,readRuleInspectionRequest,readRuleImportRequest,readRuleReferenceQuery,type RuleBundle} from '../shared/rule-transfer.js';
import {readPickedRules,writePickedRules} from './rule-transfer-files.js';
import {CatalogBackupCoordinator} from './catalog-backup.js';
import {CatalogRestoreCoordinator} from './catalog-restore.js';
import {CatalogDirectoryMover} from './catalog-directory-mover.js';
import {CatalogRestoreRecovery} from './catalog-restore-recovery.js';
import {verifyNormalStartupAdmission,recoveryRelaunchArguments} from './catalog-recovery-relaunch.js';
import {RestoreStartupBlocked,assertCatalogRestoreStartupSafe} from './catalog-restore-startup.js';
import {CatalogRestoreMaintenance} from './catalog-restore-maintenance.js';
import {CatalogRestorePreparation} from './catalog-restore-preparation.js';
import {CompletedLibraryStartupFailed} from './catalog-normal-startup-error.js';
import {CatalogLibraryLifecycle} from './catalog-library-lifecycle.js';
import {CatalogRestoreCompletion} from './catalog-restore-completion.js';
import {CatalogRestoreFinalization} from './catalog-restore-finalization.js';
import {readRestoreFinalReply} from '../shared/catalog-restore-finalization.js';
import {CatalogRestoreApplication} from './catalog-restore-application.js';
import {readRestoreAppReply} from '../shared/catalog-restore-application.js';
import {CatalogRestoreRelease} from './catalog-restore-release.js';
import {CatalogRestoreCommit} from './catalog-restore-commit.js';
import {CatalogRestoreNormalPreparation} from './catalog-restore-normal.js';
import {CatalogRestoreApply} from './catalog-restore-apply.js';
import {CatalogRestoreCutover} from './catalog-restore-cutover.js';
import {readBackupFrozen} from '../shared/catalog-backup-ui.js';
import {backupUuid} from '../shared/catalog-backup.js';
import {MainCatalogResources} from './catalog-main-resources.js';
import {WindowPlacementManager} from './window-placement.js';
import {StartupWindow} from './startup-window.js';
import {Appearance} from './appearance.js';
import {DesktopFiles,desktopFileArguments} from './desktop-files.js';
import {MEDIA_EXTENSIONS} from '../shared/media-formats.js';
import {SystemMedia,systemMediaCover} from './system-media.js';
import {RELEASE} from '../shared/release.js';
import {DsdOutputManager} from './dsd-output-manager.js';
import {MediaKeys} from './media-keys.js';
import {PauseRelease} from './pause-release.js';
import {DesktopLifecycle} from './desktop-lifecycle.js';
import {AudioDeviceWatch} from './audio-device-watch.js';
import {WasapiCapabilityProbe} from './audio-capabilities.js';
import {validEndpoint} from '../shared/audio-output.js';
import { app, BrowserWindow, dialog, ipcMain, shell,protocol,powerMonitor } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { UtilityProcess } from 'electron';
import { AudioController } from './audio.js';
import {WasapiDevices} from './audio-devices.js';
import {AsioControlPanel} from './asio-control-panel.js';
import {AsioDrivers} from './asio-drivers.js';
import {AudioBackendManager} from './audio-backend-manager.js';
import {AsioOutputManager} from './asio-output-manager.js';
import {asioDriverId,validateAsioDriverKey,type AsioCapabilities} from '../shared/asio-output.js';
import {AudioOutputManager} from './audio-output-manager.js';
import {validateAudioOutputRequest} from '../shared/audio-output.js';
import { PlaybackCoordinator } from './playback.js';
import {readPickedLyrics} from './lyrics-file.js';
import {readCueSourceExportRequest,type CueSourceExportData,type CueBundleInspection} from '../shared/cue-source-export.js';
import {exportPickedCueSource,readPickedCueSourceBundle} from './cue-source-files.js';
import {readEmbeddedCueRequest,readEmbeddedCueExportRequest,type EmbeddedCueExportData} from '../shared/embedded-cue-history.js';
import {exportPickedEmbeddedCue,embeddedCueExtension} from './embedded-cue-export.js';
import {readPickedEmbeddedCueBundle} from './embedded-cue-files.js';
import type {EmbeddedCueBundleInspection} from '../shared/embedded-cue-bundle.js';
import {readCueVersionReviewRequest,type CueVersionReview} from '../shared/cue-version-review.js';
import {readCueSourceSelectionRequest,type CueSourceSelectionResult} from '../shared/cue-source-selection.js';
import {readCueSourceImportRequest,type CueSourceImportResult} from '../shared/cue-source-import.js';
import {readCueSourceRegisterRequest} from '../shared/cue-source-registration.js';
import {readCueSourceOriginsRequest,readCueSourceOriginRequest} from '../shared/cue-source-origins.js';
import {cueId,cueHash,readCueEncoding,readCueInterpretRequest} from '../shared/cue-history.js';
import {ArtworkResources,type ArtworkQuery} from './artwork-resources.js';
import {readOnlineArtworkCommand} from '../shared/online-artwork.js';
import {readMetadataEditionsRequest} from '../shared/metadata-editions.js';
import {readMetadataReleaseContextRequest} from '../shared/metadata-release-context.js';
import type {LyricsImportInput} from '../shared/contracts.js';
import type { PlaybackState, EventMessage, LibraryItem, ListRequest, FacetView, MetadataApplyRequest, RepeatMode, QueueCommand, QueueState, UserStateRequest, PlaylistEditRequest, PlaylistPlaybackContext } from '../shared/contracts.js';

if (process.env.AURAL_TEST_DATA_DIR) app.setPath('userData',process.env.AURAL_TEST_DATA_DIR);

let systemMedia:SystemMedia|null=null;
let mediaKeys:MediaKeys|null=null;
let pauseRelease:PauseRelease|null=null;
let desktop:DesktopLifecycle|null=null;
const startupWindow=new StartupWindow();
let desktopReady=false;
let window: BrowserWindow | null = null;
let service: UtilityProcess | null = null;
let serviceReady = false;
let documentEpoch=0;
let interfaceHandoff:{window:BrowserWindow;ticket:string;epoch:number;acknowledge:(ticket:string,ready:boolean)=>boolean}|null=null;
let rendererQuitting=false;
const rendererRequests=new Set<Promise<unknown>>();
protocol.registerSchemesAsPrivileged([{scheme:'aural-artwork',privileges:{standard:true,secure:true}}]);
function serviceCall<T>(method: string, params?: unknown, timeoutMs = 15000): Promise<T> {
  return libraryLifecycle.call<T>(method,params,timeoutMs);
}

// Private maintenance requests retain their waiter until response or actual service
// exit. A UI observation deadline cannot release an in-flight capture owner.
function maintenanceCall<T>(method:string,params?:unknown):Promise<T>{
 return libraryLifecycle.controlCall<T>(method,params);
}

const tagStageBatches=new TagStageBatchController({available:()=>!rendererQuitting&&serviceReady&&desktopReady&&!mainResources.held&&!catalogRestoreRecovery.active,run:action=>mainResources.run(action),call:serviceCall,stageFile:(fileId,observation,action)=>playback.stageLibraryFile(fileId,observation,action),fault:message=>publish({event:'tagStageBatchChanged',payload:{error:message}})});
function publish(event: EventMessage | {event:'playback';payload:unknown}): void {
  if(event.event==='libraryChanged'){
    const change=event.payload as {reason?:string;itemId?:string};
    if(change?.reason==='online-artwork-changed'&&typeof change.itemId==='string')artworkResources.clearPreviews(change.itemId);
    else void artworkResources.reconcilePreviews(async itemId=>(await serviceCall<{fingerprint:string}>('metadataReviewState',itemId)).fingerprint);
  }else if(event.event==='providersChanged'||event.event==='metadataNetwork'&&(event.payload as {enabled:boolean}).enabled===false)artworkResources.clearPreviews();
  if(event.event==='playbackPolicyChanged'){try{historyRecorder?.configure(event.payload);}catch(error){publish({event:'playbackHistoryChanged',payload:{message:String(error)}});return;}}
  // Preserve Main history/control observers during stop, but do not cause new
  // cover or lyric reads in a renderer whose service is about to close.
  if (!rendererQuitting && window && !window.isDestroyed()) window.webContents.send('music:event',event);
  if(event.event==='playback'||event.event==='queue')desktop?.refresh();
  if(event.event==='playback')pauseRelease?.observe(event.payload as PlaybackState);
  if(event.event==='playback'||event.event==='queue')systemMedia?.refresh();
  if(event.event==='libraryChanged')systemMedia?.invalidateMetadata();
}
const artworkResources=new ArtworkResources(query=>serviceCall('artworkCandidate',query,60000),
 (itemId,assetId)=>serviceCall('artworkResource',{itemId,assetId}),
 (itemId,assetId,consumer,retain)=>serviceCall('artworkLease',{itemId,assetId,consumer,retain}),
 ()=>serviceCall('artworkResetLeases'));
async function artworkCandidate(query:ArtworkQuery,refresh=false):Promise<import('../shared/contracts.js').ArtworkCandidate|null>{
 const image=await serviceCall<import('../shared/contracts.js').ArtworkCandidate|null>('artworkCandidate',{...query,refresh},60000);
 return artworkResources.register(image,query);
}

import {CatalogRestoreRenderer} from './catalog-restore-renderer.js';
import {readRestoreRendererReply} from '../shared/catalog-restore-renderer.js';
import {lifecycleDigest} from '../platform/catalog-library-lifecycle.js';
import {CatalogRestoreHydration} from './catalog-restore-hydration.js';
import {readRestoreMainPrior,readRestoreStateSnapshot,type RestoreMainPrior} from '../shared/catalog-restore-state.js';
import {CatalogRestorePendingCoordinator} from './catalog-restore-pending.js';
import {readRestorePendingReply} from '../shared/catalog-restore-pending.js';
import {PlaybackHistoryRecorder} from './playback-history.js';
import {PlaybackHistoryExporter} from './history-export.js';
import {readHistoryQuery} from '../shared/playback-history.js';
import {readPlaybackPolicy,readPlaybackPolicyRequest,readPlaybackPolicyResult,matchesPlaybackPolicy} from '../shared/playback-policy.js';

let historyRecorder:PlaybackHistoryRecorder|null=null;
let playback: PlaybackCoordinator;
let analysisRequested=false;
function refreshAnalysisVisibility():void{
  audio.setAnalysisEnabled(Boolean(analysisRequested&&window&&!window.isDestroyed()&&window.isVisible()&&!window.isMinimized()));
}
const nativeAudioHost=app.isPackaged
  ?path.join(process.resourcesPath,'audio-host.exe')
  :path.resolve(__dirname,'../../../native/audio-host/build/audio-host.exe');
const mediaCapabilityRegistry=new MediaCapabilityRegistry(app.isPackaged?path.join(process.resourcesPath,'media-capabilities.json'):path.resolve(__dirname,'../../../release/media-capabilities.json'),nativeAudioHost);
const credentialVaultPath=app.isPackaged?path.join(process.resourcesPath,'credential-vault.exe'):path.resolve(__dirname,'../../../native/credential-vault/build/credential-vault.exe');
const fingerprintPath=app.isPackaged?path.join(process.resourcesPath,'fingerprint-worker.exe'):path.resolve(__dirname,'../../../native/audio-host/build/fingerprint-worker.exe');
const waveformPath=app.isPackaged?path.join(process.resourcesPath,'waveform-worker.exe'):path.resolve(__dirname,'../../../native/audio-host/build/waveform-worker.exe');
const systemMediaPath=app.isPackaged?path.join(process.resourcesPath,'system-media.exe'):path.resolve(__dirname,'../../../native/system-media/build/system-media.exe');
const mediaWorkerPath=app.isPackaged?path.join(process.resourcesPath,'media-worker.exe'):path.resolve(__dirname,'../../../native/media-worker/build/media-worker.exe');
const tagWorkerPath=app.isPackaged?path.join(process.resourcesPath,'tag-write-worker.exe'):path.resolve(__dirname,'../../../native/tag-write-worker/build/tag-write-worker.exe');
const libraryLifecycle=new CatalogLibraryLifecycle({
 workerPath:path.resolve(__dirname,'../library/service.js'),
 params:()=>({dataDir:path.join(app.getPath('userData'),'library'),credentialVaultPath,waveformPath,fingerprintPath,mediaWorkerPath,tagWorkerPath}),
 beforeNormal:()=>verifyNormalStartupAdmission(app.getPath('userData'),process.argv),
 guard:operationId=>{mainResources.assertFrozen(operationId);if(desktop?.isQuitting||playback.systemIsSleeping)throw new Error('应用正在退出或休眠，曲库恢复生命周期中断');},
 state:(process,ready)=>{service=process;serviceReady=ready;},publish,startupProgress:phase=>startupWindow.update(phase),
 unexpectedExit:code=>{catalogBackup.interrupt('曲库服务退出，备份已中断。');catalogRestore.interrupt('曲库服务退出，恢复预览已中断。');catalogDirectoryMover.interrupt('曲库服务退出，目录切换须重新核对。');catalogRestorePreparation.interrupt('曲库服务退出，整库恢复须重新核对。');catalogRestoreCutover.interrupt('曲库服务退出，整库切换须重新核对。');historyExporter.interrupt('曲库服务退出，历史导出已中断。');publish({event:'libraryChanged',payload:{error:`音乐库服务已退出 (${code})，请重启应用`}});}
});
const audio = new AudioController(nativeAudioHost,(state,reason) => {
  publish({event:'playback',payload:state});
  if(reason==='ended')playback?.onEnded();
  if(reason==='cueBoundary')playback?.onCueBoundary();
});
historyRecorder=new PlaybackHistoryRecorder(path.join(app.getPath('userData'),'playback-history-pending.json'),{save:value=>serviceCall('playbackHistoryCheckpoint',value),changed:()=>publish({event:'playbackHistoryChanged',payload:{}}),error:message=>publish({event:'playbackHistoryChanged',payload:{message}})});
audio.setHistoryObserver(value=>historyRecorder?.observe(value));
const historyExporter=new PlaybackHistoryExporter({source:path.join(app.getPath('userData'),'library','library.db'),workerPath:path.resolve(__dirname,'../library/history-export-worker.js'),ready:()=>serviceReady&&!desktop?.isQuitting,flush:()=>historyRecorder!.flush(),pending:()=>({observedAt:new Date().toISOString(),...historyRecorder!.status()}),origin:()=>serviceCall('historyExportOrigin'),publish:state=>publish({event:'historyExportChanged',payload:state}),pick:async format=>{if(!window||window.isDestroyed())throw new Error('主窗口不可用');const result=await dialog.showSaveDialog(window,{title:'导出播放历史',defaultPath:`Aural-playback-history-${new Date().toISOString().slice(0,10)}.${format}`,filters:[{name:format==='jsonl'?'JSON Lines 播放历史':'CSV 播放历史',extensions:[format]}]});return result.canceled||!result.filePath?null:result.filePath;}});
playback=new PlaybackCoordinator(audio,{
  load:()=>serviceCall('loadQueue'),
  save:(state:QueueState,baseRevision:number)=>serviceCall('saveQueue',{state,baseRevision}),
  item:(id:string)=>serviceCall<LibraryItem|undefined>('getPlaybackItem',id),
  items:(ids:string[])=>serviceCall<LibraryItem[]>('getPlaybackItems',ids),
  playlist:(playlistId:string,entryId:string,revision:number)=>serviceCall<PlaylistPlaybackContext>('playlistContext',{playlistId,entryId,revision})
},state=>publish({event:'queue',payload:state}));
pauseRelease=new PauseRelease(()=>audio.operationToken(),(observation,valid)=>playback.releasePaused(observation,valid));
const audioDeviceWatch=new AudioDeviceWatch(nativeAudioHost,state=>publish({event:'audioDevicesChanged',payload:state}));
const audioDevices=new WasapiDevices(nativeAudioHost,()=>audioDeviceWatch.snapshot().revision);
const asioDrivers:AsioDrivers=new AsioDrivers(nativeAudioHost,()=>audioDeviceWatch.snapshot().revision,():boolean=>audio.outputIsReleased()&&audioCapabilities.isIdle()&&asioPanel.isReleased()&&['idle','error'].includes(audio.snapshot().state));
audio.setAsioRebuilder(request=>playback.rebuildAsio(request));
audio.setExternalOutputGuard(()=>{mainResources.assertAvailable();asioDrivers.assertReleased();asioPanel.assertReleased();audioBackend.assertKnown();dsdOutput.assertKnown();});
let queuedAsioInspection:{key:string;promise:Promise<AsioCapabilities>}|null=null;
function inspectAsioOutput(value:unknown):Promise<AsioCapabilities>{
  const driver=validateAsioDriverKey(value),key=asioDriverId(driver);
  if(queuedAsioInspection)return queuedAsioInspection.key===key?queuedAsioInspection.promise:Promise.reject(new Error('正在读取另一 ASIO 驱动，请稍后重试'));
  const promise=playback.inspectStoppedOutput(()=>asioDrivers.inspect(driver)),entry={key,promise};queuedAsioInspection=entry;
  const clear=()=>{if(queuedAsioInspection===entry)queuedAsioInspection=null;};void promise.then(clear,clear);return promise;
}
const asioOutput=new AsioOutputManager(asioDrivers,{
  load:()=>serviceCall('loadAsioOutput'),save:(request,driver)=>serviceCall('saveAsioOutput',{request,driver}),receipt:request=>serviceCall('asioOutputReceipt',request)
},view=>publish({event:'asioOutputChanged',payload:view}),audio,playback);
const audioCapabilities=new WasapiCapabilityProbe(nativeAudioHost,()=>audioDeviceWatch.snapshot().revision);
const asioPanel:AsioControlPanel=new AsioControlPanel(nativeAudioHost,():boolean=>audio.outputIsReleased()&&audioCapabilities.isIdle()&&asioDrivers.isIdle()&&['idle','error'].includes(audio.snapshot().state),()=>asioDrivers.invalidateObservations(),state=>publish({event:'asioPanelChanged',payload:state}));
const audioOutput=new AudioOutputManager(audio,playback,audioDevices,{
  load:()=>serviceCall('loadAudioOutput'),save:(request,deviceName)=>serviceCall('saveAudioOutput',{request,deviceName}),receipt:request=>serviceCall('audioOutputReceipt',request)
},view=>publish({event:'audioOutputChanged',payload:view}));

const audioBackend=new AudioBackendManager(audio,playback,asioOutput,asioDrivers,{load:()=>serviceCall('loadAudioBackend'),save:request=>serviceCall('saveAudioBackend',request),receipt:request=>serviceCall('audioBackendReceipt',request)},view=>publish({event:'audioBackendChanged',payload:view}));
const dsdOutput=new DsdOutputManager(audio,playback,asioOutput,asioDrivers,()=>{asioDrivers.assertReleased();asioPanel.assertReleased();},{load:()=>serviceCall('loadDsdOutput'),save:request=>serviceCall('saveDsdOutput',request),receipt:request=>serviceCall('dsdOutputReceipt',request)},view=>publish({event:'dsdOutputChanged',payload:view}));

const desktopTransport={
 toggle:()=>mainResources.run(async()=>{pauseRelease?.cancel();const state=audio.snapshot();if(state.state==='playing'||state.state==='paused'||state.interruption)return playback.toggle();const q=playback.snapshot();return q.currentEntryId?playback.jump(q.currentEntryId,{commandId:randomUUID(),baseRevision:q.revision}):state;}),
 previous:()=>mainResources.run(()=>{const q=playback.snapshot();return playback.previous({commandId:randomUUID(),baseRevision:q.revision});}),
 next:()=>mainResources.run(()=>{const q=playback.snapshot();return playback.next({commandId:randomUUID(),baseRevision:q.revision});}),stop:()=>{mainResources.assertAvailable();return playback.stop();}};
mediaKeys=new MediaKeys({...desktopTransport,window:()=>window,playback:()=>audio.snapshot(),queue:()=>playback.snapshot(),sleeping:()=>playback.systemIsSleeping,token:()=>audio.operationToken(),
 load:()=>serviceCall('loadMediaKeyPreference'),save:(expected,value)=>serviceCall('saveMediaKeyPreference',{expected,value}),
 error:message=>publish({event:'desktopControlError',payload:{message}})});

systemMedia=new SystemMedia(systemMediaPath,{
 window:()=>window,playback:()=>audio.snapshot(),queue:()=>playback.snapshot(),token:()=>audio.operationToken(),sleeping:()=>playback.systemIsSleeping,
 item:id=>serviceCall<LibraryItem|undefined>('getItem',id),cover:id=>systemMediaCover(id,serviceCall),
 route:active=>mediaKeys?.setSystemSessionActive(active),publish:state=>publish({event:'systemMediaChanged',payload:state}),error:message=>publish({event:'desktopControlError',payload:{message}}),
 control:(action,value,itemId)=>{
  mainResources.assertAvailable();
  if(action==='stop')return desktopTransport.stop();
  if(action==='play')return audio.snapshot().state==='playing'?audio.snapshot():desktopTransport.toggle();
  if(action==='pause')return audio.snapshot().state==='playing'?desktopTransport.toggle():audio.snapshot();
  if(action==='next')return desktopTransport.next();if(action==='previous')return desktopTransport.previous();
  if(action==='seek'){pauseRelease?.cancel();return audio.seek(value as number,itemId??undefined);}
  const q=playback.snapshot(),command={commandId:randomUUID(),baseRevision:q.revision};
  return action==='repeat'?playback.setRepeat(value as RepeatMode,command):playback.setShuffle(value as boolean,command);
 }
});

desktop=new DesktopLifecycle({inputBlocked:()=>mainResources.held,window:()=>window,show:showMainWindow,playback:()=>audio.snapshot(),queue:()=>playback.snapshot(),
 ...desktopTransport,
 load:()=>serviceCall('loadDesktopPreference'),save:(expected,value)=>serviceCall('saveDesktopPreference',{expected,value}),mediaKeysSettings:()=>mediaKeys!.settings(),systemMediaSettings:()=>systemMedia!.settings(),windowPlacementSettings:()=>windowPlacement.settings()});

const desktopFiles=new DesktopFiles({roots:()=>serviceCall('roots'),lookup:input=>serviceCall('desktopFiles',input),item:id=>serviceCall('desktopFileSource',id),
 receipt:commandId=>serviceCall('desktopScanReceipt',commandId),importFolder:(folder,commandId,realPath)=>serviceCall('importDesktopFolder',{path:folder.path,existingRootId:folder.existingRootId,commandId,realPath}),token:()=>audio.operationToken(),sleeping:()=>playback.systemIsSleeping,
 play:(id,ids,command)=>{pauseRelease?.cancel();return playback.play(id,ids,command);},publish:inbox=>publish({event:'desktopFilesChanged',payload:inbox}),show:showMainWindow});
const appearance=new Appearance({inputBlocked:()=>mainResources.held,window:()=>window,load:()=>serviceCall('loadAppearancePreference'),save:(expected,value)=>serviceCall('saveAppearancePreference',{expected,value}),publish:state=>publish({event:'appearanceChanged',payload:state}),error:message=>publish({event:'desktopControlError',payload:{message}})});
// Geometry can queue behind large startup reads. Use the ordinary RPC deadline;
// before-quit independently bounds the final flush to 1.5s and terminates the
// original Library owner. A normal queue delay must not disable autosaving.
const windowPlacement=new WindowPlacementManager({inputBlocked:()=>mainResources.held,window:()=>window,load:()=>serviceCall('loadWindowPlacementPreference'),save:(expected,value)=>serviceCall('saveWindowPlacementPreference',{expected,value}),error:message=>publish({event:'desktopControlError',payload:{message}})});
// Private Main resource group: the backup owner freezes Renderer first and
// releases Library before these resources, keeping leases on a failed drain.
const mainResources:MainCatalogResources=new MainCatalogResources({
 resumeError:message=>publish({event:'desktopControlError',payload:{message}}),
 pause:()=>{pauseRelease?.cancel();audio.setAnalysisEnabled(false);},resume:()=>{refreshAnalysisVisibility();desktop?.refresh();windowPlacement.resumeInteraction();},playback,history:historyRecorder!,
 resources:[
  {name:'媒体快捷键',begin:owner=>mediaKeys!.beginMaintenance(owner),end:owner=>mediaKeys!.endMaintenance(owner)},
  {name:'系统媒体面板',begin:owner=>systemMedia!.beginMaintenance(owner),end:(owner,resume)=>systemMedia!.endMaintenance(owner,resume)},
  {name:'设备枚举',begin:owner=>audioDevices.beginMaintenance(owner),end:owner=>audioDevices.endMaintenance(owner)},
  {name:'设备格式查询',begin:owner=>audioCapabilities.beginMaintenance(owner),end:owner=>audioCapabilities.endMaintenance(owner)},
  {name:'ASIO 查询',begin:owner=>asioDrivers.beginMaintenance(owner),end:owner=>asioDrivers.endMaintenance(owner)},
  {name:'ASIO 面板',begin:owner=>asioPanel.beginMaintenance(owner),end:owner=>asioPanel.endMaintenance(owner)},
  {name:'设备通知',begin:owner=>audioDeviceWatch.beginMaintenance(owner),end:(owner,resume)=>audioDeviceWatch.endMaintenance(owner,resume)},
  {name:'播放历史导出',begin:owner=>historyExporter.beginMaintenance(owner),end:owner=>historyExporter.endMaintenance(owner)},
  {name:'外观',begin:owner=>appearance.beginMaintenance(owner),end:owner=>appearance.endMaintenance(owner)},
  {name:'窗口位置',begin:owner=>windowPlacement.beginMaintenance(owner),end:owner=>windowPlacement.endMaintenance(owner)},
  {name:'外部文件',begin:owner=>desktopFiles.beginMaintenance(owner),end:owner=>desktopFiles.endMaintenance(owner)},
  {name:'封面资源',begin:owner=>artworkResources.beginMaintenance(owner),end:owner=>artworkResources.endMaintenance(owner)},
  {name:'窗口与托盘',begin:owner=>desktop!.beginMaintenance(owner),end:owner=>desktop!.endMaintenance(owner)}
 ]
});
const directoryMoverPath=app.isPackaged?path.join(process.resourcesPath,'catalog-directory-mover.exe'):path.resolve(__dirname,'../../../native/tag-write-worker/build/catalog-directory-mover.exe');
const catalogDirectoryMover=new CatalogDirectoryMover(directoryMoverPath,app.getPath('userData'),owner=>{mainResources.assertFrozen(owner);catalogRestoreMaintenance.assertCutoverReady(owner);if(service!==null||serviceReady)throw new Error('曲库服务尚未实际退出，不能切换目录');if(desktop?.isQuitting||playback.systemIsSleeping)throw new Error('应用退出或系统休眠，不能继续目录切换');});
const catalogBackup:CatalogBackupCoordinator=new CatalogBackupCoordinator({
 resources:mainResources,dataDir:app.getPath('userData'),workerPath:path.resolve(__dirname,'../library/catalog-backup-worker.js'),
 otherBusy:()=>catalogRestore.busy||catalogRestorePreparation.busy||catalogRestoreCutover.busy||!catalogDirectoryMover.quiescent,
 ready:()=>serviceReady&&desktopReady&&Boolean(window&&!window.isDestroyed()),quitting:()=>Boolean(desktop?.isQuitting),sleeping:()=>playback.systemIsSleeping,
 call:maintenanceCall,publish:state=>publish({event:'catalogBackupChanged',payload:state}),
 freeze:request=>{if(!window||window.isDestroyed())throw new Error('主窗口不可用');window.webContents.send('music:event',{event:'catalogBackupFreeze',payload:request});},
 thaw:operationId=>{if(window&&!window.isDestroyed())window.webContents.send('music:event',{event:'catalogBackupThaw',payload:{operationId}});},
 changed:()=>publish({event:'libraryChanged',payload:{reason:'catalog-backup-released'}}),
 pick:async()=>{if(!window||window.isDestroyed())throw new Error('主窗口不可用');const result=await dialog.showSaveDialog(window,{title:'保存曲库备份',defaultPath:`Aural-library-${new Date().toISOString().slice(0,10)}.auralbackup`,filters:[{name:'Aural 曲库备份',extensions:['auralbackup']}]});return result.canceled||!result.filePath?null:result.filePath;}
});
const catalogRestore:CatalogRestoreCoordinator=new CatalogRestoreCoordinator({
 dataDir:app.getPath('userData'),workerPath:path.resolve(__dirname,'../library/catalog-restore-worker.js'),
 ready:()=>serviceReady&&desktopReady&&Boolean(window&&!window.isDestroyed())&&!desktop?.isQuitting&&!playback.systemIsSleeping,
 busy:()=>catalogBackup.busy||catalogRestorePreparation.busy||catalogRestoreCutover.busy||mainResources.held||!catalogDirectoryMover.quiescent,publish:state=>publish({event:'catalogRestoreChanged',payload:state}),
 pick:async()=>{if(!window||window.isDestroyed())throw new Error('主窗口不可用');const result=await dialog.showOpenDialog(window,{title:'选择曲库恢复文件',properties:['openFile'],filters:[{name:'Aural 曲库备份',extensions:['auralbackup']}]});return result.canceled||result.filePaths.length!==1?null:result.filePaths[0];}
});
const catalogRestoreMaintenance=new CatalogRestoreMaintenance({
 dataDir:app.getPath('userData'),resources:mainResources,
 ready:()=>serviceReady&&desktopReady&&Boolean(window&&!window.isDestroyed())&&!desktop?.isQuitting&&!playback.systemIsSleeping,
 busy:()=>catalogBackup.busy||catalogRestore.busy||!catalogDirectoryMover.quiescent,
 serviceAbsent:()=>service===null&&!serviceReady,
 matchesDormant:proof=>libraryLifecycle.matchesDormant(proof),matchesReleased:proof=>libraryLifecycle.matchesReleased(proof),
 resumeAllowed:()=>!desktop?.isQuitting&&!playback.systemIsSleeping,call:maintenanceCall,
 freeze:request=>{if(!window||window.isDestroyed())throw new Error('主窗口不可用');window.webContents.send('music:event',{event:'catalogBackupFreeze',payload:request});},
 thaw:operationId=>{if(window&&!window.isDestroyed())window.webContents.send('music:event',{event:'catalogBackupThaw',payload:{operationId}});},
 publish:state=>publish({event:'catalogBackupChanged',payload:state}),changed:()=>publish({event:'libraryChanged',payload:{reason:'restore-preparation-released'}})
});
const catalogRestorePreparation=new CatalogRestorePreparation({
 dataDir:app.getPath('userData'),workerPath:path.resolve(__dirname,'../library/catalog-restore-preparation-worker.js'),maintenance:catalogRestoreMaintenance,libraryLifecycle,
 ready:()=>serviceReady&&desktopReady&&Boolean(window&&!window.isDestroyed())&&!desktop?.isQuitting&&!playback.systemIsSleeping,
 lifecycleAvailable:()=>desktopReady&&Boolean(window&&!window.isDestroyed())&&!desktop?.isQuitting&&!playback.systemIsSleeping,
 busy:()=>catalogBackup.busy||catalogRestore.busy||mainResources.held||!catalogDirectoryMover.quiescent
});
const catalogRestorePending=new CatalogRestorePendingCoordinator({dataDir:app.getPath('userData'),history:historyRecorder!,assertFrozen:owner=>mainResources.assertFrozen(owner),send:request=>{if(!window||window.isDestroyed())throw new Error('主窗口不可用');window.webContents.send('music:event',{event:'catalogRestorePending',payload:request});}});
function restoreMainPrior(owner:string):RestoreMainPrior{
 mainResources.assertFrozen(owner);playback.assertRestoreFrozen(owner);const output=audioOutput.snapshot(),asio=asioOutput.snapshot(),backend=audioBackend.snapshot(),dsd=dsdOutput.snapshot(),look=appearance.restoreSnapshot(owner);
 return readRestoreMainPrior({snapshot:{version:1,queue:playback.snapshot(),audioOutput:output.preference,asioOutput:asio.preference,audioBackend:backend.preference,dsdOutput:dsd.preference,appearance:look.preference,windowPlacement:windowPlacement.restoreSnapshot(owner),desktop:desktop!.restoreSnapshot(owner),mediaKeys:mediaKeys!.restoreSnapshot(owner),historyPolicy:historyRecorder!.restoreSnapshot(owner)},pending:{audioOutput:output.pendingRequest,asioOutput:asio.pendingRequest,audioBackend:backend.pendingRequest,dsdOutput:dsd.pendingRequest,appearance:look.pendingRequest,desiredZoom:look.desiredZoom}});
}
const catalogRestoreHydration=new CatalogRestoreHydration({dataDir:app.getPath('userData'),library:libraryLifecycle,assertFrozen:owner=>mainResources.assertFrozen(owner),prior:restoreMainPrior,outputReleased:()=>audio.outputIsReleased(),
 prepare:async(owner,proof,historySha256,authorize)=>{
  const check=()=>{authorize();mainResources.assertFrozen(owner);playback.assertRestoreFrozen(owner);};check();const state=readRestoreStateSnapshot(proof.snapshot);
  audio.prepareRestoreState();analysisRequested=false;pauseRelease?.cancel();check();playback.prepareRestoreState(owner,state.queue);
  check();asioOutput.prepareRestoreState(owner,state.asioOutput);check();audioBackend.prepareRestoreState(owner,state.audioBackend);check();audioOutput.prepareRestoreState(owner,state.audioOutput);check();dsdOutput.prepareRestoreState(owner,state.dsdOutput);
  check();appearance.prepareRestoreState(owner,state.appearance);check();windowPlacement.prepareRestoreState(owner,state.windowPlacement);check();desktop!.prepareRestoreState(owner,state.desktop);check();mediaKeys!.prepareRestoreState(owner,state.mediaKeys);check();systemMedia!.prepareRestoreState(owner);
  await historyRecorder!.prepareRestoreState(owner,state.historyPolicy,historySha256,check);check();return readRestoreStateSnapshot(restoreMainPrior(owner).snapshot);
 }
});
const catalogRestoreRenderer=new CatalogRestoreRenderer({dataDir:app.getPath('userData'),rendererFile:path.resolve(__dirname,'../../renderer/index.html'),location:()=>{if(!window||window.isDestroyed())throw new Error('恢复主窗口已关闭');return {webContentsId:window.webContents.id,epoch:documentEpoch,url:window.webContents.getURL()};},
 assertHydrated:loaded=>{const owner=loaded.intent.transactionId;mainResources.assertFrozen(owner);catalogRestoreMaintenance.assertFrozen(owner);const ready=loaded.cutover.hydration?.ready,boot=loaded.cutover.activation?.request.role==='candidate'?loaded.cutover.candidateBoot:loaded.cutover.originalBoot;if(!ready||!boot?.proof||!libraryLifecycle.matchesDormant(boot.proof)||!catalogDirectoryMover.quiescent||lifecycleDigest(restoreMainPrior(owner).snapshot)!==ready.mainSha256)throw new Error('界面重建所属曲库或 Main 状态不同');},reload:()=>{if(!window||window.isDestroyed())throw new Error('恢复主窗口已关闭');window.webContents.reload();}});
const catalogRestoreNormal=new CatalogRestoreNormalPreparation({dataDir:app.getPath('userData'),library:libraryLifecycle,renderer:catalogRestoreRenderer,assertFrozen:owner=>{mainResources.assertFrozen(owner);catalogRestoreMaintenance.assertFrozen(owner);}});
const catalogRestoreCommit=new CatalogRestoreCommit({dataDir:app.getPath('userData'),library:libraryLifecycle,renderer:catalogRestoreRenderer,assertFrozen:owner=>{mainResources.assertFrozen(owner);catalogRestoreMaintenance.assertFrozen(owner);},resumeAllowed:()=>desktopReady&&!desktop?.isQuitting&&!playback.systemIsSleeping});
const catalogRestoreRelease=new CatalogRestoreRelease({dataDir:app.getPath('userData'),resources:mainResources,library:libraryLifecycle,renderer:catalogRestoreRenderer,maintenance:catalogRestoreMaintenance});
const catalogRestoreApplication=new CatalogRestoreApplication({dataDir:app.getPath('userData'),resources:mainResources,renderer:catalogRestoreRenderer,library:libraryLifecycle,maintenance:catalogRestoreMaintenance,location:()=>{if(!window||window.isDestroyed())throw new Error('恢复主窗口已关闭');return {webContentsId:window.webContents.id,epoch:documentEpoch,url:window.webContents.getURL()};},send:request=>{if(!window||window.isDestroyed())throw new Error('恢复主窗口已关闭');window.webContents.send('music:event',{event:'catalogRestoreApplication',payload:request});}});
const catalogRestoreFinalization=new CatalogRestoreFinalization({dataDir:app.getPath('userData'),resources:mainResources,application:catalogRestoreApplication,maintenance:catalogRestoreMaintenance,send:request=>{if(!window||window.isDestroyed())throw new Error('恢复主窗口已关闭');window.webContents.send('music:event',{event:'catalogRestoreFinalization',payload:request});}});
const catalogRestoreCompletion=new CatalogRestoreCompletion({dataDir:app.getPath('userData'),resources:mainResources,finalization:catalogRestoreFinalization,application:catalogRestoreApplication,renderer:catalogRestoreRenderer,maintenance:catalogRestoreMaintenance,preparation:catalogRestorePreparation,library:libraryLifecycle});
const catalogRestoreCutover=new CatalogRestoreCutover({dataDir:app.getPath('userData'),preparation:catalogRestorePreparation,maintenance:catalogRestoreMaintenance,libraryLifecycle,mover:catalogDirectoryMover,pending:catalogRestorePending,hydration:catalogRestoreHydration,renderer:catalogRestoreRenderer,normal:catalogRestoreNormal,commit:catalogRestoreCommit,release:catalogRestoreRelease,application:catalogRestoreApplication,finalization:catalogRestoreFinalization,completion:catalogRestoreCompletion,
 available:()=>desktopReady&&Boolean(window&&!window.isDestroyed())&&!desktop?.isQuitting&&!playback.systemIsSleeping,serviceAbsent:()=>service===null&&!serviceReady});
const catalogRestoreApply=new CatalogRestoreApply({preview:catalogRestore,cutover:catalogRestoreCutover,admit:()=>{mainResources.assertAvailable();if(!serviceReady||catalogBackup.busy||catalogRestore.busy||catalogRestorePreparation.busy||!catalogDirectoryMover.quiescent)throw new Error('曲库服务未准备好或已有备份恢复操作');},available:()=>desktopReady&&Boolean(window&&!window.isDestroyed())&&!desktop?.isQuitting&&!playback.systemIsSleeping,publish:state=>publish({event:'catalogRestoreApplyChanged',payload:state})});
const catalogRestoreRecovery=new CatalogRestoreRecovery({dataDir:app.getPath('userData'),absent:()=>service===null&&!serviceReady&&!desktopReady,restart:permission=>{if(service!==null||serviceReady||desktopReady||desktop?.isQuitting||!window||window.isDestroyed())throw new Error('当前应用不能重新启动核对');const args=recoveryRelaunchArguments(process.argv,desktopFileArguments(process.argv,app.isPackaged),permission);app.relaunch({args});setImmediate(()=>app.quit());},pick:async()=>{if(!window||window.isDestroyed())throw new Error('启动核对窗口已关闭');const result=await dialog.showSaveDialog(window,{title:'导出恢复核对报告',defaultPath:'Aural-restore-recovery-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'JSON 核对报告',extensions:['json']}]});return result.canceled||!result.filePath?null:result.filePath;}});
function backupIpc(channel:string,handler:Parameters<typeof ipcMain.handle>[1]):void{
 if(!['startup:ticket','startup:interface','catalog-backup:state','catalog-backup:start','catalog-backup:frozen','catalog-backup:cancel','catalog-backup:quit','catalog-backup:history','catalog-backup:verify','catalog-restore:recovery-state','catalog-restore:recovery-recheck','catalog-restore:recovery-export','catalog-restore:recovery-restart','catalog-restore:recovery-move-review','catalog-restore:recovery-move-confirm','catalog-restore:apply-state','catalog-restore:apply','catalog-restore:review','catalog-restore:state','catalog-restore:start','catalog-restore:cancel','catalog-restore:history','catalog-restore:recheck','catalog-restore:pending-reply','catalog-restore:renderer-seed','catalog-restore:renderer-reply','catalog-restore:application-reply','catalog-restore:finalization-reply'].includes(channel))throw new Error('不允许的维护控制接口');
 ipcMain.handle(channel,(event,...args)=>{filesSender(event);if(catalogRestoreRecovery.active&&!['startup:ticket','catalog-restore:recovery-state','catalog-restore:recovery-recheck','catalog-restore:recovery-export','catalog-restore:recovery-restart','catalog-restore:recovery-move-review','catalog-restore:recovery-move-confirm','catalog-backup:quit'].includes(channel))throw new Error('启动恢复核对期间普通维护操作暂停');return handler(event,...args);});
}
function handleIpc(channel:string,handler:Parameters<typeof ipcMain.handle>[1]):void{
 ipcMain.handle(channel,(event,...args)=>{
  if(rendererQuitting){
   filesSender(event);
   // These two validated teardown operations are idempotent and cannot read
   // Library, retain artwork, start analysis or create a device session.
   if(channel==='analysis:enabled'&&args.length===1&&args[0]===false)return handler(event,...args);
   if(channel==='library:artwork-lease'&&args.length===5&&args[3]===false)return handler(event,...args);
   throw new Error('应用正在退出');
  }
  const start=()=>{filesSender(event);if(catalogRestoreRecovery.active)throw new Error('恢复登记尚未确认，曲库与播放操作暂停');if(mainResources.held){const read=catalogRestoreApplication.tryRead(channel,args,()=>handler(event,...args),()=>filesSender(event));if(read)return read;}return mainResources.run(()=>handler(event,...args));};
  const work=start(),tracked=work.finally(()=>rendererRequests.delete(tracked));rendererRequests.add(tracked);return tracked;
 });
}
function captureDesktopFiles(paths:string[],source:'open'|'picker'|'drop'):Promise<string|null>{
 if(catalogRestoreRecovery.active)return Promise.reject(new Error('恢复登记尚未确认，请先核对原资料'));return mainResources.run(()=>desktopFiles.enqueue(paths,source)).catch(error=>{publish({event:'desktopControlError',payload:{message:String(error)}});throw error;});
}
function filesSender(event:Electron.IpcMainInvokeEvent):void{trusted(event.sender);if(!window||event.senderFrame!==window.webContents.mainFrame)throw new Error('文件操作仅限主界面');}
let pickingFiles=false;

function trusted(sender: Electron.WebContents): void {
  if (!window || window.isDestroyed() || sender.id !== window.webContents.id) throw new Error('无权访问该接口');
}

function checkedQueueCommand(value:unknown):QueueCommand {
  if(!value||typeof value!=='object')throw new Error('缺少队列命令');
  const command=value as QueueCommand;
  if(typeof command.commandId!=='string'||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.commandId)||
    !Number.isSafeInteger(command.baseRevision)||command.baseRevision<0)throw new Error('无效队列命令');
  return {commandId:command.commandId,baseRevision:command.baseRevision};
}

async function startLibrary(): Promise<void> {
  await libraryLifecycle.startNormal();tagStageBatches.start();
}

function registerIpc(): void {
  backupIpc('startup:ticket',event=>{filesSender(event);return !rendererQuitting&&startupWindow.active&&serviceReady&&desktopReady&&!catalogRestoreRecovery.active&&interfaceHandoff?.window===window&&interfaceHandoff.epoch===documentEpoch?interfaceHandoff.ticket:null;});
  backupIpc('startup:interface',(event,ticket:unknown,status:unknown)=>{filesSender(event);if(typeof ticket!=='string'||ticket.length!==36||status!=='ready'&&status!=='blocked')throw new Error('无效启动界面回执');if(rendererQuitting||!startupWindow.active||!serviceReady||!desktopReady||catalogRestoreRecovery.active)return false;return interfaceHandoff?.acknowledge(ticket,status==='ready')??false;});
  backupIpc('catalog-restore:finalization-reply',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>16384)throw new Error('恢复最终回执超过预算');catalogRestoreFinalization.reply(readRestoreFinalReply(value),()=>filesSender(event));});
  backupIpc('catalog-restore:application-reply',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>16384)throw new Error('恢复应用回执超过预算');catalogRestoreApplication.reply(readRestoreAppReply(value),()=>filesSender(event));});
  backupIpc('catalog-restore:renderer-seed',event=>catalogRestoreRenderer.seed(()=>filesSender(event)));
  backupIpc('catalog-restore:renderer-reply',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>16384)throw new Error('界面准备回执超过预算');catalogRestoreRenderer.reply(readRestoreRendererReply(value),()=>filesSender(event));});
  backupIpc('catalog-restore:pending-reply',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>16384)throw new Error('恢复资料回执超过预算');const reply=readRestorePendingReply(value);catalogRestorePending.reply(reply,()=>filesSender(event));});
  backupIpc('catalog-backup:state',()=>catalogRestoreMaintenance.busy?catalogRestoreMaintenance.snapshotBoundary():catalogBackup.snapshot());
  backupIpc('catalog-restore:state',()=>catalogRestore.snapshot());
  backupIpc('catalog-restore:recovery-move-review',(event,value)=>{const epoch=documentEpoch;return catalogRestoreRecovery.reviewRecordedMove(value,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('切换回执审核所属文档已变化');});});
  backupIpc('catalog-restore:recovery-move-confirm',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>4096)throw new Error('切换回执确认超过预算');const epoch=documentEpoch;return catalogRestoreRecovery.reconcileRecordedMove(value,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('切换回执确认所属文档已变化');});});
  backupIpc('catalog-restore:recovery-restart',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>4096)throw new Error('重新启动确认超过预算');const epoch=documentEpoch;return catalogRestoreRecovery.restart(value,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('重新启动所属文档已变化');});});
  backupIpc('catalog-restore:recovery-state',()=>catalogRestoreRecovery.snapshot());
  backupIpc('catalog-restore:recovery-recheck',event=>{const epoch=documentEpoch;return catalogRestoreRecovery.recheck(()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('启动核对所属文档已变化');});});
  backupIpc('catalog-restore:recovery-export',event=>{const epoch=documentEpoch;return catalogRestoreRecovery.exportReport(()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('核对报告所属文档已变化');});});
  backupIpc('catalog-restore:apply-state',()=>catalogRestoreApply.snapshot());
  backupIpc('catalog-restore:apply',(event,value)=>{if(Buffer.byteLength(JSON.stringify(value))>4096)throw new Error('恢复确认请求超过预算');const epoch=documentEpoch;mainResources.assertAvailable();return catalogRestoreApply.start(value,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('恢复确认所属界面文档已变化');});});
  backupIpc('catalog-restore:review',(event,operationId)=>{const epoch=documentEpoch;return catalogRestore.review(operationId,()=>{filesSender(event);mainResources.assertAvailable();if(epoch!==documentEpoch)throw new Error('恢复审核所属界面文档已变化');});});
  backupIpc('catalog-restore:history',()=>catalogRestore.history());
  backupIpc('catalog-restore:recheck',(event,operationId)=>{const epoch=documentEpoch;if(catalogRestoreApply.busy)throw new Error('已有恢复确认或应用操作');return catalogRestore.recheck(operationId,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('恢复核对所属界面文档已变化');});});
  backupIpc('catalog-restore:start',(event,operationId)=>{const epoch=documentEpoch;if(catalogRestoreApply.busy)throw new Error('已有恢复确认或应用操作');return catalogRestore.start(operationId,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('恢复预览所属界面文档已变化');});});
  backupIpc('catalog-restore:cancel',(_event,operationId)=>catalogRestoreApply.owns(operationId)?catalogRestoreApply.cancel(operationId):catalogRestoreCutover.owns(backupUuid(operationId))?catalogRestoreCutover.cancel(operationId):catalogRestore.cancel(operationId));
  backupIpc('catalog-backup:history',()=>catalogBackup.history());
  backupIpc('catalog-backup:verify',(event,operationId)=>{
   if(catalogRestoreApply.busy)throw new Error('已有恢复确认或应用操作');const epoch=documentEpoch;return catalogBackup.verify(operationId,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('备份核对所属界面文档已变化');});
  });
  backupIpc('catalog-backup:start',(event,operationId)=>{
   if(catalogRestoreApply.busy)throw new Error('已有恢复确认或应用操作');const epoch=documentEpoch;return catalogBackup.start(operationId,()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('备份所属界面文档已变化');});
  });
  backupIpc('catalog-backup:frozen',(event,value)=>{const reply=readBackupFrozen(value);if(catalogRestoreMaintenance.owns(reply.operationId))catalogRestoreMaintenance.frozenReply(reply,()=>filesSender(event));else catalogBackup.frozenReply(reply,()=>filesSender(event));});
  backupIpc('catalog-backup:cancel',(_event,operationId)=>catalogRestoreCutover.owns(operationId)?catalogRestoreCutover.cancel(operationId):catalogRestoreMaintenance.busy?catalogRestorePreparation.cancel(operationId):catalogBackup.cancel(operationId));
  backupIpc('catalog-backup:quit',()=>{app.quit();});
  handleIpc('appearance:state',event=>{filesSender(event);return appearance.snapshot();});
  handleIpc('appearance:refresh',event=>{filesSender(event);return appearance.refresh();});
  handleIpc('appearance:configure',(event,value)=>{filesSender(event);return appearance.configure(value);});
  handleIpc('desktop:files',event=>{filesSender(event);return desktopFiles.inbox();});
  handleIpc('desktop:file-request',(event,id)=>{filesSender(event);return desktopFiles.review(id);});
  handleIpc('desktop:drop-files',(event,paths)=>{filesSender(event);return captureDesktopFiles(paths,'drop');});
  handleIpc('desktop:pick-files',async event=>{
   filesSender(event);if(pickingFiles)throw new Error('文件选择窗口已经打开');pickingFiles=true;
   try{const result=await dialog.showOpenDialog(window!,{title:'打开音乐文件',properties:['openFile','multiSelections'],filters:[{name:'音乐与 CUE',extensions:[...MEDIA_EXTENSIONS]}]});return result.canceled||!result.filePaths.length?null:captureDesktopFiles(result.filePaths,'picker');}finally{pickingFiles=false;}
  });
  handleIpc('desktop:refresh-files',(event,id,revision)=>{filesSender(event);return desktopFiles.refresh(id,revision);});
  handleIpc('desktop:submit-files',(event,input)=>{filesSender(event);return desktopFiles.submit(input);});
  handleIpc('desktop:play-file',async(event,input)=>{
   filesSender(event);try{if(!input||typeof input!=='object')throw new Error('无效播放请求');const state=await desktopFiles.play({...input,command:checkedQueueCommand(input.command)});return {status:'processed',state};}
   catch(e){return {status:'rejected',message:String(e instanceof Error?e.message:e).slice(0,500)};}
  });
  handleIpc('desktop:dismiss-files',(event,id,revision)=>{filesSender(event);return desktopFiles.dismiss(id,revision);});
  handleIpc('audio:device-watch',event=>{trusted(event.sender);return audioDeviceWatch.snapshot();});
  handleIpc('audio:device-watch-restart',event=>{trusted(event.sender);return audioDeviceWatch.start();});
  handleIpc('audio:devices',event=>{trusted(event.sender);return audioDevices.list();});
  handleIpc('audio:asio-drivers',event=>{trusted(event.sender);return asioDrivers.list();});
  handleIpc('audio:asio-capabilities',(event,driver:unknown)=>{trusted(event.sender);return inspectAsioOutput(driver);});
  handleIpc('audio:backend',event=>{trusted(event.sender);return audioBackend.snapshot();});
  handleIpc('audio:backend-configure',(event,request:unknown)=>{trusted(event.sender);return audioBackend.configure(request);});
  handleIpc('audio:asio-volume',(event,request:unknown)=>{trusted(event.sender);return audioBackend.setVolume(request);});
  handleIpc('audio:asio-panel',event=>{trusted(event.sender);return asioPanel.snapshot();});
  handleIpc('audio:asio-panel-open',(event,request:unknown)=>{trusted(event.sender);return playback.inspectStoppedOutput(()=>asioPanel.open(request));});
  handleIpc('audio:asio-panel-finish',(event,id:unknown)=>{trusted(event.sender);return asioPanel.finish(id);});
  handleIpc('audio:asio-panel-cancel',(event,id:unknown)=>{trusted(event.sender);return asioPanel.cancel(id);});
  handleIpc('audio:asio-output',event=>{trusted(event.sender);return asioOutput.snapshot();});
  handleIpc('audio:asio-configure',(event,request:unknown)=>{trusted(event.sender);return asioOutput.configure(request);});
  handleIpc('audio:dsd-output',event=>{trusted(event.sender);return dsdOutput.snapshot();});
  handleIpc('audio:dsd-configure',(event,request:unknown)=>{trusted(event.sender);return dsdOutput.configure(request);});
  handleIpc('audio:device-capabilities',async(event,id:unknown)=>{trusted(event.sender);if(!validEndpoint(id))throw new Error('设备标识无效');const catalog=await audioDevices.list(),device=catalog.devices.find(entry=>entry.id===id);if(!device)throw new Error('设备当前不可用，请刷新列表');asioDrivers.assertReleased();asioPanel.assertReleased();return audioCapabilities.inspect(device);});
  handleIpc('audio:output',event=>{trusted(event.sender);return audioOutput.snapshot();});
  handleIpc('audio:configure',(event,value)=>{trusted(event.sender);return audioOutput.configure(validateAudioOutputRequest(value));});
  handleIpc('desktop:system-media-state',event=>{trusted(event.sender);return systemMedia!.snapshot();});
  handleIpc('desktop:system-media',event=>{trusted(event.sender);return systemMedia!.settings();});
  handleIpc('desktop:media-keys',event=>{trusted(event.sender);return mediaKeys!.settings();});
  handleIpc('desktop:settings',event=>{trusted(event.sender);return desktop!.settings();});
  handleIpc('desktop:placement-settings',event=>{filesSender(event);return windowPlacement.settings();});
  handleIpc('audio:volume',(event,value)=>{trusted(event.sender);if(audio.backendSnapshot().backend!=='wasapi')throw new Error('当前使用 ASIO，请在 ASIO 播放设置中调整数字处理');return audioOutput.setVolume(validateAudioOutputRequest(value));});
  handleIpc('waveform:request',(event,itemId,commandId)=>{trusted(event.sender);return serviceCall('waveformRequest',{itemId,commandId});});
  handleIpc('waveform:job',(event,id)=>{trusted(event.sender);return serviceCall('waveformJob',id);});
  handleIpc('waveform:cancel',(event,id)=>{trusted(event.sender);return serviceCall('waveformCancel',id);});
  handleIpc('waveform:list',event=>{trusted(event.sender);return serviceCall('waveformJobs');});
  handleIpc('analysis:enabled',(event,enabled)=>{trusted(event.sender);if(typeof enabled!=='boolean')throw new Error('无效音频分析设置');analysisRequested=enabled;refreshAnalysisVisibility();});
  handleIpc('analysis:snapshot',event=>{trusted(event.sender);return audio.analysisSnapshot();});
  handleIpc('analysis:status',event=>{trusted(event.sender);return audio.analysisStatus();});
  handleIpc('provider:retention',(event,id)=>{trusted(event.sender);return serviceCall('providerRetention',id);});
  handleIpc('provider:stored-changes',(event,id,cursor)=>{trusted(event.sender);return serviceCall('providerStoredChanges',{providerId:id,cursor});});
  handleIpc('provider:retention-configure',(event,input)=>{trusted(event.sender);if(!input||typeof input!=='object')throw new Error('无效来源保存设置');const {commandId,providerId,revision,mode}=input;return serviceCall('configureProviderRetention',{commandId,providerId,revision,mode});});
  handleIpc('provider:list',event=>{trusted(event.sender);return serviceCall('providers');});
  handleIpc('provider:enabled',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!['musicbrainz','cover-art-archive','acoustid'].includes(id))throw new Error('无效数据源');return serviceCall('providerEnabled',id);});
  handleIpc('provider:configure',(event,input)=>{
    trusted(event.sender);
    if(!input||typeof input!=='object')throw new Error('无效数据源设置');
    const {commandId,providerId,revision,enabled}=input;
    return serviceCall('configureProvider',{commandId,providerId,revision,enabled});
  });
  handleIpc('provider:credential',async(event,input)=>{
    trusted(event.sender);
    if(!input||typeof input!=='object'||!['musicbrainz','cover-art-archive','acoustid'].includes(input.providerId)||typeof input.slot!=='string'||!['set','remove'].includes(input.operation)||typeof input.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.commandId)||input.operation==='set'&&(typeof input.secret!=='string'||Buffer.byteLength(input.secret,'utf8')>2048)||input.operation==='remove'&&input.secret!==undefined)throw new Error('无效凭据请求');
    const request={commandId:input.commandId,providerId:input.providerId,slot:input.slot,operation:input.operation,secret:input.secret};
    try{return await serviceCall('providerCredential',request,60000);}
    finally{request.secret=undefined;input.secret=undefined;}
  });
  handleIpc('provider:terms',async(event,id)=>{
    trusted(event.sender);const url=await serviceCall<string>('providerTerms',id);const parsed=new URL(url);
    if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('无效数据源条款地址');await shell.openExternal(parsed.href);
  });
  handleIpc('library:addFolder',async event => {
    trusted(event.sender);
    const chosen = await dialog.showOpenDialog(window!,{title:'选择音乐目录',properties:['openDirectory']});
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    return serviceCall<{rootId:string}>('addRoot',{folder:chosen.filePaths[0]});
  });
  handleIpc('library:stats',event => { trusted(event.sender); return serviceCall('stats'); });
  handleIpc('catalog:link',(event,request)=>{trusted(event.sender);return serviceCall('linkCatalog',request);});
  handleIpc('catalog:undo',(event,changeId,commandId)=>{trusted(event.sender);return serviceCall('undoCatalog',{changeId,commandId});});
  handleIpc('catalog:changes',(event,limit,offset)=>{trusted(event.sender);return serviceCall('catalogChanges',{limit,offset});});
  handleIpc('genre:list',(event,request)=>{trusted(event.sender);return serviceCall('genres',request??{});});
  handleIpc('genre:detail',(event,genreId)=>{trusted(event.sender);return serviceCall('genre',genreId);});
  handleIpc('genre:edit',(event,request)=>{trusted(event.sender);return serviceCall('editGenre',request);});
  handleIpc('artist:candidates',(event,query,limit,offset)=>{trusted(event.sender);return serviceCall('artistCandidates',{query,limit,offset});});
  handleIpc('artist:edit',(event,request)=>{trusted(event.sender);return serviceCall('editArtists',request);});
  handleIpc('artist:profiles',(event,query,limit,offset)=>{trusted(event.sender);return serviceCall('artistProfiles',{query,limit,offset});});
  handleIpc('artist:profile',(event,artistId,limit,offset)=>{trusted(event.sender);return serviceCall('artistProfile',{artistId,limit,offset});});
  handleIpc('artist:profile-edit',(event,request)=>{trusted(event.sender);return serviceCall('editArtistProfile',request);});
  handleIpc('artist:open-reference',async(event,artist,provider,externalId)=>{
    trusted(event.sender);const url=await serviceCall<string>('artistReferenceUrl',{artist,provider,externalId});
    const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('无效引用链接');
    await shell.openExternal(parsed.href);
  });
  handleIpc('release:candidates',(event,query,limit,offset)=>{trusted(event.sender);return serviceCall('releaseCandidates',{query,limit,offset});});
  handleIpc('release:detail',(event,releaseId,limit,offset)=>{trusted(event.sender);return serviceCall('releaseDetail',{releaseId,limit,offset});});
  handleIpc('release:profile-edit',(event,request)=>{trusted(event.sender);return serviceCall('editReleaseProfile',request);});
  handleIpc('recording:profile',(event,recordingId)=>{trusted(event.sender);return serviceCall('recordingProfile',recordingId);});
  handleIpc('recording:profile-edit',(event,request)=>{trusted(event.sender);return serviceCall('editRecordingProfile',request);});
  handleIpc('entity:references',(event,kind,entityId)=>{trusted(event.sender);return serviceCall('entityReferences',{kind,entityId});});
  handleIpc('entity:reference-edit',(event,request)=>{trusted(event.sender);return serviceCall('editEntityReferences',request);});
  handleIpc('entity:open-reference',async(event,entity,provider,externalId)=>{
    trusted(event.sender);const url=await serviceCall<string>('entityReferenceUrl',{entity,provider,externalId});
    const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password)throw new Error('无效引用链接');await shell.openExternal(parsed.href);
  });
  handleIpc('release:edit',(event,request)=>{trusted(event.sender);return serviceCall('editReleases',request);});
  handleIpc('catalog:versions',(event,itemId,limit,offset)=>{
    trusted(event.sender);
    if(typeof itemId!=='string'||itemId.length>128||limit!==undefined&&(!Number.isInteger(limit)||limit<1||limit>100)||offset!==undefined&&(!Number.isSafeInteger(offset)||offset<0))throw new Error('无效版本查询');
    return serviceCall('versions',{itemId,limit,offset});
  });
  handleIpc('library:rescan',(event,rootId:string,commandId=randomUUID())=>{
    trusted(event.sender);
    if(typeof rootId!=='string'||!rootId||rootId.length>128||typeof commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(commandId))throw new Error('无效目录扫描');
    return serviceCall('rescanRoot',{rootId,commandId});
  });
  handleIpc('scan:jobs',(event,cursor)=>{trusted(event.sender);if(cursor!==undefined&&(typeof cursor!=='string'||!/^\d{1,16}$/.test(cursor)))throw new Error('无效扫描任务分页');return serviceCall('scanJobs',{cursor});});
  handleIpc('scan:job',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效扫描任务');return serviceCall('scanJob',id);});
  handleIpc('scan:issues',(event,jobId,cursor)=>{trusted(event.sender);if(typeof jobId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(jobId)||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor)))throw new Error('无效扫描异常分页');return serviceCall('scanIssues',{jobId,cursor});});
  handleIpc('scan:command',(event,value)=>{
    trusted(event.sender);const r=value as import('../shared/contracts.js').ScanJobCommand;
    if(!r||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId))throw new Error('无效扫描操作');
    if(r.action==='start'){if(typeof r.rootId!=='string'||!r.rootId||r.rootId.length>128)throw new Error('无效扫描目录');return serviceCall('scanCommand',{commandId:r.commandId,action:r.action,rootId:r.rootId});}
    if(!['cancel','resume'].includes(r.action)||typeof r.jobId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.jobId)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0)throw new Error('无效扫描控制');
    return serviceCall('scanCommand',{commandId:r.commandId,action:r.action,jobId:r.jobId,baseRevision:r.baseRevision});
  });
  handleIpc('library:preview',(event,value)=>{filesSender(event);return serviceCall('previewMusicQuery',readMusicPreviewRequest(value));});
  handleIpc('library:preview-check',(event,value)=>{filesSender(event);return serviceCall('checkMusicPreview',readMusicPreviewCheckRequest(value));});
  handleIpc('library:browse',(event,value)=>{filesSender(event);return serviceCall('browseLibrary',readBrowseRequest(value));});
  handleIpc('catalog:browse',(event,value)=>{filesSender(event);return serviceCall('browseCatalog',readCatalogBrowseRequest(value));});
  handleIpc('search:index-state',event=>{filesSender(event);return serviceCall('searchIndexState');});
  handleIpc('library:watch-state',event=>{filesSender(event);return serviceCall('libraryWatchState');});
  handleIpc('library:watch-command',async(event,value)=>{
    filesSender(event);const request=readLibraryWatchRequest(value);
    const receipt=await serviceCall<LibraryWatchResult|null>('libraryWatchReceipt',request);if(receipt)return receipt;
    let confirmed:import('../shared/library-watch.js').WatchAnchor|undefined;
    if(request.action==='confirm'){
      const state=await serviceCall<LibraryWatchState>('libraryWatchState'),root=state.roots.find(r=>r.rootId===request.rootId);
      if(!root||root.revision!==request.revision)return {status:'rejected',state,error:'目录或设置已变化，请重新读取'};
      const picked=await dialog.showOpenDialog(window!,{title:'重新确认音乐目录',defaultPath:root.path,properties:['openDirectory','dontAddToRecent']});
      if(picked.canceled||picked.filePaths.length!==1)return {status:'rejected',state,error:'已取消目录确认'};
      if(normalizedWatchPath(picked.filePaths[0])!==normalizedWatchPath(root.path))return {status:'rejected',state,error:'请选择原音乐根目录；添加其他目录请使用添加音乐目录'};
      confirmed=await probeWatchRoot(picked.filePaths[0]);
      filesSender(event);if(desktop?.isQuitting)throw new Error('应用正在退出');
    }
    return serviceCall('libraryWatchCommand',{request,confirmed},20000);
  });
  handleIpc('search:index-retry',event=>{filesSender(event);return serviceCall('retrySearchIndex');});
  handleIpc('catalog:view',event=>{filesSender(event);return serviceCall('loadCatalogViewPreference');});
  handleIpc('catalog:save-view',(event,value)=>{filesSender(event);return serviceCall('saveCatalogViewPreference',readCatalogViewSave(value));});
  handleIpc('playback:browse',async(event,value)=>{
    filesSender(event);const request=readBrowsePlayRequest(value),token=audio.operationToken();
    const context=await serviceCall<BrowsePlayContext>('browsePlayContext',request);
    if(token!==audio.operationToken()||playback.systemIsSleeping||desktop?.isQuitting)throw new Error('播放请求已取消，请重新操作');
    if(context.itemId!==request.itemId||context.snapshot!==request.snapshot||!Array.isArray(context.ids)||context.ids.length>500||!context.ids.includes(request.itemId)||context.ids.some(id=>typeof id!=='string'||!id||id.length>128))throw new Error('曲库播放范围回执无效');
    pauseRelease?.cancel();return playback.play(context.itemId,context.ids,request.command);
  });
  handleIpc('library:list',(event,request: ListRequest) => {
    trusted(event.sender);
    if (!request || !['all','artists','albums','albumGroups','genres','folders','favorites','recent','playlists'].includes(request.view) ||
      typeof request.query !== 'undefined' && typeof request.query !== 'string'||
      request.value!==undefined&&(typeof request.value!=='string'||request.value.length>256)||
      request.facetId!==undefined&&(typeof request.facetId!=='string'||request.facetId.length>128)||
      request.releaseTrackId!==undefined&&(typeof request.releaseTrackId!=='string'||request.releaseTrackId.length>128)||
      request.collapseVersions!==undefined&&typeof request.collapseVersions!=='boolean') throw new Error('无效查询');
    return serviceCall('list',{...request,query:request.query?.slice(0,256),limit:Math.min(request.limit ?? 50,100)});
  });
  handleIpc('library:facets',(event,view: FacetView,artistRole) => { trusted(event.sender); return serviceCall('facets',{view,artistRole}); });
  handleIpc('library:roots',event => { trusted(event.sender); return serviceCall('roots'); });
  handleIpc('library:lyrics',(event,id: string) => { trusted(event.sender); if(typeof id!=='string'||id.length>128) throw new Error('无效曲目 ID'); return serviceCall('lyrics',id,60000); });
  handleIpc('library:lyrics-bundle',(event,id:string)=>{trusted(event.sender);if(typeof id!=='string'||!id||id.length>128)throw new Error('无效曲目 ID');return serviceCall('lyricsBundle',id,60000);});
  handleIpc('library:lyrics-preference',(event,value)=>{
    trusted(event.sender);const r=value as import('../shared/contracts.js').LyricsPreferenceRequest,p=r?.preference;
    const sourceId=(id:unknown)=>id===null||typeof id==='string'&&/^[0-9a-f]{64}$/.test(id);
    if(!r||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId)||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||typeof r.scope!=='string'||!/^[0-9a-f]{64}$/.test(r.scope)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||!p||![p.primaryId,p.secondaryId,p.offsetSourceId].every(sourceId)||!Number.isSafeInteger(p.offsetMs)||Math.abs(p.offsetMs)>300000||!Number.isSafeInteger(p.secondaryOffsetMs)||Math.abs(p.secondaryOffsetMs)>300000||typeof p.showSecondary!=='boolean'||!Number.isInteger(p.fontSize)||p.fontSize<14||p.fontSize>32||p.sourceOrder!==undefined&&(!Array.isArray(p.sourceOrder)||p.sourceOrder.length>64||p.sourceOrder.some(id=>typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id)))||r.sourceSetFingerprint!==undefined&&(typeof r.sourceSetFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(r.sourceSetFingerprint)))throw new Error('无效歌词显示与优先级设置');
    return serviceCall('saveLyricsPreference',{commandId:r.commandId,itemId:r.itemId,scope:r.scope,baseRevision:r.baseRevision,preference:{primaryId:p.primaryId,secondaryId:p.secondaryId,offsetSourceId:p.offsetSourceId,offsetMs:p.offsetMs,secondaryOffsetMs:p.secondaryOffsetMs,showSecondary:p.showSecondary,fontSize:p.fontSize,...(p.sourceOrder!==undefined?{sourceOrder:[...p.sourceOrder]}:{})},...(r.sourceSetFingerprint!==undefined?{sourceSetFingerprint:r.sourceSetFingerprint}:{})},60000);
  });
  const lyricsInput=(value:unknown):LyricsImportInput=>{
    const r=value as LyricsImportInput;
    if(!r||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||typeof r.scope!=='string'||!/^[0-9a-f]{64}$/.test(r.scope)||typeof r.label!=='string'||r.label.length>128||typeof r.language!=='string'||r.language.length>32||typeof r.rawBase64!=='string'||r.rawBase64.length>1398104||!['auto','utf-8','utf-16le','utf-16be','gb18030'].includes(r.encoding)||!['track-relative','audio-absolute'].includes(r.timeBasis)||r.sourceDocumentId!==undefined&&(typeof r.sourceDocumentId!=='string'||!/^[0-9a-f]{64}$/.test(r.sourceDocumentId)))throw new Error('无效歌词导入请求');
    if(r.sourceLocalVersionId!==undefined&&(typeof r.sourceLocalVersionId!=='string'||!/^[0-9a-f]{64}$/.test(r.sourceLocalVersionId))||r.sourceDocumentId!==undefined&&r.sourceLocalVersionId!==undefined)throw new Error('无效歌词复制来源');
    return {itemId:r.itemId,scope:r.scope,label:r.label,language:r.language,encoding:r.encoding,timeBasis:r.timeBasis,rawBase64:r.rawBase64,...(r.sourceDocumentId!==undefined?{sourceDocumentId:r.sourceDocumentId}:{}),...(r.sourceLocalVersionId!==undefined?{sourceLocalVersionId:r.sourceLocalVersionId}:{})};
  };
  handleIpc('lyrics:pick-file',async event=>{
    trusted(event.sender);if(!window)throw new Error('音乐窗口已关闭');
    const result=await dialog.showOpenDialog(window,{title:'导入歌词',properties:['openFile'],filters:[{name:'歌词文档',extensions:['lrc','txt']}]});
    if(result.canceled||!result.filePaths[0])return null;return readPickedLyrics(result.filePaths[0]);
  });
  handleIpc('lyrics:import-preview',(event,input)=>{trusted(event.sender);return serviceCall('lyricsImportPreview',lyricsInput(input));});
  handleIpc('lyrics:saved',(event,value)=>{
    trusted(event.sender);const r=value as import('../shared/contracts.js').SavedLyricsQuery;
    if(!r||typeof r.query!=='string'||r.query.length>256||!['all','removed','same-item'].includes(r.association)||!['all','active','archived'].includes(r.state)||r.itemId!==undefined&&(typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128)||r.cursor!==undefined&&(typeof r.cursor!=='string'||r.cursor.length>512))throw new Error('无效用户歌词查询');
    return serviceCall('savedLyrics',{query:r.query,association:r.association,state:r.state,...(r.itemId!==undefined?{itemId:r.itemId}:{}),...(r.cursor!==undefined?{cursor:r.cursor}:{})});
  });
  handleIpc('lyrics:saved-document',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id))throw new Error('无效用户歌词版本');return serviceCall('savedLyricsDocument',id);});
  handleIpc('lyrics:local-saved',(event,value)=>{
    trusted(event.sender);const r=value as import('../shared/contracts.js').SavedLocalLyricsQuery;
    if(!r||typeof r.query!=='string'||r.query.length>256||r.query.includes('\0')||!['all','removed','same-item'].includes(r.association)||!['all','timed','plain'].includes(r.kind)||typeof r.lastKnownOnly!=='boolean'||r.itemId!==undefined&&(typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128)||r.association==='same-item'&&!r.itemId||r.cursor!==undefined&&(typeof r.cursor!=='string'||r.cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(r.cursor)))throw new Error('无效本地歌词原文目录查询');
    return serviceCall('savedLocalLyrics',{query:r.query,association:r.association,kind:r.kind,lastKnownOnly:r.lastKnownOnly,...(r.association==='same-item'?{itemId:r.itemId}:{}),...(r.cursor!==undefined?{cursor:r.cursor}:{})});
  });
  handleIpc('lyrics:local-saved-version',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id))throw new Error('无效保存的本地原文版本');return serviceCall('savedLocalLyricsVersion',id);});
  handleIpc('lyrics:saved-changes',(event,documentId,cursor)=>{
    trusted(event.sender);if(typeof documentId!=='string'||!/^[0-9a-f]{64}$/.test(documentId)||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor)))throw new Error('无效用户歌词修订查询');
    return serviceCall('savedLyricsChanges',{documentId,...(cursor!==undefined?{cursor}:{})});
  });
  handleIpc('lyrics:edit-saved',(event,value)=>{
    trusted(event.sender);const r=value as import('../shared/contracts.js').SavedLyricsStateRequest;
    if(!r||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId)||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||typeof r.scope!=='string'||!/^[0-9a-f]{64}$/.test(r.scope)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0||!['archive','restore'].includes(r.action)||typeof r.documentId!=='string'||!/^[0-9a-f]{64}$/.test(r.documentId))throw new Error('无效用户歌词状态操作');
    return serviceCall('editSavedLyrics',{commandId:r.commandId,itemId:r.itemId,scope:r.scope,baseRevision:r.baseRevision,action:r.action,documentId:r.documentId});
  });
  handleIpc('lyrics:documents',(event,itemId,cursor)=>{
    trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>512))throw new Error('无效歌词文档请求');
    return serviceCall('lyricsDocuments',{itemId,cursor});
  });
  handleIpc('lyrics:changes',(event,itemId,cursor)=>{
    trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>512))throw new Error('无效歌词修订请求');
    return serviceCall('lyricsDocumentChanges',{itemId,cursor});
  });
  handleIpc('lyrics:document',(event,itemId,documentId)=>{
    trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||typeof documentId!=='string'||!/^[0-9a-f]{64}$/.test(documentId))throw new Error('无效歌词版本请求');
    return serviceCall('lyricsDocument',{itemId,documentId});
  });
  handleIpc('lyrics:edit-document',(event,value)=>{
    trusted(event.sender);const r=value as import('../shared/contracts.js').LyricsDocumentRequest;
    if(!r||typeof r.itemId!=='string'||!r.itemId||r.itemId.length>128||typeof r.scope!=='string'||!/^[0-9a-f]{64}$/.test(r.scope)||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId)||!Number.isSafeInteger(r.baseRevision)||r.baseRevision<0)throw new Error('无效歌词文档操作');
    const base={commandId:r.commandId,itemId:r.itemId,scope:r.scope,baseRevision:r.baseRevision};
    if(r.action==='import')return serviceCall('editLyricsDocument',{...base,action:r.action,input:lyricsInput(r.input)});
    if(!['archive','restore'].includes(r.action)||typeof r.documentId!=='string'||!/^[0-9a-f]{64}$/.test(r.documentId))throw new Error('无效歌词文档操作');
    return serviceCall('editLyricsDocument',{...base,action:r.action,documentId:r.documentId});
  });
  handleIpc('library:item',async(event,id:unknown)=>{
    trusted(event.sender);
    if(typeof id!=='string'||!id||id.length>128)throw new Error('无效歌曲信息请求');
    return await serviceCall<LibraryItem|undefined>('getItem',id)??null;
  });
  handleIpc('library:artwork',async(event,id: string,refresh?:boolean) => { trusted(event.sender); if(typeof id!=='string'||id.length>128||refresh!==undefined&&typeof refresh!=='boolean') throw new Error('无效封面请求'); return (await artworkCandidate({itemId:id},refresh))?.url??null; });
  handleIpc('library:artwork-candidate',(event,id:string,rejectedTokens?:string[],thumbnailSize:256|1024=1024,refresh=false)=>{
    trusted(event.sender);
    if(typeof id!=='string'||id.length>128||rejectedTokens!==undefined&&(!Array.isArray(rejectedTokens)||rejectedTokens.length>8||rejectedTokens.some(token=>typeof token!=='string'||!/^[0-9a-f]{64}$/.test(token))))throw new Error('无效封面候选请求');
    if(thumbnailSize!==256&&thumbnailSize!==1024||typeof refresh!=='boolean')throw new Error('无效缩略图尺寸或刷新请求');
    return artworkCandidate({itemId:id,rejectedTokens,thumbnailSize},refresh);
  });
  handleIpc('lyrics:local-versions',(event,itemId,cursor)=>{
    trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||cursor!==undefined&&(typeof cursor!=='string'||cursor.length>512||!/^[A-Za-z0-9_-]+$/.test(cursor)))throw new Error('无效本地歌词原文查询');
    return serviceCall('localLyricsVersions',{itemId,...(cursor!==undefined?{cursor}:{})});
  });
  handleIpc('lyrics:local-version',(event,itemId,id)=>{
    trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||typeof id!=='string'||!/^[0-9a-f]{64}$/.test(id))throw new Error('无效本地歌词原文版本');
    return serviceCall('localLyricsVersion',{itemId,id});
  });
  handleIpc('library:artwork-lease',(event,url:string,itemId:string,consumer:string,retain:boolean,owner:string)=>{trusted(event.sender);const frame=window?.webContents.mainFrame;if(!event.senderFrame||!frame||event.senderFrame.routingId!==frame.routingId||event.senderFrame.processId!==frame.processId)throw new Error('封面租约来自过期窗口文档');return artworkResources.lease(url,itemId,consumer,retain,owner);});
  handleIpc('user:state',(event,request:UserStateRequest)=>{trusted(event.sender);return serviceCall('setUserState',request);});
  handleIpc('playback-history:list',(event,request)=>{filesSender(event);return serviceCall('playbackHistory',readHistoryQuery(request));});
  handleIpc('playback-history:status',event=>{filesSender(event);return historyRecorder?.status();});
  handleIpc('playback-history:export-state',event=>{filesSender(event);return historyExporter.snapshot();});
  handleIpc('playback-history:export',(event,request)=>{filesSender(event);return historyExporter.start(request,()=>filesSender(event));});
  handleIpc('playback-history:cancel-export',(event,id)=>{filesSender(event);return historyExporter.cancel(id);});
  handleIpc('playback-history:policy',async event=>{filesSender(event);const value=readPlaybackPolicy(await serviceCall('playbackPolicy'));filesSender(event);return historyRecorder!.configure(value);});
  handleIpc('playback-history:configure-policy',async(event,value)=>{
    filesSender(event);const request=readPlaybackPolicyRequest(value),result=readPlaybackPolicyResult(await serviceCall('configurePlaybackPolicy',request));
    if(result.commandId!==request.commandId||result.status==='saved'&&(!result.value||!matchesPlaybackPolicy(result.value,request)))throw new Error('播放统计设置回执与原请求不符');
    if(result.status==='saved')historyRecorder!.configure(readPlaybackPolicy(await serviceCall('playbackPolicy')));
    return result;
  });
  let ruleFileDialogBusy=false;
  handleIpc('rules:export',async(event,value)=>{
    filesSender(event);if(!window||ruleFileDialogBusy)throw new Error('请先关闭当前规则文件选择窗口');
    const request=readRuleExportRequest(value);ruleFileDialogBusy=true;
    try{const bundle=await serviceCall<RuleBundle>('exportRules',request);filesSender(event);if(!window)throw new Error('音乐窗口已关闭');const result=await dialog.showSaveDialog(window,{title:'导出已保存的音乐规则',defaultPath:'aural-rules.json',filters:[{name:'音乐规则',extensions:['json']}],properties:['showOverwriteConfirmation','createDirectory']});if(result.canceled||!result.filePath)return null;filesSender(event);return await writePickedRules(result.filePath,bundle);}finally{ruleFileDialogBusy=false;}
  });
  handleIpc('rules:pick-file',async event=>{
    filesSender(event);if(!window||ruleFileDialogBusy)throw new Error('请先关闭当前规则文件选择窗口');ruleFileDialogBusy=true;
    try{const result=await dialog.showOpenDialog(window,{title:'选择音乐规则文件',properties:['openFile'],filters:[{name:'音乐规则',extensions:['json']}]});if(result.canceled||!result.filePaths[0])return null;filesSender(event);return await readPickedRules(result.filePaths[0]);}finally{ruleFileDialogBusy=false;}
  });
  handleIpc('rules:inspect',(event,request)=>{filesSender(event);return serviceCall('inspectRuleImport',readRuleInspectionRequest(request));});
  handleIpc('rules:targets',(event,request)=>{filesSender(event);return serviceCall('ruleReferenceTargets',readRuleReferenceQuery(request));});
  handleIpc('rules:import',(event,request)=>{filesSender(event);return serviceCall('importRules',readRuleImportRequest(request),60000);});
  handleIpc('filter-preset:list',(event,request)=>{filesSender(event);return serviceCall('filterPresets',readFilterPresetPageRequest(request));});
  handleIpc('filter-preset:get',(event,id)=>{filesSender(event);return serviceCall('filterPreset',filterPresetId(id));});
  handleIpc('filter-preset:mutate',(event,request)=>{filesSender(event);return serviceCall('mutateFilterPreset',readFilterPresetMutation(request));});
  handleIpc('smart-playlist:history',(event,request)=>{filesSender(event);return serviceCall('smartPlaylistHistory',readSmartHistoryRequest(request));});
  handleIpc('smart-playlist:history-detail',(event,request)=>{filesSender(event);return serviceCall('smartPlaylistHistoryDetail',readSmartHistoryDetailRequest(request));});
  handleIpc('smart-playlist:restore',(event,request)=>{filesSender(event);return serviceCall('restoreSmartPlaylist',readSmartPlaylistRestoreRequest(request));});
  handleIpc('smart-playlist:list',(event,request)=>{filesSender(event);return serviceCall('smartPlaylists',readSmartPlaylistPageRequest(request));});
  handleIpc('smart-playlist:get',(event,id)=>{filesSender(event);return serviceCall('smartPlaylist',smartPlaylistId(id));});
  handleIpc('smart-playlist:mutate',(event,request)=>{filesSender(event);return serviceCall('mutateSmartPlaylist',readSmartPlaylistMutation(request));});
  handleIpc('playlist:list',event=>{trusted(event.sender);return serviceCall('playlists');});
  handleIpc('playlist:create',(event,name:string,commandId:string,itemIds?:string[])=>{trusted(event.sender);return serviceCall('createPlaylist',{name,commandId,itemIds});});
  handleIpc('playlist:edit',(event,request:PlaylistEditRequest)=>{trusted(event.sender);return serviceCall('editPlaylist',request);});
  handleIpc('playlist:play',async(event,playlistId:string,entryId:string,revision:number,command:QueueCommand)=>{
    trusted(event.sender);const checked=checkedQueueCommand(command);
    if(typeof playlistId!=='string'||playlistId.length>128||typeof entryId!=='string'||entryId.length>128||!Number.isSafeInteger(revision)||revision<0)throw new Error('无效歌单播放请求');
    return playback.playPlaylist({playlistId,entryId,revision},checked);
  });
  handleIpc('metadata:contact',event => { trusted(event.sender); return serviceCall('metadataContact'); });
  handleIpc('metadata:review-state',(event,itemId)=>{trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||itemId.includes('\0'))throw new Error('无效审核曲目');return serviceCall('metadataReviewState',itemId);});
  handleIpc('metadata:sources',(event,itemId)=>{trusted(event.sender);return serviceCall('metadataSources',itemId);});
  handleIpc('tag-write:job',(event,jobId)=>{trusted(event.sender);return serviceCall('tagWriteJob',jobId);});
  handleIpc('tag-backup:cleanup-command',(event,request)=>{trusted(event.sender);return serviceCall('tagBackupCleanupCommand',request,60000);});
  handleIpc('tag-backup:cleanup-get',(event,id)=>{trusted(event.sender);return serviceCall('tagBackupCleanupGet',id);});
  handleIpc('tag-backup:cleanup-list',(event,cursor)=>{trusted(event.sender);return serviceCall('tagBackupCleanupList',cursor);});
  handleIpc('tag-backup:schedule',event=>{trusted(event.sender);return serviceCall('tagBackupSchedule');});
  handleIpc('tag-backup:schedule-configure',(event,request)=>{trusted(event.sender);return serviceCall('tagBackupScheduleConfigure',request);});
  handleIpc('tag-backup:batch-preview',(event,id)=>{trusted(event.sender);return serviceCall('tagBackupBatchPreview',id,60000);});
  handleIpc('tag-backup:batch-command',(event,request)=>{trusted(event.sender);return serviceCall('tagBackupBatchCommand',request,60000);});
  handleIpc('tag-backup:batch-list',(event,cursor)=>{trusted(event.sender);return serviceCall('tagBackupBatchList',cursor);});
  handleIpc('tag-backup:batch-items',(event,request)=>{trusted(event.sender);return serviceCall('tagBackupBatchItems',request);});
  handleIpc('media:capabilities',event=>{trusted(event.sender);return mediaCapabilityRegistry.current();});
  handleIpc('tag-backup:policy',event=>{trusted(event.sender);return serviceCall('tagBackupPolicy');});
  handleIpc('tag-backup:policy-configure',(event,request)=>{trusted(event.sender);return serviceCall('tagBackupPolicyConfigure',request);});
  handleIpc('tag-backup:storage',(event,request)=>{trusted(event.sender);return serviceCall('tagBackupStorage',request,60000);});
  handleIpc('tag-review-draft:create',(event,request)=>{trusted(event.sender);return serviceCall('tagReviewDraftCreate',request);});
  handleIpc('tag-review-draft:command',(event,request)=>{trusted(event.sender);return serviceCall('tagReviewDraftCommand',request);});
  handleIpc('tag-review-draft:page',(event,id)=>{trusted(event.sender);return serviceCall('tagReviewDraftPage',id);});
  handleIpc('tag-review-draft:list',(event,cursor)=>{trusted(event.sender);return serviceCall('tagReviewDraftList',cursor);});
  handleIpc('tag-review-draft:saved-jobs',(event,id)=>{trusted(event.sender);return serviceCall('tagReviewDraftSavedJobs',id);});
  handleIpc('tag-review-draft:preview',(event,request)=>{trusted(event.sender);return serviceCall('tagReviewDraftPreview',request,60000);});
  handleIpc('tag-review-draft:preview-cancel',(event,requestId)=>{trusted(event.sender);return serviceCall('tagReviewDraftPreviewCancel',requestId);});
  handleIpc('tag-review-draft:save',(event,request)=>{trusted(event.sender);return serviceCall('tagReviewDraftSave',request,60000);});
  handleIpc('tag-review-draft:resolve',(event,commandId)=>{trusted(event.sender);return serviceCall('tagReviewDraftResolve',commandId);});
  handleIpc('tag-commit-batch:create',async(event,request)=>{trusted(event.sender);const result=await serviceCall('tagCommitBatchCreate',request);tagStageBatches.poke();return result;});
  handleIpc('tag-commit-batch:command',async(event,request)=>{trusted(event.sender);const result=await serviceCall('tagCommitBatchCommand',request);tagStageBatches.poke();return result;});
  handleIpc('tag-commit-batch:list',(event,cursor)=>{trusted(event.sender);return serviceCall('tagCommitBatchList',cursor);});
  handleIpc('tag-commit-batch:items',(event,request)=>{trusted(event.sender);return serviceCall('tagCommitBatchItems',request);});
  handleIpc('tag-stage-batch:create',async(event,request)=>{trusted(event.sender);const result=await serviceCall('tagStageBatchCreate',request);tagStageBatches.poke();return result;});
  handleIpc('tag-stage-batch:command',async(event,request)=>{trusted(event.sender);const result=await serviceCall('tagStageBatchCommand',request);tagStageBatches.poke();return result;});
  handleIpc('tag-stage-batch:list',(event,cursor)=>{trusted(event.sender);return serviceCall('tagStageBatchList',cursor);});
  handleIpc('tag-stage-batch:items',(event,request)=>{trusted(event.sender);return serviceCall('tagStageBatchItems',request);});
  handleIpc('tag-write:context',(event,itemId)=>{trusted(event.sender);return serviceCall('tagWriteContext',itemId);});
  handleIpc('tag-write:preview',(event,request)=>{trusted(event.sender);return serviceCall('tagWritePreview',request,60000);});
  handleIpc('tag-write:preview-cancel',(event,requestId)=>{trusted(event.sender);return serviceCall('tagWritePreviewCancel',requestId);});
  handleIpc('tag-write:prepare',(event,request)=>{trusted(event.sender);return serviceCall('tagWritePrepare',request,60000);});
  handleIpc('tag-write:jobs',(event,cursor)=>{trusted(event.sender);return serviceCall('tagWriteJobs',cursor);});
  handleIpc('tag-write:cancel',(event,request)=>{trusted(event.sender);return serviceCall('tagWriteCancel',request);});
  handleIpc('tag-write:stage',async(event,value)=>{trusted(event.sender);const request=readTagWriteCancelRequest(value),known=await serviceCall('tagWriteStageReceipt',request);if(known)return known;const target=await serviceCall<{fileId:string;observation:string}>('tagWriteStageTarget',request,60000);return playback.stageLibraryFile(target.fileId,target.observation,()=>serviceCall('tagWriteStage',request,60000));});
  handleIpc('tag-write:stage-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagWriteStageCancel',readTagWriteCancelRequest(value));});
  handleIpc('tag-write:inspect',(event,value)=>{trusted(event.sender);return serviceCall('tagWriteInspect',readTagWriteCancelRequest(value));});
  handleIpc('tag-write:inspect-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagWriteInspectCancel',value);});
  handleIpc('tag-write:restore-reprobe',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreReprobe',value);});
  handleIpc('tag-write:restore-reprobe-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreReprobeCancel',value);});
  handleIpc('tag-write:restore-inspect',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreInspect',readTagWriteCancelRequest(value));});
  handleIpc('tag-write:restore-inspect-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreInspectCancel',value);});
  handleIpc('tag-write:restore-retry',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreRetry',readTagRestoreStart(value),60000);});
  handleIpc('tag-write:restore-start',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreStart',readTagRestoreStart(value),60000);});
  handleIpc('tag-write:commit-start',async(event,value)=>{trusted(event.sender);const request=readTagCommitStart(value),known=await serviceCall('tagCommitStartReceipt',request);if(known)return known;const target=await serviceCall<{fileId:string;observation:string}>('tagCommitTarget',request,60000);return playback.stageLibraryFile(target.fileId,target.observation,()=>serviceCall('tagCommitStart',request,60000));});
  handleIpc('tag-write:commit-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagCommitCancel',readTagCommitCancel(value));});
  handleIpc('tag-write:restore-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagRestoreCancel',readTagRestoreCancel(value));});
  handleIpc('tag-write:commit-inspect',(event,value)=>{trusted(event.sender);return serviceCall('tagCommitInspect',readTagWriteCancelRequest(value));});
  handleIpc('tag-write:commit-inspect-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagCommitInspectCancel',value);});
  handleIpc('tag-write:commit-reprobe',(event,value)=>{trusted(event.sender);return serviceCall('tagCommitReprobe',value);});
  handleIpc('tag-write:commit-reprobe-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagCommitReprobeCancel',value);});
  handleIpc('tag-write:recover',(event,value)=>{trusted(event.sender);return serviceCall('tagWriteRecover',value);});
  handleIpc('tag-write:recover-cancel',(event,value)=>{trusted(event.sender);return serviceCall('tagWriteRecoverCancel',value);});
  handleIpc('metadata:source',(event,kind,entityId)=>{trusted(event.sender);return serviceCall('metadataSource',{kind,entityId});});
  handleIpc('metadata:locks',(event,request)=>{trusted(event.sender);return serviceCall('editMetadataLocks',request);});
  handleIpc('metadata:history',(event,kind,entityId,field,cursor)=>{trusted(event.sender);return serviceCall('metadataHistory',{kind,entityId,field,cursor});});
  handleIpc('metadata:select',(event,request)=>{trusted(event.sender);return serviceCall('selectMetadataSources',request);});
  handleIpc('metadata:collection',(event,kind,entityId,field,cursor)=>{trusted(event.sender);return serviceCall('metadataCollection',{kind,entityId,field,cursor});});
  handleIpc('metadata:collection-edit',(event,request)=>{trusted(event.sender);return serviceCall('editMetadataCollection',request);});
  handleIpc('metadata:setContact',(event,contact:string) => {
    trusted(event.sender);
    if(typeof contact!=='string'||contact.length>160) throw new Error('无效联系信息');
    return serviceCall('setMetadataContact',contact);
  });
  handleIpc('metadata:network',event=>{trusted(event.sender);return serviceCall('metadataNetworkState');});
  handleIpc('metadata:network-enabled',(event,enabled)=>{trusted(event.sender);if(typeof enabled!=='boolean')throw new Error('无效在线查询设置');return serviceCall('setMetadataNetworkEnabled',enabled);});
  handleIpc('metadata:cache-clear',event=>{trusted(event.sender);return serviceCall('clearMetadataNetworkCache');});
  handleIpc('metadata:cancel',(event,requestId)=>{trusted(event.sender);if(typeof requestId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId))throw new Error('无效在线查询 ID');return serviceCall('cancelMetadataMatch',requestId);});
  handleIpc('metadata:fingerprint-find',(event,request)=>{trusted(event.sender);return serviceCall('fingerprintFind',readFingerprintFind(request),1000000);});
  handleIpc('metadata:fingerprint-choose',(event,request)=>{trusted(event.sender);return serviceCall('fingerprintChoose',readFingerprintChoice(request),60000);});
  handleIpc('metadata:fingerprint-close',(event,token)=>{trusted(event.sender);return serviceCall('fingerprintClose',readFingerprintToken(token));});
  handleIpc('metadata:recognition-issues',(event,request)=>{trusted(event.sender);return serviceCall('metadataRecognitionIssues',readRecognitionIssueRequest(request));});
  handleIpc('metadata:recognition-details',(event,id)=>{trusted(event.sender);return serviceCall('metadataRecognitionDetails',workflowId(id));});
  handleIpc('metadata:recognition-command',(event,request)=>{trusted(event.sender);return serviceCall('metadataRecognitionCommand',readRecognitionCommand(request));});
  handleIpc('metadata:recognition-receipt',(event,request)=>{trusted(event.sender);return serviceCall('metadataRecognitionReceipt',readRecognitionCommand(request));});
  handleIpc('metadata:recognition-open',(event,id)=>{trusted(event.sender);return serviceCall('metadataRecognitionOpen',workflowId(id));});
  handleIpc('metadata:recognition-result',(event,request)=>{trusted(event.sender);return serviceCall('metadataRecognitionResult',readRecognitionResultRequest(request));});
  handleIpc('metadata:workflow',(event,id)=>{trusted(event.sender);return serviceCall('metadataWorkflow',workflowId(id));});
  handleIpc('metadata:workflow-receipt',(event,request)=>{trusted(event.sender);return serviceCall('metadataWorkflowReceipt',readMetadataWorkflowCommand(request));});
  handleIpc('metadata:workflows',(event,request)=>{trusted(event.sender);return serviceCall('metadataWorkflows',request);});
  handleIpc('metadata:workflow-command',(event,request)=>{trusted(event.sender);return serviceCall('metadataWorkflowCommand',readMetadataWorkflowCommand(request),60000);});
  handleIpc('metadata:workflow-issues',(event,request)=>{trusted(event.sender);return serviceCall('metadataWorkflowIssues',{jobId:workflowId(request?.jobId),after:request?.after});});
  handleIpc('metadata:batch-review-start',(event,ids)=>{trusted(event.sender);return serviceCall('metadataBatchReviewStart',Array.isArray(ids)?readBatchReviewItems(ids):readWorkflowReview(ids));});
  handleIpc('metadata:batch-review-status',(event,token)=>{trusted(event.sender);return serviceCall('metadataBatchReviewStatus',readBatchReviewToken(token));});
  handleIpc('metadata:batch-review-close',(event,token)=>{trusted(event.sender);return serviceCall('metadataBatchReviewClose',readBatchReviewToken(token));});
  handleIpc('metadata:match',(event,id:string,requestId=randomUUID(),fresh=false,recordingId?:string,isrc?:string,reviewToken?:string)=>{
    trusted(event.sender);if(typeof id!=='string'||!id||id.length>128||typeof requestId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)||typeof fresh!=='boolean')throw new Error('无效在线查询');
    return serviceCall('metadataMatch',readMetadataMatchRequest({itemId:id,requestId,fresh,...(recordingId===undefined?{}:{recordingId}),...(isrc===undefined?{}:{isrc}),...(reviewToken===undefined?{}:{reviewToken})}),50000);
  });
  handleIpc('metadata:album-credits-preview',(event,raw)=>{trusted(event.sender);return serviceCall('metadataAlbumCreditsPreview',readMetadataAlbumCreditsPreview(raw));});
  handleIpc('metadata:album-credits-apply',(event,raw)=>{trusted(event.sender);return serviceCall('metadataAlbumCreditsApply',readMetadataAlbumCreditsApply(raw));});
  handleIpc('metadata:album-credit-undo-preview',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效署名修订');return serviceCall('metadataAlbumCreditUndoPreview',id);});
  handleIpc('metadata:identity-preview',(event,raw)=>{trusted(event.sender);return serviceCall('metadataIdentityPreview',readMetadataIdentityPreview(raw));});
  handleIpc('metadata:identity-apply',(event,raw)=>{trusted(event.sender);return serviceCall('metadataIdentityApply',readMetadataIdentityApply(raw));});
  handleIpc('metadata:group-link-preview',(event,raw)=>{trusted(event.sender);return serviceCall('metadataGroupLinkPreview',readMetadataGroupLinkPreview(raw));});
  handleIpc('metadata:group-link-apply',(event,raw)=>{trusted(event.sender);return serviceCall('metadataGroupLinkApply',readMetadataGroupLinkApply(raw));});
  handleIpc('metadata:group-link-undo-preview',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效概念关联修订');return serviceCall('metadataGroupLinkUndoPreview',id);});
  handleIpc('metadata:identity-undo-preview',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效身份修订');return serviceCall('metadataIdentityUndoPreview',id);});
  handleIpc('metadata:album-page',(event,raw)=>{trusted(event.sender);return serviceCall('metadataAlbumPage',readMetadataAlbumPage(raw));});
  handleIpc('metadata:album-tracks',(event,raw)=>{trusted(event.sender);return serviceCall('metadataAlbumTracks',readMetadataAlbumTracks(raw));});
  handleIpc('metadata:album-batch-create',(event,raw)=>{trusted(event.sender);return serviceCall('metadataAlbumBatchCreate',readMetadataAlbumBatch(raw));});
  handleIpc('metadata:release-fields-apply',(event,raw)=>{trusted(event.sender);return serviceCall('releaseFieldsApply',readReleaseFieldsApply(raw));});
  handleIpc('metadata:release-fields-undo-preview',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))throw new Error('无效发行修订');return serviceCall('releaseFieldsUndoPreview',id);});
  handleIpc('metadata:release-fields-undo-apply',(event,raw)=>{trusted(event.sender);return serviceCall('releaseFieldsUndoApply',readReleaseFieldsUndo(raw));});
  handleIpc('metadata:release-context',(event,raw)=>{trusted(event.sender);return serviceCall('metadataReleaseContext',readMetadataReleaseContextRequest(raw),50000);});
  handleIpc('metadata:editions',(event,raw)=>{trusted(event.sender);return serviceCall('metadataEditions',readMetadataEditionsRequest(raw),50000);});
  handleIpc('metadata:apply',(event,request:MetadataApplyRequest) => {
    trusted(event.sender);
    if(!request||typeof request.itemId!=='string'||request.itemId.length>128||
      typeof request.token!=='string'||request.token.length>128||!Number.isSafeInteger(request.revision)||
      !Array.isArray(request.fields)||request.fields.length>3) throw new Error('无效元数据变更');
    return serviceCall('metadataApply',request);
  });
  handleIpc('metadata:credit-preview',(event,itemId,token,requestId,fresh=false)=>{
    trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128||typeof token!=='string'||token.length>128||typeof requestId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)||typeof fresh!=='boolean')throw new Error('无效在线署名查询');return serviceCall('metadataCreditPreview',{itemId,token,requestId,fresh},50000);
  });
  handleIpc('metadata:credit-apply',(event,request)=>{trusted(event.sender);if(!request||!Array.isArray(request.entries)||request.entries.length>64)throw new Error('无效署名审核');return serviceCall('metadataCreditApply',request);});
  handleIpc('metadata:cover-art-index',(event,request)=>{
    trusted(event.sender);if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128||typeof request.token!=='string'||request.token.length>128||typeof request.requestId!=='string'||request.requestId.length>128||typeof request.fingerprint!=='string'||request.fingerprint.length!==64||request.fresh!==undefined&&typeof request.fresh!=='boolean')throw new Error('无效封面来源查询');
    return serviceCall('coverArtSourceIndex',request,50000);
  });
  handleIpc('metadata:cover-art-preview',async(event,request)=>{
    trusted(event.sender);if(!request||typeof request.itemId!=='string'||!request.itemId||request.itemId.length>128||typeof request.token!=='string'||request.token.length>128||typeof request.requestId!=='string'||request.requestId.length>128||typeof request.fingerprint!=='string'||request.fingerprint.length!==64||typeof request.imageId!=='string'||!/^[1-9][0-9]{0,19}$/.test(request.imageId)||request.fresh!==undefined&&typeof request.fresh!=='boolean')throw new Error('无效封面图片预览');
    const owner=artworkResources.capturePreviewOwner(),preview=await serviceCall('coverArtImagePreview',request,90000) as import('../shared/contracts.js').CoverArtImagePreview;
    return artworkResources.registerPreview(preview,owner);
  });
  handleIpc('metadata:cover-art-preview-release',(event,url)=>{trusted(event.sender);if(typeof url!=='string'||url.length>128)throw new Error('无效在线图片预览地址');artworkResources.releasePreview(url);});
  handleIpc('metadata:online-artwork',(event,itemId)=>{trusted(event.sender);if(typeof itemId!=='string'||!itemId||itemId.length>128)throw new Error('无效封面曲目');return serviceCall('onlineArtwork',itemId);});
  handleIpc('metadata:online-artwork-command',async(event,raw)=>{
    trusted(event.sender);const request=readOnlineArtworkCommand(raw);
    const prior=await serviceCall('onlineArtworkReceipt',request);if(prior)return prior;
    const image=request.action==='apply'?artworkResources.previewForSave(request.previewUrl,request.itemId):undefined;
    return serviceCall('onlineArtworkCommand',{request,image});
  });
  handleIpc('metadata:batch-recheck',(event,request)=>{trusted(event.sender);return serviceCall('metadataBatchRecheck',readMetadataBatchOrigin(request));});
  handleIpc('metadata:batch-create',(event,request)=>{trusted(event.sender);if(!request||!Array.isArray(request.entries)||request.entries.length<1||request.entries.length>100)throw new Error('无效审核批次');return serviceCall('metadataBatchCreate',request);});
  handleIpc('metadata:batch',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||id.length>128)throw new Error('无效审核批次');return serviceCall('metadataBatch',id);});
  handleIpc('metadata:batches',(event,cursor)=>{trusted(event.sender);if(cursor!==undefined&&(typeof cursor!=='string'||cursor.length>1024))throw new Error('无效批次分页');return serviceCall('metadataBatches',{cursor});});
  handleIpc('metadata:batch-command',(event,request)=>{trusted(event.sender);if(!request||typeof request.batchId!=='string'||request.batchId.length>128||typeof request.commandId!=='string'||!['step','pause','cancel','undo'].includes(request.action))throw new Error('无效批次操作');return serviceCall('metadataBatchCommand',request);});
  handleIpc('metadata:undo-preview',(event,id)=>{trusted(event.sender);if(typeof id!=='string'||id.length>128)throw new Error('无效元数据修订');return serviceCall('metadataUndoPreview',id);});
  handleIpc('metadata:undo-apply',(event,request)=>{trusted(event.sender);if(!request||!Array.isArray(request.fields)||request.fields.length>3)throw new Error('无效字段撤销');return serviceCall('metadataUndoApply',request);});
  handleIpc('metadata:undo',(event,changeId:string) => {
    trusted(event.sender);
    if(typeof changeId!=='string'||changeId.length>128) throw new Error('无效修订 ID');
    return serviceCall('metadataUndo',changeId);
  });
  handleIpc('metadata:openSource',async (event,url:string) => {
    trusted(event.sender);
    if(typeof url!=='string'||!/^https:\/\/musicbrainz\.org\/(?:(?:recording|release-group|track)\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|release\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?:\/cover-art)?)$/i.test(url)) throw new Error('无效来源地址');
    await shell.openExternal(url);
  });
  handleIpc('playback:play',async (event,id: string,contextIds: string[]|undefined,command:QueueCommand) => {
    trusted(event.sender);
    if (typeof id !== 'string' || id.length > 128) throw new Error('无效曲目 ID');
    return playback.play(id,contextIds,checkedQueueCommand(command));
  });
  handleIpc('playback:pause',event => { trusted(event.sender);pauseRelease?.cancel();return playback.toggle(); });
  handleIpc('playback:seek',(event,positionSeconds:number,expectedItemId?:string) => { trusted(event.sender);if(expectedItemId!==undefined&&(typeof expectedItemId!=='string'||expectedItemId.length>128))throw new Error('无效跳转曲目');pauseRelease?.cancel();return audio.seek(positionSeconds,expectedItemId); });
  handleIpc('playback:setOutput',async(event,mode: 'shared'|'exclusive'|'exclusive-convert') => { trusted(event.sender); if(mode!=='shared'&&mode!=='exclusive'&&mode!=='exclusive-convert') throw new Error('无效输出模式');const p=audioOutput.snapshot().preference,result=await audioOutput.configure({commandId:randomUUID(),baseRevision:p.revision,deviceId:p.deviceId,mode,dsdPolicy:p.dsdPolicy,processing:{...p.processing}});if(result.status!=='saved')throw new Error(result.error);return {mode:result.preference.mode}; });
  handleIpc('playback:setDsdPolicy',async(event,policy:'stop'|'pcm')=>{trusted(event.sender);if(policy!=='stop'&&policy!=='pcm')throw new Error('无效 DSD 播放策略');const p=audioOutput.snapshot().preference,result=await audioOutput.configure({commandId:randomUUID(),baseRevision:p.revision,deviceId:p.deviceId,mode:p.mode,dsdPolicy:policy,processing:{...p.processing}});if(result.status!=='saved')throw new Error(result.error);return {policy:result.preference.dsdPolicy};});
  handleIpc('playback:dsdPolicy',event=>{trusted(event.sender);return audio.dsdPolicySnapshot();});
  handleIpc('playback:stop',event => { trusted(event.sender); return playback.stop(); });
  handleIpc('embedded-cue:item',(event,itemId:unknown)=>{filesSender(event);if(typeof itemId!=='string'||!itemId||itemId.length>128)throw new Error('无效内嵌 CUE 曲目');return serviceCall('embeddedCueForItem',itemId);});
  handleIpc('embedded-cue:source',(event,id:unknown)=>{filesSender(event);return serviceCall('embeddedCueSource',cueId(id));});
  handleIpc('embedded-cue:files',(event,value:unknown)=>{filesSender(event);return serviceCall('embeddedCueSources',value);});
  handleIpc('embedded-cue:versions',(event,value:unknown)=>{filesSender(event);const r=value as {fileId:string;cursor?:string};return serviceCall('embeddedCueVersions',{fileId:cueId(r?.fileId),...(r?.cursor!==undefined?{cursor:r.cursor}:{})});});
  handleIpc('embedded-cue:preview',(event,value:unknown)=>{filesSender(event);return serviceCall('embeddedCuePreview',readEmbeddedCueRequest(value));});
  let cueSourceFileBusy=false;
  let pickedCueBundle:{epoch:number;archiveSha256:string;bundle:import('../shared/cue-source-export.js').CueSourceBundle}|null=null;
  handleIpc('cue-source:origins',async(event,value:unknown)=>{filesSender(event);return serviceCall('cueSourceOrigins',readCueSourceOriginsRequest(value));});
  handleIpc('cue-source:inspect-origin',async(event,value:unknown)=>{
    filesSender(event);if(cueSourceFileBusy)throw new Error('请先完成当前CUE文件操作');const request=readCueSourceOriginRequest(value),epoch=documentEpoch;cueSourceFileBusy=true;
    try{
      const result=await serviceCall<{inspection:CueBundleInspection;bundle:import('../shared/cue-source-export.js').CueSourceBundle;archiveSha256:string}>('inspectCueOrigin',request);filesSender(event);if(epoch!==documentEpoch)throw new Error('原CUE备份所属界面已变化');
      if(result.inspection.archiveSha256!==result.archiveSha256||result.inspection.versionId!==result.bundle.versionId||result.inspection.sourceHash!==result.bundle.sourceHash)throw new Error('原CUE备份核对结果与保存内容不一致');
      pickedCueBundle={epoch,archiveSha256:result.archiveSha256,bundle:result.bundle};return result.inspection;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:export-origin',async(event,value:unknown)=>{
    filesSender(event);if(!window||cueSourceFileBusy)throw new Error('请先完成当前CUE文件操作');const request=readCueSourceOriginRequest(value),epoch=documentEpoch;cueSourceFileBusy=true;
    const currentFrame=()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('原CUE备份导出所属界面已变化');};
    try{
      const data=await serviceCall<CueSourceExportData>('exportCueOrigin',request);currentFrame();if(!window||data.fileId!==request.fileId||data.versionId!==request.versionId||data.kind!=='bundle')throw new Error('原CUE备份导出与所选来源版本不一致');
      const picked=await dialog.showSaveDialog(window,{title:'重新导出保存的原CUE来源备份',defaultPath:'Aural-original-cue-'+data.sha256.slice(0,12)+'.json',filters:[{name:'原CUE来源备份',extensions:['json']}]});currentFrame();if(picked.canceled||!picked.filePath)return null;
      return await exportPickedCueSource(path.resolve(picked.filePath),data,path.resolve(app.getPath('userData')),currentFrame);
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:review-version',async(event,value:unknown)=>{
    filesSender(event);if(cueSourceFileBusy)throw new Error('请先完成当前 CUE 文件操作');const request=readCueVersionReviewRequest(value),epoch=documentEpoch;cueSourceFileBusy=true;
    try{
      const result=await serviceCall<CueVersionReview>('reviewCueVersion',request);filesSender(event);if(epoch!==documentEpoch)throw new Error('CUE 历史复审所属界面已变化');
      if(JSON.stringify(result.request)!==JSON.stringify(request)||result.offset!==request.offset)throw new Error('CUE 历史复审结果与所选版本不一致');return result;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('embedded-cue:pick-bundle',async event=>{
    filesSender(event);if(!window||cueSourceFileBusy)throw new Error('请先完成当前 CUE 文件操作');cueSourceFileBusy=true;
    const epoch=documentEpoch,guard=()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('内嵌 CUE 来源备份所属界面已变化');};
    try{
      const picked=await dialog.showOpenDialog(window,{title:'打开内嵌 CUE 来源备份',properties:['openFile'],filters:[{name:'内嵌 CUE 来源备份',extensions:['json']}]});if(picked.canceled||picked.filePaths.length!==1)return null;guard();
      const archive=await readPickedEmbeddedCueBundle(picked.filePaths[0],guard),inspection=await serviceCall<EmbeddedCueBundleInspection>('inspectEmbeddedCueBundle',archive);guard();
      if(inspection.archiveSha256!==archive.archiveSha256||inspection.versionId!==archive.bundle.versionId||inspection.fileId!==archive.bundle.source.fileId||inspection.rootId!==archive.bundle.source.rootId||inspection.binaryHash!==(archive.bundle.source.binary?.sourceHash??null)||inspection.textHash!==(archive.bundle.source.text?.sourceHash??null))throw new Error('内嵌 CUE 来源备份预览与原文件不一致');return inspection;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('embedded-cue:export',async(event,value:unknown)=>{
    filesSender(event);if(!window||cueSourceFileBusy)throw new Error('请先完成当前内嵌 CUE 导出');const request=readEmbeddedCueExportRequest(value);cueSourceFileBusy=true;
    try{
      const data=await serviceCall<EmbeddedCueExportData>('embeddedCueExport',request);filesSender(event);if(!window)throw new Error('音乐窗口已关闭');if(data.versionId!==request.versionId||data.kind!==request.kind)throw new Error('内嵌 CUE 导出版本已改变');
      const extension=embeddedCueExtension(request.kind),picked=await dialog.showSaveDialog(window,{title:'导出保存的内嵌 CUE 来源',defaultPath:'Aural-embedded-cue-'+request.versionId.slice(0,12)+'.'+extension,filters:[{name:'内嵌 CUE 来源',extensions:[extension]}]});
      if(picked.canceled||!picked.filePath)return null;filesSender(event);const output=path.resolve(picked.filePath),dataRoot=path.resolve(app.getPath('userData')),relative=path.relative(dataRoot,output);if(!relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative))throw new Error('请选择应用数据目录之外的保存位置');
      return await exportPickedEmbeddedCue(output,data,dataRoot,()=>filesSender(event));
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:item',async(event,itemId:unknown)=>{filesSender(event);if(typeof itemId!=='string'||!itemId||itemId.length>128)throw new Error('无效 CUE 曲目');return serviceCall('cueSourceForItem',itemId);});
  handleIpc('cue-source:source',async(event,fileId:unknown)=>{filesSender(event);return serviceCall('cueSource',cueId(fileId));});
  handleIpc('cue-source:files',async(event,value:unknown)=>{filesSender(event);return serviceCall('cueSources',value);});
  handleIpc('cue-source:versions',async(event,value:unknown)=>{filesSender(event);const r=value as {fileId:string;cursor?:string};return serviceCall('cueSourceVersions',{fileId:cueId(r?.fileId),...(r?.cursor!==undefined?{cursor:r.cursor}:{})});});
  handleIpc('cue-source:preview',async(event,value:unknown)=>{filesSender(event);const r=value as {fileId:string;versionId:string;encoding:unknown};return serviceCall('cueSourcePreview',{fileId:cueId(r?.fileId),versionId:cueHash(r?.versionId),encoding:readCueEncoding(r?.encoding)});});
  handleIpc('cue-source:export',async(event,value:unknown)=>{
    filesSender(event);if(!window||cueSourceFileBusy)throw new Error('请先完成当前 CUE 文件操作');const request=readCueSourceExportRequest(value);cueSourceFileBusy=true;
    try{
      const data=await serviceCall<CueSourceExportData>('cueSourceExport',request);filesSender(event);if(!window)throw new Error('音乐窗口已关闭');if(data.fileId!==request.fileId||data.versionId!==request.versionId||data.kind!==request.kind)throw new Error('CUE 原文导出版本不一致');
      const extension=request.kind==='raw'?'cue':'json',picked=await dialog.showSaveDialog(window,{title:request.kind==='raw'?'导出保存的 CUE 原文':'导出 CUE 来源备份',defaultPath:'Aural-cue-source-'+request.versionId.slice(0,12)+'.'+extension,filters:[{name:request.kind==='raw'?'CUE 原始文件':'CUE 来源备份',extensions:[extension]}]});
      if(picked.canceled||!picked.filePath)return null;filesSender(event);return await exportPickedCueSource(path.resolve(picked.filePath),data,path.resolve(app.getPath('userData')),()=>filesSender(event));
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:pick-bundle',async event=>{
    filesSender(event);if(!window||cueSourceFileBusy)throw new Error('请先完成当前CUE文件操作');const epoch=documentEpoch;cueSourceFileBusy=true;
    const currentFrame=()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('CUE来源备份所属界面已变化');};
    try{
      const picked=await dialog.showOpenDialog(window,{title:'打开 CUE 来源备份',properties:['openFile'],filters:[{name:'CUE 来源备份',extensions:['json']}]});currentFrame();if(picked.canceled||picked.filePaths.length!==1)return null;
      const archive=await readPickedCueSourceBundle(picked.filePaths[0],currentFrame),inspection=await serviceCall<CueBundleInspection>('inspectCueSourceBundle',archive);currentFrame();
      if(inspection.archiveSha256!==archive.archiveSha256||inspection.versionId!==archive.bundle.versionId||inspection.sourceHash!==archive.bundle.sourceHash)throw new Error('CUE来源备份预览与原文件不一致');
      pickedCueBundle={epoch,archiveSha256:archive.archiveSha256,bundle:archive.bundle};return inspection;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:import',async(event,value:unknown)=>{
    filesSender(event);if(cueSourceFileBusy)throw new Error('请先完成当前CUE文件操作');const request=readCueSourceImportRequest(value),epoch=documentEpoch;cueSourceFileBusy=true;
    const currentFrame=()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('CUE来源导入所属界面已变化');};
    try{
      const old=await serviceCall<CueSourceImportResult|null>('cueSourceImportReceipt',request);currentFrame();if(old)return old;
      const picked=pickedCueBundle;if(!picked||picked.epoch!==epoch||picked.archiveSha256!==request.archiveSha256)throw new Error('请重新打开并核对所选CUE来源备份');
      const result=await serviceCall<CueSourceImportResult>('importCueSource',{request,bundle:picked.bundle});currentFrame();return result;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:register',async(event,value:unknown)=>{
    filesSender(event);if(cueSourceFileBusy)throw new Error('请先完成当前CUE文件操作');const request=readCueSourceRegisterRequest(value),epoch=documentEpoch;cueSourceFileBusy=true;
    const currentFrame=()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('新CUE来源所属界面已变化');};
    try{
      const old=await serviceCall<CueSourceImportResult|null>('cueSourceRegisterReceipt',request);currentFrame();if(old)return old;
      const picked=pickedCueBundle;if(!picked||picked.epoch!==epoch||picked.archiveSha256!==request.archiveSha256)throw new Error('请重新打开并核对所选CUE来源备份');
      const result=await serviceCall<CueSourceImportResult>('registerCueSource',{request,bundle:picked.bundle});currentFrame();return result;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:select',async(event,value:unknown)=>{
    filesSender(event);if(cueSourceFileBusy)throw new Error('请先完成当前CUE文件操作');const request=readCueSourceSelectionRequest(value),epoch=documentEpoch;cueSourceFileBusy=true;
    const currentFrame=()=>{filesSender(event);if(epoch!==documentEpoch)throw new Error('CUE原文选择所属界面已变化');};
    try{
      const old=await serviceCall<CueSourceSelectionResult|null>('cueSourceSelectionReceipt',request);currentFrame();if(old)return old;
      const scope=await serviceCall<{request:typeof request;documentIds:string[];fileIds:string[]}>('cueSourceSelectionScope',request);currentFrame();if(JSON.stringify(scope.request)!==JSON.stringify(request)||scope.documentIds.length>1000||scope.fileIds.length>1000)throw new Error('CUE播放变更范围与原请求不一致');
      const result=await playback.mutateCueDocuments(scope.documentIds,()=>{currentFrame();return serviceCall<CueSourceSelectionResult>('selectCueSource',request);},scope.fileIds);currentFrame();return result;
    }finally{cueSourceFileBusy=false;}
  });
  handleIpc('cue-source:configure',async(event,value:unknown)=>{filesSender(event);const request=readCueInterpretRequest(value),old=await serviceCall('cueSourceReceipt',request);if(old)return old;const source=await serviceCall<import('../shared/cue-history.js').CueSourceSummary>('cueSource',request.fileId);return playback.mutateCueDocuments(source.documentIds,()=>serviceCall('configureCueSource',request));});
  handleIpc('library:file-policy',async(event,fileId:string)=>{filesSender(event);return serviceCall('filePolicy',fileId);});
  handleIpc('library:file-policies',async(event,cursor?:string)=>{filesSender(event);return serviceCall('filePolicies',cursor);});
  handleIpc('library:configure-file-policy',async(event,value:unknown)=>{
    filesSender(event);const request=readFilePolicyRequest(value),old=await serviceCall('filePolicyReceipt',request);if(old)return old;
    return playback.mutateLibraryFile(request.fileId,()=>serviceCall('configureFilePolicy',request));
  });
  handleIpc('playback:state',event => { trusted(event.sender); return audio.snapshot(); });
  handleIpc('queue:view',event => { trusted(event.sender); return playback.view(); });
  handleIpc('queue:next',(event,command:QueueCommand) => { trusted(event.sender); return playback.next(checkedQueueCommand(command)); });
  handleIpc('queue:previous',(event,command:QueueCommand) => { trusted(event.sender); return playback.previous(checkedQueueCommand(command)); });
  handleIpc('queue:repeat',(event,mode:RepeatMode,command:QueueCommand) => { trusted(event.sender); if(!['off','one','all'].includes(mode))throw new Error('无效循环模式'); return playback.setRepeat(mode,checkedQueueCommand(command)); });
  handleIpc('queue:shuffle',(event,enabled:boolean,command:QueueCommand) => { trusted(event.sender); if(typeof enabled!=='boolean')throw new Error('无效随机状态'); return playback.setShuffle(enabled,checkedQueueCommand(command)); });
  handleIpc('queue:jump',(event,entryId:string,command:QueueCommand) => { trusted(event.sender); if(typeof entryId!=='string'||entryId.length>128)throw new Error('无效队列 ID'); return playback.jump(entryId,checkedQueueCommand(command)); });
  handleIpc('queue:remove',(event,entryId:string,command:QueueCommand) => { trusted(event.sender); if(typeof entryId!=='string'||entryId.length>128)throw new Error('无效队列 ID'); return playback.remove(entryId,checkedQueueCommand(command)); });
  handleIpc('queue:move',(event,entryId:string,direction:-1|1,command:QueueCommand) => { trusted(event.sender); if(typeof entryId!=='string'||entryId.length>128||direction!==-1&&direction!==1)throw new Error('无效队列移动'); return playback.move(entryId,direction,checkedQueueCommand(command)); });
}

function createRecoveryWindow():void{
 if(service!==null||serviceReady||desktopReady||!catalogRestoreRecovery.active)throw new Error('启动核对窗口不能接管活动曲库');
 window=new BrowserWindow({width:1000,height:760,minWidth:760,minHeight:560,title:'Aural · 恢复启动核对',backgroundColor:appearance.background(),show:false,webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
 const createdWindow=window;createdWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));createdWindow.webContents.on('will-navigate',event=>event.preventDefault());
 createdWindow.webContents.on('did-start-loading',()=>{documentEpoch++;catalogRestoreRecovery.interrupt('启动核对文档重新加载，原读取或保存需等待结束');});
 createdWindow.webContents.on('render-process-gone',()=>{documentEpoch++;catalogRestoreRecovery.interrupt('启动核对界面退出，原读取或保存需等待结束');});
 void createdWindow.loadFile(path.resolve(__dirname,'../../renderer/index.html')).catch(error=>{if(window===createdWindow){dialog.showErrorBox('启动核对界面加载失败',String(error));app.quit();}});
 createdWindow.once('ready-to-show',()=>{if(window===createdWindow&&!desktop?.isQuitting&&process.env.AURAL_TEST!=='1')createdWindow.show();});
 createdWindow.on('closed',()=>{if(window!==createdWindow)return;documentEpoch++;catalogRestoreRecovery.interrupt('启动核对窗口已关闭');window=null;});
}
function createWindow(): void {
  const placement=windowPlacement.creation();
  window = new BrowserWindow({
    ...placement.bounds,minWidth:placement.minWidth,minHeight:placement.minHeight,
    title:'Aural 音乐库',backgroundColor:appearance.background(),show:false,
    webPreferences:{
      preload:path.join(__dirname,'preload.js'),
      nodeIntegration:false,contextIsolation:true,sandbox:true
    }
  });
  const createdWindow=window;desktop!.bind(window);appearance.bind(window);windowPlacement.bind(window);
  let painted=false,revealed=false,acknowledged:'ready'|'failed'|null=null;
  let interfaceDeadline:NodeJS.Timeout|undefined,expired=false;
  const clearInterfaceDeadline=()=>{if(interfaceDeadline)clearTimeout(interfaceDeadline);interfaceDeadline=undefined;};
  const reveal=()=>{if(revealed||expired||!painted||!acknowledged||window!==createdWindow||createdWindow.isDestroyed()||desktop?.isQuitting||rendererQuitting)return;revealed=true;clearInterfaceDeadline();windowPlacement.finishRestore(createdWindow,placement.maximized);if(process.env.AURAL_TEST!=='1')createdWindow.show();startupWindow.finish(acknowledged);};
  const handoff={window:createdWindow,ticket:randomUUID(),epoch:documentEpoch,acknowledge:(ticket:string,ready:boolean):boolean=>{if(interfaceHandoff!==handoff||window!==createdWindow||handoff.epoch!==documentEpoch||ticket!==handoff.ticket||revealed||expired)return false;acknowledged=ready?'ready':'failed';reveal();return true;}};
  // This bounds only the already-initialized interface handoff. It never limits
  // a database upgrade or substitutes for a Library or restore readiness proof.
  const armInterfaceDeadline=()=>{clearInterfaceDeadline();if(!startupWindow.active||revealed)return;interfaceDeadline=setTimeout(()=>{if(interfaceHandoff!==handoff||window!==createdWindow||createdWindow.isDestroyed()||revealed||rendererQuitting||desktop?.isQuitting)return;expired=true;startupWindow.update('failed');},120000);interfaceDeadline.unref();};
  interfaceHandoff=handoff;
  armInterfaceDeadline();
  window.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  window.webContents.on('will-navigate',event => event.preventDefault());
  window.webContents.on('did-start-loading',()=>{documentEpoch++;if(interfaceHandoff===handoff){handoff.ticket=randomUUID();handoff.epoch=documentEpoch;acknowledged=null;expired=false;armInterfaceDeadline();}if(catalogRestoreRenderer.loading()){artworkResources.resetLeases();analysisRequested=false;refreshAnalysisVisibility();return;}catalogBackup.interrupt('界面重新加载，备份已中断。');catalogRestore.interrupt('应用或界面状态变化，恢复预览已中断。');catalogDirectoryMover.interrupt('应用或界面状态变化，目录切换须重新核对。');catalogRestorePreparation.interrupt('应用或界面状态变化，整库恢复准备已中断。');catalogRestoreCutover.interrupt('应用或界面状态变化，整库切换须重新核对。');artworkResources.resetLeases();analysisRequested=false;refreshAnalysisVisibility();});
  window.webContents.on('did-start-navigation',(_event,url,isInPlace,isMainFrame)=>{if(!catalogRestoreRenderer.navigation(url,isMainFrame,isInPlace))catalogRestoreCutover.interrupt('界面发生未登记的导航，整库切换须重新核对。');});
  window.webContents.on('did-finish-load',()=>catalogRestoreRenderer.loaded());
  window.webContents.on('render-process-gone',()=>{documentEpoch++;if(window===createdWindow&&startupWindow.active&&!rendererQuitting&&!desktop?.isQuitting)startupWindow.update('failed');catalogBackup.interrupt('界面进程退出，备份已中断。');catalogRestore.interrupt('应用或界面状态变化，恢复预览已中断。');catalogDirectoryMover.interrupt('应用或界面状态变化，目录切换须重新核对。');catalogRestorePreparation.interrupt('应用或界面状态变化，整库恢复准备已中断。');catalogRestoreCutover.interrupt('应用或界面状态变化，整库切换须重新核对。');artworkResources.resetLeases();});
  window.on('minimize',refreshAnalysisVisibility);
  window.on('restore',refreshAnalysisVisibility);
  window.on('show',refreshAnalysisVisibility);
  window.on('hide',refreshAnalysisVisibility);
  createdWindow.once('closed',()=>{clearInterfaceDeadline();if(interfaceHandoff===handoff)interfaceHandoff=null;});
  void window.loadFile(path.resolve(__dirname,'../../renderer/index.html')).catch(error=>{if(window!==createdWindow||rendererQuitting||desktop?.isQuitting)return;startupWindow.finish('failed');dialog.showErrorBox('音乐库界面加载失败',String(error));app.quit();});
  window.once('ready-to-show',() => {if(window!==createdWindow||desktop?.isQuitting)return;painted=true;if(!startupWindow.active)acknowledged='ready';reveal();});
  window.on('closed',() => {if(window!==createdWindow)return;documentEpoch++;catalogBackup.interrupt('主窗口关闭，备份已中断。');catalogRestore.interrupt('应用或界面状态变化，恢复预览已中断。');catalogDirectoryMover.interrupt('应用或界面状态变化，目录切换须重新核对。');catalogRestorePreparation.interrupt('应用或界面状态变化，整库恢复准备已中断。');catalogRestoreCutover.interrupt('应用或界面状态变化，整库切换须重新核对。');artworkResources.resetLeases();window=null;analysisRequested=false;refreshAnalysisVisibility();});
}

function showMainWindow():void{if(!desktop?.isQuitting&&startupWindow.focus())return;if(catalogRestoreRecovery.active){if(window&&!window.isDestroyed()){if(window.isMinimized())window.restore();window.show();window.focus();}return;}if(!serviceReady||!desktopReady||desktop?.isQuitting)return;if(!window||window.isDestroyed())createWindow();if(window){if(window.isMinimized())window.restore();window.show();window.focus();}}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',(_event,argv)=>{const files=desktopFileArguments(argv,app.isPackaged);if(files.length)void captureDesktopFiles(files,'open').catch(()=>{});showMainWindow();});
  app.on('open-file',(event,filename)=>{event.preventDefault();void captureDesktopFiles([filename],'open').catch(()=>{});});
  const initialFiles=desktopFileArguments(process.argv,app.isPackaged);if(initialFiles.length)void captureDesktopFiles(initialFiles,'open').catch(()=>{});
  app.whenReady().then(async () => {
    if(process.platform==='win32')app.setAppUserModelId(RELEASE.appId);
    powerMonitor.on('suspend',()=>{if(desktop?.isQuitting)return;if(catalogRestoreRecovery.active){catalogRestoreRecovery.interrupt('系统休眠，原启动核对需等待结束');return;}catalogBackup.interrupt('系统休眠，备份已中断。');catalogRestore.interrupt('应用或界面状态变化，恢复预览已中断。');catalogDirectoryMover.interrupt('应用或界面状态变化，目录切换须重新核对。');catalogRestorePreparation.interrupt('应用或界面状态变化，整库恢复准备已中断。');catalogRestoreCutover.interrupt('应用或界面状态变化，整库切换须重新核对。');historyExporter.interrupt('系统休眠，历史导出已中断。');void serviceCall('libraryWatchSuspend').catch(()=>{});playback.systemSuspend();audioDevices.close();audioCapabilities.close();asioDrivers.close();asioPanel.suspend();audioDeviceWatch.suspendForSystem();systemMedia?.refresh(true);});
    powerMonitor.on('resume',()=>{
      if(desktop?.isQuitting||catalogRestoreRecovery.active)return;void serviceCall('libraryWatchResume').catch(()=>{});playback.systemResume();systemMedia?.refresh(true);
      void audioDeviceWatch.resumeAfterSystem().then(()=>{if(!desktop?.isQuitting)return audioDevices.list();}).catch(()=>{/* State remains explicit; users can refresh devices or reconnect notifications. */});
    });
    protocol.handle('aural-artwork',async request=>{
      if(request.method!=='GET')return new Response(null,{status:405});if(catalogRestoreRecovery.active)return new Response(null,{status:503});
      return artworkResources.response(request.url,request.method);
    });
    registerIpc();
    startupWindow.open();
    try { await startLibrary();startupWindow.update('preferences');await appearance.initialize();await windowPlacement.initialize();startupWindow.update('output'); await audioOutput.initialize(); await asioOutput.initialize();await audioBackend.initialize();await dsdOutput.initialize();startupWindow.update('queue'); historyRecorder!.configure(readPlaybackPolicy(await serviceCall('playbackPolicy')));await playback.initialize();await historyRecorder!.initialize();startupWindow.update('desktop'); await desktop!.initialize();await mediaKeys!.initialize(); desktopReady=true; }
    catch (error) {if(quitStarted||desktop?.isQuitting)return;if(error instanceof RestoreStartupBlocked&&service===null&&!serviceReady&&!desktopReady){catalogRestoreRecovery.activate(error);createRecoveryWindow();startupWindow.finish('failed');return;}if(error instanceof CompletedLibraryStartupFailed&&service===null&&!serviceReady&&!desktopReady){catalogRestoreRecovery.activateLibraryFailure(error);createRecoveryWindow();startupWindow.finish('failed');return;}dialog.showErrorBox('音乐库初始化失败',String(error));startupWindow.finish('failed');app.quit();return;}
    if (serviceReady&&!desktop!.isQuitting&&!quitStarted) {startupWindow.update('interface');void audioDeviceWatch.start().catch(()=>{});void systemMedia!.start().catch(error=>publish({event:'desktopControlError',payload:{message:String(error)}}));createWindow();desktopFiles.start();}
  });
  let quitStarted=false,quitReady=false;
  app.on('before-quit',event => {
    if(quitReady)return;event.preventDefault();if(quitStarted)return;quitStarted=true;rendererQuitting=true;analysisRequested=false;startupWindow.finish('closing');
    const rendererExit=Promise.allSettled([...rendererRequests]);const tagBatchExit=tagStageBatches.close();
    const artworkExit=artworkResources.close();
    const backupExit=catalogBackup.close();
    const restoreExit=catalogRestore.close();
    const directoryMoveExit=catalogDirectoryMover.close();
    const restorePreparationExit=catalogRestorePreparation.close();
    const restoreCutoverExit=catalogRestoreCutover.close();
    const restoreApplyExit=catalogRestoreApply.close();
    const restoreRecoveryExit=catalogRestoreRecovery.close();
    const flush=windowPlacement.flushForQuit();
    const cleanup=[()=>desktop?.beginQuit(),()=>appearance.close(),()=>desktopFiles.close(),()=>mediaKeys?.close(),()=>systemMedia?.close(),()=>pauseRelease?.close(),()=>audio.stop(),()=>audioDevices.close(),()=>audioCapabilities.close(),()=>asioDrivers.close(),()=>asioPanel.close(),()=>audioDeviceWatch.close()];
    for(const close of cleanup){try{close();}catch{/* One failed cleanup cannot prevent the remaining owners or bounded exit. */}}
    // Audio stops immediately. Geometry and final history get at most 1.5 seconds before service termination.
    const historyExportExit=historyExporter.close();
    const historyFlush=historyRecorder?.close()??Promise.resolve();
    let timer:NodeJS.Timeout;const deadline=new Promise<void>(resolve=>{timer=setTimeout(resolve,1500);});
    void Promise.race([Promise.allSettled([flush,historyFlush,historyExportExit,rendererExit,tagBatchExit,artworkExit,backupExit,restoreExit,directoryMoveExit,restorePreparationExit,restoreCutoverExit,restoreApplyExit,restoreRecoveryExit]),deadline]).finally(()=>{clearTimeout(timer);windowPlacement.close();void libraryLifecycle.close();quitReady=true;app.quit();});
  });
  app.on('window-all-closed',() => {if(!desktop?.hasTray||desktop.isQuitting)app.quit();});
}
