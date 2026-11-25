import { it, expect } from 'vitest';
import { saveTaskTitle } from '../src/store/taskTitleEdit';
import { createSqliteStore } from '../src/store/sqliteStore';
import { openNodeSqlite } from '../src/sync/nodeSqlite';
import type { RpcClient } from '../src/sync';

it('trims title and only signals success after durable write returns', () => {
  const calls: unknown[] = [];
  expect(saveTaskTitle({rename:(...args)=>{calls.push(args);}},'id','  New title  ')).toEqual({ok:true});
  expect(calls).toEqual([['id','New title',undefined]]);
  expect(saveTaskTitle({rename:()=>{throw Error('disk full');}},'id','Keep draft')).toEqual({ok:false,reason:'storage'});
});
it('invalid or unsupported edits do not mutate the store', () => {
  let calls=0;const store={rename:()=>{calls++;}};
  expect(saveTaskTitle(store,'id','  ')).toEqual({ok:false,reason:'invalid'});
  expect(saveTaskTitle(store,'id','a'.repeat(301))).toEqual({ok:false,reason:'invalid'});
  expect(saveTaskTitle({},'id','Good')).toEqual({ok:false,reason:'unsupported'});
  expect(calls).toBe(0);
});
it('rename persists optimistic text and queues a checked edit behind own create, no network needed', () => {
  const db=openNodeSqlite();const store=createSqliteStore(db,{} as RpcClient,{autoSync:false});
  store.add('Original');const id=store.getState().tasks[0]!.id;
  store.rename!(id,'Edited offline');
  expect(store.getState().tasks[0]).toMatchObject({id,title:'Edited offline',pending:true});
  const ops=db.all<{rpc:string;args_json:string;depends_on_seq:number}>('select rpc,args_json,depends_on_seq from outbox order by seq');
  expect(ops[1]!.rpc).toBe('update_personal_task_checked');
  expect(JSON.parse(ops[1]!.args_json)).toEqual([id,{title:'Edited offline'},{title:'Original'}]);
  expect(ops[1]!.depends_on_seq).toBeTruthy();
  store.dispose?.();db.close?.();
});

it('refuses a stale editor without replacing newer local text or poisoning storage', () => {
  const db=openNodeSqlite();const store=createSqliteStore(db,{} as RpcClient,{autoSync:false});
  store.add('Original');const id=store.getState().tasks[0]!.id;
  store.rename!(id,'Newer remote or local value');
  expect(saveTaskTitle(store,id,'Older draft','Original')).toEqual({ok:false,reason:'storage'});
  expect(store.getState().tasks[0]!.title).toBe('Newer remote or local value');
  expect(store.getState().sync?.blocked).not.toBe('local_storage_error');
  expect(db.all('select * from outbox')).toHaveLength(2);
  store.dispose?.();db.close?.();
});
