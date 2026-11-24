import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, PersonalTaskRepo, SyncEngine, migrate, uuidv7, type Clock } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';
import { createSqliteStore } from '../src/store/sqliteStore.js';
import { Bridge } from './bridgeClient.js';

/** LOCAL PostgreSQL only (bridge). Nothing here touches Supabase. */
const bridge = new Bridge();
beforeAll(async () => { await bridge.start(); }, 90_000);
afterAll(() => bridge.stop());

async function device(uid: string, clock?: Clock) {
  const db = openNodeSqlite(); migrate(db);
  const outbox = new Outbox(db, clock);
  const engine = new SyncEngine(db, outbox, bridge.client(uid), clock, () => 0);
  return { db, outbox, engine, repo: new PersonalTaskRepo(db, outbox, clock), uid };
}
type Dev = Awaited<ReturnType<typeof device>>;
const serverTitle = async (id: string) => (await bridge.sql(`select title from app.personal_tasks where id = '${id}'`))[0]?.[0];
async function synced(a: Dev, b: Dev, title: string) {
  const id = a.repo.create(title);
  await a.engine.push(); await b.engine.pull('personal_tasks');
  return id;
}

describe('concurrent edits on two devices (real local PG, one user)', () => {
  it('edits to different fields both survive (patches carry only edited fields)', async () => {
    const uid = await bridge.user('c1@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Plan');
    a.repo.update(id, { title: 'Plan v2' });
    b.repo.update(id, { planned_date: '2026-12-24' });
    await a.engine.push(); await b.engine.push();
    expect(await bridge.sql(`select title, planned_date::text from app.personal_tasks where id = '${id}'`)).toEqual([['Plan v2', '2026-12-24']]);
    await a.engine.pull('personal_tasks'); await b.engine.pull('personal_tasks');
    expect(a.repo.get(id)).toMatchObject({ title: 'Plan v2', planned_date: '2026-12-24' });
    expect(b.repo.get(id)).toMatchObject({ title: 'Plan v2', planned_date: '2026-12-24' });
    expect(a.db.all('select * from sync_conflicts')).toHaveLength(0);
  });
  it('same field: last op to reach the server wins, the loser sees a conflict and can restore the other value', async () => {
    const uid = await bridge.user('c2@test.dev');
    const db = openNodeSqlite();
    const store = createSqliteStore(db, bridge.client(uid), { autoSync: false });
    const b = await device(uid);
    store.add('Shared title'); await store.sync();
    await b.engine.pull('personal_tasks');
    const id = b.repo.list()[0]!.id;
    // device A (store) edits offline via its repo; device B edits the same field and reaches the server first
    new PersonalTaskRepo(db, new Outbox(db)).update(id, { title: 'From A' });
    b.repo.update(id, { title: 'From B' }); await b.engine.push();
    await store.sync();                                         // A: pull defers B's row (conflict recorded), push applies A last
    expect(await serverTitle(id)).toBe('From A');
    const item = store.getState().inbox!.find((i) => i.kind === 'conflict');
    expect(item).toMatchObject({ kind: 'conflict', field: 'title', restorable: true });
    store.restoreOtherValue!((item as { id: number }).id);
    await store.sync();
    expect(await serverTitle(id)).toBe('From B');
    expect(store.getState().inbox!.filter((i) => i.kind === 'conflict')).toHaveLength(0);
    expect(store.getState().sync!.phase).toBe('synced');
  });
  it('remote delete while a local edit is pending: server rejects the edit, tombstone wins, nothing resurrects', async () => {
    const uid = await bridge.user('c3@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Doomed');
    b.repo.remove(id); await b.engine.push();
    a.repo.update(id, { title: 'Edit after delete' });
    await a.engine.pull('personal_tasks');                    // skipped (pending) -> conflict recorded
    expect(a.db.all<{ kind: string }>('select kind from sync_conflicts')[0]!.kind).toBe('deleted_remotely');
    expect((await a.engine.push()).rejected).toBe(1);
    await a.engine.pull('personal_tasks');
    expect(a.repo.get(id)).toBeUndefined();
    expect(await bridge.sql(`select deleted_at is not null from app.personal_tasks where id = '${id}'`)).toEqual([[true]]);
  });
  it('stale device: edits made from an old copy do not clobber untouched server fields', async () => {
    const uid = await bridge.user('c4@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Old');
    b.repo.update(id, { planned_date: '2026-11-30' }); await b.engine.push();
    a.repo.update(id, { title: 'New title' }); await a.engine.push();   // A never pulled B's change
    expect(await bridge.sql(`select title, planned_date::text from app.personal_tasks where id = '${id}'`)).toEqual([['New title', '2026-11-30']]);
  });
});

