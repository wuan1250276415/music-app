import {sqlStatement} from './sql-statements.js';
import type {DatabaseSync} from 'node:sqlite';
import {canonicalSearchText,literalSearchText} from './search-normalization.js';

export const SPELLING_ALGORITHM='latin-nfkd-word-bigram-trigram-osa2:v1';
export const spellingSchema=`
 CREATE TABLE search_word(word TEXT PRIMARY KEY CHECK(length(word) BETWEEN 2 AND 64)) WITHOUT ROWID;
 CREATE TABLE search_word_gram(gram TEXT NOT NULL,word TEXT NOT NULL REFERENCES search_word(word) ON DELETE CASCADE,PRIMARY KEY(gram,word)) WITHOUT ROWID;
 CREATE TABLE search_item_word(item_id TEXT NOT NULL REFERENCES playable_item(id) ON DELETE CASCADE,word TEXT NOT NULL REFERENCES search_word(word) ON DELETE RESTRICT,field INTEGER NOT NULL CHECK(field BETWEEN 0 AND 3),PRIMARY KEY(item_id,word,field)) WITHOUT ROWID;
 CREATE INDEX search_item_word_lookup ON search_item_word(word,item_id,field);
 CREATE TRIGGER search_item_word_orphan AFTER DELETE ON search_item_word BEGIN DELETE FROM search_word WHERE word=OLD.word AND NOT EXISTS(SELECT 1 FROM search_item_word WHERE word=OLD.word); END;
`;
const fold=(text:string)=>text.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();
const words=(text:string)=>fold(text).matchAll(/[a-z]+/g);
function grams(word:string,n:number):string[]{const value=`^${word}$`,set=new Set<string>();for(let i=0;i+n<=value.length;i++)set.add(`${n}:${value.slice(i,i+n)}`);return [...set];}
export function spellingQuery(text:string):string[]|null{
 if(!text||text.length>256||!/^[\p{Script=Latin}\p{M}\s'’\-]+$/u.test(text))return null;
 const tokens=[...new Set([...words(text)].map(match=>match[0]))];
 if(!tokens.length||tokens.length>4||tokens.some(word=>word.length<2||word.length>64)||!tokens.some(word=>word.length>=4))return null;
 return tokens;
}
// Restricted Damerau-Levenshtein (adjacent transposition), <=2 edits. Both sides <=64.
export function spellingDistance(a:string,b:string,max:number):number{
 if(!/^[a-z]{2,64}$/.test(a)||!/^[a-z]{2,64}$/.test(b)||!Number.isInteger(max)||max<0||max>2)throw new Error('英文编辑距离输入超过有界词预算');
 if(Math.abs(a.length-b.length)>max)return max+1;
 let older:number[]=[],previous=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){
  const current=[i];for(let j=1;j<=b.length;j++){
   let cost=Math.min(previous[j]+1,current[j-1]+1,previous[j-1]+(a[i-1]===b[j-1]?0:1));
   if(i>1&&j>1&&a[i-1]===b[j-2]&&a[i-2]===b[j-1])cost=Math.min(cost,older[j-2]+1);
   current[j]=cost;
  }older=previous;previous=current;
 }return previous[b.length];
}
export function updateSpellingIndex(db:DatabaseSync,id:string,fields:string[]):void{
 const old=sqlStatement(db,'SELECT DISTINCT word FROM search_item_word WHERE item_id=?').all(id) as Array<{word:string}>;
 sqlStatement(db,'DELETE FROM search_item_word WHERE item_id=?').run(id);
 const insertWord=sqlStatement(db,'INSERT OR IGNORE INTO search_word(word) VALUES(?)'),insertGram=sqlStatement(db,'INSERT OR IGNORE INTO search_word_gram(gram,word) VALUES(?,?)'),insertItem=sqlStatement(db,'INSERT INTO search_item_word(item_id,word,field) VALUES(?,?,?)');
 fields.slice(0,4).forEach((field,index)=>{
  const seen=new Set<string>();
  // Fuzzy extraction alone is bounded; existing literal/pinyin paths retain full text.
  const extracted=field.length>4096?fold(field.slice(0,4096)).replace(/[a-z]+$/,''):field;
  for(const match of words(extracted)){const word=match[0];if(word.length<2||word.length>64||seen.has(word))continue;seen.add(word);if(seen.size>64)break;
   const created=insertWord.run(word).changes;if(created)for(const gram of [...grams(word,2),...grams(word,3)])insertGram.run(gram,word);insertItem.run(id,word,index);
  }
 });
 const remove=sqlStatement(db,'DELETE FROM search_word WHERE word=? AND NOT EXISTS(SELECT 1 FROM search_item_word WHERE word=?)');for(const {word} of old)remove.run(word,word);
}
export function deleteSpellingIndex(db:DatabaseSync,id:string):void{
 const old=sqlStatement(db,'SELECT DISTINCT word FROM search_item_word WHERE item_id=?').all(id) as Array<{word:string}>;
 sqlStatement(db,'DELETE FROM search_item_word WHERE item_id=?').run(id);
 const remove=sqlStatement(db,'DELETE FROM search_word WHERE word=? AND NOT EXISTS(SELECT 1 FROM search_item_word WHERE word=?)');for(const {word} of old)remove.run(word,word);
}
export type SpellingHit={id:string;distance:number};
// The caller supplies its existing trusted SQL filters and bound values, never Renderer SQL.
export function recallSpelling(db:DatabaseSync,text:string,filteredFrom:string,filters:Array<string|number>):SpellingHit[]{
 const tokens=spellingQuery(text);if(!tokens)return [];
 const matches:Array<{word:string;token:number;distance:number}>=[],limit=Math.floor(300/tokens.length);
 tokens.forEach((query,token)=>{
  const max=query.length<4?0:query.length<8?1:2,n=query.length<7?2:3,queryGrams=grams(query,n),overlap=Math.max(1,queryGrams.length-(n+1)*max);
  const rows=sqlStatement(db,`SELECT g.word,COUNT(*) shared FROM search_word_gram g WHERE g.gram IN(${queryGrams.map(()=>'?').join(',')}) AND length(g.word) BETWEEN ? AND ? GROUP BY g.word HAVING COUNT(*)>=? ORDER BY shared DESC,g.word LIMIT ?`).all(...queryGrams,query.length-max,query.length+max,overlap,limit) as Array<{word:string}>;
  for(const {word} of rows){const distance=spellingDistance(query,word,max);if(distance<=max)matches.push({word,token,distance});}
 });
 if(!matches.length||new Set(matches.map(match=>match.token)).size!==tokens.length)return [];
 const values=matches.map(()=>'(?,?,?)').join(','),bindings=matches.flatMap(match=>[match.word,match.token,match.distance]);
 const from=filteredFrom.replace(' WHERE ', ' JOIN spelling_scores ss ON ss.item_id=p.id WHERE ');
 if(from===filteredFrom)throw new Error('错拼检索缺少受控过滤计划');
 return sqlStatement(db,`WITH spelling_terms(word,token,distance) AS(VALUES ${values}),spelling_hits AS(
  SELECT iw.item_id,t.token,MIN(t.distance) distance,MIN(iw.field) field FROM search_item_word iw JOIN spelling_terms t ON t.word=iw.word GROUP BY iw.item_id,t.token
 ),spelling_scores AS(SELECT item_id,SUM(distance) distance,MIN(field) field FROM spelling_hits GROUP BY item_id HAVING COUNT(*)=?)
 SELECT DISTINCT p.id,ss.distance,ss.field ${from} ORDER BY ss.distance,ss.field,p.id LIMIT 300`).all(...bindings,tokens.length,...filters) as SpellingHit[];
}
type RankNormalization={query:string;canonicalQuery:()=>string;canonical:(value:string)=>string};
function rankWithNormalization(values:unknown[],context:RankNormalization):number{
 const q=context.query,fields=values.map(value=>typeof value==='string'?literalSearchText(value):'');
 const rank=(text:string[],needle:string)=>text[0]===needle?0:text[1]===needle?1:text.some(field=>field.startsWith(needle))?2:text.some(field=>field.includes(needle))?3:5;
 const original=rank(fields,q);if(original===0)return 0;
 if(fields.length<2){const normalized=rank(fields.map(context.canonical),context.canonicalQuery());return normalized<original?normalized+0.25:original;}
 const canonicalQuery=context.canonicalQuery(),title=context.canonical(fields[0]);
 if(title===canonicalQuery)return 0.25;
 if(original===1)return 1;
 const artist=context.canonical(fields[1]);
 if(artist===canonicalQuery)return 1.25;
 // A literal prefix can only improve via title/artist exact equivalence.
 // Album/genre conversion cannot beat that tier, so avoid doing it per hit.
 if(original===2)return 2;
 const normalized=rank([title,artist,...fields.slice(2).map(context.canonical)],canonicalQuery);
 // Preserve each exact/prefix/substring tier; equivalent spelling follows its literal tier.
 return normalized<original?normalized+0.25:original;
}
export function directSearchRank(values:unknown[],query:unknown):number{
 if(typeof query!=='string')return 5;const q=literalSearchText(query);
 return rankWithNormalization(values,{query:q,canonicalQuery:()=>canonicalSearchText(q),canonical:canonicalSearchText});
}
// Pagination repeatedly ranks the same candidate titles as well as artists.
// One connection owns a bounded cache of text conversion, never result ranks.
// Keys contain the actual normalized text, so edits cannot reuse stale values.
export function createDirectSearchRanker():(values:unknown[],query:unknown)=>number{
 let previous:string|null=null,context:RankNormalization|null=null,bytes=0,admittedEntries=0,admittedBytes=0;
 const texts=new Map<string,string>(),maxBytes=4*1024*1024,maxEntries=16384;
 const canonical=(value:string)=>{
  const old=texts.get(value);if(old!==undefined)return old;
  const converted=canonicalSearchText(value),cost=2*(value.length+converted.length);
  // A broad query can touch more unique text than this cache holds. Admit at
  // most one cache's worth for that query, then keep using exact conversions
  // without churning retained strings on every subsequent page or refresh.
  if(cost<=maxBytes&&admittedEntries<maxEntries&&admittedBytes+cost<=maxBytes){while(texts.size>=maxEntries||bytes+cost>maxBytes){const first=texts.keys().next().value;if(first===undefined)break;bytes-=2*(first.length+texts.get(first)!.length);texts.delete(first);}texts.set(value,converted);bytes+=cost;admittedEntries++;admittedBytes+=cost;}
  return converted;
 };
 return (values,query)=>{
  if(typeof query!=='string')return 5;
  if(query.length>256)return directSearchRank(values,query);
  if(query!==previous||!context){const q=literalSearchText(query);let converted:string|undefined;context={query:q,canonicalQuery:()=>converted??=canonicalSearchText(q),canonical};previous=query;admittedEntries=0;admittedBytes=0;}
  return rankWithNormalization(values,context);
 };
}
