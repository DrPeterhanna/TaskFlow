import type { SqlDriver } from './types.js';

const MIGRATIONS: string[] = [
  `create table outbox (
     seq integer primary key autoincrement,
     op_id text not null unique,
     rpc text not null,
     entity_type text not null,
     entity_id text not null,
     args_json text not null,
     created_at integer not null,
     attempts integer not null default 0,
     next_attempt_at integer not null default 0,
     state text not null default 'queued' check (state in ('queued','inflight','acked','rejected','dead')),
     error_code text,
     error_message text,
     depends_on_seq integer references outbox(seq)
   );
   create index outbox_state_idx on outbox(state, seq);
   create table local_rows (
     stream text not null,
     id text not null,
     data_json text not null,
     change_xid text,          -- null while the row only exists optimistically
     pending integer not null default 0,
     deleted integer not null default 0,
     primary key (stream, id)
   );
   create table sync_cursor (
     stream text primary key,
     after_xid text not null default '0',
     after_id text not null default '',
     horizon text
   );
   create table meta (key text primary key, value text not null);`,
  `alter table local_rows add column base_json text;   -- last server-confirmed value while an optimistic edit is pending`,
];

export function migrate(db: SqlDriver): number {
  db.exec('create table if not exists schema_version (v integer not null)');
  const cur = db.all<{ v: number }>('select coalesce(max(v), 0) as v from schema_version')[0]!.v;
  for (let i = cur; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.run('insert into schema_version (v) values (?)', [i + 1]);
    });
  }
  return MIGRATIONS.length;
}
