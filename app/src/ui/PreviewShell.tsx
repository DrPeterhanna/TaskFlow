import React, { useEffect, useMemo } from 'react';
import { createAuthController, type AuthApi, type SessionInfo } from '../auth/authController';
import type { Locale } from '../i18n';
import { createMemoryStore } from '../store/memoryStore';
import { createShellApi, type Me } from '../shell/shellModel';
import { createOrgAdminApi, type InvitationRow, type MemberRow } from '../shell/orgAdmin';
import { Shell } from './Shell';

/** PREVIEW ONLY: in-memory fake auth + organization state to review the screens. No network, no Supabase, nothing persisted. */
export function PreviewShell({ locale, start }: { locale: Locale; start: 'auth' | 'verify' | 'gate' | 'home' }) {
  const { auth, api, adminApi } = useMemo(() => {
    const session: SessionInfo = { userId: '00000000-0000-4000-8000-000000000001', email: 'peter@example.com' };
    let signedIn = start !== 'auth';
    let me: Me = { email_verified: start !== 'verify', membership: start === 'home'
      ? { membership_id: 'm', org_id: 'o', org_name: 'Nile Field Team', role: 'admin', status: 'active', unit_id: 'u-root' } : null };
    let cb: (s: SessionInfo | null) => void = () => {};
    const fake: AuthApi = {
      getSession: async () => (signedIn ? session : null),
      signIn: async () => { signedIn = true; return { session }; },
      signUp: async () => ({ session: null }),
      resend: async () => ({}),
      signOut: async () => { signedIn = false; cb(null); },
      onChange: (f) => { cb = f; return () => {}; },
    };
    const api = createShellApi(async () => ({ data: { ok: true, data: me }, error: null, status: 200 }), {
      call: async (rpc: string, args: unknown[]) => {
        if (rpc === 'create_organization') me = { email_verified: true, membership: { membership_id: 'm', org_id: 'o', org_name: String(args[0]), role: 'admin', status: 'active', unit_id: null } };
        else return { ok: false as const, code: 'not_found', message: 'invitation' };
        return { ok: true as const, data: {} };
      },
      pull: async () => ({}) as never,
    } as never);
    // FAKE org backend (in memory): approximates, but is NOT, the server rules.
    const members: MemberRow[] = [
      { membership_id: 'm', display_name: 'Peter', role: 'admin', status: 'active', unit_id: 'u-root', is_me: true },
      { membership_id: 'm2', display_name: 'Sara', role: 'supervisor', status: 'active', unit_id: 'u-root', is_me: false },
      { membership_id: 'm3', display_name: 'Omar', role: 'team_leader', status: 'active', unit_id: 'u-a', is_me: false },
      { membership_id: 'm4', display_name: 'Laila', role: 'member', status: 'suspended', unit_id: 'u-a', is_me: false },
    ];
    const invites: InvitationRow[] = [];
    let n = 0;
    const ok = (data: unknown) => ({ data: { ok: true, data }, error: null, status: 200 });
    const adminApi = createOrgAdminApi(async (fn) => {
      if (fn === 'list_members') return ok(members.filter((x) => x.status !== 'removed').map((x) => ({ ...x })));
      if (fn === 'list_invitations') return ok(invites.map((x) => ({ ...x })));
      return ok([{ id: 'u-root', parent_id: null, name: 'Nile Field Team' }, { id: 'u-a', parent_id: 'u-root', name: 'Team A' }]);
    }, {
      call: async (rpc: string, args: unknown[]) => {
        if (rpc === 'set_member_status') { const t = members.find((x) => x.membership_id === args[0]); if (t) t.status = args[1] as MemberRow['status']; return { ok: true as const, data: {} }; }
        if (rpc === 'set_member_role') { const t = members.find((x) => x.membership_id === args[0]); if (t) t.role = args[1] as MemberRow['role']; return { ok: true as const, data: {} }; }
        if (rpc === 'create_invitation') { n++; invites.push({ id: `i${n}`, role: args[0] as MemberRow['role'], unit_id: String(args[1]), max_uses: Number(args[2]), uses: 0, expires_at: String(args[3]), revoked_at: null }); return { ok: true as const, data: { invitation_id: `i${n}`, code: `DEMO-CODE-${n}` } }; }
        if (rpc === 'revoke_invitation') { const t = invites.find((x) => x.id === args[0]); if (t) t.revoked_at = new Date().toISOString(); return { ok: true as const, data: {} }; }
        if (rpc === 'leave_organization') { me = { email_verified: true, membership: null }; return { ok: true as const, data: {} }; }
        return { ok: false as const, code: 'generic' };
      }, pull: async () => ({}) as never,
    } as never);
    return { auth: createAuthController(fake), api, adminApi };
  }, [start]);
  useEffect(() => { void auth.start(); }, [auth]);
  return <Shell auth={auth} api={api} adminApi={adminApi} makeStore={() => createMemoryStore([{ id: 'a', title: 'Prepare the weekly plan', done: false, pending: false }])} locale={locale} />;
}
