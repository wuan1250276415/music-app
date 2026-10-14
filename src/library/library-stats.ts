import type {DatabaseSync} from 'node:sqlite';
import type {LibraryStats} from '../shared/contracts.js';
import type {CatalogRepository} from './catalog.js';

// Count credit memberships after collecting distinct eligible credit IDs. The
// old OR join evaluated a recording subquery across the item/member product.
// No cached totals: every call reflects current visibility, identity and edits.
export function libraryStats(db:DatabaseSync,catalog:CatalogRepository):LibraryStats {
  return db.prepare(`WITH active_terms AS MATERIALIZED (
    SELECT artist_credit_id,release_track_id FROM playable_item INDEXED BY playable_item_search_cover
    WHERE visible=1 AND library_state='active'
  ), source_artists AS MATERIALIZED (
    SELECT DISTINCT artist_id FROM artist_credit_member INDEXED BY idx_credit_artist WHERE role='performer'
  ), selected_recordings AS (${catalog.recordingArtistSelectionIdsSql()}), credit_ids AS (
    SELECT artist_credit_id credit_id FROM active_terms WHERE artist_credit_id IS NOT NULL
    UNION
    SELECT rec.artist_credit_id credit_id FROM selected_recordings s JOIN recording rec ON rec.id=s.recording_id
    WHERE rec.id IN (SELECT recording_id FROM playable_item NOT INDEXED WHERE visible=1 AND library_state='active')
  ) SELECT
    (SELECT COUNT(*) FROM library_root) roots,
    (SELECT COUNT(*) FROM playable_item p NOT INDEXED WHERE p.visible=1 AND p.library_state='active'
      AND p.file_id IN (SELECT id FROM media_file NOT INDEXED WHERE status='online')) tracks,
    (SELECT COUNT(DISTINCT COALESCE(ai.identity_artist_id,s.artist_id)) FROM source_artists s
      LEFT JOIN artist_identity_binding ai ON ai.source_artist_id=s.artist_id
      WHERE EXISTS (SELECT 1 FROM artist_credit_member c INDEXED BY idx_credit_artist
        WHERE c.artist_id=s.artist_id AND c.role='performer' AND c.credit_id IN (SELECT credit_id FROM credit_ids))) artists,
    (SELECT COUNT(DISTINCT m.release_id) FROM release_track t NOT INDEXED JOIN medium m ON m.id=t.medium_id
      WHERE t.id IN (SELECT release_track_id FROM active_terms)) albums,
    (SELECT COUNT(*) FROM media_file NOT INDEXED WHERE status='missing') unavailable`).get() as unknown as LibraryStats;
}
