# Phase 2 report: database, authentication, permissions, hierarchy, offline and audit foundations

Scope: as approved by Peter on 24 Nov 2026. No paid services, no deployment, no mobile app code, no old codebase used.
Repository: /downloads/taskflow (new git repository).

## 1. What was built
- Schemas: `app` (tables, not exposed), `app_private` (helpers, not exposed), `app_api` (only RPC surface).
- Profiles bound to `auth.users` through a trigger.
- Organizations, org-unit tree with a closure table, cycle guard under an org-structure advisory lock.
- Memberships (4 roles, status active/suspended/removed), delegated grants (scoped, expiring, revocable), invitations (hashed code, single or multi use, expiry, revocation, 5 failed tries per hour).
- Last-admin protection (deferred constraint plus per-org advisory lock).
- Authorization helpers: authority flows down only, strict rank rule, admin org-wide, grants never exceed own scope.
- RLS enabled and FORCED on every table. Clients have SELECT only; every write is an RPC. `code_hash` is not readable.
- 14 RPCs with typed errors (TFnnn): create_organization, create_unit, rename_unit, move_unit, create_invitation, revoke_invitation, redeem_invitation, set_member_role, move_member, set_member_status (suspend, reactivate, remove), grant_permission, revoke_permission, update_profile, plus current_epoch.
- Offline foundations: sync columns (row_version, change_xid xid8, soft delete) on every syncable table; idempotency receipts written atomically with each mutation (replay, op_id_reuse on mismatch, op_expired from the v7 timestamp before any lookup, concurrent retries serialized); access epochs (user and unit scope) bumped by membership, grant and unit-structure changes.
- Audit foundation: append-only per-org hash-chained `events`, written only by `emit_event` inside every RPC; `verify_chain`. Tamper evidence only (a privileged operator can recompute the chain; not tamper-proof).

## 2. Files
supabase/migrations/0001..0008 (below), tests/harness.py, tests/run.py, tests/test_phase2.py (35 tests), tests/support/00_supabase_shim.sql (TEST ONLY), scripts/mutate.py, pyproject.toml, README.md, .gitignore.

## 3. Database migrations
0001 schemas, roles, enums, typed errors, sync trigger. 0002 profiles. 0003 organizations, units, closure. 0004 memberships, grants, invitations, last-admin. 0005 authorization helpers. 0006 events and hash chain. 0007 receipts and epochs. 0008 RLS policies and RPCs.
Ordering differs from the proposal's list (events, receipts and epochs were pulled forward from later numbers so audit capture and offline machinery exist before feature tables, as the roadmap requires). Tasks, dependencies, recurrence, follow-ups, personal tables, attachments, proposals and notifications are not built; they belong to later phases.

## 4. Tests actually executed (local PostgreSQL 16.2 via pgserver, NOT Supabase)
- Full suite: 35 tests, 35 passed (command: `python tests/run.py`). Categories: schema lint (RLS forced everywhere, fixed search_path, owner, no PUBLIC/anon execute, no client write grants, exact client-callable function list), authentication, RLS authorization matrix (member, leader, peer leader, supervisor, admin, other-org admin, anonymous), RPC positive and negative tests, hierarchy and cycle tests, invitations, receipts (replay, mismatch, expiry, concurrent), events (append-only, tamper detection, fork rejection), epochs, concurrency (opposing moves, concurrent receipts, admin lock), regression.
- Mutation testing (the last 8 mutants were last run against the suite before its final 3 tests were added; the first 19 were re-run on the final suite): 27 mutants of critical rules were applied one at a time. 26 killed by the suite; 1 survived (suspended-actor status check inside has_authority_over_membership). It is an equivalent mutant: `unit_in_scope` re-checks the actor status, and a test confirms a suspended actor has no authority. Several mutants first survived and led to new tests (peer same-rank, deterministic admin lock, receipt overwrite, scope).
- ruff: pass. mypy: pass (tests and scripts). Build verification: all 8 migrations apply in order to an empty database (done by the harness for every run).
- Not run: sqlfluff over the SQL (file too large for the default limit; only a whitespace rule was tried on small files). No API integration tests through PostgREST/Supabase, no offline client tests (no client exists), no physical-device tests, no performance tests.

## 5. Known limitations and open items
- Local PostgreSQL is not Supabase. Not verified: the `auth` schema grants to `app_rpc`, ownership changes by the hosted `postgres` role, RLS through PostgREST, `auth.uid()` from a real JWT, Auth email verification, secret management. `pgcrypto` was unavailable locally so invitation codes use built-in random UUIDs (at least 128 random bits).
- Single org per user and `UNIQUE(user_id)` (default): a removed member cannot rejoin; reactivation of removed members is blocked.
- Defaults I chose that need Peter's confirmation: unit names visible to all active org members; a leader sees only members below their rank in their unit subtree (peer visibility stays N); `admin` cannot be created by invitation (use set_member_role); invalid invitation codes return `{ok:false,error:not_found}` (not an exception) so failed attempts persist for the rate limit; invitation code is returned once and is not replayed from the receipt; default locale 'en'.
- Events table is not partitioned and per-org serialization is untested at scale. Daily signed chain-head export is not built (still an open decision).
- Receipt purge job and tombstone/sync_floor are not built (Phase 5). Epoch cost at scale is not measured.
- Org events contain no task kinds yet. Personal-space tables are not built.
- Open decisions still open from the proposal are unchanged (legacy requirements, working days and capacity, on-time metric, MFA and DB encryption, legal region, languages, store and Supabase accounts).

## 6. Next phase dependencies
Phase 3 (design system and app foundation) needs: confirmation of locale default and the Phase 2 defaults above, Expo/React Native toolchain choice per the approved proposal, and Supabase project ownership before any hosted verification (needs Peter's accounts; nothing created). Task tables (Phase 4) build on the lock, receipt, event and epoch helpers here.
