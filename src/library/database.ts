import {TagCommitBatches,tagCommitBatchSchema,validateTagCommitBatches} from './tag-commit-batches.js';
import {TagStageBatches,tagStageBatchSchema,validateTagStageBatches} from './tag-stage-batches.js';
import {tagLibraryFields,legacyTagLibraryFields} from './tag-library-fields.js';
import {recognitionRetrySchema} from './recognition-retry.js';
import {TAG_WRITE_CERTIFICATES} from '../shared/tag-write-certification.js';
import {recognitionMappingSchema} from './recognition-mapping.js';
import {MetadataRecognitionRepository,metadataRecognitionSchema} from './metadata-recognition.js';
import {MetadataWorkflowRepository,metadataWorkflowSchema} from './metadata-workflow.js';
import {localISRCs} from '../shared/isrc.js';
import {clearSqlStatements,sqlStatement} from './sql-statements.js';
import {CatalogRestorePolicyRepository} from './catalog-restore-policy.js';
import {historyExportId} from '../shared/history-export.js';
import {readLibrarySchema,type LibrarySchemaObject} from './schema-snapshot.js';
import {PlaybackPolicies,playbackPolicySchema,initializePlaybackPolicy} from './playback-policy.js';
import {RuleTransfers,ruleTransferSchema} from './rule-transfer.js';
import {SmartPlaylistHistory,smartPlaylistHistorySchema} from './smart-playlist-history.js';
import {FilterPresets,filterPresetSchema} from './filter-presets.js';
import {SmartPlaylists,smartPlaylistSchema} from './smart-playlists.js';
import {libraryQueryPlan} from './library-query-plan.js';
import {migrateTagRestoreAttempts} from './tag-restore-attempt-migration.js';
import {queryIndexSchema,snapshotQueryIndexUpgrade,verifyQueryIndexUpgrade} from './query-index-migration.js';
import type {LibraryStartupPhase} from '../shared/startup-progress.js';
import {libraryStats} from './library-stats.js';
import {registerSortFunctions,sortSchema} from './natural-sort.js';
import {musicFilterPlan,musicCodecFamily,musicReleaseYear,musicFiltersSchema} from './music-filters.js';
import {spellingSchema,recallSpelling,spellingQuery,createDirectSearchRanker,type SpellingHit} from './search-spelling.js';
import {tagRestoreReprobeSchema} from './tag-restore-reprobe-schema.js';
import type {TagRestoreReprobeProof} from './tag-restore-reprobe-proof.js';
import type {TagRestoreJournalSnapshot} from '../shared/tag-restore-journal.js';
import {tagRestoreRecoverySchema} from './tag-restore-recovery-schema.js';
import {tagRestoreSchema} from './tag-restore-schema.js';
import {tagCommitReconcileSchema} from './tag-commit-reconcile-schema.js';
import {tagCommitReprobeSchema} from './tag-commit-reprobe-schema.js';
import type {TagCommitReprobeProof} from './tag-commit-reprobe-proof.js';
import type {TagCommitJournalSnapshot} from '../shared/tag-commit-journal.js';
import {tagCommitRecoverySchema} from './tag-commit-recovery-schema.js';
import {EmbeddedCueHistory,embeddedCueHistorySchema} from './embedded-cue-history.js';
import {reviewCueVersion} from './cue-version-review.js';
import {cueSourceSelectionSchema} from './cue-source-selection-schema.js';
import {cueSourceImportSchema} from './cue-source-import-schema.js';
import {cueSourceRegistrationSchema} from './cue-source-registration-schema.js';
import {readCueSourceRegisterRequest} from '../shared/cue-source-registration.js';
import {readCueSourceImportRequest,type CueSourceImportResult} from '../shared/cue-source-import.js';
import {readCueSourceSelectionRequest,type CueSourceSelectionResult,type CueSourceApplication} from '../shared/cue-source-selection.js';
import {CueSourceHistory,cueHistorySchema,cuePathKey} from './cue-history.js';
import {FLAC_CUE_PARSER,readFlacCueSource,type FlacCueSource} from './flac-cuesheet.js';
import {readFlacCueTextSource,embeddedCueView,type FlacCueTextSource} from './flac-cue-text.js';
import {FilePolicyRepository,filePolicySchema} from './file-policy.js';
import {CatalogBrowser} from './catalog-browse.js';
import {LibraryWatchStore} from './library-watch-store.js';
import {fileObservationSchema,FILE_OBSERVATION_ALGORITHM,validFileObservation} from './file-observation.js';
import {SearchIndex,searchIndexSchema,updateLiteralSearchIndex,type SearchSource} from './search-index.js';
import {latinSearchQuery,SEARCH_ALGORITHM} from './search-text.js';
import {defaultCatalogViewPreference,readCatalogViewPreference,readCatalogViewSave,type CatalogViewPreference,type CatalogBrowseResponse} from '../shared/catalog-browse.js';
import {BrowseClock} from './browse-clock.js';
import {defaultWindowPlacementPreference,readWindowPlacementPreference,type WindowPlacementPreference} from '../shared/window-placement.js';
import {defaultAppearancePreference,readAppearancePreference,type AppearancePreference} from '../shared/appearance.js';
import {desktopSources} from './desktop-sources.js';
import {validateReplayGain} from '../shared/audio-processing.js';
import {cueReplayGain} from './replay-gain.js';
import {MetadataUndoRepository,metadataUndoSchema} from './metadata-undo.js';
import {ProviderSettings,ProviderCredentials,providerSchema} from './providers.js';
import type {CredentialStore} from './credential-vault.js';
import {ProviderRetentionRepository,providerRetentionSchema,retentionState,requireOnlineRetention} from './provider-retention.js';
import {WaveformRepository,waveformSchema} from './waveforms.js';
import {ScanJobRepository,scanJobSchema} from './scan-jobs.js';
import {LocalLyricsHistory,lyricsLocalHistorySchema,lyricsLocalBrowserSchema} from './lyrics-local-history.js';
import {defaultMediaKeyPreference,readMediaKeyPreference,type MediaKeyPreference} from '../shared/media-key-preference.js';
import {defaultDesktopPreference,readDesktopPreference,type DesktopPreference} from '../shared/desktop-preference.js';
import {AudioOutputSettings,audioOutputSettingsSchema} from './audio-output-settings.js';
import {AudioBackendSettings,audioBackendSettingsSchema} from './audio-backend-settings.js';
import {AsioOutputSettings,asioOutputSettingsSchema} from './asio-output-settings.js';
import {DsdOutputSettings,dsdOutputSettingsSchema} from './dsd-output-settings.js';
import {ArtworkStore,artworkStoreSchema} from './artwork-store.js';
import {OnlineArtworkStore,onlineArtworkSchema} from './online-artwork-store.js';
import {LyricsPreferenceRepository,lyricsPreferenceSchema} from './lyrics-preferences.js';
import {LyricsDocumentRepository,lyricsDocumentSchema,lyricsSavedSchema,lyricsContextSchema} from './lyrics-documents.js';
import {MetadataBatchRepository,metadataBatchSchema} from './metadata-batches.js';
import {MetadataCollectionRepository,metadataCollectionsSchema} from './metadata-collections.js';
import {GenreRepository,genreSchema,validateGenreTree} from './genres.js';
import {creditNameSchema} from './artist-credit.js';
import {providerArtistIdentity} from './online-credits.js';
import { DatabaseSync } from 'node:sqlite';
import {catalogSnapshotEstimate,createCatalogDatabaseSnapshot,sourceMetadata} from './catalog-backup-snapshot.js';
import { randomUUID,createHash } from 'node:crypto';
import path from 'node:path';
import {TagWriteJobs,tagWriteJobsSchema} from './tag-write-jobs.js';
import {tagWriteExecutionSchema} from './tag-write-execution-schema.js';
import {tagRecoverySchema} from './tag-recovery-schema.js';
import {tagRecoveryActionSchema} from './tag-recovery-action-schema.js';
import {tagCommitSchema} from './tag-commit-schema.js';
import {tagWriteUuid} from '../shared/tag-write.js';
import type {TagWriteContext} from '../shared/tag-write-ui.js';
import type { LibraryItem, LibraryStats, ListRequest, ListResponse, RootStatus, MetadataCandidate, MetadataField, MetadataChangeResult, QueueState, ArtistRole, CatalogFacet } from '../shared/contracts.js';
import { validQueueState } from '../shared/queue-state.js';
import {resolveCueReference,type CueEntry} from './cue.js';
import {cueTrackSchema} from './cue-model.js';
import type {ParsedCueSource} from './cue-read.js';
import { UserLibraryRepository } from './user-library.js';
import { CatalogRepository, catalogSchema, catalogAssociationSchema, artistRoles, type CatalogTags } from './catalog.js';
import { CatalogAssociationRepository } from './catalog-associations.js';
import { ArtistCurationRepository, artistCurationSchema } from './artist-curation.js';
import { ReleaseCurationRepository, releaseCurationSchema } from './release-curation.js';
import { ArtistProfileRepository, artistProfileSchema } from './artist-profiles.js';
import {MetadataIdentityRepository} from './metadata-identities.js';
import {MetadataGroupLinkRepository} from './metadata-group-link.js';
import {MetadataAlbumCreditsRepository} from './metadata-album-credits.js';
import {MetadataAlbumReviewRepository,type MetadataAlbumLocalSnapshot} from './metadata-album-review.js';
import {readMetadataFieldSources,readMetadataAlbumBinding,MetadataReviewConflictError} from '../shared/metadata-album-review.js';
import {MetadataReleaseFieldsRepository} from './metadata-release-fields.js';
import {ReleaseProfileRepository,releaseProfileSchema} from './release-profiles.js';
import {EntityReferenceRepository,entityReferenceSchema} from './entity-references.js';
import {migrateReleaseTrackReferences} from './release-track-references-migration.js';
import {RecordingProfileRepository,recordingProfileSchema} from './recording-profiles.js';
import {MetadataProvenanceRepository,metadataProvenanceSchema,metadataSelectionSchema,provenanceSnapshot,recordOnline,fieldLocked,restoreProvenance,checkProvenanceUndo,type ProvenanceSnapshot} from './metadata-provenance.js';
import type { CatalogChangeSummary, CatalogChangeResult } from '../shared/contracts.js';

export interface ParsedFile {
  embeddedCueText?:FlacCueTextSource|null;
  embeddedCue?:FlacCueSource|null;
  replayGain?:import('../shared/contracts.js').ReplayGainTags; 
  relativePath: string;
  size: number;
  mtimeMs: number;
  title: string;
  artist: string;
  album: string;
  genre: string;
  durationSeconds: number | null;
  codec: string;
  sampleRate: number | null;
  bitsPerSample: number | null;
  trackNumber: number | null;
  discNumber: number | null;
  parseError?: string;
  catalog?:CatalogTags;
}

