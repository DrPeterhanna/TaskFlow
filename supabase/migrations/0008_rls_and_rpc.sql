-- 0008: client read policies (RLS) and the Phase 2 RPC layer (app_api).
-- Clients have SELECT only, through RLS. Every write goes through an RPC below.

-- ---- extra read helpers ---------------------------------------------------------------
create function app_private.me_is_admin_of(p_org uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.user_id = auth.uid() and m.org_id = p_org
                   and m.role = 'admin' and m.status = 'active')
$$;

create function app_private.me_can_see_profile(p_user uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select p_user = auth.uid()
      or exists (select 1 from app.memberships m
                 where m.user_id = p_user
                   and app_private.has_authority_over_membership(app_private.my_membership_id(), m.id))
$$;

create function app_private.me_in_org_of_unit(p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.org_units u
                 where u.id = p_unit and app_private.is_active_member(u.org_id))
$$;

grant execute on function app_private.me_is_admin_of(uuid), app_private.me_can_see_profile(uuid),
  app_private.me_in_org_of_unit(uuid) to authenticated;

-- ---- policies -------------------------------------------------------------------------
create policy profiles_select on app.profiles for select to authenticated
  using (app_private.me_can_see_profile(id));
create policy organizations_select on app.organizations for select to authenticated
  using (app_private.is_active_member(id));
create policy org_units_select on app.org_units for select to authenticated
  using (app_private.is_active_member(org_id));
create policy unit_closure_select on app.unit_closure for select to authenticated
  using (app_private.me_in_org_of_unit(ancestor_id));
create policy memberships_select on app.memberships for select to authenticated
  using (user_id = auth.uid()
         or (app_private.is_active_member(org_id)
             and app_private.me_has_authority_over_membership(id)));
create policy grants_select on app.permission_grants for select to authenticated
  using (app_private.me_is_admin_of(org_id)
         or membership_id = app_private.my_membership_id());
create policy invitations_select on app.invitations for select to authenticated
  using (app_private.me_is_admin_of(org_id)
         or created_by = app_private.my_membership_id());
create policy events_select on app.events for select to authenticated
  using (app_private.me_is_admin_of(org_id)
         or (actor_membership_id is not null
             and actor_membership_id = app_private.my_membership_id()));

grant select on app.profiles, app.organizations, app.org_units, app.unit_closure,
  app.memberships, app.permission_grants, app.events to authenticated;
-- code_hash is never readable by clients
grant select (id, org_id, role, unit_id, max_uses, uses, expires_at, revoked_at, created_by,
              created_at, updated_at, row_version, change_xid, deleted_at)
  on app.invitations to authenticated;
-- op_receipts, user_access_state, scope_epochs, invitation_attempts: no client access.

-- ---- RPC helpers ----------------------------------------------------------------------
create function app_private.ok(p_data jsonb)
returns jsonb language sql stable
set search_path = ''
as $$ select jsonb_build_object('ok', true, 'data', p_data, 'server_time', now()) $$;

create function app_private.require_verified_email()
returns void language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from auth.users u
                 where u.id = auth.uid() and u.email_confirmed_at is not null) then
    perform app_private.raise_tf('forbidden', 'verified email required');
  end if;
end $$;

create function app_private.require_actor()
returns app.memberships language plpgsql stable
set search_path = ''
as $$
declare v app.memberships;
begin
  select * into v from app.memberships where user_id = app_private.require_uid() and status = 'active';
  if v.id is null then perform app_private.raise_tf('forbidden', 'active membership required'); end if;
  return v;
end $$;

