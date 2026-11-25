

-- === FILE: 0001_extensions_schemas_enums.sql ===

-- 0001: schemas, extensions, roles, enums, shared helpers.
create schema if not exists extensions;
create schema if not exists app;          -- tables (not exposed through the API)
create schema if not exists app_private;  -- helpers, never exposed
create schema if not exists app_api;      -- the only exposed surface (RPCs)


do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rpc') then
    create role app_rpc nologin;
  end if;
  -- hosted Supabase: postgres is not superuser; it needs SET on app_rpc to own functions as app_rpc (found by hosted run)
  execute format('grant app_rpc to %I with set true', current_user);
end $$;

revoke all on schema app, app_private, app_api from public;
grant usage, create on schema app_private, app_api to app_rpc;
grant usage on schema app to app_rpc;
grant usage on schema app_private, app_api to authenticated;
grant usage on schema app to authenticated;

create type app.app_role as enum ('member', 'team_leader', 'supervisor', 'admin');
create type app.member_status as enum ('active', 'suspended', 'removed');
create type app.permission_kind as enum (
  'manage_units', 'create_invitations', 'change_roles', 'remove_members',
  'assign_tasks', 'reopen_tasks');

-- Typed errors: SQLSTATE TFnnn with a JSON detail (API_AND_RPC_CONTRACTS section 1).
create function app_private.raise_tf(p_code text, p_message text default '')
returns void language plpgsql immutable
set search_path = ''
as $$
declare
  v_state text;
begin
  v_state := case p_code
    when 'unauthenticated' then 'TF001' when 'forbidden' then 'TF002'
    when 'not_found' then 'TF003' when 'validation' then 'TF004'
    when 'stale_conflict' then 'TF005' when 'gate_failed' then 'TF006'
    when 'dependency_blocked' then 'TF007' when 'cycle_detected' then 'TF008'
    when 'rate_limited' then 'TF009' when 'quota' then 'TF010'
    when 'expired' then 'TF011' when 'already_used' then 'TF012'
    when 'op_id_reuse' then 'TF013' when 'op_expired' then 'TF014'
    else 'TF004' end;
  raise exception '%', p_code using errcode = v_state,
    detail = pg_catalog.json_build_object('code', p_code, 'message', p_message)::text;
end $$;

-- Sync-column trigger shared by every syncable table (DATABASE_DESIGN header).
-- row_version is optimistic concurrency only; change_xid feeds the sync cursor (Phase 5).
create function app_private.touch_row()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.row_version := 1;
  else
    new.created_at := old.created_at;
    new.row_version := old.row_version + 1;
  end if;
  new.updated_at := now();
  new.change_xid := pg_catalog.pg_current_xact_id();
  return new;
end $$;

-- Current caller. Identity comes only from the JWT, never from arguments.
create function app_private.uid()
returns uuid language sql stable
set search_path = ''
as $$ select auth.uid() $$;

create function app_private.require_uid()
returns uuid language plpgsql stable
set search_path = ''
as $$
declare v uuid := auth.uid();
begin
  if v is null then perform app_private.raise_tf('unauthenticated'); end if;
  return v;
end $$;

create function app_private.role_rank(p_role app.app_role)
returns int language sql immutable
set search_path = ''
as $$ select case p_role when 'member' then 1 when 'team_leader' then 2
                         when 'supervisor' then 3 when 'admin' then 4 end $$;

-- Ownership convention: every function in app_private / app_api is owned by the
-- NOLOGIN role app_rpc. Called at the end of each migration; lint test enforces it.
create function app_private.finalize_ownership()
returns void language plpgsql
set search_path = ''
as $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'app_api')
      and p.proname <> 'finalize_ownership'
  loop
    execute format('alter function %s owner to app_rpc', r.sig);
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to app_rpc', r.sig);
  end loop;
end $$;
revoke all on function app_private.finalize_ownership() from public;

-- === FILE: 0002_profiles_auth.sql ===

-- 0002: profiles bound to auth.users; profile row created by an auth trigger.
create table app.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  avatar_path text check (avatar_path is null or char_length(avatar_path) <= 300),
  locale text not null default 'en' check (locale in ('ar', 'en')),
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  timezone text check (timezone is null or char_length(timezone) <= 64),
  reminder_time time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz
);
create trigger profiles_touch before insert or update on app.profiles
  for each row execute function app_private.touch_row();
create index profiles_change_idx on app.profiles (change_xid, id);

create function app_private.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 100))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app_private.handle_new_user();

alter table app.profiles enable row level security;
alter table app.profiles force row level security;
grant select, insert, update, delete on app.profiles to app_rpc;
create policy profiles_rpc on app.profiles to app_rpc using (true) with check (true);

select app_private.finalize_ownership();

-- === FILE: 0003_organizations_units_closure.sql ===

-- 0003: organizations, unit tree, closure table, cycle guard with lock.
create table app.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  timezone text not null default 'Africa/Cairo',            -- [DEFAULT]
  capacity_hours_default numeric(4, 1) not null default 25 check (capacity_hours_default between 0 and 100), -- [DEFAULT]
  created_by uuid not null references app.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz
);
create trigger organizations_touch before insert or update on app.organizations
  for each row execute function app_private.touch_row();

create table app.org_units (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  parent_id uuid,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  depth int not null default 0 check (depth >= 0),
  leader_membership_id uuid,   -- FK added in 0004
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  unique (id, org_id),
  foreign key (parent_id, org_id) references app.org_units (id, org_id),
  check (parent_id is distinct from id)
);
create unique index org_units_one_root on app.org_units (org_id) where parent_id is null;
create index org_units_parent_idx on app.org_units (parent_id);
create index org_units_change_idx on app.org_units (change_xid, id);
create trigger org_units_touch before insert or update on app.org_units
  for each row execute function app_private.touch_row();

create table app.unit_closure (
  ancestor_id uuid not null references app.org_units (id),
  descendant_id uuid not null references app.org_units (id),
  depth int not null check (depth >= 0),
  primary key (ancestor_id, descendant_id)
);
create index unit_closure_desc_idx on app.unit_closure (descendant_id);

-- Org structure lock (DATABASE_DESIGN section 5). Reentrant within a transaction.
create function app_private.lock_org_structure(p_org uuid)
returns void language sql
set search_path = ''
as $$ select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-structure:' || p_org::text, 0)) $$;

create function app_private.org_units_before()
returns trigger language plpgsql
set search_path = ''
as $$
declare v_parent_depth int;
begin
  perform app_private.lock_org_structure(new.org_id);
  if tg_op = 'INSERT' then
    if new.parent_id is null then
      new.depth := 0;
    else
      select depth into v_parent_depth from app.org_units where id = new.parent_id;
      new.depth := v_parent_depth + 1;
    end if;
  else
    if new.org_id <> old.org_id then
      perform app_private.raise_tf('validation', 'org_id is immutable');
    end if;
    if (old.parent_id is null) <> (new.parent_id is null) then
      perform app_private.raise_tf('validation', 'the root unit cannot be moved or created by move');
    end if;
    if new.parent_id is distinct from old.parent_id then
      -- cycle guard: new parent must not be the unit itself or one of its descendants.
      if exists (select 1 from app.unit_closure
                 where ancestor_id = new.id and descendant_id = new.parent_id) then
        perform app_private.raise_tf('cycle_detected', 'unit cannot move under itself or a descendant');
      end if;
      select depth into v_parent_depth from app.org_units where id = new.parent_id;
      new.depth := v_parent_depth + 1;
    end if;
  end if;
  return new;
end $$;
create trigger org_units_before before insert or update on app.org_units
  for each row execute function app_private.org_units_before();

-- Epoch bump helpers are defined in 0007; the closure trigger calls them via a hook
-- function so that 0003 stays self-contained.
create function app_private.org_units_after()
returns trigger language plpgsql
set search_path = ''
as $$
declare v_delta int;
begin
  if tg_op = 'INSERT' then
    insert into app.unit_closure (ancestor_id, descendant_id, depth)
    values (new.id, new.id, 0);
    if new.parent_id is not null then
      insert into app.unit_closure (ancestor_id, descendant_id, depth)
      select c.ancestor_id, new.id, c.depth + 1
      from app.unit_closure c where c.descendant_id = new.parent_id;
    end if;
  elsif new.parent_id is distinct from old.parent_id then
    v_delta := new.depth - old.depth;
    -- remove links from old ancestors (outside the subtree) to the subtree
    delete from app.unit_closure
    where descendant_id in (select descendant_id from app.unit_closure where ancestor_id = new.id)
      and ancestor_id in (select ancestor_id from app.unit_closure
                          where descendant_id = new.id and ancestor_id <> new.id);
    -- add links from new ancestors to every unit in the subtree
    insert into app.unit_closure (ancestor_id, descendant_id, depth)
    select a.ancestor_id, d.descendant_id, a.depth + 1 + d.depth
    from app.unit_closure a
    cross join app.unit_closure d
    where a.descendant_id = new.parent_id and d.ancestor_id = new.id;
    update app.org_units u set depth = u.depth + v_delta
    where u.id in (select descendant_id from app.unit_closure where ancestor_id = new.id)
      and u.id <> new.id;
  end if;
  return null;
end $$;
create trigger org_units_after after insert or update on app.org_units
  for each row execute function app_private.org_units_after();

alter table app.organizations enable row level security;
alter table app.organizations force row level security;
alter table app.org_units enable row level security;
alter table app.org_units force row level security;
alter table app.unit_closure enable row level security;
alter table app.unit_closure force row level security;
grant select, insert, update, delete on app.organizations, app.org_units, app.unit_closure to app_rpc;
create policy organizations_rpc on app.organizations to app_rpc using (true) with check (true);
create policy org_units_rpc on app.org_units to app_rpc using (true) with check (true);
create policy unit_closure_rpc on app.unit_closure to app_rpc using (true) with check (true);

select app_private.finalize_ownership();

-- === FILE: 0004_memberships_grants_invitations.sql ===

-- 0004: memberships, delegated grants, invitations, last-admin protection.
create table app.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  user_id uuid not null references app.profiles (id),
  role app.app_role not null,
  unit_id uuid not null,
  status app.member_status not null default 'active',
  capacity_hours numeric(4, 1) check (capacity_hours is null or capacity_hours between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  unique (id, org_id),
  unique (org_id, user_id),
  unique (user_id),   -- [DEFAULT] single organization per user
  foreign key (unit_id, org_id) references app.org_units (id, org_id)
);
create index memberships_unit_idx on app.memberships (unit_id);
create index memberships_change_idx on app.memberships (change_xid, id);
create trigger memberships_touch before insert or update on app.memberships
  for each row execute function app_private.touch_row();

alter table app.org_units
  add constraint org_units_leader_fk foreign key (leader_membership_id, org_id)
  references app.memberships (id, org_id);

create table app.permission_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null,
  permission app.permission_kind not null,
  scope_unit_id uuid not null,
  expires_at timestamptz not null,
  granted_by uuid not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  foreign key (membership_id, org_id) references app.memberships (id, org_id),
  foreign key (granted_by, org_id) references app.memberships (id, org_id),
  foreign key (scope_unit_id, org_id) references app.org_units (id, org_id)
);
create index permission_grants_member_idx on app.permission_grants (membership_id);
create trigger permission_grants_touch before insert or update on app.permission_grants
  for each row execute function app_private.touch_row();

create table app.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  role app.app_role not null check (role <> 'admin'),
  unit_id uuid not null,
  max_uses int not null default 1 check (max_uses between 1 and 1000),
  uses int not null default 0,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  check (uses between 0 and max_uses),
  foreign key (unit_id, org_id) references app.org_units (id, org_id),
  foreign key (created_by, org_id) references app.memberships (id, org_id)
);
create trigger invitations_touch before insert or update on app.invitations
  for each row execute function app_private.touch_row();

-- Failed-redemption counter for the 5 tries per hour limit (SECURITY_ARCHITECTURE s7).
create table app.invitation_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index invitation_attempts_user_idx on app.invitation_attempts (user_id, attempted_at);

-- Role / unit / status can never be set to inconsistent shapes by a back door:
-- the admin membership of the org stays placed in a valid unit, and the last active
-- admin cannot be removed or demoted. The BEFORE trigger serializes admin changes per
-- org so two concurrent demotions cannot both pass the deferred check.
create function app_private.memberships_admin_lock()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.status = 'active' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || old.org_id::text, 0));
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.user_id <> old.user_id then
      perform app_private.raise_tf('validation', 'org_id and user_id are immutable');
    end if;
    if old.role = 'admin' and old.status = 'active' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || old.org_id::text, 0));
    end if;
  end if;
  return new;
end $$;
create trigger memberships_admin_lock before insert or update or delete on app.memberships
  for each row execute function app_private.memberships_admin_lock();

