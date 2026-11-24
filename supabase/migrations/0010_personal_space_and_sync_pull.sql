-- 0010: owner-only personal space (data layer, history, RPCs) and the commit-safe sync pull.
-- Personal data is structurally separate: no policy or definer function lets any manager or admin
-- read it, and personal actions never enter the org events stream or its chain.

create table app.personal_tasks (
  id uuid primary key,   -- client-generated (v7-style), validated by the primary key and ownership
  user_id uuid not null references app.profiles (id) on delete cascade,
  parent_id uuid,
  root_id uuid,
  depth smallint not null default 0 check (depth between 0 and 2),
  title text not null check (char_length(btrim(title)) between 1 and 300),
  notes text check (notes is null or char_length(notes) <= 10000),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'canceled')),
  planned_date date,
  due_date date,
  estimate_min int check (estimate_min is null or estimate_min between 0 and 100000),
  is_required boolean not null default true,
  sort_key text not null default 'a0',
  recurrence_rule_id uuid,
  occurrence_date date,
  completed_at timestamptz,   -- server stamped only
  field_versions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  unique (id, user_id),
  foreign key (parent_id, user_id) references app.personal_tasks (id, user_id),
  check (status <> 'done' or completed_at is not null)
);
create index personal_tasks_change_idx on app.personal_tasks (change_xid, id);
create index personal_tasks_parent_idx on app.personal_tasks (parent_id, sort_key);
create trigger personal_tasks_touch before insert or update on app.personal_tasks
  for each row execute function app_private.touch_row();

create function app_private.personal_tasks_before()
returns trigger language plpgsql
set search_path = ''
as $$
declare v_parent app.personal_tasks;
begin
  if tg_op = 'UPDATE' and (new.user_id <> old.user_id or new.parent_id is distinct from old.parent_id) then
    perform app_private.raise_tf('validation', 'user_id and parent_id are immutable here');
  end if;
  if tg_op = 'INSERT' then
    if new.parent_id is null then
      new.depth := 0; new.root_id := new.id;
    else
      select * into v_parent from app.personal_tasks where id = new.parent_id and user_id = new.user_id;
      if v_parent.id is null then perform app_private.raise_tf('not_found', 'parent'); end if;
      if v_parent.depth >= 2 then perform app_private.raise_tf('validation', 'maximum depth is 3 levels'); end if;
      new.depth := v_parent.depth + 1; new.root_id := v_parent.root_id;
    end if;
  end if;
  return new;
end $$;
create trigger personal_tasks_before before insert or update on app.personal_tasks
  for each row execute function app_private.personal_tasks_before();

create table app.personal_task_dependencies (
  task_id uuid not null,
  blocked_by_task_id uuid not null,
  user_id uuid not null references app.profiles (id) on delete cascade,
  primary key (task_id, blocked_by_task_id),
  check (task_id <> blocked_by_task_id),
  foreign key (task_id, user_id) references app.personal_tasks (id, user_id),
  foreign key (blocked_by_task_id, user_id) references app.personal_tasks (id, user_id)
);

create table app.personal_recurrence_rules (
  id uuid primary key,
  user_id uuid not null references app.profiles (id) on delete cascade,
  template jsonb not null,
  weekdays smallint[] not null check (weekdays <@ array[0, 1, 2, 3, 4, 5, 6]::smallint[] and cardinality(weekdays) > 0),
  starts_on date not null,
  ends_on date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz
);
create trigger personal_recurrence_touch before insert or update on app.personal_recurrence_rules
  for each row execute function app_private.touch_row();

create table app.personal_attachments (
  id uuid primary key,
  personal_task_id uuid not null,
  user_id uuid not null references app.profiles (id) on delete cascade,
  storage_path text not null check (storage_path like 'user/' || user_id::text || '/%'),
  name text not null check (char_length(name) <= 255),
  mime text not null,
  size_bytes bigint not null check (size_bytes between 0 and 15728640),   -- 15 MB [DEFAULT]
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  foreign key (personal_task_id, user_id) references app.personal_tasks (id, user_id)
);
create trigger personal_attachments_touch before insert or update on app.personal_attachments
  for each row execute function app_private.touch_row();

create table app.personal_notes (
  id uuid primary key,
  user_id uuid not null references app.profiles (id) on delete cascade,
  body text not null check (char_length(body) <= 20000),
  pinned boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz
);
create index personal_notes_change_idx on app.personal_notes (change_xid, id);
create trigger personal_notes_touch before insert or update on app.personal_notes
  for each row execute function app_private.touch_row();

-- Owner-only, append-only history with its own per-user hash chain (never the org chain).
create sequence app_private.personal_events_id_seq;
create table app.personal_events (
  id bigint primary key,
  user_id uuid not null references app.profiles (id) on delete cascade,
  occurred_at timestamptz not null,
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),
  subject_id uuid,
  payload jsonb not null default '{}'::jsonb,
  request_op_id uuid,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (user_id, prev_hash)
);
create trigger personal_events_no_update before update or delete on app.personal_events
  for each row execute function app_private.events_immutable();

create function app_private.emit_personal_event(p_user uuid, p_kind text, p_subject uuid, p_payload jsonb, p_op uuid)
returns bigint language plpgsql
set search_path = ''
as $$
declare v_prev text; v_id bigint; v_at timestamptz := pg_catalog.clock_timestamp();
        v_payload jsonb := jsonb_build_object('v', 1) || coalesce(p_payload, '{}'::jsonb);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-events:' || p_user::text, 0));
  select hash into v_prev from app.personal_events where user_id = p_user order by id desc limit 1;
  v_prev := coalesce(v_prev, pg_catalog.repeat('0', 64));
  v_id := pg_catalog.nextval('app_private.personal_events_id_seq');
  insert into app.personal_events (id, user_id, occurred_at, kind, subject_id, payload, request_op_id, prev_hash, hash)
  values (v_id, p_user, v_at, p_kind, p_subject, v_payload, p_op, v_prev,
          app_private.event_hash(v_prev, p_user, v_id, p_kind, v_payload, v_at));
  return v_id;
