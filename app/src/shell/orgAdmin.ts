import type { RpcClient, RpcResult } from '../sync/types';
import { uuidv7 } from '../sync/ids';
import type { ReadCall } from './shellModel';

export type Role = 'member' | 'team_leader' | 'supervisor' | 'admin';
export interface MemberRow { membership_id: string; display_name: string; role: Role; status: 'active' | 'suspended' | 'removed'; unit_id: string | null; is_me: boolean }
export interface InvitationRow { id: string; role: Role; unit_id: string; max_uses: number; uses: number; expires_at: string; revoked_at: string | null }
export interface UnitRow { id: string; parent_id: string | null; name: string }
export type Listing<T> = { ok: true; rows: T[] } | { ok: false; error: 'network' | 'unauthorized' | 'unknown' };

export const RANK: Record<Role, number> = { member: 0, team_leader: 1, supervisor: 2, admin: 3 };

/** UI affordances only. The server re-checks every action (RPC authorization + RLS); these just avoid offering what will be refused. */
export function memberActions(myRole: Role, target: MemberRow): { suspend: boolean; reactivate: boolean; remove: boolean; setRole: boolean } {
  const none = { suspend: false, reactivate: false, remove: false, setRole: false };
  if (target.is_me || target.status === 'removed') return none;
  const above = myRole === 'admin' || RANK[myRole] > RANK[target.role];
  if (!above) return none;
  return { suspend: target.status === 'active', reactivate: target.status === 'suspended', remove: true, setRole: myRole === 'admin' && target.role !== 'admin' };
}
export function invitableRoles(myRole: Role): Role[] {
  return (['member', 'team_leader', 'supervisor'] as Role[]).filter((r) => RANK[r] < RANK[myRole] || (myRole === 'admin'));
}
export function isLiveInvitation(i: InvitationRow, now = new Date()): boolean {
  return !i.revoked_at && i.uses < i.max_uses && new Date(i.expires_at) > now;
}

export function createOrgAdminApi(read: ReadCall, rpc: RpcClient) {
  async function list<T>(fn: string): Promise<Listing<T>> {
    let r;
    try { r = await read(fn, {}); } catch { return { ok: false, error: 'network' }; }
    if (r.error) return { ok: false, error: r.status === 401 ? 'unauthorized' : r.status === 0 ? 'network' : 'unknown' };
    const d = r.data as { ok?: boolean; data?: T[] } | null;
    return d?.ok && Array.isArray(d.data) ? { ok: true, rows: d.data } : { ok: false, error: 'unknown' };
  }
  const call = (fn: string, args: unknown[], opId: string): Promise<RpcResult> => rpc.call(fn, args, opId);
  return {
    members: () => list<MemberRow>('list_members'),
    invitations: () => list<InvitationRow>('list_invitations'),
    units: () => list<UnitRow>('list_units'),
    createInvitation: (role: Role, unitId: string, maxUses: number, expiresAt: string, opId = uuidv7()) => call('create_invitation', [role, unitId, maxUses, expiresAt], opId),
    revokeInvitation: (id: string, opId = uuidv7()) => call('revoke_invitation', [id], opId),
    setStatus: (membershipId: string, status: 'active' | 'suspended' | 'removed', opId = uuidv7()) => call('set_member_status', [membershipId, status], opId),
    setRole: (membershipId: string, role: Role, opId = uuidv7()) => call('set_member_role', [membershipId, role], opId),
    leave: (opId = uuidv7()) => call('leave_organization', [], opId),
  };
}
export type OrgAdminApi = ReturnType<typeof createOrgAdminApi>;
export function expiryIn(days: number, now = new Date()): string { return new Date(now.getTime() + days * 86_400_000).toISOString(); }
