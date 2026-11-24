import { describe, expect, it } from 'vitest';

// AsyncStorage needs a native module; stub it for this pure-config test.
import { vi } from 'vitest';
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} } }));

describe('supabase client config guard', () => {
  it('refuses missing config and secret keys', async () => {
    const { createSupabase } = await import('../src/supabase/client');
    expect(() => createSupabase({})).toThrow(/not configured/);
    expect(() => createSupabase({ url: 'https://x.supabase.co', key: 'sb_secret_abc' })).toThrow(/secret key/);
    expect(() => createSupabase({ url: 'https://x.supabase.co', key: 'sb_publishable_abc' })).not.toThrow();
  });
});