create function app_private.memberships_last_admin_check()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_org uuid := coalesce(old.org_id, new.org_id);
begin
  if (tg_op = 'DELETE' or old.role is distinct from new.role or old.status is distinct from new.status)
     and old.role = 'admin' and old.status = 'active' then
    if not exists (select 1 from app.memberships
                   where org_id = v_org and role = 'admin' and status = 'active') then
      perform app_private.raise_tf('validation', 'an organization must keep at least one active admin');
    end if;
  end if;
  return null;
end $$;
create constraint trigger memberships_last_admin after update or delete on app.memberships
  deferrable initially deferred for each row
  execute function app_private.memberships_last_admin_check();

do $$
declare t text;
begin
  foreach t in array array['memberships','permission_grants','invitations','invitation_attempts'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('grant select, insert, update, delete on app.%I to app_rpc', t);
    execute format('create policy %I on app.%I to app_rpc using (true) with check (true)', t || '_rpc', t);
  end loop;
end $$;
grant usage on all sequences in schema app to app_rpc;

select app_private.finalize_ownership();

-- === FILE: 0005_authz_helpers.sql ===

-- 0005: authorization helpers (AUTHORIZATION_MATRIX rules 1 to 3).
-- Authority flows down only. A non-admin acts on a unit when the unit is at or below
-- the actor's placement unit, and on a member only when the actor's role outranks the
-- target's. Peers and ancestors are never in scope. Admin: whole org.

create function app_private.active_membership(p_user uuid)
returns app.memberships language sql stable security definer
set search_path = ''
as $$
  select m.* from app.memberships m where m.user_id = p_user and m.status = 'active'
$$;

create function app_private.my_membership_id()
returns uuid language sql stable security definer
set search_path = ''
as $$
  select m.id from app.memberships m where m.user_id = auth.uid() and m.status = 'active'
$$;

create function app_private.is_active_member(p_org uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.user_id = auth.uid() and m.org_id = p_org and m.status = 'active')
$$;

create function app_private.unit_in_scope(p_actor uuid, p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.memberships a
    join app.org_units u on u.id = p_unit and u.org_id = a.org_id
    where a.id = p_actor and a.status = 'active'
      and (a.role = 'admin'
           or exists (select 1 from app.unit_closure c
                      where c.ancestor_id = a.unit_id and c.descendant_id = p_unit)))
$$;

create function app_private.has_authority_over_membership(p_actor uuid, p_target uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.memberships a
    join app.memberships t on t.org_id = a.org_id and t.id = p_target
    where a.id = p_actor and a.status = 'active' and a.id <> t.id
      and (a.role = 'admin'
           or (app_private.role_rank(a.role) > app_private.role_rank(t.role)
               and app_private.unit_in_scope(a.id, t.unit_id))))
$$;

-- Delegated grant: active, unexpired, not revoked, scoped to a unit at or above the target unit.
-- The actor must also have the unit in their own scope: grants never exceed own authority.
create function app_private.has_grant(p_actor uuid, p_permission app.permission_kind, p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.permission_grants g
    join app.memberships m on m.id = g.membership_id and m.status = 'active'
    join app.unit_closure c on c.ancestor_id = g.scope_unit_id and c.descendant_id = p_unit
    where g.membership_id = p_actor and g.permission = p_permission
      and g.revoked_at is null and g.expires_at > now() and g.deleted_at is null
      and app_private.unit_in_scope(p_actor, p_unit))
$$;

create function app_private.is_admin(p_actor uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.id = p_actor and m.role = 'admin' and m.status = 'active')
$$;

-- Wrappers for the current user, used by RLS policies.
create function app_private.me_has_authority_over_membership(p_target uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$ select app_private.has_authority_over_membership(app_private.my_membership_id(), p_target) $$;

create function app_private.me_unit_in_scope(p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$ select app_private.unit_in_scope(app_private.my_membership_id(), p_unit) $$;


select app_private.finalize_ownership();
-- Only the current-user wrappers are callable by clients (RLS policies need them).
grant execute on function
  app_private.my_membership_id(), app_private.is_active_member(uuid),
  app_private.me_has_authority_over_membership(uuid), app_private.me_unit_in_scope(uuid)
to authenticated;

-- === FILE: 0006_events_audit_chain.sql ===

-- 0006: append-only org events with a per-org hash chain (EVENT_AND_AUDIT_MODEL).
-- Guarantee: tamper EVIDENCE against roles that cannot rewrite the whole chain.
-- A privileged database operator can recompute the chain. Not tamper-proof.
create sequence app_private.events_id_seq;

create table app.events (
  id bigint primary key,
  org_id uuid not null references app.organizations (id),
  occurred_at timestamptz not null default now(),
  actor_membership_id uuid,
  actor_kind text not null check (actor_kind in ('user', 'system')),
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),
  subject_type text not null,
  subject_id uuid,
  task_id uuid,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  request_op_id uuid,
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (org_id, prev_hash),    -- a fork in the chain is rejected by the database
  foreign key (actor_membership_id, org_id) references app.memberships (id, org_id)
);
create index events_org_idx on app.events (org_id, id);
create index events_subject_idx on app.events (subject_type, subject_id);

create function app_private.event_hash(
  p_prev text, p_org uuid, p_id bigint, p_kind text, p_payload jsonb, p_at timestamptz)
returns text language sql immutable
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      p_prev || '|' || p_org::text || '|' || p_id::text || '|' || p_kind || '|' || p_payload::text || '|' ||
      pg_catalog.to_char(p_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), 'UTF8')),
    'hex')
$$;

-- Only write path. Serializes per org with an advisory lock so prev_hash reads are ordered.
create function app_private.emit_event(
  p_org uuid, p_actor uuid, p_kind text, p_subject_type text, p_subject_id uuid,
  p_payload jsonb default '{}'::jsonb, p_op_id uuid default null)
returns bigint language plpgsql
set search_path = ''
as $$
declare
  v_prev text;
  v_id bigint;
  v_at timestamptz := pg_catalog.clock_timestamp();
  v_payload jsonb := jsonb_build_object('v', 1) || coalesce(p_payload, '{}'::jsonb);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-events:' || p_org::text, 0));
  select e.hash into v_prev from app.events e where e.org_id = p_org order by e.id desc limit 1;
  v_prev := coalesce(v_prev, pg_catalog.repeat('0', 64));
  v_id := pg_catalog.nextval('app_private.events_id_seq');
  insert into app.events (id, org_id, occurred_at, actor_membership_id, actor_kind, kind,
                          subject_type, subject_id, payload, request_op_id, prev_hash, hash)
  values (v_id, p_org, v_at, p_actor, case when p_actor is null then 'system' else 'user' end,
          p_kind, p_subject_type, p_subject_id, v_payload, p_op_id, v_prev,
          app_private.event_hash(v_prev, p_org, v_id, p_kind, v_payload, v_at));
  return v_id;
end $$;

create function app_private.events_immutable()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  raise exception 'events are append-only' using errcode = '42501';
end $$;
create trigger events_no_update before update or delete on app.events
  for each row execute function app_private.events_immutable();
create trigger events_no_truncate before truncate on app.events
  for each statement execute function app_private.events_immutable();

-- Recomputes the chain for one org. Returns the first broken event id, or null if intact.
create function app_private.verify_chain(p_org uuid)
returns bigint language plpgsql stable
set search_path = ''
as $$
declare r record; v_prev text := pg_catalog.repeat('0', 64);
begin
  for r in select * from app.events where org_id = p_org order by id loop
    if r.prev_hash <> v_prev
       or r.hash <> app_private.event_hash(r.prev_hash, r.org_id, r.id, r.kind, r.payload, r.occurred_at) then
      return r.id;
    end if;
    v_prev := r.hash;
  end loop;
  return null;
end $$;

alter table app.events enable row level security;
alter table app.events force row level security;
-- app_rpc may only read and insert: updates and deletes are revoked (and trigger-blocked).
grant select, insert on app.events to app_rpc;
create policy events_rpc_read on app.events for select to app_rpc using (true);
create policy events_rpc_insert on app.events for insert to app_rpc with check (true);
grant usage on sequence app_private.events_id_seq to app_rpc;

select app_private.finalize_ownership();

-- === FILE: 0007_receipts_epochs.sql ===

-- 0007: idempotency receipts and access epochs (OFFLINE_SYNC_ARCHITECTURE sections 3 and 8).

-- ---- idempotency receipts ----------------------------------------------------------
create table app.op_receipts (
  user_id uuid not null references app.profiles (id) on delete cascade,
  op_id uuid not null,
  rpc text not null,
  args_hash text not null,
  result jsonb,                       -- null only while the owning transaction is open
  created_at timestamptz not null default now(),
  primary key (user_id, op_id)
);

-- op ids are v7-style: the first 48 bits are a millisecond timestamp. An op id older than
-- the receipt retention (90 days [DEFAULT]) is classified op_expired BEFORE any receipt
-- lookup, so a purged receipt can never lead to an old mutation being replayed.
create function app_private.op_id_time(p_op uuid)
returns timestamptz language plpgsql immutable
set search_path = ''
as $$
declare h text := replace(p_op::text, '-', '');
begin
  if substr(h, 13, 1) <> '7' then
    perform app_private.raise_tf('validation', 'op_id must be a v7 uuid');
  end if;
  return pg_catalog.to_timestamp(('x' || '0000' || substr(h, 1, 12))::bit(64)::bigint / 1000.0);
end $$;

create function app_private.begin_op(p_op uuid, p_rpc text, p_args jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := app_private.require_uid();
  v_time timestamptz;
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_args::text, 'UTF8')), 'hex');
  v_rec app.op_receipts;
begin
  if p_op is null then perform app_private.raise_tf('validation', 'op_id required'); end if;
  v_time := app_private.op_id_time(p_op);
  if v_time < now() - interval '90 days' then
    perform app_private.raise_tf('op_expired', 'operation id is older than the receipt retention');
  end if;
  if v_time > now() + interval '1 day' then
    perform app_private.raise_tf('validation', 'op_id timestamp is in the future');
  end if;
  -- A concurrent retry blocks here on the unique key until the first transaction ends.
  insert into app.op_receipts (user_id, op_id, rpc, args_hash)
  values (v_user, p_op, p_rpc, v_hash)
  on conflict (user_id, op_id) do nothing;
  select * into v_rec from app.op_receipts where user_id = v_user and op_id = p_op;
  if v_rec.rpc <> p_rpc or v_rec.args_hash <> v_hash then
    perform app_private.raise_tf('op_id_reuse', 'op_id was used with a different call');
  end if;
  return v_rec.result;   -- null for a fresh op: caller proceeds; non-null: replay stored result
end $$;

