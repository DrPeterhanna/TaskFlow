-- 0009: fix-forward for review findings.
-- (a) One ACTIVE-or-suspended membership per user instead of one membership row ever:
--     a removed membership keeps its row (history, events) and can be reactivated by a valid
--     invitation to the same org, or a new row can be created in another org. A user still
--     never holds two non-removed memberships.
alter table app.memberships drop constraint memberships_user_id_key;
create unique index memberships_one_live_per_user on app.memberships (user_id) where status <> 'removed';

-- (b) create_invitation retry: the code is never stored, so a lost response is recovered by
--     rotating the code of the SAME unused invitation (no second invitation, no lost invite).
create or replace function app_api.create_invitation(p_op_id uuid, p_role app.app_role, p_unit_id uuid,
                                                     p_max_uses int, p_expires_at timestamptz)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_prev jsonb; v_actor app.memberships; v_u app.org_units; v_code text; v_id uuid; v_res jsonb;
  v_inv app.invitations;
begin
  v_prev := app_private.begin_op(p_op_id, 'create_invitation',
    jsonb_build_object('r', p_role, 'u', p_unit_id, 'm', p_max_uses, 'e', p_expires_at));
  if v_prev is not null then
    -- Replay after a lost response. Re-authorize as of now, then rotate the code of the
    -- original invitation if it is still unused. Never creates a second invitation.
    v_actor := app_private.require_actor();
    select * into v_inv from app.invitations
    where id = (v_prev -> 'data' ->> 'invitation_id')::uuid and created_by = v_actor.id for update;
    if v_inv.id is null or v_inv.uses > 0 or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
      return v_prev;   -- used, revoked or expired: nothing to recover; no code is returned
    end if;
    v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    update app.invitations
    set code_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex')
    where id = v_inv.id;
    perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.code_reissued', 'invitation', v_inv.id,
      '{}'::jsonb, p_op_id);
    return jsonb_set(v_prev, '{data,code}', to_jsonb(v_code));
  end if;
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
  -- Two random v4 uuids, dashes removed: 64 hex characters, 244 random bits (each v4 uuid has
  -- 122 random bits; 4 version bits and 2 variant bits are fixed). Only a SHA-256 hash is stored.
  v_code := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into app.invitations (org_id, code_hash, role, unit_id, max_uses, expires_at, created_by)
  values (v_actor.org_id, pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_code, 'UTF8')), 'hex'),
          p_role, p_unit_id, p_max_uses, p_expires_at, v_actor.id)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'unit_id', p_unit_id, 'max_uses', p_max_uses), p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', v_id, 'code_shown_once', true));
  perform app_private.finish_op(p_op_id, v_res);   -- stored result never contains the code
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));
end $$;

-- (c) redeem: a removed membership in the SAME org is reactivated (same row, history kept)
--     with the role and unit of the invitation, never with the old role. Only a valid
--     invitation can do this: set_member_status still refuses to resurrect removed members.
create or replace function app_api.redeem_invitation(p_op_id uuid, p_code text)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_prev jsonb; v_inv app.invitations; v_mem uuid; v_res jsonb; v_old app.memberships;
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_code, ''), 'UTF8')), 'hex');
begin
  v_prev := app_private.begin_op(p_op_id, 'redeem_invitation', jsonb_build_object('c', v_hash));
  if v_prev is not null then return v_prev; end if;
  perform app_private.require_verified_email();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('invite-attempts:' || v_uid::text, 0));
  if (select count(*) from app.invitation_attempts
      where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 5 then
    perform app_private.raise_tf('rate_limited', 'too many invitation attempts');
  end if;
  select * into v_inv from app.invitations where code_hash = v_hash for update;
  if v_inv.id is null or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    insert into app.invitation_attempts (user_id) values (v_uid);
    v_res := jsonb_build_object('ok', false, 'error', 'not_found', 'server_time', now());
    return app_private.finish_op(p_op_id, v_res);
  end if;
  select * into v_old from app.memberships where user_id = v_uid and status <> 'removed';
  if v_old.id is not null then
    perform app_private.raise_tf('validation', 'user already belongs to an organization');
  end if;
  select * into v_old from app.memberships where user_id = v_uid and org_id = v_inv.org_id and status = 'removed';
  if v_old.id is not null then
    update app.memberships set status = 'active', role = v_inv.role, unit_id = v_inv.unit_id where id = v_old.id;
    v_mem := v_old.id;
    perform app_private.emit_event(v_inv.org_id, v_mem, 'member.rejoined', 'membership', v_mem,
      jsonb_build_object('role', v_inv.role, 'unit_id', v_inv.unit_id, 'previous_role', v_old.role), p_op_id);
  else
    insert into app.memberships (org_id, user_id, role, unit_id)
    values (v_inv.org_id, v_uid, v_inv.role, v_inv.unit_id) returning id into v_mem;
    perform app_private.emit_event(v_inv.org_id, v_mem, 'member.joined', 'membership', v_mem,
      jsonb_build_object('role', v_inv.role, 'unit_id', v_inv.unit_id), p_op_id);
  end if;
  update app.invitations set uses = uses + 1 where id = v_inv.id;
  perform app_private.emit_event(v_inv.org_id, v_mem, 'invitation.redeemed', 'invitation', v_inv.id, '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('membership_id', v_mem, 'org_id', v_inv.org_id));
  return app_private.finish_op(p_op_id, v_res);
end $$;

select app_private.finalize_ownership();
