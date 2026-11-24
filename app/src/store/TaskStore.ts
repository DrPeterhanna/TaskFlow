export interface TaskItem { id: string; title: string; done: boolean; pending: boolean }
export type InboxItem =
  | { kind: 'rejected'; key: string; seq: number; title: string; code: string; retryable: boolean }
  | { kind: 'conflict'; key: string; id: number; title: string; field: string; mine: string; theirs: string; restorable: boolean }
  | { kind: 'deleted_remotely'; key: string; id: number; title: string };
export interface SyncView {
  phase: 'synced' | 'syncing' | 'waiting_retry' | 'offline' | 'auth_required' | 'attention';
  blocked?: 'server_update_required' | null;
  queued: number; rejected: number; conflicts: number; nextRetryAt: number | null; lastSyncedAt: number | null;
}
export interface StoreState {
  sync?: SyncView;
  inbox?: InboxItem[];
  tasks: TaskItem[];
  online: boolean;
  waiting: number;
  needAttention: number;
}
/** What the UI sees. The real implementation reads only from local SQLite. */
export interface TaskStore {
  getState(): StoreState;
  subscribe(fn: () => void): () => void;
  add(title: string): void;
  toggle(id: string): void;
  remove(id: string): void;
  setOnline?(online: boolean): void;   // preview only
  // Recovery actions (real store only; the preview store keeps simple stubs)
  retryNow?(): void;
  retryRejected?(seq: number): void;
  discardRejected?(seq: number): void;
  keepMineAfterConflict?(seq: number): void;
  restoreOtherValue?(conflictId: number): void;
  dismissConflict?(conflictId: number): void;
  fullResync?(): void;
}
