import type { SqlDriver } from './types';

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
  // 3: recovery state. skipped_rows marks server rows we did not apply because a local op was pending (cursor is rewound
  // to re-fetch them once settled). sync_conflicts is the user-visible record of concurrent edits.
  `create table skipped_rows (
     stream text not null, id text not null, xid text not null,
     primary key (stream, id)
   );
   create table sync_conflicts (
     id integer primary key autoincrement,
     stream text not null, entity_id text not null,
     kind text not null check (kind in ('field','deleted_remotely')),
     field text, base_value text, local_value text, server_value text,
     state text not null default 'open' check (state in ('open','applied','moot','resolved','dismissed')),
     detected_at integer not null,
     unique (stream, entity_id, kind, field, state)
   );`,
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
