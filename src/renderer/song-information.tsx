import React from 'react';
import type {LibraryItem,ArtistRole} from '../shared/contracts';

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0,Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2,'0')}`;
}

export const roleLabels:Record<ArtistRole,string>={performer:'曲目歌手',album_artist:'专辑艺人',composer:'作曲',conductor:'指挥',orchestra:'乐团'};
export function SongInformation({item,browse}:{item:LibraryItem|null|undefined;browse:(view:'artists'|'albums'|'albumGroups'|'genres',name:string,id?:string,role?:ArtistRole)=>void}):React.JSX.Element {
  const catalog=item?.catalog;
  return <><div className="detail-fields"><span>歌手</span><div className="credit-links">{catalog?.artists.some(member=>member.role==='performer')?
    <>{catalog.artists.filter(member=>member.role==='performer').length>1&&<b className="credit-display">{item?.artist}</b>}{catalog.artists.filter(member=>member.role==='performer').map(member=><button key={`${member.id}:${member.ordinal}`} onClick={()=>browse('artists',member.name,member.id)} title={member.name}>{member.creditedName??member.name}</button>)}</>:
    item?<button onClick={()=>browse('artists',item.artist)}>{item.artist}</button>:<b>—</b>}</div>
    <span>专辑</span>{item?<button onClick={()=>browse('albums',catalog?.releaseTitle??item.album,catalog?.releaseId)}>{catalog?.releaseTitle??item.album}</button>:<b>—</b>}
    <span>风格</span><div className="credit-links">{catalog?.genres.length?catalog.genres.map(genre=><button key={`${genre.id}:${genre.source}`} title={genre.source.startsWith('release:')?'来自发行版的风格':genre.source==='manual'?'用户分类':genre.source.startsWith('collection:')?'已确认来源的风格':'文件风格'} onClick={()=>browse('genres',genre.name,genre.id)}>{genre.name}</button>):item?.genre?<button onClick={()=>browse('genres',item.genre)}>{item.genre}</button>:<b>—</b>}</div>
    <span>音质</span><b>{item?`${item.codec.toUpperCase()}${item.sampleRate?` · ${(item.sampleRate/1000).toFixed(1)} kHz`:''}${item.bitsPerSample?` · ${item.bitsPerSample} bit`:''}`:'—'}</b>
    <span>时长</span><b>{item?formatTime(item.durationSeconds):'—'}</b>
</div>
    {item&&<details className="detail-secondary"><summary>更多歌曲资料</summary><div className="detail-fields">    {catalog?.groupId&&<><span>专辑概念</span><button onClick={()=>browse('albumGroups',catalog.groupTitle??item!.album,catalog.groupId!)}>{catalog.groupTitle}</button></>}
    {catalog?.albumArtists.length? <><span>专辑艺人</span><div className="credit-links">{catalog.albumArtists.map(member=><button key={member.ordinal} onClick={()=>browse('artists',member.name,member.id,'album_artist')} title={member.name}>{member.creditedName??member.name}</button>)}</div></>:null}
    {catalog&&(['composer','conductor','orchestra'] as ArtistRole[]).map(role=>catalog.artists.some(member=>member.role===role)?<React.Fragment key={role}><span>{roleLabels[role]}</span><div className="credit-links">{catalog.artists.filter(member=>member.role===role).map(member=><button key={member.ordinal} onClick={()=>browse('artists',member.name,member.id,role)} title={member.name}>{member.creditedName??member.name}</button>)}</div></React.Fragment>:null)}
    {catalog?.releaseDate&&<><span>发行日期</span><b>{catalog.releaseDate}</b></>}
    {catalog?.edition&&<><span>版本</span><b>{catalog.edition}</b></>}
    {catalog?.country&&<><span>国家／地区</span><b>{catalog.country}</b></>}
    {catalog?.releaseLabel&&<><span>发行公司</span><b>{catalog.releaseLabel}</b></>}
    {catalog?.catalogNumber&&<><span>目录编号</span><b>{catalog.catalogNumber}</b></>}
    {catalog?.barcode&&<><span>条码</span><b>{catalog.barcode}</b></>}
    {(catalog?.recordingProfileConfirmed||catalog?.recordingSourceSelected)&&<><span>录音名称</span><b>{catalog.recordingTitle}</b></>}
    {catalog?.recordingVersionLabel&&<><span>录音版本</span><b>{catalog.recordingVersionLabel}</b></>}
    {catalog?.recordingDurationUs!==undefined&&catalog.recordingDurationUs!==null&&<><span>录音参考时长</span><b>{(catalog.recordingDurationUs/1000000).toFixed(6).replace(/\.?0+$/,'')} 秒</b></>}
    {catalog?.recordingArtists&&(['performer','composer','conductor','orchestra'] as ArtistRole[]).map(role=>catalog.recordingArtists!.some(member=>member.role===role)?<React.Fragment key={`recording-${role}`}><span>{role==='performer'?'录音演出':`录音${roleLabels[role]}`}</span><div className="credit-links">{catalog.recordingArtists!.filter(member=>member.role===role).map(member=><button key={member.ordinal} onClick={()=>browse('artists',member.name,member.id,role)} title={member.name}>{member.creditedName??member.name}</button>)}</div></React.Fragment>:null)}
    {(catalog?.mediumDiscNumber??item?.discNumber)&&<><span>碟／轨</span><b>{catalog?.mediumDiscNumber??item?.discNumber} / {catalog?.printedNumber??item?.trackNumber??'—'}</b></>}
    {item&&<><span>文件</span><b title={item.path}>{item.path.split(/[\\/]/).pop()}{item.kind==='cue'?' · CUE 音轨':''}</b></>}
</div></details>}
  </>;
}
