import { Outbox } from '../sync/outbox';
import { PersonalTaskRepo } from '../sync/personalRepo';
import { SyncEngine } from '../sync/engine';
import { migrate } from '../sync/schema';
import type { RpcClient, SqlDriver } from '../sync/types';
import { deriveSyncPhase } from '../sync/snapshot';
import type { InboxItem, StoreState, TaskStore } from './TaskStore';

/** Real store: UI reads only local SQLite; writes are optimistic + outbox; a sync loop pushes and pulls. */
export function createSqliteStore(db: SqlDriver, rpc: RpcClient, opts: { autoSync?: boolean } = {}): TaskStore & { sync(): Promise<void>; connectivityRestored(): Promise<void>; engine: SyncEngine } {
  migrate(db);
  const outbox = new Outbox(db);
  outbox.recoverInflight();
  const engine = new SyncEngine(db, outbox, rpc);
  const repo = new PersonalTaskRepo(db, outbox);
  const subs = new Set<() => void>();
  let online = true;
  let running = false;
  let lastSyncedAt: number | null = null;
  const EDITABLE = new Set(['title', 'planned_date', 'priority', 'notes']);
  let state = compute();
  function titleFor(entityId: string, args: string): string {
    const row = db.all<{ data_json: string }>("select data_json from local_rows where stream = 'personal_tasks' and id = ?", [entityId])[0];
    if (row) return (JSON.parse(row.data_json) as { title?: string }).title ?? 'Task';
    try { const a = JSON.parse(args) as unknown[]; if (typeof a[2] === 'string') return a[2]; const p = a[1] as { title?: string } | undefined; if (p?.title) return p.title; } catch { /* fall through */ }
    return 'Task';
  }
  function inbox(): InboxItem[] {
    const items: InboxItem[] = [];
    for (const o of db.all<{ seq: number; entity_id: string; args_json: string; error_code: string | null }>("select seq, entity_id, args_json, error_code from outbox where state = 'rejected' order by seq")) {
      items.push({ kind: 'rejected', key: `r${o.seq}`, seq: o.seq, title: titleFor(o.entity_id, o.args_json), code: o.error_code ?? 'unknown', retryable: o.error_code !== 'dependency_rejected' && o.error_code !== 'op_expired' });
    }
    for (const c of db.all<{ id: number; entity_id: string; kind: string; field: string | null; local_value: string | null; server_value: string | null; state: string }>(
      "select id, entity_id, kind, field, local_value, server_value, state from sync_conflicts where state in ('open','applied') order by id")) {
      const title = titleFor(c.entity_id, '[]');
      if (c.kind === 'deleted_remotely') items.push({ kind: 'deleted_remotely', key: `c${c.id}`, id: c.id, title });
      else items.push({ kind: 'conflict', key: `c${c.id}`, id: c.id, title, field: c.field ?? '', mine: c.local_value ?? 'null', theirs: c.server_value ?? 'null', restorable: c.state === 'applied' && EDITABLE.has(c.field ?? '') });
    }
    return items;
  }
  function compute(): StoreState {
    const c = outbox.counts();
    const conflicts = db.all<{ n: number }>("select count(*) as n from sync_conflicts where state in ('open','applied')")[0]!.n;
    return {
      tasks: repo.list().map((t) => ({ id: t.id, title: t.title, done: t.status === 'done', pending: t.pending })),
      online, waiting: (c.queued ?? 0) + (c.inflight ?? 0), needAttention: (c.rejected ?? 0) + conflicts,
      inbox: inbox(),
      sync: {
        phase: deriveSyncPhase({ online, syncing: running, authPaused: engine.status === 'paused_unauthorized', queued: c.queued ?? 0, inflight: c.inflight ?? 0,
          rejected: c.rejected ?? 0, openConflicts: conflicts, nextRetryAt: outbox.nextDueAt(), now: Date.now() }),
        queued: (c.queued ?? 0) + (c.inflight ?? 0), rejected: c.rejected ?? 0, conflicts, nextRetryAt: outbox.nextDueAt(), lastSyncedAt,
      },
    };
  }
  const emit = () => { state = compute(); subs.forEach((f) => f()); };
  let syncing: Promise<void> | null = null;
  const sync = (): Promise<void> => {
    if (syncing) return syncing;
    syncing = (async () => {
      running = true; emit();
      try {
        // Pull BEFORE pushing so a concurrent remote edit is seen (and recorded as a conflict) while our op is still pending.
        // Best effort: a failure here is not fatal, push() below decides online/offline/unauthorized.
        if (outbox.counts().queued) { try { await engine.pull('personal_tasks'); } catch { /* handled by push */ } }
        const rep = await engine.push();
        online = rep.status !== 'waiting';
        if (online) { await engine.pull('personal_tasks'); if (outbox.nextDueAt() === null) lastSyncedAt = Date.now(); }
      } catch {
        online = false;
      } finally { running = false; syncing = null; emit(); scheduleRetry(); }
    })();
    return syncing;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Never gives up: wake up when the earliest queued op is due again. */
  function scheduleRetry(): void {
    if (timer || opts.autoSync === false) return;
    const next = outbox.nextDueAt();
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
    retryNow() { engine.resumeAfterTokenRefresh(); db.run("update outbox set next_attempt_at = 0 where state = 'queued'"); void sync(); },
    retryRejected(seq) { if (outbox.retryRejected(seq)) kick(); },
    discardRejected(seq) { outbox.discardRejected(seq); emit(); },
    restoreOtherValue(cid) {
      const c = db.all<{ entity_id: string; field: string; server_value: string; state: string }>('select entity_id, field, server_value, state from sync_conflicts where id = ?', [cid])[0];
      if (!c || c.state !== 'applied' || !EDITABLE.has(c.field)) return;
      db.transaction(() => {
        repo.update(c.entity_id, { [c.field]: JSON.parse(c.server_value) } as Record<string, string | null>);
        db.run("update sync_conflicts set state = 'resolved' where id = ?", [cid]);
      });
      kick();
    },
    dismissConflict(cid) { db.run("update sync_conflicts set state = 'dismissed' where id = ? and state in ('open','applied')", [cid]); emit(); },
    fullResync() { void (async () => { try { await engine.fullResync('personal_tasks'); lastSyncedAt = Date.now(); } catch { online = false; } emit(); })(); },
  };
}
