import type { SupabaseClient } from '@supabase/supabase-js';

export type AuthErrorCode = 'invalid_email' | 'weak_password' | 'invalid_credentials' | 'email_not_verified' | 'already_registered'
  | 'rate_limited' | 'network' | 'unknown';
export interface SessionInfo { userId: string; email: string }
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
  let stop: (() => void) | null = null;

  async function start() {
    stop = api.onChange((s) => set(s ? { phase: 'signedIn', session: s, verifyEmail: null, error: null } : { phase: 'signedOut', session: null }));
    try { const s = await api.getSession(); set(s ? { phase: 'signedIn', session: s } : { phase: 'signedOut' }); }
    catch { set({ phase: 'signedOut', error: 'network' }); }
  }
  function validate(email: string, password: string, strict: boolean): AuthErrorCode | null {
    if (!EMAIL.test(email.trim())) return 'invalid_email';
    if (strict && password.length < MIN_PASSWORD) return 'weak_password';
    if (!password) return 'invalid_credentials';
    return null;
  }
  async function submit(kind: 'signIn' | 'signUp', email: string, password: string) {
    if (state.busy) return;                                   // double-tap guard
    const bad = validate(email, password, kind === 'signUp');
    if (bad) return set({ error: bad });
    set({ busy: true, error: null, notice: null });
    try {
      const r = await api[kind](email.trim().toLowerCase(), password);
      if (r.error) {
        set({ busy: false, error: r.error, verifyEmail: r.error === 'email_not_verified' ? email.trim().toLowerCase() : state.verifyEmail });
      } else if (r.session) set({ busy: false, phase: 'signedIn', session: r.session, verifyEmail: null });
      else set({ busy: false, phase: 'signedOut', verifyEmail: email.trim().toLowerCase(), notice: 'verification_sent' });
    } catch { set({ busy: false, error: 'network' }); }
  }
  return {
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    getState: () => state,
    start, dispose() { stop?.(); },
    signIn: (e: string, p: string) => submit('signIn', e, p),
    signUp: (e: string, p: string) => submit('signUp', e, p),
    async resend() {
      if (!state.verifyEmail || state.busy) return;
      set({ busy: true, error: null });
      try { const r = await api.resend(state.verifyEmail); set({ busy: false, error: r.error ?? null, notice: r.error ? null : 'verification_sent' }); }
      catch { set({ busy: false, error: 'network' }); }
    },
    async signOut() { try { await api.signOut(); } finally { set({ phase: 'signedOut', session: null, error: null, verifyEmail: null, notice: null }); } },
    clearError() { set({ error: null }); },
  };
}
export type AuthController = ReturnType<typeof createAuthController>;

export function createSupabaseAuthApi(sb: SupabaseClient): AuthApi {
  const info = (u: { id: string; email?: string | null } | null | undefined): SessionInfo | null => (u ? { userId: u.id, email: u.email ?? '' } : null);
  return {
    async getSession() { const { data } = await sb.auth.getSession(); return info(data.session?.user); },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      return { session: error ? null : info(data.session?.user), error: mapAuthError(error) };
    },
    async signUp(email, password) {
      const { data, error } = await sb.auth.signUp({ email, password });
      return { session: error ? null : info(data.session?.user), error: mapAuthError(error) };
    },
    async resend(email) { const { error } = await sb.auth.resend({ type: 'signup', email }); return { error: mapAuthError(error) }; },
    async signOut() { await sb.auth.signOut(); },
    onChange(cb) { const { data } = sb.auth.onAuthStateChange((_e, s) => cb(info(s?.user))); return () => data.subscription.unsubscribe(); },
  };
}
