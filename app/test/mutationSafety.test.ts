import { describe, expect, it } from 'vitest';
import { Outbox, PersonalTaskRepo, SyncEngine, migrate, TransportError } from '../src/sync/index';
import { openNodeSqlite } from '../src/sync/nodeSqlite';
import type { RpcClient } from '../src/sync/types';
const setup = () => { const db = openNodeSqlite(); migrate(db); const outbox = new Outbox(db); return { db, outbox, repo: new PersonalTaskRepo(db, outbox) }; };
describe('mutation invariants', () => {
  it('chains own edit bases and explicit parent/create dependencies', () => {
    const { db, repo } = setup(); const p = repo.create('parent'); const child = repo.create('child', { parentId: p });
    repo.update(child, { title: 'second' }); repo.update(child, { title: 'third', notes: 'N' });
    const ops = db.all<{ seq: number; depends_on_seq: number | null; args_json: string }>('select * from outbox order by seq');
    expect(ops.map(o => o.depends_on_seq)).toEqual([null, ops[0]!.seq, ops[1]!.seq, ops[2]!.seq]);
    expect(JSON.parse(ops[3]!.args_json)[2]).toEqual({ title: 'second', notes: null }); db.close?.();
  });
  it('marks dirty subtree unsafe instead of omitting the guard', () => {
    const { db, repo } = setup(); const p = repo.create('parent'); repo.create('child', { parentId: p }); repo.remove(p);
    const args = JSON.parse(db.all<{args_json: string}>("select args_json from outbox where rpc = 'delete_personal_task_checked'")[0]!.args_json);
    expect(args[1].subtree).toEqual({ n: -1, sum: -1, members: [] }); db.close?.();
  });
  it('does not rewrite transmitted delete payload on late own-op acknowledgement or retry', async () => {
    const { db, repo, outbox } = setup(); const id = repo.create('parent'); repo.remove(id);
    const del = db.all<{seq: number; args_json: string}>("select seq, args_json from outbox where rpc = 'delete_personal_task_checked'")[0]!;
    outbox.markInflight(del.seq); outbox.retryLater(del.seq, 0);
    const rpc: RpcClient = { call: async () => ({ ok: true, data: {} }), pull: async () => ({ rows: [], horizon: '1', next_xid: null, next_id: null }) };
    await new SyncEngine(db, outbox, rpc).push();
    expect(db.all<{args_json: string}>('select args_json from outbox where seq = ?', [del.seq])[0]!.args_json).toBe(del.args_json);
    expect(() => db.run('update outbox set args_json = ? where seq = ?', ['[]', del.seq])).toThrow('immutable'); db.close?.();
  });
  it('replays byte-identical args after a lost response', async () => {
    const { db, repo, outbox } = setup(); repo.create('durable'); let first = true; const seen: string[] = [];
    const rpc: RpcClient = { call: async (fn, args, op) => { seen.push(JSON.stringify([fn,args,op])); if (first) { first = false; throw new TransportError('lost'); } return { ok: true, data: {} }; }, pull: async () => ({ rows: [], horizon: '1', next_xid: null, next_id: null }) };
    const engine = new SyncEngine(db, outbox, rpc); await engine.push(); db.run('update outbox set next_attempt_at = 0'); await engine.push();
    expect(seen).toHaveLength(2); expect(seen[1]).toBe(seen[0]); db.close?.();
  });
  it('terminal stale refusals cannot be requeued with the same operation ID', () => {
    const { db, repo, outbox } = setup(); repo.create('refused'); const op = outbox.next()!; outbox.reject(op.seq, 'stale_conflict');
    expect(outbox.retryRejected(op.seq)).toBe(false); expect(outbox.rejected()).toHaveLength(1); db.close?.();
  });
});

it('old hosted delete semantics are blocked before transmitting destructive intent', async () => {
  const db=openNodeSqlite(); migrate(db); const outbox=new Outbox(db); const repo=new PersonalTaskRepo(db,outbox); const id=repo.create('Root');
  let calls=0; const rpc: RpcClient={ call:async()=>{calls++;return {ok:true,data:{}};}, pull:async()=>({rows:[],horizon:'1',next_xid:null,next_id:null}),status:async()=>({floor_xid:'0',full_resync_required:false}) };
  const engine=new SyncEngine(db,outbox,rpc); await engine.push(); repo.remove(id); const result=await engine.push();
  expect(calls).toBe(1); expect(result.sent).toBe(0); expect(engine.blocked).toBe('server_update_required');
  expect(db.all<{state:string;transmitted_json:string|null}>("select state,transmitted_json from outbox where rpc='delete_personal_task_checked'")[0]).toEqual({state:'queued',transmitted_json:null}); db.close?.();
});

it('missing capability method cannot bypass destructive safety preflight',async()=>{
 const db=openNodeSqlite();migrate(db);const outbox=new Outbox(db);const repo=new PersonalTaskRepo(db,outbox);const id=repo.create('Preserve');let calls=0;
 const rpc:RpcClient={call:async()=>{calls++;return {ok:true,data:{}};},pull:async()=>({rows:[],horizon:'1',next_xid:null,next_id:null})};const engine=new SyncEngine(db,outbox,rpc);await engine.push();repo.remove(id);
 const result=await engine.push();expect(calls).toBe(1);expect(result.sent).toBe(0);expect(engine.blocked).toBe('server_update_required');expect(outbox.counts().queued).toBe(1);db.close?.();
});
