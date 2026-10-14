// Seeds are private SQL fragments; selected identities remain bound values.
// Expand the tree and its memberships once per statement, rather than once
// for every playable item. IN de-duplicates membership across both branches;
// recursive UNION still prevents revisiting identities in the chosen tree.
export function genreItemCondition(seed:string,descendants:boolean,activeDescendants=true):string{
 return `p.id IN(WITH RECURSIVE chosen(id) AS(${seed}${descendants?` UNION SELECT g.id FROM genre g JOIN chosen c ON g.parent_id=c.id${activeDescendants?' WHERE g.archived=0':''}`:''})
  SELECT ig.item_id FROM chosen c CROSS JOIN item_genre ig INDEXED BY idx_genre_item WHERE ig.genre_id=c.id
  UNION ALL SELECT genre_item.id FROM chosen c CROSS JOIN release_genre rg INDEXED BY idx_release_genre_reverse
  CROSS JOIN medium genre_medium CROSS JOIN release_track genre_track
  CROSS JOIN playable_item genre_item INDEXED BY idx_item_release_track
  WHERE rg.genre_id=c.id AND genre_medium.release_id=rg.release_id
  AND genre_track.medium_id=genre_medium.id AND genre_item.release_track_id=genre_track.id)`;
}