-- ---- organizations ---------------------------------------------------------------------
create function app_api.create_organization(p_op_id uuid, p_name text, p_timezone text default 'Africa/Cairo')
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb;
  v_org uuid; v_unit uuid; v_mem uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_organization', jsonb_build_object('n', p_name, 'tz', p_timezone));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_verified_email();
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    perform app_private.raise_tf('validation', 'name must be 1 to 120 characters');
  end if;
  if p_timezone is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone) then
    perform app_private.raise_tf('validation', 'unknown timezone');
  end if;
  if exists (select 1 from app.memberships where user_id = v_uid) then
    perform app_private.raise_tf('validation', 'user already belongs to an organization');
  end if;
  insert into app.organizations (name, timezone, created_by) values (btrim(p_name), p_timezone, v_uid) returning id into v_org;
  insert into app.org_units (org_id, parent_id, name) values (v_org, null, btrim(p_name)) returning id into v_unit;
  insert into app.memberships (org_id, user_id, role, unit_id) values (v_org, v_uid, 'admin', v_unit) returning id into v_mem;
  perform app_private.emit_event(v_org, v_mem, 'org.created', 'organization', v_org, jsonb_build_object('name', btrim(p_name)), p_op_id);
  perform app_private.emit_event(v_org, v_mem, 'unit.created', 'unit', v_unit, jsonb_build_object('root', true), p_op_id);
  perform app_private.emit_event(v_org, v_mem, 'member.joined', 'membership', v_mem, jsonb_build_object('role', 'admin'), p_op_id);
  v_res := app_private.ok(jsonb_build_object('org_id', v_org, 'unit_id', v_unit, 'membership_id', v_mem));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- units -----------------------------------------------------------------------------
