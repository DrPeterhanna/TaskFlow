import { describe, expect, it } from 'vitest';
import { createRpcClientFrom } from '../src/supabase/rpcClient';
import { TransportError } from '../src/sync/types';

describe('supabase rpc adapter (mocked transport, NOT a hosted test)', () => {
  it('maps positional args to named params with the op id first', async () => {
    let seen: any;
    const c = createRpcClientFrom(async (fn, args) => { seen = { fn, args }; return { data: { ok: true, data: {} }, error: null, status: 200 }; });
    await c.call('complete_personal_task', ['abc'], 'op1');
    expect(seen).toEqual({ fn: 'complete_personal_task', args: { p_op_id: 'op1', p_id: 'abc' } });
  });
  it('rejects wrong arity and unknown rpc', async () => {
    const c = createRpcClientFrom(async () => ({ data: null, error: null, status: 200 }));
    await expect(c.call('complete_personal_task', [], 'o')).rejects.toThrow(/expected/);
    await expect(c.call('nope', [], 'o')).rejects.toThrow(/unknown/);
  });
  it('classifies failures', async () => {
    const mk = (status: number) => createRpcClientFrom(async () => ({ data: null, error: { message: 'x' }, status }));
    await expect(mk(401).pull('personal', '0', '', null, 5)).rejects.toMatchObject({ kind: 'unauthorized' });
    await expect(mk(503).pull('personal', '0', '', null, 5)).rejects.toBeInstanceOf(TransportError);
    const biz = createRpcClientFrom(async () => ({ data: null, error: { message: 'op_expired', code: 'TF014', details: '{"code" : "op_expired", "message" : "x"}' }, status: 400 }));
    expect(await biz.call('complete_personal_task', ['a'], 'o')).toEqual({ ok: false, code: 'op_expired', message: 'op_expired' });
    await expect(mk(400).call('complete_personal_task', ['a'], 'o')).rejects.toBeInstanceOf(TransportError);
  });
});

describe('error classification (poison-op guard)', () => {
  const mk = (status: number, code?: string) => createRpcClientFrom(async () => ({ data: null, status, error: { message: 'boom', code } }));
  it('a database constraint error (HTTP 400, SQLSTATE 23xxx) is a permanent rejection, not an endless retry', async () => {
    expect(await mk(400, '23514').call('update_personal_task', ['x', {}], 'op')).toMatchObject({ ok: false, code: 'rejected_by_server' });
  });
  it('429, 408 and 5xx stay retryable transport errors; unknown 4xx is not silently dropped', async () => {
    for (const [st, c] of [[429, '23514'], [408, '22000'], [503, '23514'], [400, 'XX000'], [404, undefined]] as const) {
      await expect(mk(st, c).call('update_personal_task', ['x', {}], 'op'), `${st} ${c}`).rejects.toBeInstanceOf(TransportError);
    }
  });
  it('sync_status refuses a malformed answer instead of assuming no resync is needed', async () => {
    const c = createRpcClientFrom(async () => ({ data: { weird: true }, status: 200, error: null }));
    await expect(c.status!('personal_tasks', '5')).rejects.toBeInstanceOf(TransportError);
    const ok = createRpcClientFrom(async () => ({ data: { ok: true, data: { floor_xid: '9', full_resync_required: true } }, status: 200, error: null }));
    expect(await ok.status!('personal_tasks', '5')).toEqual({ floor_xid: '9', full_resync_required: true });
  });
});
