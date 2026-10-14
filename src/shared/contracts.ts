import type {AsioDriverKey,AsioDriverCatalog,AsioCapabilities,AsioOutputView,AsioOutputRequest,AsioOutputResult} from './asio-output.js';
export type FacetView = 'artists' | 'albums' | 'albumGroups' | 'genres';
export type View = 'all' | FacetView | 'folders' | 'favorites' | 'recent' | 'playlists';
export type RootStatus = 'online' | 'offline' | 'scanning';
export interface ArtworkCandidate {url:string;token:string;sourceKind:'embedded'|'sidecar'|'online';label:string;width?:number;height?:number;cacheState?:'fresh'|'stored'|'offline'|'stale';leaseOwner?:string}
export type ArtistRole = 'performer' | 'album_artist' | 'composer' | 'conductor' | 'orchestra';
export interface ArtistCreditMember { id:string; name:string; role:ArtistRole; ordinal:number; joinPhrase:string|null; creditedName?:string|null; sourceArtistId?:string; artistRevision?:number; disambiguation?:string; sortName?:string|null }
export interface ArtistCandidate {id:string;name:string;disambiguation:string;identityId:string;identityName:string;revision:number;confirmed:boolean;count:number;context:string}
export interface ExternalReference {provider:string;externalId:string;url:string|null}
export interface GenreRef {genreId:string;revision:number;fingerprint:string}
export interface GenreSummary {id:string;name:string;parentId:string|null;parentName:string|null;customized:boolean;archived:boolean;childCount:number;count:number}
export interface GenreDetail extends GenreRef {genre:GenreSummary;parent:GenreRef|null;ancestors:Array<{id:string;name:string}>;aliases:string[];subtreeCount:number}
export interface GenreListRequest {query?:string;parentId?:string|null;includeArchived?:boolean;cursor?:string}
export interface GenrePage {items:GenreSummary[];nextCursor:string|null}
export interface GenreFilter {ids:string[];operator:'any'|'all';descendants:boolean}
export type GenreEditRequest={commandId:string}&(
  {action:'genre-create';name:string;parent:GenreRef|null}|
  {action:'genre-profile';genre:GenreRef;name:string;parent:GenreRef|null}|
  {action:'genre-archive';genre:GenreRef;archived:boolean}
);
export type EntityReferenceKind='recording'|'release'|'release_group'|'release_track';
export interface EntityReferenceRef {kind:EntityReferenceKind;entityId:string;revision:number;fingerprint:string}
export interface EntityReferences extends EntityReferenceRef {title:string;subtitle:string;itemCount:number;releaseCount:number;references:ExternalReference[]}
export interface EntityReferenceRequest {entity:EntityReferenceRef;references:ExternalReference[];commandId:string}
export interface ArtistProfileRef {artistId:string;revision:number;fingerprint:string}
export interface ArtistProfile extends ArtistProfileRef {name:string;sortName:string;disambiguation:string;archived:boolean;references:ExternalReference[];itemCount:number;aliasCount:number}
export interface ArtistProfileDetail {artist:ArtistProfile;items:LibraryItem[];total:number;aliases:Array<{artistId:string;name:string;revision:number;context:string}>}
export interface ArtistProfileFields {name:string;sortName:string;disambiguation:string;references:ExternalReference[]}
export type ArtistProfileRequest={commandId:string}&(
  {action:'artist-create';fields:ArtistProfileFields}|
  {action:'artist-profile';artist:ArtistProfileRef;fields:ArtistProfileFields}|
  {action:'artist-archive';artist:ArtistProfileRef}
);
export type ArtistEditRequest={commandId:string}&(
  {action:'artist-link';sources:Array<{artistId:string;revision:number}>;target:{artistId:string;revision:number}}|
  {action:'artist-reset';sources:Array<{artistId:string;revision:number}>}|
  {action:'artist-credit';itemId:string;revision:number;members:Array<{artistId:string;artistRevision:number;role:ArtistRole;joinPhrase:string;creditedName?:string|null}>}|
  {action:'credit-reset';itemId:string;revision:number}
);
export interface ReleaseRef {releaseId:string;revision:number;fingerprint:string}
export interface ReleaseSummary extends ReleaseRef {
  title:string;albumArtist:string;date:string|null;country:string|null;edition:string|null;groupId:string|null;
  label:string|null;catalogNumber:string|null;barcode:string|null;albumArtists:ArtistCreditMember[];profileConfirmed:boolean;
  context:string;fileCount:number;trackCount:number;media:Array<{discNumber:number;trackCount:number}>;
}
export interface ReleaseProfileFields {title:string;date:string;country:string;label:string;catalogNumber:string;barcode:string;edition:string;albumArtists:Array<{artistId:string;artistRevision:number;joinPhrase:string;creditedName?:string|null}>}
export interface ReleaseProfileRequest {commandId:string;release:ReleaseRef;fields:ReleaseProfileFields}
export interface RecordingProfileRef {recordingId:string;revision:number;fingerprint:string}
export interface RecordingProfile extends RecordingProfileRef {title:string;versionLabel:string;durationUs:number|null;artists:ArtistCreditMember[];confirmed:boolean;itemCount:number;releaseCount:number}
export interface RecordingProfileFields {title:string;versionLabel:string;durationUs:number|null;artists:Array<{artistId:string;artistRevision:number;role:Exclude<ArtistRole,'album_artist'>;joinPhrase:string;creditedName?:string|null}>}
export interface RecordingProfileRequest {commandId:string;recording:RecordingProfileRef;fields:RecordingProfileFields}
export interface ReleaseDetail {release:ReleaseSummary;items:LibraryItem[];total:number}
export type ReleaseEditRequest={commandId:string}&(
  {action:'release-merge';sources:ReleaseRef[];target:ReleaseRef;discMap:Array<{releaseId:string;sourceDisc:number;targetDisc:number}>}|
  {action:'release-split';source:ReleaseRef;trackIds:string[];fields:{title:string;date:string;country:string;edition:string}}
);
export interface CatalogItem {
  recordingId:string; releaseTrackId:string; releaseId:string;
  albumArtist:string; releaseDate:string|null; edition:string|null; country:string|null;
  releaseContext:string; artists:ArtistCreditMember[]; albumArtists:ArtistCreditMember[]; genres:Array<{id:string;name:string;source:string}>;
  revision:number; releaseRevision:number; confirmed:boolean;
  recordingTitle:string; releaseTitle:string; releaseTrackTitle:string;
  groupId:string|null; groupTitle:string|null;
  artistDisplay?:string;creditConfirmed?:boolean;
  mediumDiscNumber?:number;trackPosition?:number;printedNumber?:string|null;releaseConfirmed?:boolean;
  releaseLabel?:string|null;catalogNumber?:string|null;barcode?:string|null;releaseProfileConfirmed?:boolean;
  recordingVersionLabel?:string|null;recordingDurationUs?:number|null;recordingArtists?:ArtistCreditMember[];recordingProfileConfirmed?:boolean;recordingSourceSelected?:boolean;
}
export type CatalogLinkRequest={commandId:string;items:Array<{itemId:string;revision:number}>}&(
  {action:'recording'|'version';target:{itemId:string;revision:number}}|
  {action:'reset'}|{action:'group';title:string;releases:Array<{releaseId:string;revision:number}>}
);
export interface CatalogChangeResult {changeId:string;items:Array<{itemId:string;revision:number}>;groupId?:string;artistId?:string;genreId?:string}
export interface CatalogChangeSummary {id:string;action:'recording'|'version'|'reset'|'group'|'undo'|'artist-link'|'artist-reset'|'artist-credit'|'credit-reset'|'release-merge'|'release-split'|'artist-create'|'artist-profile'|'artist-archive'|'release-profile'|'entity-references'|'recording-profile'|'metadata-lock'|'metadata-select'|'metadata-collection'|'genre-create'|'genre-profile'|'genre-archive'|'metadata-online';createdAt:number;undone:boolean;partial?:boolean;itemCount:number;title:string}
export interface CatalogFacet { id:string; name:string; count:number; subtitle?:string }

export interface LibraryItem {
  searchMatch?:{kind:'title-exact'|'artist-exact'|'prefix'|'substring'|'alias-or-pinyin'|'normalized'|'spelling';distance?:number};
  replayGain?:ReplayGainTags|null;
  id: string;
  fileId: string;
  // Last scan's size/mtime observation; a display cache key, not a content hash.
  fileStamp?:string;
  // Optional scan attribute digest, separate from the legacy size/mtime stamp.
  fileObservation?:string;
  libraryState?:import('./file-policy.js').FileLibraryState;
  sourceSampleRange?:import('./source-sample-range.js').SourceSampleRange;
  cue?:{documentId:string;documentPath:string;ordinal:number;hidden:boolean;timeBaseDen?:number;embeddedTextState?:'matched'|'text-only'|'rejected';embeddedTextNotice?:string;embeddedTextSourceHash?:string|null;index00Frame:number|null;index01Frame:number;pregapFrame:number|null;postgapFrame:number|null;indices:Array<{number:number;frame:number}>;flags:string[];sourceHash:string|null;encoding:string|null;parserVersion:string|null;interpretationPending?:boolean;gapPolicy:import('./cue-history.js').CueGapPolicy};
  kind: 'file' | 'cue';
  path: string;
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
  sourceStartSeconds: number;
  sourceEndSeconds: number | null;
  sourceStartCueFrame: number | null;
  sourceEndCueFrame: number | null;
  available: boolean;
  addedAt: string | null;
  favorite: boolean;
  rating: number;
  userRevision: number;
  playlistEntryId?: string;
  playlistPosition?: number;
  catalog?:CatalogItem;
  versionCount?:number;
}

