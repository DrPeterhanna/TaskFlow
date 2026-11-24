# Testing Strategy

> Status: proposal for approval. Behaviors described are intended design. Nothing here has been implemented, executed or validated yet. See TESTING_STRATEGY section 0.

## 0. Status: tests actually run vs required
Executed so far: none. No application, database, or migration exists. The only checks run were rendering the documentation diagrams and a text search for contradictions in these documents.
Everything below is a REQUIRED FUTURE test. No guarantee in these documents is validated until the matching test is executed and reported with real results. Local database tests are never reported as real Supabase verification. Production readiness is not claimed without physical-device testing and a verified deployment.

### Per-phase quality bar (from the directive)
Every phase must run: unit tests, database tests, RLS authorization tests, API integration tests, offline tests, edge-case tests, regression tests, negative tests, mutation testing for critical invariants, linting, type checking, and build verification. Passing results are reported only after execution, with commands and outputs.
Critical invariants for mutation testing: depth <= 2, hierarchy and dependency acyclicity, required-subtask completion gate, server-stamped completion time, personal-data isolation, idempotent receipts, no-purge-from-partial-inventory, audit append-only. Tool proposal: Stryker for TypeScript, hand-written mutants (altered SQL conditions, removed policy) for SQL.
Environments: local Supabase (CI) for speed, a real staging Supabase project for authorization, RLS, realtime, storage and Edge Function verification, and physical iOS and Android devices for offline, push, RTL and performance.

## 1. Pyramid
| Layer | Tooling | Scope |
|---|---|---|
| DB unit | pgTAP via Supabase CLI | constraints, triggers (depth, cycles, gate), RLS, RPC |
| Authorization matrix | pgTAP generated from AUTHORIZATION_MATRIX.md | every role x action, expected allow/deny |
| Contract | zod schemas + RPC contract tests against local Supabase | args/returns/errors |
| Unit | Jest | time/week logic, metrics, rescheduler rules, sync reducers |
| Component | React Native Testing Library | components, RTL, themes |
| Sync | Jest + in-memory SQLite + fake server, property-based (fast-check) | ordering, idempotency, conflicts |
| E2E | Maestro (default; Detox alternative) | journeys on iOS sim and Android emulator |
| Visual | screenshot diff light/dark, LTR/RTL | design regressions |
| Performance | seeded 50k tasks, Flashlight/Perf traces | startup, scroll, sync time |
| Security | negative tests, dependency audit, secret scan, MobSF, external pen test | |
| Accessibility | axe-like RN checks, manual VoiceOver/TalkBack | |

## 2. Deliberate unauthorized attempts (mandatory suites)
- Cross-org read/write for each table and RPC.
- Member updating another's task, forging role, org_id, completed_at, creator.
- Leader acting on peer or ancestor unit.
- Admin reading personal tasks, notes, My Day (must fail).
- Manager inferring personal data through analytics (checked by schema and results).
- Direct table INSERT/UPDATE/DELETE bypassing RPC (must fail).
- Hierarchy cycle creation and closure corruption attempts.
- Invitation code brute force, reuse after exhaustion/expiry/revocation.
- Attachment IDOR, wrong mime, oversize, double-extension, path traversal.
- Push token hijack and cross-user registration.
- Audit tamper: UPDATE/DELETE/TRUNCATE on events, chain break detection.
- Replay of op_ids with altered args (must return original result, not new effect).
- Expired/suspended membership continues to call RPC.
If legacy bug or test-failure lists are supplied later, each item gets a named regression test. Until then no assumptions are made about them.

## 2b. Concurrency and sync-correctness suites
- (Required, not yet run) Commit-order skip test: hold a write transaction open, commit later-started transactions, pull, then commit the first; assert no row is skipped across sessions and pages.
- Access change: grant, revoke, unit move; assert backfill, purge, and rejected pending ops are visible.
- Tombstone floor: client older than floor gets full_resync_required.
- Idempotency: concurrent identical op_ids, same op_id with different args, rollback of first attempt, crash between mutation and response.
- Races (multi-session harness): two unit moves forming a cycle, two dependency adds forming a cycle, complete-parent vs add-required-subtask, complete-child vs reopen-parent, concurrent reorders with equal keys, My Day add vs remove from two devices, focus-limit race.
- Field-level conflict: same field vs disjoint fields.

## 3. Sync chaos tests
Kill app at every step of push and pull; airplane mode flips; duplicate delivery; reordered responses; clock skew +/- 24 h on device; two devices editing same task; token expiry mid-sync; server rejection of middle op in a dependent chain; 10k op backlog replay. Invariant checks: no lost op, no duplicate effect, eventual convergence, outbox visible.

## 4. Time and locale
Fixtures for Cairo, UTC, US zones, DST changes; week boundaries Saturday 00:00 local; Friday end-of-day deadlines; Arabic-Indic and Western digits.

## 5. CI gates
PR: lint, typecheck strict, unit, component, pgTAP, contract, migration lint (no destructive ops without ADR), RLS/definer lints, bundle size budget. Nightly: E2E, visual, perf, chaos. Release: full suite + manual checklist + staging soak 48 h. Coverage targets: DB authz 100% of matrix cells, shared logic 90%, UI 70%.

## 6. Test data
Seed generator with orgs of varied shapes (flat, 6-level deep, 2k members). Deterministic seeds.

## 7. Definition of done (per feature)
Tests at relevant layers, authz cases added, offline behavior declared and tested, RTL + dark checked, events emitted, docs/ADR updated.
