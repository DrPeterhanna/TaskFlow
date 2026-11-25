import { validatePullPage, validateSyncStatus, validateRpcResult } from './validation';
import { backoffMs, Outbox } from './outbox';
import type { Clock, RpcClient, SqlDriver } from './types';
import { systemClock, TransportError } from './types';

export const TRACKED_FIELDS = ['title', 'status', 'parent_id', 'planned_date', 'priority', 'notes', 'due_date', 'estimate_min'] as const;

export type SyncStatus = 'idle' | 'waiting' | 'paused_unauthorized';

export interface PushReport { sent: number; acked: number; rejected: number; status: SyncStatus }

const CHECKED = new Set(['update_personal_task_checked', 'complete_personal_task_checked', 'reopen_personal_task_checked', 'delete_personal_task_checked']);

export class SyncEngine {
  private stopped = false;
  stop(): void { this.stopped = true; }
  private active(): void { if (this.stopped) throw new TransportError('worker disposed', 'unauthorized'); }
  status: SyncStatus = 'idle';
  lastTransportFailure: 'network' | 'server' | 'unauthorized' | null = null;
  /** Set when the server cannot process queued work (missing migration). Cleared by the next successful push. */
  blocked: 'server_update_required' | null = null;
  constructor(
    private db: SqlDriver,
    readonly outbox: Outbox,
    private rpc: RpcClient,
    private clock: Clock = systemClock,
    private rand: () => number = Math.random,
  ) {}

  /** Push until the queue is empty, an op is waiting out a backoff, or the transport fails. */
  async push(): Promise<PushReport> {
    const rep: PushReport = { sent: 0, acked: 0, rejected: 0, status: 'idle' };
    this.blocked = null;
    this.lastTransportFailure = null;
    if (this.status === 'paused_unauthorized') { rep.status = this.status; return rep; }
    for (;;) {
      this.active();
      const op = this.outbox.next();
      if (!op) break;
      // Old checked-delete APIs accepted omitted/exact tokens without proving subtree safety.
      // Never send a destructive op to those servers merely because the RPC name exists.
      if (op.rpc === 'delete_personal_task_checked') {
        if (!this.rpc.status) { this.blocked = 'server_update_required'; this.outbox.retryLater(op.seq, 300_000); rep.status = 'waiting'; return rep; }
        try {
          const capability = await this.rpc.status('personal_tasks', '0'); this.active(); validateSyncStatus(capability);
          if ((capability.mutation_safety_version ?? 0) < 2) {
            this.blocked = 'server_update_required'; this.outbox.retryLater(op.seq, 300_000);
            rep.status = 'waiting'; return rep;
          }
        } catch (e) {
          if (!(e instanceof TransportError)) throw e;
          this.lastTransportFailure = e.kind; this.status = e.kind === 'unauthorized' ? 'paused_unauthorized' : 'waiting';
          this.outbox.retryLater(op.seq, backoffMs(op.attempts + 1, this.rand)); rep.status = this.status; return rep;
        }
      }
      this.outbox.markInflight(op.seq);
      rep.sent++;
      try {
        const res = await this.rpc.call(op.rpc, JSON.parse(op.args_json) as unknown[], op.op_id);
        this.active(); validateRpcResult(res);
        this.db.transaction(() => {
          if (res.ok) { this.outbox.ack(op.seq); this.recordOverwrites(op, res); this.advanceChain(op, res); this.clearPending(op.entity_type, op.entity_id); }
          else if (res.code === 'unsupported') {
            // The server lacks a function this op needs (migration not applied). NEVER fall back to a weaker unchecked call:
            // the op stays queued with its intent, same op_id, and the user is told the server needs updating.
            this.outbox.retryLater(op.seq, 300_000);
            this.blocked = 'server_update_required';
          } else { this.rollbackRejected(this.outbox.reject(op.seq, res.code, res.message)); }
        });
        if (res.ok) rep.acked++; else if (res.code === 'unsupported' && CHECKED.has(op.rpc)) { rep.sent--; rep.status = 'waiting'; return rep; } else rep.rejected++;
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
        this.lastTransportFailure = e.kind;
        if (e.kind === 'unauthorized') {
          this.outbox.retryLater(op.seq, 0);
          this.status = 'paused_unauthorized';
        } else {
          this.outbox.retryLater(op.seq, backoffMs(op.attempts + 1, this.rand));
          this.status = 'waiting';
        }
        rep.status = this.status;
        return rep;
      }
    }
    this.status = this.outbox.counts().queued ? 'waiting' : 'idle';
    rep.status = this.status;
    return rep;
  }

