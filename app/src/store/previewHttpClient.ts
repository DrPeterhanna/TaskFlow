import { TransportError, type PullPage, type RpcClient, type RpcResult } from '../sync/types';

/** PREVIEW ONLY: calls the local test bridge (tests/bridge.py, local PostgreSQL). `offline` simulates a lost network. */
export function createPreviewClient(base: string, uid: string, isOffline: () => boolean): RpcClient {
  const post = async (path: string, body: unknown): Promise<any> => {
    if (isOffline()) throw new TransportError('simulated offline');
    let r: Response;
    try {
      r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { throw new TransportError(String(e)); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new TransportError(`${r.status}`, 'server');
    return j;
  };
  return {
    status: async (stream, afterXid) => (await post('/status', { uid, stream, after_xid: afterXid })).data,
    call: async (rpc, args, opId) => (await post('/rpc', { uid, fn: rpc, args, op: opId })) as RpcResult,
    pull: async (stream, afterXid, afterId, horizon, limit) =>
      (await post('/pull', { uid, stream, after_xid: afterXid, after_id: afterId, horizon, limit })) as PullPage,
  };
}
export async function previewCreateUser(base: string, email: string): Promise<string> {
  const r = await fetch(base + '/user', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  return ((await r.json()) as { id: string }).id;
}
