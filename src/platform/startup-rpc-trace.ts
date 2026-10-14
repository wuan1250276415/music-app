import {performance} from 'node:perf_hooks';

// Test-only, bounded method timing. Never serialize parameters, results, paths,
// exception messages or credentials. No file/network I/O on normal startup.
export class StartupRpcTrace {
  private readonly enabled=process.env.AURAL_TEST==='1'&&process.env.AURAL_STARTUP_PROFILE==='1';
  private readonly began=performance.now();
  private remaining=64;
  constructor(private readonly source:'main'|'library'){}
  begin(method:string):((ok:boolean)=>void)|undefined {
    if(!this.enabled||this.remaining<=0||performance.now()-this.began>30000||!/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(method))return;
    this.remaining--;const receivedAt=performance.now();let finished=false;
    return ok=>{if(finished)return;finished=true;console.error('AURAL_STARTUP_RPC '+JSON.stringify({source:this.source,method,receivedMs:receivedAt-this.began,durationMs:performance.now()-receivedAt,ok}));};
  }
}