create function app_api.create_unit(p_op_id uuid, p_parent_id uuid, p_name text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_org uuid; v_unit uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_unit', jsonb_build_object('p', p_parent_id, 'n', p_name));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select org_id into v_org from app.org_units where id = p_parent_id;
  if v_org is null or v_org <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  perform app_private.lock_org_structure(v_org);
  if not (v_actor.role = 'admin' or app_private.has_grant(v_actor.id, 'manage_units', p_parent_id)) then
    perform app_private.raise_tf('forbidden');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    perform app_private.raise_tf('validation', 'name must be 1 to 120 characters');
  end if;
  insert into app.org_units (org_id, parent_id, name) values (v_org, p_parent_id, btrim(p_name)) returning id into v_unit;
  perform app_private.emit_event(v_org, v_actor.id, 'unit.created', 'unit', v_unit,
    jsonb_build_object('parent_id', p_parent_id, 'name', btrim(p_name)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('unit_id', v_unit));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.rename_unit(p_op_id uuid, p_unit_id uuid, p_name text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'rename_unit', jsonb_build_object('u', p_unit_id, 'n', p_name));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  if not (v_actor.role = 'admin' or app_private.has_grant(v_actor.id, 'manage_units', p_unit_id)) then
    perform app_private.raise_tf('forbidden');
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120 then
    perform app_private.raise_tf('validation', 'name must be 1 to 120 characters');
  end if;
  update app.org_units set name = btrim(p_name) where id = p_unit_id;
  perform app_private.emit_event(v_u.org_id, v_actor.id, 'unit.updated', 'unit', p_unit_id,
    jsonb_build_object('from', v_u.name, 'to', btrim(p_name)), p_op_id);
  v_res := app_private.ok(jsonb_build_object('unit_id', p_unit_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.move_unit(p_op_id uuid, p_unit_id uuid, p_new_parent_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_p app.org_units; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'move_unit', jsonb_build_object('u', p_unit_id, 'p', p_new_parent_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  -- lock first, then re-read everything the decision depends on
  perform app_private.lock_org_structure(v_u.org_id);
  select * into v_u from app.org_units where id = p_unit_id;
  select * into v_p from app.org_units where id = p_new_parent_id;
  if v_p.id is null or v_p.org_id <> v_u.org_id then perform app_private.raise_tf('not_found', 'parent unit'); end if;
  if v_u.parent_id is null then perform app_private.raise_tf('validation', 'the root unit cannot be moved'); end if;
  if not (v_actor.role = 'admin'
          or (app_private.has_grant(v_actor.id, 'manage_units', p_unit_id)
              and app_private.has_grant(v_actor.id, 'manage_units', p_new_parent_id))) then
    perform app_private.raise_tf('forbidden');
  end if;
  update app.org_units set parent_id = p_new_parent_id where id = p_unit_id;   -- cycle guard in trigger
  perform app_private.emit_event(v_u.org_id, v_actor.id, 'unit.moved', 'unit', p_unit_id,
    jsonb_build_object('from_parent', v_u.parent_id, 'to_parent', p_new_parent_id), p_op_id);
  v_res := app_private.ok(jsonb_build_object('unit_id', p_unit_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- invitations -----------------------------------------------------------------------
create function app_api.create_invitation(p_op_id uuid, p_role app.app_role, p_unit_id uuid,
                                          p_max_uses int, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_code text; v_id uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_invitation',
    jsonb_build_object('r', p_role, 'u', p_unit_id, 'm', p_max_uses, 'e', p_expires_at));
  if v_prev is not null then return v_prev; end if;   -- stored result never contains the code
  v_actor := app_private.require_actor();
  select * into v_u from app.org_units where id = p_unit_id;
  if v_u.id is null or v_u.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'unit'); end if;
  if p_role = 'admin' then perform app_private.raise_tf('validation', 'admins are promoted with set_member_role'); end if;
  if p_expires_at is null or p_expires_at <= now() then perform app_private.raise_tf('validation', 'expires_at must be in the future'); end if;
  if p_max_uses is null or p_max_uses not between 1 and 1000 then perform app_private.raise_tf('validation', 'max_uses must be 1 to 1000'); end if;
  if not (v_actor.role = 'admin'
          or (v_actor.role = 'supervisor' and app_private.unit_in_scope(v_actor.id, p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))
          or (app_private.has_grant(v_actor.id, 'create_invitations', p_unit_id)
              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))) then
    perform app_private.raise_tf('forbidden');
  end if;
  v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');   -- built-in CSPRNG uuids, at least 128 random bits
  insert into app.invitations (org_id, code_hash, role, unit_id, max_uses, expires_at, created_by)
  values (v_actor.org_id, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex'),
          p_role, p_unit_id, p_max_uses, p_expires_at, v_actor.id)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'unit_id', p_unit_id, 'max_uses', p_max_uses), p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', v_id, 'code_shown_once', true));
  perform app_private.finish_op(p_op_id, v_res);
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));   -- shown once, never persisted
end $$;

create function app_api.revoke_invitation(p_op_id uuid, p_invitation_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_i app.invitations; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'revoke_invitation', jsonb_build_object('i', p_invitation_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_i from app.invitations where id = p_invitation_id for update;
  if v_i.id is null or v_i.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'invitation'); end if;
  if not (v_actor.role = 'admin' or v_i.created_by = v_actor.id) then perform app_private.raise_tf('forbidden'); end if;
  update app.invitations set revoked_at = coalesce(revoked_at, now()) where id = p_invitation_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.revoked', 'invitation', p_invitation_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', p_invitation_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- Invalid codes return {ok:false, error:'not_found'} instead of raising, so the failed
-- attempt is committed and counts toward the 5 per hour limit.
create function app_api.redeem_invitation(p_op_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb; v_inv app.invitations; v_mem uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'redeem_invitation',
    jsonb_build_object('c', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_code, ''), 'UTF8')), 'hex')));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_verified_email();
  -- serialize attempts per user so concurrent guesses cannot all pass the counter
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('invite-attempts:' || v_uid::text, 0));
  if (select count(*) from app.invitation_attempts
      where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 5 then
    perform app_private.raise_tf('rate_limited', 'too many invitation attempts');
  end if;
  select * into v_inv from app.invitations
  where code_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_code, ''), 'UTF8')), 'hex')
  for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    insert into app.invitation_attempts (user_id) values (v_uid);
    v_res := jsonb_build_object('ok', false, 'error', 'not_found', 'server_time', now());
    return app_private.finish_op(p_op_id, v_res);
  end if;
  if exists (select 1 from app.memberships where user_id = v_uid) then
    perform app_private.raise_tf('validation', 'user already belongs to an organization');
  end if;
  insert into app.memberships (org_id, user_id, role, unit_id)
  values (v_inv.org_id, v_uid, v_inv.role, v_inv.unit_id) returning id into v_mem;
  update app.invitations set uses = uses + 1 where id = v_inv.id;
  perform app_private.emit_event(v_inv.org_id, v_mem, 'invitation.redeemed', 'invitation', v_inv.id, '{}'::jsonb, p_op_id);
  perform app_private.emit_event(v_inv.org_id, v_mem, 'member.joined', 'membership', v_mem,
    jsonb_build_object('role', v_inv.role, 'unit_id', v_inv.unit_id), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', v_mem, 'org_id', v_inv.org_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- members ---------------------------------------------------------------------------
create function app_api.set_member_role(p_op_id uuid, p_membership_id uuid, p_role app.app_role)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'set_member_role', jsonb_build_object('m', p_membership_id, 'r', p_role));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if v_t.status <> 'active' then perform app_private.raise_tf('validation', 'membership is not active'); end if;
  if v_actor.role <> 'admin' then
    -- supervisor with a delegated change_roles grant: down to leader or member, within scope
    if v_actor.role <> 'supervisor'
       or not app_private.has_grant(v_actor.id, 'change_roles', v_t.unit_id)
       or not app_private.has_authority_over_membership(v_actor.id, v_t.id)
       or p_role not in ('team_leader', 'member') then
      perform app_private.raise_tf('forbidden');
    end if;
  end if;
  update app.memberships set role = p_role where id = p_membership_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'member.role_changed', 'membership', p_membership_id,
    jsonb_build_object('from', v_t.role, 'to', p_role), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', p_membership_id, 'role', p_role));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.move_member(p_op_id uuid, p_membership_id uuid, p_unit_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'move_member', jsonb_build_object('m', p_membership_id, 'u', p_unit_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  perform app_private.lock_org_structure(v_actor.org_id);   -- placement changes authority
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if not exists (select 1 from app.org_units where id = p_unit_id and org_id = v_actor.org_id) then
    perform app_private.raise_tf('not_found', 'unit');
  end if;
  if v_t.status <> 'active' then perform app_private.raise_tf('validation', 'membership is not active'); end if;
  if v_actor.role <> 'admin' then
    if not (app_private.has_grant(v_actor.id, 'change_roles', v_t.unit_id)
            and app_private.has_grant(v_actor.id, 'change_roles', p_unit_id)
            and app_private.has_authority_over_membership(v_actor.id, v_t.id)) then
      perform app_private.raise_tf('forbidden');
    end if;
  end if;
  update app.memberships set unit_id = p_unit_id where id = p_membership_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'member.moved', 'membership', p_membership_id,
    jsonb_build_object('from_unit', v_t.unit_id, 'to_unit', p_unit_id), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', p_membership_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.set_member_status(p_op_id uuid, p_membership_id uuid, p_status app.member_status)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'set_member_status', jsonb_build_object('m', p_membership_id, 's', p_status));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if p_status = 'removed' then
    -- removal path
    if not (v_actor.role = 'admin'
            or (app_private.has_grant(v_actor.id, 'remove_members', v_t.unit_id)
                and app_private.has_authority_over_membership(v_actor.id, v_t.id))) then
      perform app_private.raise_tf('forbidden');
    end if;
    update app.permission_grants set revoked_at = now()
    where membership_id = p_membership_id and revoked_at is null;
    update app.org_units set leader_membership_id = null where leader_membership_id = p_membership_id;
  else
    if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
    if v_t.status = 'removed' then perform app_private.raise_tf('validation', 'removed members cannot be reactivated'); end if;
  end if;
  update app.memberships set status = p_status where id = p_membership_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id,
    case p_status when 'removed' then 'member.removed' else 'member.status_changed' end,
    'membership', p_membership_id, jsonb_build_object('from', v_t.status, 'to', p_status), p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', p_membership_id, 'status', p_status));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- delegated grants ------------------------------------------------------------------
