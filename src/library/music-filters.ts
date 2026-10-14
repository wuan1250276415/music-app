import {readMusicFilters,musicFilterTimeAnchor,type MusicFilters,type MusicCodecFamily} from '../shared/music-filters.js';
import {genreItemCondition} from './genre-query.js';
export const musicFiltersSchema='CREATE INDEX release_filter_date ON release(date,id);CREATE INDEX media_file_filter_parameters ON media_file(sample_rate,bits_per_sample,codec);';
// Exact parser codec identities only. Unknown and hybrid codecs are not guessed.
export function musicCodecFamily(value:unknown,rate?:unknown,bits?:unknown):MusicCodecFamily{
 if(typeof value!=='string')return 'unknown';const c=value.normalize('NFKC').toLowerCase().replace(/[\s_.\/-]+/g,'');
 if((c==='dsf'||/^dsd\(/.test(c))&&typeof rate==='number'&&rate>0&&bits===1)return 'dsd';
 const names:Record<string,MusicCodecFamily>={flac:'flac',alac:'alac',mpeg4alac:'alac',pcm:'pcm',ieeefloat:'pcm',dsd:'dsd',dsdlsbf:'dsd',dsdmsbf:'dsd',mp3:'mp3',mpeg1layer3:'mp3',mpeg2layer3:'mp3',mpeg25layer3:'mp3',aac:'aac',aaclc:'aac',heaac:'aac',mpeg4aac:'aac',vorbis:'vorbis',oggvorbis:'vorbis',opus:'opus'};
 return names[c]??'unknown';
}
export function musicReleaseYear(value:unknown):number|null{
 if(typeof value!=='string'||!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(value))return null;
 const [year,month,day]=value.split('-').map(Number);if(year<1||month!==undefined&&(month<1||month>12))return null;
 const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 if(day!==undefined&&(day<1||day>days[month-1]))return null;return year;
}
export function musicFilterPlan(value:MusicFilters,recordingCreditCondition:string,asOfMs=musicFilterTimeAnchor()):{where:string[];params:Array<string|number>}{
 const f=readMusicFilters(value),where:string[]=[],params:Array<string|number>=[],family='aural_codec_family_v1(f.codec,f.sample_rate,f.bits_per_sample)',knownPcm=`${family} IN('flac','pcm','alac','mp3','aac','vorbis','opus')`,bind=(values:Array<string|number>)=>{params.push(...values);return values.map(()=>'?').join(',');};
 if(f.artists){const a=f.artists,credit=a.role==='album_artist'?'cr.artist_credit_id':'p.artist_credit_id';where.push(`(SELECT COUNT(DISTINCT COALESCE(ai.identity_artist_id,c.artist_id)) FROM artist_credit_member c LEFT JOIN artist_identity_binding ai ON ai.source_artist_id=c.artist_id WHERE (c.credit_id=${credit}${a.role==='album_artist'?'':recordingCreditCondition}) AND c.role=? AND COALESCE(ai.identity_artist_id,c.artist_id) IN(${(()=>{params.push(a.role);return bind(a.ids);})()})) ${a.operator==='all'?'=':'>='} ?`);params.push(a.operator==='all'?a.ids.length:1);}
 if(f.genres){const g=f.genres,clauses=g.ids.map(id=>{params.push(id);return genreItemCondition('SELECT id FROM genre WHERE id=? AND archived=0',g.descendants);});where.push(`(${clauses.join(g.operator==='all'?' AND ':' OR ')})`);}
 if(f.years){where.push('cr.date>=? AND cr.date<=? AND aural_release_year_v1(cr.date) BETWEEN ? AND ?');params.push(String(f.years.min).padStart(4,'0'),`${String(f.years.max).padStart(4,'0')}~`,f.years.min,f.years.max);}
 if(f.codecs)where.push(`${family} IN(${bind(f.codecs)})`);
 if(f.quality)where.push(`${family} ${f.quality==='unknown'?"='unknown'":f.quality==='lossless'?"IN('flac','pcm','alac','dsd')":"IN('mp3','aac','vorbis','opus')"}`);
 if(f.pcmRates){where.push(`${knownPcm} AND f.sample_rate BETWEEN ? AND ?`);params.push(f.pcmRates.min,f.pcmRates.max);}
 if(f.bitDepths)where.push(`${knownPcm} AND f.bits_per_sample IN(${bind(f.bitDepths)})`);
 if(f.dsdRates)where.push(`${family}='dsd' AND f.sample_rate IN(${bind(f.dsdRates.map(rate=>rate*44100))})`);
 if(f.favorite!==undefined){where.push('COALESCE(u.favorite,0)=?');params.push(f.favorite?1:0);}
 if(f.ratingAtLeast!==undefined){where.push('COALESCE(u.rating,0)>=?');params.push(f.ratingAtLeast);}
 if(f.playCount){where.push(`${f.playCount.min>0?'ps.play_count':'COALESCE(ps.play_count,0)'} BETWEEN ? AND ?`);params.push(f.playCount.min,f.playCount.max);}
 const anchor=musicFilterTimeAnchor(asOfMs),end=new Date(anchor+60000).toISOString(),cutoff=(days:number)=>new Date(anchor-days*86400000).toISOString();
 if(f.lastPlayed){
  const last=f.lastPlayed;
  if(last.mode==='never')where.push('ps.item_id IS NULL');
  else if(last.mode==='within-days'){where.push('ps.last_played_at>=? AND ps.last_played_at<?');params.push(cutoff(last.days),end);}
  else{where.push(last.includeNever?'(ps.item_id IS NULL OR ps.last_played_at<?)':'ps.last_played_at<?');params.push(cutoff(last.days));}
 }
 if(f.addedWithinDays!==undefined){where.push('p.added_at>=? AND p.added_at<?');params.push(cutoff(f.addedWithinDays),end);}
 if(f.available!==undefined)where.push(f.available?"p.visible=1 AND p.library_state='active' AND f.status='online' AND r.status!='offline' AND NOT EXISTS(SELECT 1 FROM cue_track cq JOIN cue_document cd ON cd.id=cq.cue_id JOIN cue_source_file cs ON cs.root_id=cd.root_id AND cs.path_key=aural_cue_path_key_v1(cd.relative_path) WHERE cq.item_id=p.id AND cs.scan_command IS NOT NULL)":"(p.visible!=1 OR p.library_state!='active' OR f.status!='online' OR r.status='offline' OR EXISTS(SELECT 1 FROM cue_track cq JOIN cue_document cd ON cd.id=cq.cue_id JOIN cue_source_file cs ON cs.root_id=cd.root_id AND cs.path_key=aural_cue_path_key_v1(cd.relative_path) WHERE cq.item_id=p.id AND cs.scan_command IS NOT NULL))");
 return {where,params};
}
