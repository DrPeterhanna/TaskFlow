import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Outbox, PersonalTaskRepo, SyncEngine, TransportError, deriveSyncPhase, migrate, type PullPage, type RpcClient, type RpcResult } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';
import { createSqliteStore } from '../src/store/sqliteStore.js';

const dir = mkdtempSync(join(tmpdir(), 'tf-restart-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = () => join(dir, `db${n++}.sqlite`);

/** Server that applies each distinct op_id exactly once (receipts) and can lose responses or go down. */
class Srv implements RpcClient {
  applied: string[] = []; receipts = new Set<string>(); down = false; loseResponse = 0; pages: PullPage[] = []; pullFailAfter = Infinity; pulls = 0; afters: string[] = [];
  async call(_rpc: string, args: unknown[], opId: string): Promise<RpcResult> {
    if (this.down) throw new TransportError('offline', 'network');
    if (!this.receipts.has(opId)) { this.receipts.add(opId); this.applied.push(opId); }
    if (this.loseResponse > 0) { this.loseResponse--; throw new TransportError('response lost', 'network'); }
    return { ok: true, data: { id: args[0] } };
  }
  async pull(_s: string, ax: string): Promise<PullPage> {
    this.afters.push(ax);
    if (this.pulls++ >= this.pullFailAfter) throw new TransportError('dropped mid-pull', 'network');
    return this.pages.shift() ?? ({ rows: [], horizon: '9', next_xid: null, next_id: null } as unknown as PullPage);
  }
}
const open = (f: string) => { const db = openNodeSqlite(f); migrate(db); return db; };

describe('queued operations survive restart (file-backed SQLite, node driver; device adapter NOT tested)', () => {
  it('ops written offline are still queued after the process restarts and are then sent once', async () => {
    const f = file(); const srv = new Srv(); srv.down = true;
    let db = open(f); let outbox = new Outbox(db);
    const repo = new PersonalTaskRepo(db, outbox);
    const id = repo.create('Offline one'); repo.update(id, { title: 'Offline two' });
    await new SyncEngine(db, outbox, srv, undefined, () => 0).push();
    db.close!();
    db = open(f); outbox = new Outbox(db);      // "restart"
    expect(outbox.counts().queued).toBe(2);
    expect(new PersonalTaskRepo(db, outbox).list()[0]).toMatchObject({ title: 'Offline two', pending: true });
    srv.down = false;
    const rep = await new SyncEngine(db, outbox, srv, undefined, () => 0).push();
    expect(rep.acked).toBe(2);
    expect(srv.applied).toHaveLength(2);
  });
  it('killed mid-send: the inflight op returns to queued with the SAME op_id and the server applies it once', async () => {
    const f = file(); const srv = new Srv(); srv.loseResponse = 1;
    let db = open(f); let outbox = new Outbox(db);
    new PersonalTaskRepo(db, outbox).create('Crash me');
    const opId = db.all<{ op_id: string }>('select op_id from outbox')[0]!.op_id;
    // the app dies after the request left but before the result was stored: simulate by marking inflight then closing
    outbox.markInflight(1);
    await expect(srv.call('create_personal_task', ['x'], opId)).rejects.toThrow();   // server applied, client never saw the answer
    db.close!();
    db = open(f); outbox = new Outbox(db);
    expect(outbox.counts().inflight).toBe(1);
    expect(outbox.recoverInflight()).toBe(1);
    const rep = await new SyncEngine(db, outbox, srv, undefined, () => 0).push();
    expect(rep.acked).toBe(1);
    expect(srv.applied).toEqual([opId]);        // applied exactly once, resend was a replay
  });
  it('store startup recovers inflight ops without any call from the UI', async () => {
    const f = file(); const srv = new Srv();
    let db = open(f); const outbox = new Outbox(db);
    new PersonalTaskRepo(db, outbox).create('Pending at kill'); outbox.markInflight(1); db.close!();
    db = openNodeSqlite(f);
    const store = createSqliteStore(db, srv, { autoSync: false });
    expect(store.getState().sync).toMatchObject({ queued: 1 });
    await store.sync();
    expect(store.getState()).toMatchObject({ waiting: 0 });
    expect(srv.applied).toHaveLength(1);
  });
  it('a pull interrupted between pages resumes from the stored cursor, not from zero', async () => {
    const f = file(); const srv = new Srv();
    const pg = (xid: string, id: string, more: boolean): PullPage => ({ rows: [{ id, change_xid: xid, title: id, status: 'todo', parent_id: null, planned_date: null }], horizon: '50', next_xid: xid, next_id: id, ...(more ? {} : {}) } as unknown as PullPage);
    srv.pages = [pg('11', 'a', true)]; srv.pullFailAfter = 1;
    let db = open(f); let outbox = new Outbox(db);
    await expect(new SyncEngine(db, outbox, srv).pull('personal_tasks', 1)).rejects.toThrow();
    db.close!();
    db = open(f); outbox = new Outbox(db);
    expect(db.all<{ after_xid: string }>('select after_xid from sync_cursor')[0]!.after_xid).toBe('11');
    srv.pullFailAfter = Infinity; srv.afters = [];
    await new SyncEngine(db, outbox, srv).pull('personal_tasks', 1);
    expect(srv.afters[0]).toBe('11');
    expect(db.all('select * from local_rows')).toHaveLength(1);
  });
  it('a failed transaction leaves no half-written state (row without op, or op without row)', () => {
    const f = file(); const db = open(f); const outbox = new Outbox(db);
    expect(() => db.transaction(() => {
      db.run("insert into local_rows (stream, id, data_json, pending) values ('personal_tasks','z','{}',1)");
      outbox.enqueue({ rpc: 'create_personal_task', entityType: 'personal_tasks', entityId: 'z', args: ['z'] });
      throw new Error('crash inside transaction');
    })).toThrow();
    expect(db.all('select * from local_rows')).toHaveLength(0);
    expect(db.all('select * from outbox')).toHaveLength(0);
  });
  it('reopening an existing database does not re-run migrations or lose data', () => {
    const f = file(); let db = open(f); new PersonalTaskRepo(db, new Outbox(db)).create('Keep'); db.close!();
    db = open(f); db.close!(); db = open(f);
    expect(db.all('select * from local_rows')).toHaveLength(1);
    expect(db.all<{ version: number }>('select max(v) as version from schema_version')[0]!.version).toBeGreaterThanOrEqual(3);
  });
});

describe('sync phase derivation', () => {
  const base = { online: true, syncing: false, authPaused: false, queued: 0, inflight: 0, rejected: 0, openConflicts: 0, nextRetryAt: null, now: 1000 };
  it.each([
    [{}, 'synced'],
    [{ queued: 2 }, 'syncing'],
    [{ queued: 2, nextRetryAt: 5000 }, 'waiting_retry'],
    [{ queued: 2, online: false }, 'offline'],
    [{ syncing: true }, 'syncing'],
    [{ authPaused: true, online: false, queued: 1 }, 'auth_required'],
    [{ rejected: 1 }, 'attention'],
    [{ openConflicts: 1 }, 'attention'],
    [{ rejected: 1, queued: 1 }, 'syncing'],
  ] as const)('%j -> %s', (o, phase) => { expect(deriveSyncPhase({ ...base, ...o })).toBe(phase); });
});