export interface LibraryStats {
  roots: number;
  tracks: number;
  artists: number;
  albums: number;
  unavailable: number;
}

export interface ScanState {
  rootId: string;
  path: string;
  phase: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  jobId?:string;stage?:string;
  scanned: number;
  imported: number;
  errors: number;
  message?: string;
}

export type ScanJobStatus='queued'|'running'|'cancelling'|'succeeded'|'failed'|'cancelled'|'interrupted';
export interface ScanJob {id:string;rootId:string;path:string;status:ScanJobStatus;phase:'enumerating'|'media'|'cue'|'finalizing';pass:number;generation:number|null;revision:number;attempts:number;scanned:number;imported:number;errors:number;directories:number;pending:number;unsafe:boolean;message:string;createdAt:number;updatedAt:number;canResume:boolean}
export interface ScanJobPage {items:ScanJob[];nextCursor:string|null}
export type ScanJobCommand={commandId:string}&({action:'start';rootId:string}|{action:'cancel'|'resume';jobId:string;baseRevision:number});
export interface ScanJobResult {status:'saved'|'rejected';job:ScanJob|null;error:string}
export interface ScanIssuePage {items:Array<{id:number;path:string;kind:'directory'|'audio'|'cue';message:string;pass:number;unsafe:boolean}>;nextCursor:string|null}

export interface DsdPcmConversion {
  kind:'dsd-to-pcm';container:'dsf'|'dff';bitRate:number;validBitSamples:string;
  intermediateRate:number;pcmRate:176400;gainDb:0;profile:string;delayCompensation:'pending';
}
export interface PlaybackState {
  interruption?:{kind:'system-suspend'|'pause-timeout';status:'sleeping'|'releasing'|'ready'|'failed';positionEvidence:'recent-position'|'paused-bookmark';hardwareVerified:false};
  planAcceptance?:{phase:'validated'|'ready';hardwareVerified:false};
  pipelinePlan?:AudioPipelinePlan;
  processingPlan?:ProcessingPlan;
  processingCounts?:{clippedSamples:string;invalidSamples:string};
  volumeControl?:{revision:number;application:'callback-target';rampMs:20;hardwareVerified:false};
  state: 'idle' | 'preparing' | 'playing' | 'paused' | 'error';
  itemId: string | null;
  positionSeconds: number;
  durationSeconds: number | null;
  output: string;
  requestedOutput?:{backend:'wasapi';mode:'shared'|'exclusive';deviceId:string|null;allowConversion:boolean;dsdPolicy:'stop'|'pcm'};
  actualOutput?:ActualAudioOutput;
  backend?:'wasapi'|'asio';
  asio?:import('./asio-playback.js').AsioPlaybackView;
  asioDsd?:import('./asio-dsd.js').AsioDsdPlaybackView;
  clock?:PlaybackClock;
  tail?:PlaybackTail;
  decodedSource?:{backend:'miniaudio'|'ffmpeg-8.1.3';codec:string;format:'f32'|'s16'|'s32';sampleRate:number;channels:number;certification:'pending';dsdConversion?:DsdPcmConversion|null;opusGain?:OpusGainInfo|null;media?:DecoderSourceEvidence;fileBinding?:PlaybackFileBinding};
  // Callback-side buffer starvation only; this does not measure DAC output.
  diagnostics?: { callbackCount:number; bufferUnderrunCallbacks:number; bufferUnderrunFrames:number };
  message?: string;
}

export type RepeatMode = 'off' | 'one' | 'all';
export interface DecoderSourceEvidence {version:1;encoding:'pcm-integer'|'pcm-float'|'lossless-integer'|'lossy'|'dsd'|'unknown';validBits:number|null;containerBits:number|null;evidence:'decoder-header'|'codec-context'|'unknown';decoderConversion:'integer-to-float'|'integer-output'|'float-output'|'lossy-decode'|'dsd-to-pcm'|'unknown'}
export interface PlaybackFileBinding {version:1;kind:'windows-readonly-handle';volumeSerial:string;fileIndex:string;byteLength:string;lastWriteTicks:string;shareMode:'read-only';certification:'pending'}
export type AudioOutputMode='shared'|'exclusive'|'exclusive-convert';
export interface PlaybackClock {version:4;authority:'device-reported'|'converter-estimate'|'callback-estimate'|'paused-bookmark';reason:string;sourceFrame:string;callbackFrame:string;sourceSampleRate:number;deviceSampleRate:number;committedDeviceFrames:string;submissionValid:boolean;bookmarkBasis:'device-frozen'|'converted-frozen'|'recent-position'|'requested-position'|null;devicePosition:string|null;deviceFrequency:string|null;qpc100ns:string|null;hresult:string;mappingUncertaintyFrames:1|null;conversion:{resampled:boolean;inputConsumed:string;outputProduced:string;outputPaddingFrames:string;inputLatencyFrames:string;outputLatencyFrames:string;latencyEvidence:'frame-preserving'|'converter-reported-estimate'};hardwareVerified:false;generation:number;receivedAt:number}
export interface PlaybackTail {version:1;status:'flushing'|'draining'|'completed';evidence:'pending'|'device-clock'|'shared-padding'|'exclusive-period-estimate';sourceFrame:string;sourceSampleRate:number;deviceSampleRate:number;inputEndFrame:string;targetOutputFrames:string|null;committedOutputFrames:string|null;packetPaddingFrames:string|null;filterTailInputFrames:string;policy:'no-resampler'|'linear-src-100ms';probeHresult:string|null;proof:{clockPosition:string|null;clockFrequency:string|null;paddingFrames:string|null;elapsedMs:number;bufferFrames:string}|null;hardwareVerified:false;generation:number;receivedAt:number}
export interface AudioDevice {id:string;name:string;isDefault:boolean}
export interface AudioDeviceWatchState {revision:number;status:'starting'|'watching'|'unavailable'|'stopped';message:string;observedAt:number;reasons:string[]}
export interface AudioDeviceList {backend:'wasapi';devices:AudioDevice[];truncated:boolean;incomplete:boolean;observedAt:number;deviceRevision:number}
export interface AudioFormatCandidate {format:'u8'|'pcm'|'float'|'unknown';containerBits:number;validBits:number;sampleRate:number;channels:number;channelMask:number;representation:'waveformatex'|'extensible'}
export interface AudioExclusiveProbe extends AudioFormatCandidate {status:'reported'|'unsupported'|'error';hresult:string}
export interface AudioDeviceCapabilities {deviceId:string;deviceName:string;observedAt:number;deviceRevision:number;evidence:'driver-reported';driverVersion:null;firmwareVersion:null;mixFormat:AudioFormatCandidate|null;mixHresult:string;periods:{default100ns:string;minimum100ns:string}|null;periodHresult:string;exclusiveProbes:AudioExclusiveProbe[];matrixVersion:'wasapi-pcm-candidates-v1';incomplete:boolean;hardwareVerified:false}
export interface ActualAudioOutput {backend:'wasapi';deviceId:string;deviceName:string;mode:'shared'|'exclusive';format:string;deviceFormat:string;sampleRate:number;deviceSampleRate:number;channels:number;deviceChannels:number;adapterConversion:boolean;allowConversion:boolean;applicationIntegerPath:boolean;hardwareVerified:false}
export interface AudioConverterPlan {version:1;formatIn:string;formatOut:string;channelsIn:number;channelsOut:number;sampleRateIn:number;sampleRateOut:number;executionPath:'passthrough'|'format-only'|'channels-only'|'resample-only'|'resample-first'|'channels-first';passthrough:boolean;preFormat:boolean;postFormat:boolean;channelConversion:boolean;resampling:boolean;dither:'none'|'rectangular'|'triangular';resampler:'none'|'linear';inputLatencyFrames:string;outputLatencyFrames:string;channelPath:'none'|'passthrough'|'mono-out'|'mono-in'|'shuffle'|'weights';channelMode:'none'|'rectangular'|'simple'|'custom';inputMap:number[]|null;outputMap:number[]|null;shuffle:number[]|null;weights:number[][]|null;weightRepresentation:'f32'|'s16-fixed'|null}
export interface AudioPipelinePlan {version:2;transport:'pcm';source:NonNullable<PlaybackState['decodedSource']>;output:ActualAudioOutput;conversion:AudioConverterPlan;gain:ProcessingPlan;span:{startFrame:string;endFrame:string|null;boundaryFrame:string|null;segmentIndex:0|1};buffers:{preReadFrames:string;preReadBytes:number;deviceFrames:string};path:'integer-candidate'|'float-processing'|'float-unity';stages:string[];clockPolicy:'frame-preserving'|'converter-delay-estimate';tailPolicy:'no-resampler'|'linear-src-100ms';encodedQuality:'lossless'|'lossy'|'unknown'|'dsd-converted';sampleStatus:'processing'|'conversion'|'integer-candidate'|'unity-float-unverified';warnings:string[];hardwareVerified:false;bitPerfectVerified:false}
export interface AudioProcessing {volumeDb:number;muted:boolean;replayGain:'off'|'track'|'album';preampDb:number;preventClipping:boolean;opusPolicy:'r128'|'header-only'|'legacy-before-header'|'legacy-after-header';opusTargetLUFS:-23|-18}
export interface ReplayGainTags {source:'file-tags'|'cue';trackGainDb:number|null;albumGainDb:number|null;trackPeak:number|null;albumPeak:number|null}
export interface OpusGainInfo {version:1;headerGainQ78:number;r128TrackQ78:number|null;r128AlbumQ78:number|null;r128TrackStatus:'missing'|'valid'|'invalid';r128AlbumStatus:'missing'|'valid'|'invalid';legacyTags:ReplayGainTags;legacyPresent:boolean;decoder:'ffmpeg-native-opus';headerApplied:true;referenceLUFS:-23;packetValidation:'ogg-crc-and-opushead-match';streamIndex:number;streamSerial:number;pageCount:number;tagBytes:number;hardwareVerified:false}
export interface ProcessingPlan {version:3;application:'callback-linear-envelope';rampMs:20;settings:AudioProcessing;tags:ReplayGainTags|null;enabled:boolean;selection:'none'|'track'|'album';reason:'disabled'|'selected'|'missing-tags'|'album-fallback-track'|'missing-r128'|'header-only';peak:number|null;requestedGainDb:number;effectiveGainDb:number;linearGain:number;peakLimited:boolean;peakEvidence:'tag'|'assumed-full-scale';samplePolicy:'hard-clip'|'preserve-float';invalidSamplePolicy:'zero';dither:'none';hardwareVerified:false;codecGain:OpusGainInfo|null;gainBasis:'none'|'file-replaygain'|'opus-r128'|'opus-legacy-before-header'|'opus-legacy-after-header'|'opus-header-only';codecGainDb:number;normalizationGainDb:number;referenceOffsetDb:number;totalRequestedGainDb:number;totalEffectiveGainDb:number}
export interface AudioOutputPreference {revision:number;backend:'wasapi';deviceId:string|null;deviceName:string|null;mode:AudioOutputMode;dsdPolicy:'stop'|'pcm';processing:AudioProcessing}
export interface AudioOutputRequest {commandId:string;baseRevision:number;deviceId:string|null;mode:AudioOutputMode;dsdPolicy:'stop'|'pcm';processing:AudioProcessing}
export interface AudioOutputView {preference:AudioOutputPreference;pendingCommandId:string|null;pendingRequest:AudioOutputRequest|null}
export interface AudioOutputResult {status:'saved'|'rejected'|'unknown';preference:AudioOutputPreference;playback:PlaybackState;error:string}
export interface QueueEntry { id: string; itemId: string; playlistEntryId?: string }
export interface QueueState {
  entries: QueueEntry[];
  currentEntryId: string | null;
  repeat: RepeatMode;
  shuffle: boolean;
  order: string[];
  orderCursor: number;
  history: string[];
  historyCursor: number;
  revision: number;
}
export interface QueueView extends QueueState { items: LibraryItem[] }
export interface QueueCommand { commandId: string; baseRevision: number }

