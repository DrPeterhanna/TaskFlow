-- LOCAL ONLY proposal. Capability prevents a new client trusting older unsafe delete semantics.
create or replace function app_api.sync_status(p_stream text, p_after_xid xid8 default '0'::xid8)
returns jsonb language plpgsql stable security definer
set search_path = ''
as $$
declare v_floor xid8;
begin
  if p_stream not in ('personal_tasks', 'personal_notes', 'org_units') then
    raise exception 'unknown stream' using errcode = 'TF004', detail = '{"code":"validation","message":"unknown stream"}';
  end if;
  select f.floor_xid into v_floor from app.sync_floor f where f.stream = p_stream;
  v_floor := coalesce(v_floor, '0'::xid8);
  return pg_catalog.jsonb_build_object('ok', true, 'data', pg_catalog.jsonb_build_object(
    'floor_xid', v_floor::text, 'mutation_safety_version', 2,
    'full_resync_required', (p_after_xid::text::numeric > 0 and p_after_xid::text::numeric < v_floor::text::numeric)),
    'server_time', pg_catalog.now());
end $$;
grant execute on function app_api.sync_status(text, xid8) to authenticated;
select app_private.finalize_ownership();
