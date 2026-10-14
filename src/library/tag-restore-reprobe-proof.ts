import {readFlacTagPreview,readTagFieldChanges,type TagFieldChange,type FlacTagPreview} from '../shared/tag-write.js';
import {classifyTagRestoreRecovery,assertTagRestoreInspectionEqual,type TagRestoreInspectionResult} from '../shared/tag-restore-recovery.js';
import {tagCommitCanonical} from '../shared/tag-commit-journal.js';
import type {TagRestoreBinding,TagRestoreJournalSnapshot} from '../shared/tag-restore-journal.js';
import {MEDIA_PROTOCOL_VERSION,validateMediaResponse,validateMediaRequest,type MediaStat} from './media-worker-protocol.js';
import {validFileObservation} from '../platform/file-observation.js';
import type {ParsedFile} from './database.js';
import type {TagRestoreReprobeMode} from '../shared/tag-restore-reprobe.js';

export interface TagRestoreReprobeProof {mode:TagRestoreReprobeMode;originalExitConfirmed:boolean;commitExitConfirmed:boolean;journalRevision:number;before:TagRestoreInspectionResult;after:TagRestoreInspectionResult;preview:FlacTagPreview;parsed:ParsedFile;stat:MediaStat;observation:string;journalSha256:string;commitJournalSha256:string;stagingJournalSha256:string}
// Reproduce the original read-only preview. Its before-values may contain 256
// entries or empty strings, which are valid source tags but not write requests.
// Prospective target values remain preview inputs; only parsed source is stored.
export function tagRestorePreviewChanges(binding:TagRestoreBinding):TagFieldChange[]{return readTagFieldChanges(binding.commit.plan.changes);}
export function validateRestoreReprobeProof(proof:TagRestoreReprobeProof,binding:TagRestoreBinding,journal:TagRestoreJournalSnapshot,paths:{rootPath:string;realRootPath:string;fullPath:string;relativePath:string}):void {
 if(!['native-restored','interrupted-source'].includes(proof.mode)||typeof proof.originalExitConfirmed!=='boolean'||typeof proof.commitExitConfirmed!=='boolean'||proof.mode==='native-restored'&&(!proof.originalExitConfirmed||journal.revision!==6)||proof.mode==='interrupted-source'&&(journal.revision<4||journal.revision>6)||proof.journalRevision!==journal.revision||!validFileObservation(proof.observation)||proof.journalSha256!==journal.sha256||proof.commitJournalSha256!==binding.request.commitJournalSha256||proof.stagingJournalSha256!==binding.request.stagingJournalSha256||[proof.before,proof.after].some(actual=>classifyTagRestoreRecovery(actual,binding,journal)!=='restored-source'))throw new Error('重新解析缺少实际原来源恢复或完整日志证据');
 assertTagRestoreInspectionEqual(proof.before,proof.after);
 const changes=tagRestorePreviewChanges(binding),preview=readFlacTagPreview(proof.preview,changes),original=binding.commit.plan.preview;
 if(preview.embeddedCueSheet||tagCommitCanonical(preview)!==tagCommitCanonical(original)||preview.fields.some((f,i)=>tagCommitCanonical(f.before)!==tagCommitCanonical(original.fields[i].before)))throw new Error('恢复来源实际标签、容器或保留块不属于原文件');
 const request=validateMediaRequest({...paths,before:proof.stat,version:MEDIA_PROTOCOL_VERSION,kind:'tags',id:binding.request.operationId});
 validateMediaResponse({version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'result',file:proof.parsed,after:proof.stat},request);
 if(proof.parsed.parseError||proof.parsed.size!==Number(original.sourceFileBytes)||proof.parsed.relativePath!==paths.relativePath||proof.parsed.mtimeMs!==proof.stat.mtimeMs||proof.parsed.sampleRate!==preview.sampleRate||proof.parsed.bitsPerSample!==preview.bitsPerSample||BigInt(preview.totalSamples)>0n&&(proof.parsed.durationSeconds===null||Math.abs(proof.parsed.durationSeconds-Number(preview.totalSamples)/preview.sampleRate)>1/preview.sampleRate))throw new Error('恢复来源重新解析的文件或技术资料不符合实际FLAC头部');
}
