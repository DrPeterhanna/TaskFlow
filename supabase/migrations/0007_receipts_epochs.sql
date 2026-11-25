-- 0007: idempotency receipts and access epochs (OFFLINE_SYNC_ARCHITECTURE sections 3 and 8).

-- ---- idempotency receipts ----------------------------------------------------------
create table app.op_receipts (
  user_id uuid not null references app.profiles (id) on delete cascade,
  op_id uuid not null,
  rpc text not null,
  args_hash text not null,
  result jsonb,                       -- null only while the owning transaction is open
  created_at timestamptz not null default now(),
  primary key (user_id, op_id)
);

-- op ids are v7-style: the first 48 bits are a millisecond timestamp. An op id older than
-- the receipt retention (90 days [DEFAULT]) is classified op_expired BEFORE any receipt
-- lookup, so a purged receipt can never lead to an old mutation being replayed.
create function app_private.op_id_time(p_op uuid)
returns timestamptz language plpgsql immutable
set search_path = ''
as $$
declare h text := replace(p_op::text, '-', '');
begin
  if substr(h, 13, 1) <> '7' then
    perform app_private.raise_tf('validation', 'op_id must be a v7 uuid');
  end if;
  return pg_catalog.to_timestamp(('x' || '0000' || substr(h, 1, 12))::bit(64)::bigint / 1000.0);
end $$;

create function app_private.begin_op(p_op uuid, p_rpc text, p_args jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := app_private.require_uid();
  v_time timestamptz;
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_args::text, 'UTF8')), 'hex');
  v_rec app.op_receipts;
begin
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

create function app_private.finish_op(p_op uuid, p_result jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
begin
  update app.op_receipts set result = p_result
  where user_id = app_private.require_uid() and op_id = p_op;
  return p_result;
end $$;

-- ---- access epochs ----------------------------------------------------------------
-- Epoch values come from one sequence so they only ever increase. The epoch a client sees
-- is the max of its user epoch and the scope epochs of units in its authority subtree.
create sequence app_private.epoch_seq;

create table app.user_access_state (
  user_id uuid primary key references app.profiles (id) on delete cascade,
  epoch bigint not null
);
create table app.scope_epochs (
  unit_id uuid primary key references app.org_units (id),
  epoch bigint not null
);

create function app_private.bump_user_epoch(p_user uuid)
returns void language sql
set search_path = ''
as $$
  insert into app.user_access_state (user_id, epoch)
  values (p_user, pg_catalog.nextval('app_private.epoch_seq'))
  on conflict (user_id) do update set epoch = excluded.epoch
$$;

-- bump the unit, its descendants and its ancestors
create function app_private.bump_unit_chain(p_unit uuid)
returns void language sql
set search_path = ''
as $$
  with e as (select pg_catalog.nextval('app_private.epoch_seq') as v)
  insert into app.scope_epochs (unit_id, epoch)
  select x.id, e.v from e,
    (select ancestor_id as id from app.unit_closure where descendant_id = p_unit
     union
     select descendant_id from app.unit_closure where ancestor_id = p_unit) x
  on conflict (unit_id) do update set epoch = excluded.epoch
$$;

create function app_private.epoch_on_membership()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform app_private.bump_user_epoch(old.user_id);
    perform app_private.bump_unit_chain(old.unit_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform app_private.bump_user_epoch(new.user_id);
    perform app_private.bump_unit_chain(new.unit_id);
  end if;
  return null;
end $$;
create trigger memberships_epoch after insert or update or delete on app.memberships
  for each row execute function app_private.epoch_on_membership();

create function app_private.epoch_on_grant()
returns trigger language plpgsql
set search_path = ''
as $$
declare v_user uuid;
begin
  select user_id into v_user from app.memberships where id = new.membership_id;
  perform app_private.bump_user_epoch(v_user);
  perform app_private.bump_unit_chain(new.scope_unit_id);
  return null;
end $$;
create trigger grants_epoch after insert or update on app.permission_grants
  for each row execute function app_private.epoch_on_grant();

-- Unit moves: the old chain must be read BEFORE closure is rewritten. The closure trigger
-- runs AFTER, so capture old ancestors in a BEFORE trigger of the same statement.
create function app_private.epoch_units_before()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if new.parent_id is distinct from old.parent_id then
    perform app_private.bump_unit_chain(old.id);   -- old ancestors and the subtree
  end if;
  return new;
end $$;
create trigger org_units_epoch_before before update on app.org_units
  for each row execute function app_private.epoch_units_before();

create function app_private.epoch_units_after()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id then
    perform app_private.bump_unit_chain(new.id);   -- new ancestors and the subtree
  end if;
  return null;
end $$;
-- fires after org_units_after (alphabetical trigger order: org_units_after < org_units_epoch_after)
create trigger org_units_epoch_after after insert or update on app.org_units
  for each row execute function app_private.epoch_units_after();

create function app_api.current_epoch()
returns bigint language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_user uuid := app_private.require_uid();
  v_m app.memberships;
  v_epoch bigint;
begin
  select coalesce(max(epoch), 0) into v_epoch from app.user_access_state where user_id = v_user;
  select * into v_m from app.memberships where user_id = v_user and status = 'active';
  if v_m.id is not null then
    select greatest(v_epoch, coalesce(max(s.epoch), 0)) into v_epoch
    from app.scope_epochs s
    where (v_m.role = 'admin' and s.unit_id in (select id from app.org_units where org_id = v_m.org_id))
       or s.unit_id in (select descendant_id from app.unit_closure where ancestor_id = v_m.unit_id);
  end if;
  return v_epoch;
end $$;

do $$
declare t text;
begin
  foreach t in array array['op_receipts','user_access_state','scope_epochs'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('grant select, insert, update, delete on app.%I to app_rpc', t);
    execute format('create policy %I on app.%I to app_rpc using (true) with check (true)', t || '_rpc', t);
  end loop;
end $$;
grant usage on sequence app_private.epoch_seq to app_rpc;

select app_private.finalize_ownership();
grant execute on function app_api.current_epoch() to authenticated;
