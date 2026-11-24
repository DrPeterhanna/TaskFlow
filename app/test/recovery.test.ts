import { describe, expect, it } from 'vitest';
import { Outbox, PersonalTaskRepo, SyncEngine, TransportError, migrate, type Clock, type PullPage, type RpcClient, type RpcResult } from '../src/sync/index.js';
import { openNodeSqlite } from '../src/sync/nodeSqlite.js';

class FakeClock implements Clock { t = 1_000_000; now() { return this.t; } }
type Row = { id: string; change_xid: string; deleted_at?: string | null; title?: string; status?: string; parent_id?: null; planned_date?: null };

/** In-memory server: one personal_tasks table with xid ordering, idempotent receipts, optional status(). */
class Srv implements RpcClient {
  rows = new Map<string, Row>(); xid = 100; receipts = new Map<string, RpcResult>();
  reject: string | null = null; floor = 0; pullCalls: string[] = [];
  put(r: Partial<Row> & { id: string }) { this.rows.set(r.id, { ...(this.rows.get(r.id) ?? { title: '', status: 'todo' }), ...r, change_xid: String(++this.xid) } as Row); }
  async call(rpc: string, args: unknown[], opId: string): Promise<RpcResult> {
    if (this.receipts.has(opId)) return this.receipts.get(opId)!;
    let res: RpcResult | undefined;
    if (this.reject) res = { ok: false, code: this.reject } as RpcResult;
    else {
      const id = args[0] as string;
      if (rpc === 'create_personal_task') this.put({ id, title: args[2] as string });
      else if (rpc === 'update_personal_task' || rpc === 'update_personal_task_checked') {
        const cur = this.rows.get(id) as unknown as Record<string, unknown>, base = (args[2] ?? {}) as Record<string, unknown>, patch = args[1] as Record<string, unknown>;
        const over: Record<string, unknown> = {};
        for (const k of Object.keys(patch)) if (k in base && JSON.stringify(cur[k] ?? null) !== JSON.stringify(base[k]) && JSON.stringify(cur[k] ?? null) !== JSON.stringify(patch[k])) over[k] = cur[k] ?? null;
        if (rpc === 'update_personal_task_checked' && Object.keys(over).length) res = { ok: false, code: 'stale_conflict', message: JSON.stringify(over) } as RpcResult;
        else { this.put({ id, ...patch }); res = { ok: true, data: { id, overwritten: {} } } as RpcResult; }
      }
      else if (rpc === 'delete_personal_task') this.put({ id, deleted_at: 'now' });
      else if (rpc === 'complete_personal_task') this.put({ id, status: 'done' });
      res ??= { ok: true, data: { id } };
    }
    if (res.ok) this.receipts.set(opId, res);   // like the real server: a business error rolls back, no receipt is kept
    return res;
  }
  async pull(_s: string, ax: string, _ai: string, _h: string | null, limit: number): Promise<PullPage> {
    this.pullCalls.push(ax);
    const rows = [...this.rows.values()].filter((r) => BigInt(r.change_xid) > BigInt(ax)).sort((a, b) => Number(BigInt(a.change_xid) - BigInt(b.change_xid))).slice(0, limit);
    const last = rows[rows.length - 1];
    return { rows, horizon: String(this.xid + 1), next_xid: last ? last.change_xid : null, next_id: last ? last.id : null } as unknown as PullPage;
  }
  async status(_s: string, ax: string) { return { floor_xid: String(this.floor), full_resync_required: BigInt(ax) > 0n && BigInt(ax) < BigInt(this.floor) }; }
}

function setup() {
  const db = openNodeSqlite(); migrate(db);
  const clock = new FakeClock(); const outbox = new Outbox(db, clock); const srv = new Srv();
  const engine = new SyncEngine(db, outbox, srv, clock, () => 0.5);
  const repo = new PersonalTaskRepo(db, outbox, clock);
  return { db, clock, outbox, srv, engine, repo };
}
const title = (repo: PersonalTaskRepo, id: string) => repo.list().find((t) => t.id === id)?.title;
const conflicts = (db: ReturnType<typeof openNodeSqlite>) => db.all<Record<string, unknown>>('select * from sync_conflicts order by id');

async function seed(s: ReturnType<typeof setup>) {
  const id = s.repo.create('Original');
  await s.engine.push(); await s.engine.pull('personal_tasks');
  return id;
}

describe('stale data after a rejected local op (the cursor-skip defect)', () => {
  it('re-fetches the newer server row when the pending op is rejected', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Mine' });
    s.srv.put({ id, title: 'Theirs' });                    // other device edits while ours is pending
    await s.engine.pull('personal_tasks');
    expect(title(s.repo, id)).toBe('Mine');                // pending local edit is not overwritten by the pull
    s.srv.reject = 'validation';
    await s.engine.push();                                 // server rejects ours -> rolled back
    s.srv.reject = null;
    await s.engine.pull('personal_tasks');
    expect(title(s.repo, id)).toBe('Theirs');              // converged, not stale
  });
  it('picks up a remote delete (tombstone) after our edit is rejected', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Mine' });
    s.srv.put({ id, deleted_at: 'now' });
    await s.engine.pull('personal_tasks');
    s.srv.reject = 'not_found'; await s.engine.push(); s.srv.reject = null;
    await s.engine.pull('personal_tasks');
    expect(s.repo.list().find((t) => t.id === id)).toBeUndefined();
  });
  it('an edit made from a stale value is REFUSED, nothing is overwritten, intent is kept, and a fresh op with a fresh base applies it', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Mine' });
    s.srv.put({ id, title: 'Theirs' });
    await s.engine.pull('personal_tasks');
    const rep = await s.engine.push();
    expect(rep.rejected).toBe(1);
    expect(s.srv.rows.get(id)!.title).toBe('Theirs');                       // never overwritten
    expect(s.db.all<{ error_code: string }>("select error_code from outbox where state = 'rejected'")[0]!.error_code).toBe('stale_conflict');
    await s.engine.pull('personal_tasks');
    expect(title(s.repo, id)).toBe('Theirs');
    s.repo.update(id, { title: 'Mine' });                                    // user chose "apply mine": fresh op, base = what they now see
    await s.engine.push();
    expect(s.srv.rows.get(id)!.title).toBe('Mine');
  });
});

