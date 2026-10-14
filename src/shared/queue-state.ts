import type { QueueState } from './contracts.js';

export function validQueueState(value: unknown): value is QueueState {
  if (!value || typeof value!=='object') return false;
  const state=value as QueueState;
  if (!Array.isArray(state.entries)||state.entries.length>500||
    state.entries.some(entry=>!entry||typeof entry.id!=='string'||entry.id.length>128||typeof entry.itemId!=='string'||entry.itemId.length>128||
      entry.playlistEntryId!==undefined&&(typeof entry.playlistEntryId!=='string'||entry.playlistEntryId.length>128))) return false;
  const ids=state.entries.map(entry=>entry.id);
  if (new Set(ids).size!==ids.length || !['off','one','all'].includes(state.repeat) || typeof state.shuffle!=='boolean' ||
    !Number.isSafeInteger(state.revision)||state.revision<0) return false;
  if (!Array.isArray(state.order)||state.order.length!==ids.length||new Set(state.order).size!==ids.length||state.order.some(id=>!ids.includes(id))) return false;
  if (state.currentEntryId!==null && !ids.includes(state.currentEntryId)) return false;
  if (state.currentEntryId===null && ids.length>0) return false;
  if (!Number.isInteger(state.orderCursor)||state.orderCursor<-1||state.orderCursor>=state.order.length||
    (ids.length>0 && state.order[state.orderCursor]!==state.currentEntryId)) return false;
  if (!Array.isArray(state.history)||state.history.length>1000||state.history.some(id=>!ids.includes(id))||
    !Number.isInteger(state.historyCursor)||state.historyCursor<-1||state.historyCursor>=state.history.length) return false;
  return ids.length===0 ? state.orderCursor===-1 && state.historyCursor===-1 : state.history[state.historyCursor]===state.currentEntryId;
}