create function app_private.finish_op(p_op uuid, p_result jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
begin
  update app.op_receipts set result = p_result
  where user_id = app_private.require_uid() and op_id = p_op;
  return p_result;
end $$;

-- ---- access epochs ----------------------------------------------------------------
-- Epoch values come from one sequence so they only ever increase. The epoch a client sees
-- is the max of its user epoch and the scope epochs of units in its authority subtree.
create sequence app_private.epoch_seq;

create table app.user_access_state (
  user_id uuid primary key references app.profiles (id) on delete cascade,
  epoch bigint not null
);
create table app.scope_epochs (
  unit_id uuid primary key references app.org_units (id),
  epoch bigint not null
);

create function app_private.bump_user_epoch(p_user uuid)
returns void language sql
set search_path = ''
as $$
  insert into app.user_access_state (user_id, epoch)
  values (p_user, pg_catalog.nextval('app_private.epoch_seq'))
  on conflict (user_id) do update set epoch = excluded.epoch
$$;

-- bump the unit, its descendants and its ancestors
create function app_private.bump_unit_chain(p_unit uuid)
returns void language sql
set search_path = ''
as $$
  with e as (select pg_catalog.nextval('app_private.epoch_seq') as v)
  insert into app.scope_epochs (unit_id, epoch)
  select x.id, e.v from e,
    (select ancestor_id as id from app.unit_closure where descendant_id = p_unit
     union
     select descendant_id from app.unit_closure where ancestor_id = p_unit) x
  on conflict (unit_id) do update set epoch = excluded.epoch
$$;

create function app_private.epoch_on_membership()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform app_private.bump_user_epoch(old.user_id);
    perform app_private.bump_unit_chain(old.unit_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform app_private.bump_user_epoch(new.user_id);
    perform app_private.bump_unit_chain(new.unit_id);
  end if;
  return null;
end $$;
create trigger memberships_epoch after insert or update or delete on app.memberships
  for each row execute function app_private.epoch_on_membership();

create function app_private.epoch_on_grant()
returns trigger language plpgsql
set search_path = ''
as $$
declare v_user uuid;
begin
  select user_id into v_user from app.memberships where id = new.membership_id;
  perform app_private.bump_user_epoch(v_user);
  perform app_private.bump_unit_chain(new.scope_unit_id);
  return null;
end $$;
create trigger grants_epoch after insert or update on app.permission_grants
  for each row execute function app_private.epoch_on_grant();

-- Unit moves: the old chain must be read BEFORE closure is rewritten. The closure trigger
-- runs AFTER, so capture old ancestors in a BEFORE trigger of the same statement.
create function app_private.epoch_units_before()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is distinct from old.parent_id then
    perform app_private.bump_unit_chain(old.id);   -- old ancestors and the subtree
  end if;
  return new;
end $$;
create trigger org_units_epoch_before before update on app.org_units
  for each row execute function app_private.epoch_units_before();

create function app_private.epoch_units_after()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id then
    perform app_private.bump_unit_chain(new.id);   -- new ancestors and the subtree
  end if;
  return null;
end $$;
-- fires after org_units_after (alphabetical trigger order: org_units_after < org_units_epoch_after)
create trigger org_units_epoch_after after insert or update on app.org_units
  for each row execute function app_private.epoch_units_after();

create function app_api.current_epoch()
returns bigint language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := app_private.require_uid();
  v_m app.memberships;
  v_epoch bigint;
begin
  select coalesce(max(epoch), 0) into v_epoch from app.user_access_state where user_id = v_user;
  select * into v_m from app.memberships where user_id = v_user and status = 'active';
  if v_m.id is not null then
    select greatest(v_epoch, coalesce(max(s.epoch), 0)) into v_epoch
    from app.scope_epochs s
    where (v_m.role = 'admin' and s.unit_id in (select id from app.org_units where org_id = v_m.org_id))
       or s.unit_id in (select descendant_id from app.unit_closure where ancestor_id = v_m.unit_id);
  end if;
  return v_epoch;
end $$;

do $$
declare t text;
begin
  foreach t in array array['op_receipts','user_access_state','scope_epochs'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('grant select, insert, update, delete on app.%I to app_rpc', t);
    execute format('create policy %I on app.%I to app_rpc using (true) with check (true)', t || '_rpc', t);
  end loop;
end $$;
grant usage on sequence app_private.epoch_seq to app_rpc;

select app_private.finalize_ownership();
grant execute on function app_api.current_epoch() to authenticated;

-- === FILE: 0008_rls_and_rpc.sql ===

-- 0008: client read policies (RLS) and the Phase 2 RPC layer (app_api).
-- Clients have SELECT only, through RLS. Every write goes through an RPC below.

-- ---- extra read helpers ---------------------------------------------------------------
create function app_private.me_is_admin_of(p_org uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.user_id = auth.uid() and m.org_id = p_org
                   and m.role = 'admin' and m.status = 'active')
$$;

create function app_private.me_can_see_profile(p_user uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select p_user = auth.uid()
      or exists (select 1 from app.memberships m
                 where m.user_id = p_user
                   and app_private.has_authority_over_membership(app_private.my_membership_id(), m.id))
$$;

create function app_private.me_in_org_of_unit(p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.org_units u
                 where u.id = p_unit and app_private.is_active_member(u.org_id))
$$;

grant execute on function app_private.me_is_admin_of(uuid), app_private.me_can_see_profile(uuid),
  app_private.me_in_org_of_unit(uuid) to authenticated;

-- ---- policies -------------------------------------------------------------------------
create policy profiles_select on app.profiles for select to authenticated
  using (app_private.me_can_see_profile(id));
create policy organizations_select on app.organizations for select to authenticated
  using (app_private.is_active_member(id));
create policy org_units_select on app.org_units for select to authenticated
  using (app_private.is_active_member(org_id));
create policy unit_closure_select on app.unit_closure for select to authenticated
  using (app_private.me_in_org_of_unit(ancestor_id));
create policy memberships_select on app.memberships for select to authenticated
  using (user_id = auth.uid()
         or (app_private.is_active_member(org_id)
             and app_private.me_has_authority_over_membership(id)));
create policy grants_select on app.permission_grants for select to authenticated
  using (app_private.me_is_admin_of(org_id)
         or membership_id = app_private.my_membership_id());
create policy invitations_select on app.invitations for select to authenticated
  using (app_private.me_is_admin_of(org_id)
         or created_by = app_private.my_membership_id());
create policy events_select on app.events for select to authenticated
  using (app_private.me_is_admin_of(org_id)
         or (actor_membership_id is not null
             and actor_membership_id = app_private.my_membership_id()));

grant select on app.profiles, app.organizations, app.org_units, app.unit_closure,
  app.memberships, app.permission_grants, app.events to authenticated;
-- code_hash is never readable by clients
grant select (id, org_id, role, unit_id, max_uses, uses, expires_at, revoked_at, created_by,
              created_at, updated_at, row_version, change_xid, deleted_at)
  on app.invitations to authenticated;
-- op_receipts, user_access_state, scope_epochs, invitation_attempts: no client access.

-- ---- RPC helpers ----------------------------------------------------------------------
create function app_private.ok(p_data jsonb)
returns jsonb language sql stable
set search_path = ''
as $$ select jsonb_build_object('ok', true, 'data', p_data, 'server_time', now()) $$;

create function app_private.require_verified_email()
returns void language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from auth.users u
                 where u.id = auth.uid() and u.email_confirmed_at is not null) then
    perform app_private.raise_tf('forbidden', 'verified email required');
  end if;
end $$;

create function app_private.require_actor()
returns app.memberships language plpgsql stable
set search_path = ''
as $$
declare v app.memberships;
begin
  select * into v from app.memberships where user_id = app_private.require_uid() and status = 'active';
  if v.id is null then perform app_private.raise_tf('forbidden', 'active membership required'); end if;
  return v;
end $$;

-- ---- organizations ---------------------------------------------------------------------
create function app_api.create_organization(p_op_id uuid, p_name text, p_timezone text default 'Africa/Cairo')
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb;
  v_org uuid; v_unit uuid; v_mem uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_organization', jsonb_build_object('n', p_name, 'tz', p_timezone));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_verified_email();
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    perform app_private.raise_tf('validation', 'name must be 1 to 120 characters');
  end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    perform app_private.raise_tf('validation', 'unknown timezone');
  end if;
  if exists (select 1 from app.memberships where user_id = v_uid) then
    perform app_private.raise_tf('validation', 'user already belongs to an organization');
  end if;
  insert into app.organizations (name, timezone, created_by) values (btrim(p_name), p_timezone, v_uid) returning id into v_org;
  insert into app.org_units (org_id, parent_id, name) values (v_org, null, btrim(p_name)) returning id into v_unit;
  insert into app.memberships (org_id, user_id, role, unit_id) values (v_org, v_uid, 'admin', v_unit) returning id into v_mem;
  perform app_private.emit_event(v_org, v_mem, 'org.created', 'organization', v_org, jsonb_build_object('name', btrim(p_name)), p_op_id);
  perform app_private.emit_event(v_org, v_mem, 'unit.created', 'unit', v_unit, jsonb_build_object('root', true), p_op_id);
  perform app_private.emit_event(v_org, v_mem, 'member.joined', 'membership', v_mem, jsonb_build_object('role', 'admin'), p_op_id);
  v_res := app_private.ok(jsonb_build_object('org_id', v_org, 'unit_id', v_unit, 'membership_id', v_mem));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- units -----------------------------------------------------------------------------
create function app_api.create_unit(p_op_id uuid, p_parent_id uuid, p_name text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_org uuid; v_unit uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_unit', jsonb_build_object('p', p_parent_id, 'n', p_name));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select org_id into v_org from app.org_units where id = p_parent_id;
  if v_org is null or v_org <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  perform app_private.lock_org_structure(v_org);
  if not (v_actor.role = 'admin' or app_private.has_grant(v_actor.id, 'manage_units', p_parent_id)) then
    perform app_private.raise_tf('forbidden');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    perform app_private.raise_tf('validation', 'name must be 1 to 120 characters');
  end if;
  insert into app.org_units (org_id, parent_id, name) values (v_org, p_parent_id, btrim(p_name)) returning id into v_unit;
  perform app_private.emit_event(v_org, v_actor.id, 'unit.created', 'unit', v_unit,
    jsonb_build_object('parent_id', p_parent_id, 'name', btrim(p_name)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('unit_id', v_unit));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.rename_unit(p_op_id uuid, p_unit_id uuid, p_name text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'rename_unit', jsonb_build_object('u', p_unit_id, 'n', p_name));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  if not (v_actor.role = 'admin' or app_private.has_grant(v_actor.id, 'manage_units', p_unit_id)) then
    perform app_private.raise_tf('forbidden');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    perform app_private.raise_tf('validation', 'name must be 1 to 120 characters');
  end if;
  update app.org_units set name = btrim(p_name) where id = p_unit_id;
  perform app_private.emit_event(v_u.org_id, v_actor.id, 'unit.updated', 'unit', p_unit_id,
    jsonb_build_object('from', v_u.name, 'to', btrim(p_name)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('unit_id', p_unit_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.move_unit(p_op_id uuid, p_unit_id uuid, p_new_parent_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_p app.org_units; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'move_unit', jsonb_build_object('u', p_unit_id, 'p', p_new_parent_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  -- lock first, then re-read everything the decision depends on
  perform app_private.lock_org_structure(v_u.org_id);
  select * into v_u from app.org_units where id = p_unit_id;
  select * into v_p from app.org_units where id = p_new_parent_id;
  if v_p.id is null or v_p.org_id <> v_u.org_id then perform app_private.raise_tf('not_found', 'parent unit'); end if;
  if v_u.parent_id is null then perform app_private.raise_tf('validation', 'the root unit cannot be moved'); end if;
  if not (v_actor.role = 'admin'
          or (app_private.has_grant(v_actor.id, 'manage_units', p_unit_id)
              and app_private.has_grant(v_actor.id, 'manage_units', p_new_parent_id))) then
    perform app_private.raise_tf('forbidden');
  end if;
  update app.org_units set parent_id = p_new_parent_id where id = p_unit_id;   -- cycle guard in trigger
  perform app_private.emit_event(v_u.org_id, v_actor.id, 'unit.moved', 'unit', p_unit_id,
    jsonb_build_object('from_parent', v_u.parent_id, 'to_parent', p_new_parent_id), p_op_id);
  v_res := app_private.ok(jsonb_build_object('unit_id', p_unit_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- invitations -----------------------------------------------------------------------
create function app_api.create_invitation(p_op_id uuid, p_role app.app_role, p_unit_id uuid,
                                          p_max_uses int, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_code text; v_id uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_invitation',
    jsonb_build_object('r', p_role, 'u', p_unit_id, 'm', p_max_uses, 'e', p_expires_at));
  if v_prev is not null then return v_prev; end if;   -- stored result never contains the code
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  if p_role = 'admin' then perform app_private.raise_tf('validation', 'admins are promoted with set_member_role'); end if;
  if p_expires_at is null or p_expires_at <= now() then perform app_private.raise_tf('validation', 'expires_at must be in the future'); end if;
  if p_max_uses is null or p_max_uses not between 1 and 1000 then perform app_private.raise_tf('validation', 'max_uses must be 1 to 1000'); end if;
  if not (v_actor.role = 'admin'
          or (v_actor.role = 'supervisor' and app_private.unit_in_scope(v_actor.id, p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))
          or (app_private.has_grant(v_actor.id, 'create_invitations', p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))) then
    perform app_private.raise_tf('forbidden');
  end if;
  v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');   -- see 0009 for the entropy statement
  insert into app.invitations (org_id, code_hash, role, unit_id, max_uses, expires_at, created_by)
  values (v_actor.org_id, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex'),
          p_role, p_unit_id, p_max_uses, p_expires_at, v_actor.id)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'unit_id', p_unit_id, 'max_uses', p_max_uses), p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', v_id, 'code_shown_once', true));
  perform app_private.finish_op(p_op_id, v_res);
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));   -- shown once, never persisted
end $$;

create function app_api.revoke_invitation(p_op_id uuid, p_invitation_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_i app.invitations; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'revoke_invitation', jsonb_build_object('i', p_invitation_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_i from app.invitations where id = p_invitation_id for update;
  if v_i.id is null or v_i.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'invitation'); end if;
  if not (v_actor.role = 'admin' or v_i.created_by = v_actor.id) then perform app_private.raise_tf('forbidden'); end if;
  update app.invitations set revoked_at = coalesce(revoked_at, now()) where id = p_invitation_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.revoked', 'invitation', p_invitation_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', p_invitation_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- Invalid codes return {ok:false, error:'not_found'} instead of raising, so the failed
-- attempt is committed and counts toward the 5 per hour limit.
create function app_api.redeem_invitation(p_op_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb; v_inv app.invitations; v_mem uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'redeem_invitation',
    jsonb_build_object('c', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_code, ''), 'UTF8')), 'hex')));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_verified_email();
  -- serialize attempts per user so concurrent guesses cannot all pass the counter
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('invite-attempts:' || v_uid::text, 0));
  if (select count(*) from app.invitation_attempts
      where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 5 then
    perform app_private.raise_tf('rate_limited', 'too many invitation attempts');
  end if;
  select * into v_inv from app.invitations
  where code_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_code, ''), 'UTF8')), 'hex')
  for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    insert into app.invitation_attempts (user_id) values (v_uid);
    v_res := jsonb_build_object('ok', false, 'error', 'not_found', 'server_time', now());
    return app_private.finish_op(p_op_id, v_res);
  end if;
  if exists (select 1 from app.memberships where user_id = v_uid) then
    perform app_private.raise_tf('validation', 'user already belongs to an organization');
  end if;
  insert into app.memberships (org_id, user_id, role, unit_id)
  values (v_inv.org_id, v_uid, v_inv.role, v_inv.unit_id) returning id into v_mem;
  update app.invitations set uses = uses + 1 where id = v_inv.id;
  perform app_private.emit_event(v_inv.org_id, v_mem, 'invitation.redeemed', 'invitation', v_inv.id, '{}'::jsonb, p_op_id);
  perform app_private.emit_event(v_inv.org_id, v_mem, 'member.joined', 'membership', v_mem,
    jsonb_build_object('role', v_inv.role, 'unit_id', v_inv.unit_id), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', v_mem, 'org_id', v_inv.org_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- members ---------------------------------------------------------------------------
create function app_api.set_member_role(p_op_id uuid, p_membership_id uuid, p_role app.app_role)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'set_member_role', jsonb_build_object('m', p_membership_id, 'r', p_role));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if v_t.status <> 'active' then perform app_private.raise_tf('validation', 'membership is not active'); end if;
  if v_actor.role <> 'admin' then
    -- supervisor with a delegated change_roles grant: down to leader or member, within scope
    if v_actor.role <> 'supervisor'
       or not app_private.has_grant(v_actor.id, 'change_roles', v_t.unit_id)
       or not app_private.has_authority_over_membership(v_actor.id, v_t.id)
       or p_role not in ('team_leader', 'member') then
      perform app_private.raise_tf('forbidden');
    end if;
  end if;
  update app.memberships set role = p_role where id = p_membership_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'member.role_changed', 'membership', p_membership_id,
    jsonb_build_object('from', v_t.role, 'to', p_role), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', p_membership_id, 'role', p_role));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.move_member(p_op_id uuid, p_membership_id uuid, p_unit_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'move_member', jsonb_build_object('m', p_membership_id, 'u', p_unit_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  perform app_private.lock_org_structure(v_actor.org_id);   -- placement changes authority
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if not exists (select 1 from app.org_units where id = p_unit_id and org_id = v_actor.org_id) then
    perform app_private.raise_tf('not_found', 'unit');
  end if;
  if v_t.status <> 'active' then perform app_private.raise_tf('validation', 'membership is not active'); end if;
  if v_actor.role <> 'admin' then
    if not (app_private.has_grant(v_actor.id, 'change_roles', v_t.unit_id)
            and app_private.has_grant(v_actor.id, 'change_roles', p_unit_id)
            and app_private.has_authority_over_membership(v_actor.id, v_t.id)) then
      perform app_private.raise_tf('forbidden');
    end if;
  end if;
  update app.memberships set unit_id = p_unit_id where id = p_membership_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'member.moved', 'membership', p_membership_id,
    jsonb_build_object('from_unit', v_t.unit_id, 'to_unit', p_unit_id), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', p_membership_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.set_member_status(p_op_id uuid, p_membership_id uuid, p_status app.member_status)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'set_member_status', jsonb_build_object('m', p_membership_id, 's', p_status));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if p_status = 'removed' then
    -- removal path
    if not (v_actor.role = 'admin'
            or (app_private.has_grant(v_actor.id, 'remove_members', v_t.unit_id)
                and app_private.has_authority_over_membership(v_actor.id, v_t.id))) then
      perform app_private.raise_tf('forbidden');
    end if;
    update app.permission_grants set revoked_at = now()
    where membership_id = p_membership_id and revoked_at is null;
    update app.org_units set leader_membership_id = null where leader_membership_id = p_membership_id;
  else
    if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
    if v_t.status = 'removed' then perform app_private.raise_tf('validation', 'removed members cannot be reactivated'); end if;
  end if;
  update app.memberships set status = p_status where id = p_membership_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id,
    case p_status when 'removed' then 'member.removed' else 'member.status_changed' end,
    'membership', p_membership_id, jsonb_build_object('from', v_t.status, 'to', p_status), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', p_membership_id, 'status', p_status));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- delegated grants ------------------------------------------------------------------
create function app_api.grant_permission(p_op_id uuid, p_membership_id uuid, p_permission app.permission_kind,
                                         p_scope_unit_id uuid, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_id uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'grant_permission',
    jsonb_build_object('m', p_membership_id, 'p', p_permission, 'u', p_scope_unit_id, 'e', p_expires_at));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if v_t.status <> 'active' or v_t.role = 'admin' then perform app_private.raise_tf('validation', 'grant target must be an active non-admin'); end if;
  if not exists (select 1 from app.org_units where id = p_scope_unit_id and org_id = v_actor.org_id) then
    perform app_private.raise_tf('not_found', 'unit');
  end if;
  if p_expires_at is null or p_expires_at <= now() then perform app_private.raise_tf('validation', 'expires_at must be in the future'); end if;
  insert into app.permission_grants (org_id, membership_id, permission, scope_unit_id, expires_at, granted_by)
  values (v_actor.org_id, p_membership_id, p_permission, p_scope_unit_id, p_expires_at, v_actor.id)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'grant.created', 'grant', v_id,
    jsonb_build_object('membership_id', p_membership_id, 'permission', p_permission,
                       'scope_unit_id', p_scope_unit_id, 'expires_at', p_expires_at), p_op_id);
  v_res := app_private.ok(jsonb_build_object('grant_id', v_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.revoke_permission(p_op_id uuid, p_grant_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_g app.permission_grants; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'revoke_permission', jsonb_build_object('g', p_grant_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
  select * into v_g from app.permission_grants where id = p_grant_id for update;
  if v_g.id is null or v_g.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'grant'); end if;
  update app.permission_grants set revoked_at = coalesce(revoked_at, now()) where id = p_grant_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'grant.revoked', 'grant', p_grant_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('grant_id', p_grant_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- profile ---------------------------------------------------------------------------
create function app_api.update_profile(p_op_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb; v_key text; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'update_profile', coalesce(p_patch, 'null'::jsonb));
  if v_prev is not null then return v_prev; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then perform app_private.raise_tf('validation', 'patch must be an object'); end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('display_name', 'locale', 'theme', 'timezone', 'reminder_time') then
      perform app_private.raise_tf('validation', 'field not allowed: ' || v_key);
    end if;
  end loop;
  update app.profiles set
    display_name = case when p_patch ? 'display_name' then p_patch ->> 'display_name' else display_name end,
    locale = case when p_patch ? 'locale' then p_patch ->> 'locale' else locale end,
    theme = case when p_patch ? 'theme' then p_patch ->> 'theme' else theme end,
    timezone = case when p_patch ? 'timezone' then p_patch ->> 'timezone' else timezone end,
    reminder_time = case when p_patch ? 'reminder_time' then (p_patch ->> 'reminder_time')::time else reminder_time end
  where id = v_uid;
  v_res := app_private.ok(jsonb_build_object('profile_id', v_uid));
  return app_private.finish_op(p_op_id, v_res);
end $$;

select app_private.finalize_ownership();
grant execute on function
  app_api.create_organization(uuid, text, text), app_api.create_unit(uuid, uuid, text),
  app_api.rename_unit(uuid, uuid, text), app_api.move_unit(uuid, uuid, uuid),
  app_api.create_invitation(uuid, app.app_role, uuid, int, timestamptz),
  app_api.revoke_invitation(uuid, uuid), app_api.redeem_invitation(uuid, text),
  app_api.set_member_role(uuid, uuid, app.app_role), app_api.move_member(uuid, uuid, uuid),
  app_api.set_member_status(uuid, uuid, app.member_status),
  app_api.grant_permission(uuid, uuid, app.permission_kind, uuid, timestamptz),
  app_api.revoke_permission(uuid, uuid), app_api.update_profile(uuid, jsonb)
to authenticated;

-- The RPC owner role reads auth.uid() and the verified-email flag. On hosted Supabase this
-- grant must be confirmed against the real auth schema (not covered by local tests).
grant usage on schema auth to app_rpc;
grant select (id, email_confirmed_at) on auth.users to app_rpc;

-- === FILE: 0009_rejoin_and_invitation_retry.sql ===

-- 0009: fix-forward for review findings.
-- (a) One ACTIVE-or-suspended membership per user instead of one membership row ever:
--     a removed membership keeps its row (history, events) and can be reactivated by a valid
--     invitation to the same org, or a new row can be created in another org. A user still
--     never holds two non-removed memberships.
alter table app.memberships drop constraint memberships_user_id_key;
create unique index memberships_one_live_per_user on app.memberships (user_id) where status <> 'removed';

-- (b) create_invitation retry: the code is never stored, so a lost response is recovered by
--     rotating the code of the SAME unused invitation (no second invitation, no lost invite).
create or replace function app_api.create_invitation(p_op_id uuid, p_role app.app_role, p_unit_id uuid,
                                                     p_max_uses int, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_code text; v_id uuid; v_res jsonb;
  v_inv app.invitations;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_invitation',
    jsonb_build_object('r', p_role, 'u', p_unit_id, 'm', p_max_uses, 'e', p_expires_at));
  if v_prev is not null then
    -- Replay after a lost response. Re-authorize as of now, then rotate the code of the
    -- original invitation if it is still unused. Never creates a second invitation.
    v_actor := app_private.require_actor();
    select * into v_inv from app.invitations
    where id = (v_prev -> 'data' ->> 'invitation_id')::uuid and created_by = v_actor.id for update;
    if v_inv.id is null or v_inv.uses > 0 or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
      return v_prev;   -- used, revoked or expired: nothing to recover; no code is returned
    end if;
    v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    update app.invitations
    set code_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex')
    where id = v_inv.id;
    perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.code_reissued', 'invitation', v_inv.id,
      '{}'::jsonb, p_op_id);
    return jsonb_set(v_prev, '{data,code}', to_jsonb(v_code));
  end if;
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  if p_role = 'admin' then perform app_private.raise_tf('validation', 'admins are promoted with set_member_role'); end if;
  if p_expires_at is null or p_expires_at <= now() then perform app_private.raise_tf('validation', 'expires_at must be in the future'); end if;
  if p_max_uses is null or p_max_uses not between 1 and 1000 then perform app_private.raise_tf('validation', 'max_uses must be 1 to 1000'); end if;
  if not (v_actor.role = 'admin'
          or (v_actor.role = 'supervisor' and app_private.unit_in_scope(v_actor.id, p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))
          or (app_private.has_grant(v_actor.id, 'create_invitations', p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))) then
    perform app_private.raise_tf('forbidden');
  end if;
  -- Two random v4 uuids, dashes removed: 64 hex characters, 244 random bits (each v4 uuid has
  -- 122 random bits; 4 version bits and 2 variant bits are fixed). Only a SHA-256 hash is stored.
  v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into app.invitations (org_id, code_hash, role, unit_id, max_uses, expires_at, created_by)
  values (v_actor.org_id, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex'),
          p_role, p_unit_id, p_max_uses, p_expires_at, v_actor.id)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'unit_id', p_unit_id, 'max_uses', p_max_uses), p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', v_id, 'code_shown_once', true));
  perform app_private.finish_op(p_op_id, v_res);   -- stored result never contains the code
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));
end $$;

-- (c) redeem: a removed membership in the SAME org is reactivated (same row, history kept)
--     with the role and unit of the invitation, never with the old role. Only a valid
--     invitation can do this: set_member_status still refuses to resurrect removed members.
create or replace function app_api.redeem_invitation(p_op_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb; v_inv app.invitations; v_mem uuid; v_res jsonb; v_old app.memberships;
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_code, ''), 'UTF8')), 'hex');
begin
  v_prev := app_private.begin_op(p_op_id, 'redeem_invitation', jsonb_build_object('c', v_hash));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_verified_email();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('invite-attempts:' || v_uid::text, 0));
  if (select count(*) from app.invitation_attempts
      where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 5 then
    perform app_private.raise_tf('rate_limited', 'too many invitation attempts');
  end if;
  select * into v_inv from app.invitations where code_hash = v_hash for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    insert into app.invitation_attempts (user_id) values (v_uid);
    v_res := jsonb_build_object('ok', false, 'error', 'not_found', 'server_time', now());
    return app_private.finish_op(p_op_id, v_res);
  end if;
  select * into v_old from app.memberships where user_id = v_uid and status <> 'removed';
  if v_old.id is not null then
    perform app_private.raise_tf('validation', 'user already belongs to an organization');
  end if;
  select * into v_old from app.memberships where user_id = v_uid and org_id = v_inv.org_id and status = 'removed';
  if v_old.id is not null then
    update app.memberships set status = 'active', role = v_inv.role, unit_id = v_inv.unit_id where id = v_old.id;
    v_mem := v_old.id;
    perform app_private.emit_event(v_inv.org_id, v_mem, 'member.rejoined', 'membership', v_mem,
      jsonb_build_object('role', v_inv.role, 'unit_id', v_inv.unit_id, 'previous_role', v_old.role), p_op_id);
  else
    insert into app.memberships (org_id, user_id, role, unit_id)
    values (v_inv.org_id, v_uid, v_inv.role, v_inv.unit_id) returning id into v_mem;
    perform app_private.emit_event(v_inv.org_id, v_mem, 'member.joined', 'membership', v_mem,
      jsonb_build_object('role', v_inv.role, 'unit_id', v_inv.unit_id), p_op_id);
  end if;
  update app.invitations set uses = uses + 1 where id = v_inv.id;
  perform app_private.emit_event(v_inv.org_id, v_mem, 'invitation.redeemed', 'invitation', v_inv.id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', v_mem, 'org_id', v_inv.org_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

select app_private.finalize_ownership();

-- === FILE: 0010_personal_space_and_sync_pull.sql ===

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

-- === FILE: 0011_invitation_stable_replay.sql ===

-- 0011: stable invitation replay. Supersedes the code rotation in 0009.
-- Design: the invitation code is DERIVED, not stored: code = SHA-256(secret || label || user || op ...).
-- Only the code hash is stored. A retry of the same op derives the same code, so a delayed or
-- concurrent duplicate returns exactly what the first call returned and never invalidates it.
-- Tradeoff (documented in docs/PHASE2_REPORT.md): plaintext is not retained anywhere, so a leak of
-- invitations, receipts or events does not reveal codes. A party holding the server secret AND the
-- (user_id, op_id) pair can re-derive a code; the secret is readable only by the RPC owner role.
-- The construction is a secret-prefixed SHA-256 (no pgcrypto locally); on hosted Supabase switch to
-- extensions.hmac(...) after verifying it there. Code entropy is bounded by the 244-bit secret.
create table app.server_secrets (
  key_id int primary key,
  secret text not null,
  created_at timestamptz not null default now()
);
insert into app.server_secrets (key_id, secret)
values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
alter table app.server_secrets enable row level security;
alter table app.server_secrets force row level security;
grant select on app.server_secrets to app_rpc;
create policy server_secrets_rpc on app.server_secrets for select to app_rpc using (true);
alter table app.invitations add column code_key_id int not null default 1 references app.server_secrets (key_id);

create function app_private.derive_code(p_key_id int, p_label text, p_user uuid, p_op uuid, p_extra text)
returns text language sql stable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    s.secret || '|' || p_label || '|' || p_user::text || '|' || p_op::text || '|' || coalesce(p_extra, ''), 'UTF8')), 'hex')
  from app.server_secrets s where s.key_id = p_key_id
