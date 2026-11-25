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
