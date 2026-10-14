import type {ICommonTagsResult} from 'music-metadata';
import type {ReplayGainTags} from '../shared/contracts.js';
import {emptyReplayGain,validateReplayGain} from '../shared/audio-processing.js';
const gain=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>=-60&&v<=60?v:null;
const peak=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=64?v:null;
export function fileReplayGain(tags:ICommonTagsResult):ReplayGainTags{
 // Gain dB is authoritative; the library's ratio helper uses power, not amplitude.
 return validateReplayGain({source:'file-tags',trackGainDb:gain(tags.replaygain_track_gain?.dB),albumGainDb:gain(tags.replaygain_album_gain?.dB),trackPeak:peak(tags.replaygain_track_peak?.ratio),albumPeak:peak(tags.replaygain_album_peak?.ratio)});
}
export function cueReplayGain(document:unknown,track:unknown,fallback:ReplayGainTags|null):ReplayGainTags{
 const result=emptyReplayGain('cue');result.albumGainDb=fallback?.albumGainDb??null;result.albumPeak=fallback?.albumPeak??null;
 const read=(fields:unknown,albumOnly:boolean)=>{
  if(!Array.isArray(fields))return;
  const seen=new Set<string>();
  for(const field of fields){
   if(field?.command!=='REM'||typeof field.value!=='string')continue;
   const match=/^(REPLAYGAIN_(TRACK|ALBUM)_(GAIN|PEAK))\s+"?([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s+(dB))?"?$/i.exec(field.value.trim());
   if(!match||albumOnly&&match[2].toUpperCase()!=='ALBUM'||match[3].toUpperCase()==='PEAK'&&match[5])continue;
   const key=match[1].toUpperCase(),value=Number(match[4]);
   const name=`${match[2].toLowerCase()}${match[3].toUpperCase()==='GAIN'?'GainDb':'Peak'}` as Exclude<keyof ReplayGainTags,'source'>;
   if(seen.has(key)){result[name]=null;continue;}seen.add(key);
   result[name]=match[3].toUpperCase()==='GAIN'?gain(value):peak(value);
  }
 };
 read(document,true);read(track,false);
 // A whole-image TRACK value is not the loudness of an individual CUE segment.
 return result;
}
