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
