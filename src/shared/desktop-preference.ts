export interface DesktopPreference {version:1;revision:number;closeBehavior:'ask'|'tray'|'quit'}
export const defaultDesktopPreference=():DesktopPreference=>({version:1,revision:0,closeBehavior:'ask'});
export function readDesktopPreference(value:unknown):DesktopPreference{
 const p=value as DesktopPreference;
 if(!p||typeof p!=='object'||Object.keys(p).length!==3||p.version!==1||!Number.isSafeInteger(p.revision)||p.revision<0||!['ask','tray','quit'].includes(p.closeBehavior))throw new Error('窗口关闭设置无效');
 return {version:1,revision:p.revision,closeBehavior:p.closeBehavior};
}
