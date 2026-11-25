# Development Roadmap, Risks and Milestones

## 1. Ordering principle
Offline machinery and audit capture are foundations, not later features. Phases keep the names from the directive, but each phase's scope is split into "foundation work" (must exist before dependents) and "UI expansion" (can come later).

| Phase | Scope | Exit criteria |
|---|---|---|
| 0 | Discovery, requirement consolidation | Requirements doc, open decisions closed or defaulted by Peter; legacy reconciliation if material is supplied |
| 1 | Architecture and design approval | Revised 12 docs approved by Peter. **Hard gate** |
| 2 | Database, migrations, auth, security, hierarchy. Foundation items: sync columns (change_xid, row_version, field_versions, tombstones), access epochs, op_receipts, emit_event plus hash chain for every RPC, personal tables with owner-only history, structure locks, all authz negative tests | Schema on staging; authorization matrix and concurrency suites green; commit-skip test green |
| 3 | Design system and app foundation. Foundation items: local SQLite layer, account-scoped files, repository interface, outbox, push and pull workers, reconcile mode, idempotent replay, Sync Inbox skeleton. **Sync spike gate**: prove cursor, reconcile and receipts against real Supabase | Tokens, components, i18n/RTL, nav shell, CI; sync spike passes chaos subset or fallback ADR chosen |
| 4 | Core tasks, scheduling, recurrence, subtasks, dependencies. Every write goes through repository, outbox and RPC, so features are offline-capable from the first screen | CRUD, Sat-Fri week, gates, recurrence, field-level conflicts, events emitted, offline behavior per table in OFFLINE_SYNC |
| 5 | Offline hardening: conflict cards, attachment upload queue plumbing, large-backlog replay, recovery from corruption, tombstone floor resync, full chaos suite | Chaos suite green; two-device convergence tests green |
| 6 | Follow-ups, notifications, team management (Team Pulse basics, gentle reminders, push tokens) | Threads, push, daily summary, dedup |
| 7 | Timeline and audit UI: task timeline, org audit views, chain verification job, anchoring if approved | Views and verification live (capture already exists since Phase 2) |
| 8 | My Day UI and personal productivity UI (data layer, sync and history already exist) | Daily plan, focus, personal space features, privacy tests |
| 9 | Analytics and workload balancing | Metrics per definitions, proposals with approval |
| 10 | Smart rescheduling | Rules engine, approval flow, events |
| 11 | Attachments and evidence (storage, validation, evidence history, offline queue integration) | Private storage, validation, signed URLs |
| 12 | Full-system integration: end-to-end flows across all features, real Supabase staging, cross-feature offline and authorization regression, data migration dry runs | All journeys pass on staging and physical devices; no open critical defects |
| 13 | Independent security, performance and quality audit: review by someone who did not build it, pen test, load and battery tests, accessibility review, RLS and concurrency re-verification | Audit report; all critical and high findings fixed and retested |
| 14 | Production readiness and release: production Supabase project, backups and restore drill, monitoring and alerting, runbooks, store submission, physical-device sign-off, deployment verification | Verified deployment and sign-off; only then may readiness be claimed |

Phases may be subdivided but architectural dependencies are not skipped. Execution is one phase at a time, after architecture approval.

### Phase report format (every phase)
What was built; files created; database migrations; tests executed; test results; known limitations; next phase dependencies. Tests are reported only if executed.

### Governance (from the directive)
New project directory and new Git repository, old project untouched; ordered migrations; meaningful commits at milestones; controlled dependencies; maintained documentation; backups before destructive operations; no silent replacement of architectural decisions; no nonfunctional UI controls; no removing tests to hide failures; no weakening security for convenience.

## 2. Planning estimate (conditional, not a commitment)
Rough effort, for planning only: about 28 to 44 calendar weeks to a store-ready release including Phases 12 to 14, central case near 34.
Assumptions that move the number:
- one lead engineer with AI assistance, no other team members;
- open decisions closed within about two weeks of approval;
- no large legacy reconciliation (if legacy material has many unstated rules, add 2 to 4 weeks);
- the sync spike passes (a failed spike and a switch to a managed sync layer shifts effort, direction unknown until tested);
- Supabase, Apple and Google accounts available when needed; store review time excluded;
- scope as in PRODUCT_REQUIREMENTS with P1 items cut first if needed.
It will be re-baselined at the end of Phase 3, when the riskiest unknowns are tested.

## 3. Milestones
M1 architecture approved. M2 secure backend with audit capture on staging. M3 sync spike result plus app foundation. M4 offline-capable core tasks (internal alpha). M5 hardened offline plus team features (closed beta). M6 intelligence features. M7 release candidate.

## 4. Risk register
| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Legacy requirements not supplied, so rules rest on the directive alone | H | M | Request material, reconciliation pass, explicit open decisions |
| R2 | Custom sync defects | M | H | Commit-safe cursor design, spike gate, property and chaos tests, fallback ADR |
| R3 | RLS/RPC gaps leak data | M | H | Authorization matrix tests in CI, independent review, pen test |
| R4 | Concurrency races from offline replay | M | H | Locks, race harness |
| R5 | RN RTL quirks | H | M | RTL screenshots in CI from Phase 3 |
| R6 | Expo/library compatibility (SQLite encryption, lists, notifications) | M | M | Phase 3 spikes, pinned SDK |
| R7 | Push reliability | M | M | In-app inbox as source of truth |
| R8 | Scope vs timeline | H | H | Gates, cut P1 first |
| R9 | Hierarchy scope query cost | L | M | Closure table, indexes, load test |
| R10 | Store review requirements (account deletion, privacy labels) | M | M | Delete-account flow, privacy manifest early |
| R11 | Time zone and week boundary bugs | M | M | One time module, fixtures |
| R12 | Personal data reaching team views | L | H | Separate tables, schema lint, tests |
| R13 | Supabase cost and limits | L | M | Budget, monitoring |
| R14 | Audit chain over-claimed | L | M | Qualified wording, optional anchoring |

## 5. Working agreements
No implementation before the gate. Old project untouched. Each phase: ADRs updated, migration review, tests green, demo.
