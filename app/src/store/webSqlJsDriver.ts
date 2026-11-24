import type { SqlDriver, SqlValue } from '../sync/types';

type SqlJsDb = {
  run(sql: string, p?: unknown[]): void; exec(sql: string): unknown; getRowsModified(): number; export(): Uint8Array;
  prepare(sql: string): { bind(p: unknown[]): void; step(): boolean; getAsObject(): Record<string, SqlValue>; free(): void };
};

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u.slice(0, u.length)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * BROWSER-ONLY preview driver: SQLite compiled to WebAssembly (sql.js), persisted to localStorage after each committed
 * transaction so a page reload behaves like an app restart. The device build uses expo-sqlite instead.
 */
export function createSqlJsDriver(SQL: { Database: new (data?: Uint8Array) => SqlJsDb }, storageKey: string): SqlDriver {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
  const db = new SQL.Database(saved ? unb64(saved) : undefined);
  const persist = () => { if (typeof localStorage !== 'undefined') localStorage.setItem(storageKey, b64(db.export())); };
  let depth = 0;
  return {
    exec: (sql) => { db.run(sql); },
    run(sql, params = []) { db.run(sql, params as unknown[]); return { changes: db.getRowsModified() }; },
    all<T>(sql: string, params: SqlValue[] = []) {
      const st = db.prepare(sql); st.bind(params as unknown[]);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      st.free();
      return out;
    },
    transaction<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.run(depth === 1 ? 'BEGIN' : `SAVEPOINT ${name}`);
      try {
        const r = fn();
        db.run(depth === 1 ? 'COMMIT' : `RELEASE ${name}`);
        if (depth === 1) persist();
        return r;
      } catch (e) {
        db.run(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO ${name}`);
        throw e;
      } finally { depth--; }
    },
  };
}
