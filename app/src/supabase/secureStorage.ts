/**
 * Session-token storage for supabase-js. Backed by a key/value store with a per-value size limit (expo-secure-store:
 * Keychain / Keystore, about 2 KB per value), so large values are split into chunks. Pure over an injected backend,
 * so chunking, rewrite and corruption handling are tested locally. Real Keychain/Keystore behaviour is device scope.
 */
export interface KvBackend { getItemAsync(k: string): Promise<string | null>; setItemAsync(k: string, v: string): Promise<void>; deleteItemAsync(k: string): Promise<void> }
export interface AuthStorage { getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void> }

const SAFE = /[^A-Za-z0-9._-]/g;
export function chunkedSecureStorage(kv: KvBackend, chunkSize = 1800): AuthStorage {
  const base = (k: string) => 'tf.' + k.replace(SAFE, '_');
  const removeChunks = async (b: string, from: number, to: number) => { for (let i = from; i < to; i++) await kv.deleteItemAsync(`${b}.${i}`); };
  return {
    async getItem(k) {
      const b = base(k); const meta = await kv.getItemAsync(b + '.n');
      if (meta === null) return null;
      const n = Number(meta); if (!Number.isInteger(n) || n < 1 || n > 64) return null;
      let out = '';
      for (let i = 0; i < n; i++) { const p = await kv.getItemAsync(`${b}.${i}`); if (p === null) return null; out += p; } // torn write: treat as signed out
      return out;
    },
    async setItem(k, v) {
      const b = base(k); const old = Number((await kv.getItemAsync(b + '.n')) ?? 0) || 0;
      const parts: string[] = []; for (let i = 0; i < v.length; i += chunkSize) parts.push(v.slice(i, i + chunkSize));
      if (parts.length === 0) parts.push('');
      await kv.deleteItemAsync(b + '.n'); // mark incomplete first so a crash mid-write reads as signed out, never a mixed token
      for (let i = 0; i < parts.length; i++) await kv.setItemAsync(`${b}.${i}`, parts[i]!);
      await removeChunks(b, parts.length, old);
      await kv.setItemAsync(b + '.n', String(parts.length));
    },
    async removeItem(k) {
      const b = base(k); const old = Number((await kv.getItemAsync(b + '.n')) ?? 0) || 0;
      await kv.deleteItemAsync(b + '.n'); await removeChunks(b, 0, old);
    },
  };
}

/** Serialises operations per key (supabase-js refresh and sign-out can race) and moves a legacy plain-storage session into secure storage once. */
export function safeAuthStorage(kv: KvBackend, legacy?: AuthStorage, chunkSize?: number): AuthStorage {
  const inner = chunkedSecureStorage(kv, chunkSize);
  const tails = new Map<string, Promise<unknown>>();
  const run = <T,>(k: string, f: () => Promise<T>): Promise<T> => {
    const p = (tails.get(k) ?? Promise.resolve()).then(f, f);
    tails.set(k, p.catch(() => undefined)); return p;
  };
  return {
    getItem: (k) => run(k, async () => {
      const v = await inner.getItem(k); if (v !== null || !legacy) return v;
      const old = await legacy.getItem(k); if (old === null) return null;
      await inner.setItem(k, old);
      if ((await inner.getItem(k)) === old) await legacy.removeItem(k); // remove plain copy only after the secure copy reads back identical
      return old;
    }),
    setItem: (k, v) => run(k, async () => { await inner.setItem(k, v); if (legacy) await legacy.removeItem(k); }),
    removeItem: (k) => run(k, async () => { await inner.removeItem(k); if (legacy) await legacy.removeItem(k); }),
  };
}
