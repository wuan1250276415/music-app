import {MetadataFingerprintPanel} from './metadata-fingerprint-panel';
import {MetadataISRCChoice} from './metadata-isrc-choice';
import {MetadataRecordingLookup} from './metadata-recording-lookup';
import {AsioPlaybackInfo} from './asio-playback-info';
import {AsioDsdPlaybackInfo} from './asio-dsd-playback-info';
import type {RuleSelection} from '../shared/rule-transfer';
import {SmartPlaylistBrowser} from './smart-playlist-browser';
import type {SmartPlaylistDialogState} from './smart-playlist-dialog';
import {readSmartPlaylistDetail,type SmartPlaylistDetail} from '../shared/smart-playlists';
import type {PlaylistDialogState} from './collections';
import type {MetadataSourceTarget} from './metadata-sources-dialog';
import {deferDialog} from './deferred-dialog';
import type {LibrarySort} from '../shared/library-sort';
import {musicFilterCount,musicFilterDependencies,musicFilterTimeAnchor,type MusicFilters} from '../shared/music-filters';
import {useLibraryBrowse} from './library-browse';
import {BROWSE_STALE_ERROR} from '../shared/library-browse';
import {VirtualLibrary} from './virtual-library';
import {CatalogBrowser} from './catalog-browser';
import {SearchIndexNotice} from './search-index-notice';
import './library-browse.css';
import {trap} from './dialog-focus';
import './theme-tokens.css';
import {DesktopFileEntry} from './desktop-files';
import {PlayerVolume} from './player-volume';
import {ProcessingPlanInfo} from './processing-plan';
import {PipelinePlanInfo} from './pipeline-plan';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { LibraryItem, LibraryStats, ListResponse, PlaybackState, ScanState, View, LyricsBundle,LyricsPreference,LyricsPreferenceRequest, MetadataMatchResult, MetadataField, MetadataCandidate, QueueCommand, QueueView, RepeatMode, PlaylistSummary, PlaylistEditRequest, ArtistRole,MetadataNetworkState } from '../shared/contracts';
import { RELEASE } from '../shared/release';
import {PlaybackClockInfo} from './playback-clock';
import {PlaybackTailInfo} from './playback-tail';
import {DecoderInfo} from './decoder-info';
import {CueInfo} from './cue-info';
import {Artwork} from './artwork';
import {OnlineArtworkControls} from './online-artwork-controls';
import {SongInformation,roleLabels} from './song-information';
import {useCurrentItem} from './current-item';
import {PlayerProgress} from './player-progress';
import {DetailQueue} from './detail-queue';
import {AudioVisualization} from './audio-visualization';
import {WholeWaveform} from './whole-waveform';
import {LyricsDisplay,lyricsSource} from './lyrics-display';
import {LyricsControls} from './lyrics-controls';
import {loadUsableArtwork} from './media-artwork';
import {GenreBrowser,GenreManagerDialog} from './genres';
import {MetadataNetworkControls} from './metadata-network-controls';
import {CoverArtSourcePanel} from './cover-art-source-panel';
import {MetadataEditionsPanel} from './metadata-editions-panel';
import {MetadataMatchReasons} from './metadata-match-reasons';
import {MetadataReleaseContextPanel} from './metadata-release-context-panel';
import './style.css';
import './output.css';
import './lyrics.css';
import './metadata.css';
import './queue.css';
import './detail.css';
import './collections.css';
import './catalog.css';
import './appearance.css';
import './chamber.css';
import {CatalogBackupBoundary} from './catalog-backup-boundary.js';
import {CatalogRestoreApplication} from './catalog-restore-application.js';
import {restoreAppBrowse,type RestoreAppData} from '../shared/catalog-restore-application.js';
import {CatalogRestorePrepared} from './catalog-restore-prepared.js';
import {readRestoreRendererRequest} from '../shared/catalog-restore-renderer.js';
import {readRestoreRecoveryState} from '../shared/catalog-restore-recovery.js';
import {initializeCatalogBackupClient,openCatalogBackup} from './catalog-backup-client.js';

const CatalogRestoreDialog=deferDialog<Parameters<typeof import('./catalog-restore-dialog').CatalogRestoreDialog>[0]>(()=>import('./catalog-restore-dialog').then(module=>module.CatalogRestoreDialog));
const PlaybackHistoryDialog=deferDialog<Parameters<typeof import('./playback-history-dialog').PlaybackHistoryDialog>[0]>(()=>import('./playback-history-dialog').then(module=>module.PlaybackHistoryDialog));
const AppearanceDialog=deferDialog<Parameters<typeof import('./appearance-dialog').AppearanceDialog>[0]>(()=>import('./appearance-dialog').then(module=>module.AppearanceDialog));
const SmartPlaylistHistoryDialog=deferDialog<Parameters<typeof import('./smart-playlist-history-dialog').SmartPlaylistHistoryDialog>[0]>(()=>import('./smart-playlist-history-dialog').then(module=>module.SmartPlaylistHistoryDialog));
const SmartPlaylistDialog=deferDialog<Parameters<typeof import('./smart-playlist-dialog').SmartPlaylistDialog>[0]>(()=>import('./smart-playlist-dialog').then(module=>module.SmartPlaylistDialog));
const PlaylistDialog=deferDialog<Parameters<typeof import('./collections').PlaylistDialog>[0]>(()=>import('./collections').then(module=>module.PlaylistDialog));
const CatalogDialog=deferDialog<Parameters<typeof import('./catalog-dialog').CatalogDialog>[0]>(()=>import('./catalog-dialog').then(module=>module.CatalogDialog));
const VersionsDialog=deferDialog<Parameters<typeof import('./catalog-dialog').VersionsDialog>[0]>(()=>import('./catalog-dialog').then(module=>module.VersionsDialog));
const CatalogHistoryDialog=deferDialog<Parameters<typeof import('./catalog-dialog').CatalogHistoryDialog>[0]>(()=>import('./catalog-dialog').then(module=>module.CatalogHistoryDialog));
const ArtistDialog=deferDialog<Parameters<typeof import('./artist-dialog').ArtistDialog>[0]>(()=>import('./artist-dialog').then(module=>module.ArtistDialog));
const ReleaseDialog=deferDialog<Parameters<typeof import('./release-dialog').ReleaseDialog>[0]>(()=>import('./release-dialog').then(module=>module.ReleaseDialog));
const ArtistManagerDialog=deferDialog<Parameters<typeof import('./artist-manager').ArtistManagerDialog>[0]>(()=>import('./artist-manager').then(module=>module.ArtistManagerDialog));
const EntityReferencesDialog=deferDialog<Parameters<typeof import('./entity-references-dialog').EntityReferencesDialog>[0]>(()=>import('./entity-references-dialog').then(module=>module.EntityReferencesDialog));
const RecordingProfileDialog=deferDialog<Parameters<typeof import('./recording-profile-dialog').RecordingProfileDialog>[0]>(()=>import('./recording-profile-dialog').then(module=>module.RecordingProfileDialog));
const LyricsDocumentsDialog=deferDialog<Parameters<typeof import('./lyrics-documents').LyricsDocumentsDialog>[0]>(()=>import('./lyrics-documents').then(module=>module.LyricsDocumentsDialog));
const SavedLyricsDialog=deferDialog<Parameters<typeof import('./saved-lyrics').SavedLyricsDialog>[0]>(()=>import('./saved-lyrics').then(module=>module.SavedLyricsDialog));
const LocalLyricsBrowserDialog=deferDialog<Parameters<typeof import('./local-lyrics-browser').LocalLyricsBrowserDialog>[0]>(()=>import('./local-lyrics-browser').then(module=>module.LocalLyricsBrowserDialog));
const EmbeddedCueHistoryDialog=deferDialog<Parameters<typeof import('./embedded-cue-history-dialog').EmbeddedCueHistoryDialog>[0]>(()=>import('./embedded-cue-history-dialog').then(module=>module.EmbeddedCueHistoryDialog));
const CueHistoryDialog=deferDialog<Parameters<typeof import('./cue-history-dialog').CueHistoryDialog>[0]>(()=>import('./cue-history-dialog').then(module=>module.CueHistoryDialog));
const FilePolicyDialog=deferDialog<Parameters<typeof import('./file-policy-dialog').FilePolicyDialog>[0]>(()=>import('./file-policy-dialog').then(module=>module.FilePolicyDialog));
const ScanTasksDialog=deferDialog<Parameters<typeof import('./scan-tasks').ScanTasksDialog>[0]>(()=>import('./scan-tasks').then(module=>module.ScanTasksDialog));
const LibraryWatchDialog=deferDialog<Parameters<typeof import('./library-watch-dialog').LibraryWatchDialog>[0]>(()=>import('./library-watch-dialog').then(module=>module.LibraryWatchDialog));
const AudioOutputDialog=deferDialog<Parameters<typeof import('./audio-output-dialog').AudioOutputDialog>[0]>(()=>import('./audio-output-dialog').then(module=>module.AudioOutputDialog));
const ProviderManagerDialog=deferDialog<Parameters<typeof import('./provider-manager').ProviderManagerDialog>[0]>(()=>import('./provider-manager').then(module=>module.ProviderManagerDialog));
const MetadataUndoDialog=deferDialog<Parameters<typeof import('./metadata-undo-dialog').MetadataUndoDialog>[0]>(()=>import('./metadata-undo-dialog').then(module=>module.MetadataUndoDialog));
const MetadataBatchDialog=deferDialog<Parameters<typeof import('./metadata-batch-dialog').MetadataBatchDialog>[0]>(()=>import('./metadata-batch-dialog').then(module=>module.MetadataBatchDialog));
const MetadataAlbumReviewDialog=deferDialog<Parameters<typeof import('./metadata-album-review-dialog').MetadataAlbumReviewDialog>[0]>(()=>import('./metadata-album-review-dialog').then(module=>module.MetadataAlbumReviewDialog));
const MetadataReleaseFieldsDialog=deferDialog<Parameters<typeof import('./metadata-release-fields-dialog').MetadataReleaseFieldsDialog>[0]>(()=>import('./metadata-release-fields-dialog').then(module=>module.MetadataReleaseFieldsDialog));
const MetadataCreditDialog=deferDialog<Parameters<typeof import('./metadata-credit-dialog').MetadataCreditDialog>[0]>(()=>import('./metadata-credit-dialog').then(module=>module.MetadataCreditDialog));
const RuleTransferDialog=deferDialog<Parameters<typeof import('./rule-transfer-dialog').RuleTransferDialog>[0]>(()=>import('./rule-transfer-dialog').then(module=>module.RuleTransferDialog));
const MusicFiltersDialog=deferDialog<Parameters<typeof import('./music-filters-dialog').MusicFiltersDialog>[0]>(()=>import('./music-filters-dialog').then(module=>module.MusicFiltersDialog));
const TagWriteDialog=deferDialog<Parameters<typeof import('./tag-write-dialog').TagWriteDialog>[0]>(()=>import('./tag-write-dialog').then(module=>module.TagWriteDialog));
const MetadataSourcesDialog=deferDialog<Parameters<typeof import('./metadata-sources-dialog').MetadataSourcesDialog>[0]>(()=>import('./metadata-sources-dialog').then(module=>module.MetadataSourcesDialog));