$$;

create function app_private.code_hash(p_code text)
returns text language sql immutable
set search_path = ''
as $$ select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8')), 'hex') $$;

create or replace function app_api.create_invitation(p_op_id uuid, p_role app.app_role, p_unit_id uuid,
                                                     p_max_uses int, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_code text; v_id uuid; v_res jsonb;
  v_inv app.invitations;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_invitation',
    jsonb_build_object('r', p_role, 'u', p_unit_id, 'm', p_max_uses, 'e', p_expires_at));
  if v_prev is not null then
    -- Replay: return the SAME result and the SAME code (re-derived), while the invitation is live
    -- and its creator is still an active member. Never changes the secret, never creates a second row.
    select * into v_actor from app.memberships where user_id = app_private.require_uid() and status = 'active';
    select * into v_inv from app.invitations where id = (v_prev -> 'data' ->> 'invitation_id')::uuid;
    if v_actor.id is null or v_inv.id is null or v_inv.created_by <> v_actor.id
       or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
      return v_prev;   -- not live any more: result without a code
    end if;
    return jsonb_set(v_prev, '{data,code}',
      to_jsonb(app_private.derive_code(v_inv.code_key_id, 'invite', v_actor.user_id, p_op_id, null)));
  end if;
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  if p_role = 'admin' then perform app_private.raise_tf('validation', 'admins are promoted with set_member_role'); end if;
  if p_expires_at is null or p_expires_at <= now() then perform app_private.raise_tf('validation', 'expires_at must be in the future'); end if;
  if p_max_uses is null or p_max_uses not between 1 and 1000 then perform app_private.raise_tf('validation', 'max_uses must be 1 to 1000'); end if;
  if not (v_actor.role = 'admin'
          or (v_actor.role = 'supervisor' and app_private.unit_in_scope(v_actor.id, p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))
          or (app_private.has_grant(v_actor.id, 'create_invitations', p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))) then
    perform app_private.raise_tf('forbidden');
  end if;
  v_code := app_private.derive_code(1, 'invite', v_actor.user_id, p_op_id, null);
  insert into app.invitations (org_id, code_hash, role, unit_id, max_uses, expires_at, created_by, code_key_id)
  values (v_actor.org_id, app_private.code_hash(v_code), p_role, p_unit_id, p_max_uses, p_expires_at, v_actor.id, 1)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'unit_id', p_unit_id, 'max_uses', p_max_uses), p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', v_id));
  perform app_private.finish_op(p_op_id, v_res);   -- the stored result never contains the code
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));
end $$;

