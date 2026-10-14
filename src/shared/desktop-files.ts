import type {QueueCommand} from './contracts.js';
export interface DesktopFileItem {id:string;title:string;artist:string;album:string;kind:'file'|'cue';available:boolean}
export interface DesktopFileEntry {id:string;path:string;kind:'audio'|'cue'|'folder'|'rejected';message:string;itemIds:string[]}
export interface DesktopFileFolder {id:string;path:string;existingRootId:string|null;entryIds:string[]}
export interface DesktopFileScan {folderId:string;commandId:string;rootId:string|null;jobId:string|null;message:string}
export interface DesktopFileReview {
 id:string;revision:number;source:'drop'|'open'|'picker';status:'loading'|'review'|'submitting'|'submitted'|'unknown';
 entries:DesktopFileEntry[];folders:DesktopFileFolder[];items:DesktopFileItem[];scans:DesktopFileScan[];message:string;truncated:boolean;
}
export interface DesktopFileInbox {revision:number;requests:Array<Pick<DesktopFileReview,'id'|'revision'|'source'|'status'|'message'> & {count:number}>;message:string}
export interface DesktopFileImport {id:string;baseRevision:number;folderIds:string[]}
export interface DesktopFilePlay {id:string;baseRevision:number;itemId:string;command:QueueCommand}
export interface DesktopFileLookup {entryId:string;rootId:string;relativePath:string;kind:'audio'|'cue'}
export interface DesktopFileMatches {entries:Array<{entryId:string;itemIds:string[]}>;items:DesktopFileItem[];truncated:boolean}