  resumeAfterTokenRefresh(): void { if (this.status === 'paused_unauthorized') this.status = 'waiting'; }

  /**
   * A rejected op must not leave a lie on screen. When an entity has no live ops left, restore its last
   * server-confirmed value; a row that only ever existed locally is hidden (the op stays in the Sync Inbox).
   */
  private rollbackRejected(ops: Array<{ entity_type: string; entity_id: string }>): void {
    for (const o of ops) {
      if (this.outbox.hasLiveOps(o.entity_type, o.entity_id)) continue;
      this.settle(o.entity_type, o.entity_id, 'rejected');
      const r = this.db.all<{ base_json: string | null; change_xid: string | null }>(
        'select base_json, change_xid from local_rows where stream = ? and id = ?', [o.entity_type, o.entity_id])[0];
      if (!r) continue;
      if (r.base_json !== null) {
        this.db.run('update local_rows set data_json = base_json, base_json = null, deleted = 0, pending = 0 where stream = ? and id = ?', [o.entity_type, o.entity_id]);
      } else if (r.change_xid === null) {
        this.db.run('update local_rows set deleted = 1, pending = 0 where stream = ? and id = ?', [o.entity_type, o.entity_id]);
      } else {
        this.db.run('update local_rows set pending = 0 where stream = ? and id = ?', [o.entity_type, o.entity_id]);
      }
    }
  }

  private clearPending(entityType: string, entityId: string): void {
    // acked means the server knows the row; '0' marks "server-known, xid not yet pulled" (a pull overwrites it)
    this.db.run("update local_rows set change_xid = coalesce(change_xid, '0') where stream = ? and id = ?", [entityType, entityId]);
    // A later queued op on the same entity keeps it pending.
    const more = this.db.all("select 1 as x from outbox where entity_type = ? and entity_id = ? and state in ('queued','inflight')", [entityType, entityId]);
    if (more.length === 0) {
      this.db.run('update local_rows set pending = 0, base_json = null where stream = ? and id = ?', [entityType, entityId]);
      this.settle(entityType, entityId, 'acked');
    }
  }

  /**
   * Version chain. Each acknowledged op of this device reports the task's row_version before and after it. A delete queued behind it
   * carries the version the user saw; this moves that base forward over the device's OWN ops only. If the version before our op is
   * not the one we expected, somebody else changed the task in between: the queued delete's base is set to -1 so the server refuses it
   * (terminal stale_conflict with the current values) instead of deleting an edit the user never saw.
   */
  private advanceChain(op: { rpc: string; entity_type: string; entity_id: string }, res: { data?: unknown }): void {
    if (op.entity_type !== 'personal_tasks') return;
    let before: number | undefined, after: number | undefined;
    if (op.rpc === 'create_personal_task') { before = 0; after = 1; }
    else { const d = res.data as { rv_before?: number; rv?: number; already?: boolean } | undefined; before = d?.rv_before; after = d?.rv; }
    if (typeof before !== 'number' || typeof after !== 'number') return;
    const row = this.db.all<{ data_json: string }>("select data_json from local_rows where stream = 'personal_tasks' and id = ?", [op.entity_id])[0];
    if (row) {
      const d = JSON.parse(row.data_json) as { row_version?: number };
      if ((d.row_version ?? 0) === before && op.rpc !== 'create_personal_task') this.db.run("update local_rows set data_json = ? where stream = 'personal_tasks' and id = ?", [JSON.stringify({ ...d, row_version: after }), op.entity_id]);
    }
    const dels = this.db.all<{ seq: number; args_json: string }>("select seq, args_json from outbox where entity_type = 'personal_tasks' and entity_id = ? and rpc = 'delete_personal_task_checked' and state = 'queued' and transmitted_json is null", [op.entity_id]);
    for (const d of dels) {
      const a = JSON.parse(d.args_json) as [string, { row_version: number; subtree?: unknown }];
      a[1] = { ...a[1], row_version: a[1].row_version === before ? after : -1 };
      this.db.run('update outbox set args_json = ? where seq = ?', [JSON.stringify(a), d.seq]);
    }
  }

