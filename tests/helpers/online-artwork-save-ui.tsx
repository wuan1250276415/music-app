import React from 'react';
import {createRoot} from 'react-dom/client';
import {OnlineArtworkControls} from '../../src/renderer/online-artwork-controls';
const native=(window as any).__saveNative,listeners=new Set<(event:any)=>void>();
(window as any).music={onlineArtwork:native.state,providerRetention:native.retention,onlineArtworkCommand:native.command,openMetadataSource:async()=>{},onEvent:(listener:any)=>{listeners.add(listener);return()=>listeners.delete(listener);}};
const root=createRoot(document.getElementById('root')!);let preview:any=null,itemId='';
function render(){root.render(<OnlineArtworkControls itemId={itemId} preview={preview} onSaved={()=>{preview=null;render();}}/>);}
(window as any).__save={async preview(){const value=await native.preview();itemId=value.itemId;preview=value;render();},enable:native.enable,inspect:native.inspect};
void (window as any).__save.preview();
