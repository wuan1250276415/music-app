import {MaintenanceHold} from './maintenance-hold.js';
import {adjacentCueItems} from '../shared/source-sample-range.js';
import type {AsioRebuildRequest,AsioFrameBookmark} from './asio-playback-state.js';
import { createHash,randomUUID } from 'node:crypto';
import type { LibraryItem, PlaybackState, QueueCommand, QueueState, QueueView, RepeatMode, PlaylistPlaybackContext } from '../shared/contracts.js';
import { AudioController } from './audio.js';
import { PlaybackQueue, validQueueState } from './queue.js';

type LibraryPort={
  load():Promise<unknown>;
  save(state:QueueState,baseRevision:number):Promise<unknown>;
  item(id:string):Promise<LibraryItem|undefined>;
  items(ids:string[]):Promise<LibraryItem[]>;
  playlist?(playlistId:string,entryId:string,revision:number):Promise<PlaylistPlaybackContext>;
};

type CuePlan={currentEntryId:string;nextEntryId:string;nextItemId:string;revision:number;boundaryObserved:boolean};

export function adjacentCuePair(current:LibraryItem,next:LibraryItem):boolean {
  return adjacentCueItems(current,next);
}

export class PlaybackCoordinator {
 private readonly maintenance=new MaintenanceHold();
 private restoreCompletionOwner:string|null=null;
  private historySession:string|null=null;
  private queue=new PlaybackQueue();
  private chain:Promise<unknown>=Promise.resolve();
  private planned:CuePlan|null=null;
  private persistenceUnknown=false;
  private outputBookmark:{id:string;position:number;paused:boolean;bookmark?:AsioFrameBookmark}|null=null;
  private systemSleeping=false;private powerEpoch=0;private actionPowerEpoch=0;
  private recoveryBookmark:{id:string;entryId:string;position:number;token:number;kind:NonNullable<PlaybackState['interruption']>['kind'];bookmark?:AsioFrameBookmark;positionEvidence:NonNullable<PlaybackState['interruption']>['positionEvidence']}|null=null;
  private receipts=new Map<string,{fingerprint:string;promise:Promise<unknown>;settled:boolean}>();
  constructor(private readonly audio:AudioController,private readonly library:LibraryPort,private readonly publish:(state:QueueState)=>void){}

  async initialize():Promise<void> {
    const stored=await this.library.load();
    if(stored!==null&&stored!==undefined&&!validQueueState(stored))throw new Error('已保存的播放队列无效，需要先恢复曲库备份');
    this.queue=new PlaybackQueue(stored);this.persistenceUnknown=false;this.publish(this.queue.snapshot());
  }
  assertRestoreFrozen(owner:string):void{this.maintenance.assertFrozen(owner);if(this.systemSleeping||!this.audio.outputIsReleased()||!['idle','error'].includes(this.audio.snapshot().state)||[...this.receipts.values()].some(r=>!r.settled))throw new Error('恢复状态重建前播放或原命令尚未停止');}
  prepareRestoreState(owner:string,value:unknown):void{
    this.assertRestoreFrozen(owner);if(!validQueueState(value))throw new Error('恢复播放队列无效');
    this.powerEpoch++;this.actionPowerEpoch=this.powerEpoch;this.queue=new PlaybackQueue(value);this.receipts.clear();this.planned=null;this.persistenceUnknown=false;this.outputBookmark=null;this.recoveryBookmark=null;this.historySession=null;
  }
  snapshot():QueueState {return this.queue.snapshot();}
  get systemIsSleeping():boolean{return this.systemSleeping;}
  async view():Promise<QueueView> {const state=this.queue.snapshot();return {...state,items:await this.library.items(state.entries.map(entry=>entry.itemId))};}