create function app_api.grant_permission(p_op_id uuid, p_membership_id uuid, p_permission app.permission_kind,
                                         p_scope_unit_id uuid, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_t app.memberships; v_id uuid; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'grant_permission',
    jsonb_build_object('m', p_membership_id, 'p', p_permission, 'u', p_scope_unit_id, 'e', p_expires_at));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
  select * into v_t from app.memberships where id = p_membership_id;
  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;
  if v_t.status <> 'active' or v_t.role = 'admin' then perform app_private.raise_tf('validation', 'grant target must be an active non-admin'); end if;
  if not exists (select 1 from app.org_units where id = p_scope_unit_id and org_id = v_actor.org_id) then
    perform app_private.raise_tf('not_found', 'unit');
  end if;
  if p_expires_at is null or p_expires_at <= now() then perform app_private.raise_tf('validation', 'expires_at must be in the future'); end if;
  insert into app.permission_grants (org_id, membership_id, permission, scope_unit_id, expires_at, granted_by)
  values (v_actor.org_id, p_membership_id, p_permission, p_scope_unit_id, p_expires_at, v_actor.id)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'grant.created', 'grant', v_id,
    jsonb_build_object('membership_id', p_membership_id, 'permission', p_permission,
                       'scope_unit_id', p_scope_unit_id, 'expires_at', p_expires_at), p_op_id);
  v_res := app_private.ok(jsonb_build_object('grant_id', v_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

create function app_api.revoke_permission(p_op_id uuid, p_grant_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_g app.permission_grants; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'revoke_permission', jsonb_build_object('g', p_grant_id));
  if v_prev is not null then return v_prev; end if;
  v_actor := app_private.require_actor();
  if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;
  select * into v_g from app.permission_grants where id = p_grant_id for update;
  if v_g.id is null or v_g.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'grant'); end if;
  update app.permission_grants set revoked_at = coalesce(revoked_at, now()) where id = p_grant_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'grant.revoked', 'grant', p_grant_id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('grant_id', p_grant_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

-- ---- profile ---------------------------------------------------------------------------
create function app_api.update_profile(p_op_id uuid, p_patch jsonb)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb; v_key text; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'update_profile', coalesce(p_patch, 'null'::jsonb));
  if v_prev is not null then return v_prev; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then perform app_private.raise_tf('validation', 'patch must be an object'); end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key not in ('display_name', 'locale', 'theme', 'timezone', 'reminder_time') then
      perform app_private.raise_tf('validation', 'field not allowed: ' || v_key);
    end if;
  end loop;
  update app.profiles set
    display_name = case when p_patch ? 'display_name' then p_patch ->> 'display_name' else display_name end,
    locale = case when p_patch ? 'locale' then p_patch ->> 'locale' else locale end,
    theme = case when p_patch ? 'theme' then p_patch ->> 'theme' else theme end,
    timezone = case when p_patch ? 'timezone' then p_patch ->> 'timezone' else timezone end,
    reminder_time = case when p_patch ? 'reminder_time' then (p_patch ->> 'reminder_time')::time else reminder_time end
  where id = v_uid;
  v_res := app_private.ok(jsonb_build_object('profile_id', v_uid));
  return app_private.finish_op(p_op_id, v_res);
end $$;

select app_private.finalize_ownership();
grant execute on function
  app_api.create_organization(uuid, text, text), app_api.create_unit(uuid, uuid, text),
  app_api.rename_unit(uuid, uuid, text), app_api.move_unit(uuid, uuid, uuid),
  app_api.create_invitation(uuid, app.app_role, uuid, int, timestamptz),
  app_api.revoke_invitation(uuid, uuid), app_api.redeem_invitation(uuid, text),
  app_api.set_member_role(uuid, uuid, app.app_role), app_api.move_member(uuid, uuid, uuid),
  app_api.set_member_status(uuid, uuid, app.member_status),
  app_api.grant_permission(uuid, uuid, app.permission_kind, uuid, timestamptz),
  app_api.revoke_permission(uuid, uuid), app_api.update_profile(uuid, jsonb)
to authenticated;

-- The RPC owner role reads auth.uid() and the verified-email flag. On hosted Supabase this
-- grant must be confirmed against the real auth schema (not covered by local tests).
grant usage on schema auth to app_rpc;
grant select (id, email_confirmed_at) on auth.users to app_rpc;
