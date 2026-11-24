-- 0011: stable invitation replay. Supersedes the code rotation in 0009.
-- Design: the invitation code is DERIVED, not stored: code = SHA-256(secret || label || user || op ...).
-- Only the code hash is stored. A retry of the same op derives the same code, so a delayed or
-- concurrent duplicate returns exactly what the first call returned and never invalidates it.
-- Tradeoff (documented in docs/PHASE2_REPORT.md): plaintext is not retained anywhere, so a leak of
-- invitations, receipts or events does not reveal codes. A party holding the server secret AND the
-- (user_id, op_id) pair can re-derive a code; the secret is readable only by the RPC owner role.
-- The construction is a secret-prefixed SHA-256 (no pgcrypto locally); on hosted Supabase switch to
-- extensions.hmac(...) after verifying it there. Code entropy is bounded by the 244-bit secret.
create table app.server_secrets (
  key_id int primary key,
  secret text not null,
  created_at timestamptz not null default now()
);
insert into app.server_secrets (key_id, secret)
values (1, replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));
alter table app.server_secrets enable row level security;
alter table app.server_secrets force row level security;
grant select on app.server_secrets to app_rpc;
create policy server_secrets_rpc on app.server_secrets for select to app_rpc using (true);
alter table app.invitations add column code_key_id int not null default 1 references app.server_secrets (key_id);

create function app_private.derive_code(p_key_id int, p_label text, p_user uuid, p_op uuid, p_extra text)
returns text language sql stable
set search_path = ''
as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    s.secret || '|' || p_label || '|' || p_user::text || '|' || p_op::text || '|' || coalesce(p_extra, ''), 'UTF8')), 'hex')
  from app.server_secrets s where s.key_id = p_key_id
$$;

create function app_private.code_hash(p_code text)
returns text language sql immutable
set search_path = ''
as $$ select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_code, 'UTF8')), 'hex') $$;

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
    -- Replay: return the SAME result and the SAME code (re-derived), while the invitation is live
    -- and its creator is still an active member. Never changes the secret, never creates a second row.
    select * into v_actor from app.memberships where user_id = app_private.require_uid() and status = 'active';
    select * into v_inv from app.invitations where id = (v_prev -> 'data' ->> 'invitation_id')::uuid;
    if v_actor.id is null or v_inv.id is null or v_inv.created_by <> v_actor.id
       or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
      return v_prev;   -- not live any more: result without a code
    end if;
    return jsonb_set(v_prev, '{data,code}',
      to_jsonb(app_private.derive_code(v_inv.code_key_id, 'invite', v_actor.user_id, p_op_id, null)));
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
  v_code := app_private.derive_code(1, 'invite', v_actor.user_id, p_op_id, null);
  insert into app.invitations (org_id, code_hash, role, unit_id, max_uses, expires_at, created_by, code_key_id)
  values (v_actor.org_id, app_private.code_hash(v_code), p_role, p_unit_id, p_max_uses, p_expires_at, v_actor.id, 1)
  returning id into v_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.created', 'invitation', v_id,
    jsonb_build_object('role', p_role, 'unit_id', p_unit_id, 'max_uses', p_max_uses), p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', v_id));
  perform app_private.finish_op(p_op_id, v_res);   -- the stored result never contains the code
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));
end $$;

-- Explicit rotation is its own authorized operation (creator or admin), with its own op id and
-- stable replay. It is never triggered by transport retries.
create function app_api.rotate_invitation_code(p_op_id uuid, p_invitation_id uuid)
returns jsonb language plpgsql security definer
set search_path = ''
as $$
declare v_prev jsonb; v_actor app.memberships; v_inv app.invitations; v_code text; v_res jsonb;
begin
  v_prev := app_private.begin_op(p_op_id, 'rotate_invitation_code', jsonb_build_object('i', p_invitation_id));
  v_actor := app_private.require_actor();
  select * into v_inv from app.invitations where id = p_invitation_id for update;
  if v_inv.id is null or v_inv.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'invitation'); end if;
  if not (v_actor.role = 'admin' or v_inv.created_by = v_actor.id) then perform app_private.raise_tf('forbidden'); end if;
  if v_prev is not null then
    -- stable replay of the same rotation, if it is still the current code
    v_code := app_private.derive_code(v_inv.code_key_id, 'rotate', v_actor.user_id, p_op_id, p_invitation_id::text);
    if v_inv.code_hash = app_private.code_hash(v_code) then
      return jsonb_set(v_prev, '{data,code}', to_jsonb(v_code));
    end if;
    return v_prev;
  end if;
  if v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then
    perform app_private.raise_tf('validation', 'invitation is not live');
  end if;
  v_code := app_private.derive_code(v_inv.code_key_id, 'rotate', v_actor.user_id, p_op_id, p_invitation_id::text);
  update app.invitations set code_hash = app_private.code_hash(v_code) where id = p_invitation_id;
  perform app_private.emit_event(v_actor.org_id, v_actor.id, 'invitation.code_rotated', 'invitation', p_invitation_id,
    '{}'::jsonb, p_op_id);
  v_res := app_private.ok(jsonb_build_object('invitation_id', p_invitation_id));
  perform app_private.finish_op(p_op_id, v_res);
  return jsonb_set(v_res, '{data,code}', to_jsonb(v_code));
end $$;

select app_private.finalize_ownership();
grant execute on function app_api.rotate_invitation_code(uuid, uuid) to authenticated;
