import { describe, it, expect } from 'vitest';
import { chunkedSecureStorage, type KvBackend } from '../src/supabase/secureStorage';

function mem(limit = 2048) {
  const m = new Map<string, string>();
  const kv: KvBackend = {
    async getItemAsync(k) { return m.get(k) ?? null; },
    async setItemAsync(k, v) { if (v.length > limit) throw new Error('value too large'); m.set(k, v); },
    async deleteItemAsync(k) { m.delete(k); },
  };
  return { m, kv };
}
const tok = (n: number) => JSON.stringify({ access_token: 'a'.repeat(n), refresh_token: 'r' });

describe('chunked secure session storage', () => {
  it('round-trips a session far larger than the per-value limit', async () => {
    const { kv } = mem(); const s = chunkedSecureStorage(kv);
    const v = tok(7000); await s.setItem('sb-x-auth-token', v);
    expect(await s.getItem('sb-x-auth-token')).toBe(v);
  });
  it('shrinking a value leaves no stale chunks', async () => {
    const { kv, m } = mem(); const s = chunkedSecureStorage(kv);
    await s.setItem('k', tok(7000)); await s.setItem('k', tok(100));
    expect(await s.getItem('k')).toBe(tok(100));
    expect([...m.keys()].filter(x => x.startsWith('tf.k.')).length).toBe(2); // one chunk plus count
  });
  it('a torn write (crash mid-set) reads as signed out, never a mixed token', async () => {
    const { kv, m } = mem(); const s = chunkedSecureStorage(kv);
    await s.setItem('k', tok(7000));
    let calls = 0; const crashing: KvBackend = { ...kv, async setItemAsync(k, v) { if (++calls === 2) throw new Error('killed'); return kv.setItemAsync(k, v); } };
    await expect(chunkedSecureStorage(crashing).setItem('k', tok(7001))).rejects.toThrow('killed');
    expect(await s.getItem('k')).toBeNull();
    expect(m.has('tf.k.n')).toBe(false);
  });
  it('missing chunk or corrupt count reads as null; remove clears everything', async () => {
    const { kv, m } = mem(); const s = chunkedSecureStorage(kv);
    await s.setItem('k', tok(5000)); m.delete('tf.k.1'); expect(await s.getItem('k')).toBeNull();
    await s.setItem('k', tok(5000)); m.set('tf.k.n', 'abc'); expect(await s.getItem('k')).toBeNull();
    await s.setItem('k', tok(5000)); await s.removeItem('k'); expect(m.size).toBe(0);
  });
});
