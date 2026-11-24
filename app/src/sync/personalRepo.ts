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
   * Delete. The base is what this device saw: the server row_version of the task and of EVERY live subtask (a row that is not on the
   * server yet counts as 0), plus the ids of this device's own earlier ops on those tasks, which legitimately raise versions. The
   * server refuses (terminal stored result) if anyone else changed, added or restored a task in that subtree, so a remote edit
   * is never deleted unseen, and the guard is never skipped. Resolution builds a fresh base from freshly pulled rows.
   */
  remove(id: string): void {
    this.db.transaction(() => {
      if (!this.get(id)) throw new Error('task not found locally');
      const rows = this.db.all<{ id: string; data_json: string; deleted: number }>("select id, data_json, deleted from local_rows where stream = 'personal_tasks'");
      const byParent = new Map<string, string[]>();
      const rv = new Map<string, number>();
      for (const r of rows) {
        const d = JSON.parse(r.data_json) as { parent_id?: string | null; row_version?: number };
        rv.set(r.id, typeof d.row_version === 'number' ? d.row_version : 0);
        if (d.parent_id && !r.deleted) byParent.set(d.parent_id, [...(byParent.get(d.parent_id) ?? []), r.id]);
      }
      const ids: string[] = []; const walk = (x: string): void => { ids.push(x); for (const c of byParent.get(x) ?? []) walk(c); };
      walk(id);
      const map: Record<string, number> = {}; for (const x of ids) map[x] = rv.get(x) ?? 0;
      const own = this.db.all<{ op_id: string }>(
        `select op_id from outbox where entity_type = 'personal_tasks' and entity_id in (${ids.map(() => '?').join(',')}) and state in ('queued','inflight')`, ids).map((o) => o.op_id);
      this.db.run("update local_rows set deleted = 1, pending = 1, base_json = case when change_xid is not null and base_json is null then data_json else base_json end where stream = 'personal_tasks' and id = ?", [id]);
      this.outbox.enqueue({ rpc: 'delete_personal_task_checked', entityType: 'personal_tasks', entityId: id, args: [id, { rows: map, own_ops: own }] });
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
