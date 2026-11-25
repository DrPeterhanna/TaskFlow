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
