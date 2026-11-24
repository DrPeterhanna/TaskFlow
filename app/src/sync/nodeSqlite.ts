import { DatabaseSync } from 'node:sqlite';
import type { SqlDriver, SqlValue } from './types.js';

/** Driver for tests and tooling. The Expo app supplies an expo-sqlite adapter with the same interface. */
export function openNodeSqlite(path = ':memory:'): SqlDriver {
  const db = new DatabaseSync(path);
  let depth = 0;
  return {
    exec: (sql) => db.exec(sql),
    run(sql, params = []) {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.exec(depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      try {
        const r = fn();
        db.exec(depth === 1 ? 'COMMIT' : `RELEASE ${name}`);
        return r;
      } catch (e) {
        db.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
