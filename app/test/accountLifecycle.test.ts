import { describe, expect, it, vi } from 'vitest';
import { accountBoundRpc, accountPartition } from '../src/store/accountLifecycle';
import { createSqliteStore } from '../src/store/sqliteStore';
import { openNodeSqlite } from '../src/sync/nodeSqlite';
import { TransportError, type RpcClient, type RpcResult } from '../src/sync/types';

const empty = { rows: [], horizon: '1', next_xid: null, next_id: null };
function rpc(): RpcClient { return { call: vi.fn(async () => ({ ok: true as const, data: {} })), pull: vi.fn(async () => empty) }; }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
describe('account-bound worker lifecycle', () => {
  it('partitions account/environment with collision-free escaping', () => {
    const u = '00000000-0000-0000-0000-000000000001';
    expect(accountPartition('https://a', u)).not.toBe(accountPartition('https_3a_2f_2fa', u));
    expect(accountPartition('https://a', u)).not.toBe(accountPartition('https://b', u));
    expect(() => accountPartition('local', '../escape')).toThrow();
  });
  it('blocks new requests and late responses when account changes', async () => {
    let owner: string | null = 'A'; let release!: (r: RpcResult) => void;
    const raw = rpc(); raw.call = vi.fn(() => new Promise<RpcResult>(r => { release = r; }));
    const b = accountBoundRpc(raw, 'A', () => owner);
    const pending = b.call('x', [], 'op'); owner = 'B'; release({ ok: true as const, data: {} });
    await expect(pending).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(b.call('x', [], 'op')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(raw.call).toHaveBeenCalledTimes(1);
    b.dispose(); owner = 'A'; await expect(b.pull('p', '0', '', null, 10)).rejects.toThrow();
  });
  it('automatically resumes durable operations on cold boot without an edit', async () => {
    const db = openNodeSqlite(); const r = rpc();
    const s1 = createSqliteStore(db, r, { autoSync: false }); s1.add('durable'); s1.dispose?.();
    const s2 = createSqliteStore(db, r); await flush(); await s2.sync();
    expect(r.call).toHaveBeenCalledTimes(1); expect(s2.getState().waiting).toBe(0); s2.dispose?.(); db.close?.();
  });
  it('unauthorized pauses without retry spin, refreshed credentials resume same op', async () => {
    vi.useFakeTimers();
    const db = openNodeSqlite(); const r = rpc(); let denied = true;
    r.call = vi.fn(async () => { if (denied) throw new TransportError('expired', 'unauthorized'); return { ok: true as const, data: {} }; });
    const s = createSqliteStore(db, r); s.add('pending'); await s.sync();
    expect(s.getState().sync?.phase).toBe('auth_required');
    await vi.advanceTimersByTimeAsync(60_000); expect(r.call).toHaveBeenCalledTimes(1);
    const first = db.all<{op_id: string}>('select op_id from outbox')[0]!.op_id;
    denied = false; await s.connectivityRestored();
    expect(db.all<{op_id: string}>('select op_id from outbox')[0]!.op_id).toBe(first);
    expect(s.getState().waiting).toBe(0); s.dispose?.(); db.close?.(); vi.useRealTimers();
  });
  it('disposal rejects late remote data and leaves unsent work recoverable', async () => {
    const db = openNodeSqlite(); const raw = rpc(); let release!: (r: RpcResult) => void;
    raw.call = vi.fn(() => new Promise<RpcResult>(r => { release = r; }));
    const b = accountBoundRpc(raw, 'A', () => 'A');
    const s = createSqliteStore(db, b, { autoSync: false, onDispose: () => b.dispose() }); s.add('A-only');
    const pending = s.sync(); await flush(); s.dispose?.(); release({ ok: true as const, data: {} }); await pending;
    expect(db.all<{state: string}>('select state from outbox')[0]!.state).toBe('queued');
    expect(() => s.add('late')).toThrow('disposed'); db.close?.();
  });
});

it('disposed stores refuse direct recovery writes as well as new edits', () => {
  const db=openNodeSqlite(); const s=createSqliteStore(db,rpc(),{autoSync:false}); s.dispose?.();
  expect(()=>s.discardRejected!(1)).toThrow('disposed'); expect(()=>s.retryRejected!(1)).toThrow('disposed'); expect(()=>s.dismissConflict!(1)).toThrow('disposed'); expect(()=>s.restoreOtherValue!(1)).toThrow('disposed'); db.close?.();
});
