import { Outbox } from '../sync/outbox';
import { PersonalTaskRepo } from '../sync/personalRepo';
import { SyncEngine } from '../sync/engine';
import { migrate } from '../sync/schema';
import { TransportError, type RpcClient, type SqlDriver } from '../sync/types';
import { deriveSyncPhase } from '../sync/snapshot';
import type { InboxItem, StoreState, TaskStore } from './TaskStore';

/** Real store: UI reads only local SQLite; writes are optimistic + outbox; a sync loop pushes and pulls. */
const CHECKED_RPCS = new Set(['update_personal_task_checked', 'complete_personal_task_checked', 'reopen_personal_task_checked', 'delete_personal_task_checked']);

export function createSqliteStore(db: SqlDriver, rpc: RpcClient, opts: { autoSync?: boolean; closeOnDispose?: boolean; onDispose?: () => void } = {}): TaskStore & { sync(): Promise<void>; connectivityRestored(): Promise<void>; engine: SyncEngine } {
  migrate(db);
  const outbox = new Outbox(db);
  outbox.recoverInflight();
  const engine = new SyncEngine(db, outbox, rpc);
  const repo = new PersonalTaskRepo(db, outbox);
  const subs = new Set<() => void>();
  let disposed = false;
  let online = true;
  let running = false;
  let storageError = false;
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
      items.push({ kind: 'rejected', key: `r${o.seq}`, seq: o.seq, title: titleFor(o.entity_id, o.args_json), code: o.error_code ?? 'unknown', retryable: o.error_code !== 'dependency_rejected' && o.error_code !== 'op_expired' && o.error_code !== 'stale_conflict' });
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
        phase: storageError || engine.blocked ? 'attention' : deriveSyncPhase({ online, syncing: running, authPaused: engine.status === 'paused_unauthorized', queued: c.queued ?? 0, inflight: c.inflight ?? 0,
          rejected: c.rejected ?? 0, openConflicts: conflicts, nextRetryAt: outbox.nextDueAt(), now: Date.now() }),
        blocked: storageError ? 'local_storage_error' : engine.blocked, queued: (c.queued ?? 0) + (c.inflight ?? 0), rejected: c.rejected ?? 0, conflicts, nextRetryAt: outbox.nextDueAt(), lastSyncedAt,
      },
    };
  }
  const emit = () => { if (disposed) return; try { state = compute(); } catch { storageError = true; state = { ...state, sync: state.sync ? { ...state.sync, phase: 'attention', blocked: 'local_storage_error' } : undefined }; } subs.forEach((f) => f()); };
  let syncing: Promise<void> | null = null;
  let serial: Promise<void> = Promise.resolve();
  const exclusive = (job: () => Promise<void>): Promise<void> => {
    const next = serial.then(async () => { if (!disposed) await job(); });
    serial = next.catch(() => {}); return next;
  };
  const recover = (job: () => Promise<void>) => exclusive(async () => {
    try { await job(); } catch (e) { if (!(e instanceof TransportError)) storageError = true; else online = false; } finally { emit(); }
  });
  const sync = (): Promise<void> => {
    if (disposed || storageError || engine.status === 'paused_unauthorized') return Promise.resolve();
    if (syncing) return syncing;
    syncing = exclusive(async () => {
      running = true; emit();
      try {
        // Pull BEFORE pushing so a concurrent remote edit is seen (and recorded as a conflict) while our op is still pending.
        // Best effort: a failure here is not fatal, push() below decides online/offline/unauthorized.
        if (outbox.counts().queued) { try { await engine.pull('personal_tasks'); } catch { /* handled by push */ } }
        const rep = await engine.push();
        if (disposed) return;
        if (engine.lastTransportFailure) online = false;
        if (!engine.lastTransportFailure && rep.status !== 'paused_unauthorized') { await engine.pull('personal_tasks'); online = true; if (outbox.nextDueAt() === null) lastSyncedAt = Date.now(); }
      } catch (e) {
        if (!(e instanceof TransportError)) storageError = true;
        online = false;
      } finally { running = false; syncing = null; emit(); scheduleRetry(); }
    });
    return syncing;
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Never gives up: wake up when the earliest queued op is due again. */
  function scheduleRetry(): void {
    if (disposed || timer || opts.autoSync === false || storageError || engine.status === 'paused_unauthorized') return;
    const next = outbox.nextDueAt();
    if (next === null || next === undefined) return;
    timer = setTimeout(() => { timer = null; void sync(); }, Math.max(500, Number(next) - Date.now()));
  }
  const active = () => { if (disposed) throw new Error('store disposed'); if (storageError) throw new Error('local storage needs recovery'); };
  const write = (job: () => void) => { active(); try { job(); kick(); } catch { storageError = true; emit(); throw new Error('local storage needs recovery'); } };
  const kick = () => { active(); emit(); if (opts.autoSync !== false) void sync(); };
  // Resume a durable queue after cold boot even without a new UI mutation.
  if (opts.autoSync !== false) queueMicrotask(() => { if (!disposed) void sync(); });
  return {
    engine, sync,
    dispose() { if (disposed) return; disposed = true; if (timer) clearTimeout(timer); timer = null; subs.clear(); engine.stop(); opts.onDispose?.(); if (opts.closeOnDispose) { void serial.finally(() => db.close?.()); } },
    /** Network came back: clear backoff and push now (like the OS connectivity event on a device). */
    connectivityRestored() { if (disposed) return Promise.resolve(); engine.resumeAfterTokenRefresh(); db.run("update outbox set next_attempt_at = 0 where state = 'queued'"); return sync(); },
    getState: () => state,
    subscribe: (f) => { subs.add(f); return () => { subs.delete(f); }; },
    add(title) { write(() => repo.create(title)); },
    rename(id, title, expectedTitle) { if (expectedTitle !== undefined && repo.get(id)?.title !== expectedTitle) throw new Error('title changed while editing'); const value = title.trim(); if (!value || value.length > 300) throw new Error('title must be 1 to 300 characters'); write(() => repo.update(id, { title: value })); },
    toggle(id) { write(() => { const t = repo.get(id); if (t) { if (t.status === 'done') repo.reopen(id); else repo.complete(id); } }); },
    remove(id) { write(() => repo.remove(id)); },
    retryNow() { if (disposed) return; engine.resumeAfterTokenRefresh(); db.run("update outbox set next_attempt_at = 0 where state = 'queued'"); void sync(); },
    retryRejected(seq) { active(); if (outbox.retryRejected(seq)) kick(); },
    /** "Apply mine anyway" after a stale_conflict: pull what the other device did, then queue a FRESH op whose base is that value. The server re-checks atomically. */
    keepMineAfterConflict(seq) {
      void recover(async () => {
        const op = db.all<{ rpc: string; entity_id: string; args_json: string; error_code: string | null }>("select rpc, entity_id, args_json, error_code from outbox where seq = ? and state = 'rejected'", [seq])[0];
        if (!op || op.error_code !== 'stale_conflict' || !CHECKED_RPCS.has(op.rpc)) return;
        try { await engine.pull('personal_tasks'); } catch { return; }       // need the other value first; stay in the inbox if offline
        const patch = (JSON.parse(op.args_json) as [string, Record<string, unknown>])[1];
        db.transaction(() => {
          // a FRESH op, built from the state just pulled, so its base is what the user now sees; the server checks it again atomically
          if (op.rpc === 'update_personal_task_checked') repo.update(op.entity_id, patch as never);
          else if (op.rpc === 'complete_personal_task_checked') { if (repo.get(op.entity_id)?.status !== 'done') repo.complete(op.entity_id); }
          else if (op.rpc === 'reopen_personal_task_checked') { if (repo.get(op.entity_id)?.status === 'done') repo.reopen(op.entity_id); }
          else if (repo.get(op.entity_id)) repo.remove(op.entity_id);
          // Resolving this root is not permission to discard dependent user intents. Keep those visible.
          db.run("update outbox set state = 'dead' where seq = ? and state = 'rejected'", [seq]);
        });
        kick();
      });
    },
    discardRejected(seq) { active(); outbox.discardRejected(seq); emit(); },
    restoreOtherValue(cid) {
      active();
      const c = db.all<{ entity_id: string; field: string; server_value: string; state: string }>('select entity_id, field, server_value, state from sync_conflicts where id = ?', [cid])[0];
      if (!c || c.state !== 'applied' || !EDITABLE.has(c.field)) return;
      db.transaction(() => {
        repo.update(c.entity_id, { [c.field]: JSON.parse(c.server_value) } as Record<string, string | null>);
        db.run("update sync_conflicts set state = 'resolved' where id = ?", [cid]);
      });
      kick();
    },
    dismissConflict(cid) { active(); db.run("update sync_conflicts set state = 'dismissed' where id = ? and state in ('open','applied')", [cid]); emit(); },
    fullResync() { return recover(async () => { await engine.fullResync('personal_tasks'); lastSyncedAt = Date.now(); }); },
  };
}
