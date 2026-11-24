import { Outbox } from '../sync/outbox';
import { PersonalTaskRepo } from '../sync/personalRepo';
import { SyncEngine } from '../sync/engine';
import { migrate } from '../sync/schema';
import type { RpcClient, SqlDriver } from '../sync/types';
import type { StoreState, TaskStore } from './TaskStore';

/** Real store: UI reads only local SQLite; writes are optimistic + outbox; a sync loop pushes and pulls. */
export function createSqliteStore(db: SqlDriver, rpc: RpcClient, opts: { autoSync?: boolean } = {}): TaskStore & { sync(): Promise<void>; engine: SyncEngine } {
  migrate(db);
  const outbox = new Outbox(db);
  outbox.recoverInflight();
  const engine = new SyncEngine(db, outbox, rpc);
  const repo = new PersonalTaskRepo(db, outbox);
  const subs = new Set<() => void>();
  let online = true;
  let state = compute();
  function compute(): StoreState {
    const c = outbox.counts();
    return {
      tasks: repo.list().map((t) => ({ id: t.id, title: t.title, done: t.status === 'done', pending: t.pending })),
      online, waiting: (c.queued ?? 0) + (c.inflight ?? 0), needAttention: c.rejected ?? 0,
    };
  }
  const emit = () => { state = compute(); subs.forEach((f) => f()); };
  let syncing: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      try {
        const rep = await engine.push();
        online = rep.status !== 'waiting';
        if (online) await engine.pull('personal_tasks');
      } catch {
        online = false;
      } finally { syncing = null; emit(); }
    })();
    return syncing;
  };
  const kick = () => { emit(); if (opts.autoSync !== false) void sync(); };
  return {
    engine, sync,
    getState: () => state,
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    add(title) { repo.create(title); kick(); },
    toggle(id) {
      const t = repo.get(id);
      if (t && t.status !== 'done') repo.complete(id);   // reopen is a separate op; UI wiring comes with the Phase 4 task screens
      kick();
    },
    remove(id) { repo.remove(id); kick(); },
  };
}
