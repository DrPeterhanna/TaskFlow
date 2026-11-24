import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, PersonalTaskRepo, SyncEngine, migrate } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';
import { createSqliteStore } from '../src/store/sqliteStore.js';
import { Bridge } from './bridgeClient.js';

/** LOCAL PostgreSQL only (bridge). Needs migration 0020 (and 0019). Nothing here touches Supabase. */
const bridge = new Bridge();
beforeAll(async () => { await bridge.start(); }, 90_000);
afterAll(() => bridge.stop());

async function device(uid: string) {
  const db = openNodeSqlite(); migrate(db);
  const outbox = new Outbox(db);
  const engine = new SyncEngine(db, outbox, bridge.client(uid), undefined, () => 0);
  return { db, outbox, engine, repo: new PersonalTaskRepo(db, outbox) };
}
type Dev = Awaited<ReturnType<typeof device>>;
async function synced(a: Dev, b: Dev, title: string) { const id = a.repo.create(title); await a.engine.push(); await b.engine.pull('personal_tasks'); return id; }
const srv = async (id: string) => (await bridge.sql(`select status, title, deleted_at is not null, row_version from app.personal_tasks where id = '${id}'`))[0]!;
const rejected = (d: Dev) => d.db.all<{ rpc: string; error_code: string }>("select rpc, error_code from outbox where state = 'rejected'");

describe('conditional complete / reopen / delete (real local PG)', () => {
  it('delete vs a remote edit: refused, the remote edit survives, nothing is lost; "apply mine" then deletes with a fresh base', async () => {
    const uid = await bridge.user('k1@test.dev');
    const uid2 = uid; const db = openNodeSqlite();
    const store = createSqliteStore(db, bridge.client(uid2), { autoSync: false });
    const b = await device(uid);
    store.add('Doc'); await store.sync(); await b.engine.pull('personal_tasks');
    const id = b.repo.list()[0]!.id;
    b.repo.update(id, { title: 'Doc, edited on B' }); await b.engine.push();
    store.remove(id);                                    // device A deletes from a stale copy
    await store.sync();
    expect((await srv(id))[2]).toBe(false);              // still live on the server
    expect((await srv(id))[1]).toBe('Doc, edited on B'); // B's edit is intact
    const item = store.getState().inbox!.find((i) => i.kind === 'rejected');
    expect(item).toMatchObject({ code: 'stale_conflict' });
    store.keepMineAfterConflict!((item as { seq: number }).seq);
    await new Promise((r) => setTimeout(r, 300)); await store.sync();
    expect((await srv(id))[2]).toBe(true);               // now deleted, by an explicit fresh operation
  });
  it('a refused delete stays refused for the same op id even if the task changes back', async () => {
    const uid = await bridge.user('k2@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Back');
    b.repo.update(id, { title: 'Changed' }); await b.engine.push();
    a.repo.remove(id);
    expect((await a.engine.push()).rejected).toBe(1);
    const op = a.db.all<{ op_id: string; args_json: string }>("select op_id, args_json from outbox where state = 'rejected'")[0]!;
    b.repo.update(id, { title: 'Back' }); await b.engine.push();                          // values change back
    const again = await bridge.client(uid).call('delete_personal_task_checked', JSON.parse(op.args_json), op.op_id);
    expect(again).toMatchObject({ ok: false, code: 'stale_conflict' });                    // terminal stored refusal
    expect((await srv(id))[2]).toBe(false);
  });
  it('own queued ops before a delete are not mistaken for a conflict (create, edit, complete, delete offline, then push)', async () => {
    const uid = await bridge.user('k3@test.dev');
    const a = await device(uid);
    const id = a.repo.create('Short lived');
    a.repo.update(id, { title: 'Short lived 2' }); a.repo.complete(id); a.repo.remove(id);
    const rep = await a.engine.push();
    expect(rep.rejected).toBe(0); expect(rejected(a)).toEqual([]);
    expect(await srv(id)).toEqual(['done', 'Short lived 2', true, 4]);
  });
  it('a foreign edit that lands between this device\'s own ops is detected: the queued delete is refused, not applied', async () => {
    const uid = await bridge.user('k4@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Shared');
    a.repo.update(id, { title: 'A title' });              // queued
    a.repo.remove(id);                                     // queued behind it
    b.repo.update(id, { notes: 'B notes' }); await b.engine.push();   // B edits a DIFFERENT field first
    const rep = await a.engine.push();
    expect(rep.acked).toBe(1); expect(rep.rejected).toBe(1);
    expect(rejected(a)).toEqual([{ rpc: 'delete_personal_task_checked', error_code: 'stale_conflict' }]);
    const row = await bridge.sql(`select title, notes, deleted_at is not null from app.personal_tasks where id = '${id}'`);
    expect(row).toEqual([['A title', 'B notes', false]]);  // both edits survive, task not deleted
  });
  it('complete vs a remote cancel: refused; "apply mine" pulls, then completes with a fresh base', async () => {
    const uid = await bridge.user('k5@test.dev'); const db = openNodeSqlite();
    const store = createSqliteStore(db, bridge.client(uid), { autoSync: false });
    const b = await device(uid);
    store.add('Finish'); await store.sync(); await b.engine.pull('personal_tasks');
    const id = b.repo.list()[0]!.id;
    b.repo.update(id, { status: 'canceled' } as never); await b.engine.push();
    store.toggle(id); await store.sync();                    // A completes from a stale copy
    expect((await srv(id))[0]).toBe('canceled');
    const item = store.getState().inbox!.find((i) => i.kind === 'rejected');
    expect(item).toMatchObject({ code: 'stale_conflict' });
    store.keepMineAfterConflict!((item as { seq: number }).seq);
    await new Promise((r) => setTimeout(r, 300)); await store.sync();
    expect((await srv(id))[0]).toBe('done');
  });
  it('delete of a task already deleted elsewhere is an idempotent success', async () => {
    const uid = await bridge.user('k6@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Twice');
    b.repo.remove(id); await b.engine.push();
    a.repo.remove(id);
    const rep = await a.engine.push();
    expect(rep.rejected).toBe(0); expect(rep.acked).toBe(1);   // already deleted on the server: idempotent success, nothing resurrected
    await a.engine.pull('personal_tasks');
    expect(a.repo.get(id)).toBeUndefined();
    expect((await srv(id))[2]).toBe(true);
  });
});
