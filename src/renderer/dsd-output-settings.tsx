import React,{useEffect,useRef,useState} from 'react';
import {asioDriverId,sameAsioDriver,ASIO_DSD_QUERY_RATES,type AsioDriverCatalog,type AsioOutputPreference,type AsioCapabilities} from '../shared/asio-output';
import {readDopAuthorization} from '../shared/asio-dsd';
import {readDsdOutputRequest,type DsdOutputMode,type DsdOutputView,type DsdOutputRequest,type DopDeviceProfile} from '../shared/dsd-output';

type Props={catalog:AsioDriverCatalog|null;preference:AsioOutputPreference|null;observation:AsioCapabilities|null;disabled:boolean};
type ProfileForm={profileId:string;revision:number;driverId:string;driverVersion:string;dacName:string;rates:number[];mapping:string;evidence:string;documentConfirmed:boolean;volumeConfirmed:boolean};
const modeNames:Record<DsdOutputMode,string>={inherit:'沿用播放后端策略',stop:'停止 DSD 播放',pcm:'转 PCM', 'native-dsd':'Native DSD',dop:'DoP'};
export function DsdOutputSettings({catalog,preference,observation,disabled}:Props):React.JSX.Element {
 const [view,setView]=useState<DsdOutputView|null>(null),[mode,setMode]=useState<DsdOutputMode>('inherit'),[selectedId,setSelectedId]=useState('');
 const [form,setForm]=useState<ProfileForm|null>(null),[busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),working=useRef(false),attempt=useRef<DsdOutputRequest|null>(null),latestRevision=useRef(-1);
 function adopt(next:DsdOutputView,settled=false):void {
  if(next.preference.revision<latestRevision.current){setStale(true);return;}
  latestRevision.current=next.preference.revision;setView(next);
  attempt.current=next.pendingRequest??(settled?null:attempt.current);
  const desired=attempt.current?.action==='configure'?attempt.current:next.preference;
  setMode(desired.mode);setSelectedId(desired.selectedProfileId??'');setStale(false);
 }
 async function run(action:()=>Promise<void>):Promise<void>{
  if(working.current)return;working.current=true;setBusy(true);setError('');setNotice('');
  try{await action();}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function reload():Promise<void>{const next=await window.music.dsdOutput();if(alive.current){adopt(next);setForm(null);}}
 useEffect(()=>{
  alive.current=true;void run(reload);
  const stop=window.music.onEvent(event=>{
   if(event.event==='dsdOutputChanged'){
    const next=event.payload as DsdOutputView;
    if(next.preference.revision>=latestRevision.current){latestRevision.current=next.preference.revision;setStale(true);}
   }
   if(event.event==='asioOutputChanged')setStale(true);
  });return()=>{alive.current=false;stop();};
 },[]);
 const pending=Boolean(attempt.current),locked=disabled||busy||pending||stale||!view;
 async function submit(create:()=>DsdOutputRequest,retry=false):Promise<void>{
  if(working.current||disabled||!view||!retry&&(pending||stale))return;
  await run(async()=>{
   const request=retry?attempt.current:readDsdOutputRequest(create());if(!request)return;attempt.current=request;
   try{
    const result=await window.music.configureDsdOutput(request);if(!alive.current)return;
    if(result.status==='unknown'){adopt(result.view);attempt.current=request;setError(result.error||'保存结果尚未确认，请核对原操作。');return;}
    attempt.current=null;adopt(result.view,true);
    if(result.status==='rejected'){setError(result.error);setStale(true);return;}
    setForm(null);setNotice(result.error||'DSD 设置已保存。');
   }catch(e){if(alive.current)setError(`保存结果尚未确认，请核对原操作：${e instanceof Error?e.message:String(e)}`);}
  });
 }
 function command():{commandId:string;baseRevision:number}{if(!view)throw new Error('DSD 设置尚未读取');return {commandId:crypto.randomUUID(),baseRevision:view.preference.revision};}
 function edit(profile:DopDeviceProfile|null):void {
  if(locked)return;
  setForm({profileId:profile?.profileId??crypto.randomUUID(),revision:profile?.revision??0,driverId:profile?asioDriverId(profile.driver):preference?.driver?asioDriverId(preference.driver):'',
   driverVersion:profile?String(profile.driverVersion):'',dacName:profile?.dacName??'',rates:profile?[...profile.supportedBitRates]:[],mapping:(profile?.outputChannels??preference?.outputChannels??[]).map(index=>index+1).join(', '),
   evidence:profile?.evidenceText??'',documentConfirmed:false,volumeConfirmed:false});setError('');setNotice('');
 }
 function saveProfile():DsdOutputRequest {
  if(!form)throw new Error('请先编辑设备档案');const driver=catalog?.drivers.find(d=>asioDriverId(d)===form.driverId);
  if(!driver)throw new Error('档案驱动当前未发现，请刷新 ASIO 列表');
  if(!/^-?\d{1,11}$/.test(form.driverVersion))throw new Error('驱动版本须填写驱动报告的整数');
  const entries=form.mapping.split(',').map(value=>value.trim());if(!entries.length||entries.some(value=>!/^\d{1,4}$/.test(value)))throw new Error('输出声道请按顺序填写，用英文逗号分隔');
  const profile=readDopAuthorization({kind:'userConfigured',profileId:form.profileId,revision:form.revision,driver:{registryName:driver.registryName,clsid:driver.clsid},driverVersion:Number(form.driverVersion),dacName:form.dacName.trim(),
   supportedBitRates:form.rates,outputChannels:entries.map(value=>Number(value)-1),evidenceText:form.evidence.trim(),documentConfirmed:form.documentConfirmed,volumeConfirmed:form.volumeConfirmed,hardwareVerified:false});
  return {...command(),action:'save-profile',profile};
 }
 const formDriver=catalog?.drivers.find(d=>asioDriverId(d)===form?.driverId),canCopy=Boolean(formDriver&&observation&&sameAsioDriver(formDriver,observation.identity));
 function patch(value:Partial<ProfileForm>):void{setForm(current=>current?{...current,...value}:null);}
 return <section className="asio-settings" aria-label="DSD 输出预设与设备档案">
  <h3>DSD 输出预设与设备档案</h3>
  <p>选择 ASIO 后端后，DSD 歌曲按此预设播放。Native／DoP 需要驱动支持原始输出；DoP 还需要选用匹配的设备档案。停止、转 PCM 或沿用策略均需明确选择。</p>
  <p>修改正在使用的预设或 DoP 档案会重新准备当前 DSD 曲目；归档选用档案并改为停止时，不自动继续播放。</p>
  <p>设备档案来自手动确认，不代表 DAC 或驱动已通过实机验证。</p>
  {error&&<p className="output-error" role="alert">{error}</p>}{notice&&<p className="output-notice" role="status">{notice}</p>}
  {pending&&<p role="status">上次保存结果尚未确认，请核对原操作后继续。</p>}{stale&&<p role="status">设置已变化，请刷新 DSD 设置后继续。</p>}
  <fieldset className="output-fields" disabled={locked}>
   <label>DSD 输出预设<select value={mode} onChange={e=>setMode(e.target.value as DsdOutputMode)}>{Object.entries(modeNames).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>DoP 设备档案<select value={selectedId} onChange={e=>setSelectedId(e.target.value)}><option value="">不选用</option>{view?.preference.profiles.filter(p=>!p.archived).map(p=><option key={p.profileId} value={p.profileId}>{p.dacName} · {p.driver.registryName} · 修订 {p.revision}</option>)}</select></label>
   <button type="button" disabled={mode==='dop'&&!selectedId} onClick={()=>void submit(()=>({...command(),action:'configure',mode,selectedProfileId:selectedId||null}))}>保存 DSD 预设</button>
  </fieldset>
  <p>归档正在选用的 DoP 档案会撤销选用，并将 DoP 预设改为停止；归档记录仍保留。</p>
  <ul>{view?.preference.profiles.map(profile=><li key={profile.profileId}>
   {profile.dacName} · {profile.driver.registryName} · 驱动版本 {profile.driverVersion} · 修订 {profile.revision}{profile.archived?'（已归档）':''}{profile.profileId===view.preference.selectedProfileId?'（已选用）':''}
   <div className="asio-actions">{!profile.archived&&<button type="button" disabled={locked} onClick={()=>edit(profile)}>编辑档案</button>}
    <button type="button" disabled={locked} onClick={()=>void submit(()=>({...command(),action:'archive-profile',profileId:profile.profileId,profileRevision:profile.revision,archived:!profile.archived}))}>{profile.archived?'恢复档案':'归档档案'}</button></div>
  </li>)}</ul>
  {!view?.preference.profiles.length&&<p>尚无 DoP 设备档案。</p>}
  <button type="button" disabled={locked||Boolean(view&&view.preference.profiles.length>=32)} onClick={()=>edit(null)}>新增 DoP 设备档案</button>
  {form&&<fieldset className="output-fields" disabled={locked}>
   <legend>{form.revision?'编辑':'新增'} DoP 设备档案</legend>
   <label>DAC 名称<input maxLength={256} value={form.dacName} onChange={e=>patch({dacName:e.target.value})}/></label>
   <label>64 位 ASIO 驱动<select value={form.driverId} onChange={e=>patch({driverId:e.target.value,driverVersion:'',documentConfirmed:false,volumeConfirmed:false})}>
    <option value="">请选择</option>{form.driverId&&!formDriver&&<option value={form.driverId}>档案原驱动（当前未发现）</option>}{catalog?.drivers.map(driver=><option key={asioDriverId(driver)} value={asioDriverId(driver)}>{driver.description||driver.registryName}</option>)}
   </select></label>
   <label>驱动报告的版本整数<input type="number" min={-2147483648} max={2147483647} step={1} value={form.driverVersion} onChange={e=>patch({driverVersion:e.target.value})}/></label>
   <button type="button" disabled={!canCopy} onClick={()=>{if(canCopy&&observation)patch({driverVersion:String(observation.driverVersion)});}}>填入已读取的驱动版本</button>
   <p>可手动填写，或使用上方显式读取的能力观察。填写档案不会初始化驱动。</p>
   <fieldset><legend>已确认支持的 DSD 速率</legend>{ASIO_DSD_QUERY_RATES.map((rate,index)=><label className="output-check" key={rate}><input type="checkbox" checked={form.rates.includes(rate)} onChange={e=>patch({rates:ASIO_DSD_QUERY_RATES.filter(value=>value===rate?e.target.checked:form.rates.includes(value))})}/>DSD{64*2**index} · {rate/1000000} MHz</label>)}</fieldset>
   <label>输出声道顺序（从 1 起，用英文逗号分隔）<input maxLength={110} value={form.mapping} placeholder="1, 2" onChange={e=>patch({mapping:e.target.value})}/></label>
   <p>按源声道顺序指定不同的输出，例如双声道填写 1, 2；选用时必须与已保存的 ASIO 映射一致。</p>
   <label>设备文档或确认依据<input maxLength={1024} value={form.evidence} onChange={e=>patch({evidence:e.target.value})}/></label>
   <label className="output-check"><input type="checkbox" checked={form.documentConfirmed} onChange={e=>patch({documentConfirmed:e.target.checked})}/>我已确认设备与驱动文档支持上述 DoP 速率和声道</label>
   <label className="output-check"><input type="checkbox" checked={form.volumeConfirmed} onChange={e=>patch({volumeConfirmed:e.target.checked})}/>我已确认使用设备硬件控制音量，原始 DSD 不应用软件音量或增益</label>
   <div className="asio-actions"><button type="button" disabled={!form.documentConfirmed||!form.volumeConfirmed} onClick={()=>void submit(saveProfile)}>保存设备档案</button><button type="button" onClick={()=>setForm(null)}>取消编辑</button></div>
  </fieldset>}
  <div className="asio-actions"><button type="button" disabled={disabled||busy} onClick={()=>void run(reload)}>刷新 DSD 设置</button>{pending&&<button type="button" disabled={disabled||busy} onClick={()=>void submit(()=>{throw new Error('缺少原操作');},true)}>核对 DSD 原操作</button>}</div>
 </section>;
}
