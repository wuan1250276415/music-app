import type {DatabaseSync,StatementSync} from 'node:sqlite';

// For private synchronous run/get/all callers only. Do not share iterators or
// statements with mutable return/binding options through this cache.
const caches=new WeakMap<DatabaseSync,Map<string,StatementSync>>();
const MAX_STATEMENTS=256,MAX_SQL_BYTES=65536;
export function sqlStatement(db:DatabaseSync,sql:string):StatementSync{
 if(Buffer.byteLength(sql,'utf8')>MAX_SQL_BYTES)return db.prepare(sql);
 let cache=caches.get(db);if(!cache){cache=new Map();caches.set(db,cache);}
 const old=cache.get(sql);if(old){cache.delete(sql);cache.set(sql,old);return old;}
 const statement=db.prepare(sql);cache.set(sql,statement);
 while(cache.size>MAX_STATEMENTS)cache.delete(cache.keys().next().value!);
 return statement;
}
export function clearSqlStatements(db:DatabaseSync):void{caches.delete(db);}
