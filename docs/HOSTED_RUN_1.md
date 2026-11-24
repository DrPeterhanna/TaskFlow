# Hosted Supabase run 1 (project utgqjzxfxhtrartcskbf), 2026-11-24 ~12:30-12:32 EET
Connection: Supavisor session pooler (eu-west-1), user postgres.<ref>, credential from the vault (never stored in the repo).
## Read-only inspection before any change
PostgreSQL 17.12. Schemas: auth, extensions, graphql, graphql_public, pgbouncer, public, realtime, storage, vault. Extensions: pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault. No tables in public, auth.users = 0, storage.buckets = 0, no migration history table. Only public function: rls_auto_enable (Supabase). Clean empty project: nothing to back up. Recovery plan: drop schemas app, app_api, app_private cascade and role app_rpc; reset pgrst.db_schemas to the prior default.
## Applied
0001..0013 each in its own transaction. 0001 had applied before 0002 failed: hosted `postgres` is not superuser and could not SET ROLE app_rpc (a local-vs-hosted difference the local tests could not show). Fix: 0001 now runs `grant app_rpc to current_user with set true`; applied the same grant on hosted, then 0002..0013 applied cleanly. 13 of 13 applied.
## Settings change
authenticator role: pgrst.db_schemas = 'public, graphql_public, app_api' (only app_api added; existing settings kept; app and app_private not exposed).
## Hosted checks executed (read-only SQL + HTTP with publishable key)
- 20 tables in schema app, all with RLS enabled; no anon grants on app*; authenticated has table grants on 13 app tables (RLS-governed).
- 30 app_api functions, 29 SECURITY DEFINER (owned by app_rpc), all executable by authenticated, none by anon. 7 app_private RLS helper functions executable by authenticated (by design); finalize_ownership owned by postgres (not exposed to authenticated).
- app_private.hmac_sha256 equals extensions.hmac(sha256) on one sample (not full RFC vectors).
- Hosted function signatures == app/src/supabase/rpcParams.generated.json (0 mismatches).
- REST: rpc call to app_api with the publishable key and no user JWT -> 401 "permission denied for schema app_api" (anon denied). Schema app -> PGRST106 not exposed.
## NOT done
Real authenticated JWT tests (RLS per role, RPC flows, sync_pull) need a confirmed test user; email confirmation is required and no supported admin credential held. Hosted run of the 46-test suite not done. Device runs not done.

## Follow-up checks (local, not Supabase)
- 46 of 46 local Postgres tests pass after the 0001 amendment (superuser, clean DB).
- tests/upgrade_nonsuper.py: all 13 migrations apply as a NON-superuser CREATEROLE user (hosted-like) on local PG 16: 13 of 13 applied.
- Dashboard browser route: saved browser profile not signed in to Supabase; no dashboard credential held.
