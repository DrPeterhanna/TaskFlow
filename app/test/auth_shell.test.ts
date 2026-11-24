import { describe, expect, it } from 'vitest';
import { createAuthController, mapAuthError, type AuthApi, type SessionInfo } from '../src/auth/authController';
import { createShellApi, orgErrorKey, routeFor } from '../src/shell/shellModel';

const S: SessionInfo = { userId: 'u1', email: 'a@b.co' };
function fakeApi(over: Partial<AuthApi> = {}): AuthApi & { calls: string[]; emit(s: SessionInfo | null): void } {
  let cb: (s: SessionInfo | null) => void = () => {};
  const calls: string[] = [];
  return Object.assign({
    getSession: async () => null,
    signIn: async (e: string) => { calls.push('signIn:' + e); return { session: S }; },
    signUp: async (e: string) => { calls.push('signUp:' + e); return { session: null }; },
    resend: async () => { calls.push('resend'); return {}; },
    signOut: async () => { calls.push('signOut'); },
    onChange: (f: (s: SessionInfo | null) => void) => { cb = f; return () => {}; },
  }, over, { calls, emit: (s: SessionInfo | null) => cb(s) });
}

describe('auth controller', () => {
  it('starts signed out, then signed in from a stored session', async () => {
    const c = createAuthController(fakeApi({ getSession: async () => S }));
    expect(c.getState().phase).toBe('loading');
    await c.start();
    expect(c.getState().phase).toBe('signedIn');
  });
  it('validates before calling the server', async () => {
    const api = fakeApi(); const c = createAuthController(api); await c.start();
    await c.signIn('not-an-email', 'x'); expect(c.getState().error).toBe('invalid_email');
    await c.signUp('a@b.co', 'short'); expect(c.getState().error).toBe('weak_password');
    expect(api.calls).toEqual([]);
  });
  it('sign-up without a session asks for verification, and resend works', async () => {
    const api = fakeApi(); const c = createAuthController(api); await c.start();
    await c.signUp(' A@B.co ', 'longenough1');
    expect(api.calls).toEqual(['signUp:a@b.co']);
    expect(c.getState()).toMatchObject({ phase: 'signedOut', verifyEmail: 'a@b.co', notice: 'verification_sent' });
    await c.resend(); expect(api.calls).toContain('resend');
  });
  it('maps server errors and keeps unverified email for resend', async () => {
    const c = createAuthController(fakeApi({ signIn: async () => ({ session: null, error: 'email_not_verified' as const }) })); await c.start();
    await c.signIn('a@b.co', 'pw'); expect(c.getState()).toMatchObject({ error: 'email_not_verified', verifyEmail: 'a@b.co', busy: false });
  });
  it('ignores a second submit while busy and survives thrown network errors', async () => {
    let n = 0; let release: () => void = () => {};
    const slow = fakeApi({ signIn: () => new Promise((r) => { n++; release = () => r({ session: S }); }) });
    const c = createAuthController(slow); await c.start();
    const p1 = c.signIn('a@b.co', 'pw'); void c.signIn('a@b.co', 'pw'); release(); await p1;
    expect(n).toBe(1);
    const c2 = createAuthController(fakeApi({ signIn: async () => { throw new Error('x'); } })); await c2.start();
    await c2.signIn('a@b.co', 'pw'); expect(c2.getState()).toMatchObject({ error: 'network', busy: false });
  });
  it('sign out always ends signed out, even if the call throws; external sign-out event is honoured', async () => {
    const api = fakeApi({ getSession: async () => S, signOut: async () => { throw new Error('offline'); } });
    const c = createAuthController(api); await c.start();
    await expect(c.signOut()).rejects.toThrow(); expect(c.getState().phase).toBe('signedOut');
    const api2 = fakeApi({ getSession: async () => S }); const c2 = createAuthController(api2); await c2.start();
    api2.emit(null); expect(c2.getState().phase).toBe('signedOut');
  });
  it('maps supabase error codes', () => {
    expect(mapAuthError({ code: 'invalid_credentials' })).toBe('invalid_credentials');
    expect(mapAuthError({ code: 'email_not_confirmed' })).toBe('email_not_verified');
    expect(mapAuthError({ code: 'user_already_exists' })).toBe('already_registered');
    expect(mapAuthError({ status: 429 })).toBe('rate_limited');
    expect(mapAuthError({ status: 0, message: 'fetch failed' })).toBe('network');
    expect(mapAuthError(null)).toBeUndefined();
  });
});

describe('routing', () => {
  const m = { membership_id: 'm', org_id: 'o', org_name: 'O', role: 'member' as const, status: 'active', unit_id: null };
  it('derives the screen from auth and server state', () => {
    expect(routeFor('loading', null, null)).toBe('loading');
    expect(routeFor('signedOut', null, null)).toBe('auth');
    expect(routeFor('signedIn', null, null)).toBe('loading');
    expect(routeFor('signedIn', null, 'network')).toBe('error');
    expect(routeFor('signedIn', { email_verified: false, membership: null }, null)).toBe('verify');
    expect(routeFor('signedIn', { email_verified: true, membership: null }, null)).toBe('join_or_create');
    expect(routeFor('signedIn', { email_verified: true, membership: m }, null)).toBe('home');
  });
  it('never trusts a stale signed-in state after sign-out', () => { expect(routeFor('signedOut', { email_verified: true, membership: m }, null)).toBe('auth'); });
  it('maps org errors using code and message', () => {
    expect(orgErrorKey('validation', 'user already belongs to an organization')).toBe('already_member');
    expect(orgErrorKey('validation', 'invitation is not live')).toBe('code');
    expect(orgErrorKey('validation', 'name must be 1 to 120 characters')).toBe('name');
    expect(orgErrorKey('forbidden', 'verified email required')).toBe('verify');
    expect(orgErrorKey('rate_limited')).toBe('rate');
    expect(orgErrorKey('weird')).toBe('generic');
  });
});

describe('shell api', () => {
  it('me() maps transport and server outcomes', async () => {
    const ok = createShellApi(async () => ({ data: { ok: true, data: { email_verified: true, membership: null } }, error: null, status: 200 }), {} as never);
    expect(await ok.me()).toEqual({ ok: true, me: { email_verified: true, membership: null } });
    const net = createShellApi(async () => { throw new Error('x'); }, {} as never);
    expect(await net.me()).toEqual({ ok: false, error: 'network' });
    const un = createShellApi(async () => ({ data: null, error: { message: 'jwt' }, status: 401 }), {} as never);
    expect(await un.me()).toEqual({ ok: false, error: 'unauthorized' });
  });
  it('org actions pass a caller-supplied op id so a retry replays', async () => {
    const seen: unknown[][] = [];
    const rpc = { call: async (...a: unknown[]) => { seen.push(a); return { ok: true as const, data: {} }; }, pull: async () => ({}) as never };
    const api = createShellApi(async () => ({ data: null, error: null, status: 200 }), rpc as never);
    await api.createOrg('  Acme ', 'Africa/Cairo', 'op-1'); await api.createOrg('  Acme ', 'Africa/Cairo', 'op-1');
    await api.joinOrg(' CODE ', 'op-2');
    expect(seen).toEqual([['create_organization', ['Acme', 'Africa/Cairo'], 'op-1'], ['create_organization', ['Acme', 'Africa/Cairo'], 'op-1'], ['redeem_invitation', ['CODE'], 'op-2']]);
  });
});