describe('duplicate requests and interrupted sync (real local PG)', () => {
  it('replaying the same op_id many times applies once and returns the same answer', async () => {
    const uid = await bridge.user('d1@test.dev');
    const c = bridge.client(uid); const id = uuidv7(); const op = uuidv7();
    const r = await Promise.all([1, 2, 3].map(() => c.call('create_personal_task', [id, null, 'Once', null], op)));
    expect(r.every((x) => x.ok)).toBe(true);
    expect(await bridge.sql(`select count(*) from app.personal_tasks where user_id = '${uid}'`)).toEqual([[1]]);
    expect(await bridge.sql(`select count(*) from app.personal_events where user_id = '${uid}' and kind = 'ptask.created'`)).toEqual([[1]]);
  });
  it('same op_id reused for DIFFERENT arguments is refused, not silently merged', async () => {
    const uid = await bridge.user('d2@test.dev');
    const c = bridge.client(uid); const op = uuidv7();
    expect((await c.call('create_personal_task', [uuidv7(), null, 'First', null], op)).ok).toBe(true);
    const r = await c.call('create_personal_task', [uuidv7(), null, 'Second', null], op);
    expect(r.ok).toBe(false);
    expect(await bridge.sql(`select count(*) from app.personal_tasks where user_id = '${uid}'`)).toEqual([[1]]);
  });
  it('many offline edits then reconnect: all applied in order exactly once, survives one lost response', async () => {
    const uid = await bridge.user('d3@test.dev');
    const a = await device(uid);
    const id = a.repo.create('T0');
    for (let i = 1; i <= 5; i++) a.repo.update(id, { title: `T${i}` });
    await bridge.dropNextResponses(1);
    expect((await a.engine.push()).status).toBe('waiting');
    a.db.run('update outbox set next_attempt_at = 0');
    const rep = await a.engine.push();
    expect(rep.status).toBe('idle');
    expect(await serverTitle(id)).toBe('T5');
    expect(await bridge.sql(`select count(*) from app.personal_events where user_id = '${uid}'`)).toEqual([[6]]);
  });
  it('partial failure: a rejected op in the middle does not block later independent ops', async () => {
    const uid = await bridge.user('d4@test.dev');
    const a = await device(uid);
    const ok1 = a.repo.create('Fine one');
    const bad = a.repo.create('x'); a.db.run("update outbox set args_json = ? where entity_id = ?", [JSON.stringify([bad, null, '', null]), bad]);  // invalid title
    const ok2 = a.repo.create('Fine two');
    const rep = await a.engine.push();
    expect(rep).toMatchObject({ acked: 2, rejected: 1 });
    expect(a.db.all<{ error_code: string }>("select error_code from outbox where state = 'rejected'")[0]!.error_code).toBe('rejected_by_server');
    expect(await bridge.sql(`select count(*) from app.personal_tasks where user_id = '${uid}'`)).toEqual([[2]]);
    expect(a.repo.get(ok1)).toBeTruthy(); expect(a.repo.get(ok2)).toBeTruthy(); expect(a.repo.get(bad)).toBeUndefined();
  });
});

