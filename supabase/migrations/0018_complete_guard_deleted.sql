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
