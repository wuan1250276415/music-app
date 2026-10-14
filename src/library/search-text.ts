import {SORT_ALGORITHM} from './natural-sort.js';
import {pinyin} from 'pinyin-pro';
import {SPELLING_ALGORITHM} from './search-spelling.js';
import {SEARCH_NORMALIZATION_ALGORITHM} from './search-normalization.js';
import {createHash} from 'node:crypto';
export const SEARCH_ALGORITHM_SPEC=`pinyin-pro-3.29.4:nfkc:phrase256:artist-surname:v3:${SEARCH_NORMALIZATION_ALGORITHM}:${SPELLING_ALGORITHM}:${SORT_ALGORITHM}`;
// The state contract remains bounded; the digest covers every dictionary/algorithm version.
export const SEARCH_ALGORITHM=`aural-search-v3:${createHash('sha256').update(SEARCH_ALGORITHM_SPEC).digest('hex')}`;
export const normalizeSearch=(value:string)=>value.normalize('NFKC').toLowerCase().trim();
const latin=(value:string)=>value.replace(/ü/g,'v').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase();
export function latinSearchQuery(value:string):string|null{
 const normalized=normalizeSearch(value);
 if(!normalized||normalized.length>256||!/[a-zü]/.test(normalized)||!/^[a-zü\d\s'’\-]+$/.test(normalized))return null;
 return latin(normalized).replace(/[\s'’\-]/g,'')||null;
}
export type RomanText={full:string;initials:string};
// No tag rewriting or all-polyphone Cartesian expansion. Phrase context is bounded, output is complete.
export function romanText(value:string,surname=false):RomanText{
 const text=normalizeSearch(value);if(!/\p{Script=Han}/u.test(text))return {full:'',initials:''};
 const full:string[]=[],initials:string[]=[];
 for(const part of text.split(/(\p{Script=Han}+)/u)){
  if(!part)continue;
  if(/^\p{Script=Han}+$/u.test(part)){
   const chars=Array.from(part);
   for(let start=0;start<chars.length;start+=256){
    const syllables=pinyin(chars.slice(start,start+256).join(''),{toneType:'none',type:'array',...(surname&&start===0?{mode:'surname' as const,surname:'head' as const}:{})});
    for(const syllable of syllables){const word=latin(syllable);full.push(word);initials.push(Array.from(word)[0]??'');}
   }
  }else{const words=latin(part).match(/[a-z\d]+/g)??[];full.push(...words);initials.push(...words.map(word=>/^\d+$/.test(word)?word:word[0]));}
 }
 return {full:full.join(''),initials:initials.join('')};
}
// Bound both entry count and bytes; oversized fields are converted but never retained in this cache.
export class RomanTextCache{
 private readonly values=new Map<string,{value:RomanText;bytes:number}>();private bytes=0;
 get(text:string,surname=false):RomanText{
  const key=`${surname?'s':'n'}:${text}`,old=this.values.get(key);if(old){this.values.delete(key);this.values.set(key,old);return old.value;}
  const value=romanText(text,surname),bytes=2*(key.length+value.full.length+value.initials.length);
  if(bytes<=8*1024*1024){this.values.set(key,{value,bytes});this.bytes+=bytes;while(this.values.size>256||this.bytes>8*1024*1024){const first=this.values.keys().next().value!;this.bytes-=this.values.get(first)!.bytes;this.values.delete(first);}}
  return value;
 }
 matches(value:unknown,query:unknown,surnames=false):number{
  if(typeof value!=='string'||typeof query!=='string')return 0;
  const text=normalizeSearch(value),q=normalizeSearch(query);if(text.includes(q))return 1;
  const roman=latinSearchQuery(q);if(!roman)return 0;
  const normal=this.get(text);if(normal.full.includes(roman)||normal.initials.includes(roman))return 1;
  if(!surnames)return 0;
  const surname=this.get(text,true);return surname.full.includes(roman)||surname.initials.includes(roman)?1:0;
 }
}
