# TaskFlow progress record (updated 2026-11-24 12:02 EET)

## Phase 2 (database, auth, security, hierarchy, offline/audit foundation)
Built and tested locally (PostgreSQL 16.2, 45 tests): migrations 0001-0013. Personal RPC set is now complete except attachments (Phase 11).
HOSTED VERIFICATION: BLOCKED (needs Peter's Supabase project). Phase 2 is NOT fully complete: "schema on staging" and
real-JWT/PostgREST checks are pending. See docs/HOSTED_VERIFICATION.md.
Remaining Phase 2 items: sync_floor purge job and reconcile/full_resync_required (server side, Phase 5 hardening), my_day_items (needs Phase 4 tasks).

## Phase 3 (app foundation), started in parallel because it is independent of Supabase (updated 12:20)
Done (13 Vitest tests, tsc strict): app/src/sync: SQL driver interface, local schema, UUIDv7 (monotonic), durable outbox
(FIFO, dependencies, backoff, rejection cascade, crash recovery), push/pull engine (cursor + pinned horizon applied atomically,
pending-row protection, tombstones), PersonalTaskRepo (optimistic write + op in one transaction).
Not done: Expo project and expo-sqlite adapter, design system, navigation, i18n/RTL, CI, Sync Inbox UI, reconcile mode,
account-scoped files, and the sync spike against real Supabase (hard gate, blocked). Nothing here has run on a device.

Update 12:20: 22 app tests (Vitest) incl. 7 against the LOCAL Postgres RPCs via tests/bridge.py (not Supabase): create/push/pull,
lost response replay, rejection rollback, offline-flush, crash recovery. Rejected optimistic writes now roll back (base_json).
UI: personal tasks screen (tokens, EN and AR/RTL), SQLite-backed store, expo-sqlite adapter (type-checked only, NOT run on a device).
Web preview rendered in headless Chrome (in-memory preview data). Not done: device run, reopen/edit UI, Sync Inbox screen,
reconcile mode, auth screens, navigation, CI, sync spike on real Supabase, My Day, team tasks, attachments.
