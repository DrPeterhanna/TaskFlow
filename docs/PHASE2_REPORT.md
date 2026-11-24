# Phase 2 report, revision 2: database, authentication, permissions, hierarchy, offline and audit foundations

Status: **schema foundation plus the listed RPCs, verified on local PostgreSQL 16.2 only.** This is not feature completion and not Supabase verification. Nothing deployed, no paid service, old codebase untouched. Repository: new git repo `taskflow` (11 migrations, 41 tests).

## 1. What was built
- Schemas `app` (tables), `app_private` (helpers), `app_api` (only RPC surface). Typed errors TFnnn.
- Auth: profiles bound to `auth.users` by trigger; verified email required to create or join an org.
- Org tree: organizations, units, closure table, cycle guard under an org-structure advisory lock (also in the trigger).
- Memberships (member, team_leader, supervisor, admin; active, suspended, removed), delegated grants (scoped, expiring, revocable, never above own scope), invitations, last-admin protection (deferred trigger plus per-org lock).
- RLS enabled and forced on every table. Clients have SELECT only; every write is an RPC. Code hashes and server secrets are unreadable by clients.
- Offline foundations: sync columns (row_version, change_xid, soft delete) on syncable tables; idempotency receipts (atomic with the mutation, replay, op_id_reuse, op_expired from the v7 timestamp before lookup, concurrent retries serialized); access epochs (user and unit scope); `sync_floor` table; `sync_pull` (xid horizon, (change_xid, id) keyset, SECURITY INVOKER so RLS applies).
- Audit foundations: append-only per-org hash-chained `events` written by `emit_event` in every RPC; `verify_chain`. Tamper evidence only against non-privileged modification. A privileged operator can recompute the chain. Not tamper-proof.
- Personal space (schema foundation): personal_tasks (3 levels, server-stamped completion), personal_task_dependencies, personal_recurrence_rules, personal_attachments (metadata), personal_notes, personal_events (owner-only, own hash chain, never in org events). Owner-only RLS (no manager or admin policy).

## 2. RPCs (all idempotent, all audited)
Org: create_organization, create_unit, rename_unit, move_unit, create_invitation, revoke_invitation, redeem_invitation, rotate_invitation_code, set_member_role, move_member, set_member_status, grant_permission, revoke_permission, update_profile, current_epoch.
Personal: create_personal_task, complete_personal_task, create_personal_note. Sync: sync_pull (streams personal_tasks, personal_notes, org_units).

