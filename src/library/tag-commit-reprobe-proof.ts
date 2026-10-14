import {readFlacTagPreview,type FlacTagPreview} from '../shared/tag-write.js';
import {readTagCommitInspectionResult,classifyTagCommitRecovery,type TagCommitInspectionResult} from '../shared/tag-commit-recovery.js';
import {tagCommitCanonical,type TagCommitBinding,type TagCommitJournalSnapshot} from '../shared/tag-commit-journal.js';
import {MEDIA_PROTOCOL_VERSION,validateMediaResponse,validateMediaRequest,type MediaStat} from './media-worker-protocol.js';
import {validFileObservation} from '../platform/file-observation.js';
import type {ParsedFile} from './database.js';
import type {TagCommitReprobeMode} from '../shared/tag-commit-reprobe.js';
export interface TagCommitReprobeProof {mode:TagCommitReprobeMode;originalExitConfirmed:boolean;journalRevision:number;before:TagCommitInspectionResult;after:TagCommitInspectionResult;preview:FlacTagPreview;parsed:ParsedFile;stat:MediaStat;observation:string;journalSha256:string;stagingJournalSha256:string}
export function assertCommitInspectionEqual(aValue:TagCommitInspectionResult,bValue:TagCommitInspectionResult):void {
 const a=readTagCommitInspectionResult(aValue),b=readTagCommitInspectionResult(bValue);
 if(tagCommitCanonical(a.files)!==tagCommitCanonical(b.files))throw new Error('重新解析期间实际文件或工件变化');
 for(const [left,right] of [...a.roots.map((r,i)=>[r,b.roots[i]]),[a.parent,b.parent]])if(['volume','fileId','creation'].some(k=>left[k as keyof typeof left]!==right[k as keyof typeof right]))throw new Error('重新解析期间目录物理身份变化');
}
export function validateCommitReprobeProof(proof:TagCommitReprobeProof,binding:TagCommitBinding,journal:TagCommitJournalSnapshot,paths:{rootPath:string;realRootPath:string;fullPath:string;relativePath:string}):void {
 if(!['native-verified','interrupted-target'].includes(proof.mode)||typeof proof.originalExitConfirmed!=='boolean'||proof.mode==='native-verified'&&(!proof.originalExitConfirmed||journal.revision!==5)||proof.mode==='interrupted-target'&&(journal.revision<3||journal.revision>5)||proof.journalRevision!==journal.revision||!validFileObservation(proof.observation)||proof.journalSha256!==journal.sha256||proof.stagingJournalSha256!==binding.stagingJournalSha256||[proof.before,proof.after].some(actual=>classifyTagCommitRecovery(actual,binding,journal)!=='replacement-observed'))throw new Error('重新解析缺少实际替换或日志证据');
 assertCommitInspectionEqual(proof.before,proof.after);
 const preview=readFlacTagPreview(proof.preview,binding.plan.changes),original=binding.plan.preview;
 if(preview.changed||preview.embeddedCueSheet||preview.fields.some(f=>f.changed||tagCommitCanonical(f.before)!==tagCommitCanonical(f.values))||preview.sourceMetadataSha256!==original.targetMetadataSha256||preview.targetMetadataSha256!==original.targetMetadataSha256||preview.sourceAudioOffset!==original.targetAudioOffset||preview.sourceFileBytes!==original.targetFileBytes||preview.audioBytes!==original.audioBytes||preview.preservedBlocksSha256!==original.preservedBlocksSha256||preview.streamInfoSha256!==original.streamInfoSha256)throw new Error('实际目标标签、容器或保留块不符合冻结差异');
 const request=validateMediaRequest({...paths,before:proof.stat,version:MEDIA_PROTOCOL_VERSION,kind:'tags',id:binding.request.operationId});
 validateMediaResponse({version:MEDIA_PROTOCOL_VERSION,id:request.id,kind:'result',file:proof.parsed,after:proof.stat},request);
 if(proof.parsed.parseError||proof.parsed.size!==Number(original.targetFileBytes)||proof.parsed.relativePath!==paths.relativePath||proof.parsed.mtimeMs!==proof.stat.mtimeMs||proof.parsed.sampleRate!==preview.sampleRate||proof.parsed.bitsPerSample!==preview.bitsPerSample||BigInt(preview.totalSamples)>0n&&(proof.parsed.durationSeconds===null||Math.abs(proof.parsed.durationSeconds-Number(preview.totalSamples)/preview.sampleRate)>1/preview.sampleRate))throw new Error('重新解析的文件或技术资料不符合实际 FLAC 头部');
}
