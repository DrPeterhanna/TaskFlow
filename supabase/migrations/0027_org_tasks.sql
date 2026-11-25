-- 0027: Organization & Team Tasks with hierarchical authority and RPCs

create table app.org_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id) on delete cascade,
  unit_id uuid not null,
  assignee_membership_id uuid,
  created_by_membership_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  notes text check (notes is null or char_length(notes) <= 5000),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  status text not null default 'todo' check (status in ('todo', 'in_progress', 'done', 'canceled')),
  due_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  foreign key (unit_id, org_id) references app.org_units (id, org_id),
  foreign key (assignee_membership_id, org_id) references app.memberships (id, org_id),
  foreign key (created_by_membership_id, org_id) references app.memberships (id, org_id)
);

create index org_tasks_org_idx on app.org_tasks (org_id, deleted_at, created_at desc);
create index org_tasks_assignee_idx on app.org_tasks (assignee_membership_id, status) where deleted_at is null;
create trigger org_tasks_touch before insert or update on app.org_tasks
  for each row execute function app_private.touch_row();

alter table app.org_tasks enable row level security;
alter table app.org_tasks force row level security;
grant select, insert, update, delete on app.org_tasks to app_rpc;
create policy org_tasks_rpc on app.org_tasks to app_rpc using (true) with check (true);

create or replace function app_api.list_org_tasks()
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_me app.memberships;
  v_rows jsonb;
begin
  select * into v_me from app.memberships where user_id = v_uid and status = 'active';
  if v_me.id is null then
    return pg_catalog.jsonb_build_object('ok', true, 'data', '[]'::jsonb);
  end if;

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', t.id,
    'unit_id', t.unit_id,
    'unit_name', u.name,
    'assignee_membership_id', t.assignee_membership_id,
    'assignee_name', ap.display_name,
    'created_by_membership_id', t.created_by_membership_id,
    'creator_name', cp.display_name,
    'title', t.title,
    'notes', t.notes,
    'priority', t.priority,
    'status', t.status,
    'due_date', t.due_date,
    'created_at', t.created_at,
    'is_mine', t.assignee_membership_id = v_me.id
  ) order by
    case t.status when 'in_progress' then 0 when 'todo' then 1 when 'done' then 2 else 3 end,
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from app.org_tasks t
  join app.org_units u on u.id = t.unit_id
  join app.memberships cm on cm.id = t.created_by_membership_id
  join app.profiles cp on cp.id = cm.user_id
  left join app.memberships am on am.id = t.assignee_membership_id
  left join app.profiles ap on ap.id = am.user_id
  where t.org_id = v_me.org_id
    and t.deleted_at is null
    and (
      v_me.role = 'admin'
      or t.assignee_membership_id = v_me.id
      or t.created_by_membership_id = v_me.id
      or app_private.unit_in_scope(v_me.id, t.unit_id)
    );

  return pg_catalog.jsonb_build_object('ok', true, 'data', v_rows);
end $$;

create or replace function app_api.create_org_task(
  p_op_id uuid,
  p_title text,
  p_unit_id uuid,
  p_assignee_membership_id uuid default null,
  p_priority text default 'normal',
  p_due_date date default null,
  p_notes text default null
)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_me app.memberships;
  v_target app.memberships;
  v_id uuid;
begin
  select * into v_me from app.memberships where user_id = v_uid and status = 'active';
  if v_me.id is null then
    perform app_private.raise_tf('forbidden', 'active membership required');
  end if;

  if not app_private.unit_in_scope(v_me.id, p_unit_id) then
    perform app_private.raise_tf('forbidden', 'unit out of scope');
  end if;

  if p_assignee_membership_id is not null then
    select * into v_target from app.memberships
    where id = p_assignee_membership_id and org_id = v_me.org_id and status = 'active';
    if v_target.id is null then
      perform app_private.raise_tf('not_found', 'assignee');
    end if;
    if v_target.id <> v_me.id and not app_private.has_authority_over_membership(v_me.id, v_target.id) then
      perform app_private.raise_tf('forbidden', 'cannot assign to this member');
    end if;
  end if;

  insert into app.org_tasks (
    org_id, unit_id, assignee_membership_id, created_by_membership_id,
    title, notes, priority, due_date
  ) values (
    v_me.org_id, p_unit_id, coalesce(p_assignee_membership_id, v_me.id), v_me.id,
    btrim(p_title), nullif(btrim(coalesce(p_notes, '')), ''), coalesce(p_priority, 'normal'), p_due_date
  )
  returning id into v_id;

  return pg_catalog.jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function app_api.set_org_task_status(
  p_op_id uuid,
  p_task_id uuid,
  p_status text
)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_me app.memberships;
  v_task app.org_tasks;
begin
  select * into v_me from app.memberships where user_id = v_uid and status = 'active';
  if v_me.id is null then
    perform app_private.raise_tf('forbidden', 'active membership required');
  end if;

  select * into v_task from app.org_tasks
  where id = p_task_id and org_id = v_me.org_id and deleted_at is null;
  if v_task.id is null then
    perform app_private.raise_tf('not_found', 'task');
  end if;

  if not (
    v_me.role = 'admin'
    or v_task.assignee_membership_id = v_me.id
    or v_task.created_by_membership_id = v_me.id
    or app_private.unit_in_scope(v_me.id, v_task.unit_id)
  ) then
    perform app_private.raise_tf('forbidden', 'not allowed');
  end if;

  update app.org_tasks
  set status = p_status,
      completed_at = case when p_status = 'done' then coalesce(completed_at, now()) else null end
  where id = v_task.id;

  return pg_catalog.jsonb_build_object('ok', true);
end $$;

create or replace function app_api.delete_org_task(
  p_op_id uuid,
  p_task_id uuid
)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_me app.memberships;
  v_task app.org_tasks;
begin
  select * into v_me from app.memberships where user_id = v_uid and status = 'active';
  if v_me.id is null then
    perform app_private.raise_tf('forbidden', 'active membership required');
  end if;

  select * into v_task from app.org_tasks
  where id = p_task_id and org_id = v_me.org_id and deleted_at is null;
  if v_task.id is null then
    perform app_private.raise_tf('not_found', 'task');
  end if;

  if not (
    v_me.role = 'admin'
    or v_task.created_by_membership_id = v_me.id
    or app_private.unit_in_scope(v_me.id, v_task.unit_id)
  ) then
    perform app_private.raise_tf('forbidden', 'not allowed');
  end if;

  update app.org_tasks set deleted_at = now() where id = v_task.id;
  return pg_catalog.jsonb_build_object('ok', true);
end $$;

select app_private.finalize_ownership();
grant execute on function
  app_api.list_org_tasks(),
  app_api.create_org_task(uuid, text, uuid, uuid, text, date, text),
  app_api.set_org_task_status(uuid, uuid, text),
  app_api.delete_org_task(uuid, uuid)
to authenticated, service_role;
