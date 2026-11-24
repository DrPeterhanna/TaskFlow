import type { SupabaseClient } from '@supabase/supabase-js';
import { TransportError, type PullPage, type RpcClient, type RpcResult } from '../sync/types';
import params from './rpcParams.generated.json';

type Call = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null | { message: string; code?: string; details?: string | null }; status: number }>;

/**
 * RpcClient over Supabase PostgREST. The app only ever calls the app_api schema (positional args -> named params,
 * from the generated map; re-verify against hosted signatures). Business errors arrive as {ok:false,...} data;
 * network, 5xx and auth failures throw TransportError so the outbox retries with the same op id.
 */
export function createSupabaseRpcClient(sb: SupabaseClient): RpcClient {
  return createRpcClientFrom((fn, args) => sb.schema('app_api').rpc(fn, args) as unknown as ReturnType<Call>);
}

export function createRpcClientFrom(call: Call): RpcClient {
  const run = async (fn: string, args: Record<string, unknown>): Promise<unknown> => {
    let r;
    try { r = await call(fn, args); } catch (e) { throw new TransportError(String(e)); }
    if (r.error) {
      if (r.status === 401 || r.status === 403 && /jwt/i.test(r.error.message)) throw new TransportError(r.error.message, 'unauthorized');
      if (r.status === 0 || r.status >= 500) throw new TransportError(r.error.message, r.status === 0 ? 'network' : 'server');
      // TaskFlow business errors are raised as SQLSTATE TFxxx with a JSON detail {"code","message"}; PostgREST returns them as HTTP 4xx.
      if (r.error.code && /^TF/.test(r.error.code)) {
        let code = r.error.code;
        try { const d = JSON.parse(r.error.details ?? '{}') as { code?: string }; if (d.code) code = d.code; } catch { /* keep SQLSTATE */ }
        return { ok: false, code, message: r.error.message };
      }
      // A 4xx the database raised itself (constraint or data error, SQLSTATE class 22/23) is a permanent "no": retrying the same
      // op can never succeed and would block every op queued behind it, so it is a rejection the user can see.
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429 && /^(22|23)/.test(r.error.code ?? '')) {
        return { ok: false, code: 'rejected_by_server', message: r.error.message };
      }
      throw new TransportError(`unexpected REST error ${r.status}: ${r.error.message}`, 'server');
    }
    return r.data;
  };
  const names = params as Record<string, string[]>;
  return {
    async call(rpc, args, opId): Promise<RpcResult> {
      const n = names[rpc];
      if (!n) throw new Error(`unknown rpc ${rpc}`);
      if (n.length !== args.length + 1) throw new Error(`rpc ${rpc}: expected ${n.length - 1} args, got ${args.length}`);
      const body: Record<string, unknown> = { [n[0]!]: opId };
      args.forEach((a, i) => { body[n[i + 1]!] = a; });
      return (await run(rpc, body)) as RpcResult;
    },
    async pull(stream, afterXid, afterId, horizon, limit): Promise<PullPage> {
      return (await run('sync_pull', { p_stream: stream, p_after_xid: afterXid, p_after_id: afterId, p_horizon: horizon, p_limit: limit })) as PullPage;
    },
    async status(stream, afterXid) {
      const r = (await run('sync_status', { p_stream: stream, p_after_xid: afterXid })) as { ok?: boolean; data?: { full_resync_required: boolean; floor_xid: string } };
      if (!r || r.ok !== true || !r.data) throw new TransportError('sync_status: unexpected answer', 'server');   // never guess "no resync needed" from a bad answer
      return r.data;
    },
  };
}
