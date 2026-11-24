import { describe, expect, it, vi } from 'vitest';
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {} }));
import { resolveSupabaseConfig as r, PRODUCTION_REF } from '../src/supabase/config';

const pub = 'sb_publishable_abc';
describe('explicit environment selection', () => {
  it('has no default target', () => {
    expect(() => r({})).toThrow(/no default/);
    expect(() => r({ url: `https://${PRODUCTION_REF}.supabase.co`, key: pub })).toThrow(/no default/);
  });
  it('refuses secret keys', () => {
    expect(() => r({ name: 'test', url: 'https://abc.supabase.co', key: 'sb_secret_x', testRef: 'abc' })).toThrow(/secret key/);
  });
  it('blocks production from local and test builds', () => {
    const url = `https://${PRODUCTION_REF}.supabase.co`;
    expect(() => r({ name: 'test', url, key: pub, testRef: PRODUCTION_REF })).toThrow(/must not target the production project/);
    expect(() => r({ name: 'local', url, key: pub })).toThrow(/must not target the production project/);
  });
  it('production needs explicit confirmation and the production URL', () => {
    const url = `https://${PRODUCTION_REF}.supabase.co`;
    expect(() => r({ name: 'production', url, key: pub })).toThrow(/yes-i-mean-production/);
    expect(r({ name: 'production', url, key: pub, allowProd: 'yes-i-mean-production' }).env).toBe('production');
    expect(() => r({ name: 'production', url: 'https://abc.supabase.co', key: pub, allowProd: 'yes-i-mean-production' })).toThrow();
  });
  it('test requires matching ref; local requires localhost', () => {
    expect(() => r({ name: 'test', url: 'https://abc.supabase.co', key: pub })).toThrow(/TEST_PROJECT_REF/);
    expect(r({ name: 'test', url: 'https://abc.supabase.co', key: pub, testRef: 'abc' }).env).toBe('test');
    expect(() => r({ name: 'local', url: 'https://abc.supabase.co', key: pub })).toThrow(/localhost/);
    expect(r({ name: 'local', url: 'http://127.0.0.1:3000', key: pub }).env).toBe('local');
  });
  it('createSupabase uses the same guard', async () => {
    const { createSupabase } = await import('../src/supabase/client');
    expect(() => createSupabase({})).toThrow();
    expect(() => createSupabase({ name: 'test', url: 'https://abc.supabase.co', key: pub, testRef: 'abc' })).not.toThrow();
  });
});
