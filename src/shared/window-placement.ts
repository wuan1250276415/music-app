export type WindowRect={x:number;y:number;width:number;height:number};
export type WindowPlacement={bounds:WindowRect;maximized:boolean;display:{id:string;label:string;workArea:WindowRect;scaleFactor:number}};
export type WindowPlacementPreference={version:1;revision:number;enabled:boolean;placement:WindowPlacement|null};
export const defaultWindowPlacementPreference=():WindowPlacementPreference=>({version:1,revision:0,enabled:true,placement:null});
function object(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))throw new Error('窗口位置字段无效');
 return value as Record<string,unknown>;
}
function integer(value:unknown,min:number,max:number):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error('窗口位置数值无效');return value;}
function rect(value:unknown):WindowRect{const r=object(value,['x','y','width','height']);return {x:integer(r.x,-1_000_000,1_000_000),y:integer(r.y,-1_000_000,1_000_000),width:integer(r.width,1,65536),height:integer(r.height,1,65536)};}
function text(value:unknown,max:number):string{if(typeof value!=='string'||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error('显示器标识无效');return value;}
export function readWindowPlacementPreference(value:unknown):WindowPlacementPreference{
 const r=object(value,['version','revision','enabled','placement']);if(r.version!==1||typeof r.enabled!=='boolean')throw new Error('窗口位置版本无效');
 let placement:WindowPlacement|null=null;
 if(r.placement!==null){const p=object(r.placement,['bounds','maximized','display']),d=object(p.display,['id','label','workArea','scaleFactor']);
  if(typeof p.maximized!=='boolean'||typeof d.scaleFactor!=='number'||!Number.isFinite(d.scaleFactor)||d.scaleFactor<=0||d.scaleFactor>16)throw new Error('窗口状态无效');
  placement={bounds:rect(p.bounds),maximized:p.maximized,display:{id:text(d.id,64),label:text(d.label,160),workArea:rect(d.workArea),scaleFactor:d.scaleFactor}};
 }
 return {version:1,revision:integer(r.revision,0,Number.MAX_SAFE_INTEGER),enabled:r.enabled,placement};
}
