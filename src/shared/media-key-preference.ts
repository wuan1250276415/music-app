export interface MediaKeyPreference {version:1;revision:number;enabled:boolean}
export const defaultMediaKeyPreference=():MediaKeyPreference=>({version:1,revision:0,enabled:false});
export function readMediaKeyPreference(value:unknown):MediaKeyPreference{
 const p=value as MediaKeyPreference;
 if(!p||typeof p!=='object'||Object.keys(p).length!==3||p.version!==1||!Number.isSafeInteger(p.revision)||p.revision<0||typeof p.enabled!=='boolean')throw new Error('媒体快捷键设置无效');
 return {version:1,revision:p.revision,enabled:p.enabled};
}
