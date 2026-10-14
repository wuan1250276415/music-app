export const ZOOM_PERCENTAGES=[75,80,90,100,110,125,150,175,200] as const;
export type AppearanceTheme='system'|'light'|'dark';
export interface AppearancePreference {version:1;revision:number;theme:AppearanceTheme;zoomPercent:number}
export interface AppearanceRequest {commandId:string;baseRevision:number;theme:AppearanceTheme;zoomPercent:number}
export interface AppearanceState {version:1;revision:number;preference:AppearancePreference;effectiveTheme:'light'|'dark';forcedColors:boolean;actualZoomPercent:number;displayScaleFactor:number;status:'ready'|'saving'|'unknown';message:string;applyError:string}
export interface AppearanceResult {status:'saved'|'rejected'|'unknown';state:AppearanceState;error:string}
export const defaultAppearancePreference=():AppearancePreference=>({version:1,revision:0,theme:'system',zoomPercent:100});
export function readAppearancePreference(value:unknown):AppearancePreference{
 const p=value as AppearancePreference;
 if(!p||typeof p!=='object'||Object.keys(p).length!==4||p.version!==1||!Number.isSafeInteger(p.revision)||p.revision<0||!['system','light','dark'].includes(p.theme)||!ZOOM_PERCENTAGES.includes(p.zoomPercent as typeof ZOOM_PERCENTAGES[number]))throw new Error('外观设置无效');
 return {version:1,revision:p.revision,theme:p.theme,zoomPercent:p.zoomPercent};
}
export function readAppearanceRequest(value:unknown):AppearanceRequest{
 const r=value as AppearanceRequest;
 if(!r||typeof r!=='object'||Object.keys(r).length!==4||typeof r.commandId!=='string'||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(r.commandId))throw new Error('外观操作无效');
 const p=readAppearancePreference({version:1,revision:r.baseRevision,theme:r.theme,zoomPercent:r.zoomPercent});
 return {commandId:r.commandId,baseRevision:p.revision,theme:p.theme,zoomPercent:p.zoomPercent};
}