  /** The server (0019) says which fields our edit replaced although we had not seen them: record them for the user. */
  private recordOverwrites(op: { rpc: string; entity_type: string; entity_id: string; args_json: string }, res: { data?: unknown }): void {
    if (op.rpc !== 'update_personal_task_checked') return;
    const over = (res.data as { overwritten?: Record<string, unknown> } | undefined)?.overwritten;
    if (!over) return;
    const [, patch, base] = JSON.parse(op.args_json) as [string, Record<string, unknown>, Record<string, unknown>];
    for (const [f, was] of Object.entries(over)) {
      this.db.run(`insert into sync_conflicts (stream, entity_id, kind, field, base_value, local_value, server_value, state, detected_at) values (?,?, 'field', ?,?,?,?, 'applied', ?)
                   on conflict (stream, entity_id, kind, field, state) do update set server_value = excluded.server_value, local_value = excluded.local_value, detected_at = excluded.detected_at`,
        [op.entity_type, op.entity_id, f, JSON.stringify(base?.[f] ?? null), JSON.stringify(patch[f] ?? null), JSON.stringify(was ?? null), this.clock.now()]);
    }
  }

  /**
   * All local ops for an entity are done. (1) Conflicts: an acked op means the server applied our edit AFTER the other
   * device's (field-level last-writer-wins in server order), a rejected op means the server value stands. (2) Server rows
   * we skipped while the op was pending are fetched again by rewinding the stream cursor to just before them.
   */
  private settle(stream: string, id: string, outcome: 'acked' | 'rejected'): void {
    const target = outcome === 'acked' ? 'applied' : 'moot';
    this.db.run(`delete from sync_conflicts where stream = ? and entity_id = ? and state = ?
                 and exists (select 1 from sync_conflicts o where o.stream = sync_conflicts.stream and o.entity_id = sync_conflicts.entity_id and o.kind = sync_conflicts.kind and o.field = sync_conflicts.field and o.state = 'open')`, [stream, id, target]);
    this.db.run("update sync_conflicts set state = ? where stream = ? and entity_id = ? and state = 'open'", [target, stream, id]);
    const sk = this.db.all<{ xid: string }>('select xid from skipped_rows where stream = ? and id = ?', [stream, id])[0];
    if (!sk) return;
    this.db.run('delete from skipped_rows where stream = ? and id = ?', [stream, id]);
    const rewind = (BigInt(sk.xid) - 1n).toString();
    const cur = this.db.all<{ after_xid: string }>('select after_xid from sync_cursor where stream = ?', [stream])[0];
    if (cur && BigInt(cur.after_xid) > BigInt(rewind)) {
      this.db.run("update sync_cursor set after_xid = ?, after_id = '' where stream = ?", [rewind, stream]);
    }
  }

  /** Remember that a server row was not applied because a local op is pending, and record any concurrent-edit conflict. */
  private deferServerRow(stream: string, r: Record<string, unknown> & { id: string; change_xid: string; deleted_at?: string | null }): void {
    const ex = this.db.all<{ xid: string }>('select xid from skipped_rows where stream = ? and id = ?', [stream, r.id])[0];
    if (!ex || BigInt(r.change_xid) < BigInt(ex.xid)) {
      this.db.run('insert into skipped_rows (stream, id, xid) values (?,?,?) on conflict (stream, id) do update set xid = excluded.xid', [stream, r.id, r.change_xid]);
    }
    const loc = this.db.all<{ data_json: string; base_json: string | null }>('select data_json, base_json from local_rows where stream = ? and id = ?', [stream, r.id])[0];
    if (!loc || loc.base_json === null) return;            // row never confirmed by the server: nothing to conflict with
    const base = JSON.parse(loc.base_json) as Record<string, unknown>;
    const mine = JSON.parse(loc.data_json) as Record<string, unknown>;
    const now = this.clock.now();
    if (r.deleted_at) {
      this.db.run(`insert into sync_conflicts (stream, entity_id, kind, field, state, detected_at) values (?,?, 'deleted_remotely', '', 'open', ?)
                   on conflict (stream, entity_id, kind, field, state) do nothing`, [stream, r.id, now]);
      return;
    }
    for (const f of TRACKED_FIELDS) {
      const b = JSON.stringify(base[f] ?? null), m = JSON.stringify(mine[f] ?? null), sv = JSON.stringify((r as Record<string, unknown>)[f] ?? null);
      if (m !== b && sv !== b && sv !== m) {       // both sides changed the same field to different values
        this.db.run(`insert into sync_conflicts (stream, entity_id, kind, field, base_value, local_value, server_value, state, detected_at) values (?,?, 'field', ?,?,?,?, 'open', ?)
                     on conflict (stream, entity_id, kind, field, state) do update set server_value = excluded.server_value, local_value = excluded.local_value`,
          [stream, r.id, f, b, m, sv, now]);
      }
    }
  }

