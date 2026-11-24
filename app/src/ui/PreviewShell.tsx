import React, { useEffect, useMemo } from 'react';
import { createAuthController, type AuthApi, type SessionInfo } from '../auth/authController';
import type { Locale } from '../i18n';
import { createMemoryStore } from '../store/memoryStore';
import { createShellApi, type Me } from '../shell/shellModel';
import { Shell } from './Shell';

/** PREVIEW ONLY: in-memory fake auth + organization state to review the screens. No network, no Supabase, nothing persisted. */
export function PreviewShell({ locale, start }: { locale: Locale; start: 'auth' | 'verify' | 'gate' | 'home' }) {
  const { auth, api } = useMemo(() => {
    const session: SessionInfo = { userId: '00000000-0000-4000-8000-000000000001', email: 'peter@example.com' };
    let signedIn = start !== 'auth';
    let me: Me = { email_verified: start !== 'verify', membership: start === 'home'
      ? { membership_id: 'm', org_id: 'o', org_name: 'Nile Field Team', role: 'supervisor', status: 'active', unit_id: null } : null };
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
    return { auth: createAuthController(fake), api };
  }, [start]);
  useEffect(() => { void auth.start(); }, [auth]);
  return <Shell auth={auth} api={api} makeStore={() => createMemoryStore([{ id: 'a', title: 'Prepare the weekly plan', done: false, pending: false }])} locale={locale} />;
}
