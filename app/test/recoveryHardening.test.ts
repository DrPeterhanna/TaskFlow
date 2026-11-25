import { describe, expect, it } from 'vitest';
import { createSqliteStore } from '../src/store/sqliteStore';
import { Outbox, PersonalTaskRepo, SyncEngine, migrate, TransportError } from '../src/sync/index';
import { openNodeSqlite } from '../src/sync/nodeSqlite';
import type { RpcClient, SqlDriver } from '../src/sync/types';
const empty = { rows: [], horizon: '10', next_xid: null, next_id: null };
const rpc = (): RpcClient => ({ call: async () => ({ ok: true, data: {} }), pull: async () => empty });
const seed = (db: SqlDriver) => { migrate(db); db.run("insert into local_rows (stream,id,data_json,change_xid,pending) values ('personal_tasks','saved',?,'2',0)", [JSON.stringify({ id: 'saved', title: 'Cached', status: 'todo' })]); };
const flush = async () => { for(let i=0;i<20;i++) await Promise.resolve(); };
describe('recovery hardening', () => {
  it('failed resync retains the entire usable cache and cursor', async () => {
    const db = openNodeSqlite(); seed(db); const b = new Outbox(db); const r = rpc(); r.pull = async () => { throw new TransportError('offline'); };
    db.run("insert into sync_cursor (stream,after_xid,after_id) values ('personal_tasks','2','saved')");
    await expect(new SyncEngine(db,b,r).fullResync('personal_tasks')).rejects.toThrow();
    expect(db.all('select * from local_rows')).toHaveLength(1); expect(db.all<{after_xid: string}>('select after_xid from sync_cursor')[0]!.after_xid).toBe('2'); db.close?.();
  });
  it('manual repair and normal sync never overlap network work', async () => {
    const db = openNodeSqlite(); seed(db); const r = rpc(); let release!: () => void; let calls = 0;
    r.pull = async () => { calls++; if (calls === 1) await new Promise<void>(r => { release = r; }); return empty; };
    const s = createSqliteStore(db,r,{autoSync:false}); const normal = s.sync(); await flush(); const repair = s.fullResync!();
    await flush(); expect(calls).toBe(1); release(); await normal; await repair; expect(calls).toBe(2); s.dispose?.(); db.close?.();
  });
  it('late successful pull after disposal cannot change local rows', async () => {
    const db = openNodeSqlite(); seed(db); const r = rpc(); let release!: () => void;
    r.pull = async () => { await new Promise<void>(r => {release=r;}); return {...empty, rows:[{id:'alien', change_xid:'4',title:'Late'}]}; };
    const s = createSqliteStore(db,r,{autoSync:false}); const p=s.sync(); await flush(); s.dispose?.(); release(); await p;
    expect(db.all("select * from local_rows where id='alien'")).toHaveLength(0); db.close?.();
  });
  it('disk write failure rolls back optimistic row+op and exposes recovery, never fake saved', () => {
    const db = openNodeSqlite(); migrate(db); const s=createSqliteStore(db,rpc(),{autoSync:false});
    db.exec("create trigger full_disk before insert on outbox begin select raise(abort, 'disk full'); end;");
    expect(()=>s.add('Keep my draft')).toThrow('storage'); expect(db.all('select * from local_rows')).toHaveLength(0); expect(db.all('select * from outbox')).toHaveLength(0);
    expect(s.getState().sync?.blocked).toBe('local_storage_error'); s.dispose?.(); db.close?.();
  });
  it('atomic cache replacement rolls back entirely if disk fails during resync', async () => {
    const db=openNodeSqlite(); seed(db); db.exec("create trigger full_disk before insert on local_rows begin select raise(abort, 'disk full'); end;");
    const r=rpc(); r.pull=async()=>({...empty,rows:[{id:'new',change_xid:'4'}]});
    await expect(new SyncEngine(db,new Outbox(db),r).fullResync('personal_tasks')).rejects.toThrow();
    expect(db.all<{id:string}>('select id from local_rows')).toEqual([{id:'saved'}]); db.close?.();
  });
  it('resync preserves pending intents while replacing confirmed cache', async () => {
    const db=openNodeSqlite(); seed(db); const b=new Outbox(db); const repo=new PersonalTaskRepo(db,b); const id=repo.create('Offline intent');
    await new SyncEngine(db,b,rpc()).fullResync('personal_tasks'); expect(repo.list()).toMatchObject([{id,title:'Offline intent',pending:true}]); expect(b.counts().queued).toBe(1); db.close?.();
  });
});

