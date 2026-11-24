-- 0014: account lifecycle. Found by hosted-readiness review: memberships/organizations reference profiles with
-- no cascade (org-owned data is RESTRICT), so deleting an Auth user who ever belonged to an org was blocked.
-- Policy implemented (matches DATABASE_DESIGN: CASCADE only for personal data on account deletion):
--   * deleting an Auth user erases that user's personal data, anonymises the profile, removes memberships
--     (history kept), and keeps org-owned records and the append-only audit chain;
--   * the last active admin of a live organization cannot be deleted/leave: transfer admin or close the org first;
--   * a deleted account loses all data access at once, even with an unexpired JWT (uid() returns null).
-- Seed constraint for closure: close_organization needs the org to have no work and no other active member.

-- 1. Identity split WITHOUT dropping a referential guarantee: profiles.id becomes the persistent person id (equal to the
--    Auth id at creation, so every existing reference is unchanged); the live link to Auth is profiles.auth_user_id, a real
--    foreign key to auth.users that is set to NULL when the Auth user is deleted. Org-owned rows keep referencing profiles.id.
alter table app.profiles add column auth_user_id uuid;
update app.profiles set auth_user_id = id;
alter table app.profiles drop constraint profiles_id_fkey;
alter table app.profiles add constraint profiles_auth_user_fkey
  foreign key (auth_user_id) references auth.users (id) on delete set null;
alter table app.profiles add constraint profiles_auth_user_uq unique (auth_user_id);

create or replace function app_private.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.profiles (id, auth_user_id, display_name)
  values (new.id, new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', ''), 100))
  on conflict (id) do nothing;
  return new;
end $$;

-- 2. a deleted (anonymised) profile has no identity: uid()/require_uid() stop honouring leftover JWTs
create or replace function app_private.uid()
returns uuid language sql stable security definer
set search_path = ''
as $$
  select p.id from app.profiles p where p.auth_user_id = auth.uid() and p.deleted_at is null
$$;

create or replace function app_private.require_uid()
returns uuid language plpgsql stable security definer
set search_path = ''
as $$
declare v uuid;
begin
  select p.id into v from app.profiles p where p.auth_user_id = auth.uid() and p.deleted_at is null;
  if v is null then perform app_private.raise_tf('unauthenticated'); end if;
  return v;
end $$;

-- 2b. every policy and helper must resolve identity through app_private.uid() (deleted accounts resolve to NULL).
-- Rewrites existing definitions mechanically; tests lint that auth.uid() appears only inside uid()/require_uid().
do $$
declare r record; v_def text;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('app_private', 'app_api') and p.proname not in ('uid', 'require_uid')
      and p.prosrc like '%auth.uid()%'
  loop
    v_def := replace(pg_catalog.pg_get_functiondef(r.sig), 'auth.uid()', 'app_private.uid()');
    execute v_def;
  end loop;
  for r in
    select pol.polname, pol.polrelid::regclass as tbl,
           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) as q, pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) as w
    from pg_catalog.pg_policy pol join pg_catalog.pg_class c on c.oid = pol.polrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app' and (pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) like '%auth.uid()%'
                                 or pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) like '%auth.uid()%')
  loop
    execute pg_catalog.format('alter policy %I on %s %s %s', r.polname, r.tbl,
      case when r.q is not null then 'using (' || replace(r.q, 'auth.uid()', 'app_private.uid()') || ')' else '' end,
      case when r.w is not null then 'with check (' || replace(r.w, 'auth.uid()', 'app_private.uid()') || ')' else '' end);
  end loop;
end $$;

grant execute on function app_private.uid() to authenticated;   -- policies call it as the invoking role

-- 3. last-admin check ignores closed organizations
create or replace function app_private.memberships_last_admin_check()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_org uuid := coalesce(old.org_id, new.org_id);
begin
  if (tg_op = 'DELETE' or old.role is distinct from new.role or old.status is distinct from new.status)
     and old.role = 'admin' and old.status = 'active'
     and not exists (select 1 from app.organizations o where o.id = v_org and o.deleted_at is not null) then
    if not exists (select 1 from app.memberships
                   where org_id = v_org and role = 'admin' and status = 'active') then
      perform app_private.raise_tf('validation', 'an organization must keep at least one active admin');
    end if;
  end if;
  return null;
end $$;

-- 4. extension point for Phase 4+: any org-owned work (tasks...) must make this return true
create function app_private.org_has_work(p_org uuid)
returns boolean language sql stable
set search_path = ''
as $$ select false $$;

-- 5. shared removal step (one membership)
create function app_private.remove_membership(p_membership uuid, p_actor uuid, p_op uuid, p_payload jsonb)
returns void language plpgsql
set search_path = ''
as $$
declare v_m app.memberships;
begin
  select * into v_m from app.memberships where id = p_membership for update;
  if v_m.id is null or v_m.status = 'removed' then return; end if;
  update app.permission_grants set revoked_at = pg_catalog.now()
  where membership_id = p_membership and revoked_at is null;
  update app.org_units set leader_membership_id = null where leader_membership_id = p_membership;
  update app.memberships set status = 'removed' where id = p_membership;
  perform app_private.emit_event(v_m.org_id, p_actor, 'member.removed', 'membership', p_membership,
    pg_catalog.jsonb_build_object('from', v_m.status, 'to', 'removed') || p_payload, p_op);
end $$;

