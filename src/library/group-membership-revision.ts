import type {DatabaseSync} from 'node:sqlite';
// Fence edition membership ABA using the existing monotonic entity state.
export function bumpGroupMembership(db:DatabaseSync,ids:Array<string|null>):void {
 for(const id of new Set(ids.filter((id):id is string=>Boolean(id))))db.prepare("INSERT INTO entity_reference_state(entity_kind,entity_id,revision) VALUES('release_group',?,1) ON CONFLICT(entity_kind,entity_id) DO UPDATE SET revision=revision+1").run(id);
}
