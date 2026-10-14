import {EMBEDDED_CUE_EXPORT_LIMIT,type EmbeddedCueExportData,type EmbeddedCueExportResult} from '../shared/embedded-cue-history.js';
import {exportPickedSourceBytes} from './source-export-file.js';
export const embeddedCueExtension=(kind:EmbeddedCueExportData['kind']):string=>kind==='bundle'?'json':kind==='cue-text'?'cue':kind==='text-field'?'vorbis-cue':'flaccue';
export function exportPickedEmbeddedCue(filename:string,data:EmbeddedCueExportData,forbiddenRoot:string,check:()=>void):Promise<EmbeddedCueExportResult> {
 return exportPickedSourceBytes(filename,data,{extension:embeddedCueExtension(data.kind),maxBytes:EMBEDDED_CUE_EXPORT_LIMIT,label:'内嵌 CUE ',forbiddenRoot},check);
}