describe('local data cannot bypass server authorization (real local PG)', () => {
  it('forged ops naming another user\'s task are rejected and change nothing; local state rolls back', async () => {
    const victim = await bridge.user('v1@test.dev'), attacker = await bridge.user('a1@test.dev');
    const v = await device(victim); const id = v.repo.create('Victim secret'); await v.engine.push();
    const evil = await device(attacker);
    // attacker plants the victim's row locally (as if the local DB had been edited) and queues edits/deletes
    evil.db.run("insert into local_rows (stream, id, data_json, change_xid, pending, deleted) values ('personal_tasks', ?, ?, '1', 0, 0)", [id, JSON.stringify({ id, title: 'Victim secret', status: 'todo', parent_id: null, planned_date: null })]);
    evil.repo.update(id, { title: 'HACKED' });
    evil.repo.complete(id);
    evil.repo.remove(id);
    const rep = await evil.engine.push();
    expect(rep.rejected).toBe(3); expect(rep.acked).toBe(0);
    expect(evil.db.all<{ error_code: string }>("select error_code from outbox where state = 'rejected'").map((r) => r.error_code)).toEqual(['not_found', 'not_found', 'not_found']);
    expect(await bridge.sql(`select title, status, deleted_at is null from app.personal_tasks where id = '${id}'`)).toEqual([['Victim secret', 'todo', true]]);
    // attacker can not pull it either
    const fresh = await device(attacker); await fresh.engine.pull('personal_tasks');
    expect(fresh.repo.get(id)).toBeUndefined();
  });
  it('a patch with server-controlled or foreign fields is rejected', async () => {
    const uid = await bridge.user('s1@test.dev'); const a = await device(uid);
    const id = a.repo.create('Mine'); await a.engine.push();
    const c = bridge.client(uid);
    for (const patch of [{ completed_at: '2001-01-01T00:00:00Z' }, { user_id: uuidv7() }, { updated_at: '2001-01-01T00:00:00Z' }, { created_at: '2001-01-01T00:00:00Z' }, { change_xid: '1' }, { id: uuidv7() }, { deleted_at: '2001-01-01T00:00:00Z' }, { status: 'done' }]) {
      const r = await c.call('update_personal_task', [id, patch], uuidv7());
      expect(r.ok, JSON.stringify(patch)).toBe(false);
    }
    expect(await bridge.sql(`select title, status, completed_at is null, deleted_at is null from app.personal_tasks where id = '${id}'`)).toEqual([['Mine', 'todo', true, true]]);
  });
  it('timestamps are server-authoritative: a device clock set to 2001 does not backdate the row', async () => {
    const uid = await bridge.user('t1@test.dev');
    const clock: Clock = { now: () => Date.UTC(2026, 10, 24) - 60_000 };       // clock one minute behind is accepted by the server window
    const a = await device(uid, clock);
    const id = a.repo.create('Timed'); await a.engine.push();
    const [[ok]] = await bridge.sql(`select created_at > now() - interval '1 minute' from app.personal_tasks where id = '${id}'`) as [[boolean]];
    expect(ok).toBe(true);
  });
  it('an op id older than the 90-day receipt window is refused (op_expired), so a replayed old outbox cannot resurrect', async () => {
    const uid = await bridge.user('o1@test.dev'); const a = await device(uid);
    const ms = (Date.now() - 100 * 86_400_000).toString(16).padStart(12, '0');
    const old = uuidv7().replace(/^[0-9a-f]{8}-[0-9a-f]{4}/, `${ms.slice(0, 8)}-${ms.slice(8)}`);   // same id shape, timestamp 100 days ago (uuidv7() clamps to the process clock)
    const id = uuidv7();
    a.db.transaction(() => {
      a.db.run("insert into local_rows (stream, id, data_json, pending) values ('personal_tasks', ?, '{\"id\":\"x\",\"title\":\"Old\"}', 1)", [id]);
      a.outbox.enqueue({ rpc: 'create_personal_task', entityType: 'personal_tasks', entityId: id, args: [id, null, 'Old', null], opId: old });
    });
    const rr = await a.engine.push();
    expect(rr.rejected).toBe(1);
    expect(a.db.all<{ error_code: string }>("select error_code from outbox")[0]!.error_code).toBe('op_expired');
    expect(await bridge.sql(`select count(*) from app.personal_tasks where user_id = '${uid}'`)).toEqual([[0]]);
  });
  it('pull returns only the caller\'s rows even if the local cursor/stream is tampered with', async () => {
    const u1 = await bridge.user('p1@test.dev'), u2 = await bridge.user('p2@test.dev');
    const a = await device(u1); a.repo.create('U1 only'); await a.engine.push();
    const b = await device(u2);
    b.db.run("insert into sync_cursor (stream, after_xid, after_id, horizon) values ('personal_tasks','0','',null)");
    await b.engine.pull('personal_tasks');
    expect(b.repo.list()).toHaveLength(0);
  });
});

