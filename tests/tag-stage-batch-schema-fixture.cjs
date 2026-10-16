// Reverse only an empty new domain when explicitly constructing a historical
// fixture. A user database or a batch containing evidence must never use this.
const assert=require('node:assert/strict');
exports.restorePre81=db=>{
 require('./tag-commit-batch-schema-fixture.cjs').restorePre82(db);
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tag_stage_batch'").get())return;
 assert.equal(db.isTransaction,false);for(const table of ['tag_stage_batch_command','tag_stage_batch_item','tag_stage_batch'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,'Historical fixture cannot discard batch evidence');
 db.exec('BEGIN IMMEDIATE');try{db.exec('DROP TABLE tag_stage_batch_command; DROP TABLE tag_stage_batch_item; DROP TABLE tag_stage_batch; COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
};
