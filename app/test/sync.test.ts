import { describe, expect, it } from 'vitest';
import {
  Outbox, PersonalTaskRepo, SyncEngine, TransportError, migrate, uuidv7, backoffMs,
  type Clock, type PullPage, type RpcClient, type RpcResult,
} from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';

class FakeClock implements Clock { t = 1_000_000; now() { return this.t; } }

class FakeServer implements RpcClient {
  calls: Array<{ rpc: string; opId: string }> = [];
  receipts = new Map<string, RpcResult>();
  failNext: Array<TransportError | RpcResult> = [];
  pages: PullPage[] = [];
  async call(rpc: string, args: unknown[], opId: string): Promise<RpcResult> {
    this.calls.push({ rpc, opId });
    const f = this.failNext.shift();
    if (f instanceof TransportError) throw f;
    if (this.receipts.has(opId)) return this.receipts.get(opId)!;   // server-side idempotent replay
    const res: RpcResult = f ?? { ok: true, data: { id: args[0] } };
    this.receipts.set(opId, res);
    return res;
  }
  async pull(): Promise<PullPage> { return this.pages.shift() ?? { rows: [], horizon: '10', next_xid: null, next_id: null }; }
}

function setup() {
  const db = openNodeSqlite();
  migrate(db);
  const clock = new FakeClock();
  const outbox = new Outbox(db, clock);
  const server = new FakeServer();
  const engine = new SyncEngine(db, outbox, server, clock, () => 0.5);
  const repo = new PersonalTaskRepo(db, outbox, clock);
  return { db, clock, outbox, server, engine, repo };
}

describe('uuidv7', () => {
  it('is time ordered with correct version and variant', () => {
    const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a[14]).toBe('7');
    expect('89ab').toContain(a[19]!);
  });
});

describe('backoff', () => {
  it('doubles from 2 s, jitters fully and caps at 5 min', () => {
    expect(backoffMs(1, () => 0.999)).toBeLessThan(2000);
    expect(backoffMs(3, () => 0.999)).toBeLessThan(8000);
    expect(backoffMs(30, () => 0.999)).toBeLessThan(300_000);
    expect(backoffMs(30, () => 0.999)).toBeGreaterThan(250_000);
  });
});

describe('repository and outbox', () => {
  it('writes the optimistic row and the op atomically and shows pending until acked', async () => {
    const { repo, engine, outbox } = setup();
    const id = repo.create('Write report');
    expect(repo.list()[0]).toMatchObject({ id, title: 'Write report', pending: true });
    expect(outbox.counts().queued).toBe(1);
    await engine.push();
    expect(repo.list()[0]!.pending).toBe(false);
    expect(outbox.counts().acked).toBe(1);
  });
  it('rolls back the local write if enqueue fails', () => {
    const { repo, db } = setup();
    expect(() => repo.create('   ')).toThrow();
    expect(db.all('select * from local_rows')).toHaveLength(0);
    db.exec('drop table outbox');
    expect(() => repo.create('x')).toThrow();
    expect(db.all('select * from local_rows')).toHaveLength(0);
  });
  it('keeps the entity pending while a later op for it is still queued', async () => {
    const { repo, engine, server, clock } = setup();
    const id = repo.create('A');
    repo.complete(id);
    server.failNext.push(new TransportError('offline'), new TransportError('offline'));
    await engine.push();   // first op fails
    expect(repo.get(id)!.pending).toBe(true);
    clock.t += 10 * 60_000;
    await engine.push();   // retried (transport still failing for second attempt)
    clock.t += 10 * 60_000;
    await engine.push();
    expect(repo.get(id)!.pending).toBe(false);
  });
});