it('newer schema refuses downgrade instead of reinitializing or losing data', () => {
  const db=openNodeSqlite(); seed(db); db.run('insert into schema_version (v) values (999)');
  expect(()=>migrate(db)).toThrow('newer'); expect(db.all('select * from local_rows')).toHaveLength(1); db.close?.();
});

it('expired server rejection keeps the original intent and operation ID for user review', async () => {
  const db=openNodeSqlite(); migrate(db); const b=new Outbox(db); const repo=new PersonalTaskRepo(db,b); repo.create('Never silently lost'); const before=b.next()!;
  const r=rpc(); r.call=async()=>({ok:false,code:'op_expired'}); await new SyncEngine(db,b,r).push();
  const after=b.rejected()[0]!; expect(after.op_id).toBe(before.op_id); expect(after.args_json).toBe(before.args_json); expect(b.retryRejected(after.seq)).toBe(false); db.close?.();
});

it('backoff is not mistaken for disconnected when pull succeeds', async () => {
  const db=openNodeSqlite(); migrate(db); const s=createSqliteStore(db,rpc(),{autoSync:false}); s.add('Waiting');
  db.run('update outbox set next_attempt_at = ?', [Date.now()+60_000]); await s.sync();
  expect(s.getState().online).toBe(true); expect(s.getState().sync?.phase).toBe('waiting_retry'); s.dispose?.(); db.close?.();
});

it('interrupted multi-page resync never installs a partial snapshot or erases pending work', async () => {
  const db=openNodeSqlite(); seed(db); const b=new Outbox(db); const repo=new PersonalTaskRepo(db,b); const pending=repo.create('Pending intent');
  let calls=0; const r=rpc(); r.pull=async()=>{ if(calls++) throw new TransportError('page two lost'); return {rows:Array.from({length:200},(_,i)=>({id:`r${String(i).padStart(3,'0')}`,change_xid:'3'})),horizon:'10',next_xid:'3',next_id:'r199'}; };
  await expect(new SyncEngine(db,b,r).fullResync('personal_tasks')).rejects.toThrow();
  expect(db.all('select * from local_rows')).toHaveLength(2); expect(repo.get(pending)?.title).toBe('Pending intent'); expect(repo.get('saved')?.title).toBe('Cached'); expect(b.counts().queued).toBe(1); db.close?.();
});

it('cursor-floor repair removes stale confirmed resurrection but preserves unresolved local intent', async () => {
  const db=openNodeSqlite(); seed(db); const b=new Outbox(db); const repo=new PersonalTaskRepo(db,b); const pending=repo.create('Review before replay');
  db.run("insert into sync_cursor (stream,after_xid,after_id) values ('personal_tasks','2','saved')");
  const r=rpc(); r.status=async()=>({full_resync_required:true,floor_xid:'9'}); await new SyncEngine(db,b,r).pull('personal_tasks');
  expect(repo.get('saved')).toBeUndefined(); expect(repo.get(pending)?.pending).toBe(true); expect(b.next()?.args_json).toContain('Review before replay'); db.close?.();
});

it('corrupt database refuses opening without reset or silent replacement', async () => {
  const {mkdtempSync,writeFileSync,readFileSync,rmSync}=await import('node:fs'); const {tmpdir}=await import('node:os'); const {join}=await import('node:path');
  const dir=mkdtempSync(join(tmpdir(),'tf-corrupt-')); const file=join(dir,'account.db'); const bytes=Buffer.from('unreadable database preserves evidence'); writeFileSync(file,bytes);
  let db:SqlDriver|undefined;
  try { expect(()=>{db=openNodeSqlite(file); migrate(db);}).toThrow(); expect(readFileSync(file)).toEqual(bytes); }
  finally {db?.close?.();rmSync(dir,{recursive:true,force:true});}
});
