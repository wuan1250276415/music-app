import type {DatabaseSync} from 'node:sqlite';
import type {ArtistCreditMember} from '../shared/contracts.js';

export const creditNameSchema=`ALTER TABLE artist_credit_member ADD COLUMN credited_name TEXT CHECK(credited_name IS NULL OR length(credited_name) BETWEEN 1 AND 240);`;
const schemaCache=new WeakMap<DatabaseSync,{version:number;available:boolean}>();
export function hasCreditNames(db:DatabaseSync):boolean{
  const version=(db.prepare('PRAGMA schema_version').get() as {schema_version:number}).schema_version,prior=schemaCache.get(db);if(prior?.version===version)return prior.available;
  const available=(db.prepare('PRAGMA table_info(artist_credit_member)').all() as unknown as Array<{name:string}>).some(row=>row.name==='credited_name');schemaCache.set(db,{version,available});return available;
}
export function normalizedCreditName(value:unknown):string|null{if(value===undefined||value===null||value==='')return null;if(typeof value!=='string'||!value.trim()||value.length>240||/[\u0000-\u001f\u007f]/.test(value))throw new Error('当次署名名称需为有效的 1–240 个字符');return value.trim();}
export function insertCreditMember(db:DatabaseSync,creditId:string,ordinal:number,member:{artistId:string;role:string;joinPhrase:string;creditedName?:string|null}):void{
 const named=hasCreditNames(db);db.prepare(`INSERT INTO artist_credit_member(credit_id,ordinal,artist_id,role,join_phrase${named?',credited_name':''}) VALUES(?,?,?,?,?${named?',?':''})`).run(creditId,ordinal,member.artistId,member.role,member.joinPhrase,...(named?[member.creditedName??null]:[]));
}

// Identity names and source revisions are read together, including empty-release credits.
export function readCredit(db:DatabaseSync,creditId:string|null):ArtistCreditMember[]{
  if(!creditId)return [];
  return (db.prepare(`SELECT a.id,a.name,c.artist_id sourceArtistId,c.role,c.ordinal,c.join_phrase joinPhrase,${hasCreditNames(db)?'c.credited_name':'NULL'} creditedName,
    COALESCE(s.revision,0) artistRevision,a.disambiguation,a.sort_name sortName
    FROM artist_credit_member c LEFT JOIN artist_identity_binding b ON b.source_artist_id=c.artist_id
    JOIN artist a ON a.id=COALESCE(b.identity_artist_id,c.artist_id)
    LEFT JOIN artist_identity_state s ON s.artist_id=c.artist_id WHERE c.credit_id=? ORDER BY c.ordinal`).all(creditId) as unknown as ArtistCreditMember[]).map(({creditedName,...member})=>({...member,...(creditedName!=null?{creditedName}:{})}));
}