type RootRow = { id: string; path: string; status: RootStatus; scan_generation: number };
type FileRow = { id: string; size: number; mtime_ms: number; duration_seconds: number | null;parse_error:string|null;observation_hash:string|null };

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().trim();
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, '\\$&')}%`;
}

import {PlaybackStatsClock} from './playback-stats-clock.js';
import {musicFilterDependencies,musicFilterTimeAnchor,type MusicFilters} from '../shared/music-filters.js';
import {PlaybackHistoryRepository,playbackHistorySchema,playbackStatisticsSchema} from './playback-history.js';

export class LibraryDatabase {
  // Generate a trusted reference only from this build's migrations and an empty
  // in-memory database. Candidate connections require the explicit read-only
  // dormant option after independent compatibility and full-file checks.
  static restoreSchemaReference():LibrarySchemaObject[]{
    const reference=new LibraryDatabase(':memory:');try{reference.db.exec('ANALYZE');return readLibrarySchema(reference.db);}finally{reference.close();}
  }
  private readonly db: DatabaseSync;
  private readonly filename: string;
  readonly restorePolicy:CatalogRestorePolicyRepository;
  readonly playbackHistory:PlaybackHistoryRepository;
  readonly playbackPolicies:PlaybackPolicies;
  readonly smartPlaylists:SmartPlaylists;
  readonly smartPlaylistHistory:SmartPlaylistHistory;
  readonly filterPresets:FilterPresets;
  readonly ruleTransfers:RuleTransfers;
  readonly user:UserLibraryRepository;
  readonly catalog:CatalogRepository;
  readonly associations:CatalogAssociationRepository;
  readonly artists:ArtistCurationRepository;
  readonly releases:ReleaseCurationRepository;
  readonly profiles:ArtistProfileRepository;
  readonly metadataIdentities:MetadataIdentityRepository;
  readonly metadataGroupLinks:MetadataGroupLinkRepository;
  readonly metadataAlbumCredits:MetadataAlbumCreditsRepository;
  readonly metadataAlbums:MetadataAlbumReviewRepository;
  readonly releaseFields:MetadataReleaseFieldsRepository;
  readonly releaseProfiles:ReleaseProfileRepository;
  readonly references:EntityReferenceRepository;
  readonly recordingProfiles:RecordingProfileRepository;
  readonly metadataProvenance:MetadataProvenanceRepository;
  readonly metadataCollections:MetadataCollectionRepository;
  readonly genres:GenreRepository;
  readonly metadataBatches:MetadataBatchRepository;
  readonly metadataUndo:MetadataUndoRepository;
  readonly providerSettings:ProviderSettings;
  readonly providerRetention:ProviderRetentionRepository;
  readonly waveforms:WaveformRepository;
  readonly lyricsPreferences:LyricsPreferenceRepository;
  readonly lyricsDocuments:LyricsDocumentRepository;
  readonly scanJobs:ScanJobRepository;
  readonly metadataWorkflows:MetadataWorkflowRepository;
  readonly metadataRecognitions:MetadataRecognitionRepository;
  readonly libraryWatch:LibraryWatchStore;
  readonly cueSources:CueSourceHistory;
  readonly embeddedCueSources:EmbeddedCueHistory;
  readonly filePolicy:FilePolicyRepository;
  readonly artworkStore:ArtworkStore;
  readonly onlineArtwork:OnlineArtworkStore;
  readonly localLyricsHistory:LocalLyricsHistory;
  readonly audioOutputSettings:AudioOutputSettings;
  readonly asioOutputSettings:AsioOutputSettings;
  readonly audioBackendSettings:AudioBackendSettings;
  readonly dsdOutputSettings:DsdOutputSettings;
  readonly tagWriteJobs:TagWriteJobs;
  readonly tagStageBatches:TagStageBatches;
  readonly tagCommitBatches:TagCommitBatches;
  private savepointSerial=0;
  private playbackStatsClock:PlaybackStatsClock|undefined;
  private browseClock:BrowseClock|undefined;
  private searchIndex:SearchIndex|undefined;
  searchIndexState():import('../shared/search-index.js').SearchIndexState{if(!this.searchIndex)throw new Error('检索索引尚未初始化');return this.searchIndex.state();}
  stepSearchIndex():import('../shared/search-index.js').SearchIndexState{return this.searchIndex!.step();}
  retrySearchIndex():import('../shared/search-index.js').SearchIndexState{return this.searchIndex!.retry();}
  browseStamp(query?:string):string{this.browseClock??=new BrowseClock(this.db);return this.browseClock.stamp()+`:derived:${this.searchIndex?.contentRevision()??0}`;}
  browseFilterStamp(filters:MusicFilters|undefined,asOfMs=musicFilterTimeAnchor(),saved?:MusicFilters):string{
    const dependencies=musicFilterDependencies(filters,saved);let stamp=this.browseStamp();
    if(dependencies.counts||dependencies.recency){this.playbackStatsClock??=new PlaybackStatsClock(this.db);stamp+=this.playbackStatsClock.stamp(dependencies.counts,dependencies.recency);}
    if(dependencies.relative)stamp+=`:relative-minute:${musicFilterTimeAnchor(asOfMs)}`;
    return stamp;
  }
  browseQueryStamp(query:ListRequest,asOfMs=musicFilterTimeAnchor()):string{
    const smart=query.view==='playlists'&&query.value?this.smartPlaylists.maybe(query.value):null;
    return this.browseFilterStamp(query.filters,asOfMs,smart?.definition.query.filters);
  }
  private catalogBrowser:CatalogBrowser|undefined;
  browseCatalog(value:unknown):CatalogBrowseResponse{this.catalogBrowser??=new CatalogBrowser(this.db,this.catalog,{stamp:(filters,asOfMs)=>this.browseFilterStamp(filters,asOfMs),items:ids=>this.getItems(ids),filter:(value,asOfMs)=>this.musicFilterItems(value,asOfMs)});return this.catalogBrowser.page(value);}

  private restoreNormalCandidate=false;private restoreNormalPrepared=false;private restoreWalPrepared=false;
  constructor(filename: string,options:{restoreDormant?:boolean;restoreWritablePaused?:boolean;restoreNormalPaused?:boolean;startupProgress?:(phase:LibraryStartupPhase)=>void}={}) {
    if([options.restoreDormant,options.restoreWritablePaused,options.restoreNormalPaused].filter(Boolean).length>1)throw new Error('恢复连接不能同时只读与可写');
    this.filename=filename;this.restoreNormalCandidate=Boolean(options.restoreNormalPaused);
    this.db = new DatabaseSync(filename,{readOnly:Boolean(options.restoreDormant),allowExtension:false});
    registerSortFunctions(this.db);
    this.db.function('aural_codec_family_v1',{deterministic:true},(codec,rate,bits)=>musicCodecFamily(codec,rate,bits));
    this.db.function('aural_release_year_v1',{deterministic:true},value=>musicReleaseYear(value));
    const searchRanker=createDirectSearchRanker();
    this.db.function('aural_search_rank_v1',{deterministic:true},(title,artist,album,genre,query)=>searchRanker([title,artist,album,genre],query));
    this.db.function('aural_cue_path_key_v1',{deterministic:true},value=>{if(typeof value!=='string')throw new Error('CUE 路径索引无效');return cuePathKey(value);});
    this.catalog=new CatalogRepository(this.db);
    try{
      if(options.restoreDormant){this.db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');if(Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)!==82)throw new Error('恢复只读启动不允许创建或迁移曲库');}
      else if(options.restoreWritablePaused||options.restoreNormalPaused){this.db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;');if(Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)!==82||(this.db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode!=='delete')throw new Error('恢复可写暂停连接要求现有schema82和DELETE日志，禁止创建或迁移');}
      else{this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;');this.migrate(options.startupProgress);clearSqlStatements(this.db);}
      this.restorePolicy=new CatalogRestorePolicyRepository(this.db,action=>this.transaction(action));this.restorePolicy.load();
      this.artworkStore=new ArtworkStore(this.db,action=>this.transaction(action));
      this.onlineArtwork=new OnlineArtworkStore(this.db,action=>this.transaction(action));
      this.cueSources=new CueSourceHistory(this.db,action=>this.transaction(action));
      this.embeddedCueSources=new EmbeddedCueHistory(this.db,action=>this.transaction(action));
      this.filePolicy=new FilePolicyRepository(this.db,action=>this.transaction(action),()=>this.browseStamp());
      this.libraryWatch=new LibraryWatchStore(this.db,action=>this.transaction(action));
      this.localLyricsHistory=new LocalLyricsHistory(this.db,action=>this.transaction(action));
      this.audioOutputSettings=new AudioOutputSettings(this.db,action=>this.transaction(action));
      this.asioOutputSettings=new AsioOutputSettings(this.db,action=>this.transaction(action));
      this.audioBackendSettings=new AudioBackendSettings(this.db,action=>this.transaction(action));
      this.dsdOutputSettings=new DsdOutputSettings(this.db,action=>this.transaction(action));
      this.tagWriteJobs=new TagWriteJobs(this.db,action=>this.transaction(action));
      this.tagStageBatches=new TagStageBatches(this.db,action=>this.transaction(action),id=>this.tagWriteJobs.material(id).job,id=>this.restorePolicy.assertTagJob(id));
      this.tagCommitBatches=new TagCommitBatches(this.db,action=>this.transaction(action),id=>this.tagWriteJobs.material(id).job,id=>this.restorePolicy.assertTagJob(id));
      if(!options.restoreDormant&&!options.restoreWritablePaused&&!options.restoreNormalPaused){this.tagWriteJobs.recoverInterrupted();this.tagStageBatches.recover();this.tagCommitBatches.recover();}
      this.providerSettings=new ProviderSettings(this.db);
      this.providerRetention=new ProviderRetentionRepository(this.db);
      this.waveforms=new WaveformRepository(this.db);
      this.lyricsPreferences=new LyricsPreferenceRepository(this.db);
      this.lyricsDocuments=new LyricsDocumentRepository(this.db,id=>this.localLyricsHistory.storedVersion(id));
      this.scanJobs=new ScanJobRepository(this.db,{root:id=>this.getRoot(id),begin:id=>this.beginScan(id),continue:(id,generation)=>this.continueScan(id,generation),end:(id,complete)=>this.endScan(id,complete),offline:id=>this.markRootOffline(id),authorized:root=>this.restorePolicy.assertRoot(root),scanAllowed:sequence=>this.restorePolicy.scanAllowed(sequence),scanFloor:()=>this.restorePolicy.scanFloor()});
      this.catalog.enableAssociations();
      this.catalog.enableArtists();
      this.catalog.enableReleases();
      this.catalog.enableProfiles();
      this.catalog.enableReleaseProfiles();
      this.catalog.enableRecordingProfiles();
      this.catalog.enableMetadataProvenance();
      this.catalog.enableGenreHierarchy();
      this.catalog.enableCreditNames();
      this.associations=new CatalogAssociationRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.artists=new ArtistCurationRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.releases=new ReleaseCurationRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.profiles=new ArtistProfileRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.releaseProfiles=new ReleaseProfileRepository(this.db,this.catalog,this.releases,itemId=>this.refreshEffectiveSearch(itemId));
      this.references=new EntityReferenceRepository(this.db);
      this.recordingProfiles=new RecordingProfileRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.metadataProvenance=new MetadataProvenanceRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.releaseFields=new MetadataReleaseFieldsRepository(this.db,this.catalog,this.releases,this.metadataProvenance,itemId=>this.refreshEffectiveSearch(itemId));
      this.metadataCollections=new MetadataCollectionRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.genres=new GenreRepository(this.db,this.catalog,itemId=>this.refreshEffectiveSearch(itemId));
      this.metadataUndo=new MetadataUndoRepository(this.db,{item:id=>this.getItem(id),refresh:id=>{this.catalog.sync(id);this.refreshEffectiveSearch(id);},catalogRevision:id=>this.getItem(id)?.catalog?.revision??0});
      this.metadataBatches=new MetadataBatchRepository(this.db,{
        item:id=>this.getItem(id)??null,
        fingerprint:id=>this.metadataReviewFingerprint(id),
        lookupFingerprint:id=>this.metadataRecordingLookupContext(id).fingerprint,
        before:id=>{const item=this.getItem(id);if(!item)throw new Error('曲目不存在');return {title:item.title,artist:item.artist,album:item.album};},
        validate:(id,revision,fields)=>{this.requireMetadataRetention();if(this.metadataRevision(id)!==revision)throw new Error('曲目元数据修订已变化');const item=this.getItem(id);if(!item)throw new Error('曲目不存在');for(const field of fields){if(fieldLocked(this.db,'playable_item',id,field))throw new Error('所选字段已锁定');if(field==='artist'&&item.catalog?.creditConfirmed)throw new Error('已确认多成员署名需在完整署名审核中修改');}},
        apply:(id,revision,candidate,fields)=>this.applyMetadataInTransaction(id,revision,candidate,fields),
        undo:id=>this.metadataUndo.eligibleInTransaction(id)
      });
      this.metadataWorkflows=new MetadataWorkflowRepository(this.db,action=>this.transaction(action),id=>this.getItem(id),id=>this.metadataRecognitions?.get(id)??null);
      this.metadataRecognitions=new MetadataRecognitionRepository(this.db,action=>this.transaction(action));
      if(!options.restoreDormant&&!options.restoreWritablePaused&&!options.restoreNormalPaused){this.metadataWorkflows.recover();this.metadataRecognitions.recover();}
      this.metadataAlbums=new MetadataAlbumReviewRepository({snapshot:id=>this.metadataAlbumSnapshot(id),retention:()=>this.requireMetadataRetention(),receipt:r=>this.metadataBatches.albumCreationReceipt(r),create:(r,c,identity)=>this.metadataBatches.createFromAlbum(r,c,identity)});
      this.metadataIdentities=new MetadataIdentityRepository(this.metadataAlbums,this.references);
      this.metadataGroupLinks=new MetadataGroupLinkRepository(this.db,this.metadataAlbums,this.references,this.catalog,id=>this.refreshEffectiveSearch(id));
      this.metadataAlbumCredits=new MetadataAlbumCreditsRepository(this.db,this.metadataAlbums,this.metadataCollections);
      this.playbackPolicies=new PlaybackPolicies(this.db,action=>this.transaction(action));
      this.playbackHistory=new PlaybackHistoryRepository(this.db,action=>this.transaction(action),id=>this.getItem(id),value=>this.playbackPolicies.assertSnapshot(value));
      this.user=new UserLibraryRepository(this.db);
      this.smartPlaylists=new SmartPlaylists(this.db,action=>this.transaction(action),()=>this.browseStamp());
      this.smartPlaylistHistory=new SmartPlaylistHistory(this.db,action=>this.transaction(action),id=>this.smartPlaylists.maybe(id));
      this.filterPresets=new FilterPresets(this.db,action=>this.transaction(action));
      this.ruleTransfers=new RuleTransfers(this.db,action=>this.transaction(action),this.smartPlaylists,this.filterPresets);
      this.searchIndex=new SearchIndex(this.db,{transaction:action=>this.transaction(action),sources:ids=>this.searchSources(ids)},Boolean(options.restoreDormant||options.restoreWritablePaused||options.restoreNormalPaused));
    }catch(error){clearSqlStatements(this.db);this.db.close();throw error;}
  }

  prepareRestoreNormal():void{
    if(!this.restoreNormalCandidate||this.restoreNormalPrepared||!this.searchIndex||this.db.isTransaction)throw new Error('普通服务准备不属于当前暂停连接或已经执行');
    this.searchIndex.prepareAlgorithm();{this.tagWriteJobs.recoverInterrupted();this.tagStageBatches.recover();this.tagCommitBatches.recover();}this.scanJobs.recover();this.metadataWorkflows.recover();this.metadataRecognitions.recover();this.waveforms.interrupted();this.restoreNormalPrepared=true;
  }
  assertRestoreWalReady():void{
    if(!this.restoreNormalCandidate||!this.restoreWalPrepared||this.db.isTransaction||Number((this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)!==82||(this.db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode!=='wal'||Number((this.db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys)!==1||Number((this.db.prepare('PRAGMA synchronous').get() as {synchronous:number}).synchronous)!==2)throw new Error('恢复曲库释放前连接已改变或未完成WAL准备');
  }
  prepareRestoreWal():{schema:82;journalMode:'wal';foreignKeys:true;synchronous:2;integrity:'ok';foreignKeyViolations:0}{
    if(!this.restoreNormalCandidate||this.restoreWalPrepared||this.db.isTransaction)throw new Error('恢复WAL转换不属于当前暂停连接或已执行');
    const before=this.db.prepare('PRAGMA journal_mode').get() as {journal_mode:string};if(before.journal_mode!=='delete')throw new Error('恢复WAL转换前日志模式不同');
    const mode=this.db.prepare('PRAGMA journal_mode=WAL').get() as {journal_mode:string},schema=this.db.prepare('PRAGMA user_version').get() as {user_version:number},foreign=this.db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number},sync=this.db.prepare('PRAGMA synchronous').get() as {synchronous:number},integrity=this.db.prepare('PRAGMA integrity_check(1)').get() as {integrity_check:string};
    if(mode.journal_mode!=='wal'||schema.user_version!==82||foreign.foreign_keys!==1||sync.synchronous!==2||integrity.integrity_check!=='ok'||this.db.prepare('PRAGMA foreign_key_check').get())throw new Error('恢复WAL连接、完整性或外键未确认');this.restoreWalPrepared=true;
    return {schema:82,journalMode:'wal',foreignKeys:true,synchronous:2,integrity:'ok',foreignKeyViolations:0};
  }
  close(): void {this.releaseFields?.clear();this.metadataAlbums?.clear();this.metadataIdentities?.clear();this.metadataGroupLinks?.clear();this.metadataAlbumCredits?.clear();clearSqlStatements(this.db);this.db.close();}
  catalogMetadata():import('./catalog-backup-database.js').BackupDatabaseMetadata{return sourceMetadata(this.db);}
  normalizeBeforeRestoreClose():void{
    if(this.db.isTransaction)throw new Error('曲库事务尚未结束，不能受控关闭');
    const checkpoint=this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number;log:number;checkpointed:number};if(checkpoint.busy!==0)throw new Error('曲库WAL仍被其他连接使用，不能确认关闭');
    const mode=this.db.prepare('PRAGMA journal_mode=DELETE').get() as {journal_mode:string};if(mode.journal_mode!=='delete')throw new Error('曲库未确认独立DELETE日志模式');
  }
  catalogBackupSize():number{return catalogSnapshotEstimate(this.db);}
  createCatalogBackupDatabase(filename:string,check:()=>void):Promise<import('./catalog-backup-database.js').BackupDatabaseMetadata>{return createCatalogDatabaseSnapshot(this.db,filename,check);}
  historyExportOrigin():string{const row=this.db.prepare('SELECT id FROM rule_transfer_origin WHERE slot=1').get() as {id:string}|undefined;if(!row)throw new Error('曲库来源身份缺失');return historyExportId(row.id);}
  providerCredentials(vault:CredentialStore):ProviderCredentials{return new ProviderCredentials(this.db,this.providerSettings,vault,commandId=>this.restorePolicy.assertCredentialCommand(commandId));}

  private migrate(progress?:(phase:LibraryStartupPhase)=>void): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    if (version > 82) throw new Error(`数据库版本 ${version} 高于当前应用支持版本`);
    if (version === 82) return;
    if(version<6){
    if (version === 0) this.db.exec(`
      BEGIN;
      CREATE TABLE library_root (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('online','offline','scanning')),
        scan_generation INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE media_file (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_root(id),
        relative_path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        duration_seconds REAL,
        codec TEXT NOT NULL,
        sample_rate INTEGER,
        bits_per_sample INTEGER,
        parse_error TEXT,
        status TEXT NOT NULL CHECK (status IN ('online','missing')),
        seen_generation INTEGER NOT NULL,
        UNIQUE(root_id,path_key)
      );
      CREATE TABLE playable_item (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('file','cue')),
        cue_key TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT NOT NULL,
        genre TEXT NOT NULL,
        title_norm TEXT NOT NULL,
        artist_norm TEXT NOT NULL,
        album_norm TEXT NOT NULL,
        genre_norm TEXT NOT NULL,
        track_number INTEGER,
        disc_number INTEGER,
        start_seconds REAL NOT NULL DEFAULT 0,
        end_seconds REAL,
        visible INTEGER NOT NULL DEFAULT 1,
        UNIQUE(file_id,kind,cue_key)
      );
      CREATE TABLE cue_document (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL REFERENCES library_root(id),
        relative_path TEXT NOT NULL,
        warnings TEXT NOT NULL,
        seen_generation INTEGER NOT NULL,
        UNIQUE(root_id,relative_path)
      );
      CREATE VIRTUAL TABLE search_fts USING fts5(item_id UNINDEXED, title, artist, album, genre, tokenize='trigram');
      CREATE TABLE search_gram (gram TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY(gram,item_id)) WITHOUT ROWID;
      CREATE INDEX idx_gram_item ON search_gram(item_id);
      CREATE INDEX idx_item_visible ON playable_item(visible,album,disc_number,track_number,id);
      CREATE INDEX idx_file_scan ON media_file(root_id,seen_generation);
      PRAGMA user_version=1;
      COMMIT;
    `);
    if (version === 1) {
      const backup=`${this.filename}.pre-v2-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    if (version <= 1) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE metadata_override (
        item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE CASCADE,
        title TEXT, artist TEXT, album TEXT,
        revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE metadata_change (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE CASCADE,
        base_revision INTEGER NOT NULL,
        after_revision INTEGER NOT NULL,
        provider TEXT NOT NULL,
        recording_id TEXT NOT NULL,
        release_id TEXT,
        before_json TEXT NOT NULL,
        after_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        undone_at TEXT
      );
      CREATE TABLE app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=2;
      COMMIT;
    `);
    if (version === 2) {
      const backup=`${this.filename}.pre-v3-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    if (version <= 2) this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE playable_item ADD COLUMN start_cue_frame INTEGER;
      ALTER TABLE playable_item ADD COLUMN end_cue_frame INTEGER;
      UPDATE playable_item SET
        start_cue_frame=CAST(ROUND(start_seconds*75) AS INTEGER),
        end_cue_frame=CASE WHEN end_seconds IS NULL THEN NULL ELSE CAST(ROUND(end_seconds*75) AS INTEGER) END
        WHERE kind='cue';
      PRAGMA user_version=3;
      COMMIT;
    `);
    if (version < 4) {
      if (version > 0) {
        const backup=`${this.filename}.pre-v4-${Date.now()}.bak`;
        this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
      }
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE media_stream (
          id TEXT PRIMARY KEY,
          file_id TEXT NOT NULL REFERENCES media_file(id) ON DELETE CASCADE,
          stream_index INTEGER NOT NULL CHECK (stream_index>=0),
          codec TEXT NOT NULL,
          source_kind TEXT NOT NULL DEFAULT 'unknown' CHECK (source_kind IN ('unknown','pcm','dsd')),
          sample_rate INTEGER CHECK (sample_rate IS NULL OR sample_rate>0),
          bits_per_sample INTEGER CHECK (bits_per_sample IS NULL OR bits_per_sample>0),
          UNIQUE(file_id,stream_index)
        );
        CREATE TABLE playable_span (
          item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL CHECK (ordinal>=0),
          stream_id TEXT NOT NULL REFERENCES media_stream(id),
          start_tick INTEGER NOT NULL CHECK (start_tick>=0),
          end_tick INTEGER,
          time_base_num INTEGER NOT NULL CHECK (time_base_num>0),
          time_base_den INTEGER NOT NULL CHECK (time_base_den>0),
          PRIMARY KEY(item_id,ordinal),
          CHECK(end_tick IS NULL OR end_tick>start_tick)
        );
        CREATE INDEX idx_span_stream ON playable_span(stream_id);
        INSERT INTO media_stream(id,file_id,stream_index,codec,sample_rate,bits_per_sample)
          SELECT 'stream:'||id||':0',id,0,codec,sample_rate,bits_per_sample FROM media_file;
        INSERT INTO playable_span(item_id,ordinal,stream_id,start_tick,end_tick,time_base_num,time_base_den)
          SELECT p.id,0,'stream:'||p.file_id||':0',
            CASE WHEN p.kind='cue' THEN p.start_cue_frame ELSE 0 END,
            CASE WHEN p.kind='cue' THEN p.end_cue_frame ELSE NULL END,
            1,CASE WHEN p.kind='cue' THEN 75 ELSE 1 END
          FROM playable_item p;
        PRAGMA user_version=4;
        COMMIT;
      `);
    }
    if(version<5){
    if(version>0){
      const backup=`${this.filename}.pre-v5-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE playable_item ADD COLUMN added_at TEXT;
      CREATE INDEX idx_item_added ON playable_item(visible,added_at DESC,id);
      CREATE TABLE item_user_state (
        item_id TEXT PRIMARY KEY REFERENCES playable_item(id) ON DELETE RESTRICT,
        favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0,1)),
        rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
        revision INTEGER NOT NULL CHECK(revision>=0),
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_user_favorite ON item_user_state(favorite,item_id);
      CREATE TABLE playlist (
        id TEXT PRIMARY KEY,name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        kind TEXT NOT NULL CHECK(kind='static'),revision INTEGER NOT NULL CHECK(revision>=0),
        created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE playlist_item (
        playlist_id TEXT NOT NULL REFERENCES playlist(id) ON DELETE CASCADE,
        entry_id TEXT PRIMARY KEY,item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE RESTRICT,
        position INTEGER NOT NULL CHECK(position>=0),UNIQUE(playlist_id,position)
      );
      CREATE INDEX idx_playlist_item_ref ON playlist_item(item_id);
      CREATE TABLE user_command_receipt (
        command_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      PRAGMA user_version=5;
      COMMIT;
    `);
    }
    if(version>0){
      const backup=`${this.filename}.pre-v6-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    this.transaction(()=>{
      this.db.exec(catalogSchema);
      this.catalog.backfill();
      this.db.exec('PRAGMA user_version=6');
    });
    }
    if(version<7){
    if(version>0){
      const backup=`${this.filename}.pre-v7-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    this.transaction(()=>{
      this.db.exec(catalogAssociationSchema);
      this.catalog.enableAssociations();
      this.catalog.backfill();
      this.db.exec('PRAGMA user_version=7');
    });
    }
    if(version<8){
    if(version>0){
      const backup=`${this.filename}.pre-v8-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    this.transaction(()=>{
      this.db.exec(artistCurationSchema);
      this.catalog.enableAssociations();this.catalog.enableArtists();
      const items=this.db.prepare('SELECT id FROM playable_item').all() as unknown as Array<{id:string}>;
      for(const item of items){this.catalog.refreshRevision(item.id,true);this.refreshEffectiveSearch(item.id);}
      this.db.exec('PRAGMA user_version=8');
    });
    }
    if(version<9){
    if(version>0){
      const backup=`${this.filename}.pre-v9-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    this.transaction(()=>{
      this.db.exec(releaseCurationSchema);
      this.catalog.enableAssociations();this.catalog.enableArtists();this.catalog.enableReleases();
      const items=this.db.prepare('SELECT id FROM playable_item').all() as unknown as Array<{id:string}>;
      for(const item of items){this.catalog.refreshRevision(item.id,true);this.refreshEffectiveSearch(item.id);}
      this.db.exec('PRAGMA user_version=9');
    });
    }
    if(version<10){
    if(version>0){
      const backup=`${this.filename}.pre-v10-${Date.now()}.bak`;
      this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);
    }
    this.transaction(()=>{
      this.db.exec(artistProfileSchema);
      this.catalog.enableAssociations();this.catalog.enableArtists();this.catalog.enableReleases();this.catalog.enableProfiles();
      const items=this.db.prepare('SELECT id FROM playable_item').all() as unknown as Array<{id:string}>;
      for(const item of items){this.catalog.refreshRevision(item.id,true);this.refreshEffectiveSearch(item.id);}
      this.db.exec('PRAGMA user_version=10');
    });
    }
    if(version<11){
    if(version>0){const backup=`${this.filename}.pre-v11-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{
      this.db.exec(releaseProfileSchema);
      this.catalog.enableAssociations();this.catalog.enableArtists();this.catalog.enableReleases();this.catalog.enableProfiles();this.catalog.enableReleaseProfiles();
      const items=this.db.prepare('SELECT id FROM playable_item').all() as unknown as Array<{id:string}>;
      for(const item of items){this.catalog.refreshRevision(item.id,true);this.refreshEffectiveSearch(item.id);}
      this.db.exec('PRAGMA user_version=11');
    });
    }
    if(version<12){
      if(version>0){const backup=`${this.filename}.pre-v12-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(entityReferenceSchema);this.db.exec('PRAGMA user_version=12');});
    }
    if(version<13){
      if(version>0){const backup=`${this.filename}.pre-v13-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(recordingProfileSchema);this.db.exec('PRAGMA user_version=13');});
    }
    if(version<14){
      if(version>0){const backup=`${this.filename}.pre-v14-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(metadataProvenanceSchema);this.db.exec('PRAGMA user_version=14');});
    }
    if(version<15){
    if(version>0){const backup=`${this.filename}.pre-v15-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(metadataSelectionSchema);this.db.exec('PRAGMA user_version=15');});
    }
    if(version<16){
      if(version>0){const backup=`${this.filename}.pre-v16-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(metadataCollectionsSchema);this.db.exec('PRAGMA user_version=16');});
    }
    if(version<17){
      if(version>0){const backup=`${this.filename}.pre-v17-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{validateGenreTree(this.db);this.db.exec(genreSchema);this.db.exec('PRAGMA user_version=17');});
    }
    if(version<18){
    if(version>0){const backup=`${this.filename}.pre-v18-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(creditNameSchema);this.db.exec('PRAGMA user_version=18');});
    }
    if(version<19){
    if(version>0){const backup=`${this.filename}.pre-v19-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(metadataBatchSchema);this.db.exec('PRAGMA user_version=19');});
    }
    if(version<20){
      if(version>0){const backup=`${this.filename}.pre-v20-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(metadataUndoSchema);this.db.exec('PRAGMA user_version=20');});
    }
    if(version<21){
    if(version>0){const backup=`${this.filename}.pre-v21-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{
      if(version===0)this.db.prepare("INSERT OR IGNORE INTO app_setting(key,value) VALUES('metadata_network_enabled','false')").run();
      this.db.exec(providerSchema);
      this.db.prepare("INSERT OR IGNORE INTO app_setting(key,value) VALUES('provider_credential_scope',?)").run(randomUUID());
      this.db.exec('PRAGMA user_version=21');
    });
    }
    if(version<22){
    if(version>0){const backup=`${this.filename}.pre-v22-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(providerRetentionSchema);this.db.exec('PRAGMA user_version=22');});
    }
    if(version<23){
    if(version>0){const backup=`${this.filename}.pre-v23-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(waveformSchema);this.db.exec('PRAGMA user_version=23');});
    }
    if(version<24){
    if(version>0){const backup=`${this.filename}.pre-v24-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(lyricsPreferenceSchema);this.db.exec('PRAGMA user_version=24');});
    }
    if(version<25){
    if(version>0){const backup=`${this.filename}.pre-v25-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(lyricsDocumentSchema);this.db.exec('PRAGMA user_version=25');});
    }
    if(version<26){
    if(version>0){const backup=`${this.filename}.pre-v26-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(lyricsSavedSchema);this.db.exec('PRAGMA user_version=26');});
    }
    if(version<27){
    if(version>0){const backup=`${this.filename}.pre-v27-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(lyricsContextSchema);this.db.exec('PRAGMA user_version=27');});
    }
    if(version<28){
    // v28 evolves the preference JSON contract. Older builds must reject it rather than discard sourceOrder.
    if(version>0){const backup=`${this.filename}.pre-v28-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec('PRAGMA user_version=28');});
    }
    if(version<29){
    if(version>0){const backup=`${this.filename}.pre-v29-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(scanJobSchema);this.db.exec('PRAGMA user_version=29');});
    }
    if(version<30){
    if(version>0){const backup=`${this.filename}.pre-v30-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(cueTrackSchema);this.db.exec('PRAGMA user_version=30');});
    }
    if(version<31){
    if(version>0){const backup=`${this.filename}.pre-v31-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(artworkStoreSchema);this.db.exec('PRAGMA user_version=31');});
    }
    if(version<32){
    // Compatibility fence: v31 applications only accept the old thumbnail algorithm.
    if(version>0){const backup=`${this.filename}.pre-v32-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec('PRAGMA user_version=32');});
    }
    if(version<33){
    // v32 readers do not understand direction/color-normalized thumbnail assets.
    if(version>0){const backup=`${this.filename}.pre-v33-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec('PRAGMA user_version=33');});
    }
    if(version<34){
    if(version>0){const backup=`${this.filename}.pre-v34-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(lyricsLocalHistorySchema);this.db.exec('PRAGMA user_version=34');});
    }
    if(version<35){
    if(version>0){const backup=`${this.filename}.pre-v35-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(lyricsLocalBrowserSchema);this.db.exec('PRAGMA user_version=35');});
    }
    if(version<36){
    if(version>0){const backup=`${this.filename}.pre-v36-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(audioOutputSettingsSchema);this.db.exec('PRAGMA user_version=36');});
    }
    if(version<37){
    if(version>0){const backup=`${this.filename}.pre-v37-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec('ALTER TABLE media_file ADD COLUMN replay_gain_json TEXT CHECK(replay_gain_json IS NULL OR json_valid(replay_gain_json))');this.db.exec('PRAGMA user_version=37');});
    }
    if(version<38){
    // Opus preferences add fields. Older applications must not read or overwrite the new contract.
    if(version>0){const backup=`${this.filename}.pre-v38-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>this.db.exec('PRAGMA user_version=38'));
    }
    if(version<39){
    if(version>0){const backup=`${this.filename}.pre-v39-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(searchIndexSchema);this.db.exec('PRAGMA user_version=39');});
    }
    if(version<40){
    if(version>0){const backup=`${this.filename}.pre-v40-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
    this.transaction(()=>{this.db.exec(fileObservationSchema);this.db.exec('PRAGMA user_version=40');});
    }
    if(version<41){
      if(version>0){const backup=`${this.filename}.pre-v41-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(filePolicySchema);this.db.exec('PRAGMA user_version=41');});
    }
    if(version<42){
      if(version>0){const backup=`${this.filename}.pre-v42-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(cueHistorySchema);this.db.exec('PRAGMA user_version=42');});
    }
    if(version<43){
      if(version>0){const backup=`${this.filename}.pre-v43-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(`
        ALTER TABLE cue_source_file ADD COLUMN gap_policy TEXT NOT NULL DEFAULT 'previous' CHECK(gap_policy IN('previous','current'));
        ALTER TABLE cue_source_version ADD COLUMN gap_policy TEXT NOT NULL DEFAULT 'previous' CHECK(gap_policy IN('previous','current'));
        ALTER TABLE cue_document ADD COLUMN gap_policy TEXT NOT NULL DEFAULT 'previous' CHECK(gap_policy IN('previous','current'));
        CREATE INDEX playable_item_cue_identity ON playable_item(substr(cue_key,1,36),file_id,track_number) WHERE kind='cue';
        PRAGMA user_version=43;
      `);});
    }
    if(version<44){
      if(version>0){const backup=`${this.filename}.pre-v44-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(asioOutputSettingsSchema);this.db.exec('PRAGMA user_version=44');});
    }
    if(version<45){
      if(version>0){const backup=`${this.filename}.pre-v45-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(audioBackendSettingsSchema);this.db.exec('PRAGMA user_version=45');});
    }
    if(version<46){
      if(version>0){const backup=`${this.filename}.pre-v46-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(dsdOutputSettingsSchema);this.db.exec('PRAGMA user_version=46');});
    }
    if(version<47){
      if(version>0){const backup=`${this.filename}.pre-v47-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagWriteJobsSchema);this.db.exec('PRAGMA user_version=47');});
    }
    if(version<48){
      if(version>0){const backup=`${this.filename}.pre-v48-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagWriteExecutionSchema);this.db.exec('PRAGMA user_version=48');});
    }
    if(version<49){
      if(version>0){const backup=`${this.filename}.pre-v49-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagRecoverySchema);this.db.exec('PRAGMA user_version=49');});
    }
    if(version<50){
      if(version>0){const backup=`${this.filename}.pre-v50-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagRecoveryActionSchema);this.db.exec('PRAGMA user_version=50');});
    }
    if(version<51){
      if(version>0){const backup=`${this.filename}.pre-v51-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagCommitSchema);this.db.exec('PRAGMA user_version=51');});
    }
    if(version<52){
      if(version>0){const backup=`${this.filename}.pre-v52-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagCommitRecoverySchema);this.db.exec('PRAGMA user_version=52');});
    }
    if(version<53){
      if(version>0){const backup=`${this.filename}.pre-v53-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagCommitReprobeSchema);this.db.exec('PRAGMA user_version=53');});
    }
    if(version<54){
      if(version>0){const backup=`${this.filename}.pre-v54-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagCommitReconcileSchema);this.db.exec('PRAGMA user_version=54');});
    }
    if(version<55){
      if(version>0){const backup=`${this.filename}.pre-v55-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagRestoreSchema);this.db.exec('PRAGMA user_version=55');});
    }
    if(version<56){
      if(version>0){const backup=`${this.filename}.pre-v56-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagRestoreRecoverySchema);this.db.exec('PRAGMA user_version=56');});
    }
    if(version<57){
      if(version>0){const backup=`${this.filename}.pre-v57-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(tagRestoreReprobeSchema);this.db.exec('PRAGMA user_version=57');});
    }
    if(version<58){
      if(version>0){const backup=`${this.filename}.pre-v58-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      // Guard only: preserve immutable JSON and raw native histories.
      this.transaction(()=>this.db.exec('PRAGMA user_version=58'));
    }
    if(version<59){
      if(version>0){const backup=`${this.filename}.pre-v59-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(spellingSchema);this.db.exec('PRAGMA user_version=59');});
    }
    if(version<60){
      if(version>0){const backup=`${this.filename}.pre-v60-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(musicFiltersSchema);this.db.exec('PRAGMA user_version=60');});
    }
    if(version<61){
      if(version>0){const backup=`${this.filename}.pre-v61-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(sortSchema);this.db.exec("UPDATE search_index_state SET algorithm='',cursor='',processed=0,status='building',message='' WHERE id=1" );this.db.exec('PRAGMA user_version=61');});
    }
    if(version<62){
      if(version>0){const backup=`${this.filename}.pre-v62-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(smartPlaylistSchema);if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('歌单迁移外键核对失败');this.db.exec('PRAGMA user_version=62');});
    }
    if(version<63){
      if(version>0){const backup=`${this.filename}.pre-v63-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(playbackHistorySchema);this.db.exec('PRAGMA user_version=63');});
    }
    if(version<64){
      if(version>0){const backup=`${this.filename}.pre-v64-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(playbackStatisticsSchema);this.db.exec('PRAGMA user_version=64');});
    }
    if(version<65){
      if(version>0){const backup=`${this.filename}.pre-v65-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(filterPresetSchema);this.db.exec('PRAGMA user_version=65');});
    }
    if(version<66){
      if(version>0){const backup=`${this.filename}.pre-v66-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(smartPlaylistHistorySchema);if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('智能规则历史迁移外键核对失败');this.db.exec('PRAGMA user_version=66');});
    }
    if(version<67){
      if(version>0){const backup=`${this.filename}.pre-v67-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(ruleTransferSchema);this.db.prepare('INSERT INTO rule_transfer_origin VALUES(1,?)').run(randomUUID());if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('规则迁移外键核对失败');this.db.exec('PRAGMA user_version=67');});
    }
    if(version<68){
      if(version>0){const backup=`${this.filename}.pre-v68-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(playbackPolicySchema);initializePlaybackPolicy(this.db);if(this.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('播放统计规则迁移外键核对失败');this.db.exec('PRAGMA user_version=68');});
    }
    if(version<69){
      if(version>0){const backup=`${this.filename}.pre-v69-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(embeddedCueHistorySchema);new EmbeddedCueHistory(this.db,action=>this.transaction(action)).adoptRetainedDocuments();if(this.db.prepare('PRAGMA foreign_key_check').get())throw new Error('内嵌 CUE 历史迁移外键核对失败');this.db.exec('PRAGMA user_version=69');});
    }
    if(version<70){
      if(version>0){const backup=`${this.filename}.pre-v70-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(cueSourceSelectionSchema);if(this.db.prepare('PRAGMA foreign_key_check').get())throw new Error('CUE原文选择迁移外键核对失败');this.db.exec('PRAGMA user_version=70');});
    }
    if(version<71){
      if(version>0){const backup=`${this.filename}.pre-v71-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(cueSourceImportSchema);if(this.db.prepare('PRAGMA foreign_key_check').get())throw new Error('CUE来源备份导入迁移外键核对失败');this.db.exec('PRAGMA user_version=71');});
    }
    if(version<72){
      if(version>0){const backup=`${this.filename}.pre-v72-${Date.now()}.bak`;this.db.exec(`VACUUM INTO '${backup.replace(/'/g,"''")}'`);}
      this.transaction(()=>{this.db.exec(cueSourceRegistrationSchema);if(this.db.prepare('PRAGMA foreign_key_check').get())throw new Error('新CUE来源登记迁移外键核对失败');this.db.exec('PRAGMA user_version=72');});
    }
    if(version<73){
      const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version>0,progress);
      progress?.('index-update');
      this.transaction(()=>{this.db.exec(queryIndexSchema);progress?.('index-verify');verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=73');});
    }
    if(version<74){
      const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===73,progress,{from:73,to:74});
      this.transaction(()=>{this.db.exec(onlineArtworkSchema);verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=74');});
    }
    if(version<75){
      const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===74,progress,{from:74,to:75});
      this.transaction(()=>{migrateReleaseTrackReferences(this.db);verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=75');});
    }
    if(version<76){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===75,progress,{from:75,to:76});this.transaction(()=>{this.db.exec(metadataWorkflowSchema);verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=76');});}
    if(version<77){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===76,progress,{from:76,to:77});this.transaction(()=>{this.db.exec(metadataRecognitionSchema);verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=77');});}
    if(version<78){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===77,progress,{from:77,to:78});this.transaction(()=>{this.db.exec(recognitionMappingSchema);verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=78');});}
    if(version<79){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===78,progress,{from:78,to:79});this.transaction(()=>{this.db.exec(recognitionRetrySchema);verifyQueryIndexUpgrade(this.db,counts);this.db.exec('PRAGMA user_version=79');});}
    if(version<80){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===79,progress,{from:79,to:80});migrateTagRestoreAttempts(this.db,action=>this.transaction(action),()=>verifyQueryIndexUpgrade(this.db,counts));}
    if(version<81){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===80,progress,{from:80,to:81});this.transaction(()=>{this.db.exec(tagStageBatchSchema);progress?.('index-verify');verifyQueryIndexUpgrade(this.db,counts);validateTagStageBatches(this.db);this.db.exec('PRAGMA user_version=81');});}
    if(version<82){const counts=snapshotQueryIndexUpgrade(this.db,this.filename,version===81,progress,{from:81,to:82});this.transaction(()=>{this.db.exec(tagCommitBatchSchema);progress?.('index-verify');verifyQueryIndexUpgrade(this.db,counts);validateTagCommitBatches(this.db);this.db.exec('PRAGMA user_version=82');});}
  }

  private transaction<T>(action: () => T): T {
    if(this.db.isTransaction){const name=`aural_nested_${++this.savepointSerial}`;this.db.exec(`SAVEPOINT ${name}`);try{const result=action();this.db.exec(`RELEASE SAVEPOINT ${name}`);return result;}catch(error){this.db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);throw error;}}
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  addRoot(folder: string): string {
    const canonical = path.resolve(folder);
    const found = this.db.prepare('SELECT id FROM library_root WHERE path=?').get(canonical) as { id: string } | undefined;
    if (found) return found.id;
    const id = randomUUID();
    this.db.prepare('INSERT INTO library_root(id,path,status) VALUES(?,?,?)').run(id, canonical, 'online');
    return id;
  }

  roots(): Array<{ id: string; path: string; status: RootStatus }> {
    return this.db.prepare('SELECT id,path,status FROM library_root ORDER BY path').all() as unknown as Array<{ id: string; path: string; status: RootStatus }>;
  }

  desktopFiles(input:unknown):import('../shared/desktop-files.js').DesktopFileMatches{return desktopSources(this.db,input,ids=>this.getItems(ids));}
  getRoot(id: string): RootRow | undefined {
    return this.db.prepare('SELECT * FROM library_root WHERE id=?').get(id) as RootRow | undefined;
  }
  reviewCueVersion(value:unknown):import('../shared/cue-version-review.js').CueVersionReview {
    return reviewCueVersion(this.db,this.cueSources,value,{root:id=>this.getRoot(id),authorization:root=>({allowed:this.restorePolicy.rootAuthorized(root),sha256:createHash('sha256').update(JSON.stringify([this.restorePolicy.load(),this.libraryWatch.load(root)])).digest('hex')}),readable:id=>this.tagWriteJobs.assertReadable(id)});
  }
  selectCueSource(value:unknown):CueSourceSelectionResult {
    const request=readCueSourceSelectionRequest(value);
    return this.cueSources.selectSource(request,()=>{
      const review=this.reviewCueVersion({fileId:request.fileId,versionId:request.selectedVersion??request.latestVersion,baseRevision:request.baseRevision,latestVersion:request.latestVersion,encoding:request.encoding,gapPolicy:request.gapPolicy,offset:0,expectedMappingSha256:request.reviewSha256});
      if(review.invalid||review.warnings.length||review.warningsOmitted||!review.visibleTracks||!review.rootAuthorized||review.rootStatus!=='online'||review.unavailableTracks)throw new Error('请先处理原文、目录授权和全部引用范围，再选择此原文');
    });
  }
  cueSourceSelectionScope(value:unknown):{request:ReturnType<typeof readCueSourceSelectionRequest>;documentIds:string[];fileIds:string[]} {
    const request=readCueSourceSelectionRequest(value),source=this.cueSources.source(request.fileId),result={request,documentIds:[] as string[],fileIds:[] as string[]};
    if(source.revision!==request.baseRevision||source.latestVersion!==request.latestVersion)return result;
    result.documentIds=source.documentIds;const root=this.getRoot(source.rootId),versionId=request.selectedVersion??request.latestVersion;if(!root||!versionId)return result;
    try{
      const parsed=this.cueSources.reviewSource({fileId:request.fileId,versionId,baseRevision:request.baseRevision,latestVersion:request.latestVersion,encoding:request.encoding,gapPolicy:request.gapPolicy,offset:0}).parsed;
      const ids=new Set<string>();for(const entry of parsed.document.entries){const full=resolveCueReference(root.path,path.resolve(root.path,source.relativePath),entry.file);if(full){const row=this.fileSnapshot(root.id,path.relative(root.path,full));if(row)ids.add(row.id);}}
      result.fileIds=[...ids];
    }catch{/* Final acceptance independently records semantic rejection; scope never authorizes an application. */}
    return result;
  }
  importCueSource(value:unknown):CueSourceImportResult {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'request')||!Object.hasOwn(value,'bundle'))throw new Error('私有CUE来源备份导入值无效');
    const input=value as {request:unknown;bundle:unknown},request=readCueSourceImportRequest(input.request);
    return this.cueSources.importBundle(request,input.bundle,source=>{const root=this.getRoot(source.rootId);if(!root||root.path!==source.rootPath)throw new Error('目标CUE来源目录已改变，请重新绑定后导入');});
  }
  registerCueSource(value:unknown):CueSourceImportResult {
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'request')||!Object.hasOwn(value,'bundle'))throw new Error('私有新CUE来源登记值无效');
    const input=value as {request:unknown;bundle:unknown},request=readCueSourceRegisterRequest(input.request);
    return this.cueSources.registerBundle(request,input.bundle,()=>{const root=this.getRoot(request.rootId);if(!root||root.path!==request.rootPath)throw new Error('登记目标音乐目录已变化，请重新选择当前目录');});
  }

  beginScan(rootId: string): number {
    const root=this.getRoot(rootId);if(!root||!Number.isSafeInteger(root.scan_generation)||root.scan_generation<0||root.scan_generation>=Number.MAX_SAFE_INTEGER)throw new Error('扫描目录或代次无效');
    this.db.prepare("UPDATE library_root SET status='scanning',scan_generation=scan_generation+1 WHERE id=?").run(rootId);
    return this.getRoot(rootId)?.scan_generation ?? 0;
  }

  continueScan(rootId:string,generation:number):void{const root=this.getRoot(rootId);if(!root||root.scan_generation!==generation)throw new Error('扫描代次已被替代');this.db.prepare("UPDATE library_root SET status='scanning' WHERE id=?").run(rootId);}
  hasCue(rootId:string,relative:string):boolean{return !!this.db.prepare('SELECT id FROM cue_document WHERE root_id=? AND relative_path=?').get(rootId,relative);}
  protectCue(rootId:string,relative:string,generation:number):void{this.db.prepare('UPDATE cue_document SET seen_generation=? WHERE root_id=? AND relative_path=?').run(generation,rootId,relative);}

  endScan(rootId: string, complete: boolean): void {
    const root = this.getRoot(rootId);
    if (!root) return;
    this.transaction(() => {
      if (complete) {
        this.db.prepare("UPDATE media_file SET status='missing' WHERE root_id=? AND seen_generation<>?").run(rootId, root.scan_generation);
        const stale = this.db.prepare('SELECT id FROM cue_document WHERE root_id=? AND seen_generation<>?').all(rootId,root.scan_generation) as unknown as Array<{id:string}>;
        for (const cue of stale) {
          this.db.prepare("UPDATE playable_item SET visible=0 WHERE kind='cue' AND cue_key LIKE ?").run(`${cue.id}:%`);
        }
      }
      this.db.prepare(`UPDATE playable_item SET visible=1 WHERE id IN(
        SELECT t.item_id FROM cue_track t JOIN cue_document d ON d.id=t.cue_id JOIN media_file f ON f.id=t.media_file_id
        WHERE d.root_id=? AND d.parser_version IN(?,?,?,?) AND d.seen_generation=? AND f.seen_generation=?
        AND (json_extract(d.fields_json,'$.playable')=1 OR (json_extract(d.fields_json,'$.playable') IS NULL AND json_type(d.fields_json,'$.embedded')='object' AND json_extract(d.fields_json,'$.notice')=''))
        AND NOT EXISTS(SELECT 1 FROM cue_track x JOIN cue_document e ON e.id=x.cue_id JOIN playable_item p ON p.id=x.item_id
          WHERE x.media_file_id=t.media_file_id AND COALESCE(e.parser_version,'') NOT LIKE 'aural-flac-cuesheet-%' AND p.visible=1))`).run(rootId,FLAC_CUE_PARSER,'aural-flac-cuesheet-1','aural-flac-cuesheet-2','aural-flac-cuesheet-3',root.scan_generation,root.scan_generation);
      this.db.prepare("UPDATE playable_item SET visible=1 WHERE kind='file' AND file_id IN (SELECT id FROM media_file WHERE root_id=?)").run(rootId);
      this.db.prepare("UPDATE playable_item SET visible=0 WHERE kind='file' AND file_id IN (SELECT file_id FROM playable_item WHERE kind='cue' AND visible=1) AND file_id IN (SELECT id FROM media_file WHERE root_id=?)").run(rootId);
      this.db.prepare("UPDATE library_root SET status='online' WHERE id=?").run(rootId);
    });
  }

  markRootOffline(rootId: string): void {
    this.db.prepare("UPDATE library_root SET status='offline' WHERE id=?").run(rootId);
  }

  fileSnapshot(rootId: string, relativePath: string): FileRow | undefined {
    return this.db.prepare('SELECT f.id,f.size,f.mtime_ms,f.duration_seconds,f.parse_error,o.stamp observation_hash FROM media_file f LEFT JOIN media_file_observation o ON o.file_id=f.id AND o.algorithm=? WHERE f.root_id=? AND f.path_key=?')
      .get(FILE_OBSERVATION_ALGORITHM,rootId, normalize(relativePath)) as FileRow | undefined;
  }

  private markEmbeddedCueSeen(fileId:string,generation:number):void{this.db.prepare('UPDATE cue_document SET seen_generation=? WHERE parser_version IN(?,?,?,?) AND EXISTS(SELECT 1 FROM media_file f WHERE f.id=? AND f.root_id=cue_document.root_id AND f.relative_path=cue_document.relative_path)').run(generation,FLAC_CUE_PARSER,'aural-flac-cuesheet-1','aural-flac-cuesheet-2','aural-flac-cuesheet-3',fileId);}
  protectFile(fileId:string,generation:number):void{this.db.prepare('UPDATE media_file SET seen_generation=? WHERE id=?').run(generation,fileId);this.markEmbeddedCueSeen(fileId,generation);}

  markSeen(fileId: string, generation: number): void {
    this.db.prepare("UPDATE media_file SET seen_generation=?,status='online' WHERE id=?").run(generation, fileId);
    this.markEmbeddedCueSeen(fileId,generation);
  }

  private refreshSearch(itemId: string, title: string, artist: string, album: string, genre: string,freshItem=false,sort?:SearchSource['sort']): void {
    this.transaction(()=>{
    const fields = [title, artist, album, genre].map(normalize);
    if(this.searchIndex)this.searchIndex.put(itemId,fields,sort,freshItem);
    else updateLiteralSearchIndex(this.db,itemId,fields,freshItem);
    });
  }

  private deleteSearch(itemId: string): void {
    this.transaction(()=>{
    this.db.prepare('DELETE FROM search_fts WHERE item_id=?').run(itemId);
    this.db.prepare('DELETE FROM search_gram WHERE item_id=?').run(itemId);
    this.searchIndex?.delete(itemId);
    });
  }

  private searchSources(ids:string[]):SearchSource[]{
    if(!ids.length)return [];if(ids.length>64)throw new Error('检索索引读取预算超限');
    const rows=this.db.prepare(`SELECT p.id,COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,
      COALESCE(o.album,p.album) album,p.genre FROM playable_item p LEFT JOIN metadata_override o ON o.item_id=p.id WHERE p.id IN (${ids.map(()=>'?').join(',')})`).all(...ids) as unknown as Array<{id:string;title:string;artist:string;album:string;genre:string}>;
    const projects=this.catalog.project(ids);
    return rows.map(row=>{const catalog=projects.get(row.id);return {id:row.id,sort:{title:row.title,artist:catalog&&(catalog.creditConfirmed||catalog.artistDisplay)?catalog.artistDisplay??'':row.artist,album:catalog?.releaseTitle??row.album,releaseTitle:catalog?.releaseTitle??'',date:catalog?.releaseDate??''},fields:[row.title,[catalog?.creditConfirmed?'':row.artist,catalog?.artistDisplay??'',...(catalog?.artists.map(member=>member.name)??[]),...(catalog?.recordingArtists?.map(member=>member.name)??[]),catalog?.albumArtist??''].join(' '),[row.album,catalog?.releaseTitle??'',catalog?.groupTitle??'',catalog?.recordingTitle??'',catalog?.recordingVersionLabel??''].join(' '),(catalog?catalog.genres.map(genre=>genre.name):[row.genre]).join(' ')].map(normalize)};});
  }
  private refreshEffectiveSearch(itemId: string,freshItem=false): void {
    const source=this.searchSources([itemId])[0];
    if(source)this.refreshSearch(itemId,source.fields[0],source.fields[1],source.fields[2],source.fields[3],freshItem,source.sort);
  }

  loadMediaKeyPreference():MediaKeyPreference{
    const row=this.db.prepare("SELECT value FROM app_setting WHERE key='media_key_preference'").get() as {value:string}|undefined;
    return row?readMediaKeyPreference(JSON.parse(row.value)):defaultMediaKeyPreference();
  }
  saveMediaKeyPreference(value:unknown):MediaKeyPreference{
    if(!value||typeof value!=='object'||Object.keys(value).length!==2)throw new Error('无效媒体键设置请求');
    const r=value as {expected:unknown;value:unknown},before=readMediaKeyPreference(r.expected),next=readMediaKeyPreference(r.value);
    if(before.revision>=Number.MAX_SAFE_INTEGER||next.revision!==before.revision+1)throw new Error('媒体键设置修订无效');
    return this.transaction(()=>{
      const current=this.loadMediaKeyPreference();if(JSON.stringify(current)===JSON.stringify(next))return current;
      if(JSON.stringify(current)!==JSON.stringify(before))throw new Error('媒体键设置已变化，请重新读取');
      this.db.prepare("INSERT INTO app_setting(key,value) VALUES('media_key_preference',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));return next;
    });
  }
  loadCatalogViewPreference():CatalogViewPreference{
    const row=this.db.prepare("SELECT value FROM app_setting WHERE key='catalog_view_preference'").get() as {value:string}|undefined;
    return row?readCatalogViewPreference(JSON.parse(row.value)):defaultCatalogViewPreference();
  }
  saveCatalogViewPreference(value:unknown):CatalogViewPreference{
    const {expected,value:next}=readCatalogViewSave(value);
    return this.transaction(()=>{const current=this.loadCatalogViewPreference();if(JSON.stringify(current)===JSON.stringify(next))return current;
      if(JSON.stringify(current)!==JSON.stringify(expected))throw new Error('分类显示设置已变化，请重新读取');
      this.db.prepare("INSERT INTO app_setting(key,value) VALUES('catalog_view_preference',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));return next;});
  }
  loadAppearancePreference():AppearancePreference{
    const row=this.db.prepare("SELECT value FROM app_setting WHERE key='appearance_preference'").get() as {value:string}|undefined;
    return row?readAppearancePreference(JSON.parse(row.value)):defaultAppearancePreference();
  }
  saveAppearancePreference(value:unknown):AppearancePreference{
    if(!value||typeof value!=='object'||Object.keys(value).length!==2)throw new Error('无效外观设置请求');
    const r=value as {expected:unknown;value:unknown},before=readAppearancePreference(r.expected),next=readAppearancePreference(r.value);
    if(before.revision>=Number.MAX_SAFE_INTEGER||next.revision!==before.revision+1)throw new Error('外观设置修订无效');
    return this.transaction(()=>{const current=this.loadAppearancePreference();if(JSON.stringify(current)===JSON.stringify(next))return current;
      if(JSON.stringify(current)!==JSON.stringify(before))throw new Error('外观设置已变化，请重新读取');
      this.db.prepare("INSERT INTO app_setting(key,value) VALUES('appearance_preference',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));return next;});
  }
  loadWindowPlacementPreference():WindowPlacementPreference{
    const row=this.db.prepare("SELECT value FROM app_setting WHERE key='window_placement'").get() as {value:string}|undefined;
    return row?readWindowPlacementPreference(JSON.parse(row.value)):defaultWindowPlacementPreference();
  }
  saveWindowPlacementPreference(value:unknown):WindowPlacementPreference{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'expected')||!Object.hasOwn(value,'value'))throw new Error('无效窗口位置请求');
    const r=value as {expected:unknown;value:unknown},before=readWindowPlacementPreference(r.expected),next=readWindowPlacementPreference(r.value);
    if(before.revision>=Number.MAX_SAFE_INTEGER||next.revision!==before.revision+1)throw new Error('窗口位置修订无效');
    return this.transaction(()=>{const current=this.loadWindowPlacementPreference();if(JSON.stringify(current)===JSON.stringify(next))return current;
      if(JSON.stringify(current)!==JSON.stringify(before))throw new Error('窗口位置已变化，请重新读取');
      this.db.prepare("INSERT INTO app_setting(key,value) VALUES('window_placement',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));return next;});
  }
  loadDesktopPreference():DesktopPreference{
    const row=this.db.prepare("SELECT value FROM app_setting WHERE key='desktop_preference'").get() as {value:string}|undefined;
    return row?readDesktopPreference(JSON.parse(row.value)):defaultDesktopPreference();
  }
  saveDesktopPreference(value:unknown):DesktopPreference{
    if(!value||typeof value!=='object'||Object.keys(value).length!==2)throw new Error('无效窗口设置请求');
    const r=value as {expected:unknown;value:unknown},before=readDesktopPreference(r.expected),next=readDesktopPreference(r.value);
    if(before.revision>=Number.MAX_SAFE_INTEGER||next.revision!==before.revision+1)throw new Error('窗口设置修订无效');
    return this.transaction(()=>{
      const current=this.loadDesktopPreference();if(JSON.stringify(current)===JSON.stringify(next))return current;
      if(JSON.stringify(current)!==JSON.stringify(before))throw new Error('窗口设置已变化，请重新读取');
      this.db.prepare("INSERT INTO app_setting(key,value) VALUES('desktop_preference',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next));return next;
    });
  }
  metadataNetworkEnabled():boolean{return this.providerSettings.setting('musicbrainz').enabled;}
  metadataRetentionMode():import('../shared/contracts.js').ProviderRetentionMode{return retentionState(this.db,'musicbrainz').mode;}
  requireMetadataRetention():void{requireOnlineRetention(this.db,'musicbrainz');}
  setMetadataNetworkEnabled(enabled:boolean):void{if(typeof enabled!=='boolean')throw new Error('无效在线查询设置');this.providerSettings.configure({commandId:randomUUID(),providerId:'musicbrainz',revision:this.providerSettings.setting('musicbrainz').revision,enabled});}
  metadataContact(): string {
    return (this.db.prepare("SELECT value FROM app_setting WHERE key='musicbrainz_contact'").get() as {value:string}|undefined)?.value ?? '';
  }

  setMetadataContact(contact: string): void {
    this.db.prepare("INSERT INTO app_setting(key,value) VALUES('musicbrainz_contact',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(contact);
  }

  loadQueue(): QueueState | null {
    const row=this.db.prepare("SELECT value FROM app_setting WHERE key='playback_queue'").get() as {value:string}|undefined;
    if(!row)return null;
    let parsed:unknown;
    try{parsed=JSON.parse(row.value);}catch{throw new Error('已保存的播放队列无法解析，需要先恢复曲库备份');}
    if(!validQueueState(parsed))throw new Error('已保存的播放队列无效，需要先恢复曲库备份');
    return parsed;
  }

  saveQueue(state: QueueState,baseRevision:number): void {
    if(!validQueueState(state)||!Number.isSafeInteger(baseRevision)||baseRevision<0||state.revision!==baseRevision+1)
      throw new Error('无效队列修订');
    const json=JSON.stringify(state);
    if(json.length>200_000)throw new Error('队列数据超过限制');
    this.transaction(()=>{
      const current=this.loadQueue();
      if((current?.revision??0)!==baseRevision)throw new Error('队列版本已变化，请刷新后重试');
      this.db.prepare("INSERT INTO app_setting(key,value) VALUES('playback_queue',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(json);
    });
  }

  metadataRevision(itemId: string): number {
    return (this.db.prepare('SELECT revision FROM metadata_override WHERE item_id=?').get(itemId) as {revision:number}|undefined)?.revision ?? 0;
  }

  lockedMetadataFields(itemId:string):MetadataField[]{return (['title','artist','album'] as MetadataField[]).filter(field=>fieldLocked(this.db,'playable_item',itemId,field));}

  metadataCreditTargets(itemId:string):Array<Omit<import('../shared/contracts.js').MetadataCreditTarget,'candidates'>>{
    const item=this.getItem(itemId);if(!item?.catalog)throw new Error('曲目不存在或缺少曲库关联');
    const targets:Array<[import('../shared/contracts.js').MetadataCollectionKind,string,import('../shared/contracts.js').MetadataCollectionField]>=[['playable_item',item.id,'artists'],['recording',item.catalog.recordingId,'artists'],['release',item.catalog.releaseId,'albumArtists']];
    return targets.map(([kind,entityId,field])=>{const value=this.metadataCollections.get(kind,entityId,field),ref={kind,entityId,field,revision:value.revision,fingerprint:value.fingerprint};return {ref,title:value.title,locked:value.locked||kind==='playable_item'&&fieldLocked(this.db,'playable_item',item.id,'artist'),itemCount:this.metadataCollections.affectedCount(ref),current:value.values};});
  }
  metadataCreditMembers(credits:import('../shared/contracts.js').MetadataProviderCredit[]):import('../shared/contracts.js').MetadataCreditMember[]{return credits.map(member=>({...member,...providerArtistIdentity(this.db,member.externalId)}));}

  metadataReviewFingerprint(itemId:string):string {
    const item=this.getItem(itemId);if(!item)throw new Error('曲目不存在');
    return this.metadataReviewFingerprintForLoadedItem(item);
  }
  private metadataReviewFingerprintForLoadedItem(item:LibraryItem):string {
    const itemId=item.id;
    return createHash('sha256').update(JSON.stringify([item.id,item.fileId,item.path,item.fileStamp,item.fileObservation,item.kind,item.available,item.title,item.artist,item.album,item.durationSeconds,item.discNumber,item.trackNumber,item.catalog,this.metadataRevision(itemId),provenanceSnapshot(this.db,'playable_item',itemId),retentionState(this.db,'musicbrainz')])).digest('hex');
  }
  metadataRecordingLookupContext(itemId:string):{references:string[];fingerprint:string;isrcs:string[];isrcSource:'file-tag'|'cue';notices:string[]} {
    const item=this.getItem(itemId);if(!item)throw new Error('曲目不存在');
    const isrcSource=item.kind==='cue'?'cue':'file-tag',cue=item.kind==='cue'?this.db.prepare('SELECT cue_id,source_ordinal,fields_json FROM cue_track WHERE item_id=?').get(itemId):undefined,tag=this.db.prepare("SELECT json_extract(json,'$.isrcs') raw FROM item_catalog_source WHERE item_id=?").get(itemId) as {raw:string|null}|undefined;
    const source=cue?JSON.parse(String(cue.fields_json)).isrc:undefined,raw=item.kind==='cue'?(source===undefined?[]:[source]):tag?.raw?JSON.parse(tag.raw):[],parsed=localISRCs(raw),notices:string[]=[];
    if(parsed.invalidCount)notices.push(`${parsed.invalidCount} 个来源编码无效，未用于查询`);if(item.kind==='cue'&&!parsed.codes.length)notices.push('该CUE音轨没有有效编码，不使用镜像文件的录音编码');
    if(item.cue?.interpretationPending)notices.push('CUE编排尚待审核，暂不按录音编码查询');
    const base=item.catalog?this.metadataRecordingReferenceFingerprint(item.catalog.recordingId):createHash('sha256').update(JSON.stringify([itemId,null])).digest('hex'),fingerprint=raw.length?createHash('sha256').update(JSON.stringify([base,raw,cue??null,item.catalog?.revision,item.fileObservation,item.cue])).digest('hex'):base;
    return {references:item.catalog?this.references.get('recording',item.catalog.recordingId).references.filter(r=>r.provider==='musicbrainz').map(r=>r.externalId):[],fingerprint,isrcs:item.cue?.interpretationPending?[]:parsed.codes,isrcSource,notices};
  }
  private metadataRecordingReferenceFingerprint(recordingId:string):string {
    const state=this.db.prepare("SELECT revision FROM entity_reference_state WHERE entity_kind='recording' AND entity_id=?").get(recordingId)??null;
    const refs=this.db.prepare("SELECT provider,external_id,url FROM external_ref WHERE entity_kind='recording' AND entity_id=? ORDER BY provider,external_id").all(recordingId);
    return createHash('sha256').update(JSON.stringify([recordingId,state,refs])).digest('hex');
  }
  metadataAlbumSnapshot(releaseId:string):MetadataAlbumLocalSnapshot {
    const release=this.releases.summary(releaseId);if(release.fileCount>5000)throw new Error('整专辑审核最多5000个本地版本');
    const ids=(this.db.prepare('SELECT p.id FROM playable_item p JOIN release_track t ON t.id=p.release_track_id JOIN medium m ON m.id=t.medium_id WHERE m.release_id=? ORDER BY m.disc_no,t.position,p.id LIMIT 5001').all(releaseId) as Array<{id:string}>).map(r=>r.id);
    const items=this.getItems(ids),versions=new Map<string,number>();for(const item of items)if(item.catalog)versions.set(item.catalog.releaseTrackId,(versions.get(item.catalog.releaseTrackId)??0)+1);
    const known=new Map<string,string[]>();return {release:{releaseId,revision:release.revision,fingerprint:release.fingerprint},title:release.title,media:release.media,rows:items.map(item=>{const c=item.catalog!;if(!known.has(c.recordingId))known.set(c.recordingId,this.references.get('recording',c.recordingId).references.filter(r=>r.provider==='musicbrainz').map(r=>r.externalId));return {itemId:item.id,localTrackId:c.releaseTrackId,localRecordingId:c.recordingId,title:item.title,artist:item.artist,album:item.album,codec:item.codec,discNumber:item.discNumber??c.mediumDiscNumber??null,trackNumber:item.trackNumber??c.trackPosition??null,durationSeconds:item.durationSeconds,versionCount:versions.get(c.releaseTrackId)??1,knownRecordingId:known.get(c.recordingId)?.[0]??null,knownRecordingIds:known.get(c.recordingId)??[],lockedFields:this.lockedMetadataFields(item.id),creditConfirmed:c.creditConfirmed===true,revision:this.metadataRevision(item.id),fingerprint:this.metadataReviewFingerprintForLoadedItem(item),referenceFingerprint:this.metadataRecordingReferenceFingerprint(c.recordingId)};})};
  }
  applyMetadata(itemId:string,baseRevision:number,candidate:MetadataCandidate,fields:MetadataField[]):MetadataChangeResult {
    return this.transaction(()=>this.applyMetadataInTransaction(itemId,baseRevision,candidate,fields));
  }
  private applyMetadataInTransaction(itemId: string, baseRevision: number, candidate: MetadataCandidate, fields: MetadataField[]): MetadataChangeResult {
    requireOnlineRetention(this.db,candidate.provider);
    const fieldSources=readMetadataFieldSources(candidate.fieldSourceUrls,candidate.recordingId,candidate.releaseId);
    const permitted=new Set<MetadataField>(['title','artist','album']);
    if (!fields.length || fields.some(field=>!permitted.has(field)) || new Set(fields).size!==fields.length) throw new Error('请选择有效且不重复的元数据字段');
      const item=this.getItem(itemId);
      if (!item) throw new Error('曲目不存在');
      if(candidate.albumContext){const context=readMetadataAlbumBinding(candidate.albumContext,candidate.recordingId,candidate.releaseId);if(item.catalog?.recordingId!==context.localRecordingId||this.metadataRecordingReferenceFingerprint(context.localRecordingId)!==context.localRecordingReferenceFingerprint)throw new MetadataReviewConflictError('录音外部引用或关联在审核后已变化，保留当前曲库值');}
      const before=this.db.prepare('SELECT title,artist,album,revision FROM metadata_override WHERE item_id=?').get(itemId) as
        {title:string|null;artist:string|null;album:string|null;revision:number}|undefined;
      const revision=before?.revision ?? 0;
      if (revision!==baseRevision) throw new Error('曲目元数据已变化，请重新匹配');
      const values:{title:string|null;artist:string|null;album:string|null}={title:before?.title??null,artist:before?.artist??null,album:before?.album??null};
      const previous={...values};
      const sourceBefore=provenanceSnapshot(this.db,'playable_item',itemId);
      const updated:MetadataField[]=[];
      for (const field of fields) {
        if(fieldLocked(this.db,'playable_item',itemId,field))throw new Error('所选字段已锁定，请先解除锁定');
        if(field==='artist'&&item.catalog?.creditConfirmed)throw new Error('此歌曲使用已确认的多成员署名，请通过完整署名审核修改');
        const value=candidate[field];
        if (typeof value!=='string' || !value.trim() || value.length>240) throw new Error(`候选 ${field} 字段无效`);
        if (item[field]!==value.trim()) {values[field]=value.trim();updated.push(field);}
      }
      if (!updated.length) throw new Error('所选字段与当前曲库一致');
      const afterRevision=revision+1;
      this.db.prepare(`INSERT INTO metadata_override(item_id,title,artist,album,revision) VALUES(?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,revision=excluded.revision`)
        .run(itemId,values.title,values.artist,values.album,afterRevision);
      recordOnline(this.db,itemId,Object.fromEntries(updated.map(field=>[field,values[field]!])),Object.fromEntries(updated.map(field=>[field,fieldSources[field]??(field==='album'&&candidate.releaseId?`https://musicbrainz.org/release/${candidate.releaseId}`:candidate.sourceUrl)])),candidate.fetchedAt);
      this.catalog.sync(itemId);
      this.refreshEffectiveSearch(itemId);
      const changeId=randomUUID();
      this.db.prepare(`INSERT INTO metadata_change(id,item_id,base_revision,after_revision,provider,recording_id,release_id,before_json,after_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(changeId,itemId,revision,afterRevision,candidate.provider,candidate.recordingId,candidate.releaseId,
          JSON.stringify({...previous,provenance:sourceBefore,effective:{title:item.title,artist:item.artist,album:item.album}}),JSON.stringify({...values,provenance:provenanceSnapshot(this.db,'playable_item',itemId),updated,effective:(()=>{const current=this.getItem(itemId)!;return {title:current.title,artist:current.artist,album:current.album};})(),items:[{itemId,revision:this.getItem(itemId)?.catalog?.revision??0}]}),new Date().toISOString());
      return {changeId,revision:afterRevision,updated};
  }

  undoMetadata(changeId:string):MetadataChangeResult {return this.transaction(()=>this.metadataUndo.eligibleInTransaction(changeId));}

  private upsertStream(fileId:string,codec:string,sampleRate:number|null,bitsPerSample:number|null):void {
    this.db.prepare(`INSERT INTO media_stream(id,file_id,stream_index,codec,sample_rate,bits_per_sample)
      VALUES(?,?,0,?,?,?) ON CONFLICT(file_id,stream_index) DO UPDATE SET
      codec=excluded.codec,sample_rate=excluded.sample_rate,bits_per_sample=excluded.bits_per_sample`)
      .run(`stream:${fileId}:0`,fileId,codec,sampleRate,bitsPerSample);
  }

  private upsertSpan(itemId:string,fileId:string,startTick:number,endTick:number|null,timeBaseDen:number):void {
    this.db.prepare(`INSERT INTO playable_span(item_id,ordinal,stream_id,start_tick,end_tick,time_base_num,time_base_den)
      VALUES(?,0,?,?,?,1,?) ON CONFLICT(item_id,ordinal) DO UPDATE SET
      stream_id=excluded.stream_id,start_tick=excluded.start_tick,end_tick=excluded.end_tick,
      time_base_num=excluded.time_base_num,time_base_den=excluded.time_base_den`)
      .run(itemId,`stream:${fileId}:0`,startTick,endTick,timeBaseDen);
  }

  upsertFile(rootId: string, input: ParsedFile, generation: number, observation?:string): string {return this.upsertParsedFile(rootId,input,generation,observation);}
  commitTagReprobe(id:string,proof:TagCommitReprobeProof,journal:TagCommitJournalSnapshot):void {
    this.tagWriteJobs.finishReprobe(id,proof,journal,()=>{
      const {row,descriptor:d}=this.tagWriteJobs.reprobeBinding(id),rootBinding=this.tagWriteRootBinding(d.worker.plan.itemId),root=this.getRoot(rootBinding.id);
      if(!root||root.path!==d.worker.binding.rootPath||!['online','scanning'].includes(root.status)||proof.parsed.relativePath!==d.worker.binding.relativePath)throw new Error('曲库提交目录或来源路径已变化');
      const result=this.upsertParsedFile(root.id,proof.parsed,root.scan_generation,proof.observation,{kind:'commit',id});if(result!==row.file_id)throw new Error('曲库提交文件身份不符');return result;
    });
  }
  commitTagRestoreReprobe(id:string,proof:TagRestoreReprobeProof,journal:TagRestoreJournalSnapshot):void {
    this.tagWriteJobs.finishRestoreReprobe(id,proof,journal,()=>{
      const {row,descriptor:d}=this.tagWriteJobs.restoreReprobeBinding(id),rootBinding=this.tagWriteRootBinding(d.worker.plan.itemId),root=this.getRoot(rootBinding.id);
      if(!root||root.path!==d.worker.binding.rootPath||!['online','scanning'].includes(root.status)||proof.parsed.relativePath!==d.worker.binding.relativePath)throw new Error('恢复来源曲库目录或路径已变化');
      const result=this.upsertParsedFile(root.id,proof.parsed,root.scan_generation,proof.observation,{kind:'restore',id});if(result!==row.file_id)throw new Error('恢复来源曲库文件身份不符');return result;
    });
  }
  private upsertParsedFile(rootId:string,input:ParsedFile,generation:number,observation?:string,reprobe?:{kind:'commit'|'restore';id:string}):string {
    if(observation!==undefined&&!validFileObservation(observation))throw new Error('音乐文件观察无效');
    return this.transaction(() => {
      const existing = this.fileSnapshot(rootId, input.relativePath);
      const id = existing?.id ?? randomUUID();
      let reprobeItemId:string|undefined;if(reprobe){const {row,descriptor}=reprobe.kind==='commit'?this.tagWriteJobs.reprobeBinding(reprobe.id):this.tagWriteJobs.restoreReprobeBinding(reprobe.id);if(!existing||id!==row.file_id)throw new Error('重新解析只能更新冻结的现有文件');reprobeItemId=descriptor.worker.plan.itemId;}else if(existing)this.tagWriteJobs.assertReadable(id);
      this.db.prepare(`INSERT INTO media_file(id,root_id,relative_path,path_key,size,mtime_ms,duration_seconds,codec,sample_rate,bits_per_sample,parse_error,status,seen_generation)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'online',?)
        ON CONFLICT(root_id,path_key) DO UPDATE SET relative_path=excluded.relative_path,size=excluded.size,mtime_ms=excluded.mtime_ms,
        duration_seconds=excluded.duration_seconds,codec=excluded.codec,sample_rate=excluded.sample_rate,bits_per_sample=excluded.bits_per_sample,
        parse_error=excluded.parse_error,status='online',seen_generation=excluded.seen_generation`)
        .run(id, rootId, input.relativePath, normalize(input.relativePath), input.size, Math.trunc(input.mtimeMs), input.durationSeconds,
          input.codec, input.sampleRate, input.bitsPerSample, input.parseError ?? null, generation);
      this.filePolicy.parsed(id);
      this.db.prepare('UPDATE media_file SET replay_gain_json=? WHERE id=?').run(input.replayGain?JSON.stringify(validateReplayGain(input.replayGain)):null,id);
      if(observation)this.db.prepare('INSERT INTO media_file_observation(file_id,algorithm,stamp) VALUES(?,?,?) ON CONFLICT(file_id) DO UPDATE SET algorithm=excluded.algorithm,stamp=excluded.stamp').run(id,FILE_OBSERVATION_ALGORITHM,observation);
      else this.db.prepare('DELETE FROM media_file_observation WHERE file_id=?').run(id);
      if(!reprobe)this.tagWriteJobs.observe(id,JSON.stringify([input.size,Math.trunc(input.mtimeMs),observation??null]));
      this.upsertStream(id,input.codec,input.sampleRate,input.bitsPerSample);
      const oldItem = this.db.prepare("SELECT id FROM playable_item WHERE file_id=? AND kind='file'").get(id) as { id: string } | undefined;
      const itemId = oldItem?.id ?? randomUUID();
      if(reprobe&&(!oldItem||itemId!==reprobeItemId))throw new Error('重新解析只能更新冻结的现有曲目身份');
      this.db.prepare(`INSERT INTO playable_item(id,file_id,kind,cue_key,title,artist,album,genre,title_norm,artist_norm,album_norm,genre_norm,track_number,disc_number,visible,added_at)
        VALUES(?,?,'file',NULL,?,?,?,?,?,?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,artist=excluded.artist,album=excluded.album,genre=excluded.genre,
        title_norm=excluded.title_norm,artist_norm=excluded.artist_norm,album_norm=excluded.album_norm,genre_norm=excluded.genre_norm,
        track_number=excluded.track_number,disc_number=excluded.disc_number`)
        .run(itemId,id,input.title,input.artist,input.album,input.genre,normalize(input.title),normalize(input.artist),normalize(input.album),normalize(input.genre),input.trackNumber,input.discNumber,new Date().toISOString());
      this.upsertSpan(itemId,id,0,null,1);
      this.catalog.sync(itemId,input.catalog??{});
      // Only a genuinely new playable row can bypass deletion of old FTS rows.
      this.refreshEffectiveSearch(itemId,!oldItem);
      if(!reprobe&&input.embeddedCue!==undefined)this.applyEmbeddedCue(rootId,input,id,generation);
      return id;
    });
  }

  private applyEmbeddedCue(rootId:string,input:ParsedFile,fileId:string,generation:number):void {
    const source=input.embeddedCue===null?null:readFlacCueSource(input.embeddedCue,input.size);
    if(source&&(source.sampleRate!==input.sampleRate||Math.abs(source.totalSamples/source.sampleRate-(input.durationSeconds??-1))>0.000001))throw new Error('内嵌 CUESHEET 与解析音频参数不符');
    const text=input.embeddedCueText===undefined||input.embeddedCueText===null?null:readFlacCueTextSource(input.embeddedCueText,input.size);
    if(text&&(text.sampleRate!==input.sampleRate||Math.abs(text.totalSamples/text.sampleRate-(input.durationSeconds??-1))>0.000001))throw new Error('内嵌 CUE 文本与音频参数不符');
    const parsed=embeddedCueView(source,text,path.basename(input.relativePath),input.artist,input.album);
    const root=this.db.prepare('SELECT path FROM library_root WHERE id=?').get(rootId) as {path:string}|undefined;if(!root)throw new Error('内嵌 CUE 历史所属目录不存在');
    const embeddedVersion=this.embeddedCueSources.observe({fileId,rootId,rootPath:root.path,relativePath:input.relativePath,size:input.size,artist:input.artist,album:input.album,binary:source,text});
    let document=this.db.prepare('SELECT id,parser_version FROM cue_document WHERE root_id=? AND relative_path=?').get(rootId,input.relativePath) as {id:string;parser_version:string|null}|undefined;
    if(document&&!document.parser_version?.startsWith('aural-flac-cuesheet-'))throw new Error('内嵌编排身份与已有外部编排冲突');
    if(parsed.entries.length){
      this.applyCue(rootId,input.relativePath,parsed.album,parsed.performer,parsed.entries.map(entry=>({...entry,fileId})),parsed.notice?[parsed.notice]:[],generation,undefined,parsed.timeBaseDen);
      document=this.db.prepare('SELECT id,parser_version FROM cue_document WHERE root_id=? AND relative_path=?').get(rootId,input.relativePath) as {id:string;parser_version:string|null};
      const rows=this.db.prepare('SELECT p.id,t.hidden,t.source_ordinal,t.track_no FROM playable_item p JOIN cue_track t ON t.item_id=p.id WHERE t.cue_id=? AND p.visible=1').all(document.id) as Array<{id:string;hidden:number;source_ordinal:number;track_no:number}>;
      for(const row of rows){
        const entry=parsed.entries.find(track=>track.sourceOrdinal===row.source_ordinal&&Boolean(track.hidden)===Boolean(row.hidden)&&track.number===row.track_no);if(!entry)throw new Error('内嵌编排曲目归属不符');
        const textAccepted=parsed.textState==='matched'||parsed.textState==='text-only',albumArtist=textAccepted&&text?.document.performer?text.document.performer:null;
        this.db.prepare('UPDATE playable_item SET disc_number=? WHERE id=?').run(input.discNumber,row.id);
        this.catalog.sync(row.id,{...input.catalog,...(entry.performerOrigin==='cue'?{artists:[entry.performer]}:{}),...(albumArtist?{albumArtist,albumArtists:[albumArtist]}:{}),...(entry.songwriter?{composers:[entry.songwriter]}:{}),fieldOrigins:{title:entry.fields?.some(field=>field.command==='TITLE')?'cue':'missing',artist:entry.performerOrigin==='cue'?'cue':input.catalog?.fieldOrigins?.artist??'missing',album:textAccepted&&text?.document.title?'cue':input.catalog?.fieldOrigins?.album??'missing'}});this.refreshEffectiveSearch(row.id);
      }
    }else{
      const cueId=document?.id??randomUUID();
      this.db.prepare('INSERT INTO cue_document(id,root_id,relative_path,warnings,seen_generation) VALUES(?,?,?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET warnings=excluded.warnings,seen_generation=excluded.seen_generation').run(cueId,rootId,input.relativePath,JSON.stringify(parsed.notice?[parsed.notice]:[]),generation);
      this.db.prepare("UPDATE playable_item SET visible=0 WHERE kind='cue' AND substr(cue_key,1,36)=?").run(cueId);
    }
    // A FLAC path owns a separate document from any external .cue path. The
    // original block is retained as binary bytes, never passed through a text decoder.
    this.db.prepare("UPDATE cue_document SET source_hash=?,encoding=NULL,parser_version=?,fields_json=?,gap_policy='previous' WHERE root_id=? AND relative_path=?").run(source?.sourceHash??text?.sourceHash??null,FLAC_CUE_PARSER,JSON.stringify({fields:parsed.fields??[],embedded:source,embeddedText:text,embeddedVersion,textState:parsed.textState,playable:parsed.entries.length>0,notice:parsed.notice,timeBaseDen:parsed.timeBaseDen}),rootId,input.relativePath);
    // An already known external CUE remains the preferred representation. Its
    // own scan phase validates and updates it, or hides it if the document vanished.
    if(document&&this.db.prepare("SELECT 1 FROM cue_track t JOIN cue_document d ON d.id=t.cue_id JOIN playable_item p ON p.id=t.item_id WHERE t.media_file_id=? AND d.relative_path<>? AND p.visible=1 LIMIT 1").get(fileId,input.relativePath))this.db.prepare("UPDATE playable_item SET visible=0 WHERE kind='cue' AND substr(cue_key,1,36)=?").run(document.id);
  }

  needsEmbeddedCue(fileId:string):boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM media_file f WHERE f.id=? AND lower(f.relative_path) LIKE '%.flac' AND NOT EXISTS(SELECT 1 FROM cue_document d WHERE d.root_id=f.root_id AND d.relative_path=f.relative_path AND d.parser_version=?)").get(fileId,FLAC_CUE_PARSER));
  }

  applyCue(rootId: string, cueRelative: string, cueTitle: string, cueArtist: string, entries: Array<CueEntry & { fileId: string }>, warnings: string[], generation: number, source?:ParsedCueSource,timeBaseDen=75,application?:CueSourceApplication): number {
    if(!Number.isSafeInteger(timeBaseDen)||timeBaseDen<1||timeBaseDen>1536000||source&&timeBaseDen!==75)throw new Error('CUE 编排时间基准无效');
    if(!entries.length||entries.length>2000||Buffer.byteLength(JSON.stringify(entries),'utf8')>2*1024*1024)throw new Error('CUE 编排超过曲库预算');
    return this.transaction(() => {
      for(const fileId of new Set(entries.map(entry=>entry.fileId)))this.tagWriteJobs.assertReadable(fileId);
      if(source)for(const fileId of new Set(entries.map(entry=>entry.fileId)))this.db.prepare("UPDATE playable_item SET visible=0 WHERE kind='cue' AND file_id=? AND substr(cue_key,1,36) IN(SELECT id FROM cue_document WHERE parser_version LIKE 'aural-flac-cuesheet-%')").run(fileId);
      const old = this.db.prepare('SELECT id FROM cue_document WHERE root_id=? AND relative_path=?').get(rootId,cueRelative) as { id: string } | undefined;
      const cueId = old?.id ?? randomUUID();
      const oldItems = this.db.prepare("SELECT p.id,p.file_id,p.track_number,p.visible,COALESCE(t.hidden,CASE WHEN p.track_number=0 THEN 1 ELSE 0 END) hidden FROM playable_item p LEFT JOIN cue_track t ON t.item_id=p.id WHERE p.kind='cue' AND substr(p.cue_key,1,36)=? LIMIT 262145").all(cueId) as unknown as Array<{id:string;file_id:string;track_number:number;visible:number;hidden:number}>;
      if(oldItems.length>262144)throw new Error('此 CUE 的历史曲目超过身份核对预算，原编排保留');
      const identity=(file:string,number:number,hidden:boolean)=>JSON.stringify([file,number,hidden]),oldByIdentity=new Map<string,typeof oldItems>();
      for(const item of oldItems){const key=identity(item.file_id,item.track_number,Boolean(item.hidden)),members=oldByIdentity.get(key)??[];members.push(item);oldByIdentity.set(key,members);}
      const claimed=new Set<string>();
      this.db.prepare('DELETE FROM cue_track WHERE cue_id=?').run(cueId);
      this.db.prepare("UPDATE playable_item SET visible=0 WHERE kind='cue' AND substr(cue_key,1,36)=?").run(cueId);
      this.db.prepare(`INSERT INTO cue_document(id,root_id,relative_path,warnings,seen_generation) VALUES(?,?,?,?,?)
        ON CONFLICT(root_id,relative_path) DO UPDATE SET warnings=excluded.warnings,seen_generation=excluded.seen_generation`)
        .run(cueId,rootId,cueRelative,JSON.stringify(warnings),generation);
      if(source){const fields=JSON.stringify({songwriter:source.document.songwriter,catalog:source.document.catalog,cdTextFile:source.document.cdTextFile,fields:source.document.fields,...(application?{cueSelection:application}:{})});this.db.prepare('UPDATE cue_document SET source_hash=?,encoding=?,parser_version=?,fields_json=?,gap_policy=? WHERE id=?').run(source.sourceHash,source.encoding,source.parserVersion,fields,source.gapPolicy,cueId);}
      else this.db.prepare("UPDATE cue_document SET gap_policy='previous' WHERE id=?").run(cueId);
      let count = 0;
      for (const [ordinal, entry] of entries.entries()) {
        const sourceOrdinal=entry.sourceOrdinal??ordinal,hidden=Boolean(entry.hidden),startFrame=entry.startFrame??entry.index01Frame;
        if(!Number.isSafeInteger(sourceOrdinal)||sourceOrdinal<0||sourceOrdinal>=1000||!Number.isSafeInteger(entry.number)||entry.number<0||entry.number>999||hidden!==(entry.number===0)||!Number.isSafeInteger(startFrame)||startFrame<0||startFrame>entry.index01Frame||!Number.isSafeInteger(entry.index01Frame)||entry.index01Frame<0||entry.endFrame!==undefined&&(!Number.isSafeInteger(entry.endFrame)||entry.endFrame<=entry.index01Frame))throw new Error('CUE 音轨范围无效');
        const effectivePolicy=source?.gapPolicy??'previous';
        if(hidden&&entry.index01Frame!==0||startFrame!==(hidden?0:effectivePolicy==='current'?entry.index00Frame??entry.index01Frame:entry.index01Frame))throw new Error('CUE 起点与前间隙归属不符');
        const historical=(oldByIdentity.get(identity(entry.fileId,entry.number,hidden))??[]).filter(item=>!claimed.has(item.id)),visible=historical.filter(item=>item.visible===1),matches=visible.length?visible:historical;
        let itemId=matches.length===1?matches[0].id:`cue:${cueId}:${hidden?'hidden:':''}${sourceOrdinal}`;
        if(!matches.length||matches.length>1){if(this.db.prepare('SELECT id FROM playable_item WHERE id=?').get(itemId))itemId=`cue:${cueId}:${randomUUID()}`;}
        claimed.add(itemId);
        const album = cueTitle || '未知专辑';
        const artist = entry.performer || cueArtist || '未知艺术家';
        this.db.prepare(`INSERT INTO playable_item(id,file_id,kind,cue_key,title,artist,album,genre,title_norm,artist_norm,album_norm,genre_norm,track_number,start_seconds,end_seconds,start_cue_frame,end_cue_frame,added_at)
          VALUES(?,?,'cue',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET file_id=excluded.file_id,title=excluded.title,artist=excluded.artist,album=excluded.album,
          genre=excluded.genre,title_norm=excluded.title_norm,artist_norm=excluded.artist_norm,album_norm=excluded.album_norm,
          genre_norm=excluded.genre_norm,track_number=excluded.track_number,start_seconds=excluded.start_seconds,end_seconds=excluded.end_seconds,
          start_cue_frame=excluded.start_cue_frame,end_cue_frame=excluded.end_cue_frame,visible=1`)
          .run(itemId,entry.fileId,`${cueId}:${itemId.slice(cueId.length+5)}`,entry.title,artist,album,'',normalize(entry.title),normalize(artist),normalize(album),'',entry.number,
            startFrame/timeBaseDen,entry.endFrame===undefined?null:entry.endFrame/timeBaseDen,timeBaseDen===75?startFrame:null,timeBaseDen===75?entry.endFrame??null:null,new Date().toISOString());
        this.upsertSpan(itemId,entry.fileId,startFrame,entry.endFrame??null,timeBaseDen);
        const fields=JSON.stringify({flags:entry.flags??[],fields:entry.fields??[],songwriter:entry.songwriter,isrc:entry.isrc,fileType:entry.fileType});
        if(Buffer.byteLength(fields,'utf8')>65536)throw new Error('CUE 音轨字段超过预算');
        this.db.prepare('INSERT INTO cue_track(item_id,cue_id,media_file_id,source_ordinal,track_no,file_ref,index00,index01,pregap,postgap,hidden,indices_json,fields_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(itemId,cueId,entry.fileId,sourceOrdinal,entry.number,entry.file,entry.index00Frame??null,entry.index01Frame,entry.pregapFrame??null,entry.postgapFrame??null,hidden?1:0,JSON.stringify(entry.indices??[{number:1,frame:entry.index01Frame}]),fields);
        this.catalog.sync(itemId,{artists:[artist],albumArtist:cueArtist||undefined,albumArtists:cueArtist?[cueArtist]:[],composers:entry.songwriter?[entry.songwriter]:[],isrcs:entry.isrc?[entry.isrc]:undefined,fieldOrigins:{title:'cue',artist:entry.performerOrigin??(entry.performer||cueArtist?'cue':'missing'),album:cueTitle?'cue':'missing'}});
        this.refreshEffectiveSearch(itemId);
        this.db.prepare("UPDATE playable_item SET visible=0 WHERE file_id=? AND kind='file'").run(entry.fileId);
        count++;
      }
      return count;
    });
  }

  stats(): LibraryStats {
    return libraryStats(this.db,this.catalog);
  }

  facets(view: 'artists' | 'albums' | 'albumGroups' | 'genres',role?:ArtistRole):CatalogFacet[] {return this.catalog.facets(view,role);}

  catalogChanges(limit=50,offset=0):{items:CatalogChangeSummary[];total:number}{
    if(!Number.isInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw new Error('无效修订查询');
    const from=`FROM (SELECT id,action,created_at,undone_at,after_json,COALESCE(json_extract(before_json,'$.items[0].facts.title'),'曲库关联') title FROM catalog_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM artist_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM release_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM artist_profile_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM release_profile_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM entity_reference_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM recording_profile_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM metadata_policy_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM metadata_selection_change UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM metadata_collection_change
      UNION ALL SELECT id,action,created_at,undone_at,after_json,title FROM genre_change
      UNION ALL SELECT id,'metadata-online',CAST(strftime('%s',created_at) AS INTEGER)*1000+CAST(substr(created_at,21,3) AS INTEGER),undone_at,json_set(after_json,'$.items',json_array(json_object('itemId',item_id))),COALESCE(json_extract(after_json,'$.effective.title'),(SELECT title FROM playable_item WHERE id=metadata_change.item_id),'在线元数据') FROM metadata_change
      UNION ALL SELECT id,'undo',created_at,NULL,after_json,title FROM metadata_compensation) history_changes`;
    const total=(this.db.prepare(`SELECT COUNT(*) n ${from}`).get() as {n:number}).n;
    const rows=this.db.prepare(`SELECT id,action,title,created_at createdAt,undone_at IS NOT NULL undone,undone_at IS NULL AND EXISTS(SELECT 1 FROM metadata_compensation c WHERE c.change_id=history_changes.id) partial,json_array_length(after_json,'$.items') itemCount
      ${from} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(limit,offset) as unknown as Array<Omit<CatalogChangeSummary,'undone'>&{undone:number}>;
    return {total,items:rows.map(row=>({...row,undone:Number(row.undone)===1,partial:Number(row.partial)===1}))};
  }
  undoCatalog(changeId:string,commandId:string):CatalogChangeResult{if(this.metadataUndo.owns(changeId)){const result=this.metadataUndo.eligible(commandId,changeId);const snapshot=this.db.prepare('SELECT after_json FROM metadata_compensation WHERE id=?').get(result.undoId!) as {after_json:string};return {changeId:result.undoId!,items:JSON.parse(snapshot.after_json).items};}return this.metadataGroupLinks.owns(changeId)?this.metadataGroupLinks.undo(changeId,commandId):this.genres.owns(changeId)?this.genres.undo(changeId,commandId):this.metadataCollections.owns(changeId)?this.metadataCollections.undo(changeId,commandId):this.metadataProvenance.owns(changeId)?this.metadataProvenance.undo(changeId,commandId):this.recordingProfiles.owns(changeId)?this.recordingProfiles.undo(changeId,commandId):this.references.owns(changeId)?this.references.undo(changeId,commandId):this.releaseFields.owns(changeId)?this.releaseFields.undoEligible(changeId,commandId):this.releaseProfiles.owns(changeId)?this.releaseProfiles.undo(changeId,commandId):this.profiles.owns(changeId)?this.profiles.undo(changeId,commandId):this.releases.owns(changeId)?this.releases.undo(changeId,commandId):this.artists.owns(changeId)?this.artists.undo(changeId,commandId):this.associations.undo(changeId,commandId);}

  artistProfile(artistId:string,limit=50,offset=0):import('../shared/contracts.js').ArtistProfileDetail{
    const detail=this.profiles.detail(artistId,limit,offset);return {artist:detail.artist,items:this.getItems(detail.ids),total:detail.total,aliases:detail.aliases};
  }

  releaseDetail(releaseId:string,limit=50,offset=0):import('../shared/contracts.js').ReleaseDetail{
    const detail=this.releases.detail(releaseId,limit,offset),counts=new Map(detail.rows.map(row=>[row.id,row.versionCount]));
    return {release:detail.release,total:detail.total,items:this.getItems(detail.rows.map(row=>row.id)).map(item=>({...item,versionCount:counts.get(item.id)}))};
  }

  private musicFilterItems(filters:MusicFilters,asOfMs=musicFilterTimeAnchor()):{sql:string;params:Array<string|number>}{
    const plan=musicFilterPlan(filters,this.catalog.recordingCreditCondition(),asOfMs),dependencies=musicFilterDependencies(filters);
    return {sql:`SELECT p.id FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id LEFT JOIN item_user_state u ON u.item_id=p.id LEFT JOIN release_track ct ON ct.id=p.release_track_id LEFT JOIN medium cm ON cm.id=ct.medium_id LEFT JOIN release cr ON cr.id=cm.release_id ${dependencies.counts||dependencies.recency?'LEFT JOIN playback_item_stats ps ON ps.item_id=p.id':''} WHERE ${plan.where.length?plan.where.join(' AND '):'1=1'}`,params:plan.params};
  }
  list(input: ListRequest,asOfMs=musicFilterTimeAnchor()): ListResponse {
    const smart=input.view==='playlists'&&input.value?this.smartPlaylists.maybe(input.value):null;
    const saved=smart?libraryQueryPlan(this.db,this.catalog,smart.definition.query,undefined,asOfMs,'ids'):null;
    const membership=saved?{sql:`${saved.cte}SELECT p.id ${saved.from}`,params:saved.queryParams}:undefined;
    const scope=smart?.definition.query;
    const sort=scope?.sort?.mode==='default'||!scope?.sort?scope?.view==='recent'?{mode:'added' as const,direction:'desc' as const}:scope?.sort:scope.sort;
    const request:ListRequest=smart?{...input,view:'all',value:undefined,facetId:undefined,artistRole:undefined,sort,collapseVersions:false,query:input.query?.trim()?input.query:scope?.query}:input;
    if(request.view==='playlists'&&!request.value)return {items:[],total:0};
    const limit = Math.max(1,Math.min(100,Math.trunc(request.limit ?? 50)));
    const offset = Math.max(0,Math.trunc(request.offset ?? 0));
    const {params,order,q,cte,directParams,spelling,rank,distance,collapse,from,countFrom,prefixPage,queryParams}=libraryQueryPlan(this.db,this.catalog,request,membership,asOfMs,request.view==='playlists'?'items':'ids');
    const plainCount=(request.view==='all'||request.view==='recent')&&!q&&!membership&&!collapse&&!request.releaseTrackId&&request.genreFilter===undefined&&request.filters===undefined;
    let total = prefixPage?0:(sqlStatement(this.db,plainCount?"SELECT COUNT(*) count FROM playable_item p WHERE p.visible=1 AND p.library_state='active'":`${cte}SELECT COUNT(*) count ${countFrom}`).get(...(plainCount?[]:queryParams)) as { count: number }).count;
    const pageParams=[...directParams,...(rank?[q]:[]),...(distance?spelling.flatMap(hit=>[hit.id,hit.distance]):[]),...(collapse?[...params,...params]:params),limit,offset];
    if(request.view!=='playlists'){
      // Sort and paginate IDs before loading media/provenance details. A deep
      // page must not hydrate every discarded row or count every row's versions.
      const pageRows=sqlStatement(this.db,prefixPage??`${cte}SELECT p.id${rank?`,${rank} search_rank`:''}${distance?`,${distance} search_distance`:''} ${from} ORDER BY ${rank?`search_rank,${distance?'search_distance,':''}`:''}${order} LIMIT ? OFFSET ?`).all(...(prefixPage?[...pageParams.slice(0,-2),limit,offset,limit,offset]:pageParams)) as Array<{id:string|null;total?:number;search_rank?:number;search_distance?:number}>;
      if(prefixPage){const pageTotal=pageRows[0]?.total;if(pageTotal===undefined||!Number.isSafeInteger(pageTotal)||pageTotal<0)throw new Error('分页查询缺少有效总数');total=pageTotal;}
      const page=pageRows.filter((row):row is typeof row&{id:string}=>typeof row.id==='string');
      const items=this.getItems(page.map(row=>row.id));
      if(page.length){const counts=sqlStatement(this.db,`SELECT p.id,(SELECT COUNT(*) FROM playable_item pv INDEXED BY idx_item_release_track WHERE pv.release_track_id=p.release_track_id AND pv.visible=1 AND pv.library_state='active') count FROM playable_item p WHERE p.id IN(${page.map(()=>'?').join(',')})`).all(...page.map(row=>row.id)) as Array<{id:string;count:number}>;const byId=new Map(counts.map(row=>[row.id,Number(row.count)]));for(const item of items)item.versionCount=byId.get(item.id)??item.versionCount;}
      if(q){const matches=new Map(spelling.map(hit=>[hit.id,hit.distance])),byId=new Map(page.map(row=>[row.id,row]));for(const item of items){const score=Number(byId.get(item.id)?.search_rank);item.searchMatch=score===10?{kind:matches.get(item.id)===0?'normalized':'spelling',distance:matches.get(item.id)??0}:!Number.isInteger(score)?{kind:'normalized',distance:0}:{kind:(['title-exact','artist-exact','prefix','substring','alias-or-pinyin','alias-or-pinyin'] as const)[score]??'alias-or-pinyin'};}}
      return {total,items};
    }
    const rows = this.db.prepare(`${cte}SELECT ${rank?`${rank} search_rank,`:''}${distance?`${distance} search_distance,`:''}p.id,p.file_id,p.kind,p.library_state,COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,
      COALESCE(o.album,p.album) album,p.genre,p.track_number,p.disc_number,
      p.added_at,p.visible,COALESCE(u.favorite,0) favorite,COALESCE(u.rating,0) rating,COALESCE(u.revision,0) user_revision,
      ${request.view==='playlists'?'pj.entry_id':'NULL'} playlist_entry_id,
      ${request.view==='playlists'?'pj.position':'NULL'} playlist_position,
      (SELECT COUNT(*) FROM playable_item pv INDEXED BY idx_item_release_track WHERE pv.release_track_id=p.release_track_id AND pv.visible=1 AND pv.library_state='active') version_count,
      p.start_seconds,p.end_seconds,p.start_cue_frame,p.end_cue_frame,f.replay_gain_json,(SELECT stamp FROM media_file_observation fo WHERE fo.file_id=f.id AND fo.algorithm='node-bigint-stat-v1') file_observation,f.size file_size,f.mtime_ms file_mtime_ms,f.relative_path,f.duration_seconds,f.codec,f.sample_rate,f.bits_per_sample,f.status,r.path root_path,r.status root_status
      ${from} ORDER BY ${rank&&request.view!=='playlists'?`search_rank,${distance?'search_distance,':''}`:''}${order} LIMIT ? OFFSET ?`)
      .all(...pageParams) as unknown as Array<Record<string, unknown>>;
    const matches=new Map(spelling.map(hit=>[hit.id,hit.distance]));
    const items=this.toItems(rows);if(q)items.forEach((item,i)=>{const score=Number(rows[i].search_rank);item.searchMatch=score===10?{kind:matches.get(item.id)===0?'normalized':'spelling',distance:matches.get(item.id)??0}:!Number.isInteger(score)?{kind:'normalized',distance:0}:{kind:(['title-exact','artist-exact','prefix','substring','alias-or-pinyin','alias-or-pinyin'] as const)[score]??'alias-or-pinyin'};});
    return { total, items };
  }

  getItem(itemId: string): LibraryItem | undefined {
    const row = this.db.prepare(`SELECT p.id,p.file_id,p.kind,p.library_state,COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,
      COALESCE(o.album,p.album) album,p.genre,p.track_number,p.disc_number,
      p.added_at,p.visible,COALESCE(u.favorite,0) favorite,COALESCE(u.rating,0) rating,COALESCE(u.revision,0) user_revision,
      p.start_seconds,p.end_seconds,p.start_cue_frame,p.end_cue_frame,f.replay_gain_json,(SELECT stamp FROM media_file_observation fo WHERE fo.file_id=f.id AND fo.algorithm='node-bigint-stat-v1') file_observation,f.size file_size,f.mtime_ms file_mtime_ms,f.relative_path,f.duration_seconds,f.codec,f.sample_rate,f.bits_per_sample,f.status,r.path root_path,r.status root_status
      FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id
      LEFT JOIN metadata_override o ON o.item_id=p.id LEFT JOIN item_user_state u ON u.item_id=p.id WHERE p.id=?`).get(itemId) as Record<string, unknown> | undefined;
    return row ? this.toItems([row])[0] : undefined;
  }
  waveformSource(itemId:string):{item:LibraryItem;rootPath:string}{return this.mediaSource(itemId);}
  itemFileId(itemId:string):string|undefined{return (this.db.prepare('SELECT file_id FROM playable_item WHERE id=?').get(itemId) as {file_id:string}|undefined)?.file_id;}
  mediaSource(itemId:string,ownerJobId?:string):{item:LibraryItem;rootPath:string}{
    const item=this.getItem(itemId),root=this.db.prepare('SELECT r.id,r.path FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id WHERE p.id=?').get(itemId) as {id:string;path:string}|undefined;
    if(!item||!root)throw new Error('曲目不存在');this.restorePolicy.assertRoot(root);if(ownerJobId){this.restorePolicy.assertTagJob(ownerJobId);this.tagWriteJobs.assertOwner(item.fileId,ownerJobId);}else this.tagWriteJobs.assertReadable(item.fileId);return {item,rootPath:root.path};
  }

  tagWriteContext(itemId:unknown,ownerJobId?:string,reviewLeaseRevision?:number,basisVersion:1|2=2):TagWriteContext {
    if(!tagWriteUuid(itemId))throw new Error('标签编辑曲目身份无效');
    const item=this.getItem(itemId);if(!item)throw new Error('曲目不存在');
    const cue=Boolean(this.db.prepare("SELECT 1 FROM playable_item WHERE file_id=? AND kind='cue' LIMIT 1").get(item.fileId));
    const lease=this.tagWriteJobs.fileState(item.fileId);
    if(ownerJobId)this.tagWriteJobs.assertOwner(item.fileId,ownerJobId);
    if(reviewLeaseRevision!==undefined&&(!ownerJobId||!Number.isSafeInteger(reviewLeaseRevision)||reviewLeaseRevision<0||reviewLeaseRevision>=lease!.lease_revision))throw new Error('冻结审核租约基准无效');
    const rootBinding=this.tagWriteRootBinding(item.id),restoredPolicy=this.restorePolicy.load();if(ownerJobId)this.restorePolicy.assertTagJob(ownerJobId);
    const reason=!this.restorePolicy.rootAuthorized(rootBinding)?'恢复的目录尚未重新选择并确认':!item.available?'歌曲文件当前不可用':item.libraryState!=='active'?'请先恢复此曲目到音乐库':item.kind!=='file'||cue?'CUE 虚拟轨或共享镜像暂不适用单曲写回':path.extname(item.path).toLowerCase()!=='.flac'?'当前写回预览支持独立 FLAC 文件':!item.fileObservation?'请重新扫描以建立文件观察':!ownerJobId&&lease&&lease.lease_state!=='none'?'文件正在写入或等待恢复':'';
    if(basisVersion!==1&&basisVersion!==2)throw new Error('标签审核依据版本不受支持');
    const fields=basisVersion===1?legacyTagLibraryFields(this.db,item,restoredPolicy?.observationRowid,restoredPolicy?.activationId):tagLibraryFields(this.db,item,restoredPolicy?.observationRowid,restoredPolicy?.activationId,restoredPolicy?(restoredPolicy.version===2?restoredPolicy.collectionObservationRowid:Number.MAX_SAFE_INTEGER):undefined);
    const contentRevision=this.tagWriteJobs.contentRevision(item.fileId);
    const fingerprint=createHash('sha256').update(JSON.stringify([this.metadataReviewFingerprint(itemId),item.libraryState,item.genre,item.trackNumber,item.discNumber,contentRevision,cue,reviewLeaseRevision??(ownerJobId?(lease!.lease_revision-1):(lease?.lease_revision??0)),ownerJobId?'none':(lease?.lease_state??'none'),this.tagWriteRootBinding(itemId),fields])).digest('hex');
    return {itemId:item.id,fileId:item.fileId,title:item.title,fingerprint,contentRevision,eligible:!reason,reason,fields,executionReady:TAG_WRITE_CERTIFICATES.length>0};
  }
  tagWriteRootBinding(itemId:string):{id:string;path:string;anchor:import('../shared/library-watch.js').WatchAnchor|null} {
    const root=this.db.prepare('SELECT r.id,r.path FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id WHERE p.id=?').get(itemId) as {id:string;path:string}|undefined;
    if(!root)throw new Error('曲目音乐目录不存在');return {...root,anchor:this.libraryWatch.load(root).anchor};
  }

  versions(itemId:string,limit=50,offset=0):ListResponse{
    const item=this.getItem(itemId);if(!item?.catalog)throw new Error('曲目不存在');
    return this.list({view:'all',releaseTrackId:item.catalog.releaseTrackId,limit,offset});
  }

  getItems(itemIds: string[]): LibraryItem[] {
    if(!Array.isArray(itemIds)||itemIds.length>500||itemIds.some(id=>typeof id!=='string'||id.length>128))throw new Error('无效曲目列表');
    if(!itemIds.length)return [];
    const placeholders=itemIds.map(()=>'?').join(',');
    const rows=this.db.prepare(`SELECT p.id,p.file_id,p.kind,p.library_state,COALESCE(o.title,p.title) title,COALESCE(o.artist,p.artist) artist,
      COALESCE(o.album,p.album) album,p.genre,p.track_number,p.disc_number,p.start_seconds,p.end_seconds,p.start_cue_frame,p.end_cue_frame,
      p.added_at,p.visible,COALESCE(u.favorite,0) favorite,COALESCE(u.rating,0) rating,COALESCE(u.revision,0) user_revision,
      f.replay_gain_json,(SELECT stamp FROM media_file_observation fo WHERE fo.file_id=f.id AND fo.algorithm='node-bigint-stat-v1') file_observation,f.size file_size,f.mtime_ms file_mtime_ms,f.relative_path,f.duration_seconds,f.codec,f.sample_rate,f.bits_per_sample,f.status,r.path root_path,r.status root_status
      FROM playable_item p JOIN media_file f ON f.id=p.file_id JOIN library_root r ON r.id=f.root_id
      LEFT JOIN metadata_override o ON o.item_id=p.id LEFT JOIN item_user_state u ON u.item_id=p.id WHERE p.id IN (${placeholders})`).all(...itemIds) as unknown as Array<Record<string,unknown>>;
    const found=new Map(this.toItems(rows).map(item=>[item.id,item]));
    return itemIds.flatMap(id=>{const item=found.get(id);return item?[item]:[];});
  }

  private toItem(row: Record<string, unknown>): LibraryItem {
    if(row.file_observation!==null&&row.file_observation!==undefined&&!validFileObservation(row.file_observation))throw new Error('曲目的扫描属性观察无效，请保留数据库并检查');
    const startCueFrame=row.kind==='cue'&&row.start_cue_frame!==null?Number(row.start_cue_frame):null;
    const endCueFrame=row.kind==='cue'&&row.end_cue_frame!==null?Number(row.end_cue_frame):null;
    const start = startCueFrame===null?Number(row.start_seconds ?? 0):startCueFrame/75;
    const end = endCueFrame!==null?endCueFrame/75:
      row.end_seconds === null ? (row.duration_seconds === null ? NaN : Number(row.duration_seconds)) : Number(row.end_seconds);
    return {
      id:String(row.id), fileId:String(row.file_id), libraryState:row.library_state as import('../shared/file-policy.js').FileLibraryState, fileStamp:`${row.file_size}:${row.file_mtime_ms}`, ...(row.file_observation?{fileObservation:String(row.file_observation)}:{}), kind:row.kind as 'file'|'cue',
      path:path.join(String(row.root_path),String(row.relative_path)),
      title:String(row.title), artist:String(row.artist), album:String(row.album), genre:String(row.genre),
      durationSeconds:Number.isFinite(end) ? Math.max(0,end-start) : null,
      codec:String(row.codec), sampleRate:row.sample_rate === null ? null : Number(row.sample_rate),
      bitsPerSample:row.bits_per_sample === null ? null : Number(row.bits_per_sample),
      trackNumber:row.track_number === null ? null : Number(row.track_number),
      discNumber:row.disc_number === null ? null : Number(row.disc_number),
      sourceStartSeconds:start,sourceEndSeconds:endCueFrame!==null?endCueFrame/75:
        row.end_seconds === null ? null : Number(row.end_seconds),
      sourceStartCueFrame:startCueFrame,sourceEndCueFrame:endCueFrame,
      available:row.status === 'online'&&row.root_status!=='offline'&&Number(row.visible)!==0&&row.library_state==='active',
      addedAt:typeof row.added_at==='string'?row.added_at:null,favorite:Number(row.favorite)===1,
      rating:Number(row.rating??0),userRevision:Number(row.user_revision??0),
      versionCount:Number(row.version_count??1),
      replayGain:typeof row.replay_gain_json==='string'?validateReplayGain(JSON.parse(row.replay_gain_json)):null,
      ...(typeof row.playlist_entry_id==='string'?{playlistEntryId:row.playlist_entry_id,playlistPosition:Number(row.playlist_position)}:{})
    };
  }

  needsCatalog(fileId:string):boolean {
    return Boolean(this.db.prepare(`SELECT p.id FROM playable_item p LEFT JOIN item_catalog_source s ON s.item_id=p.id
      WHERE p.file_id=? AND p.kind='file' AND (s.item_id IS NULL OR (SELECT replay_gain_json FROM media_file WHERE id=p.file_id) IS NULL${this.catalog.metadataProvenanceEnabled?" OR json_type(s.json,'$.fieldOrigins') IS NULL OR (SELECT COUNT(*) FROM metadata_auto_source a WHERE a.entity_kind='playable_item' AND a.entity_id=p.id)<3 OR (SELECT COUNT(*) FROM metadata_collection_state c WHERE c.entity_kind='playable_item' AND c.entity_id=p.id AND c.automatic_id IS NOT NULL)<2":''})`).get(fileId));
  }

  private toItems(rows:Array<Record<string,unknown>>):LibraryItem[]{
    const projection=this.catalog.project(rows.map(row=>String(row.id)));
    const cueRows=rows.length?this.db.prepare(`SELECT t.*,s.start_tick span_start_tick,s.end_tick span_end_tick,s.time_base_den span_time_base_den,EXISTS(SELECT 1 FROM cue_source_file cs WHERE cs.root_id=d.root_id AND cs.path_key=aural_cue_path_key_v1(d.relative_path) AND cs.scan_command IS NOT NULL) interpretation_pending,json_remove(d.fields_json,'$.embedded.rawBase64','$.embedded.streamInfoBase64','$.embedded.tracks','$.embeddedText.rawBase64','$.embeddedText.streamInfoBase64','$.embeddedText.document') document_fields_json,d.relative_path,d.source_hash,d.encoding,d.parser_version,d.gap_policy FROM cue_track t JOIN cue_document d ON d.id=t.cue_id LEFT JOIN playable_span s ON s.item_id=t.item_id AND s.ordinal=0 WHERE t.item_id IN(${rows.map(()=>'?').join(',')})`).all(...rows.map(row=>String(row.id))) as Array<Record<string,unknown>>:[];
    const cues=new Map<string,NonNullable<LibraryItem['cue']>>(cueRows.map(row=>{const fields=JSON.parse(String(row.fields_json)),document=JSON.parse(String(row.document_fields_json))??{fields:[]};return [String(row.item_id),{documentId:String(row.cue_id),documentPath:String(row.relative_path),ordinal:Number(row.source_ordinal),hidden:Boolean(row.hidden),timeBaseDen:Number(row.span_time_base_den??75),...(document.textState&&document.textState!=='none'?{embeddedTextState:document.textState,embeddedTextNotice:String(document.notice??''),embeddedTextSourceHash:document.embeddedText?.sourceHash??null}:{}),index00Frame:row.index00===null?null:Number(row.index00),index01Frame:Number(row.index01),pregapFrame:row.pregap===null?null:Number(row.pregap),postgapFrame:row.postgap===null?null:Number(row.postgap),indices:JSON.parse(String(row.indices_json)),flags:fields.flags??[],sourceHash:row.source_hash===null?null:String(row.source_hash),encoding:row.encoding===null?null:String(row.encoding),parserVersion:row.parser_version===null?null:String(row.parser_version),interpretationPending:Boolean(row.interpretation_pending),gapPolicy:row.gap_policy==='current'?'current':'previous'}];}));
    return rows.map(row=>{const catalog=projection.get(String(row.id)),cue=cues.get(String(row.id));const item=this.toItem(row),cueRow=cueRows.find(value=>String(value.item_id)===item.id);const replayGain=cueRow?cueReplayGain(JSON.parse(String(cueRow.document_fields_json))?.fields,JSON.parse(String(cueRow.fields_json)).fields,item.replayGain??null):item.replayGain;const sourceSampleRange=cue?.parserVersion?.startsWith('aural-flac-cuesheet-')&&cue.timeBaseDen!==75?{sampleRate:cue.timeBaseDen!,start:Number(cueRow!.span_start_tick),end:Number(cueRow!.span_end_tick)}:undefined;return {...item,...(sourceSampleRange?{sourceSampleRange}:{}),available:item.available&&!Boolean(cueRow?.interpretation_pending),replayGain,...(cue?{cue}:{}),...(catalog&&(catalog.creditConfirmed||catalog.artistDisplay)?{artist:catalog.artistDisplay??''}:{}),...(catalog?{genre:[...new Set(catalog.genres.map(value=>value.name))].join('、')}:{}),catalog};});
  }
}