export interface ItemUserState { itemId:string; favorite:boolean; rating:number; revision:number }
export interface UserStateRequest extends QueueCommand {itemId:string;favorite?:boolean;rating?:number}
export interface PlaylistSummary {id:string;name:string;revision:number;count:number;createdAt:string;updatedAt:string}
export type PlaylistEditRequest = QueueCommand & {playlistId:string} & (
  {action:'rename';name:string} | {action:'delete'} | {action:'add';itemIds:string[]} |
  {action:'remove';entryId:string} | {action:'move';entryId:string;direction:-1|1}
);
export interface PlaylistPlaybackContext {playlistId:string;revision:number;entries:Array<{id:string;itemId:string}>;startIndex:number}

export interface LyricsDocument {
  source: string;
  sourceKind?: 'embedded' | 'sidecar' | 'imported';
  id?: string;
  label?: string;
  language?: string;
  encoding?: string;
  descriptor?: string;
  sourceOffsetMs?: number;
  kind: 'timed' | 'plain';
  lines: Array<{ atSeconds: number; text: string }>;
}
export interface LyricsPreference {
  primaryId:string|null; secondaryId:string|null; offsetSourceId:string|null;
  offsetMs:number; secondaryOffsetMs:number; showSecondary:boolean; fontSize:number; sourceOrder?:string[];
}
export interface LyricsBundle {
  itemId:string; scope:string; revision:number; sources:LyricsDocument[]; defaultSourceIds:string[]; sourceSetFingerprint:string;
  preference:LyricsPreference; primaryId:string|null; secondaryId:string|null;
  offsetMs:number; secondaryOffsetMs:number; notice:string;
}
export interface LyricsPreferenceRequest {
  commandId:string; itemId:string; scope:string; baseRevision:number;
  preference:LyricsPreference; sourceSetFingerprint?:string;
}
export interface LyricsPreferenceResult {status:'saved'|'rejected';bundle:LyricsBundle|null;error:string}
export type LyricsEncoding='auto'|'utf-8'|'utf-16le'|'utf-16be'|'gb18030';
export type LyricsTimeBasis='track-relative'|'audio-absolute';
export interface LyricsImportInput {itemId:string;scope:string;label:string;language:string;encoding:LyricsEncoding;timeBasis:LyricsTimeBasis;rawBase64:string;sourceDocumentId?:string;sourceLocalVersionId?:string}
export interface LocalLyricsVersionSummary {id:string;sourceId:string;label:string;encoding:LyricsEncoding;rawBytes:number;rawSha256:string;kind:'timed'|'plain';lineCount:number;createdAt:string;lastKnown:boolean;scope:string}
export interface LocalLyricsVersionPage {itemId:string;scope:string;items:LocalLyricsVersionSummary[];nextCursor:string|null}
export interface LocalLyricsVersion {summary:LocalLyricsVersionSummary;rawBase64:string;preview:LyricsImportPreview}
export interface SavedLocalLyricsQuery {query:string;association:'all'|'removed'|'same-item';kind:'all'|'timed'|'plain';lastKnownOnly:boolean;itemId?:string;cursor?:string}
export interface SavedLocalLyricsSummary extends LocalLyricsVersionSummary {itemId:string;association:'current'|'previous-scope'|'removed';itemTitle:string|null;fileAvailable:boolean|null;originalTitle:string;originalArtist:string;originalAlbum:string;language:string}
export interface SavedLocalLyricsPage {items:SavedLocalLyricsSummary[];nextCursor:string|null}
export interface SavedLocalLyricsVersion extends LocalLyricsVersion {summary:SavedLocalLyricsSummary}
export interface LyricsScopeSnapshot {
 version:1;scope:string;item:Pick<LibraryItem,'id'|'fileId'|'path'|'kind'|'title'|'artist'|'album'|'durationSeconds'|'codec'|'sampleRate'|'bitsPerSample'|'trackNumber'|'discNumber'|'sourceStartSeconds'|'sourceEndSeconds'|'sourceStartCueFrame'|'sourceEndCueFrame'>;
 catalog:{recordingId:string;releaseId:string;releaseTrackId:string;revision:number;releaseRevision:number}|null;
 localSidecar?:{version:2;timeBasis:'track-relative'|'audio-absolute';cueIndex01Seconds:number|null};
}
export interface SavedLyricsStateRequest {commandId:string;itemId:string;scope:string;baseRevision:number;action:'archive'|'restore';documentId:string}
export interface SavedLyricsChangePage extends LyricsDocumentChangePage {scope:string;revision:number}
export interface LyricsImportPreview {scopeSnapshot?:LyricsScopeSnapshot|null;text:string;encoding:string;rawSha256:string;rawBytes:number;document:LyricsDocument;target?:{title:string;artist:string;kind:'file'|'cue';sourceStartSeconds:number;sourceEndSeconds:number|null}}
export type LyricsDocumentRequest={commandId:string;itemId:string;scope:string;baseRevision:number}&(
 {action:'import';input:LyricsImportInput}|{action:'archive'|'restore';documentId:string}
);
export interface LyricsDocumentSummary {id:string;label:string;language:string;kind:'timed'|'plain';encoding:string;timeBasis:LyricsTimeBasis;rawBytes:number;rawSha256:string;lineCount:number;archived:boolean;createdAt:string;changedAt:string}
export interface LyricsDocumentPage {itemId:string;scope:string;revision:number;items:LyricsDocumentSummary[];nextCursor:string|null;olderScopeCount:number}
export interface LyricsDocumentChangeSummary {commandId:string;documentId:string;action:'import'|'archive'|'restore';label:string;revision:number;createdAt:string}
export interface LyricsDocumentChangePage {items:LyricsDocumentChangeSummary[];nextCursor:string|null}
export interface LyricsDocumentResult {status:'saved'|'rejected';documentId:string|null;revision:number|null;error:string}
export interface SavedLyricsQuery {query:string;association:'all'|'removed'|'same-item';state:'all'|'active'|'archived';itemId?:string;cursor?:string}
export interface SavedLyricsSummary extends LyricsDocumentSummary {itemId:string;scope:string;association:'current'|'previous-scope'|'removed';itemTitle:string|null;fileAvailable:boolean|null;copiedFromId:string|null;copiedFromLocalVersionId:string|null;scopeRevision:number}
export interface SavedLyricsPage {items:SavedLyricsSummary[];nextCursor:string|null}
export interface SavedLyricsDocument {summary:SavedLyricsSummary;rawBase64:string;preview:LyricsImportPreview}

