import {useEffect,type RefObject,type KeyboardEvent} from 'react';
export function useFocus(ref:RefObject<HTMLDivElement|null>):void{
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.querySelector<HTMLElement>('input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled)')?.focus();return()=>previous?.focus();},[]);
}
export function trap(event:KeyboardEvent,element:HTMLElement|null,onClose:()=>void,busy=false):void{
  if(event.key==='Escape'){event.stopPropagation();if(!busy)onClose();}
  if(event.key==='Tab'){
    const controls=[...(element?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary')??[])].filter(control=>control.getClientRects().length>0);
    if(!controls.length){event.preventDefault();return;}
    const first=controls[0],last=controls[controls.length-1];
    if(!element?.contains(document.activeElement)||document.activeElement===element){event.preventDefault();(event.shiftKey?last:first)?.focus();return;}
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }
}

