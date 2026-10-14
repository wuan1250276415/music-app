export type SystemMediaAction='play'|'pause'|'previous'|'next'|'stop'|'seek'|'repeat'|'shuffle';
export type SystemMediaState={status:'stopped'|'starting'|'ready'|'unavailable'|'unsupported';message:string;observedAt:number;platform:'windows';verified:false};
