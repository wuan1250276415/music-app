import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
// Connection-local triggers follow committed catalog mutations, including scanner writes between UI events.
export class BrowseClock{
 private installed=false;private readonly epoch=randomUUID();
 constructor(private readonly db:DatabaseSync){}
 stamp():string{
  if(!this.installed){
   const tables=this.db.prepare("SELECT name,sql FROM main.sqlite_schema WHERE type='table' ORDER BY name").all() as Array<{name:string;sql:string}>;
   const relevant=tables.filter(t=>/^(library_root|media_file|media_stream|playable_\w+|cue_\w+|search_gram|metadata_\w+|item_\w+|artist\w*|recording\w*|release\w*|medium|genre\w*|playlist\w*|catalog_change|entity_reference_\w+|external_ref|field_decision|provider_rights)$/.test(t.name)&&!/^CREATE\s+VIRTUAL\s+TABLE/i.test(t.sql??''));
   for(const name of ['library_root','media_file','playable_item','metadata_override','item_user_state','playlist_item'])if(!relevant.some(t=>t.name===name))throw new Error('曲库浏览缺少必要数据表');
   if(relevant.length>256)throw new Error('曲库浏览表预算超限');
   this.db.exec('SAVEPOINT aural_browse_setup');
   try{
    this.db.exec('CREATE TEMP TABLE aural_browse_clock(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991));INSERT INTO temp.aural_browse_clock VALUES(1,0);');
    for(const t of relevant)for(const event of ['INSERT','UPDATE','DELETE'])this.db.exec(`CREATE TEMP TRIGGER aural_browse_${t.name}_${event.toLowerCase()} AFTER ${event} ON main."${t.name}" BEGIN UPDATE aural_browse_clock SET revision=revision+1 WHERE id=1; END;`);
    this.db.exec('RELEASE aural_browse_setup');this.installed=true;
   }catch(e){this.db.exec('ROLLBACK TO aural_browse_setup;RELEASE aural_browse_setup');throw e;}
  }
  const row=this.db.prepare('SELECT revision FROM temp.aural_browse_clock WHERE id=1').get() as {revision:number};
  const external=this.db.prepare('PRAGMA main.data_version').get() as {data_version:number};
  return `${this.epoch}:${row.revision}:${external.data_version}`;
 }
}
