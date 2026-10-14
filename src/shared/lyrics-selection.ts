import type {LyricsDocument,LyricsPreference} from './contracts.js';

// Stable ordering: explicit source identities first; newly observed sources keep their default order.
export function orderedLyricsSources(sources:LyricsDocument[],preference:LyricsPreference):LyricsDocument[]{
 const ranks=new Map((preference.sourceOrder??[]).map((id,index)=>[id,index]));
 return sources.map((source,index)=>({source,index})).sort((a,b)=>(ranks.get(a.source.id??'')??Number.MAX_SAFE_INTEGER)-(ranks.get(b.source.id??'')??Number.MAX_SAFE_INTEGER)||a.index-b.index).map(value=>value.source);
}
export function effectiveLyricsSelection(sources:LyricsDocument[],preference:LyricsPreference):{primaryId:string|null;secondaryId:string|null}{
 const ordered=orderedLyricsSources(sources,preference),primaryId=ordered.find(source=>source.id===preference.primaryId)?.id??ordered[0]?.id??null;
 const secondaryId=preference.showSecondary&&preference.secondaryId!==primaryId?ordered.find(source=>source.id===preference.secondaryId)?.id??null:null;
 return {primaryId,secondaryId};
}
