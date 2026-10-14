import type {PlaybackState} from '../shared/contracts.js';
export interface PauseObservation {token:number;itemId:string;generation:number}
// One lease per actual paused session/generation; periodic status cannot extend it.
export class PauseRelease{
 private timer:NodeJS.Timeout|null=null;private key:string|null=null;private lease=0;private closed=false;
 constructor(private readonly token:()=>number,private readonly release:(observation:PauseObservation,valid:()=>boolean)=>Promise<unknown>,private readonly delayMs=60000){}
 observe(state:PlaybackState):void{
  if(this.closed)return;
  if(state.state!=='paused'||!state.itemId){if(this.key!==null)this.cancel();return;}
  const observation={token:this.token(),itemId:state.itemId,generation:state.asioDsd?.generation??state.asio?.generation??state.clock?.generation??0},key=JSON.stringify(observation);
  if(key===this.key)return;this.cancel();this.key=key;const lease=this.lease;
  this.timer=setTimeout(()=>{
   this.timer=null;void this.release(observation,()=>!this.closed&&lease===this.lease&&this.key===key).catch(error=>console.error('[pause-release]',error));
  },this.delayMs);this.timer.unref();
 }
 cancel():void{++this.lease;if(this.timer)clearTimeout(this.timer);this.timer=null;this.key=null;}
 close():void{this.closed=true;this.cancel();}
}
