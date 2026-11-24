import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * The only Supabase client in the app. Uses the PUBLISHABLE key only (safe to ship; access is enforced by RLS and RPC
 * authorization). Never put a secret/service key or database password in EXPO_PUBLIC_* variables or in the app.
 * Configuration comes from environment variables (.env.local, untracked; see .env.example).
 */
export function createSupabase(env: { url?: string; key?: string } = {
  url: process.env.EXPO_PUBLIC_SUPABASE_URL, key: process.env.EXPO_PUBLIC_SUPABASE_KEY,
}): SupabaseClient {
  if (!env.url || !env.key) throw new Error('Supabase is not configured: set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY');
  if (/^sb_secret_|service_role/.test(env.key)) throw new Error('A secret key must never be used in the app');
  return createClient(env.url, env.key, {
    auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
  });
}
