# Offline Sync and Recovery: architecture, data flow, evidence

Scope: the personal tasks stream (`personal_tasks`). Everything below was verified on a LOCAL PostgreSQL 16 with an auth shim
(through `tests/bridge.py`), a node SQLite driver, or a browser SQLite (sql.js). **Nothing was verified on hosted Supabase or on a phone.**

## 1. Principles
1. The screen reads only the local SQLite database. Every write is one local transaction: optimistic row + outbox operation.
2. The server is the authority: permissions (RLS and `SECURITY DEFINER` RPC checks via `uid()`), timestamps (`now()` on the server),
   ids of operations (receipts), and the final value of every field. The client never writes a table directly; it only calls `app_api` RPCs.
3. Local data is a cache plus a queue of requests. Editing it cannot grant anything: every queued request is re-authorised by the server.

## 2. Data flow
```
UI action -> repo (local row pending=1 + outbox op, one transaction) -> store.sync()
  sync: pull (see remote edits while ours are pending) -> push (FIFO, same op_id on every retry) -> pull (converge)
  push result per op: ok -> ack, clear pending | business error -> reject, roll the row back to base_json
                      transport error -> same op queued again after exponential backoff (2 s base, full jitter, 5 min cap)
                      401 -> paused until the session is refreshed
  pull: pages by (change_xid, id), cursor stored per page in the same transaction as the rows (a crash resumes, never restarts)
```
Startup: `recoverInflight()` returns ops that were mid-send when the app died to `queued` with the SAME op_id; the server replays the stored result.

## 3. Conflict policy (explicit)
* Unit of conflict: a field. The client sends only the fields the user edited, so edits to different fields on two devices both survive.
* Same field edited on two devices: **no silent overwrite.** An edit made from a value the device did not see is refused by the server (0019, atomic under the row lock); the user decides (apply mine with a fresh base, or use the other value). Last-writer-wins applies only to edits made from the current value. complete, reopen and delete are not yet conditional (see SYNC_STATUS.md).
* The user is told, not silently overwritten. Detection: primarily SERVER-reported (0019, closes the pull-then-push race); the client-side pull check remains as a second source: when a pull meets a row with a pending local op,
  the server row is not applied over the user's edit; if both sides changed the same field to different values a `sync_conflicts`
  record is created. After our op is acknowledged the record is "applied" (our value is now in effect) and the Sync panel offers
  "Restore the other value" (queues a normal update) or "Keep mine". If the server refuses our op, the record is closed and the server value stands.
* Remote delete while a local edit is pending: the edit is refused (`not_found`), the tombstone wins, the panel says so. Nothing is resurrected.
* A skipped server row is not lost: when the local ops for that row settle (acked or rejected) the stream cursor is rewound to just before it and it is re-pulled.
  (Before this phase a rejected local op left the client permanently stale. Tests: `recovery.test.ts` "stale data after a rejected local op".)
* Limit: detection depends on the client seeing the other value before it pushes (the store pulls first). A change that lands on the server between that pull
  and the push is still resolved correctly by last-writer-wins, but no conflict record is created.

## 4. Failure matrix
| Situation | Behaviour | Evidence |
|---|---|---|
| Offline, writes | kept locally, shown "waiting", sent later | restart.test, ui_e2e, ui_sync_e2e |
| App killed mid-send, answer lost | op back to queued, same op_id, server applies once | restart.test, e2e_local_postgres, e2e_sync_recovery |
| Same op_id sent 3 times in parallel | one row, one event | e2e_sync_recovery |
| Same op_id with different arguments | refused | e2e_sync_recovery |
| Server business refusal | op rejected, row rolled back, visible in inbox with reason, Retry or Discard | recovery.test, ui_sync_e2e |
| Database constraint error (HTTP 400, SQLSTATE 22/23) | permanent rejection `rejected_by_server` (before: retried forever and blocked the queue) | rpcClient.test, e2e_sync_recovery |
| Network/5xx/429/408 | retried with backoff, never dropped | sync.test, rpcClient.test |
| 401 | paused, `auth_required` state | sync.test |
| Op older than 90 days | `op_expired`, no retry offered | e2e_sync_recovery |
| Pull interrupted between pages | resumes from stored cursor | restart.test |
| Cursor older than purge floor | `sync_status` (0017) says so, client re-downloads, keeps unsent work | recovery.test, test_sync_server |
| Crash inside a write | no half state (row without op) | restart.test |

