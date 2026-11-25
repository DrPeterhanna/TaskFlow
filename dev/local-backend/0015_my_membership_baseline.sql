-- LOCAL DEVELOPMENT ONLY: read-only membership compatibility without held migration 0014.
-- Not a hosted migration, no account-deletion policy changes.
-- Baseline identity is profiles.id = auth.users.id.
-- Read-only "who am I" for the client shell. The app schema is intentionally not exposed over REST, so the client
-- needs one narrow read RPC to learn its own live membership and whether its email is verified. No new table access.
create function app_api.my_membership()
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := app_private.require_uid();
  v_verified boolean;
  v_m jsonb;
begin
  select exists (select 1 from auth.users u join app.profiles p on p.id = u.id where p.id = v_uid and u.email_confirmed_at is not null) into v_verified;
  select pg_catalog.jsonb_build_object('membership_id', m.id, 'org_id', m.org_id, 'org_name', o.name, 'role', m.role,
                                       'status', m.status, 'unit_id', m.unit_id)
    into v_m
  from app.memberships m join app.organizations o on o.id = m.org_id
  where m.user_id = v_uid and m.status <> 'removed' and o.deleted_at is null
  order by m.created_at desc limit 1;
  return app_private.ok(pg_catalog.jsonb_build_object('email_verified', v_verified, 'membership', v_m));
end $$;
grant execute on function app_api.my_membership() to authenticated;
select app_private.finalize_ownership();
