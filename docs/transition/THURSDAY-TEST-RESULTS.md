# TaskFlow development test record

Checkpoint: November24,2026,20:55 Cairo. This is an interim Thursday preparation record, not final acceptance. Source application changes through developmentdf7ac68 / sanitized7e1f7e3. Later documentation/test-only revisions must be recorded separately. Original project and hosted databases remain untouched.

## Implemented in this follow-up

- Personal-first workspace after registration/login. Organization join/create stays optional, not removed.
- Task-title edit UI: trim/1-300 validation, guarded local transaction/outbox, cancel and retained failed draft. An editor opened on an older title refuses saving after the displayed local title changes underneath it.
- Offline personal access after JWT expiry when a genuine secure stored session cannot refresh due to retryable network/server failure. This unlocks only local identity, not a server token or cached organization authority. Explicit local logout locks it even if remote revocation fails. Network authorization remains live/server-enforced.
- Explicit loopback debug build helper with safe JS rebundling; separate-install ARM64 package. Narrow320px input overflow fixed; English light/Arabic dark browser layouts inspected.

## Execution tiers and results

These suites overlap. Do not add their counts into a claim of independent unique tests.

| Tier | Command / configuration | Result |
|---|---|---|
| TypeScript static | app: npm run typecheck | PASS |
| Portable unit subset | app: npm run test:unit |151/151 PASS,17files |
| Full app tests | app: npm test |200 PASS,12opt-in SKIP,23passed files/1skipped file |
| Genuine local Auth HTTP adapter | TASKFLOW_REAL_AUTH_E2E=1 TASKFLOW_TEST_PYTHON=<runtime-python> npm test -- test/e2e_real_auth.test.ts |12/12 PASS, no skip in enabled run |
| Original Python local PostgreSQL shim | python tests/run.py |97/97 PASS |
| Genuine Auth SQL-role regression | runtime-python dev/real-auth/server_sync_regression.py |19/19 PASS |
| Genuine Auth/PostgREST authorization | TASKFLOW_AUTH_BINARY=<fixture-excluded-auth> runtime-python dev/real-auth/integration.py |15named PASS groups including exact catalog rollback |
| Launcher/gateway persistence | runtime-python dev/real-auth/launcher_smoke.py |signup/password/refresh/task create PASS; restart/account/session/task preservation PASS |
| Browser SQLite + PostgreSQL bridge CRUD | python tests/ui_e2e.py |8/8 PASS |
| Browser SQLite + bridge sync recovery | python tests/ui_sync_e2e.py |4/4 PASS |
| Browser SQLite + bridge title editor | python tests/ui_title_edit_e2e.py |4/4 PASS, rerun after responsive change |
| Mocked Expo SQLite adapter contract | npm test -- test/expoSqliteContract.test.ts |3/3 PASS, node SQLite mock, NOT native execution |
| Fake-backend browser auth/org | python tests/ui_shell_e2e.py |22/22 PASS, fake preview only |
| Standalone browser visual checks |320px English light and390px Arabic dark editor |PASS no horizontal overflow after fix, actual pixels inspected |
| ARM64 native compilation | app: node scripts/build-local-android.mjs |PASS with warmed dependencies; independent extracted-source rebuild also PASS |
| APK inspection | apksigner verify --verbose; aapt dump badging; ZIP ABI/bundle check |v2 signature PASS, windowsdev package, onlyARM64, embedded loopback config, no fake-demo task string |

The10genuine HTTP tests cover two offline repositories converging; lost response after real commit replaying once; stale offline delete not overwriting remote edit; cross-account pull isolation; saved old JWT denied after real logout; expired offline stored-session local unlock/reconnect/logout; file-backed UI store offline create+checked rename surviving close/reopen then syncing once on reconnect; real SDK credential cleanup when persistent local-lock writes fail; same-field stale queued title refusal with original intent retained; and lost checked-title-edit reply replay with identical operation ID and one final task.

The expired-session test uses genuinely issued Auth credentials, a test-only expired expires_at metadata value and simulated disconnected HTTP. It does not wait for cryptographic JWT expiry on a physical device. Native SecureStore and ExpoSQLite remain separate acceptance gates.

## Fresh source reproduction

A source ZIP was extracted into a new directory. npm ci --offline installed528packages from the local npm cache, typecheck/unit143/full192+7skipped passed. Its native build completed using independently installed node_modules, existing Android/Gradle caches, and bounded compile passes. It is not proof of a clean Windows machine or a network-free first install. Fresh-directory APK bytes differ because paths affect font resources, Expo fingerprint and native output; the procedure is reproducible, bit-for-bit determinism is not claimed.

Source ZIP + all five unchanged runtime archives were extracted into the actual source root.90runtime manifest entries matched SHA256 and launcher/restart smoke passed. Extracting runtime ZIPs into the source's parent puts dev/real-auth in the wrong location, so instructions now name the exact source root.