  /**
   * Discard the non-pending local copy of a stream and fetch it again from zero. Rows with unsent local ops are kept
   * (never lose user work). Used when the server says the cursor is older than its purge floor, and as a manual repair.
   */
  async fullResync(stream: string): Promise<number> {
    // Stage all server data first. A failed request never destroys the last usable cache.
    this.active();
    const rows: Array<Record<string, unknown> & { id: string; change_xid: string; deleted_at?: string | null }> = [];
    let xid = '0', id = '', horizon: string | null = null;
    for (;;) {
      const page = await this.rpc.pull(stream, xid, id, horizon, 200); this.active();
      validatePullPage(page,xid,id,horizon,200);
      horizon = page.horizon; rows.push(...page.rows);
      if (rows.length > 100_000) throw new TransportError('resync exceeds safe staging capacity; cache retained', 'server');
      if (page.rows.length < 200 || page.next_xid === null || page.next_id === null) break;
      if (page.next_xid === xid && page.next_id === id) throw new TransportError('non-advancing resync cursor', 'server');
      xid = page.next_xid; id = page.next_id;
    }
    this.db.transaction(() => {
      this.db.run('delete from sync_cursor where stream = ?', [stream]);
      this.db.run('delete from skipped_rows where stream = ?', [stream]);
      this.db.run('delete from local_rows where stream = ? and pending = 0', [stream]);
      for (const row of rows) {
        const local = this.db.all<{pending: number}>('select pending from local_rows where stream = ? and id = ?', [stream, row.id])[0];
        if (local?.pending) { this.deferServerRow(stream, row); continue; }
        this.db.run('insert into local_rows (stream,id,data_json,change_xid,pending,deleted) values (?,?,?,?,0,?)', [stream,row.id,JSON.stringify(row),row.change_xid,row.deleted_at ? 1 : 0]);
      }
      // Cursor zero intentionally forces a normal pull, including pending rows, after atomic replacement.
    });
    return rows.length;
  }

  /**
   * Pull one stream to the horizon. Each page is applied atomically together with its cursor, so a crash
   * resumes exactly after the last applied page. Server rows overwrite local rows that have no pending op;
   * rows with a pending op keep the optimistic value until their op is acked (the next pull then converges).
   */
  async pull(stream: string, limit = 200, skipStatusCheck = false): Promise<number> {
    let applied = 0;
    const cur = this.db.all<{ after_xid: string; after_id: string; horizon: string | null }>('select * from sync_cursor where stream = ?', [stream])[0]
      ?? { after_xid: '0', after_id: '', horizon: null };
    if (!skipStatusCheck && cur.after_xid !== '0' && this.rpc.status) {
      const st = await this.rpc.status(stream, cur.after_xid);
      validateSyncStatus(st); this.active();
      if (st.full_resync_required) return this.fullResync(stream);
    }
    let { after_xid, after_id } = cur;
    let horizon: string | null = null;   // a fresh horizon per pull run; pinned across its pages
    for (;;) {
      this.active();
      const page = await this.rpc.pull(stream, after_xid, after_id, horizon, limit);
      this.active();
      validatePullPage(page,after_xid,after_id,horizon,limit);
      horizon = page.horizon;
      this.db.transaction(() => {
        for (const r of page.rows) {
          const local = this.db.all<{ pending: number }>('select pending from local_rows where stream = ? and id = ?', [stream, r.id])[0];
          if (local && local.pending) { this.deferServerRow(stream, r); continue; }
          this.db.run(
            `insert into local_rows (stream, id, data_json, change_xid, pending, deleted) values (?,?,?,?,0,?)
             on conflict (stream, id) do update set data_json = excluded.data_json, change_xid = excluded.change_xid, deleted = excluded.deleted, base_json = null`,
            [stream, r.id, JSON.stringify(r), r.change_xid, r.deleted_at ? 1 : 0],
          );
        }
        if (page.next_xid !== null && page.next_id !== null) {
          this.db.run(
            `insert into sync_cursor (stream, after_xid, after_id, horizon) values (?,?,?,?)
             on conflict (stream) do update set after_xid = excluded.after_xid, after_id = excluded.after_id, horizon = excluded.horizon`,
            [stream, page.next_xid, page.next_id, page.horizon],
          );
        }
      });
      applied += page.rows.length;
      if (page.rows.length < limit || page.next_xid === null || page.next_id === null) break;
      if (page.next_xid === after_xid && page.next_id === after_id) throw new TransportError('non-advancing pull cursor', 'server');
      after_xid = page.next_xid; after_id = page.next_id;
    }
    return applied;
  }
}
