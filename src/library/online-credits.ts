import {createHash,randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {MetadataCreditMember,MetadataProviderCredit} from '../shared/contracts.js';
import {recordProviderArtist} from './metadata-provenance.js';
const mbid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export function providerArtistIdentity(db:DatabaseSync,externalId:string):Omit<MetadataCreditMember,keyof MetadataProviderCredit>{
 if(typeof externalId!=='string'||!mbid.test(externalId))throw new Error('无效 MusicBrainz 艺人身份');
 const mappings=db.prepare(`SELECT entity_id FROM external_ref WHERE entity_kind='artist' AND provider='musicbrainz' AND lower(external_id)=? LIMIT 2`).all(externalId) as unknown as Array<{entity_id:string}>;
 if(mappings.length>1)throw new Error('同一 MusicBrainz 艺人有多个本地归属，请先整理外部引用');
 const artist=mappings[0]?db.prepare(`SELECT a.*,COALESCE(s.revision,0) identity_revision FROM artist a LEFT JOIN artist_identity_state s ON s.artist_id=a.id WHERE a.id=?`).get(mappings[0].entity_id) as {id:string;name:string;archived:number;local_key:string|null}|undefined:undefined;
 if(mappings.length&&!artist)throw new Error('艺人外部引用归属已损坏');
 const fingerprint=createHash('sha256').update(JSON.stringify([externalId,mappings,artist??null])).digest('hex');
 return {localArtistId:artist?.id??null,localName:artist?.name??null,identityFingerprint:fingerprint,archived:artist?.archived===1};
}
export function importProviderArtist(db:DatabaseSync,member:MetadataProviderCredit,recordedAt:string):{artistId:string;created:boolean}{
 const identity=providerArtistIdentity(db,member.externalId);if(identity.archived)throw new Error('候选艺人已在本地归档，请先恢复其身份');if(identity.localArtistId)return {artistId:identity.localArtistId,created:false};
 if(!member.name||member.name.length>240||!Number.isFinite(Date.parse(recordedAt)))throw new Error('艺人来源数据无效');
 const artistId=randomUUID(),url=`https://musicbrainz.org/artist/${member.externalId}`;
 db.prepare('INSERT INTO artist(id,name,sort_name,normalized_name,disambiguation,local_key) VALUES(?,?,?,?,?,NULL)').run(artistId,member.name,member.sortName||null,member.name.normalize('NFKC').toLowerCase().trim(),member.disambiguation||'');
 db.prepare('INSERT INTO artist_identity_state(artist_id,revision) VALUES(?,1)').run(artistId);
 db.prepare("INSERT INTO external_ref(entity_kind,entity_id,provider,external_id,url) VALUES('artist',?,'musicbrainz',?,?)").run(artistId,member.externalId,url);
 recordProviderArtist(db,artistId,{name:member.name,...(member.sortName?{sortName:member.sortName}:{}),...(member.disambiguation?{disambiguation:member.disambiguation}:{})},url,recordedAt);
 return {artistId,created:true};
}