## 5. Authorization
* Forged outbox ops naming another user's task (edit, complete, delete) are all refused `not_found`; the server row is unchanged; the forger cannot pull it. (e2e_sync_recovery)
* Patches containing server-controlled fields (completed_at, user_id, created_at, updated_at, change_xid, id, deleted_at, status done) are refused. (e2e_sync_recovery)
* `created_at` comes from the server clock, not the device. (e2e_sync_recovery)
* A tampered local cursor or stream only changes what is requested; the pull RPC returns only the caller's rows. (e2e_sync_recovery)
* Not covered: org streams (not synced client side), removed or suspended organisation members calling org RPCs offline (server-side tests exist in `test_phase2.py`, but no client-queue test).

## 6. UI states and recovery
Phases: synced, syncing, waiting_retry (with seconds to the next try), offline, auth_required, attention. Tap the status chip for the Sync panel:
queued count, last full sync time, Try now, Re-download from server, and an inbox with rejected operations (Try again / Discard change) and conflicts (Restore the other value / Keep mine / OK).
English and Arabic strings exist. Screenshots: `/downloads/ui_shots/05_sync_panel_offline.png`, `06_sync_panel_rejected.png`.

## 7. Database changes (all local, none applied anywhere hosted)
| Migration | What | Baseline (0001-0013) dependency |
|---|---|---|
| 0017_sync_status | read-only `app_api.sync_status(stream, after_xid)`; true only when 0 < cursor < purge floor. Independent of identity helpers. | applies on baseline |
| 0019_update_checked | `update_personal_task_checked(op, id, patch, base)`: same rules as update, plus the server reports fields whose current value differs from the base the device last saw (atomic under the row lock). Edit still applies. | applies on baseline; needs approval; client falls back without it |
| 0018_complete_guard_deleted | `complete_personal_task` refuses a soft-deleted task. Defect found in 0010: completing a tombstone succeeded and rewrote it. | applies on baseline; needs approval before hosted use |
Client (device) schema migration 3: `skipped_rows`, `sync_conflicts`.

## 8. Does sync verification depend on 0014 (account lifecycle)?
No. The sync tests were run on two migration sets:
* Baseline = 0001-0013 + 0017 (+0018 for the one test that needs it): `tools/make_baseline.sh` builds it.
* Full = 0001-0018 including the unapproved 0014-0016.

Baseline result: python suite 49 passed, 17 failed. All 17 are tests of 0014, 0015, 0016 or 0018 (lifecycle x9, my_membership x3, list x2,
two lint tests whose expected function list names 0014-0016 functions, and the 0018 test that fails on the baseline BY DESIGN because it proves the 0010 defect).
All sync and personal-space tests pass on the baseline. Vitest (client + local PG) passes 123/123 on both sets.

## 9. Known limitations and unresolved risks
1. Only `personal_tasks` is synced client side. Notes, my-day items, attachments, org streams (epoch / `list_visible_ids` reconcile) are NOT offline-synced.
2. The expo-sqlite adapter and real device behaviour (background kill, OS connectivity events) are untested. Restart tests use a file-backed node SQLite.
3. No purge job exists on the server; `sync_status` only detects a floor if something sets one. Floor behaviour was tested by setting the floor by hand.
4. `create_personal_task` lets a raw CHECK error escape for an empty title (HTTP 400, SQLSTATE 23514) instead of a TF validation error. The client now treats it as a rejection; the server contract is unchanged (0013 is applied hosted).
5. Conflict detection is best effort (section 3). Last-writer-wins is the authority.
6. The panel offers "Restore the other value" only for title, planned date, priority and notes. Status changes use their own RPCs and are not restorable that way.
7. The client has no edit screen yet for titles; `repo.update` exists and is tested, the UI exposes add, complete, reopen, delete.
8. All hosted behaviour (PostgREST, JWT expiry, RLS under real roles, pooler) is UNVERIFIED. 0014 to 0018 are unapplied.

## 10. Verified here versus hosted
| Claim | Local PG (shim) | Browser/node SQLite | Hosted Supabase | Phone |
|---|---|---|---|---|
| RPC idempotency, auth refusals, 0017, 0018 | yes | n/a | NOT verified | NOT verified |
| Client queue, backoff, restart, conflicts, full resync | yes (fake server and local PG) | yes | NOT verified | NOT verified |
| Sync panel UI | yes (headless Chrome, react-native-web, local PG) | yes | NOT verified | NOT verified |
| RLS and JWT behaviour under PostgREST | partly (postgrest_local 13/13) | n/a | NOT verified | n/a |
