-- 0020: conditional complete / reopen / delete for personal tasks. Same rules as 0013/0018, plus a REQUIRED base describing what
-- the device last saw. Under the row lock, if the task changed in a way that makes the device's intent unsafe, the server REFUSES
-- before changing anything and stores the refusal as the op's terminal result (receipt): the same op_id can never commit later,
-- even if values change back. Only a fresh op_id with a fresh base (explicit user resolution) can apply it.
--   complete / reopen: base {"status": <status the device saw>}. Refused when the current status differs from the base AND is not
--     already the target (completing a task that is already done, or reopening one already todo, is an idempotent success; nothing is changed or re-emitted).
--   delete: base {"rows": {task_id: row_version the device saw, for the task and every live subtask}, "own_ops": [op ids of the device's
--     own earlier operations on those tasks]}. Refused when any live row of the subtree was changed by someone else (edit, new subtask,
--     restore, move in), so a remote change is never deleted unseen. Already deleted: idempotent success.
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
declare
  v_uid uuid := app_private.require_uid(); v_prev jsonb; v_t app.personal_tasks; v_res jsonb; v_n int;
  v_own uuid[]; v_changed jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'delete_personal_task_checked', jsonb_build_object('i', p_id, 'b', p_base));
  if v_prev is not null then return v_prev; end if;
  if p_base is null or jsonb_typeof(p_base) <> 'object' or jsonb_typeof(p_base -> 'rows') is distinct from 'object' then
    perform app_private.raise_tf('validation', 'base with rows is required');
  end if;
  select * into v_t from app.personal_tasks where id = p_id and user_id = v_uid for update;
  if v_t.id is null then perform app_private.raise_tf('not_found', 'task'); end if;
  if v_t.deleted_at is not null then
    return app_private.finish_op(p_op_id, app_private.ok(jsonb_build_object('id', p_id, 'rows', 0, 'already', true)));
  end if;
  -- The device saw each LIVE row of this subtree at some row_version (base.rows, missing = never on the server, 0). Its own earlier
  -- operations (base.own_ops) legitimately bump versions; each of them emitted exactly one event for the row. Anything else, i.e.
  -- an edit, a new subtask, a restore or a move into the subtree made by someone else, makes (version - own bumps) differ from
  -- what the device saw, and the delete is refused before anything changes. Rows already deleted are ignored: deleting them again loses nothing.
  select coalesce(array_agg(x::uuid), '{}'::uuid[]) into v_own from pg_catalog.jsonb_array_elements_text(coalesce(p_base -> 'own_ops', '[]'::jsonb)) x;
  with recursive sub as (
    select id, row_version from app.personal_tasks where id = p_id and user_id = v_uid and deleted_at is null
    union all
    select c.id, c.row_version from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid and c.deleted_at is null),
  chk as (
    select s.id, s.row_version,
           (select count(*) from app.personal_events e where e.user_id = v_uid and e.subject_id = s.id and e.request_op_id = any (v_own)) as own_bumps,
           coalesce((p_base -> 'rows' ->> s.id::text)::bigint, 0) as seen
    from sub s)
  select coalesce(jsonb_object_agg(id::text, row_version), '{}'::jsonb) into v_changed from chk where row_version - own_bumps <> seen;
  if v_changed <> '{}'::jsonb then
    return app_private.refuse_stale(p_op_id, pg_catalog.jsonb_build_object('row_version', v_t.row_version, 'status', v_t.status, 'changed', v_changed));
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
