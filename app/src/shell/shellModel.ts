import type { RpcClient } from '../sync/types';
import { uuidv7 } from '../sync/ids';

export interface Membership { membership_id: string; org_id: string; org_name: string; role: 'member' | 'team_leader' | 'supervisor' | 'admin'; status: string; unit_id: string | null }
export interface Me { email_verified: boolean; membership: Membership | null }
export type Route = 'auth' | 'verify' | 'join_or_create' | 'home' | 'loading' | 'error';
export type ShellError = 'network' | 'unauthorized' | 'unknown';

export function routeFor(auth: 'loading' | 'signedOut' | 'signedIn', me: Me | null, loadError: ShellError | null): Route {
  if (auth === 'loading') return 'loading';
  if (auth === 'signedOut') return 'auth';
  if (loadError) return 'error';
  if (!me) return 'loading';
  if (!me.email_verified) return 'verify';
  return 'home'; // Personal workspace never requires organization membership.
}

export interface ReadCall { (fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: null | { message: string }; status: number }> }

/** Narrow reads/actions the shell needs. Org mutations carry a stable op id so a retry replays instead of duplicating. */
export function createShellApi(read: ReadCall, rpc: RpcClient) {
  return {
    async me(): Promise<{ ok: true; me: Me } | { ok: false; error: ShellError }> {
      let r;
      try { r = await read('my_membership', {}); } catch { return { ok: false, error: 'network' }; }
      if (r.error) return { ok: false, error: r.status === 401 ? 'unauthorized' : r.status === 0 ? 'network' : 'unknown' };
      const d = r.data as { ok?: boolean; data?: Me } | null;
      return d?.ok && d.data ? { ok: true, me: d.data } : { ok: false, error: 'unknown' };
    },
    createOrg: (name: string, timezone: string, opId = uuidv7()) => rpc.call('create_organization', [name.trim(), timezone], opId),
    joinOrg: (code: string, opId = uuidv7()) => rpc.call('redeem_invitation', [code.trim()], opId),
  };
}

export type OrgErrorKey = 'name' | 'code' | 'already_member' | 'verify' | 'rate' | 'generic' | 'network';
/** Keyed on the server's code AND its message because 'validation' covers several different cases. */
export function orgErrorKey(code: string | undefined, message?: string): OrgErrorKey {
  const m = message ?? '';
  if (code === 'rate_limited') return 'rate';
  if (code === 'forbidden') return 'verify';
  if (code === 'not_found') return 'code';
  if (code === 'validation') {
    if (/already belongs/.test(m)) return 'already_member';
    if (/invitation is not live/.test(m)) return 'code';
    if (/name|timezone/.test(m)) return 'name';
  }
  return 'generic';
}
