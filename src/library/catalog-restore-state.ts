import {readRestoreStateSnapshot,emptyRestoreQueue,type RestoreStateSnapshot} from '../shared/catalog-restore-state.js';
import type {LibraryDatabase} from './database.js';

// Read-only projection shared by hydration, normal preparation and WAL readiness.
// Callers own and verify the maintenance lease before and after this read.
export function restoreLibrarySnapshot(db:LibraryDatabase):RestoreStateSnapshot{
 return readRestoreStateSnapshot({version:1,queue:db.loadQueue()??emptyRestoreQueue(),audioOutput:db.audioOutputSettings.load(),asioOutput:db.asioOutputSettings.load(),audioBackend:db.audioBackendSettings.load(),dsdOutput:db.dsdOutputSettings.load(),appearance:db.loadAppearancePreference(),windowPlacement:db.loadWindowPlacementPreference(),desktop:db.loadDesktopPreference(),mediaKeys:db.loadMediaKeyPreference(),historyPolicy:db.playbackPolicies.load()});
}
