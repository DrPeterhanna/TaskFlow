import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveSupabaseConfig, type RawEnv } from './config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The only Supabase client in the app. Uses the PUBLISHABLE key only (safe to ship; access is enforced by RLS and RPC
 * authorization). Never put a secret/service key or database password in EXPO_PUBLIC_* variables or in the app.
 * Configuration comes from environment variables (.env.local, untracked; see .env.example).
 */
export function createSupabase(raw: RawEnv = {
  name: process.env.EXPO_PUBLIC_TASKFLOW_ENV, url: process.env.EXPO_PUBLIC_SUPABASE_URL, key: process.env.EXPO_PUBLIC_SUPABASE_KEY,
  testRef: process.env.EXPO_PUBLIC_TEST_PROJECT_REF, allowProd: process.env.EXPO_PUBLIC_ALLOW_PRODUCTION,
}): SupabaseClient {
  const env = resolveSupabaseConfig(raw);
  return createClient(env.url, env.key, {
    auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
}
