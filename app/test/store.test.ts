import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSqliteStore } from '../src/store/sqliteStore.js';
import { migrate } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';
import { Bridge } from './bridgeClient.js';

const bridge = new Bridge();
beforeAll(async () => { await bridge.start(); }, 90_000);
afterAll(() => bridge.stop());

describe('SQLite-backed store against LOCAL PostgreSQL (not Supabase)', () => {
  it('UI state: add shows pending at once, then settles after sync; second device sees it', async () => {
    const uid = await bridge.user('store1@test.dev');
    const store = createSqliteStore(openNodeSqlite(), bridge.client(uid), { autoSync: false });
    store.add('Order spare parts');
    expect(store.getState()).toMatchObject({ waiting: 1, tasks: [{ title: 'Order spare parts', pending: true, done: false }] });
    await store.sync();
    expect(store.getState()).toMatchObject({ waiting: 0, needAttention: 0, online: true });
    expect(store.getState().tasks[0]!.pending).toBe(false);
    const other = createSqliteStore(openNodeSqlite(), bridge.client(uid), { autoSync: false });
    await other.sync();
    expect(other.getState().tasks.map((t) => t.title)).toEqual(['Order spare parts']);
  });
  it('offline then online: changes survive and flush; transport failure keeps data and reports offline', async () => {
    const uid = await bridge.user('store2@test.dev');
    const db = openNodeSqlite();
    const store = createSqliteStore(db, bridge.client(uid), { autoSync: false });
    store.add('Written offline');
    await bridge.dropNextResponses(1);
    await store.sync();
    expect(store.getState()).toMatchObject({ online: false, waiting: 1 });
    db.run('update outbox set next_attempt_at = 0');
    await store.sync();
    expect(store.getState()).toMatchObject({ online: true, waiting: 0 });
    expect(await bridge.sql(`select count(*) from app.personal_tasks where user_id = '${uid}'`)).toEqual([[1]]);
  });
  it('restart: a new store on the same file recovers an inflight op with the same op_id', async () => {
    const uid = await bridge.user('store3@test.dev');
    const db = openNodeSqlite();
    const s1 = createSqliteStore(db, bridge.client(uid), { autoSync: false });
    s1.add('Crash test');
    db.run("update outbox set state = 'inflight', attempts = 1");   // app killed mid-send
    const before = db.all<{ op_id: string }>('select op_id from outbox')[0]!.op_id;
    const s2 = createSqliteStore(db, bridge.client(uid), { autoSync: false });
    await s2.sync();
    expect(db.all<{ op_id: string; state: string }>('select op_id, state from outbox')).toEqual([{ op_id: before, state: 'acked' }]);
    expect(migrate(db)).toBeGreaterThan(0);
  });
});
