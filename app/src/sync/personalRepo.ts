import { uuidv7 } from './ids.js';
import { Outbox } from './outbox.js';
import type { Clock, SqlDriver } from './types.js';
import { systemClock } from './types.js';

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
      this.patch(id, { status: 'done' });
      this.outbox.enqueue({ rpc: 'complete_personal_task', entityType: 'personal_tasks', entityId: id, args: [id] });
    });
  }

  remove(id: string): void {
    this.db.transaction(() => {
      if (!this.get(id)) throw new Error('task not found locally');
      this.db.run("update local_rows set deleted = 1, pending = 1, base_json = case when change_xid is not null and base_json is null then data_json else base_json end where stream = 'personal_tasks' and id = ?", [id]);
      this.outbox.enqueue({ rpc: 'delete_personal_task', entityType: 'personal_tasks', entityId: id, args: [id] });
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
