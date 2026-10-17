const assert=require('node:assert/strict');
exports.restorePre86=db=>{
 if(!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='tag_backup_schedule'").get())return;
 assert.equal(db.isTransaction,false);
 for(const table of ['tag_backup_batch_command','tag_backup_batch_item','tag_backup_batch'])assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,'Historical fixture cannot discard cleanup batch evidence');
 assert.deepEqual(db.prepare('SELECT * FROM tag_backup_schedule').all().map(r=>({...r})),[{revision:0,command_id:null,request_json:null,enabled:0,origin:null,activation_id:null,created_at:0}]);
 db.exec('DROP TABLE tag_backup_batch_command;DROP TABLE tag_backup_batch_item;DROP TABLE tag_backup_batch;DROP TABLE tag_backup_schedule');
};