const emptyPlayback: PlaybackState = {state:'idle',itemId:null,positionSeconds:0,durationSeconds:null,output:'未连接'};
const emptyQueue: QueueView = {entries:[],currentEntryId:null,repeat:'off',shuffle:false,order:[],orderCursor:-1,history:[],historyCursor:-1,revision:0,items:[]};
const nav: Array<{id:View;label:string;icon:string}> = [
  {id:'all',label:'全部音乐',icon:'♫'},
  {id:'artists',label:'歌手',icon:'◎'},
  {id:'albums',label:'专辑',icon:'▣'},
  {id:'genres',label:'风格',icon:'◇'},
  {id:'folders',label:'文件夹',icon:'▤'},
  {id:'favorites',label:'收藏',icon:'♡'},
  {id:'recent',label:'最近添加',icon:'◷'},
  {id:'playlists',label:'歌单',icon:'☷'}
];

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0,Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2,'0')}`;
}

function outputSummary(output:string):string {
  if(output.startsWith('DSD'))return 'DSD → PCM · 未认证';
  if(output.includes('(converted)'))return '已转换 · 悬停详情';
  if(output.includes('integer path'))return '整数路径 · 未认证';
  return output;
}

function App({onRestoreReady,onRestoreError,startupTicket}:{onRestoreReady?:(data:RestoreAppData)=>void;onRestoreError?:(error:unknown)=>void;startupTicket?:string|null}={}): React.JSX.Element {
  const restoreReads=useRef(new Set<string>()),restoreReported=useRef(false),[restoreReadRevision,setRestoreReadRevision]=useState(0);
  const restoreRead=(name:string)=>{restoreReads.current.add(name);setRestoreReadRevision(value=>value+1);};
  const startupReported=useRef(false);
  const restoreError=(error:unknown)=>{if(onRestoreError&&!restoreReported.current){restoreReported.current=true;onRestoreError(error);}};
  const [restoreOpen,setRestoreOpen]=useState(false);
  const [showAppearance,setShowAppearance]=useState(false),[compact,setCompact]=useState(()=>window.matchMedia('(max-width:800px)').matches),[showNavigation,setShowNavigation]=useState(false);
  const sidebarRef=useRef<HTMLElement|null>(null);
  useEffect(()=>{const media=window.matchMedia('(max-width:800px)'),changed=()=>{setCompact(media.matches);setShowNavigation(false);};media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);},[]);
  useEffect(()=>{if(!compact||!showNavigation)return;const previous=document.activeElement as HTMLElement|null;sidebarRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();return()=>previous?.focus();},[compact,showNavigation]);
  const [view,setView] = useState<View>('all');
  const [facet,setFacet] = useState('');
  const [facetId,setFacetId]=useState('');
  const [genreFilter,setGenreFilter]=useState<import('../shared/contracts').GenreFilter|null>(null);
  const [musicFilters,setMusicFilters]=useState<MusicFilters>({}),[showMusicFilters,setShowMusicFilters]=useState(false);
  const [showGenreManager,setShowGenreManager]=useState(false);
  const [artistRole,setArtistRole]=useState<ArtistRole>('performer');
  const [query,setQuery] = useState('');
  const [settledQuery,setSettledQuery] = useState('');
  const [stats,setStats] = useState<LibraryStats>({roots:0,tracks:0,artists:0,albums:0,unavailable:0});
  const [roots,setRoots] = useState<Array<{id:string;path:string;status:string}>>([]);
  const [playlists,setPlaylists]=useState<PlaylistSummary[]>([]);
  const smartOpenEpoch=useRef(0);
  const [smartPlaylist,setSmartPlaylist]=useState<SmartPlaylistDetail|null>(null);
  const [smartPlaylistDialog,setSmartPlaylistDialog]=useState<SmartPlaylistDialogState|null>(null);
  const [smartHistory,setSmartHistory]=useState<{playlistId?:string}|null>(null);
  const [ruleTransfer,setRuleTransfer]=useState<{initialExport?:Array<RuleSelection&{name:string}>}|null>(null);
  const [playlistDialog,setPlaylistDialog]=useState<PlaylistDialogState|null>(null);
  const [catalogItem,setCatalogItem]=useState<LibraryItem|null>(null);
  const [artistItem,setArtistItem]=useState<LibraryItem|null>(null);
  const [releaseItem,setReleaseItem]=useState<LibraryItem|null>(null);
  const [referencesItem,setReferencesItem]=useState<LibraryItem|null>(null);
  const [recordingItem,setRecordingItem]=useState<LibraryItem|null>(null);
  const [sourceTarget,setSourceTarget]=useState<MetadataSourceTarget|null>(null);
  const [tagWriteItem,setTagWriteItem]=useState<string|null>(null);
  const [showArtistManager,setShowArtistManager]=useState(false);
  const [versionsItem,setVersionsItem]=useState<LibraryItem|null>(null);
  const [showCatalogHistory,setShowCatalogHistory]=useState(false);
  const [librarySort,setLibrarySort]=useState<LibrarySort>({mode:'default',direction:'asc'});
  const [collapseVersions,setCollapseVersions]=useState(false);
  const [userBusy,setUserBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [playback,setPlayback] = useState<PlaybackState>(emptyPlayback);
  const [queue,setQueue] = useState<QueueView>(emptyQueue);
  const [queueRevision,setQueueRevision] = useState(0);
  const [showQueue,setShowQueue] = useState(false);
  const [batchSelection,setBatchSelection]=useState<LibraryItem[]>([]);
  const [undoReview,setUndoReview]=useState<string|null>(null);
  const [showBatchReview,setShowBatchReview]=useState(false);
  const [showDetail,setShowDetail] = useState(false);
  const [historyDialog,setHistoryDialog]=useState<{itemId?:string}|null>(null);
  const [detailPanel,setDetailPanel]=useState<'lyrics'|'queue'|'both'>('both');
  const detailOrigin=useRef<HTMLElement|null>(null);
  const [queueBusy,setQueueBusy]=useState(false),queueEditing=useRef(false);
  const [showScanTasks,setShowScanTasks]=useState(false);
  const [cueHistoryItemId,setCueHistoryItemId]=useState<string|null|undefined>(undefined);
  const [embeddedCueHistoryItemId,setEmbeddedCueHistoryItemId]=useState<string|null|undefined>(undefined);
  const [filePolicyFileId,setFilePolicyFileId]=useState<string|null|undefined>(undefined);
  const [showLibraryWatch,setShowLibraryWatch]=useState(false);
  const [lyricsImportItem,setLyricsImportItem]=useState<LibraryItem|null>(null);
  const [lyricsReuse,setLyricsReuse]=useState<import('../shared/contracts').SavedLyricsDocument|null>(null),[showSavedLyrics,setShowSavedLyrics]=useState(false),[savedLyricsThisItem,setSavedLyricsThisItem]=useState(false);
  const [lyricsLocalReuse,setLyricsLocalReuse]=useState<import('../shared/contracts').LocalLyricsVersion|null>(null),[showLocalLyricsBrowser,setShowLocalLyricsBrowser]=useState(false),[localLyricsThisItem,setLocalLyricsThisItem]=useState(false);
  const [showProviders,setShowProviders]=useState(false);
  const [showAudioOutput,setShowAudioOutput]=useState(false);
  const [scan,setScan] = useState<ScanState | null>(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [revision,setRevision] = useState(0);
  const [selectedItem,setSelectedItem] = useState<LibraryItem|null>(null);
  const [showLyrics,setShowLyrics] = useState(false);
  const [lyricsState,setLyricsState] = useState<{key:string;bundle:LyricsBundle|null}|null>(null);
  const [lyricsRevision,setLyricsRevision]=useState(0);
  const [lyricsBusy,setLyricsBusy]=useState(false),[lyricsPending,setLyricsPending]=useState(false),[lyricsError,setLyricsError]=useState('');
  const lyricsAttempt=useRef<LyricsPreferenceRequest|null>(null),lyricsSaving=useRef(false);
  const [artworkRevisions,setArtworkRevisions]=useState<Record<string,number>>({});
  const [artworkEpoch,setArtworkEpoch]=useState(0);
  const mediaRefreshJobs=useRef(new Set<string>());
  const [refreshingFiles,setRefreshingFiles]=useState<ReadonlySet<string>>(new Set());
  const [showMetadata,setShowMetadata] = useState(false);
  const [metadataContact,setMetadataContact] = useState('');
  const [fingerprintWorking,setFingerprintWorking]=useState(false);
  const [match,setMatch] = useState<MetadataMatchResult|null>(null);
  const matchRef=useRef(match);matchRef.current=match;
  const [matchItem,setMatchItem] = useState<LibraryItem|null>(null);
  const [candidateToken,setCandidateToken] = useState('');
  const [albumReview,setAlbumReview]=useState<import('../shared/metadata-album-review').MetadataAlbumReviewHeader|null>(null);
  const [batchInitialId,setBatchInitialId]=useState<string|undefined>(undefined);
  const [releaseFieldsReview,setReleaseFieldsReview]=useState<import('../shared/metadata-release-fields').ReleaseFieldsReview|null>(null);
  const [creditReview,setCreditReview]=useState<{itemId:string;token:string}|null>(null);
  const [acceptedFields,setAcceptedFields] = useState<MetadataField[]>([]);
  const [metadataBusy,setMetadataBusy] = useState(false),[metadataSearching,setMetadataSearching]=useState(false),[metadataNetworkBusy,setMetadataNetworkBusy]=useState(false),[metadataNetwork,setMetadataNetwork]=useState<MetadataNetworkState|null>(null),[metadataNow,setMetadataNow]=useState(Date.now());
  const metadataRequest=useRef<{id:string;searching:boolean}|null>(null),metadataNetworkAction=useRef(false);
  const [lastChange,setLastChange] = useState('');

  const queueItemId=queue.entries.find(entry=>entry.id===queue.currentEntryId)?.itemId ?? null;
  const currentId=playback.itemId ?? queueItemId;
  const [statisticsRevision,setStatisticsRevision]=useState(0);
  const filterDependencies=musicFilterDependencies(musicFilters,view==='playlists'?smartPlaylist?.definition.query.filters:undefined);
  const filterDependenciesRef=useRef(filterDependencies);filterDependenciesRef.current=filterDependencies;
  useEffect(()=>{
    if(!filterDependencies.relative)return;
    let bucket=musicFilterTimeAnchor(),timer:ReturnType<typeof setTimeout>;
    const check=()=>{const current=musicFilterTimeAnchor();if(current!==bucket){bucket=current;setStatisticsRevision(v=>v+1);}};
    const schedule=()=>{timer=setTimeout(()=>{check();schedule();},60000-Date.now()%60000+25);};
    const visible=()=>{if(document.visibilityState==='visible')check();};
    schedule();window.addEventListener('focus',check);document.addEventListener('visibilitychange',visible);
    return()=>{clearTimeout(timer);window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',visible);};
  },[filterDependencies.relative]);
  const currentIdRef=useRef(currentId);currentIdRef.current=currentId;
  const lyricsKey=`${currentId}:${revision}:${lyricsRevision}`;
  const lyricsContext=useRef(lyricsKey);lyricsContext.current=lyricsKey;
  const lyricsBundle=lyricsState?.key===lyricsKey?lyricsState.bundle:null;
  const lyrics=lyricsBundle?.sources.find(source=>source.id===lyricsBundle.primaryId)??null;
  const secondaryLyrics=lyricsBundle?.sources.find(source=>source.id===lyricsBundle.secondaryId)??null;
  const lyricsLoading=Boolean(currentId&&lyricsState?.key!==lyricsKey);
  function artworkRevision(item:LibraryItem|null|undefined):string{return JSON.stringify([artworkEpoch,item?.fileStamp??'',item?.fileObservation??'',artworkRevisions[item?.fileId??'']??0]);}

  useEffect(() => { const timer=setTimeout(() => setSettledQuery(query),220); return () => clearTimeout(timer); },[query]);
  useEffect(() => {
    const unsubscribe = window.music.onEvent(message => {
      if (message.event === 'scan') {const state=message.payload as ScanState;setScan(state);if(['complete','failed','cancelled'].includes(state.phase))setArtworkEpoch(value=>value+1);}
      if (message.event === 'libraryChanged') {
        const change=message.payload as {reason?:string;action?:string};
        if(change?.reason==='online-artwork-changed'){
          setArtworkEpoch(value=>value+1);
          setNotice(change.action==='apply'?'封面已保存到本机曲库。':change.action==='undo'?'已撤销封面修改。':change.action==='clear'?'已恢复本地封面优先。':'已更新封面使用顺序。');
        }else{setRevision(value=>value+1);if(change?.reason==='local-files-changed')setArtworkEpoch(value=>value+1);}
      }
      if(message.event==='playbackStatisticsChanged'){const changed=message.payload as {counts?:boolean;recency?:boolean},dependency=filterDependenciesRef.current;if(dependency.counts&&changed.counts===true||dependency.recency&&changed.recency===true)setStatisticsRevision(value=>value+1);}
      if (message.event === 'playback') setPlayback(message.payload as PlaybackState);
      if(message.event==='desktopControlError')setError(String((message.payload as {message:string}).message));
      if (message.event === 'queue') setQueueRevision(value=>value+1);
      if(message.event==='lyricsChanged'&&(message.payload as {itemId?:string})?.itemId===currentIdRef.current)setLyricsRevision(value=>value+1);
      if(message.event==='metadataNetwork')setMetadataNetwork(message.payload as MetadataNetworkState);
      if(message.event==='providersChanged'&&(message.payload as {providerId?:string})?.providerId==='musicbrainz'){setMatch(null);setAcceptedFields([]);setCreditReview(null);}
    });
    void window.music.playback().then(value=>{setPlayback(value);restoreRead('playback');}).catch(error=>{setError(String(error));restoreError(error);});
    return unsubscribe;
  },[]);
  useEffect(() => {
    let alive=true;
    void window.music.queue().then(value=>{if(alive){setQueue(value);restoreRead('queue');}}).catch(error=>{if(alive){setError(String(error));restoreError(error);}});
    return ()=>{alive=false;};
  },[queueRevision,revision]);
  useEffect(() => {
    if (!currentId) {setLyricsState(null);return;}
    let alive=true;
    void window.music.lyricsBundle(currentId).then(bundle => {if(alive)setLyricsState({key:lyricsKey,bundle});}).catch(e => {if(alive){setLyricsState({key:lyricsKey,bundle:null});setLyricsError(String(e));}});
    return () => {alive=false;};
  },[currentId,lyricsKey]);
  async function saveLyrics(preference?:LyricsPreference,retry=false):Promise<void> {
    if(lyricsSaving.current||!retry&&lyricsAttempt.current)return;
    const request=retry?lyricsAttempt.current:lyricsBundle&&preference?{commandId:crypto.randomUUID(),itemId:lyricsBundle.itemId,scope:lyricsBundle.scope,baseRevision:lyricsBundle.revision,preference,sourceSetFingerprint:lyricsBundle.sourceSetFingerprint}:null;
    if(!request)return;
    const context=lyricsKey;lyricsAttempt.current=request;lyricsSaving.current=true;setLyricsBusy(true);setLyricsPending(true);setLyricsError('');
    try{
      const result=await window.music.saveLyricsPreference(request);
      lyricsAttempt.current=null;setLyricsPending(false);
      if(result.status==='rejected')setLyricsError(result.error);
      else if(result.bundle&&context===lyricsContext.current&&result.bundle.itemId===currentIdRef.current)setLyricsState({key:context,bundle:result.bundle});
      setLyricsRevision(value=>value+1);
    }catch(e){setLyricsError(String(e));}
    finally{lyricsSaving.current=false;setLyricsBusy(false);}
  }
  useEffect(() => {
    let alive=true;
    Promise.all([window.music.stats(),window.music.roots(),window.music.playlists()]).then(([a,b,c]) => {
      if (alive) {setStats(a);setRoots(b);setPlaylists(c);restoreRead('stats');restoreRead('roots');restoreRead('playlists');}
    }).catch(error => {if(alive){setError(String(error));restoreError(error);}});
    return () => {alive=false;};
  },[revision]);
  const browseQuery=useMemo(()=>({view,value:facet||undefined,facetId:facetId||undefined,artistRole,collapseVersions,genreFilter:view==='genres'?genreFilter??undefined:undefined,filters:musicFilters,sort:view==='playlists'?undefined:librarySort,query:settledQuery}),[view,facet,facetId,artistRole,collapseVersions,genreFilter,musicFilters,librarySort,settledQuery]);
  const browse=useLibraryBrowse(browseQuery,revision+statisticsRevision);
  const result={total:browse.total,items:browse.items};
  useEffect(()=>{
    if(!startupTicket||onRestoreReady||startupReported.current)return;
    const blocked=Boolean(error||browse.error);
    if(!blocked&&(browse.loading||!browse.snapshot||['playback','queue','stats','roots','playlists'].some(name=>!restoreReads.current.has(name))))return;
    startupReported.current=true;void window.music.startupInterfaceReady(startupTicket,blocked?'blocked':'ready').catch(()=>{});
  },[startupTicket,onRestoreReady,restoreReadRevision,browse.loading,browse.snapshot,browse.error,error]);
  useEffect(()=>{
    if(!onRestoreReady||restoreReported.current)return;if(browse.error){restoreError(new Error(browse.error));return;}
    if(browse.loading||!browse.snapshot||['playback','queue','stats','roots','playlists'].some(name=>!restoreReads.current.has(name)))return;
    restoreReported.current=true;onRestoreReady({playback,queue,stats,roots,playlists,browse:restoreAppBrowse(browseQuery,browse.snapshot,browse.total)});
  },[restoreReadRevision,browse.snapshot,browse.total,browse.loading,browse.error,onRestoreReady,onRestoreError]);

  const currentFallback = useMemo(() => result.items.find(item => item.id === currentId) ?? queue.items.find(item=>item.id===currentId) ?? (selectedItem?.id===currentId?selectedItem:undefined),[result.items,queue.items,currentId,selectedItem]);
  const currentInfo=useCurrentItem(currentId,revision,currentFallback);
  const current=currentInfo.item;
  const mediaRefreshing=Boolean(current&&refreshingFiles.has(current.fileId));
  const mediaRefreshBlocked=mediaRefreshing||refreshingFiles.size>=2;
  const currentMediaIdentity=JSON.stringify([current?.id,current?.fileId,current?.fileStamp,current?.fileObservation]);
  const currentMediaIdentityRef=useRef(currentMediaIdentity);currentMediaIdentityRef.current=currentMediaIdentity;
  const metadataItem = current ?? selectedItem ?? null;
  const reviewItem = matchItem ?? metadataItem;
  const candidate = match?.candidates.find(item=>item.token===candidateToken) ?? null;
  const activeLine = useMemo(() => {
    if (!lyrics || lyrics.kind !== 'timed') return -1;
    const position=playback.positionSeconds-(lyricsBundle?.offsetMs??0)/1000+0.08;
    let low=0,high=lyrics.lines.length;
    while(low<high){const middle=(low+high)>>>1;if(lyrics.lines[middle].atSeconds<=position)low=middle+1;else high=middle;}
    return low-1;
  },[lyrics,playback.positionSeconds,lyricsBundle?.offsetMs]);
  const lyricsSettings=<>{current&&<div className="lyrics-import-entry"><button disabled={lyricsBusy||lyricsPending} onClick={()=>{setLyricsReuse(null);setLyricsLocalReuse(null);setLyricsImportItem(current);}}>导入歌词与版本管理</button></div>}{lyricsBundle?<LyricsControls key={`${lyricsKey}:${lyricsBundle.revision}:${lyricsBundle.sourceSetFingerprint}`} bundle={lyricsBundle} busy={lyricsBusy} pending={lyricsPending} error={lyricsError} save={preference=>void saveLyrics(preference)} retry={()=>void saveLyrics(undefined,true)} reload={()=>setLyricsRevision(value=>value+1)}/>:<div className="lyrics-settings">{lyricsError&&<p role="alert">{lyricsError}</p>}{lyricsPending&&<button disabled={lyricsBusy} onClick={()=>void saveLyrics(undefined,true)}>核对上次保存结果</button>}<button disabled={lyricsBusy||lyricsLoading} onClick={()=>setLyricsRevision(value=>value+1)}>重新读取歌词</button></div>}</>;
  const lyricsDisplayProps={contextKey:currentId??'',document:lyrics,secondary:secondaryLyrics,offsetMs:lyricsBundle?.offsetMs??0,secondaryOffsetMs:lyricsBundle?.secondaryOffsetMs??0,fontSize:lyricsBundle?.preference.fontSize??20,activeLine,loading:lyricsLoading,canSeek:playback.state==='playing'||playback.state==='paused',seek:(position:number)=>{if(currentId)void queueAction(()=>window.music.seek(position,currentId));}};
  useEffect(()=>{
    if(!showDetail)return;
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!document.querySelector('[role="dialog"]'))closeDetail();};
    window.addEventListener('keydown',close);
    return ()=>window.removeEventListener('keydown',close);
  },[showDetail]);
  function openDetail(panel?:'lyrics'|'queue'|'both'):void {
    if(!showDetail)detailOrigin.current=document.activeElement instanceof HTMLElement?document.activeElement:null;
    setShowNavigation(false);setShowLyrics(false);setShowQueue(false);
    // Keep an in-flight metadata change and its review state intact.
    if(!metadataBusy||metadataSearching)closeMetadata();
    if(panel)setDetailPanel(panel);
    setShowDetail(true);
  }
  function closeDetail():void {
    exitDetailFullscreen();
    setShowDetail(false);
    requestAnimationFrame(()=>{
      const origin=detailOrigin.current;detailOrigin.current=null;
      if(origin?.isConnected&&!origin.closest('[inert]'))origin.focus();
      else document.querySelector<HTMLButtonElement>('.player-detail-button')?.focus();
    });
  }
  function exitDetailFullscreen():void {
    if(document.fullscreenElement?.classList.contains('app-shell'))void document.exitFullscreen().catch(()=>{});
  }
  function switchDetailPanel(panel:'lyrics'|'queue'|'both',focus=false):void {
    setDetailPanel(panel);
    if(focus)document.getElementById(`detail-${panel}-tab`)?.focus();
  }
  function detailTabKey(event:React.KeyboardEvent<HTMLDivElement>):void {
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();
    const panels=['lyrics','queue','both'] as const,index=panels.indexOf(detailPanel);
    switchDetailPanel(event.key==='Home'?panels[0]:event.key==='End'?panels[2]:panels[(index+(event.key==='ArrowRight'?1:2))%panels.length],true);
  }
  const selectedSmartPlaylist=view==='playlists'&&smartPlaylist?.id===facet?smartPlaylist:null;
  useEffect(()=>{smartOpenEpoch.current++;},[view,facet]);
  useEffect(()=>{if(view!=='playlists'||smartPlaylist?.id!==facet)return;let alive=true;void window.music.smartPlaylist(facet).then(raw=>{const value=readSmartPlaylistDetail(raw);if(alive)setSmartPlaylist(value);}).catch(e=>{if(alive)setError(String(e instanceof Error?e.message:e));});return()=>{alive=false;};},[view,facet,revision]);
  const selectedPlaylist=playlists.find(playlist=>playlist.id===facet);
  const title = view==='albumGroups'?(facet||'专辑概念'):view==='playlists'?(selectedPlaylist?.name??selectedSmartPlaylist?.name??'我的歌单'):facet || nav.find(item => item.id === view)?.label || '全部音乐';
  const activeScan = scan?.phase === 'running';

  async function addFolder(): Promise<void> {
    setError('');setBusy(true);
    try { await window.music.addFolder(); setRevision(value => value+1); }
    catch (e) {setError(e instanceof Error ? e.message : String(e));}
    finally {setBusy(false);}
  }

  async function play(item: LibraryItem): Promise<void> {
    setError('');
    try {
      setSelectedItem(item);
      setPlayback(item.playlistEntryId&&selectedPlaylist?
        await window.music.playPlaylist(selectedPlaylist.id,item.playlistEntryId,selectedPlaylist.revision,queueCommand()):
        await window.music.playBrowse(browse.playRequest(item,queueCommand())));
      setQueue(await window.music.queue());
    }
    catch (e) {
      const message=e instanceof Error?e.message:String(e);
      if(!item.playlistEntryId&&message.includes(BROWSE_STALE_ERROR)){browse.retry();setError('曲库已变化，正在刷新列表；请重新选择歌曲播放。');}
      else setError(message);
      void refreshQueue();
    }
  }

  async function playHistory(id:string):Promise<void>{
    const item=await window.music.item(id);
    if(!item?.available||item.cue?.hidden||item.libraryState&&item.libraryState!=='active')throw new Error('历史关联歌曲当前不可播放');
    setSelectedItem(item);
    try{setPlayback(await window.music.play(id,[id],queueCommand()));}
    finally{await refreshQueue();}
  }
  function searchHistory(value:string):void{
    setHistoryDialog(null);closeDetail();setView('all');setFacet('');setFacetId('');setGenreFilter(null);setMusicFilters({});setQuery(value.slice(0,256));setSettledQuery(value.slice(0,256));
  }
  async function playVersion(item:LibraryItem):Promise<void>{
    setVersionsItem(null);setError('');setSelectedItem(item);
    const context:string[]=[];let selected=false;
    for(const row of result.items){
      if(row.catalog?.releaseTrackId===item.catalog?.releaseTrackId){if(!selected){context.push(item.id);selected=true;}}
      else context.push(row.id);
    }
    if(!selected)context.unshift(item.id);context.splice(500);
    try{setPlayback(await window.music.play(item.id,context,queueCommand()));await refreshQueue();}
    catch(e){setError(e instanceof Error?e.message:String(e));await refreshQueue();}
  }

  function catalogDone():void{
    setCatalogItem(null);setArtistItem(null);setReleaseItem(null);setReferencesItem(null);setRecordingItem(null);setShowCatalogHistory(false);setNotice('曲库关联已保存，可在修订记录中查看和撤销');setRevision(value=>value+1);
  }

  function queueCommand():QueueCommand {return {commandId:crypto.randomUUID(),baseRevision:queue.revision};}
  async function refreshQueue():Promise<void> {try{setQueue(await window.music.queue());}catch{/* Preserve the command error. */}}

  async function queueAction(action:()=>Promise<PlaybackState>):Promise<void> {
    setError('');
    try {setPlayback(await action());await refreshQueue();}
    catch(e) {setError(e instanceof Error?e.message:String(e));await refreshQueue();}
  }

  async function queueEdit(action:()=>Promise<QueueView>):Promise<void> {
    if(queueEditing.current)return;
    queueEditing.current=true;setQueueBusy(true);setError('');
    try {setQueue(await action());}
    catch(e) {setError(e instanceof Error?e.message:String(e));await refreshQueue();}
    finally{queueEditing.current=false;setQueueBusy(false);}
  }

  async function jumpDetail(entryId:string):Promise<void>{
    if(queueEditing.current)return;
    queueEditing.current=true;setQueueBusy(true);
    try{await queueAction(()=>window.music.queueJump(entryId,queueCommand()));}
    finally{queueEditing.current=false;setQueueBusy(false);}
  }

  function browseFacet(target: 'artists'|'albums'|'albumGroups'|'genres',value:string,id?:string,role:ArtistRole='performer'):void {
    exitDetailFullscreen();
    setView(target);setFacet(value);setFacetId(id??'');setArtistRole(role);setQuery('');setSettledQuery('');setShowDetail(false);
    // A song reached from a queue may be outside the library's old filters.
    // Opening its credited artist/album is a fresh scope, with exact IDs when
    // available; unrelated ratings, formats and statistical conditions must go.
    setMusicFilters({});setError('');detailOrigin.current=null;
    setGenreFilter(target==='genres'&&id?{ids:[id],operator:'any',descendants:true}:null);
    requestAnimationFrame(()=>document.querySelector<HTMLInputElement>('.topbar input')?.focus());
  }
  async function refreshMedia(withLyrics=true):Promise<void>{
    if(!current||mediaRefreshJobs.current.has(current.fileId)||mediaRefreshJobs.current.size>=2)return;
    const item=current,identity=currentMediaIdentity;mediaRefreshJobs.current.add(item.fileId);
    setRefreshingFiles(new Set(mediaRefreshJobs.current));setError('');setNotice('');
    // A slow or failed cover must not prevent the independent lyrics refresh.
    if(withLyrics)setLyricsRevision(value=>value+1);
    try{
      const image=await loadUsableArtwork(item.id,1024,true);
      setArtworkRevisions(previous=>({...previous,[item.fileId]:(previous[item.fileId]??0)+1}));
      if(currentMediaIdentityRef.current===identity){const message=image?.cacheState==='offline'?'文件暂不可读取，保留已保存封面':image?.cacheState==='stale'?'封面重新读取失败，保留旧缓存':image?'封面已重新读取':'未读取到可显示的本地封面';setNotice(message+(withLyrics?'；歌词已请求刷新':''));}
    }catch(e){if(currentMediaIdentityRef.current===identity)setError(e instanceof Error?e.message:String(e));}
    finally{mediaRefreshJobs.current.delete(item.fileId);setRefreshingFiles(new Set(mediaRefreshJobs.current));}
  }
  async function openSmartPlaylist(id:string):Promise<void>{const epoch=++smartOpenEpoch.current;try{const value=readSmartPlaylistDetail(await window.music.smartPlaylist(id));if(epoch!==smartOpenEpoch.current)return;setSmartPlaylist(value);setView('playlists');setFacet(value.id);setFacetId('');setQuery('');setSettledQuery('');setMusicFilters({});setGenreFilter(null);setError('');}catch(e){if(epoch===smartOpenEpoch.current)setError(String(e instanceof Error?e.message:e));}}
  function smartPlaylistDone(value:SmartPlaylistDetail|null,deletedId?:string):void{setSmartPlaylistDialog(null);setNotice(value?'智能歌单规则已保存':'智能歌单已删除');setRevision(v=>v+1);if(value)void openSmartPlaylist(value.id);else{setSmartPlaylist(old=>old?.id===deletedId?null:old);if(facet===deletedId)setFacet('');}}
  function openPlaylist(playlist:PlaylistSummary):void {smartOpenEpoch.current++;
    setView('playlists');setFacet(playlist.id);setFacetId('');setQuery('');setSettledQuery('');
  }
  async function saveUserState(item:LibraryItem,change:{favorite?:boolean;rating?:number}):Promise<void>{
    setUserBusy(true);setError('');
    try{
      const state=await window.music.setUserState({itemId:item.id,...change,baseRevision:item.userRevision,commandId:crypto.randomUUID()});
      const update=(value:LibraryItem)=>value.id===item.id?{...value,favorite:state.favorite,rating:state.rating,userRevision:state.revision}:value;
      setQueue(previous=>({...previous,items:previous.items.map(update)}));
      setSelectedItem(previous=>previous?update(previous):null);
      setRevision(value=>value+1);
    }catch(e){setError(e instanceof Error?e.message:String(e));setRevision(value=>value+1);}
    finally{setUserBusy(false);}
  }
  async function editPlaylist(action:PlaylistEditRequest):Promise<void>{
    setUserBusy(true);setError('');
    try{
      const updated=await window.music.editPlaylist(action);
      if(updated)setPlaylists(previous=>previous.map(value=>value.id===updated.id?updated:value));
      setNotice('歌单已保存');
    }catch(e){setError(e instanceof Error?e.message:String(e));setRevision(value=>value+1);}
    finally{setUserBusy(false);}
  }
  function playlistDone(updated:PlaylistSummary|null,message:string):void{
    if(updated)setPlaylists(previous=>[...previous.filter(value=>value.id!==updated.id),updated]);
    else if(playlistDialog?.playlist){setPlaylists(previous=>previous.filter(value=>value.id!==playlistDialog.playlist!.id));setFacet('');}
    if(updated&&playlistDialog?.kind==='create')openPlaylist(updated);
    setPlaylistDialog(null);setNotice(message);setRevision(value=>value+1);
  }

  function selectCandidate(value: MetadataCandidate, target=reviewItem,lockedFields=match?.lockedFields??[]): void {
    setCandidateToken(value.token);
    if (!target) return;
    setAcceptedFields((['title','artist','album'] as MetadataField[]).filter(field=>value[field] && value[field]!==target[field]&&!lockedFields.includes(field)&&!(field==='artist'&&target.catalog?.creditConfirmed)));
  }

  function cancelMetadataSearch():void{
    const request=metadataRequest.current;metadataRequest.current=null;if(request){void window.music.cancelMetadataMatch(request.id).catch(()=>{});if(request.searching)setMetadataBusy(false);}setMetadataSearching(false);
  }
  function closeMetadata():void{cancelMetadataSearch();setMatch(null);setMatchItem(null);setAcceptedFields([]);setShowMetadata(false);}
  async function changeMetadataNetwork(enabled:boolean):Promise<void>{if(metadataNetworkAction.current)return;metadataNetworkAction.current=true;setMetadataNetworkBusy(true);cancelMetadataSearch();setMatch(null);setAcceptedFields([]);setError('');try{await window.music.setMetadataNetworkEnabled(enabled);setMetadataNetwork(await window.music.metadataNetworkState());}catch(e){setError(String(e));}finally{metadataNetworkAction.current=false;setMetadataNetworkBusy(false);}}
  async function clearMetadataNetwork():Promise<void>{if(metadataNetworkAction.current)return;metadataNetworkAction.current=true;setMetadataNetworkBusy(true);cancelMetadataSearch();setMatch(null);setAcceptedFields([]);setError('');try{await window.music.clearMetadataNetworkCache();setMetadataNetwork(await window.music.metadataNetworkState());setNotice('候选缓存已清除，曲库资料保留。');}catch(e){setError(String(e));}finally{metadataNetworkAction.current=false;setMetadataNetworkBusy(false);}}
  useEffect(()=>{
    const reviewed=matchRef.current;if(!reviewed)return;let alive=true;
    const invalidate=()=>{const current=matchRef.current;if(alive&&current?.itemId===reviewed.itemId&&current.fingerprint===reviewed.fingerprint&&current.revision===reviewed.revision){cancelMetadataSearch();setMatch(null);setAcceptedFields([]);setNotice('歌曲资料已变化，请重新匹配。');}};
    void window.music.metadataReviewState(reviewed.itemId).then(state=>{if(state.fingerprint!==reviewed.fingerprint||state.revision!==reviewed.revision)invalidate();}).catch(invalidate);
    return()=>{alive=false;};
  },[revision]);
  useEffect(()=>()=>{const request=metadataRequest.current;if(request)void window.music.cancelMetadataMatch(request.id).catch(()=>{});},[]);
  useEffect(()=>{if(!showMetadata)return;const timer=setInterval(()=>setMetadataNow(Date.now()),5000);return()=>clearInterval(timer);},[showMetadata]);
  useEffect(()=>{if(match?.candidates.some(value=>value.expiresAt&&Date.parse(value.expiresAt)<=metadataNow)){cancelMetadataSearch();setMatch(null);setAcceptedFields([]);setNotice('候选预览已过期，请重新搜索。');}},[metadataNow,match]);
  async function openMetadata(): Promise<void> {
    cancelMetadataSearch();setShowLyrics(false);setShowMetadata(true);setMatch(null);setMatchItem(null);setLastChange('');setError('');
    try {const [contact,network]=await Promise.all([window.music.metadataContact(),window.music.metadataNetworkState()]);setMetadataContact(contact);setMetadataNetwork(network);}
    catch(e) {setError(String(e));}
  }
  async function searchMetadata(fresh=false,recordingId?:string,isrc?:string):Promise<void>{
    if(!metadataItem||metadataNetwork?.enabled===false||metadataNetworkAction.current)return;cancelMetadataSearch();const target=metadataItem,requestId=crypto.randomUUID();metadataRequest.current={id:requestId,searching:true};
    setMetadataBusy(true);setMetadataSearching(true);setError('');setMatch(null);setMatchItem(target);setLastChange('');setAcceptedFields([]);
    try{if(metadataContact.trim())await window.music.setMetadataContact(metadataContact.trim());if(metadataRequest.current?.id!==requestId)return;
      const found=await window.music.metadataMatch(target.id,requestId,fresh,recordingId,isrc);if(metadataRequest.current?.id!==requestId)return;
      const context=await window.music.metadataReviewState(target.id);if(metadataRequest.current?.id!==requestId)return;
      if(context.fingerprint!==found.fingerprint||context.revision!==found.revision)throw new Error('歌曲资料已变化，请重新匹配。');
      setMatch(found);if(found.candidates[0])selectCandidate(found.candidates[0],target,found.lockedFields??[]);
    }catch(e){if(metadataRequest.current?.id===requestId)setError(e instanceof Error?e.message:String(e));}
    finally{if(metadataRequest.current?.id===requestId){metadataRequest.current.searching=false;setMetadataSearching(false);setMetadataBusy(false);}}
  }

  async function applyMetadata(): Promise<void> {
    if (!match || !candidate || !acceptedFields.length) return;
    setMetadataBusy(true);setError('');
    try {
      const change=await window.music.metadataApply({itemId:match.itemId,revision:match.revision,token:candidate.token,fields:acceptedFields});
      setLastChange(change.changeId);setMatch(null);setRevision(value=>value+1);
      const updated=await window.music.item(match.itemId).catch(()=>null);
      if(updated){setMatchItem(current=>current?.id===match.itemId?updated:current);setSelectedItem(current=>current?.id===match.itemId?updated:current);}
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {setMetadataBusy(false);}
  }

  function undoMetadata():void{if(lastChange)setUndoReview(lastChange);}

  return <div className={`app-shell ${compact&&showNavigation?'navigation-open':''}`}>
    <aside id="music-navigation" className="sidebar" ref={sidebarRef} inert={showDetail||compact&&!showNavigation} role={compact&&showNavigation?'dialog':undefined} aria-modal={compact&&showNavigation?true:undefined} aria-label="音乐库导航与设置" onClickCapture={event=>{if(compact&&(event.target as HTMLElement).closest('button'))setShowNavigation(false);}} onKeyDown={event=>{if(compact&&showNavigation)trap(event,sidebarRef.current,()=>setShowNavigation(false));}}>
      <button className="navigation-close" aria-label="关闭音乐库导航" onClick={()=>setShowNavigation(false)}>关闭导航 ×</button>
      <div className="brand"><div className="brand-mark"><span></span><span></span><span></span></div><div><strong>Aural</strong><small>你的私人音乐库</small></div></div>
      <div className="side-caption">音乐库</div>
      <nav aria-label="音乐库导航">{nav.map(item => <button key={item.id} className={`nav-item ${view===item.id||(item.id==='albums'&&view==='albumGroups')?'active':''}`} onClick={() => {smartOpenEpoch.current++;setView(item.id);setFacet('');setFacetId('');setGenreFilter(null);setArtistRole('performer');}}><span className="nav-icon">{item.icon}</span><span>{item.label}</span></button>)}</nav>
      <div className="side-caption roots-caption">音乐目录</div>
      <div className="roots-list">{roots.length===0?<p className="roots-empty">还没有添加目录</p>:roots.map(root => <div className="root-line" key={root.id}><button title={root.path} className={`root-item ${view==='folders'&&facet===root.id?'chosen':''}`} onClick={() => {setView('folders');setFacet(root.id);}}><span className="root-dot" data-status={root.status}></span><span>{root.path.split(/[\\/]/).filter(Boolean).pop()}</span></button><button className="root-rescan" aria-label={`重新扫描 ${root.path.split(/[\\/]/).filter(Boolean).pop()}`} title="重新扫描目录" disabled={root.status==='scanning'} onClick={()=>void window.music.rescanRoot(root.id).catch(e=>setError(String(e)))}>↻</button></div>)}</div>
      <button className="add-folder" disabled={busy} onClick={() => void addFolder()}><span>＋</span> 添加音乐目录</button>
      <button className="add-folder" onClick={()=>void window.music.pickDesktopFiles().catch(e=>setError(String(e)))}><span>↗</span> 打开音乐文件</button>
      <button className="add-folder" onClick={()=>setShowProviders(true)}><span>◎</span> 数据源设置</button>
      <button className="add-folder" onClick={()=>setHistoryDialog({})}><span>◷</span> 播放历史与统计</button>
      <button className="add-folder" onClick={()=>openCatalogBackup()}><span>▣</span> 曲库备份</button>
      <button className="add-folder" onClick={()=>setRestoreOpen(true)}><span>↺</span> 曲库恢复</button>
      <button className="add-folder" onClick={()=>setShowAppearance(true)}><span>◐</span> 外观与缩放</button>
      <button className="add-folder" onClick={()=>void window.music.desktopSettings().catch(e=>setError(String(e)))}><span>◇</span> 窗口与托盘</button>
      <button className="add-folder" onClick={()=>void window.music.windowPlacementSettings().catch(e=>setError(String(e)))}><span>▣</span> 窗口位置与显示器</button>
      <button className="add-folder" onClick={()=>void window.music.systemMediaSettings().catch(e=>setError(String(e)))}><span>♫</span> 系统媒体面板</button>
      <button className="add-folder" onClick={()=>void window.music.mediaKeySettings().catch(e=>setError(String(e)))}><span>⌨</span> 媒体快捷键</button>
      <div className="sidebar-footer"><span className="status-light"></span> 本地优先 · 原型版 {RELEASE.appVersion}</div>
    </aside>

    <main className="main-panel" inert={showDetail||compact&&showNavigation}>
      <header className="topbar"><button className="navigation-toggle" aria-label="打开音乐库导航" aria-controls="music-navigation" aria-expanded={compact&&showNavigation} onClick={()=>setShowNavigation(true)}>☰</button><div className="search-wrap"><span className="search-icon">⌕</span><input aria-label="搜索音乐" placeholder="搜索歌曲、歌手、专辑；支持拼音和首字母" value={query} onChange={event => setQuery(event.target.value.slice(0,256))} /><kbd>搜索</kbd></div><div className="top-actions"><span className="library-count">{stats.tracks.toLocaleString()} 首音乐</span><button className={`lyrics-toggle ${showQueue?'selected':''}`} onClick={() => {setShowLyrics(false);closeMetadata();setShowQueue(value=>!value);}}>{showQueue?'关闭队列':'队列'}</button><button className={`lyrics-toggle ${showMetadata?'selected':''}`} onClick={() => {setShowQueue(false);showMetadata?closeMetadata():void openMetadata();}}>{showMetadata?'关闭匹配':'元数据'}</button><button className={`lyrics-toggle ${showLyrics?'selected':''}`} onClick={() => {setShowQueue(false);closeMetadata();setShowLyrics(value=>!value);}}>{showLyrics?'关闭歌词':'歌词'}</button><button className="lyrics-toggle" onClick={()=>{setSavedLyricsThisItem(false);setShowSavedLyrics(true);}}>用户歌词</button><button className="lyrics-toggle" onClick={()=>setShowScanTasks(true)}>任务</button><button className="circle-action" title="添加目录" onClick={() => void addFolder()}>＋</button></div></header>
      <SearchIndexNotice/>

      {(error || (playback.state==='error' && playback.message)) && <div className="error-banner" role="alert"><span>{error || playback.message}</span>{error && <button onClick={() => setError('')}>关闭</button>}</div>}
      {notice&&<div className="collection-notice" role="status">{notice}<button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>}
      {scan && <div className={`scan-banner ${scan.phase}`}><span className="scan-bullet"></span><span>{scan.phase==='queued'?'扫描等待中':activeScan?`正在扫描${scan.stage?.startsWith('verification-')?' · 完成前对账':''} · 已检查 ${scan.scanned} 次，更新 ${scan.imported} 个文件／轨目`:scan.phase==='complete'?`扫描完成${scan.errors?`，${scan.errors} 项异常可在任务中心查看`:''}`:scan.phase==='cancelled'?'扫描已取消，已导入内容与检查点保留':scan.phase==='interrupted'?'扫描中断，可在任务中心继续':`扫描未完成 · ${scan.message??''}`}</span></div>}

      <div className="content-scroll"><section className="hero"><div className="hero-kicker">YOUR MUSIC, YOUR SPACE</div><h1>{title}</h1><p>{stats.roots===0?'添加一个音乐目录，开始整理你的收藏。':`在 ${stats.albums} 张专辑、${stats.artists} 位歌手之间，找到此刻想听的声音。`}</p><div className="hero-decoration" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div></section>

      {view==='playlists'&&<div className="collection-toolbar"><button onClick={()=>setRuleTransfer({})}>导入／导出音乐规则</button><button onClick={()=>setPlaylistDialog({kind:'create'})}>＋ 创建歌单</button>{selectedPlaylist&&<><button onClick={()=>setPlaylistDialog({kind:'rename',playlist:selectedPlaylist})}>重命名歌单</button><button onClick={()=>setPlaylistDialog({kind:'delete',playlist:selectedPlaylist})}>删除歌单</button><span>{selectedPlaylist.count} 个条目 · 可重复添加</span></>}</div>}
      {view==='playlists'&&!facet&&<SmartPlaylistBrowser revision={revision} onHistory={()=>setSmartHistory({})} onOpen={id=>void openSmartPlaylist(id)} onCreate={()=>setSmartPlaylistDialog({kind:'create',query:{view:'all',filters:{},sort:{mode:'default',direction:'asc'}}})}/>}{view==='playlists'&&!facet&&<div className="playlist-grid">{playlists.length?playlists.map(playlist=><button className="playlist-card" key={playlist.id} onClick={()=>openPlaylist(playlist)}><span>☷</span><strong>{playlist.name}</strong><small>{playlist.count} 首音乐</small></button>):<p className="collection-note">还没有歌单。创建一个歌单，然后用曲目右侧的“＋”添加音乐。</p>}</div>}
      {selectedSmartPlaylist&&<div className="collection-toolbar"><button onClick={()=>setRuleTransfer({initialExport:[{kind:'smart',id:selectedSmartPlaylist.id,revision:selectedSmartPlaylist.revision,name:selectedSmartPlaylist.name}]})}>导出此歌单规则</button><button onClick={()=>setSmartPlaylistDialog({kind:'edit',playlist:selectedSmartPlaylist})}>编辑智能歌单规则</button><button onClick={()=>setSmartPlaylistDialog({kind:'delete',playlist:selectedSmartPlaylist})}>删除智能歌单</button><button onClick={()=>setSmartHistory({playlistId:selectedSmartPlaylist.id})}>规则历史与恢复</button><button onClick={()=>{void openSmartPlaylist(selectedSmartPlaylist.id);setRevision(v=>v+1);}}>重新读取歌单</button><span>{browse.loading?'正在匹配…':`${result.total} 首动态匹配`}</span><p className="collection-note">当前搜索和组合筛选是附加条件，不修改已保存规则；固定添加和手动排列请使用普通歌单。</p></div>}
      {view==='recent'&&<p className="collection-note">按首次导入时间排列。旧版曲库中没有记录添加时间的歌曲会排在后面。</p>}

      <div className="batch-selection-actions"><span>已选择 {batchSelection.length} 首（最多 100 首）</span><button onClick={()=>setBatchSelection(previous=>{const seen=new Set(previous.map(item=>item.id));return [...previous,...result.items.filter(item=>{if(seen.has(item.id))return false;seen.add(item.id);return true;})].slice(0,100);})}>选择已加载歌曲</button><button disabled={!batchSelection.length} onClick={()=>setBatchSelection([])}>清空选择</button><button onClick={()=>setShowBatchReview(true)}>批量元数据审核／记录</button></div>
      <div className="catalog-display">{view!=='playlists'&&<button className="catalog-undo" onClick={()=>setSmartPlaylistDialog({kind:'create',query:{...browseQuery,query}})}>保存为智能歌单</button>}{view!=='playlists'&&<><label>曲目排序<select aria-label="曲目排序" title="发行日期升序按最早可能日期、降序按最晚可能日期；未知日期置后，年／月信息不会当作准确日期。" value={librarySort.mode} onChange={e=>{const mode=e.target.value as LibrarySort['mode'];setLibrarySort({mode,direction:mode==='default'?'asc':mode==='date'||mode==='added'?'desc':'asc'});}}><option value="default">{view==='recent'?'默认加入时间（新到旧）':'默认专辑／碟轨'}</option><option value="title">歌曲名称</option><option value="artist">艺人名称</option><option value="album">专辑名称</option><option value="date">发行日期（保留精度）</option><option value="added">加入时间</option></select></label>{librarySort.mode!=='default'&&<label>方向<select aria-label="曲目排序方向" value={librarySort.direction} onChange={e=>setLibrarySort(old=>({...old,direction:e.target.value as 'asc'|'desc'}))}><option value="asc">从小到大／从早到晚</option><option value="desc">从大到小／从晚到早</option></select></label>}</>}<button className="catalog-undo" aria-haspopup="dialog" onClick={()=>setShowMusicFilters(true)}>组合筛选{musicFilterCount(musicFilters)?` · ${musicFilterCount(musicFilters)}组条件`:''}</button>{musicFilterCount(musicFilters)>0&&<button className="catalog-undo" onClick={()=>setMusicFilters({})}>清除组合条件</button>}{view!=='playlists'&&<label><input type="checkbox" aria-label="折叠同一发行曲目的文件版本" checked={collapseVersions} onChange={event=>{setCollapseVersions(event.target.checked);}}/>折叠文件版本</label>}<button className="catalog-undo" onClick={()=>setShowCatalogHistory(true)}>曲库修订记录</button><button className="catalog-undo" onClick={()=>setShowArtistManager(true)}>艺人资料管理</button><button className="catalog-undo" onClick={()=>setShowGenreManager(true)}>风格管理</button>
      {(view==='albums'||view==='albumGroups')&&<label>专辑视图<select aria-label="专辑视图" value={view} onChange={event=>{setView(event.target.value as View);setFacet('');setFacetId('');}}><option value="albums">具体发行版</option><option value="albumGroups">专辑概念</option></select></label>}</div>
      {view==='artists'&&<label className="catalog-role">作品署名<select aria-label="艺人角色" value={artistRole} onChange={event=>{setArtistRole(event.target.value as ArtistRole);setFacet('');setFacetId('');}}>{Object.entries(roleLabels).map(([role,label])=><option value={role} key={role}>{label}</option>)}</select></label>}
      {view==='genres'&&<GenreBrowser revision={revision} filter={genreFilter??{ids:[],operator:'any',descendants:true}} onManage={()=>setShowGenreManager(true)} onChange={value=>{setGenreFilter(value);setFacet('');setFacetId('');}}/>}
      {(view==='artists'||view==='albums'||view==='albumGroups')&&<CatalogBrowser key={`${view}:${artistRole}`} view={view} role={artistRole} revision={revision+statisticsRevision} filters={musicFilters} selectedId={facetId} selectedName={facet} onSelect={(id,name)=>{setFacet(name);setFacetId(id);}} artworkRevision={artworkRevision}/>}

      {view==='folders'&&roots.length>0&&<section className="facet-section"><div className="section-heading"><h2>目录筛选</h2></div><div className="facet-row"><button className={`facet-chip ${!facet?'selected':''}`} onClick={() => setFacet('')}>全部目录</button>{roots.map(item => <button key={item.id} className={`facet-chip ${facet===item.id?'selected':''}`} onClick={() => setFacet(item.id)}>{item.path.split(/[\\/]/).filter(Boolean).pop()}</button>)}</div></section>}

      {(view!=='playlists'||!!facet)&&<section className="tracks-section"><div className="section-heading"><h2>{settledQuery?`搜索结果 · ${result.total} 首`:'曲目'}</h2><span>{result.total} 首</span></div>
      {(browse.loading||browse.error)&&result.total===0?<div className="browse-feedback" role={browse.error?'alert':'status'}>{browse.error||'正在读取曲库…'}{browse.error&&<button onClick={browse.retry}>重新读取</button>}</div>:result.total===0?<div className="empty-state"><div className="empty-record">♫</div><h3>{stats.roots===0?'让音乐住进这里':settledQuery?'没有找到匹配的音乐':view==='favorites'?'还没有收藏':view==='playlists'?'这个歌单还是空的':'这里还没有曲目'}</h3><p>{stats.roots===0?'选择一个本地音乐文件夹，Aural 会读取标签并建立可搜索的曲库。':settledQuery?'试试更短的关键词，或按歌手、专辑重新查找。':view==='favorites'?'点击曲目旁的心形按钮，将喜欢的音乐保存在这里。':view==='playlists'?'用曲目右侧的“＋”将音乐加入这个歌单。':'目录可能正在扫描，稍后就会显示。'}</p>{stats.roots===0&&<button className="primary-button" onClick={() => void addFolder()}>添加音乐目录</button>}</div>:
       <div className={`track-table ${view==='playlists'?'playlist-table':''}`}><div className="track-header"><span>歌曲</span><span>专辑</span><span>音质</span><span>时长</span><span>操作</span></div><VirtualLibrary key={JSON.stringify(browseQuery)} total={result.total} itemAt={browse.itemAt} range={browse.range} generation={browse.generation} label={`${title}曲目`} renderRow={(item,index) => {
         const active=(playback.itemId===item.id||(view!=='playlists'&&collapseVersions&&Boolean(item.catalog&&current?.catalog&&item.catalog.releaseTrackId===current.catalog.releaseTrackId)))&&(!item.playlistEntryId||queue.entries.find(entry=>entry.id===queue.currentEntryId)?.playlistEntryId===item.playlistEntryId);
         return <div key={item.playlistEntryId??item.id} className={`track-row ${active?'is-playing':''} ${!item.available?'unavailable':''}`} data-entry-id={item.playlistEntryId} data-item-id={item.id}>
         <label className="track-select"><input type="checkbox" aria-label={`选择审核 ${item.title}`} checked={batchSelection.some(value=>value.id===item.id)} disabled={batchSelection.length>=100&&!batchSelection.some(value=>value.id===item.id)} onChange={event=>setBatchSelection(values=>event.target.checked?values.some(value=>value.id===item.id)?values:[...values,item]:values.filter(value=>value.id!==item.id))}/></label>
         <button className="track-play" onClick={()=>void play(item)} disabled={!item.available} aria-label={`播放 ${item.title}`} title={`${item.path}${item.searchMatch?`\n匹配：${({'title-exact':'标题精确','artist-exact':'歌手精确','prefix':'前缀','substring':'原文子串','alias-or-pinyin':'署名或拼音','normalized':'字母规范化','spelling':'英文近似拼写'} as const)[item.searchMatch.kind]}${item.searchMatch.kind==='spelling'?`（${item.searchMatch.distance??0}处编辑差异）`:''}`:''}${view==='recent'?`\n添加时间：${item.addedAt??'未记录'}`:''}`}><span className="track-main"><span className="track-num">{active&&playback.state==='playing'?'▶':String(item.playlistPosition!==undefined?item.playlistPosition+1:index+1).padStart(2,'0')}</span><Artwork item={item} revision={artworkRevision(item)} className="track-art"/><span className="track-names"><strong>{item.title}</strong><small>{item.artist}{item.searchMatch?.kind==='spelling'&&<em> 近似匹配</em>}{item.searchMatch?.kind==='normalized'&&<em> 字母匹配</em>}{item.kind==='cue'&&<em> CUE</em>}{!item.available&&<em> 不可用</em>}</small></span></span><span className="row-album">{item.catalog?.releaseTitle??item.album}</span><span className="row-codec">{item.codec.toUpperCase()}{item.sampleRate?` · ${(item.sampleRate/1000).toFixed(1)}k`:''}</span><span className="row-duration">{formatTime(item.durationSeconds)}</span></button>
         <div className="track-actions">{view!=='playlists'&&(item.versionCount??1)>1&&<button className="catalog-version-button" aria-label={`选择版本 ${item.title}`} onClick={()=>setVersionsItem(item)}>{item.versionCount} 版本</button>}<button aria-label={`整理关联 ${item.title}`} title="整理曲库关联" onClick={()=>setCatalogItem(item)}>⇄</button><button aria-label={`${item.favorite?'取消收藏':'收藏'} ${item.title}`} aria-pressed={item.favorite} className={item.favorite?'active':''} disabled={userBusy} onClick={()=>void saveUserState(item,{favorite:!item.favorite})}>{item.favorite?'♥':'♡'}</button><button aria-label={`加入歌单 ${item.title}`} title="加入歌单" onClick={()=>setPlaylistDialog({kind:'add',item})}>＋</button>
         <button aria-label={`管理音乐文件 ${item.title}`} onClick={()=>setFilePolicyFileId(item.fileId)}>文件</button>
         {item.playlistEntryId&&selectedPlaylist&&<><button aria-label={`上移 ${item.title}`} disabled={userBusy||item.playlistPosition===0} onClick={()=>void editPlaylist({action:'move',playlistId:selectedPlaylist.id,entryId:item.playlistEntryId!,direction:-1,baseRevision:selectedPlaylist.revision,commandId:crypto.randomUUID()})}>↑</button><button aria-label={`下移 ${item.title}`} disabled={userBusy||item.playlistPosition===selectedPlaylist.count-1} onClick={()=>void editPlaylist({action:'move',playlistId:selectedPlaylist.id,entryId:item.playlistEntryId!,direction:1,baseRevision:selectedPlaylist.revision,commandId:crypto.randomUUID()})}>↓</button><button aria-label={`从歌单移除 ${item.title}`} onClick={()=>void editPlaylist({action:'remove',playlistId:selectedPlaylist.id,entryId:item.playlistEntryId!,baseRevision:selectedPlaylist.revision,commandId:crypto.randomUUID()})} disabled={userBusy}>×</button></>}
         </div></div>;
       }}/></div>}
      {browse.error&&result.total>0&&<div className="browse-feedback" role="alert">{browse.error}<button onClick={browse.retry}>重新读取</button></div>}<p className="collection-note">滚动浏览全部结果；点击歌曲会建立从该曲目所在范围开始、最多 500 首的播放队列。</p></section>}
      <footer className="main-footer">当前阶段已实现本地导入、分类、检索和 FLAC/WAV/MP3 播放原型。ASIO、DSD 与位完美输出仍待实机验证。</footer></div>
      {showLyrics&&<aside className="lyrics-panel" aria-label="歌词面板"><div className="lyrics-head"><div><small>NOW PLAYING</small><h2>{current?.title??'本地歌词'}</h2><p>{current?.artist??'选择一首音乐'}</p></div><button aria-label="关闭歌词" onClick={() => setShowLyrics(false)}>×</button></div>{lyricsSettings}<LyricsDisplay {...lyricsDisplayProps} compact/><div className="lyrics-foot">{lyricsSource(lyrics)}</div></aside>}
      {showQueue&&<aside className="queue-panel" aria-label="播放队列"><div className="queue-head"><div><small>UP NEXT</small><h2>播放队列</h2><p>{queue.entries.length} 首 · 重启后保留</p></div><button aria-label="关闭队列" onClick={()=>setShowQueue(false)}>×</button></div><div className="queue-options"><button className={queue.shuffle?'active':''} onClick={()=>void queueEdit(()=>window.music.setShuffle(!queue.shuffle,queueCommand()))}>{queue.shuffle?'随机播放 · 开':'随机播放 · 关'}</button><button onClick={()=>{const modes:RepeatMode[]=['off','all','one'];void queueEdit(()=>window.music.setRepeat(modes[(modes.indexOf(queue.repeat)+1)%modes.length],queueCommand()));}}>{queue.repeat==='off'?'顺序播放':queue.repeat==='all'?'列表循环':'单曲循环'}</button></div><div className="queue-body">{queue.entries.length===0?<p className="queue-empty">点击一首歌曲后，当前列表会成为播放队列。</p>:queue.entries.map((entry,index)=>{const item=queue.items.find(value=>value.id===entry.itemId);return <div key={entry.id} className={`queue-entry ${entry.id===queue.currentEntryId?'current':''}`}><button className="queue-song" onClick={()=>void queueAction(()=>window.music.queueJump(entry.id,queueCommand()))}><span>{String(index+1).padStart(2,'0')}</span><strong>{item?.title??'曲目已移除'}</strong><small>{item?.artist??''}</small></button><div className="queue-entry-actions"><button title="上移" disabled={index===0} onClick={()=>void queueEdit(()=>window.music.queueMove(entry.id,-1,queueCommand()))}>↑</button><button title="下移" disabled={index===queue.entries.length-1} onClick={()=>void queueEdit(()=>window.music.queueMove(entry.id,1,queueCommand()))}>↓</button><button title="移出队列" disabled={entry.id===queue.currentEntryId} onClick={()=>void queueEdit(()=>window.music.queueRemove(entry.id,queueCommand()))}>×</button></div></div>;})}</div><div className="queue-foot">队列与播放模式自动保存；重启后需手动继续播放。</div></aside>}
      {showMetadata&&<aside className="metadata-panel" aria-label="元数据面板"><div className="metadata-head"><div><small>MUSICBRAINZ</small><h2>匹配元数据</h2><p>{reviewItem?`${reviewItem.title} · ${reviewItem.artist}`:'先选择一首曲目'}</p></div><button aria-label="关闭元数据" disabled={metadataBusy&&!metadataSearching} onClick={closeMetadata}>×</button></div><div className="metadata-body"><label className="contact-label">公开维护者联系信息<input aria-label="MusicBrainz 联系信息" value={metadataContact} onChange={event=>setMetadataContact(event.target.value)} placeholder="邮箱或 HTTPS 项目网址" /></label><p className="metadata-note">MusicBrainz 要求应用提供可联系的标识。仅发送本次查询使用的曲名、歌手或选定录音标识／编码，不发送文件路径或音频。</p><MetadataNetworkControls state={metadataNetwork} busy={metadataBusy||metadataNetworkBusy||fingerprintWorking} searching={metadataSearching} now={metadataNow} cancel={()=>{cancelMetadataSearch();setMatch(null);setAcceptedFields([]);setNotice('搜索已取消。');}} toggle={enabled=>void changeMetadataNetwork(enabled)} clear={()=>void clearMetadataNetwork()}/><button className="release-refresh" disabled={!reviewItem||metadataBusy} onClick={()=>reviewItem&&setSourceTarget({itemId:reviewItem.id})}>查看来源与字段锁</button><button className="release-refresh" disabled={!reviewItem||metadataBusy} onClick={()=>reviewItem&&setTagWriteItem(reviewItem.id)}>文件标签预览</button><button className="metadata-primary" disabled={!reviewItem||metadataBusy||metadataNetworkBusy||fingerprintWorking||!metadataNetwork?.enabled} onClick={()=>void searchMetadata()}>{metadataBusy?'正在处理…':'搜索候选'}</button><button className="metadata-link" disabled={!reviewItem||metadataBusy||metadataNetworkBusy||fingerprintWorking||!metadataNetwork?.enabled} onClick={()=>void searchMetadata(true)}>跳过缓存重新搜索</button><MetadataFingerprintPanel item={metadataItem??reviewItem} disabled={metadataBusy||metadataNetworkBusy} networkEnabled={metadataNetwork?.enabled===true} onBusy={setFingerprintWorking} onConfigure={()=>setShowProviders(true)} onPrepare={async()=>{cancelMetadataSearch();setMatch(null);setMatchItem(metadataItem??null);setLastChange('');setAcceptedFields([]);if(metadataContact.trim())await window.music.setMetadataContact(metadataContact.trim());}} onMatch={found=>{setMatch(found);setMatchItem(found.item??metadataItem??null);setAcceptedFields([]);setCandidateToken('');setLastChange('');}}/>{match&&<><MetadataRecordingLookup key={match.requestId} match={match} busy={metadataBusy||metadataNetworkBusy||!metadataNetwork?.enabled} onChoose={id=>void searchMetadata(false,id)}/><MetadataISRCChoice key={`isrc:${match.requestId}`} match={match} busy={metadataBusy||metadataNetworkBusy||!metadataNetwork?.enabled} onChoose={code=>void searchMetadata(false,undefined,code)}/><div className="metadata-subtitle">候选结果 · {match.candidates.length}{match.cacheHit?' · 来自短期缓存':''}</div>{match.candidates.length===0?<p className="metadata-note">{match.isrcLookup?.requiresChoice?'歌名不足，请明确选择录音编码查询。':match.isrcLookup?.selectedCode?'该编码没有返回候选，保留当前资料；可重新按歌名搜索。':match.recordingLookup?.requiresChoice?'存在多个已确认录音，请先选择本次读取的标识。':'没有找到候选，请检查本地标签或已确认录音标识后重试。'}</p>:<><div className="candidate-list">{match.candidates.map(value=><button key={value.token} className={`candidate-card ${candidateToken===value.token?'chosen':''}`} onClick={()=>selectCandidate(value)}><strong>{value.title}</strong><span>{value.artist}</span><small>{value.album??'未关联发行版'}{value.date?` · ${value.date}`:''} · 匹配排序 {value.score}</small></button>)}</div>{candidate&&<><MetadataMatchReasons candidate={candidate}/>{match.fingerprint&&<MetadataReleaseContextPanel key={`context:${candidate.token}`} itemId={match.itemId} fingerprint={match.fingerprint} candidate={candidate} networkEnabled={metadataNetwork?.enabled===true} onReview={setReleaseFieldsReview} onAlbumReview={setAlbumReview}/>} {match.fingerprint&&<MetadataEditionsPanel itemId={match.itemId} fingerprint={match.fingerprint} candidate={candidate} networkEnabled={metadataNetwork?.enabled===true} onSelect={value=>{setMatch(previous=>previous?{...previous,candidates:[...previous.candidates.filter(entry=>entry.token!==value.token).slice(-39),value]}:previous);selectCandidate(value);}}/>}{match.fingerprint&&<CoverArtSourcePanel key={`cover:${candidate.token}`} itemId={match.itemId} fingerprint={match.fingerprint} candidate={candidate} networkEnabled={metadataNetwork?.enabled===true} onProviders={()=>setShowProviders(true)}/>}<button className="metadata-primary" disabled={metadataBusy||metadataNetworkBusy||!metadataNetwork?.enabled} onClick={()=>match&&setCreditReview({itemId:match.itemId,token:candidate.token})}>读取并审核完整艺人署名</button><div className="metadata-subtitle">确认字段差异</div>{(['title','artist','album'] as MetadataField[]).map(field=>{const incoming=candidate[field];return incoming&&reviewItem?<label key={field} className="metadata-diff"><input type="checkbox" disabled={incoming===reviewItem[field]||match.lockedFields?.includes(field)||field==='artist'&&reviewItem.catalog?.creditConfirmed} checked={acceptedFields.includes(field)} onChange={event=>setAcceptedFields(previous=>event.target.checked?[...previous,field]:previous.filter(value=>value!==field))} /><span><b>{field==='title'?'歌名':field==='artist'?'歌手':'专辑'}</b><small>{reviewItem[field]} → {incoming}{match.lockedFields?.includes(field)?' · 字段已锁定':field==='artist'&&reviewItem.catalog?.creditConfirmed?' · 使用已确认署名，请在完整审核中修改':''}</small></span></label>:null;})}<button className="metadata-primary" disabled={!acceptedFields.length||metadataBusy||metadataNetwork?.retentionMode!=='reviewed'} onClick={()=>void applyMetadata()}>确认更新曲库</button><p className="metadata-note">仅修改曲库展示值，可撤销；不会写入音乐文件。<button className="metadata-link" onClick={()=>void window.music.openMetadataSource(candidate.sourceUrl).catch(e=>setError(String(e)))}>查看 MusicBrainz 来源</button></p></>}</>}</>}{lastChange&&<div className="metadata-success">曲库元数据已更新。<button disabled={metadataBusy} onClick={()=>void undoMetadata()}>撤销本次修改</button></div>}</div></aside>}
    </main>

    {restoreOpen&&<CatalogRestoreDialog onClose={()=>setRestoreOpen(false)}/>}
    {showMusicFilters&&<MusicFiltersDialog value={musicFilters} revision={revision} previewQuery={browseQuery} scopeLabel={title} onClose={()=>setShowMusicFilters(false)} onApply={value=>{setMusicFilters(value);setShowMusicFilters(false);}}/>}
    {undoReview&&<MetadataUndoDialog changeId={undoReview} onClose={()=>setUndoReview(null)} onDone={result=>{if(!result.remaining?.length&&lastChange===undoReview)setLastChange('');setRevision(value=>value+1);setSelectedItem(null);}}/>}
    {showBatchReview&&<MetadataBatchDialog items={batchSelection} initialBatchId={batchInitialId} onClose={()=>{setShowBatchReview(false);setBatchInitialId(undefined);}} onChanged={()=>setRevision(value=>value+1)}/>}
    {showDetail&&<section id="playback-detail" className="detail-view" aria-label="播放详情">
      <header className="detail-header"><div><small>NOW PLAYING</small><h2>播放详情</h2></div><div className="detail-header-actions"><button className="detail-refresh" disabled={!current} onClick={()=>current&&setHistoryDialog({itemId:current.id})}>此曲播放记录</button><button className="detail-refresh" disabled={!current||mediaRefreshBlocked} onClick={()=>void refreshMedia()}>{mediaRefreshing?'正在读取…':'重新读取封面与歌词'}</button><button className="detail-close" autoFocus aria-label="关闭播放详情" onClick={closeDetail}>×</button></div></header>
      {currentInfo.loading&&!current&&<p className="detail-notice" role="status">正在读取歌曲信息…</p>}
      {currentInfo.error&&<div className="detail-error" role="alert">{currentInfo.error}<button className="detail-refresh" onClick={()=>setRevision(value=>value+1)}>重新读取歌曲信息</button></div>}
      {currentId&&!currentInfo.loading&&!currentInfo.error&&!current&&<p className="detail-notice" role="status">这首歌曲已不在曲库中，可从播放列表选择其他歌曲。</p>}
      {playback.interruption&&<p className="detail-notice" role="status">{playback.message}</p>}
      {notice&&<p className="detail-notice" role="status">{notice}</p>}
      {(error||(playback.state==='error'&&playback.message))&&<div className="detail-error" role="alert">{error||playback.message}</div>}
      <div className="detail-toolbar"><div className="detail-panel-switch" role="tablist" aria-label="详情内容" onKeyDown={detailTabKey}><button id="detail-lyrics-tab" role="tab" tabIndex={detailPanel==='lyrics'?0:-1} aria-controls="detail-lyrics-panel" aria-selected={detailPanel==='lyrics'} className={detailPanel==='lyrics'?'active':''} onClick={()=>switchDetailPanel('lyrics')}>歌词</button><button id="detail-queue-tab" role="tab" tabIndex={detailPanel==='queue'?0:-1} aria-controls="detail-queue-panel" aria-selected={detailPanel==='queue'} className={detailPanel==='queue'?'active':''} onClick={()=>switchDetailPanel('queue')}>播放列表 · {queue.entries.length}</button><button id="detail-both-tab" role="tab" tabIndex={detailPanel==='both'?0:-1} aria-controls="detail-lyrics-panel detail-queue-panel" aria-selected={detailPanel==='both'} className={detailPanel==='both'?'active':''} onClick={()=>switchDetailPanel('both')}>歌词＋列表</button></div><div className="detail-modes"><button disabled={queueBusy} aria-pressed={queue.shuffle} className={queue.shuffle?'active':''} onClick={()=>void queueEdit(()=>window.music.setShuffle(!queue.shuffle,queueCommand()))}>{queue.shuffle?'随机：开':'随机：关'}</button><label>播放模式<select aria-label="播放模式" value={queue.repeat} disabled={queueBusy} onChange={event=>{const mode=event.target.value as RepeatMode;void queueEdit(()=>window.music.setRepeat(mode,queueCommand()));}}><option value="off">顺序播放</option><option value="all">列表循环</option><option value="one">单曲循环</option></select></label></div></div>
      <div className={`detail-grid ${detailPanel==='both'?'detail-grid-both':''}`}><div className="detail-album"><Artwork item={current} revision={artworkRevision(current)} className="detail-art" eager onRetry={()=>void refreshMedia(false)} retrying={mediaRefreshing} retryDisabled={mediaRefreshBlocked}/><h3>{current?.title??(currentInfo.loading?'正在读取歌曲信息…':currentId?'歌曲信息暂不可用':'尚未选择歌曲')}</h3>{current&&<div className="detail-user-actions"><button disabled={userBusy} aria-pressed={current.favorite} onClick={()=>void saveUserState(current,{favorite:!current.favorite})}>{current.favorite?'♥ 已收藏':'♡ 收藏'}</button><button onClick={()=>setPlaylistDialog({kind:'add',item:current})}>＋ 加入歌单</button><button onClick={()=>setCatalogItem(current)}>整理关联</button><button onClick={()=>setSourceTarget({itemId:current.id})}>来源与字段锁</button><button onClick={()=>setVersionsItem(current)}>文件版本</button><button onClick={()=>setFilePolicyFileId(current.fileId)}>文件管理</button>{/\.flac$/i.test(current.path)&&<button onClick={()=>setEmbeddedCueHistoryItemId(current.id)}>内嵌编排历史</button>}<label>评分<select aria-label="歌曲评分" value={current.rating} disabled={userBusy} onChange={event=>void saveUserState(current,{rating:Number(event.target.value)})}><option value={0}>未评分</option>{[1,2,3,4,5].map(rating=><option key={rating} value={rating}>{rating} 星</option>)}</select></label></div>}<SongInformation key={currentId} item={current} browse={browseFacet}/>{current&&<OnlineArtworkControls key={current.id} itemId={current.id}/>}<details key={currentId} className="detail-secondary"><summary>播放与音频信息</summary>{current&&<CueInfo item={current} onHistory={()=>current.cue?.parserVersion?.startsWith('aural-flac-cuesheet-')?setEmbeddedCueHistoryItemId(current.id):setCueHistoryItemId(current.id)}/>}{playback.decodedSource&&playback.itemId===currentId&&<DecoderInfo source={playback.decodedSource}/>}<AsioPlaybackInfo value={playback.itemId===currentId?playback.asio:undefined}/><AsioDsdPlaybackInfo value={playback.itemId===currentId?playback.asioDsd:undefined}/><PlaybackClockInfo clock={playback.itemId===currentId?playback.clock:undefined}/><PlaybackTailInfo tail={playback.itemId===currentId?playback.tail:undefined}/>{playback.itemId===currentId&&<><ProcessingPlanInfo playback={playback}/><PipelinePlanInfo plan={playback.pipelinePlan} acceptance={playback.planAcceptance}/></>}</details><AudioVisualization playback={playback}/><WholeWaveform item={current??null} playback={playback} seek={position=>window.music.seek(position,current?.id)}/></div>
      <div id="detail-lyrics-panel" role="tabpanel" aria-labelledby={detailPanel==='both'?'detail-both-tab':'detail-lyrics-tab'} className="detail-lyrics" hidden={detailPanel==='queue'}><div className="detail-section-heading"><h3>歌词</h3><small>{lyricsSource(lyrics)}</small></div>{lyricsSettings}<LyricsDisplay {...lyricsDisplayProps} visible={detailPanel!=='queue'}/></div>
      <div id="detail-queue-panel" role="tabpanel" aria-labelledby={detailPanel==='both'?'detail-both-tab':'detail-queue-tab'} className="detail-queue" hidden={detailPanel==='lyrics'}><div className="detail-section-heading"><h3>播放列表</h3><small>{queue.entries.length} 首 · {queue.shuffle?'随机顺序':'列表顺序'}</small></div><DetailQueue queue={queue} artworkRevision={artworkRevision} busy={queueBusy} visible={detailPanel!=='lyrics'} jump={entryId=>void jumpDetail(entryId)} move={(entryId,direction)=>void queueEdit(()=>window.music.queueMove(entryId,direction,queueCommand()))} remove={entryId=>void queueEdit(()=>window.music.queueRemove(entryId,queueCommand()))}/></div></div>
    </section>}

    {lyricsImportItem&&<LyricsDocumentsDialog key={`${lyricsImportItem.id}:${lyricsLocalReuse?.summary.id??lyricsReuse?.summary.id??'new'}`} item={lyricsImportItem} covered={showSavedLyrics||showLocalLyricsBrowser} reuseSource={lyricsReuse} reuseLocalSource={lyricsLocalReuse} onBrowseSaved={()=>{setSavedLyricsThisItem(true);setShowSavedLyrics(true);}} onBrowseLocal={()=>{setLocalLyricsThisItem(true);setShowLocalLyricsBrowser(true);}} onClose={()=>{setLyricsImportItem(null);setLyricsReuse(null);setLyricsLocalReuse(null);}} onChanged={()=>setLyricsRevision(value=>value+1)}/>}
    {compact&&showNavigation&&<button className="navigation-backdrop" aria-label="关闭音乐库导航" tabIndex={-1} onClick={()=>setShowNavigation(false)}/>}
    {historyDialog&&<PlaybackHistoryDialog itemId={historyDialog.itemId} onClose={()=>setHistoryDialog(null)} onPlay={playHistory} onSearch={searchHistory}/>}
    {showAppearance&&<AppearanceDialog onClose={()=>setShowAppearance(false)}/>}
    <DesktopFileEntry onTasks={()=>setShowScanTasks(true)}/>
    {showScanTasks&&<ScanTasksDialog onLocate={itemId=>{void window.music.item(itemId).then(item=>{if(!item){setError('歌曲已移除，请重新读取任务记录。');return;}setShowScanTasks(false);setFilePolicyFileId(item.fileId);}).catch(()=>setError('无法读取歌曲，请稍后重新打开任务。'));}} onClose={()=>setShowScanTasks(false)} onWatch={()=>{setShowScanTasks(false);setShowLibraryWatch(true);}} onCues={()=>{setShowScanTasks(false);setCueHistoryItemId(null);}} onFiles={()=>{setShowScanTasks(false);setFilePolicyFileId(null);}}/>}
    {embeddedCueHistoryItemId!==undefined&&<EmbeddedCueHistoryDialog itemId={embeddedCueHistoryItemId} onClose={()=>setEmbeddedCueHistoryItemId(undefined)} onExternal={()=>{setEmbeddedCueHistoryItemId(undefined);setCueHistoryItemId(null);}}/>}
    {cueHistoryItemId!==undefined&&<CueHistoryDialog itemId={cueHistoryItemId} onClose={()=>setCueHistoryItemId(undefined)} onEmbedded={()=>{setCueHistoryItemId(undefined);setEmbeddedCueHistoryItemId(null);}} onTasks={()=>{setCueHistoryItemId(undefined);setShowScanTasks(true);}}/>}
    {filePolicyFileId!==undefined&&<FilePolicyDialog fileId={filePolicyFileId} onClose={()=>setFilePolicyFileId(undefined)} onTasks={()=>{setFilePolicyFileId(undefined);setShowScanTasks(true);}}/>}
    {showLibraryWatch&&<LibraryWatchDialog onClose={()=>setShowLibraryWatch(false)} onTasks={()=>{setShowLibraryWatch(false);setShowScanTasks(true);}}/>}
    {showSavedLyrics&&<SavedLyricsDialog target={lyricsImportItem??metadataItem} initialSameItem={savedLyricsThisItem} onBrowseLocal={()=>{setShowSavedLyrics(false);setLocalLyricsThisItem(false);setShowLocalLyricsBrowser(true);}} onClose={()=>setShowSavedLyrics(false)} onCopy={(target,source)=>{setShowSavedLyrics(false);setLyricsImportItem(target);setLyricsLocalReuse(null);setLyricsReuse(source);}}/>}
    {showLocalLyricsBrowser&&<LocalLyricsBrowserDialog target={lyricsImportItem??metadataItem} initialSameItem={localLyricsThisItem} onClose={()=>setShowLocalLyricsBrowser(false)} onCopy={(target,source)=>{setShowLocalLyricsBrowser(false);setLyricsImportItem(target);setLyricsReuse(null);setLyricsLocalReuse(source);}}/>}
    {showAudioOutput&&<AudioOutputDialog playback={playback} onClose={()=>setShowAudioOutput(false)}/>}
    {showProviders&&<ProviderManagerDialog onClose={()=>setShowProviders(false)}/>}
    {ruleTransfer&&<RuleTransferDialog {...ruleTransfer} revision={revision} onClose={()=>setRuleTransfer(null)} onChanged={()=>setRevision(value=>value+1)}/>}
    {smartHistory&&<SmartPlaylistHistoryDialog {...smartHistory} revision={revision} onClose={()=>setSmartHistory(null)} onOpen={id=>{setSmartHistory(null);void openSmartPlaylist(id);}} onChanged={()=>{setRevision(value=>value+1);setNotice('原恢复操作已保存');}}/>}
    {smartPlaylistDialog&&<SmartPlaylistDialog state={smartPlaylistDialog} revision={revision} onClose={()=>setSmartPlaylistDialog(null)} onDone={smartPlaylistDone}/>}
    {playlistDialog&&<PlaylistDialog state={playlistDialog} playlists={playlists} onClose={()=>setPlaylistDialog(null)} onDone={playlistDone}/>}
    {catalogItem&&<CatalogDialog item={catalogItem} onClose={()=>setCatalogItem(null)} onDone={catalogDone} onArtists={()=>{setArtistItem(catalogItem);setCatalogItem(null);}} onReleases={()=>{setReleaseItem(catalogItem);setCatalogItem(null);}} onReferences={()=>{setReferencesItem(catalogItem);setCatalogItem(null);}} onRecording={()=>{setRecordingItem(catalogItem);setCatalogItem(null);}} onSources={()=>{setSourceTarget({itemId:catalogItem.id});setCatalogItem(null);}}/>}
    {tagWriteItem&&<TagWriteDialog itemId={tagWriteItem} onClose={()=>setTagWriteItem(null)}/>}
    {sourceTarget&&<MetadataSourcesDialog target={sourceTarget} onClose={()=>setSourceTarget(null)} onChanged={()=>{setRevision(value=>value+1);setMatch(null);setAcceptedFields([]);setNotice('来源修订已保存，可在曲库修订记录中撤销');}}/>}
    {recordingItem&&<RecordingProfileDialog item={recordingItem} onClose={()=>setRecordingItem(null)} onDone={catalogDone}/>}
    {referencesItem&&<EntityReferencesDialog item={referencesItem} onClose={()=>setReferencesItem(null)} onChanged={()=>{setRevision(v=>v+1);setNotice('外部引用已保存，可在修订记录中撤销');}}/>}
    {artistItem&&<ArtistDialog item={artistItem} onClose={()=>setArtistItem(null)} onDone={catalogDone} onManage={()=>{setArtistItem(null);setShowArtistManager(true);}}/>}
    {showArtistManager&&<ArtistManagerDialog onClose={()=>setShowArtistManager(false)} onChanged={()=>{setRevision(value=>value+1);setNotice('艺人资料已保存，可在曲库修订记录中撤销');}}/>}
    {showGenreManager&&<GenreManagerDialog revision={revision} onClose={()=>setShowGenreManager(false)} onChanged={()=>{setRevision(value=>value+1);setNotice('风格资料已保存，可在曲库修订记录中撤销');}}/>}
    {albumReview&&<MetadataAlbumReviewDialog header={albumReview} onClose={()=>setAlbumReview(null)} onSaved={batch=>{setAlbumReview(null);setBatchInitialId(batch.id);setShowBatchReview(true);}}/>}
    {releaseFieldsReview&&<MetadataReleaseFieldsDialog review={releaseFieldsReview} onClose={()=>setReleaseFieldsReview(null)}/>}
    {creditReview&&<MetadataCreditDialog itemId={creditReview.itemId} token={creditReview.token} onClose={()=>setCreditReview(null)} onChanged={()=>{setCreditReview(null);setMatch(null);setAcceptedFields([]);setRevision(value=>value+1);setNotice('在线署名已保存，可在曲库修订记录中撤销');}}/>}
    {releaseItem&&<ReleaseDialog item={releaseItem} onClose={()=>setReleaseItem(null)} onDone={catalogDone}/>}
    {versionsItem&&<VersionsDialog item={versionsItem} onClose={()=>setVersionsItem(null)} onPlay={item=>void playVersion(item)}/>}
    {showCatalogHistory&&<CatalogHistoryDialog onMetadataUndo={id=>{setShowCatalogHistory(false);setUndoReview(id);}} onClose={()=>setShowCatalogHistory(false)} onDone={catalogDone}/>}

    <div className="player-bar"><div className="player-track"><button className="player-detail-button" aria-controls="playback-detail" aria-expanded={showDetail} aria-label="打开播放详情" title="打开播放详情" onClick={()=>openDetail('both')}><Artwork item={current} revision={artworkRevision(current)} className="player-cover" eager/></button><div className="player-meta"><strong>{current?.title??(playback.state==='error'?'播放失败':'还没有播放音乐')}</strong><small title={playback.interruption?playback.message:current?.artist}>{playback.interruption?playback.message:current?.artist??'选择一首音乐，开始播放'}</small></div></div><div className="player-center"><div className="player-controls"><button title="停止" aria-label="停止" onClick={() => void queueAction(()=>window.music.stop())}>■</button><button title="上一首" aria-label="上一首" disabled={!queue.entries.length} onClick={()=>void queueAction(()=>window.music.previous(queueCommand()))}>▏◁</button><button className="play-toggle" title={playback.state==='playing'?'暂停':'播放或继续'} aria-label={playback.state==='playing'?'暂停':'播放或继续'} onClick={() => {if(playback.state==='playing'||playback.state==='paused')void queueAction(()=>window.music.pause());else if(queue.currentEntryId)void queueAction(()=>window.music.queueJump(queue.currentEntryId!,queueCommand()));else if(current)void play(current);}}>{playback.state==='playing'?'Ⅱ':'▶'}</button><button title="下一首" aria-label="下一首" disabled={queue.entries.length<2} onClick={()=>void queueAction(()=>window.music.next(queueCommand()))}>▷▏</button><button className="player-queue-button" aria-label={`打开播放列表，共 ${queue.entries.length} 首`} title={`播放列表 · ${queue.entries.length} 首`} onClick={()=>openDetail('queue')}>≡</button></div><PlayerProgress playback={playback} entryId={queue.currentEntryId} seek={(position,itemId)=>void queueAction(()=>window.music.seek(position,itemId))}/></div><div className="player-output"><span className="output-led"></span><button className="output-settings-button" aria-label="输出设备与播放设置" title="输出设备与播放设置" onClick={()=>setShowAudioOutput(true)}>{playback.asioDsd?.output.driverName||playback.asioDsd?.output.identity.registryName||playback.asio?.output.driverName||playback.asio?.output.identity.registryName||playback.actualOutput?.deviceName||'输出设备'}</button><span className="output-description" title={playback.output}>{outputSummary(playback.output)}</span><PlayerVolume playback={playback}/></div></div>
  </div>;
}

function StartupBlocked({ticket,children}:{ticket:string|null;children:React.ReactNode}){useEffect(()=>{if(ticket)void window.music.startupInterfaceReady(ticket,'blocked').catch(()=>{});},[ticket]);return <>{children}</>;}
void (async()=>{
 const root=createRoot(document.getElementById('root')!);
 let startupTicket:string|null=null;
 try{startupTicket=await window.music.startupTicket();const recovery=readRestoreRecoveryState(await window.music.catalogRestoreRecoveryState());if(recovery.active){const {CatalogRestoreRecovery}=await import('./catalog-restore-recovery.js');root.render(<CatalogRestoreRecovery initial={recovery}/>);return;}await initializeCatalogBackupClient();const seed=await window.music.catalogRestoreRendererSeed();if(seed){root.render(<CatalogRestorePrepared request={readRestoreRendererRequest(seed)} onApplication={request=>root.render(<CatalogRestoreApplication request={request} renderApplication={(ready,failed)=><App onRestoreReady={ready} onRestoreError={failed}/>}/>)}/>);return;}root.render(<CatalogBackupBoundary><App startupTicket={startupTicket}/></CatalogBackupBoundary>);}
 catch(error){root.render(<StartupBlocked ticket={startupTicket}><main className="catalog-backup-overlay"><div className="catalog-backup-dialog"><h1>界面状态尚未确认</h1><p role="alert">{String(error instanceof Error?error.message:error)}</p><p>原资料继续保留，请退出后重新核对恢复状态。</p><button onClick={()=>void window.music.quitCatalogBackup()}>退出应用</button></div></main></StartupBlocked>);}
})();