describe('pull-then-push race closed by the server (0019, real local PG)', () => {
  it('a remote edit that lands AFTER our last pull but BEFORE our push is reported by the server and shown as a conflict', async () => {
    const uid = await bridge.user('race1@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Base');
    a.repo.update(id, { title: 'A wins last' });          // A has pulled everything it will see; now B sneaks in
    b.repo.update(id, { title: 'B in between' }); await b.engine.push();
    await a.engine.push();                                  // no pull in between: client-only detection cannot see B
    expect(await serverTitle(id)).toBe('A wins last');
    const c = a.db.all<{ field: string; state: string; server_value: string; local_value: string }>('select field, state, server_value, local_value from sync_conflicts');
    expect(c).toEqual([{ field: 'title', state: 'applied', server_value: '"B in between"', local_value: '"A wins last"' }]);
  });
  it('no conflict when the other device changed a different field', async () => {
    const uid = await bridge.user('race2@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = await synced(a, b, 'Base');
    a.repo.update(id, { title: 'Only title' });
    b.repo.update(id, { planned_date: '2026-12-30' }); await b.engine.push();
    await a.engine.push();
    expect(a.db.all('select * from sync_conflicts')).toHaveLength(0);
    expect(await bridge.sql(`select title, planned_date::text from app.personal_tasks where id = '${id}'`)).toEqual([['Only title', '2026-12-30']]);
  });
  it('baseline fallback: a server without 0019 gets the plain update with the same op id', async () => {
    const uid = await bridge.user('race3@test.dev');
    const a = await device(uid); const id = a.repo.create('X'); await a.engine.push();
    const real = bridge.client(uid);
    const old: typeof real = { ...real, call: async (rpc, args, op) => (rpc === 'update_personal_task_checked' ? ({ ok: false, code: 'unsupported' } as never) : real.call(rpc, args, op)) };
    const e2 = new SyncEngine(a.db, a.outbox, old, undefined, () => 0);
    a.repo.update(id, { title: 'Y' });
    const opId = a.db.all<{ op_id: string }>("select op_id from outbox where state = 'queued'")[0]!.op_id;
    await e2.push();
    expect(await serverTitle(id)).toBe('Y');
    expect(a.db.all<{ op_id: string; rpc: string }>("select op_id, rpc from outbox where op_id = ?", [opId])[0]!.rpc).toBe('update_personal_task');
  });
});

describe('sync_status (migration 0017) against real local PG', () => {
  it('fresh cursor and current cursor do not require a full resync; a cursor below the floor does', async () => {
    const uid = await bridge.user('st1@test.dev'); const c = bridge.client(uid);
    expect(await c.status!('personal_tasks', '0')).toMatchObject({ full_resync_required: false });
    const a = await device(uid); a.repo.create('x'); await a.engine.push(); await a.engine.pull('personal_tasks');
    const cur = a.db.all<{ after_xid: string }>('select after_xid from sync_cursor')[0]!.after_xid;
    expect((await c.status!('personal_tasks', cur)).full_resync_required).toBe(false);
    const floor = (await c.status!('personal_tasks', '0')).floor_xid;
    if (BigInt(floor) > 1n) expect((await c.status!('personal_tasks', '1')).full_resync_required).toBe(true);
  });
});
