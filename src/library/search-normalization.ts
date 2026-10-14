import {Converter} from 'opencc-js/t2cn';

export const SEARCH_NORMALIZATION_ALGORITHM='opencc-js-1.4.2:t2s:nfkc:derived-v1';
const traditionalToSimplified=Converter({from:'t',to:'cn'});
export const literalSearchText=(value:string)=>value.normalize('NFKC').toLowerCase().trim();
export function canonicalSearchText(value:string):string{
 const text=literalSearchText(value);
 return /\p{Script=Han}/u.test(text)?traditionalToSimplified(text):text;
}
export function literalSearchVariants(value:string):string[]{
 const original=literalSearchText(value),canonical=canonicalSearchText(original);
 return original===canonical?[original]:[original,canonical];
}
export function shortHanSearchGrams(value:string):Set<string>{
 const out=new Set<string>();
 for(const variant of literalSearchVariants(value))for(const word of variant.split(/[\s\p{P}\p{S}]+/u)){
  const chars=[...word];for(let i=0;i<chars.length;i++){
   if(/\p{Script=Han}/u.test(chars[i]))out.add(chars[i]);
   if(i+1<chars.length&&/\p{Script=Han}/u.test(chars[i]+chars[i+1]))out.add(chars[i]+chars[i+1]);
  }
 }
 return out;
}
