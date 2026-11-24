-- 0005: authorization helpers (AUTHORIZATION_MATRIX rules 1 to 3).
-- Authority flows down only. A non-admin acts on a unit when the unit is at or below
-- the actor's placement unit, and on a member only when the actor's role outranks the
-- target's. Peers and ancestors are never in scope. Admin: whole org.

create function app_private.active_membership(p_user uuid)
returns app.memberships language sql stable security definer
set search_path = ''
as $$
  select m.* from app.memberships m where m.user_id = p_user and m.status = 'active'
$$;

create function app_private.my_membership_id()
returns uuid language sql stable security definer
set search_path = ''
as $$
  select m.id from app.memberships m where m.user_id = auth.uid() and m.status = 'active'
$$;

create function app_private.is_active_member(p_org uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.user_id = auth.uid() and m.org_id = p_org and m.status = 'active')
$$;

create function app_private.unit_in_scope(p_actor uuid, p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.memberships a
    join app.org_units u on u.id = p_unit and u.org_id = a.org_id
    where a.id = p_actor and a.status = 'active'
      and (a.role = 'admin'
           or exists (select 1 from app.unit_closure c
                      where c.ancestor_id = a.unit_id and c.descendant_id = p_unit)))
$$;

create function app_private.has_authority_over_membership(p_actor uuid, p_target uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.memberships a
    join app.memberships t on t.org_id = a.org_id and t.id = p_target
    where a.id = p_actor and a.status = 'active' and a.id <> t.id
      and (a.role = 'admin'
           or (app_private.role_rank(a.role) > app_private.role_rank(t.role)
               and app_private.unit_in_scope(a.id, t.unit_id))))
$$;

-- Delegated grant: active, unexpired, not revoked, scoped to a unit at or above the target unit.
-- The actor must also have the unit in their own scope: grants never exceed own authority.
create function app_private.has_grant(p_actor uuid, p_permission app.permission_kind, p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1
    from app.permission_grants g
    join app.memberships m on m.id = g.membership_id and m.status = 'active'
    join app.unit_closure c on c.ancestor_id = g.scope_unit_id and c.descendant_id = p_unit
    where g.membership_id = p_actor and g.permission = p_permission
      and g.revoked_at is null and g.expires_at > now() and g.deleted_at is null
      and app_private.unit_in_scope(p_actor, p_unit))
$$;

create function app_private.is_admin(p_actor uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from app.memberships m
                 where m.id = p_actor and m.role = 'admin' and m.status = 'active')
$$;

-- Wrappers for the current user, used by RLS policies.
create function app_private.me_has_authority_over_membership(p_target uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$ select app_private.has_authority_over_membership(app_private.my_membership_id(), p_target) $$;

create function app_private.me_unit_in_scope(p_unit uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$ select app_private.unit_in_scope(app_private.my_membership_id(), p_unit) $$;


select app_private.finalize_ownership();
-- Only the current-user wrappers are callable by clients (RLS policies need them).
grant execute on function
  app_private.my_membership_id(), app_private.is_active_member(uuid),
  app_private.me_has_authority_over_membership(uuid), app_private.me_unit_in_scope(uuid)
to authenticated;
