import type { RpcClient } from '../sync/types';
import { TransportError } from '../sync/types';

/** Bound at store construction. A changed account invalidates it permanently, including late responses. */
export function accountBoundRpc(rpc: RpcClient, owner: string, currentOwner: () => string | null): RpcClient & { dispose(): void } {
  let disposed = false;
  const check = () => { if (disposed || currentOwner() !== owner) throw new TransportError('account no longer active', 'unauthorized'); };
  const protect = async <T,>(f: () => Promise<T>): Promise<T> => { check(); const result = await f(); check(); return result; };
  return {
    call: (...a) => protect(() => rpc.call(...a)),
    pull: (...a) => protect(() => rpc.pull(...a)),
    ...(rpc.status ? { status: (stream: string, xid: string) => protect(() => rpc.status!(stream, xid)) } : {}),
    dispose() { disposed = true; },
  };
}

/** Stable partition for local databases and cached routing, including project/environment separation. */
export function accountPartition(environment: string, userId: string): string {
  if ((!environment || environment.length > 512) || !/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid account partition');
  // Encode, do not truncate/hash away distinctions.
  return `${environment.replace(/[^a-zA-Z0-9]/g, (c) => '_' + c.charCodeAt(0).toString(16))}_${userId}`;
}