  private serialize<T>(action:()=>Promise<T>,command?:QueueCommand,identity?:unknown,maintenance=false):Promise<T> {
    if(this.maintenance.held||this.restoreCompletionOwner)return Promise.reject(new Error('曲库维护期间播放和队列操作暂停'));
    const epoch=this.powerEpoch;
    let fingerprint='';
    if(command){
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.commandId)||
        !Number.isSafeInteger(command.baseRevision)||command.baseRevision<0)throw new Error('无效队列命令');
      fingerprint=createHash('sha256').update(JSON.stringify([identity,command.baseRevision])).digest('hex');
      const prior=this.receipts.get(command.commandId);
      if(prior){
        if(prior.fingerprint!==fingerprint)throw new Error('队列命令 ID 已用于不同操作');
        return prior.promise as Promise<T>;
      }
      // Keep in-flight receipts; only completed receipts may leave the bounded replay window.
      if(this.receipts.size>=512){
        for(const [id,receipt] of this.receipts){if(receipt.settled){this.receipts.delete(id);break;}}
        if(this.receipts.size>=512)throw new Error('队列命令过多，请稍后重试');
      }
    }
    const running=this.chain.then(()=>{if(epoch!==this.powerEpoch||this.systemSleeping&&!maintenance)throw new Error('系统播放状态已变化，请唤醒后重新操作');this.actionPowerEpoch=epoch;this.checkRevision(command);return action();});
    this.chain=running.catch(()=>undefined);
    if(command){
      const receipt={fingerprint,promise:running as Promise<unknown>,settled:false};
      this.receipts.set(command.commandId,receipt);
      void running.then(()=>{receipt.settled=true;},()=>{receipt.settled=true;});
    }
    return running;
  }
  private async changeQueue<T>(change:(draft:PlaybackQueue)=>T):Promise<T> {
    if(this.persistenceUnknown)throw new Error('曲库队列持久化状态尚未确认，请重启应用');
    const before=this.queue.snapshot();
    const draft=new PlaybackQueue(before);
    const result=change(draft);
    const after=draft.snapshot();
    if(after.revision===before.revision){
      if(JSON.stringify(after)!==JSON.stringify(before))throw new Error('队列变化缺少修订号');
      return result;
    }
    if(after.revision!==before.revision+1)throw new Error('队列修订号不连续');
    try{await this.library.save(after,before.revision);}
    catch(error){
      let persisted:unknown;
      try{persisted=await this.library.load();}
      catch{this.persistenceUnknown=true;throw new Error('无法确认队列是否已保存，请重启应用后查看队列');}
      if(persisted!==null&&persisted!==undefined&&!validQueueState(persisted)){
        this.persistenceUnknown=true;throw new Error('已保存的播放队列无效，需要先恢复曲库备份');
      }
      const actual=new PlaybackQueue(persisted).snapshot();
      if(JSON.stringify(actual)!==JSON.stringify(after)){
        if(JSON.stringify(actual)===JSON.stringify(before))throw error;
        this.queue=new PlaybackQueue(actual);this.planned=null;this.audio.stop();this.publish(actual);
        throw new Error('队列已被其他写入更新，请刷新后重试');
      }
    }
    this.queue=draft;
    this.publish(after);
    return result;
  }
  private checkRevision(command?:QueueCommand):void {
    if(command&&command.baseRevision!==this.queue.snapshot().revision)
      throw new Error('队列版本已变化，请刷新后重试');
  }
  private async playItem(id:string,resume?:{position:number;paused:boolean;token?:number;bookmark?:AsioFrameBookmark}):Promise<PlaybackState> {
    if(!resume){this.outputBookmark=null;this.recoveryBookmark=null;}
    this.planned=null;
    const item=await this.library.item(id);
    if(!item)throw new Error('队列曲目已不在音乐库中');
    const state=this.queue.snapshot();
    let nextItem:LibraryItem|undefined;
    if(!this.audio.rawDsdSelected(item)&&state.repeat==='off'&&!state.shuffle&&state.historyCursor===state.history.length-1&&
      state.orderCursor>=0&&state.orderCursor+1<state.order.length){
      const nextEntryId=state.order[state.orderCursor+1];
      const nextEntry=state.entries.find(entry=>entry.id===nextEntryId);
      if(nextEntry){
        const candidate=await this.library.item(nextEntry.itemId);
        if(candidate&&adjacentCuePair(item,candidate)){
          nextItem=candidate;
          this.planned={currentEntryId:state.currentEntryId!,nextEntryId,nextItemId:candidate.id,
            revision:state.revision,boundaryObserved:false};
        }
      }
    }
    try{
      if(this.actionPowerEpoch!==this.powerEpoch||this.systemSleeping||resume?.token!==undefined&&resume.token!==this.audio.operationToken())throw new Error('播放请求已取消，请重新操作');
      if(!resume||!this.historySession)this.historySession=randomUUID();
      const entry=state.entries.find(value=>value.id===state.currentEntryId);
      if(!entry||entry.itemId!==item.id)throw new Error('播放曲目与持久队列身份不符');
      const nextEntry=nextItem&&this.planned?state.entries.find(value=>value.id===this.planned!.nextEntryId):undefined;
      return await this.audio.play(item,nextItem,resume?.position??0,resume?.paused??false,resume?.bookmark,{
        sessionId:this.historySession,first:{entryId:entry.id,item},...(nextItem&&nextEntry?{next:{entryId:nextEntry.id,item:nextItem}}:{})
      });
    }
    catch(error){this.planned=null;throw error;}
  }
  private async applyBoundary():Promise<void>{
    const plan=this.planned;
    if(!plan)return;
    const before=this.queue.snapshot();
    if(!plan.boundaryObserved||before.revision!==plan.revision||before.currentEntryId!==plan.currentEntryId||
      before.order[before.orderCursor+1]!==plan.nextEntryId){
      this.planned=null;this.audio.stop();throw new Error('CUE 边界与队列版本不一致，已停止播放');
    }
    try{
      await this.changeQueue(draft=>{
        const id=draft.next(true);
        if(id!==plan.nextItemId||draft.snapshot().currentEntryId!==plan.nextEntryId)
          throw new Error('CUE 边界目标与队列不一致，已停止播放');
      });
      this.planned=null;
    }catch(error){this.planned=null;this.audio.stop();throw error;}
  }
  private async beforeQueueMutation():Promise<void>{
    if(!this.planned)return;
    try{
      const result=await this.audio.cancelNext();
      if(result==='crossed')await this.applyBoundary();
      else this.planned=null;
    }catch(error){this.planned=null;throw error;}
  }
  rebuildAsio(request:AsioRebuildRequest):Promise<PlaybackState>{
    return this.serialize(async()=>{
      const state=this.audio.snapshot(),q=this.queue.snapshot(),entry=q.entries.find(e=>e.id===q.currentEntryId);
      if(request.token!==this.audio.operationToken()||state.state!=='preparing'||state.itemId!==request.itemId||entry?.itemId!==request.itemId)throw new Error('ASIO 重建期间曲目或队列已变化');
      this.planned=null;
      try{return await this.playItem(request.itemId,{position:Number(request.frame)/request.sampleRate,paused:request.paused,token:request.token,bookmark:request});}
      catch(error){if(this.actionPowerEpoch===this.powerEpoch&&!this.systemSleeping&&this.queue.snapshot().currentEntryId===q.currentEntryId&&['idle','error'].includes(this.audio.snapshot().state))this.audio.rememberOutputFailure({...state,positionSeconds:Number(request.frame)/request.sampleRate},error instanceof Error?error.message:String(error));throw error;}
    });
  }
  inspectStoppedOutput<T>(inspect:()=>Promise<T>):Promise<T>{
    return this.serialize(async()=>{
      if(!['idle','error'].includes(this.audio.snapshot().state)||!this.audio.outputIsReleased())throw new Error('请先停止播放并等待音频输出释放，再读取 ASIO 驱动能力');
      return inspect();
    });
  }
  configureOutput(commit:()=>Promise<void>,prepare?:()=>Promise<void>):Promise<PlaybackState>{
    return this.serialize(async()=>{
      await prepare?.();
      return this.reopenOutput(commit);
    });
  }
  configureBackendOutput(backend:'wasapi'|'asio',commit:()=>Promise<void>,prepare?:()=>Promise<void>,affectsPlayback:()=>boolean=()=>true,continuePlayback:()=>boolean=()=>true):Promise<PlaybackState>{
    return this.serialize(async()=>{await prepare?.();if(this.audio.backendSnapshot().backend===backend&&affectsPlayback())return this.reopenOutput(commit,continuePlayback);await commit();return this.audio.snapshot();});
  }
  private async reopenOutput(commit:()=>Promise<void>,continuePlayback:()=>boolean=()=>true):Promise<PlaybackState>{
      await this.beforeQueueMutation();const before=this.audio.snapshot(),frameBookmark=this.audio.frameBookmark();
      const held=this.recoveryBookmark;
      if(before.state==='preparing')throw new Error('正在准备播放，请稍后再切换输出设备');
      const resume=(before.state==='playing'||before.state==='paused')&&before.itemId?{id:before.itemId,position:frameBookmark?Number(frameBookmark.frame)/frameBookmark.sampleRate:before.positionSeconds,paused:before.state==='paused',bookmark:frameBookmark}:this.outputBookmark;
      if(resume&&this.queue.snapshot().entries.find(entry=>entry.id===this.queue.snapshot().currentEntryId)?.itemId!==resume.id)throw new Error('播放曲目与队列不一致，已阻止设备切换');
      this.outputBookmark=resume;const releasing=this.audio.release(),token=this.audio.operationToken();await releasing;
      try{
        await commit();
        if(!continuePlayback()){this.outputBookmark=null;return this.audio.snapshot();}
        if(held&&this.recoveryBookmark===held&&token===this.audio.operationToken()&&!resume){held.token=token;this.audio.markPlaybackInterruption(before,token,held.kind,'ready','输出设置已保存，点击播放从保留位置继续',held.positionEvidence);}
        if(resume&&token===this.audio.operationToken()){const result=await this.playItem(resume.id,{position:resume.position,paused:resume.paused,token,bookmark:this.audio.refreshFrameBookmark(resume.bookmark)});this.outputBookmark=null;return result;}
        this.outputBookmark=null;return this.audio.snapshot();
      }catch(error){if(resume&&token===this.audio.operationToken()&&this.audio.snapshot().state==='idle')this.audio.rememberOutputFailure({...before,itemId:resume.id,positionSeconds:resume.position},error instanceof Error?error.message:String(error));throw error;}
  }
  mutateCueDocuments<T>(documentIds:readonly string[],commit:()=>Promise<T>,fileIds:readonly string[]=[]):Promise<T>{
    return this.serialize(async()=>{
      const audio=this.audio.snapshot(),ids=[audio.itemId,this.recoveryBookmark?.id,this.outputBookmark?.id,this.planned?.nextItemId].filter((id):id is string=>Boolean(id));
      const documents=new Set(documentIds),files=new Set(fileIds),items=(documents.size||files.size)&&ids.length?await this.library.items([...new Set(ids)]):[];
      if(items.some(item=>files.has(item.fileId)||item.cue&&documents.has(item.cue.documentId))){this.planned=null;this.stop();await this.audio.release();if(!this.audio.outputIsReleased())throw new Error('CUE编排变更前音频资源尚未确认释放');}
      return commit();
    },undefined,undefined,true);
  }
  mutateLibraryFile<T>(fileId:string,commit:()=>Promise<T>):Promise<T>{
    return this.serialize(async()=>{
      const audio=this.audio.snapshot(),ids=[audio.itemId,this.recoveryBookmark?.id,this.outputBookmark?.id,this.planned?.nextItemId].filter((id):id is string=>Boolean(id));
      const items=ids.length?await this.library.items([...new Set(ids)]):[];
      if(items.some(item=>item.fileId===fileId)){this.planned=null;this.stop();}
      return commit();
    },undefined,undefined,true);
  }
  stageLibraryFile<T>(fileId:string,observation:string,commit:()=>Promise<T>):Promise<T>{
    return this.serialize(async()=>{
      const audio=this.audio.snapshot(),ids=[audio.itemId,this.recoveryBookmark?.id,this.outputBookmark?.id,this.planned?.nextItemId].filter((id):id is string=>Boolean(id));
      const items=ids.length?await this.library.items([...new Set(ids)]):[];
      if(items.some(item=>item.fileId===fileId||Boolean(observation)&&item.fileObservation===observation)){this.planned=null;this.stop();await this.audio.release();}
      return commit();
    },undefined,undefined,true);
  }
  beginMaintenance(owner:string):Promise<void>{if(this.restoreCompletionOwner)return Promise.reject(new Error('恢复最终播放占用尚未完成'));return this.maintenance.begin(owner,async()=>{
    this.stop();const results=await Promise.allSettled([this.chain,this.audio.release()]);
    const failed=results.find((v):v is PromiseRejectedResult=>v.status==='rejected');if(failed)throw failed.reason;
    this.planned=null;if(!this.audio.outputIsReleased())throw new Error('音频输出尚未确认释放');
  });}
  endMaintenance(owner:string):void{if(this.restoreCompletionOwner)throw new Error('恢复最终播放占用尚未完成');this.maintenance.end(owner);}
  endRestoreMaintenance(owner:string):void{this.assertRestoreFrozen(owner);if(this.restoreCompletionOwner)throw new Error('恢复最终播放占用已登记');this.restoreCompletionOwner=owner;this.maintenance.end(owner);}
  get maintenanceIsHeld():boolean{return this.maintenance.held;}
  assertRestoreStopped(owner:string):void{if(this.restoreCompletionOwner!==owner||this.maintenance.held||this.systemSleeping||!this.audio.outputIsReleased()||!['idle','error'].includes(this.audio.snapshot().state)||[...this.receipts.values()].some(r=>!r.settled))throw new Error('恢复最终播放资源或停止状态尚未确认');}
  completeRestore(owner:string):void{this.assertRestoreStopped(owner);this.restoreCompletionOwner=null;}
  stop():PlaybackState{++this.powerEpoch;this.recoveryBookmark=null;this.outputBookmark=null;return this.audio.stop();}
  systemSuspend():void{
    if(this.systemSleeping)return;this.systemSleeping=true;++this.powerEpoch;this.audio.setSystemSleeping(true);
    const before=this.audio.snapshot(),frameBookmark=this.audio.frameBookmark()??this.recoveryBookmark?.bookmark,boundary=this.planned?.boundaryObserved?this.planned:null;
    const active=(before.state==='playing'||before.state==='paused'||before.interruption&&this.recoveryBookmark?.token===this.audio.operationToken())&&before.itemId;
    this.outputBookmark=null;const releasing=this.audio.release(),token=this.audio.operationToken();
    this.recoveryBookmark=active?{id:before.itemId!,entryId:boundary?.nextEntryId??this.queue.snapshot().currentEntryId??'',position:frameBookmark?Number(frameBookmark.frame)/frameBookmark.sampleRate:before.positionSeconds,bookmark:frameBookmark,token,kind:'system-suspend',positionEvidence:before.interruption?.positionEvidence??'recent-position'}:null;
    if(active)this.audio.markSystemInterruption(before,token,'sleeping','系统休眠，正在释放音频；唤醒后请手动继续');
    void this.serialize(async()=>{
      await releasing;
      if(boundary&&this.planned===boundary)await this.applyBoundary();else this.planned=null;
      const bookmark=this.recoveryBookmark,q=this.queue.snapshot();
      if(bookmark&&(q.currentEntryId!==bookmark.entryId||q.entries.find(e=>e.id===q.currentEntryId)?.itemId!==bookmark.id))throw new Error('休眠位置与队列不一致，请重新选择曲目');
      if(bookmark&&token===this.audio.operationToken())this.audio.markSystemInterruption(before,token,this.systemSleeping?'sleeping':'ready',this.systemSleeping?'系统休眠，旧音频宿主已退出；唤醒后请手动继续':'系统已唤醒，点击播放重新协商设备并从最近位置继续');
    },undefined,undefined,true).catch(error=>{
      if(token===this.audio.operationToken()||this.recoveryBookmark?.token===token){this.recoveryBookmark=null;this.audio.markSystemInterruption(before,this.audio.operationToken(),'failed',error instanceof Error?error.message:String(error));}
    });
  }
  systemResume():void{
    if(!this.systemSleeping)return;this.systemSleeping=false;this.audio.setSystemSleeping(false);
    const bookmark=this.recoveryBookmark;if(bookmark)this.audio.markSystemInterruption(this.audio.snapshot(),bookmark.token,'ready','系统已唤醒，点击播放重新协商设备并从最近位置继续');
  }
  toggle():Promise<PlaybackState>{
    if(this.maintenance.held||this.restoreCompletionOwner)return Promise.reject(new Error('曲库维护期间播放暂停'));
    const bookmark=this.recoveryBookmark,q=this.queue.snapshot();
    if(bookmark&&this.audio.snapshot().state==='idle'&&q.currentEntryId===bookmark.entryId)return this.jump(bookmark.entryId,{commandId:randomUUID(),baseRevision:q.revision});
    return Promise.resolve(this.audio.pause());
  }
  releasePaused(observation:import('./pause-release.js').PauseObservation,valid:()=>boolean):Promise<PlaybackState>{
    return this.serialize(async()=>{
      const matches=()=>{const state=this.audio.snapshot();return valid()&&this.audio.operationToken()===observation.token&&state.state==='paused'&&state.itemId===observation.itemId&&(state.asioDsd?.generation??state.asio?.generation??state.clock?.generation??0)===observation.generation;};
      if(!matches())return this.audio.snapshot();
      await this.beforeQueueMutation();if(!matches())return this.audio.snapshot();
      const before=this.audio.snapshot(),frameBookmark=this.audio.frameBookmark(),q=this.queue.snapshot(),entry=q.entries.find(e=>e.id===q.currentEntryId);
      const positionEvidence=(before.asioDsd?.clock.authority??before.asio?.clock.authority??before.clock?.authority)==='paused-bookmark'?'paused-bookmark':'recent-position';
      this.outputBookmark=null;const releasing=this.audio.release(),token=this.audio.operationToken();
      const bookmark:typeof this.recoveryBookmark=entry?.itemId===before.itemId?{id:before.itemId!,entryId:entry.id,position:frameBookmark?Number(frameBookmark.frame)/frameBookmark.sampleRate:before.positionSeconds,bookmark:frameBookmark,token,kind:'pause-timeout',positionEvidence}:null;
      this.recoveryBookmark=bookmark;this.planned=null;
      this.audio.markPlaybackInterruption(before,token,'pause-timeout',bookmark?'releasing':'failed',bookmark?'暂停满 60 秒，正在释放设备；请稍后继续':'暂停位置与队列不一致，请重新选择曲目',positionEvidence);
      try{await releasing;}catch(error){if(this.recoveryBookmark===bookmark&&token===this.audio.operationToken())this.audio.markPlaybackInterruption(before,token,'pause-timeout','failed',error instanceof Error?error.message:String(error),positionEvidence);throw error;}
      if(bookmark&&this.recoveryBookmark===bookmark&&token===this.audio.operationToken())this.audio.markPlaybackInterruption(before,token,'pause-timeout','ready','暂停满 60 秒，设备已释放；点击播放从保留位置继续',positionEvidence);
      return this.audio.snapshot();
    });
  }
  configureVolume(commit:(token:number,reopening:boolean)=>Promise<void>,prepare?:()=>boolean):Promise<PlaybackState>{
    return this.serialize(async()=>{
      if(prepare?.())return this.reopenOutput(()=>commit(this.audio.operationToken(),true));
      await commit(this.audio.operationToken(),false);return this.audio.snapshot();
    });
  }
  play(id:string,contextIds?:string[],command?:QueueCommand):Promise<PlaybackState> {
    return this.serialize(async()=>{
      if(!id||id.length>128||contextIds!==undefined && (!Array.isArray(contextIds)||contextIds.length>500||contextIds.some(value=>typeof value!=='string'||value.length>128)))throw new Error('无效播放上下文');
      await this.changeQueue(draft=>draft.start(id,contextIds));return this.playItem(id);
    },command,['play',id,contextIds]);
  }
  jump(entryId:string,command?:QueueCommand):Promise<PlaybackState> {
    return this.serialize(async()=>{
      const bookmark=this.recoveryBookmark,current=this.queue.snapshot().currentEntryId,before=this.audio.snapshot();
      const id=await this.changeQueue(draft=>draft.jump(entryId));
      const resume=bookmark&&entryId===current&&entryId===bookmark.entryId&&id===bookmark.id?{position:bookmark.position,paused:false,token:bookmark.token,bookmark:this.audio.refreshFrameBookmark(bookmark.bookmark)}:undefined;
      try{const result=await this.playItem(id,resume);this.recoveryBookmark=null;return result;}
      catch(error){
        if(resume&&bookmark&&this.recoveryBookmark===bookmark&&this.actionPowerEpoch===this.powerEpoch&&!this.systemSleeping){
          bookmark.token=this.audio.operationToken();this.audio.markPlaybackInterruption(before,bookmark.token,bookmark.kind,'failed',`继续播放未完成，可修复设备后重试：${error instanceof Error?error.message:String(error)}`,bookmark.positionEvidence);
        }
        throw error;
      }
    },command,['jump',entryId]);
  }
  playPlaylist(request:{playlistId:string;entryId:string;revision:number},command:QueueCommand):Promise<PlaybackState> {
    return this.serialize(async()=>{
      if(!this.library.playlist)throw new Error('歌单播放服务不可用');
      const context=await this.library.playlist(request.playlistId,request.entryId,request.revision);
      if(!context||!Array.isArray(context.entries)||context.entries.length>500||context.entries.some(entry=>
        typeof entry.id!=='string'||entry.id.length>128||typeof entry.itemId!=='string'||entry.itemId.length>128))throw new Error('无效歌单播放上下文');
      const id=await this.changeQueue(draft=>draft.startAt(context.entries.map(entry=>({itemId:entry.itemId,playlistEntryId:entry.id})),context.startIndex));
      return this.playItem(id);
    },command,['playlist',request.playlistId,request.entryId,request.revision]);
  }
  next(command?:QueueCommand):Promise<PlaybackState> {return this.serialize(async()=>{
    await this.beforeQueueMutation();this.checkRevision(command);return this.advance(false);
  },command,['next']);}
  previous(command?:QueueCommand):Promise<PlaybackState> {
    return this.serialize(async()=>{
      await this.beforeQueueMutation();this.checkRevision(command);
      const id=await this.changeQueue(draft=>draft.previous(this.audio.snapshot().positionSeconds));
      if(!id)return this.audio.snapshot();
      return this.playItem(id);
    },command,['previous']);
  }
  onCueBoundary():void {
    if(this.maintenance.held||this.restoreCompletionOwner)return;
    if(this.planned)this.planned.boundaryObserved=true;
    void this.serialize(()=>this.applyBoundary()).catch(error=>console.error('[queue]',error));
  }
  onEnded():void {if(this.maintenance.held||this.restoreCompletionOwner)return;void this.serialize(async()=>{
    if(this.planned)await this.applyBoundary();
    return this.advance(true);
  }).catch(error=>console.error('[queue]',error));}
  private async advance(automatic:boolean):Promise<PlaybackState> {
    this.planned=null;
    const count=this.queue.snapshot().entries.length;
    for(let attempt=0;attempt<Math.max(1,count);attempt++) {
      const id=await this.changeQueue(draft=>draft.next(automatic && attempt===0));
      if(!id)return this.audio.stop();
      const item=await this.library.item(id);
      if(item?.available) {
        if(this.actionPowerEpoch!==this.powerEpoch||this.systemSleeping)throw new Error('系统播放状态已变化，未自动继续');
        this.recoveryBookmark=null;try{return await this.playItem(id);}catch(error){if(!automatic)throw error;}
      } else if(!automatic) throw new Error('下一首曲目不可用');
    }
    return this.audio.stop();
  }
  setRepeat(mode:RepeatMode,command?:QueueCommand):Promise<QueueView> {return this.serialize(async()=>{
    if(this.queue.snapshot().repeat!==mode)await this.beforeQueueMutation();
    this.checkRevision(command);await this.changeQueue(draft=>draft.setRepeat(mode));return this.view();
  },command,['repeat',mode]);}
  setShuffle(enabled:boolean,command?:QueueCommand):Promise<QueueView> {return this.serialize(async()=>{
    if(this.queue.snapshot().shuffle!==enabled)await this.beforeQueueMutation();
    this.checkRevision(command);await this.changeQueue(draft=>draft.setShuffle(enabled));return this.view();
  },command,['shuffle',enabled]);}
  remove(entryId:string,command?:QueueCommand):Promise<QueueView> {return this.serialize(async()=>{
    if(this.queue.snapshot().currentEntryId===entryId)throw new Error('当前播放项不能从队列移除');
    await this.beforeQueueMutation();this.checkRevision(command);
    await this.changeQueue(draft=>draft.remove(entryId));return this.view();
  },command,['remove',entryId]);}
  move(entryId:string,direction:-1|1,command?:QueueCommand):Promise<QueueView> {return this.serialize(async()=>{
    await this.beforeQueueMutation();this.checkRevision(command);
    await this.changeQueue(draft=>draft.move(entryId,direction));return this.view();
  },command,['move',entryId,direction]);}
}
