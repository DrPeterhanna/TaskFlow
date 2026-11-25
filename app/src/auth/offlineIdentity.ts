import type { AuthStorage } from '../supabase/secureStorage';
import type { SessionInfo } from './authController';

/** Local unlock only, never a credential provider or proof of server authority. */
export interface OfflineIdentity {
  locked(): Promise<boolean>;
  lock(): Promise<void>;
  unlock(): Promise<void>;
  read(): Promise<SessionInfo | null>;
}
const registered = new WeakMap<object, OfflineIdentity>();
export function registerOfflineIdentity(client: object, identity: OfflineIdentity) { registered.set(client, identity); }
export function offlineIdentityFor(client: object) { return registered.get(client); }
export function retryableAuthFailure(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as {name?:string}).name === 'AuthRetryableFetchError';
}
/** Collision-free full-origin key using SecureStore-safe characters. No legacy adoption. */
export function authStorageKey(url: string): string {
  const origin = new URL(url).origin;
  return 'taskflow.auth.v2.' + Array.from(origin).map(c => c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
}
export function createOfflineIdentity(storage: AuthStorage, sessionKey: string): OfflineIdentity {
  const lockKey = sessionKey + '.local-locked';
  let memoryLocked = false;
  return {
    locked: async () => memoryLocked || (await storage.getItem(lockKey)) !== null,
    async lock() { memoryLocked = true; await storage.setItem(lockKey, 'locked'); if (await storage.getItem(lockKey) !== 'locked') throw new Error('local logout lock not persisted'); },
    async unlock() { await storage.removeItem(lockKey); if (await storage.getItem(lockKey) !== null) throw new Error('local logout lock not removed'); memoryLocked = false; },
    async read() {
      if (memoryLocked || await storage.getItem(lockKey) !== null) return null;
      const raw = await storage.getItem(sessionKey);
      if (!raw) return null;
      try {
        const s = JSON.parse(raw);
        if (typeof s.access_token !== 'string' || !s.access_token || typeof s.refresh_token !== 'string' || !s.refresh_token ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.user?.id) || typeof s.user?.email !== 'string') return null;
        // Only these non-secret identity fields leave secure storage.
        return {userId: s.user.id, email:s.user.email, localOnly:true};
      } catch { return null; }
    },
  };
}
