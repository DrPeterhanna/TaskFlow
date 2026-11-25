import { describe, it, expect } from 'vitest';
import { safeAuthStorage, chunkedSecureStorage, type KvBackend } from '../src/supabase/secureStorage';

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

describe('safeAuthStorage', () => {
  const legacyMem = (init: Record<string, string> = {}) => { const m = new Map(Object.entries(init)); return { m, s: { async getItem(k: string) { return m.get(k) ?? null; }, async setItem(k: string, v: string) { m.set(k, v); }, async removeItem(k: string) { m.delete(k); } } }; };
  it('moves a legacy plain session into secure storage and deletes the plain copy', async () => {
    const { kv } = mem(); const l = legacyMem({ k: tok(5000) }); const s = safeAuthStorage(kv, l.s);
    expect(await s.getItem('k')).toBe(tok(5000)); expect(l.m.size).toBe(0);
    expect(await chunkedSecureStorage(kv).getItem('k')).toBe(tok(5000));
  });
  it('keeps the plain copy if the secure write fails (no session loss)', async () => {
    const { kv } = mem(); const bad: KvBackend = { ...kv, async setItemAsync() { throw new Error('keychain unavailable'); } };
    const l = legacyMem({ k: tok(100) }); await expect(safeAuthStorage(bad, l.s).getItem('k')).rejects.toThrow(); expect(l.m.get('k')).toBe(tok(100));
  });
  it('concurrent writes are serialised: final value is the last write, chunks consistent', async () => {
    const { kv, m } = mem(); const s = safeAuthStorage(kv);
    await Promise.all([s.setItem('k', tok(7000)), s.setItem('k', tok(300)), s.setItem('k', tok(4000)), s.removeItem('z')]);
    expect(await s.getItem('k')).toBe(tok(4000));
    expect([...m.keys()].filter(x => x.startsWith('tf.k.')).length).toBe(4);
  });
  it('set after sign-in does not resurrect a removed session', async () => {
    const { kv } = mem(); const l = legacyMem({ k: tok(50) }); const s = safeAuthStorage(kv, l.s);
    await Promise.all([s.removeItem('k'), s.getItem('k')]); expect(await s.getItem('k')).toBeNull();
  });
});
