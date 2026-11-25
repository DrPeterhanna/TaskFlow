import type { SupabaseClient } from '@supabase/supabase-js';
import { offlineIdentityFor, retryableAuthFailure } from './offlineIdentity';

export type AuthErrorCode = 'invalid_email' | 'weak_password' | 'invalid_credentials' | 'email_not_verified' | 'already_registered'
  | 'rate_limited' | 'network' | 'local_logout_failed' | 'logout_remote_failed' | 'unknown';
export interface SessionInfo { userId: string; email: string; localOnly?: true }
export interface AuthApi {
  getSession(): Promise<SessionInfo | null>;
  signIn(email: string, password: string): Promise<{ session: SessionInfo | null; error?: AuthErrorCode }>;
  signUp(email: string, password: string): Promise<{ session: SessionInfo | null; error?: AuthErrorCode }>;
  resend(email: string): Promise<{ error?: AuthErrorCode }>;
  signOut(): Promise<void>;
  onChange(cb: (s: SessionInfo | null) => void): () => void;
}
export interface AuthState {
  phase: 'loading' | 'signedOut' | 'signedIn';
  session: SessionInfo | null;
  busy: boolean;
  error: AuthErrorCode | null;
  /** set after a sign-up that did not return a session (the project asks for email verification) */
  verifyEmail: string | null;
  notice: 'verification_sent' | null;
}

export const MIN_PASSWORD = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function mapAuthError(e: { code?: string; message?: string; status?: number } | null | undefined): AuthErrorCode | undefined {
  if (!e) return undefined;
  const c = e.code ?? '';
  if (c === 'invalid_credentials') return 'invalid_credentials';
  if (c === 'email_not_confirmed') return 'email_not_verified';
  if (c === 'user_already_exists' || c === 'email_exists') return 'already_registered';
  if (c === 'weak_password') return 'weak_password';
  if (c === 'over_request_rate_limit' || c === 'over_email_send_rate_limit' || e.status === 429) return 'rate_limited';
  if (e.status === 0 || /fetch|network/i.test(e.message ?? '')) return 'network';
  return 'unknown';
}

/** Framework-free so it is unit-testable; the UI subscribes with useSyncExternalStore. */
export function createAuthController(api: AuthApi) {
  let state: AuthState = { phase: 'loading', session: null, busy: false, error: null, verifyEmail: null, notice: null };
  const subs = new Set<() => void>();
  const set = (p: Partial<AuthState>) => { state = { ...state, ...p }; subs.forEach((f) => f()); };
  let disposed = false;
  let authRevision = 0;
  let stop: (() => void) | null = null;

  async function start() {
    stop?.(); disposed = false;
    const revision = ++authRevision;
    stop = api.onChange((s) => { if (disposed) return; authRevision++; set(s ? { phase: 'signedIn', session: s, busy: false, verifyEmail: null, error: null } : { phase: 'signedOut', session: null, busy: false }); });
    try { const s = await api.getSession(); if (authRevision !== revision) return; set(s ? { phase: 'signedIn', session: s } : { phase: 'signedOut' }); }
    catch { if (authRevision === revision) set({ phase: 'signedOut', error: 'network' }); }
  }
  function validate(email: string, password: string, strict: boolean): AuthErrorCode | null {
    if (!EMAIL.test(email.trim())) return 'invalid_email';
    if (strict && password.length < MIN_PASSWORD) return 'weak_password';
    if (!password) return 'invalid_credentials';
    return null;
  }
  async function submit(kind: 'signIn' | 'signUp', email: string, password: string) {
    if (disposed || state.busy) return;                                   // double-tap guard
    const bad = validate(email, password, kind === 'signUp');
    if (bad) return set({ error: bad });
    const revision = authRevision;
    set({ busy: true, error: null, notice: null });
    try {
      const r = await api[kind](email.trim().toLowerCase(), password);
      if (disposed || authRevision !== revision) return;
      if (r.error) {
        set({ busy: false, error: r.error, verifyEmail: r.error === 'email_not_verified' ? email.trim().toLowerCase() : state.verifyEmail });
      } else if (r.session) set({ busy: false, phase: 'signedIn', session: r.session, verifyEmail: null });
      else set({ busy: false, phase: 'signedOut', verifyEmail: email.trim().toLowerCase(), notice: 'verification_sent' });
    } catch { if (!disposed && authRevision === revision) set({ busy: false, error: 'network' }); }
  }
  return {
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    getState: () => state,
    start, dispose() { disposed = true; authRevision++; stop?.(); stop = null; },
    signIn: (e: string, p: string) => submit('signIn', e, p),
    signUp: (e: string, p: string) => submit('signUp', e, p),
    async resend() {
      if (disposed || !state.verifyEmail || state.busy) return;
      const revision = authRevision;
      set({ busy: true, error: null });
      try { const r = await api.resend(state.verifyEmail); if (disposed || authRevision !== revision) return; set({ busy: false, error: r.error ?? null, notice: r.error ? null : 'verification_sent' }); }
      catch { if (!disposed && authRevision === revision) set({ busy: false, error: 'network' }); }
    },
    async signOut() { authRevision++; set({ busy: false, phase: 'signedOut', session: null, error: null, verifyEmail: null, notice: null }); try { await api.signOut(); } catch (e) { set({ error: e instanceof Error && e.message === 'local_logout_failed' ? 'local_logout_failed' : 'logout_remote_failed' }); throw e; } },
    clearError() { set({ error: null }); },
  };
}
export type AuthController = ReturnType<typeof createAuthController>;

