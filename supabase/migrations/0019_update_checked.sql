-- 0019: conditional update. Same rules as update_personal_task (0013), plus p_base (REQUIRED): the values the client last saw
-- for the fields it edits. Under the row lock, if ANY of those fields currently holds a different value (and not already the
-- value being written) the server REFUSES with stale_conflict and changes nothing; the message carries the current values.
-- The client keeps the user's intent, shows the conflict, and only a fresh operation with a fresh base can apply it.
-- A refused op leaves no receipt, so a resend is evaluated again (the same answer while the values still differ).
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
    perform app_private.raise_tf('stale_conflict', v_over::text);
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
  v_res := app_private.ok(jsonb_build_object('id', p_id, 'overwritten', v_over));
  return app_private.finish_op(p_op_id, v_res);
end $$;
grant execute on function app_api.update_personal_task_checked(uuid, uuid, jsonb, jsonb) to authenticated;
select app_private.finalize_ownership();
