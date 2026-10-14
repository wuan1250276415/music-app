export const LIBRARY_STARTUP_PHASES = ['library-open','snapshot-save','snapshot-verify','index-update','index-verify','library-runtime'] as const;
export type LibraryStartupPhase = typeof LIBRARY_STARTUP_PHASES[number];
export interface LibraryStartupMessage {startupProgress:LibraryStartupPhase}
export type StartupPhase = 'admission' | LibraryStartupPhase | 'preferences' | 'output' | 'queue' | 'desktop' | 'interface' | 'ready' | 'failed' | 'closing';
export interface StartupState {version:1;phase:StartupPhase;title:string;detail:string;elapsedMs:number}
export function readLibraryStartupPhase(value:unknown):LibraryStartupPhase|null {
  if(typeof value!=='string'||!(LIBRARY_STARTUP_PHASES as readonly string[]).includes(value))return null;
  return value as LibraryStartupPhase;
}
