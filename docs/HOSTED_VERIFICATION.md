# Hosted (Supabase) verification checklist. Not yet run.
Requires Peter's own Supabase project. No migration is applied without his go-ahead.
1. Apply migrations 0001-0012 in order to the empty project; record any error.
2. HMAC: compare select encode(app_private.hmac_sha256(k::bytea, m::bytea),'hex') with encode(extensions.hmac(m::bytea, k::bytea, 'sha256'),'hex') for RFC 4231 vectors and for derive_code inputs. Must be identical. (If equal, keeping the SQL version is acceptable; switching to extensions.hmac is optional.)
3. Confirm grants on schema auth for the RPC owner role (0008 note), auth.uid() and the verified-email flag.
4. Run the RLS matrix and RPC allow/deny cases through PostgREST with real JWTs for 7 roles.
5. Confirm the app_rpc role setup works under the hosted postgres (non-superuser) role.
6. Commit-skip test with two real connections through the pooler.
Record results as hosted evidence, separate from local results.