## Failures found, fixed or retained

- Long cold Kotlin/CMake compilation exceeded individual bounded runs. Single worker/in-process nonincremental Kotlin and incremental continuation completed it. No compiler error remained. Normal uninterrupted first build may take several minutes.
- Root assembleDebug tried to build dependency library lint tasks whose lint-gradle was uncached. Use :app:assembleDebug; no lint acceptance is claimed.
- First unconfigured APK was caught by embedded-byte inspection, never selected. Changing EXPO_PUBLIC values alone did not invalidate cached JS. Helper removes generated debug JS only and resets Metro transforms before rebuilding.
- ZIP lost Unix executable bit, causing gradlew EACCES in independent extraction. Helper now invokes bash on Linux. Windows wrapper not executed.
- Initial Python environment lacked pgserver; another lacked Playwright. Correct isolated runtime/PYTHONPATH reruns passed. These were environment invocation failures, not concealed app passes.
- A test-only TypeScript field mismatch was fixed, then typecheck/full suite rerun.
- Immediate reconnect assertion failed because installed Auth SDK caches a refresh failure for60seconds. Bound retry through cooldown passes. This latency remains, not bypassed.
-320px add input clipped the Add control. Actual screenshot caught it, minWidth0/fixed editor sizing fixed it. Pixel/width checks reran in English and Arabic.

## Environment and limitations

Executed on Linux x86_64 with Node22.23.5, Python3.10, JDK17.0.21.1, Android SDK/Build-Tools36, NDK27.1.12297006, CMake3.22.1, Gradle9.4.1. Memory-constrained one-worker compiler,1300MB heap/384MB metaspace, in-process nonincremental Kotlin. Browser is Chrome/Playwright. No paid service or API credits.

NOT TESTED: Windows, Android Studio UI, WSL2 forwarding, USB, Android installation/launch, Galaxy A56, native SQLite/SecureStore persistence, Android keyboard, actual device process kills/backups/reinstall, background/killed-app sync, hosted Supabase/production deployment, high-scale throughput. No emulator was available. API24minimum/36target and ARM64 package metadata alone are not Galaxy acceptance.

Foreground periodic check60seconds; failed refresh cooldown60seconds; simulated expired offline boot took about25seconds of SDK retries before local access. Reconnect acceptance should allow roughly two minutes plus request time. Cached data cannot learn remote revocation while disconnected. Offline local logout is not a successful global/server logout. Local SQLite task data is plaintext in the app sandbox.

## Rollback and safety

Keep original refs, original project and all six delivered ZIPs. Work is on the approved development branch and separate sanitized source. No task data/queue cleanup or forced migration is added. Do not uninstall/clear storage to address signing conflicts. Source Windows builds have computer-local debug signer and may not update a supplied APK using the same package. Preserve data before changing anything. Local backend rollback was tested against exact captured catalogs, but running it restores weaker authorization and requires stopped writers; never target an original/hosted database.


## Bounded independent review follow-up

A separate read-only source review found hostname-only session storage did not match full-origin task database partitioning. The current fix uses a full-origin, SecureStore-safe v2 session and logout-lock key. It leaves legacy saved credentials and task queues untouched, does not silently adopt them, and requires one fresh online sign-in. It adds token-callback lock checks before and after current-session retrieval. Failed persistent lock writes immediately deny tokens in memory, still attempt SDK cleanup, and expose an explicit unconfirmed-local-logout warning and retry. A separate message distinguishes local sign-out from unconfirmed server revocation.

The reviewer initially raised an SDK token-retention concern. Inspection of the actual installed Auth SDK showed local-scope logout removes local session before its HTTP request, including retryable refresh failures. Genuine SDK tests verified stored credentials are removed even when network logout and lock persistence fail. The review claim was corrected, not treated as a proven bug. Lock checks remain defense in depth. No unsupported private SDK reset method or arbitrary offline age cap was added. This was bounded review, not security certification. Native storage failure behavior remains unverified.

The bounded follow-up review found the source-confirmed origin/lock/token-callback issues resolved with no new blocking source issue. The reviewer did not independently run tests, inspect the installed SDK or execute native behavior. If both durable lock persistence and SDK credential cleanup fail, logout across restart cannot be guaranteed. The app must retain its explicit unconfirmed-local-logout warning; do not hand over the device or clear/uninstall it as a workaround. A regression test covers this combined failure and verifies current-process denial plus the warning. Fresh-signin unlock-storage errors can still appear as a generic network message, a fail-safe UX limitation, not permission to bypass the lock.


## Cursor blocker found and repaired at20:44-20:55