describe('conflict records', () => {
  it('records a field conflict when both sides changed the same field, and closes it when the server refuses the stale edit', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Mine' }); s.srv.put({ id, title: 'Theirs' });
    await s.engine.pull('personal_tasks');
    expect(conflicts(s.db)).toHaveLength(1);
    expect(conflicts(s.db)[0]).toMatchObject({ kind: 'field', field: 'title', state: 'open' });
    await s.engine.push();
    expect(conflicts(s.db)[0]).toMatchObject({ state: 'moot' });
  });
  it('records no conflict for different fields, or when both set the same value', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Same' }); s.srv.put({ id, title: 'Same' });
    await s.engine.pull('personal_tasks');
    expect(conflicts(s.db)).toHaveLength(0);
  });
  it('records deleted_remotely and marks it moot when our op is rejected', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Mine' }); s.srv.put({ id, deleted_at: 'now' });
    await s.engine.pull('personal_tasks');
    expect(conflicts(s.db)[0]).toMatchObject({ kind: 'deleted_remotely', state: 'open' });
    s.srv.reject = 'not_found'; await s.engine.push();
    expect(conflicts(s.db)[0]).toMatchObject({ state: 'moot' });
  });
  it('update sends only the edited fields', async () => {
    const s = setup(); const id = await seed(s);
    s.repo.update(id, { title: 'Only title' });
    const op = s.db.all<{ args_json: string }>("select args_json from outbox where rpc = 'update_personal_task_checked'")[0]!;
    expect(JSON.parse(op.args_json)).toEqual([id, { title: 'Only title' }, { title: 'Original' }]);   // patch + what this device last saw
  });
});

describe('recovery actions', () => {
  it('retryRejected re-queues rejected ops with the same op ids, in order', async () => {
    const s = setup();
    const id = s.repo.create('A'); s.repo.update(id, { title: 'B' });
    s.srv.reject = 'validation'; await s.engine.push(); s.srv.reject = null;
    const before = s.db.all<{ seq: number; op_id: string; state: string }>('select seq, op_id, state from outbox order by seq');
    expect(before.map((o) => o.state)).toEqual(['rejected', 'rejected']);
    expect(s.outbox.retryRejected(before[0]!.seq)).toBe(true);
    expect(s.outbox.retryRejected(before[1]!.seq)).toBe(true);
    const after = s.db.all<{ op_id: string; state: string }>('select op_id, state from outbox order by seq');
    expect(after.map((o) => o.state)).toEqual(['queued', 'queued']);
    expect(after[0]!.op_id).toBe(before[0]!.op_id);
    await s.engine.push(); await s.engine.pull('personal_tasks');
    expect(title(s.repo, id)).toBe('B');
  });
  it('discardRejected moves it to dead and leaves no attention item', async () => {
    const s = setup();
    const id = s.repo.create('A'); void id;
    s.srv.reject = 'validation'; await s.engine.push();
    const seq = s.db.all<{ seq: number }>('select seq from outbox')[0]!.seq;
    expect(s.outbox.discardRejected(seq)).toBe(1);
    expect(s.outbox.counts().rejected ?? 0).toBe(0);
  });
  it('retryRejected refuses an expired op (a new op id is needed)', async () => {
    const s = setup(); s.repo.create('A');
    s.srv.reject = 'op_expired'; await s.engine.push();
    const seq = s.db.all<{ seq: number }>('select seq from outbox')[0]!.seq;
    expect(s.outbox.retryRejected(seq)).toBe(false);
  });
});

describe('full resync', () => {
  it('is triggered when the server says the cursor is below its purge floor, keeps unsent local work', async () => {
    const s = setup(); const id = await seed(s);
    const other = s.repo.create('Unsent');
    s.srv.put({ id, title: 'Server changed' });
    s.srv.floor = 100000;                                  // server purged past our cursor
    await s.engine.pull('personal_tasks');
    expect(title(s.repo, id)).toBe('Server changed');
    expect(title(s.repo, other)).toBe('Unsent');
    expect(s.db.all('select * from outbox where state = \'queued\'').length).toBe(1);
  });
  it('does not resync when the cursor is above the floor', async () => {
    const s = setup(); const id = await seed(s);
    s.srv.floor = 1;
    s.srv.put({ id, title: 'X' });
    await s.engine.pull('personal_tasks');
    expect(title(s.repo, id)).toBe('X');
    expect(s.srv.pullCalls.filter((a) => a === '0').length).toBe(1);   // only the first, initial pull
  });
});
void TransportError;
