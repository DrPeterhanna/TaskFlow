import { Outbox } from '../sync/outbox';
import { PersonalTaskRepo } from '../sync/personalRepo';
import { SyncEngine } from '../sync/engine';
import { migrate } from '../sync/schema';
import type { RpcClient, SqlDriver } from '../sync/types';
import type { StoreState, TaskStore } from './TaskStore';

/** Real store: UI reads only local SQLite; writes are optimistic + outbox; a sync loop pushes and pulls. */
export function createSqliteStore(db: SqlDriver, rpc: RpcClient, opts: { autoSync?: boolean } = {}): TaskStore & { sync(): Promise<void>; connectivityRestored(): Promise<void>; engine: SyncEngine } {
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
      } finally { syncing = null; emit(); scheduleRetry(); }
    })();
    return syncing;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Never gives up: wake up when the earliest queued op is due again. */
  function scheduleRetry(): void {
    if (timer || opts.autoSync === false) return;
    const next = db.all<{ t: number | null }>("select min(next_attempt_at) as t from outbox where state = 'queued'")[0]?.t;
    if (next === null || next === undefined) return;
    timer = setTimeout(() => { timer = null; void sync(); }, Math.max(500, Number(next) - Date.now()));
  }
  const kick = () => { emit(); if (opts.autoSync !== false) void sync(); };
  return {
    engine, sync,
    /** Network came back: clear backoff and push now (like the OS connectivity event on a device). */
    connectivityRestored() { db.run("update outbox set next_attempt_at = 0 where state = 'queued'"); return sync(); },
    getState: () => state,
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    add(title) { repo.create(title); kick(); },
    toggle(id) {
      const t = repo.get(id);
      if (t) { if (t.status === 'done') repo.reopen(id); else repo.complete(id); }
      kick();
    },
    remove(id) { repo.remove(id); kick(); },
  };
}
