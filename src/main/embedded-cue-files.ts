import {readEmbeddedCueSourceBundle,EMBEDDED_CUE_EXPORT_LIMIT,type EmbeddedCueSourceBundle} from '../shared/embedded-cue-bundle.js';
import {readPickedSourceJson} from './source-json-file.js';

export function readPickedEmbeddedCueBundle(filename:string,check:()=>void):Promise<{name:string;archiveSha256:string;bundle:EmbeddedCueSourceBundle}> {
 return readPickedSourceJson(filename,{label:'内嵌 CUE 来源备份',maxBytes:EMBEDDED_CUE_EXPORT_LIMIT,read:readEmbeddedCueSourceBundle},check);
}
