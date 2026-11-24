-- 0012: replace the secret-prefixed SHA-256 code derivation with a standard HMAC-SHA-256 (RFC 2104 / FIPS 198-1).
-- pgcrypto is not guaranteed locally, so HMAC is built from the built-in sha256(). It is checked against the
-- RFC 4231 test vectors and against Python's hmac module. On Supabase, a hosted check compares it with
-- extensions.hmac (see docs/HOSTED_VERIFICATION.md); the algorithm is the same on both, so codes do not change.
-- No invitation exists before first release, so no code derived under 0011 needs to stay valid.

create function app_private.hmac_sha256(p_key bytea, p_msg bytea)
returns bytea language plpgsql immutable
set search_path = ''
as $$
declare
  v_key bytea := p_key;
  v_ipad bytea;
  v_opad bytea;
  i int;
begin
  if pg_catalog.length(v_key) > 64 then
    v_key := pg_catalog.sha256(v_key);
  end if;
  v_key := v_key || pg_catalog.decode(pg_catalog.repeat('00', 64 - pg_catalog.length(v_key)), 'hex');
  v_ipad := v_key;
  v_opad := v_key;
  for i in 0..63 loop
    v_ipad := pg_catalog.set_byte(v_ipad, i, pg_catalog.get_byte(v_key, i) # 54);   -- 0x36
    v_opad := pg_catalog.set_byte(v_opad, i, pg_catalog.get_byte(v_key, i) # 92);   -- 0x5c
  end loop;
  return pg_catalog.sha256(v_opad || pg_catalog.sha256(v_ipad || p_msg));
end
$$;

create or replace function app_private.derive_code(p_key_id int, p_label text, p_user uuid, p_op uuid, p_extra text)
returns text language sql stable
set search_path = ''
as $$
  select pg_catalog.encode(app_private.hmac_sha256(
    pg_catalog.convert_to(s.secret, 'UTF8'),
    pg_catalog.convert_to(p_label || '|' || p_user::text || '|' || p_op::text || '|' || coalesce(p_extra, ''), 'UTF8')), 'hex')
  from app.server_secrets s where s.key_id = p_key_id
$$;

select app_private.finalize_ownership();