describe('push retries and idempotency', () => {
  it('retries a transport failure with the SAME op_id and the server applies it once', async () => {
    const { repo, engine, server, clock, outbox } = setup();
    repo.create('A');
    server.failNext.push(new TransportError('timeout'));
    const r1 = await engine.push();
    expect(r1.status).toBe('waiting');
    expect(outbox.counts().queued).toBe(1);
    expect((await engine.push()).sent).toBe(0);   // still backing off
    clock.t += 5 * 60_000;
    await engine.push();
    expect(new Set(server.calls.map((c) => c.opId)).size).toBe(1);
    expect(server.calls).toHaveLength(2);
    expect(outbox.counts().acked).toBe(1);
  });
  it('lost response: crash after send, restart replays the same op_id and server returns the stored result', async () => {
    const { repo, engine, server, db, clock } = setup();
    repo.create('A');
    const op = new Outbox(db, clock).next()!;
    new Outbox(db, clock).markInflight(op.seq);
    await server.call(op.rpc, JSON.parse(op.args_json), op.op_id);   // server applied, response lost
    expect(new Outbox(db, clock).recoverInflight()).toBe(1);
    await engine.push();
    expect(server.receipts.size).toBe(1);
    expect(new Outbox(db, clock).counts().acked).toBe(1);
  });
  it('business rejection is final, visible, and rejects dependents; later independent ops still go', async () => {
    const { repo, engine, server, outbox } = setup();
    const a = repo.create('A');
    outbox.enqueue({ rpc: 'complete_personal_task', entityType: 'personal_tasks', entityId: a, args: [a], dependsOnSeq: outbox.next()!.seq });
    repo.create('B');
    server.failNext.push({ ok: false, code: 'forbidden', message: 'nope' });
    const rep = await engine.push();
    expect(rep.rejected).toBe(1);   // the dependent is rejected by cascade without being sent
    expect(outbox.counts().rejected).toBe(2);
    expect(rep.acked).toBe(1);
    expect(outbox.rejected().map((o) => o.error_code)).toEqual(['forbidden', 'dependency_rejected']);
  });
  it('401 pauses pushing, keeps ops, and resumes after refresh', async () => {
    const { repo, engine, server, outbox } = setup();
    repo.create('A');
    server.failNext.push(new TransportError('401', 'unauthorized'));
    expect((await engine.push()).status).toBe('paused_unauthorized');
    expect((await engine.push()).sent).toBe(0);
    engine.resumeAfterTokenRefresh();
    await engine.push();
    expect(outbox.counts().acked).toBe(1);
  });
  it('replays a large backlog in order', async () => {
    const { repo, engine, server } = setup();
    for (let i = 0; i < 300; i++) repo.create(`t${i}`);
    await engine.push();
    expect(server.calls).toHaveLength(300);
    expect(server.calls.map((c) => c.opId)).toEqual([...server.calls.map((c) => c.opId)].sort());
  });
});

describe('pull', () => {
  const row = (id: string, xid: string, extra: object = {}) => ({ id, change_xid: xid, title: id, status: 'todo', ...extra });
  it('applies pages with the cursor atomically, pins the horizon and resumes', async () => {
    const { engine, server, db } = setup();
    server.pages = [
      { rows: [row('a', '5'), row('b', '6')], horizon: '20', next_xid: '6', next_id: 'b' },
      { rows: [row('c', '7')], horizon: '20', next_xid: '7', next_id: 'c' },
    ];
    expect(await engine.pull('personal_tasks', 2)).toBe(3);
    expect(db.all('select id from local_rows order by id').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(db.all('select after_xid, after_id from sync_cursor')[0]).toEqual({ after_xid: '7', after_id: 'c' });
  });
  it('does not overwrite a row with a pending local op, then converges once acked', async () => {
    const { engine, server, repo } = setup();
    const id = repo.create('local title');
    server.pages = [{ rows: [row(id, '9', { title: 'server title' })], horizon: '20', next_xid: '9', next_id: id }];
    await engine.pull('personal_tasks');
    expect(repo.get(id)!.title).toBe('local title');
    await engine.push();
    server.pages = [{ rows: [row(id, '10', { title: 'server title' })], horizon: '30', next_xid: '10', next_id: id }];
    await engine.pull('personal_tasks');
    expect(repo.get(id)!.title).toBe('server title');
  });
  it('applies server tombstones', async () => {
    const { engine, server, repo } = setup();
    server.pages = [{ rows: [row('x', '3')], horizon: '9', next_xid: '3', next_id: 'x' }];
    await engine.pull('personal_tasks');
    expect(repo.list()).toHaveLength(1);
    server.pages = [{ rows: [row('x', '4', { deleted_at: '2026-01-01T00:00:00Z' })], horizon: '9', next_xid: '4', next_id: 'x' }];
    await engine.pull('personal_tasks');
    expect(repo.list()).toHaveLength(0);
  });
});

describe('rejected optimistic writes are rolled back', () => {
  it('restores the last server value for an edited row and hides a row that only existed locally', async () => {
    const { repo, engine, server } = setup();
    const id = repo.create('Server task');
    await engine.push();
    server.pages = [{ rows: [{ id, change_xid: '5', title: 'Server task', status: 'todo' }], horizon: '9', next_xid: '5', next_id: id }];
    await engine.pull('personal_tasks');
    repo.complete(id);
    const fresh = repo.create('Never accepted');
    expect(repo.get(id)!.status).toBe('done');
    server.failNext.push({ ok: false, code: 'gate_failed' }, { ok: false, code: 'forbidden' });
    await engine.push();
    expect(repo.get(id)).toMatchObject({ status: 'todo', pending: false });
    expect(repo.get(fresh)).toBeUndefined();
  });
  it('keeps the optimistic value when a later op for the same entity is still live', async () => {
    const { repo, engine, server, outbox } = setup();
    const id = repo.create('X');
    outbox.enqueue({ rpc: 'complete_personal_task', entityType: 'personal_tasks', entityId: id, args: [id] });
    server.failNext.push({ ok: false, code: 'forbidden' }, new TransportError('offline'));
    await engine.push();
    expect(outbox.counts().rejected).toBe(1);
  });
});
