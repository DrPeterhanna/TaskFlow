# Offline Sync & Recovery: living status list
Last updated at the commit that contains this file. All evidence is LOCAL (local PostgreSQL 16 + auth shim, node/browser SQLite, headless Chrome). Hosted Supabase: none. Device: none.

## 1. Implemented
- Durable outbox (SQLite), FIFO, same op_id on every retry, exponential backoff with full jitter (2 s base, 5 min cap), inflight recovery at startup.
- Server idempotency receipts (90 days), op expiry, args-hash mismatch refusal.
- Pull with per-page atomic cursor, horizon pinning, skipped-row rewind after local ops settle (fixes the stale-after-reject defect).
- NO SILENT OVERWRITE for edits (0019 `update_personal_task_checked`, base REQUIRED): under the row lock the server REFUSES (stale_conflict) if any edited field holds a value the device had not seen, and changes nothing. The device keeps the user's intent in the inbox: "Apply my change anyway" pulls the other value first and queues a FRESH op whose base is that value (the server re-checks atomically, so a further intervening edit is refused again); "Use the other value" discards. A resend of a refused op is evaluated again. There is NO fallback to the unchecked update: on a server without 0019 the op stays queued, same op_id, and the panel says the server needs an update.
- Remote delete during a local edit: refused by the server, shown to the user.
- Full resync via `sync_status` (0017), keeps unsent work.
- Recovery UI: status chip, Sync panel (queued count, retry countdown only when truly waiting to retry, last full sync), Try now, Re-download, rejected inbox (Try again / Discard), conflict inbox (Restore other value / Keep mine / OK). EN and AR.
- Poison-op protection: DB constraint errors become visible rejections; missing server function falls back.
- 0018: completing a deleted task refused.

## 2. Verified scenarios (local)
See docs/TEST_RESULTS.txt for counts. Scenarios: offline write and flush; restart with queued ops; kill mid-send then replay (applied once); lost response; same op_id x3 in parallel; same op_id with different args; 5 offline edits plus one lost response; rejected op in the middle does not block later ops; stale-pull-after-reject; remote delete during edit; edit/edit same field (server-reported, even when no pull happened in between); edit/edit different fields; stale device edit; mid-pull crash resume; cursor below floor; forged ops on another user's task; server-controlled fields in a patch; 90-day-old op; tampered cursor.

## 3. Remaining failures / gaps (NOT done)
1. Conflict audit is incomplete. Only UPDATE is conditional. complete, reopen and delete from a stale device are still applied unconditionally (for example deleting a task another device just edited). They need conditional versions (base row_version) with the same refusal and fresh-op resolution, plus deterministic tests. NOT DONE.
1b. Baseline dependence: without 0019 no edit can sync (by design). On the baseline set (0001-0013 + 0017) 8 vitest edit tests fail for that reason. So edit-sync verification depends on 0019 (unapproved, not on 0014).
2. Reassignment, role changes and org streams are not synced offline, so conflicts there are untested by design.
3. No retention/purge mechanism is built. Required design (not done): tombstones, op receipts and old-op replay must be bounded together; the watermark must be a proven cursor position (snapshot/transaction ordering), not 'highest purged change_xid'; unsent local work must be preserved and a purged delete must never be resurrected by a full resync. Only the client reaction to a floor that was set by hand is tested. The 0010 architecture schedules the purge for a later phase; Peter has now asked for a safe design in this phase.
4. Authorization after revocation: personal-space ops depend only on the signed-in user. Tests for a suspended or role-changed org member exist at server level (test_phase2) but there is no client-queue test, because org operations are online-only. A removed/deleted account (0014, unapproved) with a queued personal op is untested.
5. No title-edit screen; conflicts can only arise today from complete/reopen/delete and the repo update API.
6. Restart: a REAL OS process (SIGKILL) was killed during an active push on a file-backed node SQLite; the next process recovered the inflight op with the same op_id and applied both ops once (restart.test). Still untested: expo-sqlite and native OS termination (device scope).
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

## Session token storage and credential history (updated)
- Session tokens now use expo-secure-store (Keychain/Keystore) through a chunking adapter (app/src/supabase/secureStorage.ts). Adapter tests (4) cover large values, shrink, torn write reads as signed out, corruption. Verified against an in-memory backend only. Real Keychain/Keystore behaviour, backup exclusion and migration of old AsyncStorage sessions: device scope, unverified.
- Correction: the database credential saved in the vault WAS used earlier for the authorised production migrations 0001-0013 (about 12:30, before the hold). It is held now and not used further. Earlier notes calling it unused were wrong.
