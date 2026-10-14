import React from 'react';
import {createRoot} from 'react-dom/client';
import {CoverArtSourcePanel} from '../../src/renderer/cover-art-source-panel';
import '../../src/renderer/metadata.css';
const id='76df3287-6cda-33eb-8e9a-044b5e15ffdd';
const listeners=new Set<(event:unknown)=>void>(),calls:Array<{kind:string;value:unknown}>=[],pending=new Map<string,{request:any;resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();
let enabled=false,props:any,reviewFingerprint:string|null=null;
const root=createRoot(document.getElementById('root')!);
const emit=(event:unknown)=>listeners.forEach(listener=>listener(event));
(window as any).music={
 onlineArtwork:async(itemId:string)=>({itemId,revision:0,mode:'fallback',source:null,changes:[]}),
 providerRetention:async()=>({mode:'preview-only'}),
 metadataReviewState:async()=>({itemId:props.itemId,revision:0,fingerprint:reviewFingerprint??props.fingerprint}),
 providerEnabled:async()=>enabled,providers:async()=>[{manifest:{id:'cover-art-archive'},enabled}],onEvent:(listener:(event:unknown)=>void)=>{listeners.add(listener);return()=>listeners.delete(listener);},
 coverArtSourceIndex:(request:any)=>{calls.push({kind:'query',value:request});return new Promise((resolve,reject)=>pending.set(request.requestId,{request,resolve,reject}));},
 coverArtImagePreview:(request:any)=>{calls.push({kind:'image',value:request});return new Promise((resolve,reject)=>pending.set(request.requestId,{request,resolve,reject}));},
 releaseCoverArtImagePreview:async(url:string)=>{calls.push({kind:'release-image',value:url});await (window as any).__coverNative.release(url);},
 cancelMetadataMatch:async(requestId:string)=>{calls.push({kind:'cancel',value:requestId});},
 openMetadataSource:async(url:string)=>{calls.push({kind:'source',value:url});}
};
function mount(options:any={}):void{
 reviewFingerprint=null;
 props={itemId:'fixture-item',fingerprint:'a'.repeat(64),candidate:{token:'11111111-1111-1111-1111-111111111111',releaseId:id,title:'测试歌曲',album:'测试专辑发行版',expiresAt:new Date(Date.now()+600000).toISOString()},networkEnabled:true,onProviders:()=>calls.push({kind:'providers',value:true}),...options};
 root.render(<CoverArtSourcePanel key={props.candidate.token} {...props}/>);
}
(window as any).__cover={
 contextFingerprint:(value:string)=>{reviewFingerprint=value;},
 calls, mount,emit,
 async respondImage(requestId:string,overrides:any={}){
  const entry=pending.get(requestId);if(!entry)throw new Error('missing pending image request');pending.delete(requestId);
  // Keep mock expiry inside the production ten-minute bound across process clocks.
  const value={...(window as any).__coverImageData,itemId:entry.request.itemId,candidateToken:entry.request.token,fingerprint:entry.request.fingerprint,releaseId:id,imageId:entry.request.imageId,sourceUrl:`https://musicbrainz.org/release/${id}/cover-art`,fetchedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+599000).toISOString(),rights:{status:'unverified',display:true,cache:'session',persist:false,export:false},...overrides};
  const preview=await (window as any).__coverNative.register(value);(window as any).__cover.lastPreviewURL=preview.url;entry.resolve(preview);
 },
 enable(value:boolean){enabled=value;emit({event:'providersChanged',payload:{providerId:'cover-art-archive'}});},
 respond(requestId:string,overrides:any={}){const entry=pending.get(requestId);if(!entry)throw new Error('missing pending request');pending.delete(requestId);entry.resolve({...entry.request,provider:'cover-art-archive',releaseId:id,sourceUrl:`https://musicbrainz.org/release/${id}/cover-art`,availability:'found',fetchedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),cacheHit:false,indexRights:{display:true,cache:'memory',persist:false},imageRights:{status:'unverified',display:false,cache:false,export:false},entries:[{imageId:'829521842',front:true,back:false,editorialApproved:true,types:['Front'],comment:'<script>window.unexpected=true</script>'},{imageId:'829521843',front:false,back:true,editorialApproved:false,types:['Back'],comment:''}],...overrides});},
 reject(requestId:string){const entry=pending.get(requestId);if(entry){pending.delete(requestId);entry.reject(new Error('模拟网络错误'));}}
};
mount();
