/** Pure derivation of what the user sees about synchronization. No I/O, so every branch is unit-testable. */
export type SyncPhase = 'synced' | 'syncing' | 'waiting_retry' | 'offline' | 'auth_required' | 'attention';

export interface SyncFacts {
  online: boolean; syncing: boolean; authPaused: boolean;
  queued: number; inflight: number; rejected: number; openConflicts: number;
  nextRetryAt: number | null; now: number;
}
export interface SyncSnapshot {
  phase: SyncPhase; queued: number; rejected: number; conflicts: number; nextRetryAt: number | null; lastSyncedAt: number | null;
}

/**
 * Priority: sign-in needed beats everything (nothing can sync); an active run is "syncing"; no connection is "offline";
 * queued work whose retry time is in the future is "waiting_retry"; anything the user must decide is "attention".
 * "synced" is only ever shown when nothing is queued, rejected or in conflict.
 */
export function deriveSyncPhase(f: SyncFacts): SyncPhase {
  if (f.authPaused) return 'auth_required';
  if (f.syncing) return 'syncing';
  if (!f.online) return 'offline';
  if (f.queued + f.inflight > 0) return f.nextRetryAt !== null && f.nextRetryAt > f.now ? 'waiting_retry' : 'syncing';
  if (f.rejected > 0 || f.openConflicts > 0) return 'attention';
  return 'synced';
}
