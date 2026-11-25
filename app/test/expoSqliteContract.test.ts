/** Native adapter contract over a node SQLite mock. NOT actual Expo/native filesystem execution. */
import {DatabaseSync} from 'node:sqlite';
import {expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({names:[] as string[],db:null as unknown}));
vi.mock('expo-sqlite',()=>({openDatabaseSync:(name:string)=>{
 state.names.push(name);const d=state.db as DatabaseSync;
 return {execSync:(sql:string)=>d.exec(sql),closeSync:()=>d.close(),runSync:(sql:string,p:unknown[])=>d.prepare(sql).run(...p as never[]),getAllSync:(sql:string,p:unknown[])=>d.prepare(sql).all(...p as never[])};
}}));
import {openAccountDb} from '../src/store/expoSqliteDriver';
import {createSqliteStore} from '../src/store/sqliteStore';
import {type RpcClient} from '../src/sync';
const owner='12345678-1234-1234-1234-123456789abc';
it('Expo adapter API maps SQL mutations/results and checked offline store semantics',()=>{
 state.db=new DatabaseSync(':memory:');const db=openAccountDb(owner,'http://127.0.0.1:54321');
 const store=createSqliteStore(db,{} as RpcClient,{autoSync:false});store.add('Native interface');const id=store.getState().tasks[0]!.id;store.rename!(id,'Checked interface','Native interface');expect(store.getState().tasks[0]).toMatchObject({title:'Checked interface',pending:true});expect(db.all('select * from outbox')).toHaveLength(2);
 expect(state.names.at(-1)).toContain(owner);expect(state.names.at(-1)).toContain('54321');store.dispose?.();db.close?.();
});
it('nested failed transaction rolls back inner write without losing outer write',()=>{
 state.db=new DatabaseSync(':memory:');const db=openAccountDb(owner,'http://127.0.0.1:54321');db.exec('create table example (n integer)');
 db.transaction(()=>{db.run('insert into example values (?)',[1]);try{db.transaction(()=>{db.run('insert into example values (?)',[2]);throw Error('abort inner');});}catch{}db.transaction(()=>db.run('insert into example values (?)',[3]));});expect(db.all('select n from example')).toEqual([{n:1},{n:3}]);
 expect(()=>db.transaction(()=>{db.run('insert into example values (?)',[4]);throw Error('abort all');})).toThrow();expect(db.all('select n from example')).toHaveLength(2);db.close?.();
});
it('invalid owner cannot open a native database or escape filename partition',()=>{
 const before=state.names.length;expect(()=>openAccountDb('../other','http://127.0.0.1:54321')).toThrow();expect(state.names).toHaveLength(before);
});