end $$;

-- sync_floor: highest purged tombstone xid per stream (purge job itself is Phase 5).
create table app.sync_floor (
  stream text primary key,
  floor_xid xid8 not null default '0'::xid8
);

do $$
declare t text;
begin
  foreach t in array array['personal_tasks','personal_task_dependencies','personal_recurrence_rules',
                           'personal_attachments','personal_notes','personal_events','sync_floor'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    if t = 'personal_events' then
      execute format('grant select, insert on app.%I to app_rpc', t);
      execute format('create policy %I on app.%I for select to app_rpc using (true)', t || '_rpc_r', t);
      execute format('create policy %I on app.%I for insert to app_rpc with check (true)', t || '_rpc_w', t);
    else
      execute format('grant select, insert, update, delete on app.%I to app_rpc', t);
      execute format('create policy %I on app.%I to app_rpc using (true) with check (true)', t || '_rpc', t);
    end if;
    if t not in ('sync_floor') then
      execute format('create policy %I on app.%I for select to authenticated using (user_id = auth.uid())', t || '_owner', t);
      execute format('grant select on app.%I to authenticated', t);
    end if;
  end loop;
end $$;
grant usage on sequence app_private.personal_events_id_seq to app_rpc;

-- ---- personal RPCs (owner only; subtasks to depth 2) --------------------------------------
create function app_api.create_personal_task(p_op_id uuid, p_id uuid, p_parent_id uuid, p_title text,
                                             p_planned_date date default null)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_personal_task',
    jsonb_build_object('i', p_id, 'p', p_parent_id, 't', p_title, 'd', p_planned_date));
  if v_prev is not null then return v_prev; end if;
  insert into app.personal_tasks (id, user_id, parent_id, title, planned_date)
  values (p_id, v_uid, p_parent_id, p_title, p_planned_date);
  perform app_private.emit_personal_event(v_uid, 'ptask.created', p_id, jsonb_build_object('title', p_title), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.complete_personal_task(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'complete_personal_task', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null then perform app_private.raise_tf('not_found', 'task'); end if;
  -- gate: required, not-done, not-deleted children block completion (parent locked first)
  if exists (select 1 from app.personal_tasks c where c.parent_id = p_id and c.is_required
             and c.status not in ('done', 'canceled') and c.deleted_at is null) then
    perform app_private.raise_tf('gate_failed', 'required subtasks are not done');
  end if;
  update app.personal_tasks set status = 'done', completed_at = now() where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.completed', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.create_personal_note(p_op_id uuid, p_id uuid, p_body text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_personal_note', jsonb_build_object('i', p_id, 'b', p_body));
  if v_prev is not null then return v_prev; end if;
  insert into app.personal_notes (id, user_id, body) values (p_id, v_uid, p_body);
  perform app_private.emit_personal_event(v_uid, 'pnote.created', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- commit-safe sync pull (proposed design, OFFLINE_SYNC section 2) ----------------------
-- horizon = lowest transaction id still in progress at the time of the call. Rows are returned
-- only when change_xid < horizon, so a transaction that commits late can never be skipped
-- behind an already-delivered higher xid. Keyset (change_xid, id). SECURITY INVOKER: RLS applies.
-- Pagination is per-page, not an MVCC snapshot (see OFFLINE_SYNC 2.1): pass the first page's
-- horizon back on later pages.
create function app_api.sync_pull(p_stream text, p_after_xid xid8 default '0'::xid8,
                                  p_after_id text default '', p_horizon xid8 default null, p_limit int default 200)
returns jsonb language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_horizon xid8 := coalesce(p_horizon, pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot()));
  v_rows jsonb; v_next_xid text; v_next_id text; v_sql text;
begin
  if p_stream not in ('personal_tasks', 'personal_notes', 'org_units') then
    raise exception 'unknown stream' using errcode = 'TF004', detail = '{"code":"validation","message":"unknown stream"}';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'limit must be 1 to 1000' using errcode = 'TF004', detail = '{"code":"validation","message":"limit"}';
  end if;
  v_sql := pg_catalog.format($q$
    with page as (
      select t.*, t.id::text as id_text from app.%1$I t
      where (t.change_xid, t.id::text) > ($1, $2) and t.change_xid < $3
      order by t.change_xid, t.id::text limit $4)
    select coalesce(jsonb_agg(to_jsonb(p) - 'id_text' order by p.change_xid, p.id_text), '[]'::jsonb),
           (select change_xid::text from page order by change_xid desc, id_text desc limit 1),
           (select id_text from page order by change_xid desc, id_text desc limit 1)
    from page p$q$, p_stream);
  execute v_sql into v_rows, v_next_xid, v_next_id using p_after_xid, p_after_id, v_horizon, p_limit;
  return jsonb_build_object('rows', v_rows, 'horizon', v_horizon::text,
                            'next_xid', v_next_xid, 'next_id', v_next_id);
end $$;

select app_private.finalize_ownership();
-- finalize_ownership would hand sync_pull to app_rpc; it must stay SECURITY INVOKER so RLS applies.
grant execute on function app_api.create_personal_task(uuid, uuid, uuid, text, date),
  app_api.complete_personal_task(uuid, uuid), app_api.create_personal_note(uuid, uuid, text),
  app_api.sync_pull(text, xid8, text, xid8, int) to authenticated;