-- guard shared by leave / delete-account: last active admin of a LIVE org may not go
create function app_private.assert_not_last_admin(p_membership uuid)
returns void language plpgsql
set search_path = ''
as $$
declare v_m app.memberships;
begin
  select * into v_m from app.memberships where id = p_membership;
  if v_m.id is null or v_m.role <> 'admin' or v_m.status <> 'active' then return; end if;
  if exists (select 1 from app.organizations o where o.id = v_m.org_id and o.deleted_at is not null) then return; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || v_m.org_id::text, 0));
  if not exists (select 1 from app.memberships
                 where org_id = v_m.org_id and role = 'admin' and status = 'active' and id <> p_membership) then
    perform app_private.raise_tf('validation', 'last admin: transfer the admin role or close the organization first');
  end if;
end $$;

-- 5b. personal audit rows are append-only EXCEPT for erasure of that user's own data during account deletion
create function app_private.personal_events_guard()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and pg_catalog.current_setting('app_private.erasing_user', true) = old.user_id::text then
    return old;
  end if;
  raise exception 'events are append-only' using errcode = '42501';
end $$;
drop trigger personal_events_no_update on app.personal_events;
create trigger personal_events_no_update before update or delete on app.personal_events
  for each row execute function app_private.personal_events_guard();
grant delete on app.personal_events to app_rpc;
create policy personal_events_rpc_d on app.personal_events for delete to app_rpc using (true);

-- 6. Auth user deletion hooks (dashboard, admin API or any supported path)
create function app_private.guard_user_deletion()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare r record;
begin
  for r in select m.id from app.memberships m join app.profiles p on p.id = m.user_id
           where p.auth_user_id = old.id and m.status <> 'removed' order by m.id loop
    perform app_private.assert_not_last_admin(r.id);
  end loop;
  return old;
end $$;
create trigger a_before_auth_user_deleted before delete on auth.users
  for each row execute function app_private.guard_user_deletion();

create function app_private.handle_user_deleted()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare r record; v_uid uuid;
begin
  select id into v_uid from app.profiles where auth_user_id = old.id;
  if v_uid is null then return old; end if;
  for r in select id from app.memberships where user_id = v_uid and status <> 'removed' order by id loop
    perform app_private.remove_membership(r.id, r.id, null, pg_catalog.jsonb_build_object('reason', 'account_deleted'));
  end loop;
  perform pg_catalog.set_config('app_private.erasing_user', v_uid::text, true);
  -- personal data: every table that cascades from profiles is erased (org-owned data is RESTRICT and never listed)
  for r in
    select c.conrelid::regclass as tbl, a.attname as col
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'app.profiles'::regclass and c.confdeltype = 'c' and pg_catalog.array_length(c.conkey, 1) = 1
    order by 1::text
  loop
    execute pg_catalog.format('delete from %s where %I = $1', r.tbl, r.col) using v_uid;
  end loop;
  perform pg_catalog.set_config('app_private.erasing_user', '', true);
  update app.profiles set display_name = '', avatar_path = null, timezone = null, reminder_time = null,
                          auth_user_id = null, deleted_at = coalesce(deleted_at, pg_catalog.now())
  where id = v_uid;
  return old;
end $$;
-- BEFORE (not AFTER): the ON DELETE SET NULL referential action would otherwise clear the link first; one transaction either way
create trigger b_on_auth_user_deleted before delete on auth.users
  for each row execute function app_private.handle_user_deleted();

-- 7. ordinary-user RPCs
create function app_api.leave_organization(p_op_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'leave_organization', '{}'::jsonb);
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  perform app_private.assert_not_last_admin(v_actor.id);
  perform app_private.remove_membership(v_actor.id, v_actor.id, p_op_id, pg_catalog.jsonb_build_object('self', true));
  v_res := app_private.ok(pg_catalog.jsonb_build_object('membership_id', v_actor.id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- Closes (soft-deletes) an organization that has no work and no other active member. Admin only. Audit kept.
create function app_api.close_organization(p_op_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_res jsonb; v_org uuid;
begin
  v_prev := app_private.begin_op(p_op_id, 'close_organization', '{}'::jsonb);
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
  v_org := v_actor.org_id;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || v_org::text, 0));
  if exists (select 1 from app.organizations where id = v_org and deleted_at is not null) then
    perform app_private.raise_tf('validation', 'organization already closed');
  end if;
  if exists (select 1 from app.memberships where org_id = v_org and id <> v_actor.id and status <> 'removed') then
    perform app_private.raise_tf('validation', 'remove or transfer all other members first');
  end if;
  if app_private.org_has_work(v_org) then
    perform app_private.raise_tf('validation', 'organization has work; it cannot be closed');
  end if;
  update app.invitations set revoked_at = pg_catalog.now() where org_id = v_org and revoked_at is null;
  perform app_private.emit_event(v_org, v_actor.id, 'org.closed', 'organization', v_org, '{}'::jsonb, p_op_id);
  update app.organizations set deleted_at = pg_catalog.now() where id = v_org;
  perform app_private.remove_membership(v_actor.id, v_actor.id, p_op_id, pg_catalog.jsonb_build_object('reason', 'org_closed'));
  v_res := app_private.ok(pg_catalog.jsonb_build_object('org_id', v_org));
  return app_private.finish_op(p_op_id, v_res);
end $$;

grant execute on function app_api.leave_organization(uuid), app_api.close_organization(uuid) to authenticated;
select app_private.finalize_ownership();
