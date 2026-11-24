import { backoffMs, Outbox } from './outbox.js';
import type { Clock, RpcClient, SqlDriver } from './types.js';
import { systemClock, TransportError } from './types.js';

export type SyncStatus = 'idle' | 'waiting' | 'paused_unauthorized';

export interface PushReport { sent: number; acked: number; rejected: number; status: SyncStatus }

export class SyncEngine {
  status: SyncStatus = 'idle';
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
    if (this.status === 'paused_unauthorized') { rep.status = this.status; return rep; }
    for (;;) {
      const op = this.outbox.next();
      if (!op) break;
      this.outbox.markInflight(op.seq);
      rep.sent++;
      try {
        const res = await this.rpc.call(op.rpc, JSON.parse(op.args_json) as unknown[], op.op_id);
        this.db.transaction(() => {
          if (res.ok) { this.outbox.ack(op.seq); this.clearPending(op.entity_type, op.entity_id); }
          else { this.outbox.reject(op.seq, res.code, res.message); }
        });
        if (res.ok) rep.acked++; else rep.rejected++;
      } catch (e) {
        if (!(e instanceof TransportError)) throw e;
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

  private clearPending(entityType: string, entityId: string): void {
    // A later queued op on the same entity keeps it pending.
    const more = this.db.all("select 1 as x from outbox where entity_type = ? and entity_id = ? and state in ('queued','inflight')", [entityType, entityId]);
    if (more.length === 0) this.db.run('update local_rows set pending = 0 where stream = ? and id = ?', [entityType, entityId]);
  }

  /**
   * Pull one stream to the horizon. Each page is applied atomically together with its cursor, so a crash
   * resumes exactly after the last applied page. Server rows overwrite local rows that have no pending op;
   * rows with a pending op keep the optimistic value until their op is acked (the next pull then converges).
   */
  async pull(stream: string, limit = 200): Promise<number> {
    let applied = 0;
    const cur = this.db.all<{ after_xid: string; after_id: string; horizon: string | null }>('select * from sync_cursor where stream = ?', [stream])[0]
      ?? { after_xid: '0', after_id: '', horizon: null };
    let { after_xid, after_id } = cur;
    let horizon: string | null = null;   // a fresh horizon per pull run; pinned across its pages
    for (;;) {
      const page = await this.rpc.pull(stream, after_xid, after_id, horizon, limit);
      horizon = page.horizon;
      this.db.transaction(() => {
        for (const r of page.rows) {
          const local = this.db.all<{ pending: number }>('select pending from local_rows where stream = ? and id = ?', [stream, r.id])[0];
          if (local && local.pending) continue;
          this.db.run(
            `insert into local_rows (stream, id, data_json, change_xid, pending, deleted) values (?,?,?,?,0,?)
             on conflict (stream, id) do update set data_json = excluded.data_json, change_xid = excluded.change_xid, deleted = excluded.deleted`,
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
      after_xid = page.next_xid; after_id = page.next_id;
    }
    return applied;
  }
}
