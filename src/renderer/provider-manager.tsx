import React,{useEffect,useRef,useState} from 'react';
import type {ProviderId,ProviderState,ProviderSettingRequest,ProviderCredentialRequest} from '../shared/contracts';
import {trap,useFocus} from './dialog-focus';
import './providers.css';
import {ProviderRetentionDialog} from './provider-retention-dialog';

type CredentialAttempt=Omit<ProviderCredentialRequest,'secret'>;
const key=(provider:ProviderId,slot:string)=>`${provider}:${slot}`;
export function ProviderManagerDialog({onClose}:{onClose:()=>void}):React.JSX.Element{
 const dialog=useRef<HTMLDivElement|null>(null),alive=useRef(true),generation=useRef(0),acting=useRef(false);
 const settingAttempt=useRef<ProviderSettingRequest|null>(null),credentialAttempt=useRef<CredentialAttempt|null>(null);useFocus(dialog);
 const [retentionTarget,setRetentionTarget]=useState<{id:ProviderId;name:string}|null>(null);
 const [states,setStates]=useState<ProviderState[]>([]),[drafts,setDrafts]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[reload,setReload]=useState(0),[error,setError]=useState(''),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false),[settingUncertain,setSettingUncertain]=useState(false);
 useEffect(()=>{
  alive.current=true;
  const unsubscribe=window.music.onEvent(event=>{if(event.event==='providersChanged')setReload(value=>value+1);});
  return()=>{alive.current=false;generation.current++;unsubscribe();credentialAttempt.current=null;settingAttempt.current=null;};
 },[]);
 useEffect(()=>{
  const current=++generation.current;setLoading(true);
  void window.music.providers().then(values=>{if(alive.current&&generation.current===current){setStates(values);setLoading(false);}}).catch(e=>{if(alive.current&&generation.current===current){setError(e instanceof Error?e.message:String(e));setLoading(false);}});
 },[reload]);
 function begin():boolean{if(acting.current)return false;acting.current=true;setBusy(true);setError('');setNotice('');return true;}
 function finish():void{acting.current=false;if(alive.current){setBusy(false);setReload(value=>value+1);}}
 async function configure(state:ProviderState,retry=false):Promise<void>{
  if(!begin())return;
  const request=retry?settingAttempt.current:{commandId:crypto.randomUUID(),providerId:state.manifest.id,revision:state.revision,enabled:!state.enabled};
  if(!request){finish();return;}settingAttempt.current=request;
  try{await window.music.configureProvider(request);if(alive.current){setSettingUncertain(false);settingAttempt.current=null;setNotice('数据源设置已保存。');}}
  catch(e){if(alive.current){setSettingUncertain(true);setError(e instanceof Error?e.message:String(e));}}
  finally{finish();}
 }
 async function credential(provider:ProviderId,slot:string,operation:'set'|'remove',fresh=false):Promise<void>{
  if(!begin())return;
  const prior=credentialAttempt.current;
  const attempt:CredentialAttempt=!fresh&&prior?.providerId===provider&&prior.slot===slot&&prior.operation===operation?prior:{commandId:crypto.randomUUID(),providerId:provider,slot,operation};
  credentialAttempt.current=attempt;
  const request:ProviderCredentialRequest={...attempt,...(operation==='set'?{secret:drafts[key(provider,slot)]??''}:{})};
  try{
   const result=await window.music.providerCredential(request);
   if(!alive.current)return;
   setUncertain(result.state==='unknown');setNotice(result.replayed?'这是此前已确认的操作，当前凭据状态见刷新结果。':result.message??(operation==='set'?'密钥已由系统保存，当前状态已核对。':'密钥已移除，当前状态已核对。'));
   if(result.state==='succeeded'){credentialAttempt.current=null;setDrafts(values=>({...values,[key(provider,slot)]:''}));}
  }catch(e){if(alive.current){setUncertain(true);setError(e instanceof Error?e.message:String(e));}}
  finally{request.secret=undefined;finish();}
 }
 async function terms(id:ProviderId):Promise<void>{try{await window.music.openProviderTerms(id);}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}}
 return <><div className="collection-backdrop"><div className="collection-dialog catalog-dialog provider-dialog" role="dialog" aria-modal={!retentionTarget} aria-hidden={Boolean(retentionTarget)} inert={Boolean(retentionTarget)} aria-label="数据源设置" ref={dialog} onKeyDown={event=>trap(event,dialog.current,onClose,busy)}>
  <header><h2>数据源设置</h2><button aria-label="关闭数据源设置" disabled={busy} onClick={onClose}>×</button></header>
  <p className="collection-note">在线查询由您主动发起。当前元数据查询发送曲名、歌手及所选来源的录音／发行编号，不发送文件路径或完整音频。指纹识别只发送指纹和时长，不贡献指纹数据。MusicBrainz 的公开联系信息可在“元数据”面板填写。</p>
  <button className="release-refresh" disabled={busy||loading} onClick={()=>{setError('');setReload(value=>value+1);}}>刷新设置与凭据状态</button>
  {error&&<p className="collection-error" role="alert">{error}</p>}{notice&&<p className="collection-note" role="status">{notice}</p>}
  <div className="provider-cards" aria-busy={loading}>
   {states.map(state=>{
    const manifest=state.manifest;
    return <section className="provider-card" key={manifest.id} aria-label={`${manifest.name} 数据源`}>
     <div className="provider-heading"><h3>{manifest.name}</h3><span className={manifest.ready?'ready':'planned'}>{manifest.ready?(state.enabled?'已启用':'已暂停'):'待接入'}</span></div>
     <p>{manifest.note}</p><div className="provider-actions"><button disabled={busy||loading} onClick={()=>setRetentionTarget({id:manifest.id,name:manifest.name})}>来源保存与撤销</button></div>
     <ul>{manifest.capabilities.map(capability=><li key={capability.kind}><strong>{capability.label}</strong><small>{capability.retention}</small></li>)}</ul>
     <div className="provider-actions"><button disabled={busy||loading||!manifest.ready} onClick={()=>void configure(state)}>{manifest.ready?(state.enabled?'暂停此数据源':'启用此数据源'):'尚不能启用'}</button><button disabled={busy} onClick={()=>void terms(manifest.id)}>查看来源与条款</button>{settingUncertain&&settingAttempt.current?.providerId===manifest.id&&<button disabled={busy} onClick={()=>void configure(state,true)}>核对上次设置操作</button>}</div>
     {manifest.credentialSlots.map(slot=>{
      const identity=key(manifest.id,slot.id),status=state.credentials.find(value=>value.slot===slot.id),attempt=credentialAttempt.current;
      const pending=uncertain&&attempt?.providerId===manifest.id&&attempt.slot===slot.id?attempt:null;
      return <div className="provider-credential" key={slot.id}>
       <label htmlFor={`credential-${identity}`}>{slot.label}</label>
       <p className="provider-status">{status?.present===true?'已保存':status?.present===false?'尚未保存':'状态未知'}{status?.error?` · ${status.error}`:''}{status?.uncertain?` · ${status.uncertain} 次历史操作尚未确认`:''}</p>
       <input id={`credential-${identity}`} type="password" autoComplete="off" spellCheck={false} aria-label={`${manifest.name} ${slot.label}`} placeholder="输入您自己的应用密钥" disabled={busy||!state.vaultAvailable} value={drafts[identity]??''} onChange={event=>{const value=event.target.value;credentialAttempt.current=null;setUncertain(false);setDrafts(values=>({...values,[identity]:value}));}}/>
       <div className="provider-actions"><button disabled={busy||!state.vaultAvailable||!drafts[identity]?.trim()} onClick={()=>void credential(manifest.id,slot.id,'set')}>{pending?.operation==='set'?'核对上次保存结果':'保存密钥'}</button><button disabled={busy||!state.vaultAvailable} onClick={()=>void credential(manifest.id,slot.id,'remove')}>{pending?.operation==='remove'?'核对上次移除结果':'移除密钥'}</button>{pending&&<button disabled={busy||!state.vaultAvailable||pending.operation==='set'&&!drafts[identity]?.trim()} onClick={()=>void credential(manifest.id,slot.id,pending.operation,true)}>{pending.operation==='set'?'按当前输入重新保存':'再次明确移除'}</button>}</div>
       <small>密钥保存到当前 Windows 用户的系统凭据库。这里只显示是否已保存；保存密钥不会自动开启查询。</small>
      </div>;
     })}
    </section>;
   })}
   {loading&&<p>正在读取数据源状态…</p>}
  </div>
  <footer><span className="collection-note">{busy?'正在处理，请等待状态确认…':'本地播放不依赖在线数据源。'}</span><button disabled={busy} onClick={onClose}>关闭</button></footer>
 </div></div>{retentionTarget&&<ProviderRetentionDialog providerId={retentionTarget.id} name={retentionTarget.name} onClose={()=>setRetentionTarget(null)}/>}</>;
}
