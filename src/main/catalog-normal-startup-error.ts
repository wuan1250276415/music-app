import {readNormalLibraryPermission,type NormalLibraryPermission} from '../shared/catalog-normal-open.js';
import type {RestoreRecoveryFailure} from '../shared/catalog-restore-recovery.js';

// Created only after the actual failed startup process has exited. A completed
// directory certificate alone cannot certify that the existing database opens.
export class CompletedLibraryStartupFailed extends Error{
 readonly permission:NormalLibraryPermission;
 constructor(permission:NormalLibraryPermission,readonly stage:RestoreRecoveryFailure['stage'],cause:unknown){
  super('已完成恢复的曲库启动未确认：'+String(cause instanceof Error?cause.message:cause).replace(/[\u0000-\u001f]/g,' ').slice(0,768),{cause});
  this.name='CompletedLibraryStartupFailed';this.permission=readNormalLibraryPermission(permission);
 }
}
