import type { SupabaseClient } from '@supabase/supabase-js';
import { TransportError, type PullPage, type RpcClient, type RpcResult } from '../sync/types';
import params from './rpcParams.generated.json';

type Call = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null | { message: string; code?: string }; status: number }>;

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
      return { ok: false, code: 'validation', message: r.error.message };
    }
    return r.data;
  };
  const names = params as Record<string, string[]>;
  return {
    async call(rpc, args, opId): Promise<RpcResult> {
      const n = names[rpc];
      if (!n) throw new Error(`unknown rpc ${rpc}`);
      if (n.length !== args.length + 1) throw new Error(`rpc ${rpc}: expected ${n.length - 1} args, got ${args.length}`);
      const body: Record<string, unknown> = { [n[0]]: opId };
      args.forEach((a, i) => { body[n[i + 1]] = a; });
      return (await run(rpc, body)) as RpcResult;
    },
    async pull(stream, afterXid, afterId, horizon, limit): Promise<PullPage> {
      return (await run('sync_pull', { p_stream: stream, p_after_xid: afterXid, p_after_id: afterId, p_horizon: horizon, p_limit: limit })) as PullPage;
    },
  };
}
