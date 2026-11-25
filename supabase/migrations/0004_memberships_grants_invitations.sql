-- 0004: memberships, delegated grants, invitations, last-admin protection.
create table app.memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  user_id uuid not null references app.profiles (id),
  role app.app_role not null,
  unit_id uuid not null,
  status app.member_status not null default 'active',
  capacity_hours numeric(4, 1) check (capacity_hours is null or capacity_hours between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  unique (id, org_id),
  unique (org_id, user_id),
  unique (user_id),   -- [DEFAULT] single organization per user
  foreign key (unit_id, org_id) references app.org_units (id, org_id)
);
create index memberships_unit_idx on app.memberships (unit_id);
create index memberships_change_idx on app.memberships (change_xid, id);
create trigger memberships_touch before insert or update on app.memberships
  for each row execute function app_private.touch_row();

alter table app.org_units
  add constraint org_units_leader_fk foreign key (leader_membership_id, org_id)
  references app.memberships (id, org_id);

create table app.permission_grants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  membership_id uuid not null,
  permission app.permission_kind not null,
  scope_unit_id uuid not null,
  expires_at timestamptz not null,
  granted_by uuid not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  foreign key (membership_id, org_id) references app.memberships (id, org_id),
  foreign key (granted_by, org_id) references app.memberships (id, org_id),
  foreign key (scope_unit_id, org_id) references app.org_units (id, org_id)
);
create index permission_grants_member_idx on app.permission_grants (membership_id);
create trigger permission_grants_touch before insert or update on app.permission_grants
  for each row execute function app_private.touch_row();

create table app.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references app.organizations (id),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  role app.app_role not null check (role <> 'admin'),
  unit_id uuid not null,
  max_uses int not null default 1 check (max_uses between 1 and 1000),
  uses int not null default 0,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  row_version bigint not null default 1,
  change_xid xid8 not null default pg_current_xact_id(),
  deleted_at timestamptz,
  check (uses between 0 and max_uses),
  foreign key (unit_id, org_id) references app.org_units (id, org_id),
  foreign key (created_by, org_id) references app.memberships (id, org_id)
);
create trigger invitations_touch before insert or update on app.invitations
  for each row execute function app_private.touch_row();

-- Failed-redemption counter for the 5 tries per hour limit (SECURITY_ARCHITECTURE s7).
create table app.invitation_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null references app.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now()
);
create index invitation_attempts_user_idx on app.invitation_attempts (user_id, attempted_at);

-- Role / unit / status can never be set to inconsistent shapes by a back door:
-- the admin membership of the org stays placed in a valid unit, and the last active
-- admin cannot be removed or demoted. The BEFORE trigger serializes admin changes per
-- org so two concurrent demotions cannot both pass the deferred check.
create function app_private.memberships_admin_lock()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.role = 'admin' and old.status = 'active' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || old.org_id::text, 0));
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.user_id <> old.user_id then
      perform app_private.raise_tf('validation', 'org_id and user_id are immutable');
    end if;
    if old.role = 'admin' and old.status = 'active' then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || old.org_id::text, 0));
    end if;
  end if;
  return new;
end $$;
create trigger memberships_admin_lock before insert or update or delete on app.memberships
  for each row execute function app_private.memberships_admin_lock();

create function app_private.memberships_last_admin_check()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_org uuid := coalesce(old.org_id, new.org_id);
begin
  if (tg_op = 'DELETE' or old.role is distinct from new.role or old.status is distinct from new.status)
     and old.role = 'admin' and old.status = 'active' then
    if not exists (select 1 from app.memberships
                   where org_id = v_org and role = 'admin' and status = 'active') then
      perform app_private.raise_tf('validation', 'an organization must keep at least one active admin');
    end if;
  end if;
  return null;
end $$;
create constraint trigger memberships_last_admin after update or delete on app.memberships
  deferrable initially deferred for each row
  execute function app_private.memberships_last_admin_check();

do $$
declare t text;
begin
  foreach t in array array['memberships','permission_grants','invitations','invitation_attempts'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('grant select, insert, update, delete on app.%I to app_rpc', t);
    execute format('create policy %I on app.%I to app_rpc using (true) with check (true)', t || '_rpc', t);
  end loop;
end $$;
grant usage on all sequences in schema app to app_rpc;

select app_private.finalize_ownership();
