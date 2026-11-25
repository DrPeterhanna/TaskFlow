import { accountPartition } from './accountLifecycle';
import * as SQLite from 'expo-sqlite';
import type { SqlDriver, SqlValue } from '../sync/types';

/**
 * expo-sqlite adapter. One database file per account id (tf_<userId>.db): accounts never share data.
 * UNVERIFIED ON DEVICE: type-checked only. Needs a development build run on iOS and Android.
 */
export function openAccountDb(userId: string, environment: string): SqlDriver {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user id for database name');
  const db = SQLite.openDatabaseSync(`tf_${accountPartition(environment, userId)}.db`);
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  let depth = 0;
  return {
    close: () => db.closeSync(),
    exec: (sql) => db.execSync(sql),
    run(sql, params = []) {
      const r = db.runSync(sql, params as SQLite.SQLiteBindValue[]);
      return { changes: r.changes };
    },
    all<T>(sql: string, params: SqlValue[] = []) {
      return db.getAllSync(sql, params as SQLite.SQLiteBindValue[]) as T[];
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.execSync(depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      try {
        const r = fn();
        db.execSync(depth === 1 ? 'COMMIT' : `RELEASE ${name}`);
        return r;
      } catch (e) {
        db.execSync(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
  };
}
