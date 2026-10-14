export type SearchIndexState={version:1;algorithm:string;revision:number;status:'building'|'ready'|'error';processed:number;message:string};
export function readSearchIndexState(value:unknown):SearchIndexState{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('检索索引回执无效');
 const r=value as Record<string,unknown>;
 if(r.version!==1||typeof r.algorithm!=='string'||r.algorithm.length>128||typeof r.revision!=='number'||!Number.isSafeInteger(r.revision)||r.revision<0||typeof r.status!=='string'||!['building','ready','error'].includes(r.status)||typeof r.processed!=='number'||!Number.isSafeInteger(r.processed)||r.processed<0||typeof r.message!=='string'||r.message.length>512)throw new Error('检索索引状态无效');
 return {version:1,algorithm:r.algorithm,revision:r.revision,status:r.status as SearchIndexState['status'],processed:r.processed,message:r.message};
}