export function createSupabaseAuthApi(sb: SupabaseClient): AuthApi {
  const offline = offlineIdentityFor(sb);
  let revision = 0;
  let submitting = false;
  const info = (u: { id: string; email?: string | null } | null | undefined): SessionInfo | null => (u ? { userId: u.id, email: u.email ?? '' } : null);
  return {
    async getSession() {
      const before = revision;
      if (await offline?.locked()) return null;
      const { data, error } = await sb.auth.getSession();
      if (before !== revision || await offline?.locked()) return null;
      if (data.session) return info(data.session.user);
      if (retryableAuthFailure(error)) { const local = await offline?.read() ?? null; return before === revision ? local : null; }
      return null;
    },
    async signIn(email, password) {
      submitting = true;
      const before = revision;
      try {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (!error && data.session && before === revision) await offline?.unlock();
        if (before !== revision) { await offline?.lock(); return { session: null, error: 'network' }; }
        return { session: error ? null : info(data.session?.user), error: mapAuthError(error) };
      } finally { submitting = false; }
    },
    async signUp(email, password) {
      submitting = true;
      const before = revision;
      try {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (!error && data.session && before === revision) await offline?.unlock();
        if (before !== revision) { await offline?.lock(); return { session: null, error: 'network' }; }
        return { session: error ? null : info(data.session?.user), error: mapAuthError(error) };
      } finally { submitting = false; }
    },
    async resend(email) { const { error } = await sb.auth.resend({ type: 'signup', email }); return { error: mapAuthError(error) }; },
    async signOut() {
      revision++;
      let lockFailed = false;
      try { await offline?.lock(); } catch { lockFailed = true; }
      // Installed SDK removes local session before HTTP logout, including retryable refresh failure.
      // Still attempt that cleanup when durable lock storage failed; memory lock denies network tokens now.
      let remoteError: unknown;
      try { const result = await sb.auth.signOut({ scope: 'local' }); remoteError = result.error; } catch (e) { remoteError = e; }
      if (lockFailed) throw new Error('local_logout_failed');
      if (remoteError) throw new Error('logout_remote_failed');
    },
    onChange(cb) {
      const { data } = sb.auth.onAuthStateChange((event, s) => {
        // Startup getSession owns the retryable-offline fallback. INITIAL_SESSION null is not a logout.
        if (event === 'INITIAL_SESSION' || (submitting && s)) return;
        revision++;
        const before = revision;
        if (!s) { cb(null); return; }
        void (async () => { try { const locked = await offline?.locked(); if (before === revision && !locked) cb(info(s.user)); } catch { if (before === revision) cb(null); } })();
      });
      return () => data.subscription.unsubscribe();
    },
  };
}
