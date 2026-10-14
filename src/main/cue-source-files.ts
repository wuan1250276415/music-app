import {CUE_SOURCE_EXPORT_LIMIT,CUE_SOURCE_RAW_LIMIT,readCueSourceBundle,type CueSourceBundle,type CueSourceExportData,type CueSourceExportResult} from '../shared/cue-source-export.js';
import {exportPickedSourceBytes} from './source-export-file.js';
import {readPickedSourceJson} from './source-json-file.js';
export function exportPickedCueSource(filename:string,data:CueSourceExportData,forbiddenRoot:string,check:()=>void):Promise<CueSourceExportResult> {
 return exportPickedSourceBytes(filename,data,{extension:data.kind==='raw'?'cue':'json',maxBytes:data.kind==='raw'?CUE_SOURCE_RAW_LIMIT:CUE_SOURCE_EXPORT_LIMIT,label:'CUE 原文',forbiddenRoot},check);
}
export function readPickedCueSourceBundle(filename:string,check:()=>void):Promise<{name:string;archiveSha256:string;bundle:CueSourceBundle}> {
 return readPickedSourceJson(filename,{label:'CUE 来源备份',maxBytes:CUE_SOURCE_EXPORT_LIMIT,read:readCueSourceBundle},check);
}
