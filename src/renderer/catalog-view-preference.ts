import {useEffect,useRef,useState} from 'react';
import {defaultCatalogViewPreference,readCatalogViewPreference,type CatalogViewPreference} from '../shared/catalog-browse';
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export function useCatalogViewPreference(){
 const [preference,setPreference]=useState(defaultCatalogViewPreference),[status,setStatus]=useState<'ready'|'busy'|'unknown'>('unknown'),[message,setMessage]=useState('正在读取显示设置…');
 const alive=useRef(true),busy=useRef(false),confirmed=useRef(preference),attempt=useRef<{expected:CatalogViewPreference;value:CatalogViewPreference}|null>(null);
 const adopt=(value:CatalogViewPreference,text:string)=>{confirmed.current=value;if(alive.current){setPreference(value);setStatus('ready');setMessage(text);}attempt.current=null;};
 async function reload():Promise<void>{
  if(busy.current)return;busy.current=true;if(alive.current)setStatus('busy');
  try{const current=readCatalogViewPreference(await window.music.catalogViewPreference());adopt(current,attempt.current&&!same(current,attempt.current.value)?'上次选择未保存或已被更新，已显示当前设置。':'');}
  catch(e){if(alive.current){setStatus('unknown');setMessage(`显示设置未能确认，保留当前布局。${String(e instanceof Error?e.message:e).slice(0,160)}`);}}
  finally{busy.current=false;}
 }
 async function change(layout:CatalogViewPreference['layout'],density:CatalogViewPreference['density']):Promise<void>{
  if(busy.current||status!=='ready'||attempt.current)return;const before=confirmed.current;if(before.layout===layout&&before.density===density)return;
  if(before.revision>=Number.MAX_SAFE_INTEGER){setStatus('unknown');setMessage('显示设置修订达到上限');return;}
  const next:CatalogViewPreference={version:1,revision:before.revision+1,layout,density};attempt.current={expected:before,value:next};busy.current=true;setStatus('busy');setMessage('正在保存显示设置…');
  try{
   let current:CatalogViewPreference;
   try{current=readCatalogViewPreference(await window.music.saveCatalogViewPreference(attempt.current));}catch{current=readCatalogViewPreference(await window.music.catalogViewPreference());}
   adopt(current,same(current,next)?'':'显示设置未保存，已显示当前设置。');
  }catch(e){if(alive.current){setStatus('unknown');setMessage('保存结果尚未确认，保留原布局；请核对显示设置。');}}
  finally{busy.current=false;}
 }
 useEffect(()=>{alive.current=true;void reload();return()=>{alive.current=false;};},[]);
 return {preference,status,message,reload,change};
}
