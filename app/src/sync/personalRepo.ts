import { uuidv7 } from './ids';
import { Outbox } from './outbox';
import type { Clock, SqlDriver } from './types';
import { systemClock } from './types';

export interface PersonalTask {
  id: string; title: string; status: string; parent_id: string | null; planned_date: string | null; pending: boolean;
}

/** UI-facing repository: reads only from local SQLite; every write is optimistic local row + outbox op in ONE transaction. */
export class PersonalTaskRepo {
  constructor(private db: SqlDriver, private outbox: Outbox, private clock: Clock = systemClock) {}

  create(title: string, opts: { parentId?: string | null; plannedDate?: string | null } = {}): string {
    const t = title.trim();
    if (t.length < 1 || t.length > 300) throw new Error('title must be 1 to 300 characters');
    const id = uuidv7(this.clock.now());
    this.db.transaction(() => {
      this.db.run(
        'insert into local_rows (stream, id, data_json, pending) values (?,?,?,1)',
        ['personal_tasks', id, JSON.stringify({ id, title: t, status: 'todo', parent_id: opts.parentId ?? null, planned_date: opts.plannedDate ?? null })],
      );
      this.outbox.enqueue({ rpc: 'create_personal_task', entityType: 'personal_tasks', entityId: id, args: [id, opts.parentId ?? null, t, opts.plannedDate ?? null] });
    });
    return id;
  }

  complete(id: string): void {
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error('task not found locally');
      const seen = row.status;                                        // the status the user saw; the server refuses if it is different there (0020)
      this.patch(id, { status: 'done' });
      this.outbox.enqueue({ rpc: 'complete_personal_task_checked', entityType: 'personal_tasks', entityId: id, args: [id, { status: seen }] });
    });
  }

  reopen(id: string): void {
    this.db.transaction(() => {
      const row = this.get(id);
      if (!row) throw new Error('task not found locally');
      const seen = row.status;
      this.patch(id, { status: 'todo' });
      this.outbox.enqueue({ rpc: 'reopen_personal_task_checked', entityType: 'personal_tasks', entityId: id, args: [id, { status: seen }] });
    });
  }

  /** Edit fields. Sends ONLY the edited fields so a concurrent edit of other fields on another device is not overwritten. */
  update(id: string, patch: { title?: string; planned_date?: string | null; priority?: string | null; notes?: string | null }): void {
    const keys = Object.keys(patch);
    if (keys.length === 0) throw new Error('nothing to update');
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (t.length < 1 || t.length > 300) throw new Error('title must be 1 to 300 characters');
      patch = { ...patch, title: t };
    }
    this.db.transaction(() => {
      if (!this.get(id)) throw new Error('task not found locally');
      // base = what this device last saw for the edited fields (server-confirmed value, or the value before our first pending edit).
      // The server compares it under the row lock and reports overwritten fields (migration 0019).
      const r = this.db.all<{ data_json: string; base_json: string | null }>("select data_json, base_json from local_rows where stream = 'personal_tasks' and id = ?", [id])[0]!;
      const seen = JSON.parse(r.base_json ?? r.data_json) as Record<string, unknown>;
      const base: Record<string, unknown> = {};
      for (const k of Object.keys(patch)) if (k in seen) base[k] = seen[k];
      this.patch(id, patch as Record<string, unknown>);
      this.outbox.enqueue({ rpc: 'update_personal_task_checked', entityType: 'personal_tasks', entityId: id, args: [id, patch, base] });
    });
  }

  /**
   * Delete. The base is what this device saw: the task's server row_version (0 when the task was created on this device and
   * is not on the server yet), and, when every live subtask is server-confirmed and nothing is pending below it, a fingerprint of
   * the live subtree. The server refuses (terminal) if either changed, so a remote edit is never deleted unseen. Earlier queued
   * ops of this device on the same task are accounted for by the engine, which advances this base as they are acknowledged.
   */
  remove(id: string): void {
    this.db.transaction(() => {
      if (!this.get(id)) throw new Error('task not found locally');
      const rows = this.db.all<{ id: string; data_json: string; pending: number; deleted: number; change_xid: string | null }>(
        "select id, data_json, pending, deleted, change_xid from local_rows where stream = 'personal_tasks'");
      const byParent = new Map<string, typeof rows>();
      const me = rows.find((r) => r.id === id)!;
      for (const r of rows) { const p = (JSON.parse(r.data_json) as { parent_id?: string | null }).parent_id; if (p && !r.deleted) byParent.set(p, [...(byParent.get(p) ?? []), r]); }
      let n = 0, sum = 0, clean = true;
      const walk = (pid: string): void => { for (const c of byParent.get(pid) ?? []) { const v = (JSON.parse(c.data_json) as { row_version?: number }).row_version; if (c.pending || c.change_xid === null || typeof v !== 'number') clean = false; else { n++; sum += v; } walk(c.id); } };
      walk(id);
      const rv = me.change_xid === null ? 0 : ((JSON.parse(me.data_json) as { row_version?: number }).row_version ?? -1);
      const hasEarlierOps = this.db.all("select 1 as x from outbox where entity_type = 'personal_tasks' and entity_id = ? and state in ('queued','inflight')", [id]).length > 0;
      const base: Record<string, unknown> = { row_version: rv };
      if (clean && !hasEarlierOps) base.subtree = { n, sum };       // with earlier own ops the subtree check is skipped (documented limit)
      this.db.run("update local_rows set deleted = 1, pending = 1, base_json = case when change_xid is not null and base_json is null then data_json else base_json end where stream = 'personal_tasks' and id = ?", [id]);
      this.outbox.enqueue({ rpc: 'delete_personal_task_checked', entityType: 'personal_tasks', entityId: id, args: [id, base] });
    });
  }

  get(id: string): PersonalTask | undefined {
    return this.list(true).find((t) => t.id === id);
  }

  list(includeAll = false): PersonalTask[] {
    const rows = this.db.all<{ data_json: string; pending: number }>(
      `select data_json, pending from local_rows where stream = 'personal_tasks' and deleted = 0 order by id`);
    void includeAll;
    return rows.map((r) => ({ ...(JSON.parse(r.data_json) as Omit<PersonalTask, 'pending'>), pending: !!r.pending }));
  }

  private patch(id: string, p: Record<string, unknown>): void {
    const r = this.db.all<{ data_json: string }>("select data_json from local_rows where stream = 'personal_tasks' and id = ?", [id])[0]!;
    this.db.run("update local_rows set data_json = ?, pending = 1, base_json = case when change_xid is not null and base_json is null then data_json else base_json end where stream = 'personal_tasks' and id = ?",
      [JSON.stringify({ ...(JSON.parse(r.data_json) as object), ...p }), id]);
  }
}
