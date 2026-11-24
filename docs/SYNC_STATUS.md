# Offline Sync & Recovery: living status list
Last updated at the commit that contains this file. All evidence is LOCAL (local PostgreSQL 16 + auth shim, node/browser SQLite, headless Chrome). Hosted Supabase: none. Device: none.

## 1. Implemented
- Durable outbox (SQLite), FIFO, same op_id on every retry, exponential backoff with full jitter (2 s base, 5 min cap), inflight recovery at startup.
- Server idempotency receipts (90 days), op expiry, args-hash mismatch refusal.
- Pull with per-page atomic cursor, horizon pinning, skipped-row rewind after local ops settle (fixes the stale-after-reject defect).
- Conflict reporting by the SERVER (0019 `update_personal_task_checked`): under the row lock it reports which edited fields held a value this device had not seen. The edit still applies; the device records a conflict and the user can restore the other value. Fallback to plain update when 0019 is missing (client-side detection only).
- Remote delete during a local edit: refused by the server, shown to the user.
- Full resync via `sync_status` (0017), keeps unsent work.
- Recovery UI: status chip, Sync panel (queued count, retry countdown only when truly waiting to retry, last full sync), Try now, Re-download, rejected inbox (Try again / Discard), conflict inbox (Restore other value / Keep mine / OK). EN and AR.
- Poison-op protection: DB constraint errors become visible rejections; missing server function falls back.
- 0018: completing a deleted task refused.

## 2. Verified scenarios (local)
See docs/TEST_RESULTS.txt for counts. Scenarios: offline write and flush; restart with queued ops; kill mid-send then replay (applied once); lost response; same op_id x3 in parallel; same op_id with different args; 5 offline edits plus one lost response; rejected op in the middle does not block later ops; stale-pull-after-reject; remote delete during edit; edit/edit same field (server-reported, even when no pull happened in between); edit/edit different fields; stale device edit; mid-pull crash resume; cursor below floor; forged ops on another user's task; server-controlled fields in a patch; 90-day-old op; tampered cursor.

## 3. Remaining failures / gaps (NOT done)
1. Conflict audit is incomplete. Only the update path reports overwritten fields. complete, reopen and delete from a stale device are applied without telling the user what they replaced (for example deleting a task that another device just edited). Each needs a deterministic test and either a server report or a refusal.
2. Reassignment, role changes and org streams are not synced offline, so conflicts there are untested by design.
3. No retention/purge mechanism is built. Only the client reaction to a floor that was set by hand is tested. The 0010 architecture schedules the purge for a later phase; Peter has now asked for a safe design in this phase.
4. Authorization after revocation: personal-space ops depend only on the signed-in user. Tests for a suspended or role-changed org member exist at server level (test_phase2) but there is no client-queue test, because org operations are online-only. A removed/deleted account (0014, unapproved) with a queued personal op is untested.
5. No title-edit screen; conflicts can only arise today from complete/reopen/delete and the repo update API.
6. Restart tests use a file-backed node SQLite. Kill during an active network call is simulated, not a real process kill.
7. The browser UI tests cover reject and discard; conflict "Restore other value" is covered by the store test, not by a browser test.

## 4. Unverified assumptions
- expo-sqlite behaves like node SQLite for transactions and file durability.
- PostgREST maps TFxxx and SQLSTATE errors as the bridge and mocks assume (partly checked by postgrest_local, 13 checks, not for the new RPCs).
- 0017 and 0019 are not exercised through PostgREST/RLS under real roles.
- Real JWT expiry, token refresh and 401 behaviour.

## 5. Production risks
- 0015-0019 are unapplied everywhere hosted and need approval. Without 0019 conflict reporting falls back to client-side best effort.
- `create_personal_task` lets a raw CHECK error escape for an empty title (handled client side).
- Tombstones grow without a purge job (no correctness risk yet; storage only).
- Last-writer-wins remains the final rule for the winning value; the user is told, and can restore.

## Needs real Supabase or a device (cannot be done locally)
Hosted RLS and role behaviour, PostgREST error mapping for 0017/0019, JWT expiry, hosted migration application, expo-sqlite durability, OS background kill, connectivity events. No credentials are requested now.
