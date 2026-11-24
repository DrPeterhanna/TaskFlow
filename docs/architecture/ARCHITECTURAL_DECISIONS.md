# Architectural Decisions

> Status: proposal for approval. Behaviors described are intended design. Nothing here has been implemented, executed or validated yet. See TESTING_STRATEGY section 0.

Format: Decision, options considered, rationale, consequence. Status Proposed until approved.

## Decisions
**ADR-001 Backend: Supabase (Postgres) as specified.** Alternatives: Firebase (legacy), custom Node API. Chosen: matches brief; SQL constraints and RLS fit hierarchical authz; no server to operate. Consequence: logic in SQL/plpgsql, needs strong pgTAP coverage.

**ADR-002 All writes via RPC; table writes revoked.** Alt: RLS write policies. Rationale: single enforcement point, idempotency, event emission, server-controlled fields. Cost: more functions.

**ADR-003 Hierarchy: adjacency list + closure table.** Alt: ltree, recursive CTE only. Closure gives fast indexed scope checks in RLS; trigger maintenance and cycle guard. ltree is a viable alternative; closure chosen for portability and simpler policies.

**ADR-004 Roles on membership, authority via unit position.** Alt: arbitrary ACLs. Four fixed roles plus scoped grants cover brief with less complexity.

**ADR-005 Tasks in one table with parent_id, depth <= 2.** Alt: separate subtask table. One table simplifies sync, dependencies, events. Depth by trigger.

**ADR-006 Personal space in separate tables, owner-only RLS, own owner-only history, not in org events/analytics.** Alt: is_personal flag on shared tables (one policy mistake would expose data). Separate tables give structural isolation. Capability parity with team tasks (subtasks, recurrence, attachments, history) is kept; privacy restricts readers, not features. Confirmation requested.

**ADR-007 Local DB: expo-sqlite; custom outbox + commit-safe pull sync (change_xid + snapshot horizon, access epochs, tombstone floor).** The earlier global-sequence cursor was rejected because it can skip rows from transactions that commit late. Alt: WatermelonDB, PowerSync, RxDB, TanStack persisted cache. Custom retains RLS fidelity, no extra vendor, fits Expo; cost is engineering risk (mitigated by chaos tests, review gate end of Phase 5).

**ADR-008 Server-stamped completion time with client claim stored.** Trust over fidelity.

**ADR-009 Realtime as ping only.** Prevents payload leakage and filter edge cases.

**ADR-010 Recurrence: rule + materialized occurrences (8 weeks).** Simplifies offline and analytics.

**ADR-011 Week Saturday to Friday, org timezone for boundaries.** Default timezone Africa/Cairo.

**ADR-012 Hash-chained append-only events with external anchoring.** The chain detects gaps, edits and deletions by anyone who cannot rewrite it, including bugs and compromised app roles. It does NOT protect against a privileged database operator (superuser or table owner), who can rewrite rows and recompute the chain. Mitigation: daily signed chain-head export to a separate write-once location under different credentials [OPEN: who holds it]. Without anchoring, claim only accident and non-privileged tamper evidence.

**ADR-013 Rescheduler and balancer are deterministic rules, no ML.** Explainable, testable, offline-capable; LLM explanation optional later.

**ADR-014 Expo managed workflow + dev client + EAS.** Fewer native maintenance burdens; config plugins for native needs.

**ADR-015 Monorepo with shared zod package.** One validation source.

**ADR-016 Fractional-index keys with id tiebreak and server rebalance.** Not conflict-free (equal keys and key growth are possible). Gives deterministic total order, last-arrival-wins reorders, no data loss.

**ADR-017 Push via Expo Push Service, in-app inbox is source of truth.**

**ADR-018 Attachments: quarantine upload, Edge validation, signed URLs.**

**ADR-019 Idempotency via op_receipts (user_id, op_id, rpc, args_hash, result) written atomically with the mutation.** Concurrent retries serialize on the unique key, argument mismatch returns op_id_reuse, rejections store nothing.

**ADR-021 Concurrency: per-org structure advisory lock plus ordered row locks (root to leaf) with checks re-read under lock.** Alt: SERIALIZABLE everywhere (retry storms with offline replay).

**ADR-022 Conflict policy: field-level compare-and-set for team data, last-arrival-wins for owner-only data and My Day registers.** One policy, defined in OFFLINE_SYNC section 11.

**ADR-020 i18n with i18next; RTL by language; Cairo font bundled.**

## Proposed defaults (change freely)
Org timezone Africa/Cairo; capacity 25 h/week; focus slots 3; attachment max 15 MB; hierarchy soft cap 6 levels; single org per user; nudge cap 1/24 h/task; follow-up edit window 15 min; recurrence horizon 8 weeks; JWT 1 h; password min 10; event retention indefinite; platforms iOS+Android; no web.

## Open decisions (need Peter)
1. Legacy material: please share the old requirements and development history (read-only), including any lists of past defects or test failures you want covered. None has been supplied, so nothing from it is reflected here.
2. Can a user use the app with no organization (personal-only)? Default yes.
3. Multi-organization membership per user now or later? Default later.
4. Can members see peers' tasks in the same unit? Default no.
5. Exact permission list for delegated grants and who may delegate.
6. Workload: weekly capacity default, working days (Sat-Thu? Sun-Thu?), holidays and leave handling.
7. Is "on time" measured on server completion time or offline claim time? Default server.
8. Metric edge cases: reassigned and reopened tasks attribution (defaults in PRODUCT_REQUIREMENTS section 6).
9. Is Hijri calendar display required? Default no.
10. Local DB encryption requirement (SQLCipher) vs OS protection.
11. MFA for admins required?
12. Target markets and legal regime (data residency, retention, export/delete).
13. Languages beyond Arabic/English? Who reviews Arabic copy?
14. Web or tablet-first needs? Default phone only.
15. Whether an LLM may ever be used for rescheduling explanations (data privacy).
16. Release plan: store accounts (Apple/Google), bundle id, app name availability, Supabase region and project ownership/billing (these require Peter's accounts and approval; no money committed by this package).
17. Team size, budget and deadline expectations against the conditional estimate in DEVELOPMENT_ROADMAP; which P1 items can be cut.
18. Personal space capability: confirm parity with team tasks (subtasks, recurrence, dependencies, attachments, owner-only history) or choose a narrower scope.
19. Audit anchoring: who holds the external write-once chain-head copy, or accept limited tamper evidence.
20. Tombstone and receipt retention (default 90 days) and acceptance of a full resync after longer offline periods.
21. Whether completing the last required subtask should offer (not force) parent completion. Default: offer only.
22. Approval protocol: Peter's review of these 12 documents as a whole, or per document.

## Approval gate
Implementation starts only after Peter explicitly approves this package after reading it. Earlier "Approved" message preceded delivery and does not count.
