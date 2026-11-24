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
