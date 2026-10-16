// Reverse only the empty restore domain when constructing explicit pre-v80 fixtures.
const assert=require('node:assert/strict');
const {tagRestoreSchema}=require('../dist/main/library/tag-restore-schema.js'),{tagRestoreRecoverySchema}=require('../dist/main/library/tag-restore-recovery-schema.js'),{tagRestoreReprobeSchema}=require('../dist/main/library/tag-restore-reprobe-schema.js');
exports.restoreSchema79=db=>{
 if(!db.prepare('PRAGMA table_info(tag_restore_operation)').all().some(row=>row.name==='attempt_number'))return;
 const tables=['tag_restore_reprobe_release','tag_restore_reprobe','tag_restore_inspection','tag_restore_receipt','tag_restore_operation'];
 for(const table of tables)assert.equal(db.prepare('SELECT COUNT(*) n FROM '+table).get().n,0,'Historical fixture downgrade cannot remove restore evidence');
 assert.equal(db.isTransaction,false);const foreign=Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys);db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{for(const table of tables)db.exec('DROP TABLE '+table);db.exec(tagRestoreSchema+tagRestoreRecoverySchema+tagRestoreReprobeSchema);assert.equal(db.prepare('PRAGMA foreign_key_check').get(),undefined);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}finally{db.exec('PRAGMA foreign_keys='+foreign);}
};