export type MetadataField = 'title' | 'artist' | 'album';
export type MetadataEntityKind='playable_item'|'artist'|'recording'|'release'|'release_group';
export type MetadataScalar=string|number|null;
export interface MetadataPolicyRef {kind:MetadataEntityKind;entityId:string;revision:number;fingerprint:string}
export interface MetadataSourceField {field:string;label:string;value:MetadataScalar;locked:boolean;source:string;recordedAt:string|null;rights:string;sourceUrl:string|null;decisionMode?:MetadataSelectionMode}
export interface MetadataSourceEntity extends MetadataPolicyRef {title:string;fields:MetadataSourceField[]}
export interface MetadataLockRequest {commandId:string;entity:MetadataPolicyRef;locks:Array<{field:string;locked:boolean}>}
export type MetadataSelectionMode='automatic'|'observation'|'clear';
export interface MetadataObservation {id:string;value:MetadataScalar;source:string;recordedAt:string;rights:string;sourceUrl:string|null;selected:boolean;usable:boolean}
export interface MetadataObservationPage {entity:MetadataSourceEntity;field:string;items:MetadataObservation[];total:number;nextCursor:string|null;mode:MetadataSelectionMode;explicit:boolean;automatic:MetadataObservation|null;canClear:boolean}
export type MetadataSelectionChange={field:string}&({mode:'observation';observationId:string}|{mode:'automatic'}|{mode:'clear'});
export interface MetadataSelectionRequest {commandId:string;entity:MetadataPolicyRef;changes:MetadataSelectionChange[]}
export type MetadataCollectionKind='playable_item'|'recording'|'release';
export type MetadataCollectionField='artists'|'albumArtists'|'genres';
export interface MetadataCollectionMember {id:string;name:string;role?:ArtistRole;joinPhrase?:string;creditedName?:string|null;source?:string;fingerprint?:string}
export interface MetadataCollectionRef {kind:MetadataCollectionKind;entityId:string;field:MetadataCollectionField;revision:number;fingerprint:string}
export interface MetadataCollectionObservation {id:string;source:string;sourceRef:string;recordedAt:string;values:MetadataCollectionMember[];rights?:string}
export interface MetadataCollectionView extends MetadataCollectionRef {label:string;title:string;locked:boolean;mode:string;values:MetadataCollectionMember[];automatic:MetadataCollectionObservation|null;observations:MetadataCollectionObservation[];nextCursor:string|null}
export type MetadataCollectionRequest={commandId:string;ref:MetadataCollectionRef}&({action:'lock';locked:boolean}|{action:'automatic'}|{action:'clear'}|{action:'select';entries:Array<{observationId:string;ordinal:number;fingerprint:string}>}|{action:'genres';names:string[]});

export type {MetadataReleaseContext,MetadataReleaseTrack} from './metadata-release-context';
export interface MetadataMatchEvidence {
 algorithm:string;providerScore:number;
 retrieval?:{kind:'confirmed-recording';recordingId:string}|{kind:'isrc';isrc:string;recordingCount:number};
 title:{kind:'exact'|'similar'|'different';similarity:number};
 artist:{kind:'exact'|'similar'|'different'|'missing';similarity:number|null};
 album:{kind:'exact'|'similar'|'different'|'missing'|'edition-title';similarity:number|null};
 duration:{kind:'close'|'near'|'different'|'missing';differenceSeconds:number|null};warnings:string[];
}
export interface MetadataCandidate {
  token: string;
  provider: 'musicbrainz';
  recordingId: string;
  releaseId: string | null;
  title: string;
  artist: string;
  album: string | null;
  date: string | null;
  score: number;
  durationSeconds?:number|null;
  matchEvidence?:MetadataMatchEvidence;
  sourceUrl: string;
  fetchedAt?:string;
  expiresAt?:string;
  cacheHit?:boolean;
  edition?:{country:string|null;status:string|null;disambiguation:string|null;format:string|null;barcode:string|null};
  batchLookup?:import('./metadata-batch-review').MetadataBatchLookup;
  batchEdition?:import('./metadata-batch-recheck').MetadataBatchEdition;
  batchOrigin?:import('./metadata-batch-recheck').MetadataBatchOrigin;
  recordingCredits?:MetadataProviderCredit[];
  releaseCredits?:MetadataProviderCredit[];
  fieldSourceUrls?:Partial<Record<MetadataField,string>>;
  albumContext?:import('./metadata-album-review').MetadataAlbumBinding;
  recordingCreditAt?:string;
  releaseCreditAt?:string;
}

export interface CoverArtSourceRequest {itemId:string;token:string;fingerprint:string;requestId:string;fresh?:boolean}
export interface ConvertedCoverImage {url:string;token:string;width:number;height:number}
export interface CoverArtImageRequest extends CoverArtSourceRequest {imageId:string}
export interface CoverArtImagePreview extends ConvertedCoverImage {
 itemId:string;candidateToken:string;fingerprint:string;releaseId:string;imageId:string;sourceUrl:string;fetchedAt:string;expiresAt:string;
 rights:{status:'unverified';display:true;cache:'session';persist:false;export:false};
}
export interface CoverArtSourceEntry {imageId:string;front:boolean;back:boolean;editorialApproved:boolean;types:string[];comment:string}
export interface CoverArtSourceIndex {
 itemId:string;token:string;fingerprint:string;provider:'cover-art-archive';releaseId:string;sourceUrl:string;
 availability:'found'|'not-found';entries:CoverArtSourceEntry[];fetchedAt:string;expiresAt:string;cacheHit:boolean;
 indexRights:{display:true;cache:'memory';persist:false};imageRights:{status:'unverified';display:false;cache:false;export:false;preview:'on-request'};
}
export interface MetadataProviderCredit {externalId:string;name:string;creditedName:string;joinPhrase:string;sortName:string;disambiguation:string}
export interface MetadataCreditMember extends MetadataProviderCredit {localArtistId:string|null;localName:string|null;identityFingerprint:string;archived:boolean}
export interface MetadataCreditTarget {ref:MetadataCollectionRef;title:string;locked:boolean;itemCount:number;current:MetadataCollectionMember[];candidates:MetadataCreditMember[]}
export interface MetadataCreditPreview {itemId:string;token:string;expiresAt:string;targets:MetadataCreditTarget[];recordingTitle:string;releaseTitle:string|null;sourceUrl:string;releaseUrl:string|null}
export interface MetadataCreditApplyRequest {commandId:string;itemId:string;token:string;ref:MetadataCollectionRef;entries:Array<{source:'current'|'candidate';ordinal:number;role:ArtistRole;joinPhrase:string;identityFingerprint?:string}>}

export interface MetadataNetworkState {provider:'musicbrainz';enabled:boolean;retentionMode:ProviderRetentionMode;active:number;queued:number;cacheEntries:number;retryAt:number|null;blocked:boolean;proxy:'system'}
export type ProviderRetentionMode='reviewed'|'preview-only';
export interface ProviderRetention {providerId:ProviderId;mode:ProviderRetentionMode;revision:number;rightsId:string|null;retention:string;scalarChanges:number;pendingScalarChanges:number;releaseChanges:number;pendingReleaseChanges:number;identityChanges:number;pendingIdentityChanges:number;groupLinkChanges?:number;pendingGroupLinkChanges?:number;collectionChanges:number;scalarObservations:number;collectionObservations:number}
export interface ProviderRetentionRequest {commandId:string;providerId:ProviderId;revision:number;mode:ProviderRetentionMode}
export interface ProviderStoredChange {kind?:'item'|'release'|'identity'|'group-link'|'album-credit';id:string;itemId:string;title:string;createdAt:string;undone:boolean}
export interface ProviderStoredChangePage {items:ProviderStoredChange[];nextCursor:string|null}
export type ProviderId='musicbrainz'|'cover-art-archive'|'acoustid';
export interface ProviderCapability {kind:'metadata'|'artwork'|'fingerprint'|'lyrics';ready:boolean;label:string;retention:string}
export interface ProviderManifest {id:ProviderId;name:string;version:string;ready:boolean;capabilities:ProviderCapability[];termsUrl:string;credentialSlots:Array<{id:string;label:string}>;note:string}
export interface ProviderCredentialState {slot:string;present:boolean|null;error:string|null;uncertain:number}
export interface ProviderState {manifest:ProviderManifest;enabled:boolean;revision:number;vaultAvailable:boolean;credentials:ProviderCredentialState[]}
export interface ProviderSettingRequest {commandId:string;providerId:ProviderId;revision:number;enabled:boolean}
export interface ProviderCredentialRequest {commandId:string;providerId:ProviderId;slot:string;operation:'set'|'remove';secret?:string}
export interface ProviderCredentialResult {commandId:string;providerId:ProviderId;slot:string;state:'succeeded'|'unknown';present:boolean|null;message:string|null;replayed?:boolean}
export interface MetadataMatchResult {
  itemId: string;
  item?:LibraryItem;
  revision: number;
  candidates: MetadataCandidate[];
  recordingLookup?:{references:string[];selectedId:string|null;requiresChoice:boolean};
  isrcLookup?:{codes:string[];source:'file-tag'|'cue';selectedCode:string|null;requiresChoice:boolean;notices:string[]};
  lockedFields?:MetadataField[];
  requestId?:string;
  cacheHit?:boolean;
  fingerprint?:string;
}

