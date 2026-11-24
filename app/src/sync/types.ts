export type SqlValue = string | number | bigint | null;
export interface SqlDriver {
  exec(sql: string): void;
  close?(): void;
  run(sql: string, params?: SqlValue[]): { changes: number };
  all<T = Record<string, SqlValue>>(sql: string, params?: SqlValue[]): T[];
  /** Runs fn atomically; rolls back if it throws. */
  transaction<T>(fn: () => T): T;
}

export type OutboxState = 'queued' | 'inflight' | 'acked' | 'rejected' | 'dead';

export interface OutboxOp {
  seq: number;
  op_id: string;
  rpc: string;
  entity_type: string;
  entity_id: string;
  args_json: string;
  attempts: number;
  next_attempt_at: number;
  state: OutboxState;
  error_code: string | null;
  depends_on_seq: number | null;
}

/** Business-level server answer (the server returns { ok, ... } or raises a typed error). */
export type RpcResult =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message?: string };

export class TransportError extends Error {
  constructor(message: string, readonly kind: 'network' | 'server' | 'unauthorized' = 'network') {
    super(message);
  }
}

export interface RpcClient {
  /** Must reuse the same opId on every retry. Throws TransportError for network, 5xx, 401. */
  call(rpc: string, args: unknown[], opId: string): Promise<RpcResult>;
  pull(stream: string, afterXid: string, afterId: string, horizon: string | null, limit: number): Promise<PullPage>;
  /** Optional: asks the server whether this cursor is older than its purge floor. */
  status?(stream: string, afterXid: string): Promise<{ full_resync_required: boolean; floor_xid: string }>;
}

export interface PullPage {
  rows: Array<Record<string, unknown> & { id: string; change_xid: string; deleted_at?: string | null }>;
  horizon: string;
  next_xid: string | null;
  next_id: string | null;
}

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
