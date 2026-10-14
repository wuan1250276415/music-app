import {randomUUID} from 'node:crypto';
import type {LibraryDatabase} from './database.js';
import type {ScanState} from '../shared/contracts.js';
import {ScanManager} from './scan-manager.js';

const contexts=new WeakMap<LibraryDatabase,{manager:ScanManager;listeners:Set<(state:ScanState)=>void>}>();
// The public scan helper uses one pipeline per database, including overlapping callers.
export async function scanRoot(db:LibraryDatabase,rootId:string,publish:(state:ScanState)=>void):Promise<void>{
 let context=contexts.get(db);if(!context){const listeners=new Set<(state:ScanState)=>void>(),manager=new ScanManager(db,state=>{for(const listener of listeners){try{listener(state);}catch{/* Listener failure cannot interrupt checkpoint writes. */}}},()=>{});context={manager,listeners};contexts.set(db,context);}
 const listener=(state:ScanState)=>{if(state.rootId===rootId)publish(state);};context.listeners.add(listener);
 try{const result=context.manager.command({commandId:randomUUID(),action:'start',rootId});if(result.status!=='saved'||!result.job)throw new Error(result.error);await context.manager.wait(result.job.id);}finally{context.listeners.delete(listener);}
}