-- Explicit rotation is its own authorized operation (creator or admin), with its own op id and
-- stable replay. It is never triggered by transport retries.
create function app_api.rotate_invitation_code(p_op_id uuid, p_invitation_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_inv app.invitations; v_code text; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'rotate_invitation_code', jsonb_build_object('i', p_invitation_id));
  v_actor := app_private.require_actor();
  select * into v_inv from app.invitations where id = p_invitation_id for update;
  if v_inv.id is null or v_inv.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'invitation'); end if;
  if not (v_actor.role = 'admin' or v_inv.created_by = v_actor.id) then perform app_private.raise_tf('forbidden'); end if;
  if v_prev is not null then
    -- stable replay of the same rotation, if it is still the current code
    v_code := app_private.derive_code(v_inv.code_key_id, 'rotate', v_actor.user_id, p_op_id, p_invitation_id::text);
    if v_inv.code_hash = app_private.code_hash(v_code) then
      return jsonb_set(v_prev, '{data,code}', to_jsonb(v_code));
    end if;
    return v_prev;
  end if;
  if v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    perform app_private.raise_tf('validation', 'invitation is not live');
  end if;
  v_code := app_private.derive_code(v_inv.code_key_id, 'rotate', v_actor.user_id, p_op_id, p_invitation_id::text);
  update app.invitations set code_hash = app_private.code_hash(v_code) where id = p_invitation_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.code_rotated', 'invitation', p_invitation_id,
    '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', p_invitation_id));
  perform app_private.finish_op(p_op_id, v_res);
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));
end $$;

select app_private.finalize_ownership();
grant execute on function app_api.rotate_invitation_code(uuid, uuid) to authenticated;

-- === FILE: 0012_standard_hmac.sql ===

-- 0012: replace the secret-prefixed SHA-256 code derivation with a standard HMAC-SHA-256 (RFC 2104 / FIPS 198-1).
-- pgcrypto is not guaranteed locally, so HMAC is built from the built-in sha256(). It is checked against the
-- RFC 4231 test vectors and against Python's hmac module. On Supabase, a hosted check compares it with
-- extensions.hmac (see docs/HOSTED_VERIFICATION.md); the algorithm is the same on both, so codes do not change.
-- No invitation exists before first release, so no code derived under 0011 needs to stay valid.

create function app_private.hmac_sha256(p_key bytea, p_msg bytea)
returns bytea language plpgsql immutable
set search_path = ''
as $$
declare
  v_key bytea := p_key;
  v_ipad bytea;
  v_opad bytea;
  i int;
