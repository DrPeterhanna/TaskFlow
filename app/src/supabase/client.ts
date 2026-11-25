import 'react-native-url-polyfill/auto';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { authStorageKey, createOfflineIdentity, offlineIdentityFor, registerOfflineIdentity } from '../auth/offlineIdentity';
import { safeAuthStorage } from './secureStorage';
import { resolveSupabaseConfig, type RawEnv } from './config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The only Supabase client in the app. Uses the PUBLISHABLE key only (safe to ship; access is enforced by RLS and RPC
 * authorization). Never put a secret/service key or database password in EXPO_PUBLIC_* variables or in the app.
 * Configuration comes from environment variables (.env.local, untracked; see .env.example).
 */
export const configuredEnvironment = (): RawEnv => ({
  name: process.env.EXPO_PUBLIC_TASKFLOW_ENV, url: process.env.EXPO_PUBLIC_SUPABASE_URL, key: process.env.EXPO_PUBLIC_SUPABASE_KEY,
  testRef: process.env.EXPO_PUBLIC_TEST_PROJECT_REF, allowProd: process.env.EXPO_PUBLIC_ALLOW_PRODUCTION,
});

export function createSupabase(raw: RawEnv = configuredEnvironment()): SupabaseClient {
  const env = resolveSupabaseConfig(raw);
  const storage = safeAuthStorage(SecureStore, AsyncStorage);
  // Old hostname-only sessions are deliberately left untouched, never silently adopted.
  const storageKey = authStorageKey(env.url);
  const client = createClient(env.url, env.key, {
    auth: { storageKey, storage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
  registerOfflineIdentity(client, createOfflineIdentity(storage, storageKey));
  return client;
}

/** This client can never borrow a different account's bearer token, even mid-switch. */
export function createAccountSupabase(authClient: SupabaseClient, owner: string): SupabaseClient {
  const env = resolveSupabaseConfig(configuredEnvironment());
  return createClient(env.url, env.key, { accessToken: async () => {
    const identity = offlineIdentityFor(authClient);
    if (await identity?.locked()) throw new Error('local identity locked');
    const { data, error } = await authClient.auth.getSession();
    if (await identity?.locked()) throw new Error('local identity locked');
    if (error || data.session?.user.id !== owner) throw new Error('account no longer active');
    return data.session.access_token;
  } });
}