## 3. Scope correction (explicit, not silent)
The roadmap puts "personal tables with owner-only history" in Phase 2. Delivered: the tables, owner-only RLS, owner-only history chain, and the three RPCs above (the minimum to prove the history and gate paths). **Not delivered, and why:**
- `my_day_items`: references team tasks, which do not exist until Phase 4. My Day UI and semantics are Phase 8. Prerequisites: team `tasks` table (Phase 4), the per-item register RPCs (add, remove, focus, move) from the approved sync design, a visibility check against task RLS.
- Personal RPCs for update, delete/restore, dependency add/remove (with cycle check), recurrence set, reorder, attachment upload: tables exist, RPCs and tests do not. They belong with the task machinery (Phase 4) and attachments (Phase 11) so the personal and team paths share trigger functions.
- Team tasks, dependencies, recurrence, follow-ups, notifications, attachments, proposals: Phases 4 to 11.
- sync_pull covers three streams only. `sync_floor` has no purge job. Reconcile mode (`list_visible_ids`) and `full_resync_required` logic are not built (Phase 3 spike and Phase 5).
- Roadmap exit criterion "Schema on staging" is NOT met (no staging; needs Peter's Supabase account). "Commit-skip test green" is met on local PostgreSQL only.

## 4. Migrations
0001 schemas, roles, enums, errors. 0002 profiles. 0003 org tree and closure. 0004 memberships, grants, invitations, last-admin. 0005 authz helpers. 0006 events and chain. 0007 receipts and epochs. 0008 RLS and RPCs. 0009 rejoin lifecycle. 0010 personal space, sync_floor, sync_pull. 0011 stable invitation replay and rotation.
Numbering differs from the proposal: events, receipts and epochs were pulled forward. 0009 and 0011 are fix-forward (pre-release), they supersede functions from 0008.

## 5. Decisions made in this revision
- **Rejoin.** At most one live (non-removed) membership per user (partial unique index). A removed member keeps their row and history. A valid invitation to the same org reactivates that same row with the invitation's role and unit (event member.rejoined). An invitation from another org creates a new row; the old row stays as history. Suspended members cannot redeem. Admins cannot resurrect removed members directly.
- **Invitation codes and retries.** Codes are derived, not stored: `code = SHA-256(secret || label || user || op [|| invitation])`. Only the hash is stored, so a leak of invitations, receipts or events does not reveal codes. The same op returns the same code, whether the retry is delayed or concurrent, while the invitation is live and the creator is still an active member. A used-up, revoked or expired invitation returns no code. Rotation is a separate authorized RPC (creator or admin) with its own stable replay. Redeem retry with the same op replays the stored result and cannot consume a second use.
  Tradeoff: a party holding the server secret and the (user_id, op_id) pair can re-derive a code (the secret is readable only by the RPC owner role). The construction is a secret-prefixed SHA-256 because pgcrypto is unavailable locally; on Supabase it should become `extensions.hmac` after verification there. Code entropy is bounded by the 244-bit secret (two v4 UUIDs: 2 x 122 random bits).
- Invalid invitation codes return `{ok:false, error:not_found}` (not an exception) so failed attempts are committed and counted (5 per hour).
- Defaults to confirm with Peter: unit names visible to all org members; leaders see only lower-rank members in their subtree (peer visibility N); admins are not created by invitation; default locale 'en'.

## 6. Tests actually executed (local PostgreSQL 16.2 via pgserver; NOT Supabase)
- `python tests/run.py`: **41 of 41 passed** (docs/TEST_RESULTS.txt). Covers: schema lint (RLS forced, fixed search_path, owner, no PUBLIC or client write grants, exact client-callable function list); authentication; RLS matrix across member, leader, peer leader, supervisor, admin, other-org admin, anonymous, suspended, removed; RPC allow and deny; hierarchy and cycles; rejoin lifecycle; invitations (single use, expiry, revocation, rate limit, stable replay, concurrent and delayed duplicates, rotation); receipts (replay, mismatch, expired id, concurrent retry); event tamper detection and fork rejection; epochs; concurrency (opposing moves, admin lock, receipts, invitations); personal-space owner-only and gate and depth; sync_pull late-commit and pagination; regression.
- Mutation testing on the final suite: **35 mutants applied one at a time, 34 killed, 1 survived** (docs/MUTATION_RESULTS.txt). The survivor is an equivalent mutant: removing the actor-status check inside `has_authority_over_membership` changes nothing because `unit_in_scope` re-checks status; a regression test asserts the observable result. Killed mutants include: cycle guard, structure lock, RLS force, last-admin, admin lock, rank strictness, scope check, grant expiry and revocation, events immutability, chain fork, hash payload, args mismatch, op expiry, receipt overwrite, epoch bump, invitation scope, rate limit, hash and secret exposure, rotation authorization, rejoin role, multiple live memberships, sync horizon, personal owner policy, personal gate and depth.
- ruff: pass. mypy: pass. sqlfluff (postgres dialect, `.sqlfluff`, no file-size skip, layout and capitalization rules): pass on all 11 migrations. Limit: PL/pgSQL bodies are strings to sqlfluff, so they are not style-checked, and the safety rules are enforced by the lint tests instead.
- Build verification: all 11 migrations apply in order on an empty database (done by the harness in every run).
- NOT run: API tests through PostgREST or Supabase, RLS under real JWTs, hosted Supabase checks (auth schema grants, role ownership), mobile or offline client tests (no client yet), chaos or load tests, physical-device tests.

## 7. Known limitations
Local PostgreSQL is not Supabase. Epoch cost and per-org event serialization are unmeasured at scale. Events are not partitioned. No signed chain-head export. Receipt purge job and tombstone purge not built. Org events carry no task kinds yet. Open decisions from the proposal are unchanged.

## 8. Next phase dependencies
Phase 3 stays paused. Before it: Peter's go-ahead on this scope correction and the defaults in section 5; Supabase project ownership (needs his accounts) for hosted verification; toolchain confirmation. Phase 4 builds task tables on the locks, receipts, events, epochs and sync_pull here, and then closes the personal RPC and My Day gaps.