export interface MetadataBatchCreateRequest {retryOf?:import('./metadata-batch-recheck').MetadataBatchOrigin;commandId:string;title:string;entries:Array<MetadataApplyRequest&{fingerprint:string}>}
export type MetadataBatchOutcome='pending'|'applied'|'conflict'|'failed'|'expired'|'skipped'|'undone'|'undo_conflict';
export interface MetadataBatchRow {edition?:import('./metadata-batch-recheck').MetadataBatchEdition;fetchedAt?:string;fieldSourceUrls?:Partial<Record<MetadataField,string>>;lookup?:Omit<import('./metadata-batch-review').MetadataBatchLookup,'sourceFingerprint'|'version'>;albumContext?:import('./metadata-album-review').MetadataAlbumBinding;ordinal:number;itemId:string;before:Record<MetadataField,string>;values:Partial<Record<MetadataField,string>>;fields:MetadataField[];expiresAt:string;sourceUrl:string;outcome:MetadataBatchOutcome;result:MetadataChangeResult|null;undoResult?:MetadataChangeResult|null;error:string|null}
export interface MetadataBatchSummary {id:string;title:string;createdAt:string;revision:number;status:'ready'|'paused'|'completed'|'cancelled';total:number;counts:Partial<Record<MetadataBatchOutcome,number>>}
export interface MetadataBatch extends MetadataBatchSummary {retryOf?:import('./metadata-batch-recheck').MetadataBatchOrigin;rows:MetadataBatchRow[];rights:string}
export interface MetadataBatchCommand {commandId:string;batchId:string;revision:number;action:'step'|'pause'|'cancel'|'undo'}

export interface MetadataApplyRequest {
  itemId: string;
  revision: number;
  token: string;
  fields: MetadataField[];
}

export interface MetadataChangeResult {
  changeId: string;
  revision: number;
  updated: MetadataField[];
  undoId?:string;
  remaining?:MetadataField[];
  conflicts?:Array<{field:MetadataField;reason:string}>;
}

export interface AudioAnalysisFrame {
  version:1;sessionId:string;generation:number;itemId:string;receivedAt:number;
  positionSeconds:number;sampleRate:number;channels:number;windowFrames:2048;
  tap:'callback-pcm-before-device'|'independent-dsd-pcm-copy';
  dsdCopy?:import('./dsd-analysis.js').DsdAnalysisEvidence;
  peakDb:number[];rmsDb:number[];spectrumDb:number[];waveform:Array<[number,number]>;
  droppedFrames:number;invalidSamples:number;
}
export interface AudioAnalysisStatus {source:'pcm-callback'|'dsd-copy'|'none';state:'disabled'|'starting'|'warming-up'|'ready'|'failed';message:string;sessionId:string|null;generation:number|null;hardwareVerified:false}
export interface WaveformSummary {
  version:1;algorithm:string;sha256:string;sampleRate:number;channels:number;
  decoder:{backend:'miniaudio'|'ffmpeg-8.1.3';codec:string;certification:'pending'};
  dsdConversion?:DsdPcmConversion|null;
  startFrame:string;endFrame:string;durationSeconds:number;peakDb:number;rmsDb:number;invalidSamples:string;
  levels:Array<{points:number;values:Array<[number,number]>}>;
}
export type WaveformStatus='queued'|'running'|'cancelling'|'completed'|'failed'|'cancelled'|'interrupted';
export interface WaveformJob {id:string;itemId:string;status:WaveformStatus;phase:'waiting'|'hashing'|'decoding'|'done';progress:number;createdAt:number;updatedAt:number;message:string|null;cached:boolean;summary:WaveformSummary|null}

export interface MetadataUndoField {field:MetadataField;status:'ready'|'conflict'|'undone';reason:string|null;before:string|null;after:string|null;current:string;restore:string|null;restoreAutomatic:boolean;source:string|null;rights:string|null}
export interface MetadataUndoPreview {changeId:string;itemId:string;title:string;revision:number;fingerprint:string;fields:MetadataUndoField[];complete:boolean}
export interface MetadataUndoRequest {commandId:string;changeId:string;fingerprint:string;fields:MetadataField[]}

export interface ListRequest {
  sort?:import('./library-sort.js').LibrarySort;
  filters?:import('./music-filters.js').MusicFilters;
  view: View;
  value?: string;
  query?: string;
  limit?: number;
  offset?: number;
  facetId?:string;
  artistRole?:ArtistRole;
  collapseVersions?:boolean;
  releaseTrackId?:string;
  genreFilter?:GenreFilter;
}

export interface ListResponse {
  items: LibraryItem[];
  total: number;
}

export interface RequestMessage {
  id: string;
  method: string;
  params?: unknown;
}

