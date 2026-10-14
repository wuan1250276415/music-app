export const LIBRARY_SORT_MODES=['default','title','artist','album','date','added'] as const;
export type LibrarySort={mode:typeof LIBRARY_SORT_MODES[number];direction:'asc'|'desc'};
export function readLibrarySort(value:unknown):LibrarySort{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||Object.keys(value).some(k=>!['mode','direction'].includes(k)))throw new Error('无效曲库排序字段');
 const v=value as Record<string,unknown>;
 if(typeof v.mode!=='string'||!LIBRARY_SORT_MODES.includes(v.mode as LibrarySort['mode'])||typeof v.direction!=='string'||!['asc','desc'].includes(v.direction)||v.mode==='default'&&v.direction!=='asc')throw new Error('无效曲库排序方式');
 return {mode:v.mode as LibrarySort['mode'],direction:v.direction as LibrarySort['direction']};
}
