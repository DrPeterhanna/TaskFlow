-- LOCAL ONLY: fixes reproduced coarse table/receipt/row lock-order deadlocks.
create or replace function app_private.begin_op(p_op uuid, p_rpc text, p_args jsonb)
returns jsonb language plpgsql
set search_path = ''
as $$
declare
  v_user uuid := app_private.require_uid();
  v_time timestamptz;
  v_hash text := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_args::text, 'UTF8')), 'hex');
  v_rec app.op_receipts;
begin
  -- Global local-proposal lock order: serialize personal RPCs before receipt/row/table locks.
  -- Correctness-first; replace only with a proved finer-grained protocol.
  if p_rpc like '%personal%' then perform pg_catalog.pg_advisory_xact_lock(7412093, 1); end if;
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


select app_private.finalize_ownership();
