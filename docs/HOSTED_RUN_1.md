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
- tests/postgrest_local.py: standalone PostgREST v16.6 on LOCAL PG, self-signed HS256 JWTs. NOT Supabase (no GoTrue, no gateway). 10 of 10 pass: anon denied, schema app not exposed, expired JWT rejected, named-parameter RPC call works, op-id replay idempotent, sync_pull isolation between two users, cross-user completion refused.
  Finding: business errors surface over REST as HTTP 400 with SQLSTATE TFxxx and JSON details, not as {ok:false}. The adapter now maps them to {ok:false, code}; unexpected 4xx become TransportError (retry-safe). Test updated (mocked transport).

## Account lifecycle (migration 0014), LOCAL only, NOT applied to hosted
Problem: memberships.user_id and organizations.created_by have no ON DELETE CASCADE, so deleting an Auth user who had joined or created an org was blocked.
Implemented: profiles are no longer hard-linked to auth.users (the one foreign key changed; replaced by a delete trigger plus an invariant test); deleting an Auth user erases that user's personal data (including personal audit rows via a guarded exception), anonymises the profile, removes memberships and revokes grants, keeps org records and the org audit chain; the last active admin of a live org cannot be deleted or leave (transfer or close first); new RPCs leave_organization and close_organization (admin, sole remaining member, no org work); app_private.uid()/require_uid() return nothing for deleted accounts so unexpired JWTs lose all RPC and RLS access; all policies and helpers now use app_private.uid() (lint test enforces).
Tests (local PG + shim): 54 of 54 pass (46 earlier + 8 lifecycle: member deletion keeps history and denies stale token; last-admin block is atomic and retry after transfer succeeds; close then delete full cleanup with replay; org-has-work refusal and other orgs untouched; leave and replay; concurrent deletion of both admins leaves exactly one; no-org user deletes cleanly; uid lint). PostgREST local: 13 of 13 (adds deleted-user unexpired JWT cannot write or read). Non-superuser apply of 0001-0014: OK.
Not verified: behaviour on hosted Supabase (not applied); project JWT lifetime (dashboard setting, not read); auth.users trigger permission on a separate project (0002 trigger worked on production).