begin
  if pg_catalog.length(v_key) > 64 then
    v_key := pg_catalog.sha256(v_key);
  end if;
  v_key := v_key || pg_catalog.decode(pg_catalog.repeat('00', 64 - pg_catalog.length(v_key)), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  for i in 0..63 loop
    v_ipad := pg_catalog.set_byte(v_ipad, i, pg_catalog.get_byte(v_key, i) # 54);   -- 0x36
    v_opad := pg_catalog.set_byte(v_opad, i, pg_catalog.get_byte(v_key, i) # 92);   -- 0x5c
  end loop;
  return pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || p_msg));
end
$$;

create or replace function app_private.derive_code(p_key_id int, p_label text, p_user uuid, p_op uuid, p_extra text)
returns text language sql stable
set search_path = ''
as $$
  select pg_catalog.encode(app_private.hmac_sha256(
    pg_catalog.convert_to(s.secret, 'UTF8'),
    pg_catalog.convert_to(p_label || '|' || p_user::text || '|' || p_op::text || '|' || coalesce(p_extra, ''), 'UTF8')), 'hex')
  from app.server_secrets s where s.key_id = p_key_id
$$;

select app_private.finalize_ownership();

-- === FILE: 0013_personal_rpcs_complete.sql ===

-- 0013: remaining personal-space RPCs (owner only, idempotent via receipts, history in personal_events).
-- update, reopen, delete and restore (soft, subtree), reorder, dependencies with cycle check,
-- recurrence rule set/clear, note update and delete.
-- Not here: attachments (Phase 11 storage), field-level conflict merge (Phase 4), occurrence generation (Phase 4).

create function app_private.personal_task_owned(p_uid uuid, p_id uuid)
returns app.personal_tasks language plpgsql
set search_path = ''
as $$
declare v_t app.personal_tasks;
begin
  select * into v_t from app.personal_tasks where id = p_id and user_id = p_uid for update;
  if v_t.id is null then perform app_private.raise_tf('not_found', 'task'); end if;
  return v_t;
end $$;

create function app_api.update_personal_task(p_op_id uuid, p_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; k text;
begin
  v_prev := app_private.begin_op(p_op_id, 'update_personal_task', jsonb_build_object('i', p_id, 'p', p_patch));
  if v_prev is not null then return v_prev; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform app_private.raise_tf('validation', 'patch must be a non-empty object');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('title', 'notes', 'priority', 'status', 'planned_date', 'due_date', 'estimate_min', 'is_required') then
      perform app_private.raise_tf('validation', 'field not editable: ' || k);
    end if;
  end loop;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if p_patch ? 'status' and p_patch ->> 'status' not in ('todo', 'in_progress', 'canceled') then
    perform app_private.raise_tf('validation', 'status here must be todo, in_progress or canceled; use complete_personal_task for done');
  end if;
  if p_patch ? 'status' and v_t.status = 'done' then
    perform app_private.raise_tf('validation', 'use reopen_personal_task for a done task');
  end if;
  update app.personal_tasks set
    title = case when p_patch ? 'title' then p_patch ->> 'title' else title end,
    notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else notes end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    planned_date = case when p_patch ? 'planned_date' then (p_patch ->> 'planned_date')::date else planned_date end,
    due_date = case when p_patch ? 'due_date' then (p_patch ->> 'due_date')::date else due_date end,
    estimate_min = case when p_patch ? 'estimate_min' then (p_patch ->> 'estimate_min')::int else estimate_min end,
    is_required = case when p_patch ? 'is_required' then (p_patch ->> 'is_required')::boolean else is_required end
  where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.updated', p_id,
    jsonb_build_object('fields', (select jsonb_agg(x order by x) from jsonb_object_keys(p_patch) x)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.reopen_personal_task(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'reopen_personal_task', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if v_t.status <> 'done' then perform app_private.raise_tf('validation', 'task is not done'); end if;
  update app.personal_tasks set status = 'todo', completed_at = null where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.reopened', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.delete_personal_task(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; v_n int;
begin
  v_prev := app_private.begin_op(p_op_id, 'delete_personal_task', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  with recursive sub as (
    select id from app.personal_tasks where id = p_id and user_id = v_uid
    union all
    select c.id from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid)
  update app.personal_tasks t set deleted_at = now() from sub where t.id = sub.id and t.deleted_at is null;
  get diagnostics v_n = row_count;
  perform app_private.emit_personal_event(v_uid, 'ptask.deleted', p_id, jsonb_build_object('rows', v_n), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'rows', v_n));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.restore_personal_task(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; v_n int;
begin
  v_prev := app_private.begin_op(p_op_id, 'restore_personal_task', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is null then perform app_private.raise_tf('validation', 'task is not deleted'); end if;
  if v_t.parent_id is not null and exists (select 1 from app.personal_tasks where id = v_t.parent_id and deleted_at is not null) then
    perform app_private.raise_tf('validation', 'restore the parent first');
  end if;
  -- restore the subtree that was deleted together with this task (same deletion instant)
  with recursive sub as (
    select id from app.personal_tasks where id = p_id and user_id = v_uid
    union all
    select c.id from app.personal_tasks c join sub s on c.parent_id = s.id
    where c.user_id = v_uid and c.deleted_at = v_t.deleted_at)
  update app.personal_tasks t set deleted_at = null from sub where t.id = sub.id;
  get diagnostics v_n = row_count;
  perform app_private.emit_personal_event(v_uid, 'ptask.restored', p_id, jsonb_build_object('rows', v_n), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'rows', v_n));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.reorder_personal_task(p_op_id uuid, p_id uuid, p_sort_key text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'reorder_personal_task', jsonb_build_object('i', p_id, 's', p_sort_key));
  if v_prev is not null then return v_prev; end if;
  if p_sort_key is null or p_sort_key !~ '^[0-9a-zA-Z]{1,64}$' then
    perform app_private.raise_tf('validation', 'sort_key must be 1 to 64 alphanumeric characters');
  end if;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  update app.personal_tasks set sort_key = p_sort_key where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.reordered', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- p_task_id is blocked by p_blocked_by. A cycle exists if p_blocked_by is already (transitively) blocked by p_task_id.
create function app_api.add_personal_dependency(p_op_id uuid, p_task_id uuid, p_blocked_by uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'add_personal_dependency', jsonb_build_object('t', p_task_id, 'b', p_blocked_by));
  if v_prev is not null then return v_prev; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-deps:' || v_uid::text, 0));
  if p_task_id = p_blocked_by then perform app_private.raise_tf('validation', 'a task cannot block itself'); end if;
  perform app_private.personal_task_owned(v_uid, p_task_id);
  perform app_private.personal_task_owned(v_uid, p_blocked_by);
  if exists (select 1 from app.personal_tasks where id in (p_task_id, p_blocked_by) and deleted_at is not null) then
    perform app_private.raise_tf('not_found', 'task');
  end if;
  if exists (
    with recursive r as (
      select blocked_by_task_id as id from app.personal_task_dependencies where task_id = p_blocked_by and user_id = v_uid
      union
      select d.blocked_by_task_id from app.personal_task_dependencies d join r on d.task_id = r.id where d.user_id = v_uid)
    select 1 from r where id = p_task_id) then
    perform app_private.raise_tf('cycle_detected', 'dependency would create a cycle');
  end if;
  insert into app.personal_task_dependencies (task_id, blocked_by_task_id, user_id)
  values (p_task_id, p_blocked_by, v_uid) on conflict do nothing;
  perform app_private.emit_personal_event(v_uid, 'ptask.dependency_added', p_task_id, jsonb_build_object('blocked_by', p_blocked_by), p_op_id);
  v_res := app_private.ok(jsonb_build_object('task_id', p_task_id, 'blocked_by', p_blocked_by));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.remove_personal_dependency(p_op_id uuid, p_task_id uuid, p_blocked_by uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'remove_personal_dependency', jsonb_build_object('t', p_task_id, 'b', p_blocked_by));
  if v_prev is not null then return v_prev; end if;
  delete from app.personal_task_dependencies where task_id = p_task_id and blocked_by_task_id = p_blocked_by and user_id = v_uid;
  perform app_private.emit_personal_event(v_uid, 'ptask.dependency_removed', p_task_id, jsonb_build_object('blocked_by', p_blocked_by), p_op_id);
  v_res := app_private.ok(jsonb_build_object('task_id', p_task_id, 'blocked_by', p_blocked_by));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- Create or replace a recurrence rule (weekday numbers 0..6, Saturday-start week handled by the client/Phase 4 generator).
create function app_api.set_personal_recurrence(p_op_id uuid, p_id uuid, p_template jsonb, p_weekdays int[],
                                                p_starts_on date, p_ends_on date default null)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb; v_owner uuid;
begin
  v_prev := app_private.begin_op(p_op_id, 'set_personal_recurrence',
    jsonb_build_object('i', p_id, 't', p_template, 'w', p_weekdays, 's', p_starts_on, 'e', p_ends_on));
  if v_prev is not null then return v_prev; end if;
  if p_template is null or jsonb_typeof(p_template) <> 'object' or char_length(coalesce(p_template ->> 'title', '')) not between 1 and 300 then
    perform app_private.raise_tf('validation', 'template needs a title');
  end if;
  if p_ends_on is not null and p_ends_on < p_starts_on then
    perform app_private.raise_tf('validation', 'ends_on is before starts_on');
  end if;
  select user_id into v_owner from app.personal_recurrence_rules where id = p_id;
  if v_owner is not null and v_owner <> v_uid then perform app_private.raise_tf('not_found', 'rule'); end if;
  insert into app.personal_recurrence_rules (id, user_id, template, weekdays, starts_on, ends_on)
  values (p_id, v_uid, p_template, p_weekdays::smallint[], p_starts_on, p_ends_on)
  on conflict (id) do update set template = excluded.template, weekdays = excluded.weekdays,
    starts_on = excluded.starts_on, ends_on = excluded.ends_on, active = true, deleted_at = null
    where app.personal_recurrence_rules.user_id = v_uid;
  perform app_private.emit_personal_event(v_uid, 'prule.set', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.clear_personal_recurrence(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb; v_n int;
begin
  v_prev := app_private.begin_op(p_op_id, 'clear_personal_recurrence', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  update app.personal_recurrence_rules set active = false, deleted_at = now() where id = p_id and user_id = v_uid;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform app_private.raise_tf('not_found', 'rule'); end if;
  perform app_private.emit_personal_event(v_uid, 'prule.cleared', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.update_personal_note(p_op_id uuid, p_id uuid, p_body text, p_pinned boolean default null)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb; v_n int;
begin
  v_prev := app_private.begin_op(p_op_id, 'update_personal_note', jsonb_build_object('i', p_id, 'b', p_body, 'p', p_pinned));
  if v_prev is not null then return v_prev; end if;
  update app.personal_notes set body = coalesce(p_body, body), pinned = coalesce(p_pinned, pinned)
  where id = p_id and user_id = v_uid and deleted_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform app_private.raise_tf('not_found', 'note'); end if;
  perform app_private.emit_personal_event(v_uid, 'pnote.updated', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.delete_personal_note(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_res jsonb; v_n int;
begin
  v_prev := app_private.begin_op(p_op_id, 'delete_personal_note', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  update app.personal_notes set deleted_at = now() where id = p_id and user_id = v_uid and deleted_at is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then perform app_private.raise_tf('not_found', 'note'); end if;
  perform app_private.emit_personal_event(v_uid, 'pnote.deleted', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

select app_private.finalize_ownership();
grant execute on function app_api.update_personal_task(uuid, uuid, jsonb), app_api.reopen_personal_task(uuid, uuid),
  app_api.delete_personal_task(uuid, uuid), app_api.restore_personal_task(uuid, uuid),
  app_api.reorder_personal_task(uuid, uuid, text), app_api.add_personal_dependency(uuid, uuid, uuid),
  app_api.remove_personal_dependency(uuid, uuid, uuid),
  app_api.set_personal_recurrence(uuid, uuid, jsonb, int[], date, date),
  app_api.clear_personal_recurrence(uuid, uuid), app_api.update_personal_note(uuid, uuid, text, boolean),
  app_api.delete_personal_note(uuid, uuid) to authenticated;

-- === FILE: 0015_my_membership_baseline.sql ===

-- LOCAL DEVELOPMENT ONLY: read-only membership compatibility without held migration 0014.
-- Not a hosted migration, no account-deletion policy changes.
-- Baseline identity is profiles.id = auth.users.id.
-- Read-only "who am I" for the client shell. The app schema is intentionally not exposed over REST, so the client
-- needs one narrow read RPC to learn its own live membership and whether its email is verified. No new table access.
create function app_api.my_membership()
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_verified boolean;
  v_m jsonb;
begin
  select exists (select 1 from auth.users u join app.profiles p on p.id = u.id where p.id = v_uid and u.email_confirmed_at is not null) into v_verified;
  select pg_catalog.jsonb_build_object('membership_id', m.id, 'org_id', m.org_id, 'org_name', o.name, 'role', m.role,
                                       'status', m.status, 'unit_id', m.unit_id)
    into v_m
  from app.memberships m join app.organizations o on o.id = m.org_id
  where m.user_id = v_uid and m.status <> 'removed' and o.deleted_at is null
  order by m.created_at desc limit 1;
  return app_private.ok(pg_catalog.jsonb_build_object('email_verified', v_verified, 'membership', v_m));
end $$;
grant execute on function app_api.my_membership() to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0016_org_read_rpcs.sql ===

-- 0016: read-only listings for the organization screens. SECURITY INVOKER on purpose: they run as the calling user, so
-- the existing RLS policies (authority-down visibility) decide every row. No new access path, no privilege widening.
create function app_api.list_members()
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'data', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'membership_id', m.id, 'display_name', p.display_name, 'role', m.role, 'status', m.status, 'unit_id', m.unit_id,
           'is_me', m.id = app_private.my_membership_id()) order by m.created_at, m.id), '[]'::jsonb))
  from app.memberships m join app.profiles p on p.id = m.user_id
  where m.status <> 'removed'
$$;

create function app_api.list_invitations()
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'data', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', i.id, 'role', i.role, 'unit_id', i.unit_id, 'max_uses', i.max_uses, 'uses', i.uses,
           'expires_at', i.expires_at, 'revoked_at', i.revoked_at) order by i.created_at, i.id), '[]'::jsonb))
  from app.invitations i
$$;

create function app_api.list_units()
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'data', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', u.id, 'parent_id', u.parent_id, 'name', u.name) order by u.created_at, u.id), '[]'::jsonb))
  from app.org_units u where u.deleted_at is null
$$;
grant execute on function app_api.list_members(), app_api.list_invitations(), app_api.list_units() to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0017_sync_status.sql ===

-- 0017: lets a client learn that its pull cursor is older than the purge floor (tombstones it never saw are gone), so it
-- must discard its non-pending local copy of the stream and pull again from zero. Deliberately independent of identity
-- helpers (no uid): the floor is a non-sensitive per-stream number, so this applies on the 0001-0013 baseline and with 0014+.
create function app_api.sync_status(p_stream text, p_after_xid xid8 default '0'::xid8)
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare v_floor xid8;
begin
  if p_stream not in ('personal_tasks', 'personal_notes', 'org_units') then
    raise exception 'unknown stream' using errcode = 'TF004', detail = '{"code":"validation","message":"unknown stream"}';
  end if;
  select f.floor_xid into v_floor from app.sync_floor f where f.stream = p_stream;
  v_floor := coalesce(v_floor, '0'::xid8);
  return pg_catalog.jsonb_build_object('ok', true, 'data', pg_catalog.jsonb_build_object(
    'floor_xid', v_floor::text,
    'full_resync_required', (p_after_xid::text::numeric > 0 and p_after_xid::text::numeric < v_floor::text::numeric)),
    'server_time', pg_catalog.now());
end $$;
grant execute on function app_api.sync_status(text, xid8) to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0018_complete_guard_deleted.sql ===

-- 0018: complete_personal_task (0010) did not refuse a soft-deleted task, unlike update/reopen/delete (0013). A queued
-- "complete" from a device that never saw the delete therefore changed a tombstone (status, completed_at, a new change_xid and
-- an event). It now fails with not_found like the other RPCs, so the client shows the refusal. Same signature, grants unchanged.
-- NOT part of the approved baseline (0001-0013): needs the user's approval before any hosted use.
create or replace function app_api.complete_personal_task(p_op_id uuid, p_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'complete_personal_task', jsonb_build_object('i', p_id));
  if v_prev is not null then return v_prev; end if;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null or v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if exists (select 1 from app.personal_tasks c where c.parent_id = p_id and c.is_required
             and c.status not in ('done', 'canceled') and c.deleted_at is null) then
    perform app_private.raise_tf('gate_failed', 'required subtasks are not done');
  end if;
  update app.personal_tasks set status = 'done', completed_at = now() where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.completed', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;
select app_private.finalize_ownership();

-- === FILE: 0019_update_checked.sql ===

-- 0019: conditional update. Same rules as update_personal_task (0013), plus p_base (REQUIRED): the values the client last saw
-- for the fields it edits. Under the row lock, if ANY of those fields currently holds a different value (and not already the
-- value being written) the server REFUSES with stale_conflict and changes nothing; the message carries the current values.
-- The client keeps the user's intent, shows the conflict, and only a fresh operation with a fresh base can apply it.
-- The refusal is stored as the op's terminal result (receipt): a resend returns the same refusal, even if the values changed back.
-- NOT part of the approved baseline: needs the user's approval before hosted use.
create function app_api.update_personal_task_checked(p_op_id uuid, p_id uuid, p_patch jsonb, p_base jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; k text; v_over jsonb := '{}'::jsonb; v_cur jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'update_personal_task_checked', jsonb_build_object('i', p_id, 'p', p_patch, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' then
    perform app_private.raise_tf('validation', 'base is required and must be an object');
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform app_private.raise_tf('validation', 'patch must be a non-empty object');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('title', 'notes', 'priority', 'status', 'planned_date', 'due_date', 'estimate_min', 'is_required') then
      perform app_private.raise_tf('validation', 'field not editable: ' || k);
    end if;
  end loop;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if p_patch ? 'status' and p_patch ->> 'status' not in ('todo', 'in_progress', 'canceled') then
    perform app_private.raise_tf('validation', 'status here must be todo, in_progress or canceled; use complete_personal_task for done');
  end if;
  if p_patch ? 'status' and v_t.status = 'done' then
    perform app_private.raise_tf('validation', 'use reopen_personal_task for a done task');
  end if;
  -- Atomic (row is locked): which edited fields hold a value the client did NOT see?
  -- Only fields the client sent a base for are compared.
  v_cur := pg_catalog.to_jsonb(v_t);
  if p_base is not null then
    for k in select jsonb_object_keys(p_patch) loop
      if p_base ? k and (v_cur -> k) is distinct from (p_base -> k) and (v_cur -> k) is distinct from (p_patch -> k) then
        v_over := v_over || pg_catalog.jsonb_build_object(k, v_cur -> k);
      end if;
    end loop;
  end if;
  if v_over <> '{}'::jsonb then
    -- Terminal, idempotent refusal: returned as DATA and stored in the receipt, so this op_id can never commit later,
    -- even if the values change back. Only a fresh op_id (explicit user resolution) can apply the change.
    v_res := pg_catalog.jsonb_build_object('ok', false, 'code', 'stale_conflict', 'message', v_over::text, 'current', v_over);
    return app_private.finish_op(p_op_id, v_res);
  end if;
  update app.personal_tasks set
    title = case when p_patch ? 'title' then p_patch ->> 'title' else title end,
    notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else notes end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    planned_date = case when p_patch ? 'planned_date' then (p_patch ->> 'planned_date')::date else planned_date end,
    due_date = case when p_patch ? 'due_date' then (p_patch ->> 'due_date')::date else due_date end,
    estimate_min = case when p_patch ? 'estimate_min' then (p_patch ->> 'estimate_min')::int else estimate_min end,
    is_required = case when p_patch ? 'is_required' then (p_patch ->> 'is_required')::boolean else is_required end
  where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.updated', p_id,
    jsonb_build_object('fields', (select jsonb_agg(x order by x) from jsonb_object_keys(p_patch) x)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'overwritten', v_over, 'rv_before', v_t.row_version, 'rv', v_t.row_version + 1));
  return app_private.finish_op(p_op_id, v_res);
end $$;
grant execute on function app_api.update_personal_task_checked(uuid, uuid, jsonb, jsonb) to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0020_conditional_mutations.sql ===

-- 0020: conditional complete / reopen / delete for personal tasks. Same rules as 0013/0018, plus a REQUIRED base describing what
-- the device last saw. Under the row lock, if the task changed in a way that makes the device's intent unsafe, the server REFUSES
-- before changing anything and stores the refusal as the op's terminal result (receipt): the same op_id can never commit later,
-- even if values change back. Only a fresh op_id with a fresh base (explicit user resolution) can apply it.
--   complete / reopen: base {"status": <status the device saw>}. Refused when the current status differs from the base AND is not
--     already the target (completing a task that is already done, or reopening one already todo, is an idempotent success; nothing is changed or re-emitted).
--   delete: base {"row_version": n, "subtree": {"n": k, "sum": s}} (subtree optional: live descendants count and sum of row_version).
--     Refused when the row or the live subtree changed since the device saw it, so a remote edit is never deleted unseen.
--     Already deleted: idempotent success.
-- NOT part of the approved baseline: needs the user's approval before hosted use.
create function app_private.refuse_stale(p_op uuid, p_current jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
begin
  return app_private.finish_op(p_op, pg_catalog.jsonb_build_object('ok', false, 'code', 'stale_conflict',
           'message', p_current::text, 'current', p_current));
end $$;

create function app_api.complete_personal_task_checked(p_op_id uuid, p_id uuid, p_base jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'complete_personal_task_checked', jsonb_build_object('i', p_id, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' or not (p_base ? 'status') then
    perform app_private.raise_tf('validation', 'base with status is required');
  end if;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null or v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if v_t.status = 'done' then
    return app_private.finish_op(p_op_id, app_private.ok(jsonb_build_object('id', p_id, 'already', true)));
  end if;
  if v_t.status is distinct from (p_base ->> 'status') then
    return app_private.refuse_stale(p_op_id, pg_catalog.jsonb_build_object('status', v_t.status, 'row_version', v_t.row_version));
  end if;
  if exists (select 1 from app.personal_tasks c where c.parent_id = p_id and c.is_required
             and c.status not in ('done', 'canceled') and c.deleted_at is null) then
    perform app_private.raise_tf('gate_failed', 'required subtasks are not done');
  end if;
  update app.personal_tasks set status = 'done', completed_at = now() where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.completed', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'rv_before', v_t.row_version, 'rv', v_t.row_version + 1));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.reopen_personal_task_checked(p_op_id uuid, p_id uuid, p_base jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'reopen_personal_task_checked', jsonb_build_object('i', p_id, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' or not (p_base ? 'status') then
    perform app_private.raise_tf('validation', 'base with status is required');
  end if;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null or v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if v_t.status = 'todo' and (p_base ->> 'status') = 'done' then
    return app_private.finish_op(p_op_id, app_private.ok(jsonb_build_object('id', p_id, 'already', true)));  -- someone already reopened it
  end if;
  if v_t.status <> 'done' or (p_base ->> 'status') <> 'done' then
    return app_private.refuse_stale(p_op_id, pg_catalog.jsonb_build_object('status', v_t.status, 'row_version', v_t.row_version));
  end if;
  update app.personal_tasks set status = 'todo', completed_at = null where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.reopened', p_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'rv_before', v_t.row_version, 'rv', v_t.row_version + 1));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.delete_personal_task_checked(p_op_id uuid, p_id uuid, p_base jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; v_n int; v_sn bigint; v_ss numeric;
begin
  v_prev := app_private.begin_op(p_op_id, 'delete_personal_task_checked', jsonb_build_object('i', p_id, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' or not (p_base ? 'row_version') then
    perform app_private.raise_tf('validation', 'base with row_version is required');
  end if;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null then perform app_private.raise_tf('not_found', 'task'); end if;
  if v_t.deleted_at is not null then
    return app_private.finish_op(p_op_id, app_private.ok(jsonb_build_object('id', p_id, 'rows', 0, 'already', true)));
  end if;
  with recursive sub as (
    select id, row_version from app.personal_tasks where parent_id = p_id and user_id = v_uid and deleted_at is null
    union all
    select c.id, c.row_version from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid and c.deleted_at is null)
  select count(*), coalesce(sum(row_version), 0) into v_sn, v_ss from sub;
  if v_t.row_version <> (p_base ->> 'row_version')::bigint
     or (p_base ? 'subtree' and (v_sn <> (p_base -> 'subtree' ->> 'n')::bigint or v_ss <> (p_base -> 'subtree' ->> 'sum')::numeric)) then
    return app_private.refuse_stale(p_op_id, pg_catalog.jsonb_build_object('row_version', v_t.row_version, 'status', v_t.status,
             'subtree', pg_catalog.jsonb_build_object('n', v_sn, 'sum', v_ss)));
  end if;
  with recursive sub as (
    select id from app.personal_tasks where id = p_id and user_id = v_uid
    union all
    select c.id from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid)
  update app.personal_tasks t set deleted_at = now() from sub where t.id = sub.id and t.deleted_at is null;
  get diagnostics v_n = row_count;
  perform app_private.emit_personal_event(v_uid, 'ptask.deleted', p_id, jsonb_build_object('rows', v_n), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'rows', v_n, 'rv_before', v_t.row_version, 'rv', v_t.row_version + 1));
  return app_private.finish_op(p_op_id, v_res);
end $$;

grant execute on function app_api.complete_personal_task_checked(uuid, uuid, jsonb),
  app_api.reopen_personal_task_checked(uuid, uuid, jsonb), app_api.delete_personal_task_checked(uuid, uuid, jsonb) to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0021_offline_mutation_safety.sql ===

-- LOCAL ONLY proposal. Not authorized for hosted installation.
-- Exact subtree membership/version token prevents count/sum collisions; table lock closes descendant races.
create or replace function app_api.update_personal_task_checked(p_op_id uuid, p_id uuid, p_patch jsonb, p_base jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; k text; v_over jsonb := '{}'::jsonb; v_cur jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'update_personal_task_checked', jsonb_build_object('i', p_id, 'p', p_patch, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' then
    perform app_private.raise_tf('validation', 'base is required and must be an object');
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' or p_patch = '{}'::jsonb then
    perform app_private.raise_tf('validation', 'patch must be a non-empty object');
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('title', 'notes', 'priority', 'status', 'planned_date', 'due_date', 'estimate_min', 'is_required') then
      perform app_private.raise_tf('validation', 'field not editable: ' || k);
    end if;
  end loop;
  v_t := app_private.personal_task_owned(v_uid, p_id);
  if v_t.deleted_at is not null then perform app_private.raise_tf('not_found', 'task'); end if;
  if p_patch ? 'status' and p_patch ->> 'status' not in ('todo', 'in_progress', 'canceled') then
    perform app_private.raise_tf('validation', 'status here must be todo, in_progress or canceled; use complete_personal_task for done');
  end if;
  if p_patch ? 'status' and v_t.status = 'done' then
    perform app_private.raise_tf('validation', 'use reopen_personal_task for a done task');
  end if;
  -- Atomic (row is locked): which edited fields hold a value the client did NOT see?
  -- Every patched field requires a base; missing fields never disable the check.
  v_cur := pg_catalog.to_jsonb(v_t);
  if p_base is not null then
    for k in select jsonb_object_keys(p_patch) loop
      if not (p_base ? k) then perform app_private.raise_tf('validation', 'base required for every patched field'); end if;
      if (v_cur -> k) is distinct from (p_base -> k) and (v_cur -> k) is distinct from (p_patch -> k) then
        v_over := v_over || pg_catalog.jsonb_build_object(k, v_cur -> k);
      end if;
    end loop;
  end if;
  if v_over <> '{}'::jsonb then
    -- Terminal, idempotent refusal: returned as DATA and stored in the receipt, so this op_id can never commit later,
    -- even if the values change back. Only a fresh op_id (explicit user resolution) can apply the change.
    v_res := pg_catalog.jsonb_build_object('ok', false, 'code', 'stale_conflict', 'message', v_over::text, 'current', v_over);
    return app_private.finish_op(p_op_id, v_res);
  end if;
  update app.personal_tasks set
    title = case when p_patch ? 'title' then p_patch ->> 'title' else title end,
    notes = case when p_patch ? 'notes' then p_patch ->> 'notes' else notes end,
    priority = case when p_patch ? 'priority' then p_patch ->> 'priority' else priority end,
    status = case when p_patch ? 'status' then p_patch ->> 'status' else status end,
    planned_date = case when p_patch ? 'planned_date' then (p_patch ->> 'planned_date')::date else planned_date end,
    due_date = case when p_patch ? 'due_date' then (p_patch ->> 'due_date')::date else due_date end,
    estimate_min = case when p_patch ? 'estimate_min' then (p_patch ->> 'estimate_min')::int else estimate_min end,
    is_required = case when p_patch ? 'is_required' then (p_patch ->> 'is_required')::boolean else is_required end
  where id = p_id;
  perform app_private.emit_personal_event(v_uid, 'ptask.updated', p_id,
    jsonb_build_object('fields', (select jsonb_agg(x order by x) from jsonb_object_keys(p_patch) x)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'overwritten', v_over, 'rv_before', v_t.row_version, 'rv', v_t.row_version + 1));
  return app_private.finish_op(p_op_id, v_res);
end $$;
grant execute on function app_api.update_personal_task_checked(uuid, uuid, jsonb, jsonb) to authenticated;
select app_private.finalize_ownership();

create or replace function app_api.delete_personal_task_checked(p_op_id uuid, p_id uuid, p_base jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; v_n int; v_sn bigint; v_ss numeric; v_members jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'delete_personal_task_checked', jsonb_build_object('i', p_id, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' or not (p_base ? 'row_version') then
    perform app_private.raise_tf('validation', 'base with row_version is required');
  end if;
  -- Serialize all table writers, including child insert/reparent, before reading. Local safety-first implementation.
  lock table app.personal_tasks in share row exclusive mode;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null then perform app_private.raise_tf('not_found', 'task'); end if;
  if v_t.deleted_at is not null then
    return app_private.finish_op(p_op_id, app_private.ok(jsonb_build_object('id', p_id, 'rows', 0, 'already', true)));
  end if;
  with recursive sub as (
    select id, row_version from app.personal_tasks where parent_id = p_id and user_id = v_uid and deleted_at is null
    union all
    select c.id, c.row_version from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid and c.deleted_at is null)
  select count(*), coalesce(sum(row_version), 0), coalesce(jsonb_agg(jsonb_build_object('id', id, 'rv', row_version) order by id), '[]'::jsonb) into v_sn, v_ss, v_members from sub;
  if v_t.row_version is distinct from (p_base ->> 'row_version')::bigint
     or (v_sn > 0 and not (p_base ? 'subtree'))
     or (p_base ? 'subtree' and (coalesce(p_base -> 'subtree' -> 'members', '[]'::jsonb) <> v_members or v_sn <> (p_base -> 'subtree' ->> 'n')::bigint or v_ss <> (p_base -> 'subtree' ->> 'sum')::numeric)) then
    return app_private.refuse_stale(p_op_id, pg_catalog.jsonb_build_object('row_version', v_t.row_version, 'status', v_t.status,
             'subtree', pg_catalog.jsonb_build_object('n', v_sn, 'sum', v_ss)));
  end if;
  with recursive sub as (
    select id from app.personal_tasks where id = p_id and user_id = v_uid
    union all
    select c.id from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid)
  update app.personal_tasks t set deleted_at = now() from sub where t.id = sub.id and t.deleted_at is null;
  get diagnostics v_n = row_count;
  perform app_private.emit_personal_event(v_uid, 'ptask.deleted', p_id, jsonb_build_object('rows', v_n), p_op_id);
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'rows', v_n, 'rv_before', v_t.row_version, 'rv', v_t.row_version + 1));
  return app_private.finish_op(p_op_id, v_res);
end $$;

grant execute on function app_api.complete_personal_task_checked(uuid, uuid, jsonb),
  app_api.reopen_personal_task_checked(uuid, uuid, jsonb), app_api.delete_personal_task_checked(uuid, uuid, jsonb) to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0022_deleted_parent_guard.sql ===

-- LOCAL ONLY proposal. Do not allow a queued child to attach beneath a deleted parent.
create or replace function app_private.personal_tasks_before()
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
      if v_parent.id is null or v_parent.deleted_at is not null then perform app_private.raise_tf('not_found', 'parent'); end if;
      if v_parent.depth >= 2 then perform app_private.raise_tf('validation', 'maximum depth is 3 levels'); end if;
      new.depth := v_parent.depth + 1; new.root_id := v_parent.root_id;
    end if;
  end if;
  return new;
end $$;

select app_private.finalize_ownership();

-- === FILE: 0023_mutation_safety_capability.sql ===

-- LOCAL ONLY proposal. Capability prevents a new client trusting older unsafe delete semantics.
create or replace function app_api.sync_status(p_stream text, p_after_xid xid8 default '0'::xid8)
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare v_floor xid8;
begin
  if p_stream not in ('personal_tasks', 'personal_notes', 'org_units') then
    raise exception 'unknown stream' using errcode = 'TF004', detail = '{"code":"validation","message":"unknown stream"}';
  end if;
  select f.floor_xid into v_floor from app.sync_floor f where f.stream = p_stream;
  v_floor := coalesce(v_floor, '0'::xid8);
  return pg_catalog.jsonb_build_object('ok', true, 'data', pg_catalog.jsonb_build_object(
    'floor_xid', v_floor::text, 'mutation_safety_version', 2,
    'full_resync_required', (p_after_xid::text::numeric > 0 and p_after_xid::text::numeric < v_floor::text::numeric)),
    'server_time', pg_catalog.now());
end $$;
grant execute on function app_api.sync_status(text, xid8) to authenticated;
select app_private.finalize_ownership();

-- === FILE: 0024_personal_lock_order.sql ===

-- LOCAL ONLY: fixes reproduced coarse table/receipt/row lock-order deadlocks.
create or replace function app_private.begin_op(p_op uuid, p_rpc text, p_args jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := app_private.require_uid();
  v_time timestamptz;
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_args::text, 'UTF8')), 'hex');
  v_rec app.op_receipts;
begin
  -- Global local-proposal lock order: serialize personal RPCs before receipt/row/table locks.
  -- Correctness-first; replace only with a proved finer-grained protocol.
  if p_rpc like '%personal%' then perform pg_catalog.pg_advisory_xact_lock(7412093, 1); end if;
  if p_op is null then perform app_private.raise_tf('validation', 'op_id required'); end if;
  v_time := app_private.op_id_time(p_op);
  if v_time < now() - interval '90 days' then
    perform app_private.raise_tf('op_expired', 'operation id is older than the receipt retention');
  end if;
  if v_time > now() + interval '1 day' then
    perform app_private.raise_tf('validation', 'op_id timestamp is in the future');
  end if;
  -- A concurrent retry blocks here on the unique key until the first transaction ends.
  insert into app.op_receipts (user_id, op_id, rpc, args_hash)
  values (v_user, p_op, p_rpc, v_hash)
  on conflict (user_id, op_id) do nothing;
  select * into v_rec from app.op_receipts where user_id = v_user and op_id = p_op;
  if v_rec.rpc <> p_rpc or v_rec.args_hash <> v_hash then
    perform app_private.raise_tf('op_id_reuse', 'op_id was used with a different call');
  end if;
  return v_rec.result;   -- null for a fresh op: caller proceeds; non-null: replay stored result
end $$;


select app_private.finalize_ownership();

-- === FILE: 0025_sync_pull_numeric_cursor.sql ===

-- LOCAL ONLY: PostgreSQL ORDER BY output aliases made change_xid::text sort lexically.
-- Keep the invoker/RLS contract and order the underlying xid8 explicitly.
create or replace function app_api.sync_pull(p_stream text, p_after_xid xid8 default '0'::xid8,
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
           (select q.change_xid::text from page q order by q.change_xid desc, q.id_text desc limit 1),
           (select q.id_text from page q order by q.change_xid desc, q.id_text desc limit 1)
    from page p$q$, p_stream);
  execute v_sql into v_rows, v_next_xid, v_next_id using p_after_xid, p_after_id, v_horizon, p_limit;
  return jsonb_build_object('rows', v_rows, 'horizon', v_horizon::text,
                            'next_xid', v_next_xid, 'next_id', v_next_id);
end $$;

-- === FILE: authorization.sql ===

-- LOCAL DISPOSABLE ONLY. Executed in Docker-free real-Auth tests, never hosted.
-- Target: disposable baseline 0001-0013 + 0016-0024 + reviewed baseline my_membership.
-- Never apply against held0014 identity layout or production. Transactional DDL.
-- Requires real Auth columns auth.users.banned_until/deleted_at and auth.sessions(id,user_id).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='profiles' AND column_name='auth_user_id') THEN
    RAISE EXCEPTION 'Held lifecycle identity layout detected; this proposal is not for that layout';
  END IF;
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'Real Auth sessions schema required; shim is not sufficient';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_rpc' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe app_rpc role attributes';
  END IF;
END $$;

-- No public/global suspension API is introduced. An approved operator controls this table.
-- No row means no extra global suspension. Original membership suspension stays org-scoped.
CREATE TABLE app.account_access_guard (
  user_id uuid PRIMARY KEY REFERENCES app.profiles(id) ON DELETE RESTRICT,
  suspended boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.account_access_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_access_guard FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.account_access_guard FROM PUBLIC, anon, authenticated, app_rpc;
GRANT SELECT ON app.account_access_guard TO app_rpc;
CREATE POLICY account_access_guard_rpc_read ON app.account_access_guard
  FOR SELECT TO app_rpc USING (true);

-- Least-privilege reads, no mutation of the Auth-owned schema.
GRANT SELECT (banned_until,deleted_at) ON auth.users TO app_rpc;
GRANT SELECT (id,user_id,not_after) ON auth.sessions TO app_rpc;
-- Pinned real Auth enables RLS with no app_rpc policy; column grants alone return no rows.
-- Local-only explicit read policies, no writes/owner changes/BYPASSRLS.
CREATE POLICY taskflow_auth_guard_users_read ON auth.users FOR SELECT TO app_rpc USING (true);
CREATE POLICY taskflow_auth_guard_sessions_read ON auth.sessions FOR SELECT TO app_rpc USING (true);

CREATE OR REPLACE FUNCTION app_private.uid()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.id
  FROM app.profiles p
  JOIN auth.users u ON u.id=p.id
  WHERE p.id=auth.uid()
    AND p.deleted_at IS NULL
    AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until <= statement_timestamp())
    AND NOT EXISTS (SELECT 1 FROM app.account_access_guard g WHERE g.user_id=p.id AND g.suspended)
    AND EXISTS (
      SELECT 1 FROM auth.sessions s
      WHERE s.user_id=p.id
        AND (s.not_after IS NULL OR s.not_after > statement_timestamp())
        AND s.id::text = (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'session_id')
    )
$$;
ALTER FUNCTION app_private.uid() OWNER TO app_rpc;
REVOKE ALL ON FUNCTION app_private.uid() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.uid() TO app_rpc, authenticated;

CREATE OR REPLACE FUNCTION app_private.require_uid()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v uuid := app_private.uid();
BEGIN
  IF v IS NULL THEN PERFORM app_private.raise_tf('unauthenticated'); END IF;
  RETURN v;
END $$;
ALTER FUNCTION app_private.require_uid() OWNER TO app_rpc;
REVOKE ALL ON FUNCTION app_private.require_uid() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.require_uid() TO app_rpc;

CREATE OR REPLACE FUNCTION app_private.my_membership_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT m.id FROM app.memberships m WHERE m.user_id=app_private.uid() AND m.status='active' $$;
CREATE OR REPLACE FUNCTION app_private.is_active_member(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=app_private.uid() AND m.org_id=p_org AND m.status='active') $$;
CREATE OR REPLACE FUNCTION app_private.me_is_admin_of(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=app_private.uid() AND m.org_id=p_org AND m.role='admin' AND m.status='active') $$;
CREATE OR REPLACE FUNCTION app_private.me_can_see_profile(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT p_user=app_private.uid() OR EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=p_user AND app_private.has_authority_over_membership(app_private.my_membership_id(),m.id)) $$;
CREATE OR REPLACE FUNCTION app_private.require_verified_email()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=app_private.require_uid() AND u.email_confirmed_at IS NOT NULL) THEN
    PERFORM app_private.raise_tf('forbidden','verified email required');
  END IF;
END $$;

-- Existing ownership and grants survive CREATE OR REPLACE for these five helpers.
-- Grant no new RPCs and do not use finalize_ownership to mask unknown new objects.
ALTER POLICY memberships_select ON app.memberships USING (
  user_id=app_private.uid() OR (app_private.is_active_member(org_id) AND app_private.me_has_authority_over_membership(id))
);
ALTER POLICY personal_tasks_owner ON app.personal_tasks USING (user_id=app_private.uid());
ALTER POLICY personal_task_dependencies_owner ON app.personal_task_dependencies USING (user_id=app_private.uid());
ALTER POLICY personal_recurrence_rules_owner ON app.personal_recurrence_rules USING (user_id=app_private.uid());
ALTER POLICY personal_attachments_owner ON app.personal_attachments USING (user_id=app_private.uid());
ALTER POLICY personal_notes_owner ON app.personal_notes USING (user_id=app_private.uid());
ALTER POLICY personal_events_owner ON app.personal_events USING (user_id=app_private.uid());

-- Every PostgREST request validates current access before RPC dispatch or receipt lookup.
CREATE FUNCTION app_private.authorize_request()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM app_private.require_uid(); END $$;
ALTER FUNCTION app_private.authorize_request() OWNER TO app_rpc;
REVOKE ALL ON FUNCTION app_private.authorize_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.authorize_request() TO authenticated;

-- No Auth deletion hooks. No lifecycle/cleanup triggers. No policy disabling.
-- Scope: local disposable development only; not a hosted migration.
COMMIT;
