import { randomUUID } from 'node:crypto';
import type { QueueEntry, QueueState, RepeatMode } from '../shared/contracts.js';
import { validQueueState } from '../shared/queue-state.js';
export { validQueueState } from '../shared/queue-state.js';

const MAX_ENTRIES=500;
const empty=():QueueState=>({entries:[],currentEntryId:null,repeat:'off',shuffle:false,order:[],orderCursor:-1,history:[],historyCursor:-1,revision:0});

export class PlaybackQueue {
  private state:QueueState;
  constructor(initial?:unknown, private readonly rng:()=>number=Math.random) {
    this.state=validQueueState(initial) ? structuredClone(initial) : empty();
  }
  snapshot():QueueState { return structuredClone(this.state); }
  currentItemId():string|null { return this.entryItem(this.state.currentEntryId); }
  private entryItem(id:string|null):string|null {return this.state.entries.find(entry=>entry.id===id)?.itemId??null;}
  private shuffleIds(ids:string[]):string[] {
    const out=[...ids];
    for(let i=out.length-1;i>0;i--){const j=Math.floor(this.rng()*(i+1));[out[i],out[j]]=[out[j],out[i]];}
    return out;
  }
  start(itemId:string,contextIds?:string[]):string {
    const context=contextIds?.slice(0,MAX_ENTRIES) ?? [];
    if (!context.includes(itemId)) context.unshift(itemId);
    context.splice(MAX_ENTRIES);
    return this.startAt(context.map(itemId=>({itemId})),context.indexOf(itemId));
  }
  startAt(context:Array<{itemId:string;playlistEntryId?:string}>,startIndex:number):string {
    if(!context.length||context.length>MAX_ENTRIES||!Number.isInteger(startIndex)||startIndex<0||startIndex>=context.length)throw new Error('无效播放条目位置');
    const entries:QueueEntry[]=context.map(value=>({id:randomUUID(),...value}));
    const current=entries[startIndex];
    const order=this.state.shuffle ? [current.id,...this.shuffleIds(entries.filter(entry=>entry.id!==current.id).map(entry=>entry.id))] : entries.map(entry=>entry.id);
    const cursor=order.indexOf(current.id);
    this.state={...this.state,entries,currentEntryId:current.id,order,orderCursor:cursor,history:[current.id],historyCursor:0,revision:this.state.revision+1};
    return current.itemId;
  }
  jump(entryId:string):string {
    const itemId=this.entryItem(entryId);
    if (!itemId) throw new Error('队列曲目不存在');
    this.state.currentEntryId=entryId;
    this.state.orderCursor=this.state.order.indexOf(entryId);
    this.state.history=[entryId];this.state.historyCursor=0;this.state.revision++;
    return itemId;
  }
  next(automatic=false):string|null {
    const current=this.state.currentEntryId;
    if (!current) return null;
    if (automatic&&this.state.repeat==='one') return this.entryItem(current);
    if (this.state.historyCursor<this.state.history.length-1) {
      const next=this.state.history[++this.state.historyCursor];
      this.state.currentEntryId=next;this.state.orderCursor=this.state.order.indexOf(next);this.state.revision++;
      return this.entryItem(next);
    }
    let cursor=this.state.orderCursor+1;
    if (cursor>=this.state.order.length) {
      if (this.state.repeat!=='all') return null;
      if (this.state.shuffle && this.state.order.length>1) {
        const remaining=this.state.order.filter(id=>id!==current);
        this.state.order=[...this.shuffleIds(remaining),current];
      }
      cursor=0;
    }
    const next=this.state.order[cursor];
    this.state.currentEntryId=next;this.state.orderCursor=cursor;
    this.state.history=this.state.history.slice(0,this.state.historyCursor+1);
    this.state.history.push(next);
    if (this.state.history.length>1000) this.state.history.shift();
    this.state.historyCursor=this.state.history.length-1;
    this.state.revision++;
    return this.entryItem(next);
  }
  previous(elapsedSeconds:number):string|null {
    const current=this.state.currentEntryId;
    if (!current) return null;
    if (elapsedSeconds>3 || this.state.historyCursor<=0) return this.entryItem(current);
    const previous=this.state.history[--this.state.historyCursor];
    this.state.currentEntryId=previous;this.state.orderCursor=this.state.order.indexOf(previous);this.state.revision++;
    return this.entryItem(previous);
  }
  setRepeat(mode:RepeatMode):void {if(!['off','one','all'].includes(mode))throw new Error('无效循环模式');this.state.repeat=mode;this.state.revision++;}
  setShuffle(enabled:boolean):void {
    if(this.state.shuffle===enabled)return;
    this.state.shuffle=enabled;
    const current=this.state.currentEntryId;
    this.state.order=enabled&&current ? [current,...this.shuffleIds(this.state.entries.filter(entry=>entry.id!==current).map(entry=>entry.id))] : this.state.entries.map(entry=>entry.id);
    this.state.orderCursor=current ? this.state.order.indexOf(current) : -1;
    this.state.history=current?[current]:[];this.state.historyCursor=current?0:-1;this.state.revision++;
  }
  remove(entryId:string):void {
    if(entryId===this.state.currentEntryId)throw new Error('当前播放项不能从队列移除');
    if(!this.entryItem(entryId))throw new Error('队列曲目不存在');
    this.state.entries=this.state.entries.filter(entry=>entry.id!==entryId);
    this.state.order=this.state.order.filter(id=>id!==entryId);
    this.state.orderCursor=this.state.order.indexOf(this.state.currentEntryId!);
    const played=this.state.history.slice(0,this.state.historyCursor+1).filter(id=>id!==entryId);
    const future=this.state.history.slice(this.state.historyCursor+1).filter(id=>id!==entryId);
    this.state.history=[...played,...future];this.state.historyCursor=played.length-1;this.state.revision++;
  }
  move(entryId:string,direction:-1|1):void {
    const index=this.state.entries.findIndex(entry=>entry.id===entryId);
    const target=index+direction;
    if(index<0||target<0||target>=this.state.entries.length)throw new Error('无法移动队列曲目');
    [this.state.entries[index],this.state.entries[target]]=[this.state.entries[target],this.state.entries[index]];
    if(!this.state.shuffle){this.state.order=this.state.entries.map(entry=>entry.id);this.state.orderCursor=this.state.order.indexOf(this.state.currentEntryId!);}
    this.state.revision++;
  }
}
