-- 0016: read-only listings for the organization screens. SECURITY INVOKER on purpose: they run as the calling user, so
-- the existing RLS policies (authority-down visibility) decide every row. No new access path, no privilege widening.
create function app_api.list_members()
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'data', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'membership_id', m.id, 'display_name', p.display_name, 'role', m.role, 'status', m.status, 'unit_id', m.unit_id,
           'is_me', m.id = app_private.my_membership_id()) order by m.created_at, m.id), '[]'::jsonb))
  from app.memberships m join app.profiles p on p.id = m.user_id
  where m.status <> 'removed'
$$;

create function app_api.list_invitations()
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'data', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', i.id, 'role', i.role, 'unit_id', i.unit_id, 'max_uses', i.max_uses, 'uses', i.uses,
           'expires_at', i.expires_at, 'revoked_at', i.revoked_at) order by i.created_at, i.id), '[]'::jsonb))
  from app.invitations i
$$;

create function app_api.list_units()
returns jsonb language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object('ok', true, 'data', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', u.id, 'parent_id', u.parent_id, 'name', u.name) order by u.created_at, u.id), '[]'::jsonb))
  from app.org_units u where u.deleted_at is null
$$;
grant execute on function app_api.list_members(), app_api.list_invitations(), app_api.list_units() to authenticated;
select app_private.finalize_ownership();
