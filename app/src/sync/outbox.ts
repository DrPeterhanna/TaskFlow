import { uuidv7 } from './ids.js';
import type { Clock, OutboxOp, SqlDriver } from './types.js';
import { systemClock } from './types.js';

export interface EnqueueInput {
  rpc: string;
  entityType: string;
  entityId: string;
  args: unknown[];
  dependsOnSeq?: number | null;
  opId?: string;
}

/** Retry delay: 2 s base, doubling, full jitter, capped at 5 min. Never gives up on transport errors. */
export function backoffMs(attempts: number, rand: () => number = Math.random): number {
  const cap = Math.min(300_000, 2000 * 2 ** Math.max(0, attempts - 1));
  return Math.floor(rand() * cap);
}

export class Outbox {
  constructor(private db: SqlDriver, private clock: Clock = systemClock) {}

  /** Must be called inside the same transaction as the optimistic local write. */
  enqueue(i: EnqueueInput): OutboxOp {
    const opId = i.opId ?? uuidv7(this.clock.now());
    this.db.run(
      `insert into outbox (op_id, rpc, entity_type, entity_id, args_json, created_at, depends_on_seq)
       values (?,?,?,?,?,?,?)`,
      [opId, i.rpc, i.entityType, i.entityId, JSON.stringify(i.args), this.clock.now(), i.dependsOnSeq ?? null],
    );
    return this.byOpId(opId)!;
  }

  byOpId(opId: string): OutboxOp | undefined {
    return this.db.all<OutboxOp>('select * from outbox where op_id = ?', [opId])[0];
  }

  /** Crash recovery: inflight ops from a previous run go back to queued, SAME op_id (server replays). */
  recoverInflight(): number {
    return this.db.run("update outbox set state = 'queued' where state = 'inflight'").changes;
  }

  /** Next op eligible now: strict FIFO among queued ops; an op whose dependency is unresolved is skipped. */
  next(): OutboxOp | undefined {
    const now = this.clock.now();
    const head = this.db.all<OutboxOp>("select * from outbox where state = 'queued' order by seq limit 1")[0];
    if (!head || head.next_attempt_at > now) return undefined;
    if (head.depends_on_seq !== null) {
      const dep = this.db.all<{ state: string }>('select state from outbox where seq = ?', [head.depends_on_seq])[0];
      if (dep && dep.state !== 'acked') return undefined;
    }
    return head;
  }

  markInflight(seq: number): void {
    this.db.run("update outbox set state = 'inflight', attempts = attempts + 1 where seq = ?", [seq]);
  }
  ack(seq: number): void {
    this.db.run("update outbox set state = 'acked', error_code = null where seq = ?", [seq]);
  }
  /** Business rejection: no retry. Dependents are rejected too so nothing silently disappears. */
  reject(seq: number, code: string, message?: string): void {
    this.db.run("update outbox set state = 'rejected', error_code = ?, error_message = ? where seq = ?", [code, message ?? null, seq]);
    let frontier = [seq];
    while (frontier.length) {
      const kids = this.db.all<{ seq: number }>(
        `select seq from outbox where depends_on_seq in (${frontier.map(() => '?').join(',')}) and state in ('queued','inflight')`,
        frontier,
      );
      frontier = kids.map((k) => k.seq);
      for (const k of frontier) {
        this.db.run("update outbox set state = 'rejected', error_code = 'dependency_rejected' where seq = ?", [k]);
      }
    }
  }
  retryLater(seq: number, delayMs: number): void {
    this.db.run("update outbox set state = 'queued', next_attempt_at = ? where seq = ?", [this.clock.now() + delayMs, seq]);
  }
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ state: string; n: number }>('select state, count(*) as n from outbox group by state')) out[r.state] = Number(r.n);
    return out;
  }
  /** Rows the user must see in the Sync Inbox. */
  rejected(): OutboxOp[] {
    return this.db.all<OutboxOp>("select * from outbox where state = 'rejected' order by seq");
  }
}
