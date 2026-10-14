import {useEffect,useState} from 'react';
// Bounded backing stores: DPR and page zoom are applied once; image assets are never recolored.
export function drawingDimensions(rect:DOMRect,ratio:number):{width:number;height:number;scale:number}{
 const w=Math.max(1,rect.width),h=Math.max(1,rect.height),d=Number.isFinite(ratio)&&ratio>0?ratio:1;
 const scale=Math.min(d,4,4096/w,1024/h,Math.sqrt(2*1024*1024/(w*h)));
 return {width:Math.max(1,Math.floor(w*scale)),height:Math.max(1,Math.floor(h*scale)),scale};
}
export function drawingColors():{background:string;grid:string;primary:string;secondary:string;position:string}{
 const css=getComputedStyle(document.documentElement),read=(name:string)=>css.getPropertyValue(`--aural-chart-${name}`).trim();
 return {background:read('background'),grid:read('grid'),primary:read('primary'),secondary:read('secondary'),position:read('position')};
}
export function useDrawingEnvironment():number{
 const [revision,setRevision]=useState(0);
 useEffect(()=>{
  let resolution:MediaQueryList|null=null;const changed=()=>setRevision(value=>value+1);
  const dpi=()=>{resolution?.removeEventListener('change',dpi);resolution=window.matchMedia(`(resolution: ${window.devicePixelRatio||1}dppx)`);resolution.addEventListener('change',dpi);changed();};
  const theme=window.matchMedia('(prefers-color-scheme: light)'),forced=window.matchMedia('(forced-colors: active)');theme.addEventListener('change',changed);forced.addEventListener('change',changed);window.addEventListener('resize',changed);dpi();
  return()=>{resolution?.removeEventListener('change',dpi);theme.removeEventListener('change',changed);forced.removeEventListener('change',changed);window.removeEventListener('resize',changed);};
 },[]);return revision;
}