The extra 50-task/150-operation genuine HTTP run FAILED at20:43. All writer batches drained, but a fresh reader rejected an inconsistent page cursor before applying it. The preserved failing log is genuine-churn150-ops.txt. Diagnostic read found next_xid998 while the final ordered row was1001. PostgreSQL resolved the unqualified ORDER BY change_xid in a scalar subquery to its selected change_xid::text alias, so cursor candidates were sorted lexically rather than numerically when their decimal widths differed.

LOCAL proposal0025_sync_pull_numeric_cursor.sql qualifies q.change_xid, retaining its xid8 type for ordering. No cursor validator was relaxed. No operation was discarded, rewritten or acknowledged by this repair. Original migration0010 is retained unchanged for history. Fresh local backend manifest now includes0025 and still excludes0014 and lifecycle0015.

Exact expanded results:
- Deterministic SQL 9/10/100 boundary regression: PASS in shim and genuine-Auth SQL-role suites, with short/full pages and exact next cursor assertions.
- Original five10-task offline batches, create+rename+complete, disk close/reopen/reconnect, fresh reader: PASS.
- Added separate OS-process Node acceptance: 50 tasks,150 durable operations, process exit after offline creation; three sync processes lose replies AFTER genuine server commit at selected calls; fourth process replays and drains all150.153 transmissions contain150 unique operation IDs. Each transmission uses the original persisted RPC,args and ID. Replay results match; all150 states are acked, no rejected/dead/queued operation remains. Another reconnect transmits0 operations.
- Fresh reader uses page size7: eight pages produce50 unique tasks, exact final title/status match and row_version3 for EVERY task. This verifies one create, one title update and one completion per task in this scenario, despite three duplicate transmissions.
- Third pull response interrupted after server response:14 rows and last committed cursor retained; reader process exits. New process resumes same disk DB and converges to50 records, exact fields and version3. Separate empty reader independently converges through8 pages.
- Entire enabled genuine HTTP suite:12/12 PASS,100.9sec. Full app200 PASS+12 opt-in skips separately; portable151PASS; typecheckPASS; shim97/97; genuineAuth SQL-role19/19; authorization15named groups including rollback; launcher/account/session/task restartPASS. Wrong Python interpreter initially failed the genuine SQL-role setup with missingpgserver, then rerun using packaged runtime passed19/19. An earlier batched command timeout interrupted an enabled run; it is not counted as passing.

Evidence: numeric-fix-process-churn.txt, numeric-fix-genuine12.txt, numeric-fix-server97.txt, numeric-fix-auth-server19.txt, numeric-fix-authz15.txt, numeric-fix-launcher.txt, numeric-fix-app212.txt, numeric-fix-unit151.txt. These are Linux local evidence, not Expo SQLite or SecureStore or Android execution. None prove native persistence or Windows/WSL/USB behavior.

Existing initialized local launchers fail closed on SQL inventory change. They do NOT silently upgrade/reset/delete. A tested explicit data-preserving upgrade/rollback path and updated packaged source are still pending. The six delivered files remain unchanged and contain the older backend without0025. The native APK is unchanged and does not embed backendSQL. Offline Sync remains incomplete for final acceptance; the reproduced cursor defect now passes the requested local regressions, with native/device and package-upgrade gates still open.

20:56 follow-up: explicit local-only0025 upgrade tool now PASS on a disposable exact pre0025 backend. Live launcher lock refuses upgrade. After stopping backend, exact inventory-gated one-function transaction passes, duplicate invocation is no-op. Current source restarts and preserves account/password/signing-key/saved-session/task and row version. Original stored app data and outbox are not opened by the tool. Private pre-function/inventory recovery files preserved. See dev/real-auth/upgrade-cursor-0025.md. Windows execution and operator rollback instructions remain untested; current delivered six files are still unchanged. Newly packaged corrected source has not yet been uploaded.


21:08 reproduction: extracted2100ZIP in another independent directory; npm ci --offline528packages/typecheckPASS. Initial test setup deliberately refused mismatched runtime (development Auth binary7db9... against sanitized manifestd9a4...), then corrected to the unchanged delivered sanitizedAuth runtime. No integrity check disabled. Repeated process churnPASS and entire enabled genuineHTTP12/12PASS against sanitized fixture-excludedAuth,101.3sec. Sanitized authorization15namedgroups/rollback alsoPASS. Thus the passing delivery-source evidence is not reliant only on the different development binary.

21:08 rollback follow-up: upgrade_cursor_smoke now additionally stops current backend, restores preserved exact prior function in transaction and priorinventory, verifies exact function definition, restarts oldsource and verifies account/password/key/token/task still preserved. PASS on Linux disposable backend. No standalone rollback tool or Windows test claim. SourceZIP2100 remains immutable older checkpoint; latest test-only/docs follow-up is a later revision and will be included in the next final package.
