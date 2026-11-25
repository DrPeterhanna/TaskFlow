import { describe, expect, it } from 'vitest';
import { createOrgAdminApi, expiryIn, invitableRoles, isLiveInvitation, memberActions, type MemberRow } from '../src/shell/orgAdmin';

const m = (role: MemberRow['role'], over: Partial<MemberRow> = {}): MemberRow => ({ membership_id: 'x', display_name: 'n', role, status: 'active', unit_id: null, is_me: false, ...over });

describe('action affordances (UI hints; server enforces)', () => {
  it('never offers actions on yourself, removed members, or equal/higher ranks', () => {
    expect(memberActions('admin', m('member', { is_me: true }))).toEqual({ suspend: false, reactivate: false, remove: false, setRole: false });
    expect(memberActions('admin', m('member', { status: 'removed' })).remove).toBe(false);
    expect(memberActions('supervisor', m('supervisor')).remove).toBe(false);
    expect(memberActions('team_leader', m('supervisor')).suspend).toBe(false);
    expect(memberActions('member', m('member')).remove).toBe(false);
  });
  it('lets higher ranks suspend/reactivate/remove and only admins change roles (never of admins)', () => {
    expect(memberActions('supervisor', m('member'))).toMatchObject({ suspend: true, remove: true, setRole: false });
    expect(memberActions('admin', m('team_leader', { status: 'suspended' }))).toMatchObject({ suspend: false, reactivate: true, setRole: true });
    expect(memberActions('admin', m('admin')).setRole).toBe(false);
  });
  it('invitable roles never include admin', () => {
    expect(invitableRoles('admin')).toEqual(['member', 'team_leader', 'supervisor']);
    expect(invitableRoles('supervisor')).toEqual(['member', 'team_leader']);
    expect(invitableRoles('member')).toEqual([]);
  });
  it('live invitation rules', () => {
    const base = { id: 'i', role: 'member' as const, unit_id: 'u', max_uses: 2, uses: 1, expires_at: expiryIn(1), revoked_at: null };
    expect(isLiveInvitation(base)).toBe(true);
    expect(isLiveInvitation({ ...base, uses: 2 })).toBe(false);
    expect(isLiveInvitation({ ...base, revoked_at: 'now' })).toBe(false);
    expect(isLiveInvitation({ ...base, expires_at: expiryIn(-1) })).toBe(false);
  });
});

describe('org admin api', () => {
  it('lists and maps failures', async () => {
    const ok = createOrgAdminApi(async () => ({ data: { ok: true, data: [m('member')] }, error: null, status: 200 }), {} as never);
    expect((await ok.members()).ok).toBe(true);
    expect(await createOrgAdminApi(async () => { throw new Error('x'); }, {} as never).members()).toEqual({ ok: false, error: 'network' });
    expect(await createOrgAdminApi(async () => ({ data: null, error: { message: 'jwt' }, status: 401 }), {} as never).units()).toEqual({ ok: false, error: 'unauthorized' });
    expect(await createOrgAdminApi(async () => ({ data: { ok: false }, error: null, status: 200 }), {} as never).invitations()).toEqual({ ok: false, error: 'unknown' });
  });
  it('actions use stable op ids and the right argument order', async () => {
    const seen: unknown[][] = [];
    const rpc = { call: async (...a: unknown[]) => { seen.push(a); return { ok: true as const, data: {} }; }, pull: async () => ({}) as never };
    const api = createOrgAdminApi(async () => ({ data: null, error: null, status: 200 }), rpc as never);
    await api.createInvitation('member', 'u1', 3, 'T', 'o1'); await api.revokeInvitation('i1', 'o2');
    await api.setStatus('m1', 'suspended', 'o3'); await api.setRole('m1', 'supervisor', 'o4'); await api.leave('o5');
    expect(seen).toEqual([['create_invitation', ['member', 'u1', 3, 'T'], 'o1'], ['revoke_invitation', ['i1'], 'o2'],
      ['set_member_status', ['m1', 'suspended'], 'o3'], ['set_member_role', ['m1', 'supervisor'], 'o4'], ['leave_organization', [], 'o5']]);
  });
});
