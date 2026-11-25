

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
