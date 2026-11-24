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
    expect(await mk(400).call('complete_personal_task', ['a'], 'o')).toMatchObject({ ok: false });
  });
});
