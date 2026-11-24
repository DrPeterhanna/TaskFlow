import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Outbox, PersonalTaskRepo, SyncEngine, migrate } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';
import { Bridge } from './bridgeClient.js';

const bridge = new Bridge();
beforeAll(async () => { await bridge.start(); }, 90_000);
afterAll(() => bridge.stop());

async function device(uid: string) {
  const db = openNodeSqlite();
  migrate(db);
  const outbox = new Outbox(db);
  const engine = new SyncEngine(db, outbox, bridge.client(uid), undefined, () => 0);
  return { db, outbox, engine, repo: new PersonalTaskRepo(db, outbox) };
}

describe('TS client against LOCAL PostgreSQL RPCs (not Supabase)', () => {
  it('create -> push -> server row -> second device pulls it', async () => {
    const uid = await bridge.user('e2e1@test.dev');
    const a = await device(uid), b = await device(uid);
    const id = a.repo.create('Prepare weekly plan', { plannedDate: '2026-12-05' });
    expect((await a.engine.push()).acked).toBe(1);
    const srv = await bridge.sql(`select title, planned_date::text from app.personal_tasks where id = '${id}'`);
    expect(srv).toEqual([['Prepare weekly plan', '2026-12-05']]);
    expect(await b.engine.pull('personal_tasks')).toBe(1);
    expect(b.repo.get(id)).toMatchObject({ id, title: 'Prepare weekly plan', pending: false });
  });

  it('lost response: server applied, client times out, retries same op_id, no duplicate, pending converges', async () => {
    const uid = await bridge.user('e2e2@test.dev');
    const a = await device(uid);
    const id = a.repo.create('Call supplier');
    await bridge.dropNextResponses(1);
    expect((await a.engine.push()).status).toBe('waiting');
    expect(a.repo.get(id)!.pending).toBe(true);
    // op is waiting out its backoff; force it due and retry
    a.db.run('update outbox set next_attempt_at = 0');
    expect((await a.engine.push()).acked).toBe(1);
    expect(await bridge.sql(`select count(*) from app.personal_tasks where user_id = '${uid}'`)).toEqual([[1]]);
    expect(await bridge.sql(`select count(*) from app.personal_events where user_id = '${uid}' and kind = 'ptask.created'`)).toEqual([[1]]);
    expect(a.repo.get(id)!.pending).toBe(false);
  });

  it('server rejection (gate) is final and visible; local optimistic state converges to server truth after pull', async () => {
    const uid = await bridge.user('e2e3@test.dev');
    const a = await device(uid);
    const parent = a.repo.create('Parent');
    const child = a.repo.create('Child', { parentId: parent });
    await a.engine.push();
    a.repo.complete(parent);                       // optimistic: parent looks done
    expect(a.repo.get(parent)!.status).toBe('done');
    const rep = await a.engine.push();             // server: required subtask not done
    expect(rep.rejected).toBe(1);
    expect(a.outbox.rejected()[0]!.error_code).toBe('gate_failed');
    expect(a.repo.get(parent)!.status).toBe('todo');   // optimistic lie rolled back to server truth
    expect(a.repo.get(parent)!.pending).toBe(false);
    expect(child).toBeTruthy();
  });

  it('two devices: offline edits sync in order and RLS keeps users apart', async () => {
    const u1 = await bridge.user('e2e4@test.dev'), u2 = await bridge.user('e2e5@test.dev');
    const a = await device(u1), other = await device(u2);
    for (let i = 0; i < 25; i++) a.repo.create(`task ${i}`);
    await a.engine.push();
    expect(await other.engine.pull('personal_tasks')).toBe(0);
    const d2 = await device(u1);
    expect(await d2.engine.pull('personal_tasks', 10)).toBe(25);   // multiple pages
    expect(d2.repo.list()).toHaveLength(25);
  });
});
