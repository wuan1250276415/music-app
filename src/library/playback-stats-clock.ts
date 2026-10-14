import type {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
export class PlaybackStatsClock {
 private installed=false;private readonly epoch=randomUUID();
 constructor(private readonly db:DatabaseSync){}
 stamp(counts:boolean,recency:boolean):string {
  if(!counts&&!recency)return '';
  if(!this.installed){
   this.db.exec('SAVEPOINT aural_stats_clock_setup');
   try{this.db.exec(`
    CREATE TEMP TABLE aural_stats_clock(id INTEGER PRIMARY KEY CHECK(id=1),counts INTEGER NOT NULL CHECK(counts BETWEEN 0 AND 9007199254740991),recency INTEGER NOT NULL CHECK(recency BETWEEN 0 AND 9007199254740991));
    INSERT INTO aural_stats_clock VALUES(1,0,0);
    CREATE TEMP TRIGGER aural_stats_insert AFTER INSERT ON main.playback_item_stats BEGIN UPDATE aural_stats_clock SET counts=counts+(NEW.play_count!=0),recency=recency+1 WHERE id=1;END;
    CREATE TEMP TRIGGER aural_stats_delete AFTER DELETE ON main.playback_item_stats BEGIN UPDATE aural_stats_clock SET counts=counts+(OLD.play_count!=0),recency=recency+1 WHERE id=1;END;
    CREATE TEMP TRIGGER aural_stats_update AFTER UPDATE ON main.playback_item_stats BEGIN UPDATE aural_stats_clock SET counts=counts+(NEW.play_count!=OLD.play_count),recency=recency+(NEW.last_played_at!=OLD.last_played_at OR NEW.last_played_basis!=OLD.last_played_basis) WHERE id=1;END;
    `);this.db.exec('RELEASE aural_stats_clock_setup');this.installed=true;
   }catch(error){this.db.exec('ROLLBACK TO aural_stats_clock_setup;RELEASE aural_stats_clock_setup');throw error;}
  }
  const row=this.db.prepare('SELECT counts,recency FROM temp.aural_stats_clock WHERE id=1').get() as {counts:number;recency:number};
  const external=this.db.prepare('PRAGMA main.data_version').get() as {data_version:number};
  return `:stats:${this.epoch}:${counts?row.counts:'-'}:${recency?row.recency:'-'}:${external.data_version}`;
 }
}
