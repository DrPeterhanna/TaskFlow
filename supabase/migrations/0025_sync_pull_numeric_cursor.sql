-- LOCAL ONLY: PostgreSQL ORDER BY output aliases made change_xid::text sort lexically.
-- Keep the invoker/RLS contract and order the underlying xid8 explicitly.
create or replace function app_api.sync_pull(p_stream text, p_after_xid xid8 default '0'::xid8,
                                  p_after_id text default '', p_horizon xid8 default null, p_limit int default 200)
returns jsonb language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_horizon xid8 := coalesce(p_horizon, pg_catalog.pg_snapshot_xmin(pg_catalog.pg_current_snapshot()));
  v_rows jsonb; v_next_xid text; v_next_id text; v_sql text;
begin
  if p_stream not in ('personal_tasks', 'personal_notes', 'org_units') then
    raise exception 'unknown stream' using errcode = 'TF004', detail = '{"code":"validation","message":"unknown stream"}';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'limit must be 1 to 1000' using errcode = 'TF004', detail = '{"code":"validation","message":"limit"}';
  end if;
  v_sql := pg_catalog.format($q$
    with page as (
      select t.*, t.id::text as id_text from app.%1$I t
      where (t.change_xid, t.id::text) > ($1, $2) and t.change_xid < $3
      order by t.change_xid, t.id::text limit $4)
    select coalesce(jsonb_agg(to_jsonb(p) - 'id_text' order by p.change_xid, p.id_text), '[]'::jsonb),
           (select q.change_xid::text from page q order by q.change_xid desc, q.id_text desc limit 1),
           (select q.id_text from page q order by q.change_xid desc, q.id_text desc limit 1)
    from page p$q$, p_stream);
  execute v_sql into v_rows, v_next_xid, v_next_id using p_after_xid, p_after_id, v_horizon, p_limit;
  return jsonb_build_object('rows', v_rows, 'horizon', v_horizon::text,
                            'next_xid', v_next_xid, 'next_id', v_next_id);
end $$;
