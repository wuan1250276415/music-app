import {FINGERPRINT_RECIPE,validAudioFingerprint,type AudioFingerprintSummary} from './audio-fingerprint';

export interface RecognitionMapping {
 version:1;
 source:string;
 authority:string;
 metadata:string;
 fetchedAt:string;
 summary:Omit<AudioFingerprintSummary,'fingerprint'|'sha256'|'rawWords'>;
 mappings:Array<{acoustidId:string;recordingId:string}>;
}
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export function readRecognitionMapping(raw:unknown):RecognitionMapping {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('保存的识别依据无效');
 const v=raw as RecognitionMapping;
 if(Object.keys(v).length!==7||v.version!==1||!digest(v.source)||!digest(v.authority)||!digest(v.metadata)||typeof v.fetchedAt!=='string'||!Number.isFinite(Date.parse(v.fetchedAt))||new Date(v.fetchedAt).toISOString()!==v.fetchedAt||!v.summary||Object.keys(v.summary).length!==13||v.summary.algorithm!==FINGERPRINT_RECIPE)throw new Error('保存的识别依据无效');
 // Validate the local decoding descriptor without retaining any encoded fingerprint.
 if(!validAudioFingerprint({...v.summary,sha256:'0'.repeat(64),fingerprint:'descriptor',rawWords:1}))throw new Error('保存的音频范围无效');
 if(!Array.isArray(v.mappings)||v.mappings.length>100)throw new Error('保存的录音标识数量无效');
 const seen=new Set<string>();
 for(const pair of v.mappings){if(!pair||typeof pair!=='object'||Object.keys(pair).length!==2||!uuid(pair.acoustidId)||!uuid(pair.recordingId)||seen.has(pair.recordingId))throw new Error('保存的录音标识无效');seen.add(pair.recordingId);}
 return structuredClone(v);
}
