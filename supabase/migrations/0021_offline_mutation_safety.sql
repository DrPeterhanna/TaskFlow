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
