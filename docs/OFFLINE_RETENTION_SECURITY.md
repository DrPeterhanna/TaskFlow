# Offline sync retention and security decision

Status: LOCAL IMPLEMENTATION REVIEW. No production readiness or external audit claim.

## Retention stays disabled

No automatic tombstone, receipt, rejected/dead operation, conflict, local database, or cursor deletion is added. Unsent operations never expire silently. A terminal server `op_expired` response moves an intent into the visible rejected inbox with original payload/ID retained. No automatic fresh-ID replay: that could duplicate an operation whose old receipt no longer exists. Explicit user recovery must first inspect current server state and submit a separately confirmed fresh intent.

Server acceptance is based on UUIDv7 timestamp, not client enqueue age. The current source rejects IDs older than90days and more than1day ahead before receipt lookup. Clock correction does not authorize changing a sent ID. A bad local clock can cause visible refusals; device-clock UX and trusted clock calibration remain future work. The UUID generator's per-process monotonic floor may remain ahead until restart after a large clock jump, so no hidden regeneration is implemented.

The existing `sync_floor` read protocol is not a safe purge producer. Taking the maximum transaction ID among purged rows can leap over an older still-running transaction that later commits. Publishing that as a safe watermark can resurrect deleted rows or skip unseen changes. No scheduled cleanup, SQL purge function, or guessed watermark is introduced.

Before enabling cleanup, require:
- A transaction-consistent cut with no earlier in-flight writer able to commit behind it; preserve tombstones past the supported offline horizon and backup/restore windows. Prove this under real database isolation and concurrent transactions, not wall-clock ordering.
- A durable, atomic relationship between deleting tombstones and advancing the floor. Floor must never overstate what disappeared, and each stream/client scope must be defined.
- Reconnect below floor triggers full snapshot replacement before trusting incremental state. Current repair stages data before atomic cache replacement, preserves pending intents, then repulls from zero. A multi-page RPC horizon is not an MVCC snapshot: coordinated snapshot tokens or another proved protocol is still required before purge.
- Receipt lifetime must cover the full server acceptance window, retries and restoration. Cross-window replays must refuse before lookup and must never auto-regenerate operation IDs. Old app clients and restored backups must follow the same rule.
- Model tests for long-running transactions, old clients, lost responses, restored backups, interrupted purge/floor commits, anti-resurrection and disk/network failure, plus hosted/device evidence and an independently reviewed deployment/rollback plan.

The safe local choice is unbounded retention until these gates pass, with a documented future capacity plan rather than unsafe cleanup. No claim that finite-retention safety has been proved.

## Reviewed local controls

- SQLite databases are separated by exact environment URL and account ID. No automatic adoption of ambiguous pre-release `tf_<uid>.db` files. Those files remain intact; verified-environment import needs a separate tested path before existing pre-release users upgrade.
- Hosted worker uses a dedicated token callback that rejects a session with a different user ID, plus before/after request checks. Identity transitions permanently invalidate old workers, even A→B→A; store disposal stops scheduled work and prevents late response application.
- UI cache and membership are tagged with owner to avoid rendering old-account state during React effect cleanup. Offline personal access grants no cached organization permissions. Every server operation still checks server authority/RLS.
- Queue payload/opID/RPC are immutable after first transmission. Stable IDs support receipt replay. Local0023adds a versioned safety capability. Hosted/bridge delete workers require safetyversion2before destructive transmission, so existing0020is not trusted merely because its function exists. Checked RPC absence queues work with a server-update warning, never fallback to unsafe unchecked calls.
- Local0021requires all patch bases and exact descendant ID+version tokens. Dirty descendant state refuses destructive intent. Coarse writer lock serializes descendant edits/inserts. Concurrent stress reproduced a table/receipt/row lock-order deadlock; local0024now takes a global personal-RPC advisory lock before all those locks. This fixes the tested internal RPC cycle but deliberately serializes personal writes across accounts and is not a scale endorsement. Local0022rejects creating a child under a deleted parent. No WIP code was merged.
- Resync and explicit conflict refresh serialize with normal sync. Cache replacement is atomic and preserves pending intents, with100krow staging cap. Exceeding the cap refuses repair without deleting old cache.
- Corrupt/newer SQLite schemas refuse opening rather than resetting. Local write failures keep draft text and expose recovery. Automatic corruption repair/export is not implemented because it could erase evidence or unsent data.
- Auth secrets retain the existing SecureStore chunked backend. SQLite business data is plaintext in the OS sandbox. Device lock/backup policy, SQLCipher/encryption key handling, secure delete, native filesystem permissions and physical-device logout/reinstall behavior are not verified. Do not advertise encrypted local data.
- Test HTTP bridge is loopback-only disposable infrastructure with privileged assertion endpoint, no real authentication. Never deploy or expose it. SIGTERM now waits for cleanup rather than orphaning local PostgreSQL.

## Remaining acceptance work

Native iOS/Android offline cold boot, refresh-token failures/revocation, real connectivity/foreground timing, process kill while ExpoSQLite is writing, storage quota/corrupt-file UX, cross-account visual tests, secure-store/backups and background behavior. Hosted PostgREST signatures/RLS/session pooling/realtime not validated here. Independent security review and load testing remain required. Coarse deletion/global personal-RPC lock is correctness-first, not a production throughput endorsement.

## Next safe action

Review local diff/commits, then approve a disposable hosted staging environment and native development-build validation separately. Do not migrate production. Resolve pre-release local DB import/encryption policy and snapshot-retention protocol before any broad release or purge enablement. The local offline work does not authorize beginning unrelated full-product features.

## Maintenance boundary

The global advisory lock coordinates RPC callers, not arbitrary owner/admin SQL. A maintenance transaction holding a task row can still invert row/table ordering against a destructive RPC. Do not run such maintenance concurrently with writes. A future hosted runbook must quiesce writes or acquire the same advisory lock before any receipt/row/table lock, and test migration/rollback behavior. This local-only implementation is not permission to run maintenance in production.