export interface ResponseMessage {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface EventMessage {
  event: 'catalogRestoreApplyChanged' | 'catalogRestoreFinalization' | 'catalogRestoreApplication' | 'catalogRestorePending' | 'catalogRestoreChanged' | 'catalogBackupChanged' | 'catalogBackupFreeze' | 'catalogBackupThaw' | 'historyExportChanged' | 'playbackPolicyChanged' | 'filterPresetsChanged' | 'playbackStatisticsChanged' | 'playbackHistoryChanged' | 'tagWriteJobsChanged' | 'scan' | 'scanJobsChanged' | 'libraryWatchChanged' | 'libraryChanged' | 'searchIndexChanged' | 'queue' | 'metadataNetwork' | 'metadataBatch' | 'providersChanged' | 'lyricsChanged' | 'audioOutputChanged' | 'audioBackendChanged' | 'asioOutputChanged' | 'dsdOutputChanged' | 'asioPanelChanged' | 'audioDevicesChanged' | 'desktopControlError' | 'systemMediaChanged' | 'desktopFilesChanged' | 'appearanceChanged';
  payload: unknown;
}

export interface MusicApi extends ProviderManagementApi {
  startupTicket():Promise<string|null>;
  startupInterfaceReady(ticket:string,status:'ready'|'blocked'):Promise<boolean>;
  catalogRestoreState():Promise<import('./catalog-restore.js').CatalogRestoreState>;
  reviewRecordedCatalogMove(transactionId:string):Promise<import('./catalog-move-reconciliation.js').RecordedMoveReview>;
  confirmRecordedCatalogMove(value:import('./catalog-move-reconciliation.js').RecordedMoveConfirmation):Promise<import('./catalog-restore-recovery.js').RestoreRecoveryState>;
  restartCatalogRestoreRecovery(value:import('./catalog-restore-recovery.js').RestoreRecoveryRestartRequest):Promise<import('./catalog-restore-recovery.js').RestoreRecoveryState>;
  catalogRestoreRecoveryState():Promise<import('./catalog-restore-recovery.js').RestoreRecoveryState>;
  recheckCatalogRestoreRecovery():Promise<import('./catalog-restore-recovery.js').RestoreRecoveryState>;
  exportCatalogRestoreRecovery():Promise<string|null>;
  catalogRestoreApplyState():Promise<import('./catalog-restore-consent.js').CatalogRestoreApplyState>;
  applyCatalogRestore(value:import('./catalog-restore-consent.js').RestoreApplyRequest):Promise<import('./catalog-restore-consent.js').CatalogRestoreApplyState>;
  catalogRestoreReview(operationId:string):Promise<import('./catalog-restore-review.js').CatalogRestoreReview>;
  catalogRestoreHistory():Promise<import('./catalog-restore-history.js').CatalogRestoreHistory>;
  recheckCatalogRestore(operationId:string):Promise<import('./catalog-restore.js').CatalogRestorePreview|null>;
  prepareCatalogRestore(operationId:string):Promise<import('./catalog-restore.js').CatalogRestorePreview|null>;
  cancelCatalogRestore(operationId:string):Promise<boolean>;
  catalogBackupState():Promise<import('./catalog-backup-ui.js').CatalogBackupState>;
  catalogBackupHistory():Promise<import('./catalog-backup-history.js').CatalogBackupHistory>;
  verifyCatalogBackup(operationId:string):Promise<import('./catalog-backup-ui.js').CatalogBackupResult|null>;
  startCatalogBackup(operationId:string):Promise<import('./catalog-backup-ui.js').CatalogBackupResult|null>;
  catalogRestoreRendererSeed():Promise<import('./catalog-restore-renderer.js').RestoreRendererRequest|null>;
  catalogRestoreFinalizationReply(value:import('./catalog-restore-finalization.js').RestoreFinalReply):Promise<void>;
  catalogRestoreApplicationReply(value:import('./catalog-restore-application.js').RestoreAppReply):Promise<void>;
  catalogRestoreRendererReply(value:import('./catalog-restore-renderer.js').RestoreRendererReply):Promise<void>;
  catalogRestorePendingReply(value:import('./catalog-restore-pending.js').RestorePendingReply):Promise<void>;
  catalogBackupFrozen(value:import('./catalog-backup-ui.js').CatalogBackupFrozen):Promise<void>;
  cancelCatalogBackup(operationId:string):Promise<boolean>;
  quitCatalogBackup():Promise<void>;
  tagWriteContext(itemId:string):Promise<import('./tag-write-ui.js').TagWriteContext>;
  tagWritePreview(request:import('./tag-write-ui.js').TagWriteDraft):Promise<import('./tag-write-ui.js').TagWritePreview>;
  tagWritePreviewCancel(requestId:string):Promise<void>;
  tagWritePrepare(request:import('./tag-write-ui.js').TagWritePrepareRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteJobs(cursor?:string):Promise<import('./tag-write-ui.js').TagWriteJobPage>;
  tagWriteCancel(request:import('./tag-write-ui.js').TagWriteCancelRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteStage(request:import('./tag-write-ui.js').TagWriteStageRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteStageCancel(request:import('./tag-write-ui.js').TagWriteStageRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteInspect(request:import('./tag-write-ui.js').TagWriteStageRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteInspectCancel(request:import('./tag-recovery.js').TagRecoveryCancelRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagRestoreReprobe(request:import('./tag-restore-reprobe.js').TagRestoreReprobeRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagRestoreReprobeCancel(request:import('./tag-restore-reprobe.js').TagRestoreReprobeCancel):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagRestoreInspect(request:import('./tag-write-ui.js').TagWriteStageRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagRestoreInspectCancel(request:import('./tag-recovery.js').TagRecoveryCancelRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagCommitInspect(request:import('./tag-write-ui.js').TagWriteStageRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagCommitInspectCancel(request:import('./tag-recovery.js').TagRecoveryCancelRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagCommitReprobe(request:import('./tag-commit-reprobe.js').TagCommitReprobeRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagCommitReprobeCancel(request:import('./tag-commit-reprobe.js').TagCommitReprobeCancel):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteRecover(request:import('./tag-recovery.js').TagRecoveryActionRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  tagWriteRecoverCancel(request:import('./tag-recovery.js').TagRecoveryActionCancelRequest):Promise<import('./tag-write-ui.js').TagWriteJob>;
  embeddedCueForItem(itemId:string):Promise<import('./embedded-cue-history.js').EmbeddedCueSource|null>;
  embeddedCueSource(fileId:string):Promise<import('./embedded-cue-history.js').EmbeddedCueSource>;
  embeddedCueSources(query:string,cursor?:string):Promise<import('./embedded-cue-history.js').EmbeddedCuePage>;
  embeddedCueVersions(fileId:string,cursor?:string):Promise<import('./embedded-cue-history.js').EmbeddedCueVersionPage>;
  embeddedCuePreview(request:import('./embedded-cue-history.js').EmbeddedCueRequest):Promise<import('./embedded-cue-history.js').EmbeddedCuePreview>;
  exportEmbeddedCue(request:import('./embedded-cue-history.js').EmbeddedCueExportRequest):Promise<import('./embedded-cue-history.js').EmbeddedCueExportResult|null>;
  pickEmbeddedCueBundle():Promise<import('./embedded-cue-bundle.js').EmbeddedCueBundleInspection|null>;
  cueSourceForItem(itemId:string):Promise<import('./cue-history.js').CueSourceSummary|null>;
  cueSource(fileId:string):Promise<import('./cue-history.js').CueSourceSummary>;
  cueSources(query:string,cursor?:string):Promise<import('./cue-history.js').CueSourcePage>;
  cueSourceVersions(fileId:string,cursor?:string):Promise<import('./cue-history.js').CueVersionPage>;
  cueSourcePreview(fileId:string,versionId:string,encoding:import('./cue-history.js').CueEncoding):Promise<import('./cue-history.js').CueSourcePreview>;
  exportCueSource(request:import('./cue-source-export.js').CueSourceExportRequest):Promise<import('./cue-source-export.js').CueSourceExportResult|null>;
  pickCueSourceBundle():Promise<import('./cue-source-export.js').CueBundleInspection|null>;
  reviewCueVersion(request:import('./cue-version-review.js').CueVersionReviewRequest):Promise<import('./cue-version-review.js').CueVersionReview>;
  selectCueSource(request:import('./cue-source-selection.js').CueSourceSelectionRequest):Promise<import('./cue-source-selection.js').CueSourceSelectionResult>;
  importCueSource(request:import('./cue-source-import.js').CueSourceImportRequest):Promise<import('./cue-source-import.js').CueSourceImportResult>;
  registerCueSource(request:import('./cue-source-registration.js').CueSourceRegisterRequest):Promise<import('./cue-source-import.js').CueSourceImportResult>;
  cueSourceOrigins(request:import('./cue-source-origins.js').CueSourceOriginsRequest):Promise<import('./cue-source-origins.js').CueSourceOriginsPage>;
  inspectCueOrigin(request:import('./cue-source-origins.js').CueSourceOriginRequest):Promise<import('./cue-source-export.js').CueBundleInspection>;
  exportCueOrigin(request:import('./cue-source-origins.js').CueSourceOriginRequest):Promise<import('./cue-source-export.js').CueSourceExportResult|null>;
  configureCueSource(request:import('./cue-history.js').CueInterpretRequest):Promise<import('./cue-history.js').CueInterpretResult>;
  filePolicy(fileId:string):Promise<import('./file-policy.js').FilePolicyView>;
  filePolicies(cursor?:string):Promise<import('./file-policy.js').FilePolicyPage>;
  configureFilePolicy(request:import('./file-policy.js').FilePolicyRequest):Promise<import('./file-policy.js').FilePolicyResult>;
  appearance():Promise<import('./appearance.js').AppearanceState>;
  refreshAppearance():Promise<import('./appearance.js').AppearanceState>;
  configureAppearance(request:import('./appearance.js').AppearanceRequest):Promise<import('./appearance.js').AppearanceResult>;
  desktopFiles():Promise<import('./desktop-files.js').DesktopFileInbox>;
  desktopFileRequest(id:string):Promise<import('./desktop-files.js').DesktopFileReview>;
  importDesktopFiles(files:unknown[]):Promise<string|null>;
  pickDesktopFiles():Promise<string|null>;
  refreshDesktopFiles(id:string,revision:number):Promise<import('./desktop-files.js').DesktopFileReview>;
  submitDesktopFiles(request:import('./desktop-files.js').DesktopFileImport):Promise<import('./desktop-files.js').DesktopFileReview>;
  playDesktopFile(request:import('./desktop-files.js').DesktopFilePlay):Promise<{status:'processed';state:PlaybackState}|{status:'rejected';message:string}>;
  dismissDesktopFiles(id:string,revision:number):Promise<void>;
  item(itemId:string):Promise<LibraryItem|null>;
  addFolder(): Promise<{ rootId: string } | null>;
  rescanRoot(rootId:string,commandId?:string):Promise<{rootId:string;jobId:string}>;
  scanJobs(cursor?:string):Promise<ScanJobPage>;
  scanJob(jobId:string):Promise<ScanJob>;
  scanIssues(jobId:string,cursor?:string):Promise<ScanIssuePage>;
  scanCommand(request:ScanJobCommand):Promise<ScanJobResult>;
  libraryWatchState():Promise<import('./library-watch.js').LibraryWatchState>;
  libraryWatchCommand(request:import('./library-watch.js').LibraryWatchRequest):Promise<import('./library-watch.js').LibraryWatchResult>;
  linkCatalog(request:CatalogLinkRequest):Promise<CatalogChangeResult>;
  undoCatalog(changeId:string,commandId:string):Promise<CatalogChangeResult>;
  catalogChanges(limit?:number,offset?:number):Promise<{items:CatalogChangeSummary[];total:number}>;
  genres(request?:GenreListRequest):Promise<GenrePage>;
  genre(genreId:string):Promise<GenreDetail>;
  editGenre(request:GenreEditRequest):Promise<CatalogChangeResult>;
  versions(itemId:string,limit?:number,offset?:number):Promise<ListResponse>;
  artistCandidates(query?:string,limit?:number,offset?:number):Promise<{items:ArtistCandidate[];total:number}>;
  editArtists(request:ArtistEditRequest):Promise<CatalogChangeResult>;
  artistProfiles(query?:string,limit?:number,offset?:number):Promise<{items:ArtistProfile[];total:number}>;
  artistProfile(artistId:string,limit?:number,offset?:number):Promise<ArtistProfileDetail>;
  editArtistProfile(request:ArtistProfileRequest):Promise<CatalogChangeResult>;
  openArtistReference(artist:ArtistProfileRef,provider:string,externalId:string):Promise<void>;
  releaseCandidates(query?:string,limit?:number,offset?:number):Promise<{items:ReleaseSummary[];total:number}>;
  releaseDetail(releaseId:string,limit?:number,offset?:number):Promise<ReleaseDetail>;
  editReleases(request:ReleaseEditRequest):Promise<CatalogChangeResult>;
  editReleaseProfile(request:ReleaseProfileRequest):Promise<CatalogChangeResult>;
  recordingProfile(recordingId:string):Promise<RecordingProfile>;
  editRecordingProfile(request:RecordingProfileRequest):Promise<CatalogChangeResult>;
  metadataSources(itemId:string):Promise<MetadataSourceEntity[]>;
  metadataSource(kind:MetadataEntityKind,entityId:string):Promise<MetadataSourceEntity>;
  editMetadataLocks(request:MetadataLockRequest):Promise<CatalogChangeResult>;
  metadataHistory(kind:MetadataEntityKind,entityId:string,field:string,cursor?:string):Promise<MetadataObservationPage>;
  selectMetadataSources(request:MetadataSelectionRequest):Promise<CatalogChangeResult>;
  metadataCollection(kind:MetadataCollectionKind,entityId:string,field:MetadataCollectionField,cursor?:string):Promise<MetadataCollectionView>;
  editMetadataCollection(request:MetadataCollectionRequest):Promise<CatalogChangeResult>;
  entityReferences(kind:EntityReferenceKind,entityId:string):Promise<EntityReferences>;
  editEntityReferences(request:EntityReferenceRequest):Promise<CatalogChangeResult>;
  openEntityReference(entity:EntityReferenceRef,provider:string,externalId:string):Promise<void>;
  stats(): Promise<LibraryStats>;
  list(request: ListRequest): Promise<ListResponse>;
  browse(request:import('./library-browse.js').BrowseRequest):Promise<import('./library-browse.js').BrowseResponse>;
  browseCatalog(request:import('./catalog-browse.js').CatalogBrowseRequest):Promise<import('./catalog-browse.js').CatalogBrowseResponse>;
  searchIndexState():Promise<import('./search-index.js').SearchIndexState>;
  retrySearchIndex():Promise<import('./search-index.js').SearchIndexState>;
  catalogViewPreference():Promise<import('./catalog-browse.js').CatalogViewPreference>;
  saveCatalogViewPreference(request:{expected:import('./catalog-browse.js').CatalogViewPreference;value:import('./catalog-browse.js').CatalogViewPreference}):Promise<import('./catalog-browse.js').CatalogViewPreference>;
  playBrowse(request:import('./library-browse.js').BrowsePlayRequest):Promise<PlaybackState>;
  facets(view: FacetView,artistRole?:ArtistRole): Promise<CatalogFacet[]>;
  roots(): Promise<Array<{ id: string; path: string; status: RootStatus }>>;
  play(id: string, contextIds: string[] | undefined, command: QueueCommand): Promise<PlaybackState>;
  setOutput(mode: 'shared' | 'exclusive' | 'exclusive-convert'): Promise<{mode:'shared'|'exclusive'|'exclusive-convert'}>;
  audioDevices():Promise<AudioDeviceList>;
  audioBackend():Promise<import('./audio-backend.js').AudioBackendView>;
  configureAudioBackend(request:import('./audio-backend.js').AudioBackendRequest):Promise<import('./audio-backend.js').AudioBackendResult>;
  configureAsioVolume(request:import('./audio-backend.js').AudioBackendRequest):Promise<import('./audio-backend.js').AudioBackendResult>;
  asioControlPanel():Promise<import('./asio-panel.js').AsioPanelState>;
  openAsioControlPanel(request:import('./asio-panel.js').AsioPanelRequest):Promise<import('./asio-panel.js').AsioPanelState>;
  finishAsioControlPanel(operationId:string):Promise<import('./asio-panel.js').AsioPanelState>;
  cancelAsioControlPanel(operationId:string):Promise<import('./asio-panel.js').AsioPanelState>;
  asioDrivers():Promise<AsioDriverCatalog>;
  asioDriverCapabilities(driver:AsioDriverKey):Promise<AsioCapabilities>;
  asioOutput():Promise<AsioOutputView>;
  configureAsioOutput(request:AsioOutputRequest):Promise<AsioOutputResult>;
  dsdOutput():Promise<import('./dsd-output.js').DsdOutputView>;
  configureDsdOutput(request:import('./dsd-output.js').DsdOutputRequest):Promise<import('./dsd-output.js').DsdOutputResult>;
  audioDeviceWatch():Promise<AudioDeviceWatchState>;
  restartAudioDeviceWatch():Promise<AudioDeviceWatchState>;
  audioDeviceCapabilities(deviceId:string):Promise<AudioDeviceCapabilities>;
  audioOutput():Promise<AudioOutputView>;
  configureAudioOutput(request:AudioOutputRequest):Promise<AudioOutputResult>;
  configureAudioVolume(request:AudioOutputRequest):Promise<AudioOutputResult>;
  setDsdPolicy(policy:'stop'|'pcm'):Promise<{policy:'stop'|'pcm'}>;
  dsdPolicy():Promise<{policy:'stop'|'pcm'}>;
  pause(): Promise<PlaybackState>;
  seek(positionSeconds: number,expectedItemId?:string): Promise<PlaybackState>;
  stop(): Promise<PlaybackState>;
  playback(): Promise<PlaybackState>;
  setAudioAnalysisEnabled(enabled:boolean):Promise<void>;
  desktopSettings():Promise<void>;
  windowPlacementSettings():Promise<void>;
  mediaKeySettings():Promise<void>;
  systemMediaState():Promise<import('./system-media').SystemMediaState>;
  systemMediaSettings():Promise<void>;
  audioAnalysis():Promise<AudioAnalysisFrame|null>;
  audioAnalysisStatus():Promise<AudioAnalysisStatus>;
  requestWaveform(itemId:string,commandId:string):Promise<WaveformJob>;
  waveformJob(jobId:string):Promise<WaveformJob>;
  cancelWaveform(jobId:string):Promise<WaveformJob>;
  waveformJobs():Promise<WaveformJob[]>;
  queue(): Promise<QueueView>;
  next(command: QueueCommand): Promise<PlaybackState>;
  previous(command: QueueCommand): Promise<PlaybackState>;
  setRepeat(mode: RepeatMode, command: QueueCommand): Promise<QueueView>;
  setShuffle(enabled: boolean, command: QueueCommand): Promise<QueueView>;
  queueJump(entryId: string, command: QueueCommand): Promise<PlaybackState>;
  queueRemove(entryId: string, command: QueueCommand): Promise<QueueView>;
  queueMove(entryId: string, direction: -1 | 1, command: QueueCommand): Promise<QueueView>;
  lyrics(id: string): Promise<LyricsDocument | null>;
  lyricsBundle(id:string):Promise<LyricsBundle|null>;
  saveLyricsPreference(request:LyricsPreferenceRequest):Promise<LyricsPreferenceResult>;
  pickLyricsFile():Promise<{name:string;rawBase64:string}|null>;
  previewLyricsImport(input:LyricsImportInput):Promise<LyricsImportPreview>;
  lyricsDocuments(itemId:string,cursor?:string):Promise<LyricsDocumentPage>;
  localLyricsVersions(itemId:string,cursor?:string):Promise<LocalLyricsVersionPage>;
  localLyricsVersion(itemId:string,id:string):Promise<LocalLyricsVersion>;
  savedLocalLyrics(request:SavedLocalLyricsQuery):Promise<SavedLocalLyricsPage>;
  savedLocalLyricsVersion(id:string):Promise<SavedLocalLyricsVersion>;
  lyricsDocument(itemId:string,documentId:string):Promise<LyricsImportPreview>;
  lyricsDocumentChanges(itemId:string,cursor?:string):Promise<LyricsDocumentChangePage>;
  editLyricsDocument(request:LyricsDocumentRequest):Promise<LyricsDocumentResult>;
  savedLyrics(request:SavedLyricsQuery):Promise<SavedLyricsPage>;
  savedLyricsDocument(documentId:string):Promise<SavedLyricsDocument>;
  editSavedLyrics(request:SavedLyricsStateRequest):Promise<LyricsDocumentResult>;
  savedLyricsChanges(documentId:string,cursor?:string):Promise<SavedLyricsChangePage>;
  artwork(id: string,refresh?:boolean): Promise<string | null>;
  artworkCandidate(id:string,rejectedTokens?:string[],thumbnailSize?:256|1024,refresh?:boolean):Promise<ArtworkCandidate|null>;
  artworkLease(url:string,itemId:string,consumer:string,retain:boolean,owner:string):Promise<void>;
  setUserState(request:UserStateRequest):Promise<ItemUserState>;
  playbackHistory(request:import('./playback-history.js').PlaybackHistoryQuery):Promise<import('./playback-history.js').PlaybackHistoryPage>;
  playbackHistoryStatus():Promise<{enabled:boolean;pending:number;error:string}>;
  historyExportState():Promise<import('./history-export.js').HistoryExportState>;
  exportPlaybackHistory(request:import('./history-export.js').HistoryExportRequest):Promise<import('./history-export.js').HistoryExportResult|null>;
  cancelHistoryExport(operationId:string):Promise<boolean>;
  playbackPolicy():Promise<import('./playback-policy.js').PlaybackPolicySnapshot>;
  configurePlaybackPolicy(request:import('./playback-policy.js').PlaybackPolicyRequest):Promise<import('./playback-policy.js').PlaybackPolicyResult>;
  previewMusicQuery(request:import('./music-preview.js').MusicPreviewRequest):Promise<import('./music-preview.js').MusicPreviewResponse>;
  checkMusicPreview(request:import('./music-preview.js').MusicPreviewCheckRequest):Promise<import('./music-preview.js').MusicPreviewCheck>;
  exportRules(request:import('./rule-transfer.js').RuleExportRequest):Promise<{name:string;entries:number}|null>;
  pickRulesFile():Promise<{name:string;bundle:import('./rule-transfer.js').RuleBundle}|null>;
  inspectRuleImport(request:import('./rule-transfer.js').RuleInspectionRequest):Promise<import('./rule-transfer.js').RuleTransferInspection>;
  ruleReferenceTargets(request:import('./rule-transfer.js').RuleReferenceQuery):Promise<import('./rule-transfer.js').RuleReferencePage>;
  importRules(request:import('./rule-transfer.js').RuleImportRequest):Promise<import('./rule-transfer.js').RuleImportResult>;
  filterPresets(request:import('./filter-presets.js').FilterPresetPageRequest):Promise<import('./filter-presets.js').FilterPresetPage>;
  filterPreset(id:string):Promise<import('./filter-presets.js').FilterPresetDetail>;
  mutateFilterPreset(request:import('./filter-presets.js').FilterPresetMutation):Promise<import('./filter-presets.js').FilterPresetResult>;
  smartPlaylistHistory(request:import('./smart-playlist-history.js').SmartHistoryRequest):Promise<import('./smart-playlist-history.js').SmartHistoryPage>;
  smartPlaylistHistoryDetail(request:import('./smart-playlist-history.js').SmartHistoryDetailRequest):Promise<import('./smart-playlist-history.js').SmartHistoryDetail>;
  restoreSmartPlaylist(request:import('./smart-playlist-history.js').SmartPlaylistRestoreRequest):Promise<import('./smart-playlist-history.js').SmartPlaylistRestoreResult>;
  smartPlaylists(request:import('./smart-playlists.js').SmartPlaylistPageRequest):Promise<import('./smart-playlists.js').SmartPlaylistPage>;
  smartPlaylist(id:string):Promise<import('./smart-playlists.js').SmartPlaylistDetail>;
  mutateSmartPlaylist(request:import('./smart-playlists.js').SmartPlaylistMutation):Promise<import('./smart-playlists.js').SmartPlaylistResult>;
  playlists():Promise<PlaylistSummary[]>;
  createPlaylist(name:string,commandId:string,itemIds?:string[]):Promise<PlaylistSummary>;
  editPlaylist(request:PlaylistEditRequest):Promise<PlaylistSummary|null>;
  playPlaylist(playlistId:string,entryId:string,playlistRevision:number,command:QueueCommand):Promise<PlaybackState>;
  metadataContact(): Promise<string>;
  metadataReviewState(itemId:string):Promise<{itemId:string;revision:number;fingerprint:string}>;
  setMetadataContact(contact: string): Promise<void>;
  metadataBatchReviewStart(itemIds:string[]):Promise<import('./metadata-batch-review').MetadataBatchReviewLease>;
  metadataBatchReviewStatus(reviewToken:string):Promise<import('./metadata-batch-review').MetadataBatchReviewStatus>;
  metadataBatchReviewClose(reviewToken:string):Promise<void>;
  metadataMatch(id:string,requestId?:string,fresh?:boolean,recordingId?:string,isrc?:string,reviewToken?:string):Promise<MetadataMatchResult>;
  metadataEditions(request:import('./metadata-editions').MetadataEditionsRequest):Promise<import('./metadata-editions').MetadataEditionsPage>;
  metadataGroupLinkPreview(request:import('./metadata-group-link').MetadataGroupLinkPreviewRequest):Promise<import('./metadata-group-link').MetadataGroupLinkPreview>;
  metadataGroupLinkApply(request:import('./metadata-group-link').MetadataGroupLinkApplyRequest):Promise<import('./metadata-group-link').MetadataGroupLinkResult>;
  metadataGroupLinkUndoPreview(id:string):Promise<import('./metadata-group-link').MetadataGroupLinkUndoPreview>;
  metadataAlbumCreditsPreview(request:import('./metadata-album-credits').MetadataAlbumCreditsPreviewRequest):Promise<import('./metadata-album-credits').MetadataAlbumCreditsPreview>;
  metadataAlbumCreditsApply(request:import('./metadata-album-credits').MetadataAlbumCreditsApplyRequest):Promise<import('./metadata-album-credits').MetadataAlbumCreditsResult>;
  metadataAlbumCreditUndoPreview(id:string):Promise<import('./metadata-album-credits').MetadataAlbumCreditUndoPreview>;
  metadataIdentityPreview(request:import('./metadata-identities').MetadataIdentityPreviewRequest):Promise<import('./metadata-identities').MetadataIdentityPreview>;
  metadataIdentityApply(request:import('./metadata-identities').MetadataIdentityApplyRequest):Promise<import('./metadata-identities').MetadataIdentityResult>;
  metadataIdentityUndoPreview(id:string):Promise<import('./metadata-identities').MetadataIdentityUndoPreview>;
  metadataAlbumPage(request:import('./metadata-album-review').MetadataAlbumPageRequest):Promise<import('./metadata-album-review').MetadataAlbumReviewPage>;
  metadataAlbumTracks(request:import('./metadata-album-review').MetadataAlbumTrackRequest):Promise<import('./metadata-album-review').MetadataAlbumTrackPage>;
  metadataAlbumBatchCreate(request:import('./metadata-album-review').MetadataAlbumBatchRequest):Promise<MetadataBatch>;
  releaseFieldsApply(request:import('./metadata-release-fields').ReleaseFieldsApply):Promise<CatalogChangeResult>;
  releaseFieldsUndoPreview(id:string):Promise<import('./metadata-release-fields').ReleaseFieldsUndoPreview>;
  releaseFieldsUndoApply(request:import('./metadata-release-fields').ReleaseFieldsUndo):Promise<import('./metadata-release-fields').ReleaseFieldsUndoResult>;
  metadataReleaseContext(request:import('./metadata-release-context').MetadataReleaseContextRequest):Promise<import('./metadata-release-context').MetadataReleaseContextResult>;
  cancelMetadataMatch(requestId:string):Promise<void>;
  metadataNetworkState():Promise<MetadataNetworkState>;
  setMetadataNetworkEnabled(enabled:boolean):Promise<void>;
  clearMetadataNetworkCache():Promise<void>;
  metadataApply(request: MetadataApplyRequest): Promise<MetadataChangeResult>;
  metadataCreditPreview(itemId:string,token:string,requestId:string,fresh?:boolean):Promise<MetadataCreditPreview>;
  coverArtSourceIndex(request:CoverArtSourceRequest):Promise<CoverArtSourceIndex>;
  coverArtImagePreview(request:CoverArtImageRequest):Promise<CoverArtImagePreview>;
  releaseCoverArtImagePreview(url:string):Promise<void>;
  onlineArtwork(itemId:string):Promise<import('./online-artwork.js').OnlineArtworkState>;
  onlineArtworkCommand(request:import('./online-artwork.js').OnlineArtworkCommand):Promise<import('./online-artwork.js').OnlineArtworkResult>;
  metadataCreditApply(request:MetadataCreditApplyRequest):Promise<CatalogChangeResult>;
  metadataBatchRecheck(request:import('./metadata-batch-recheck').MetadataBatchOrigin):Promise<import('./metadata-batch-recheck').MetadataBatchRecheckResult>;
  metadataBatchCreate(request:MetadataBatchCreateRequest):Promise<MetadataBatch>;
  metadataBatch(id:string):Promise<MetadataBatch>;
  metadataBatches(cursor?:string):Promise<{items:MetadataBatchSummary[];nextCursor:string|null}>;
  metadataBatchCommand(request:MetadataBatchCommand):Promise<MetadataBatch>;
  metadataUndo(changeId: string): Promise<MetadataChangeResult>;
  metadataUndoPreview(changeId:string):Promise<MetadataUndoPreview>;
  metadataUndoApply(request:MetadataUndoRequest):Promise<MetadataChangeResult>;
  openMetadataSource(url: string): Promise<void>;
  onEvent(callback: (event: EventMessage | { event: 'playback'; payload: PlaybackState }) => void): () => void;
}

// Narrow registry and credential operations; secret reads are never exposed.
export interface ProviderManagementApi {
  providerRetention(id:ProviderId):Promise<ProviderRetention>;
  configureProviderRetention(request:ProviderRetentionRequest):Promise<ProviderRetention>;
  providerStoredChanges(id:ProviderId,cursor?:string):Promise<ProviderStoredChangePage>;
  providers():Promise<ProviderState[]>;
  providerEnabled(id:string):Promise<boolean>;
  configureProvider(request:ProviderSettingRequest):Promise<ProviderState[]>;
  providerCredential(request:ProviderCredentialRequest):Promise<ProviderCredentialResult>;
  openProviderTerms(id:ProviderId):Promise<void>;
}
