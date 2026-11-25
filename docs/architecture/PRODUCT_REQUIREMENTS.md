# TaskFlow 2.0 Product Requirements

> Status: proposal for approval. Behaviors described are intended design. Nothing here has been implemented, executed or validated yet. See TESTING_STRATEGY section 0.

Status: DRAFT for approval. Phase 0 and Phase 1 output. No code exists.
Legend: **[DEFAULT]** = proposed by the architect, change if you disagree. **[OPEN]** = needs your decision (all collected in ARCHITECTURAL_DECISIONS.md section "Open decisions").

## 1. Inputs and honesty note
- Source: your Nov 23 master directive. The old TaskFlow code and chat history have NOT been supplied. Section 3 of the directive lists what they contain, but I have not seen them. Requirements below come from the directive only. When the old material arrives (read-only) a reconciliation pass will add or correct items. Nothing here assumes old technical choices.
- Greenfield: new repo, new Supabase project, new migrations, new UI. Old project is never modified.

## 2. Personas
| Persona | Goal | Key needs |
|---|---|---|
| Member | Do my work, plan my day | My Day, tasks, subtasks, follow-ups, private space |
| Team Leader | Keep my team on track | Team Pulse, assign, gentle reminders, reschedule approvals |
| Supervisor | Oversee several teams | Cross-team visibility, workload balance, escalations |
| Administrator | Run the organization | Org/hierarchy/roles, invitations, delegated permissions, audit |
| Individual (no team) | Personal productivity | Personal space only, works without an org [OPEN: allowed?] |

## 3. Capability requirements (A to M)
Priority: P0 = launch, P1 = launch+1 phase. Phase = roadmap phase.

### A. Authentication and Organization (Phase 2)
- A1 Email/password sign-up, sign-in, reset, email verification (Supabase Auth). P0
- A2 Profile: name, avatar, language, theme, timezone, reminder time. P0
- A3 Create organization (creator becomes Administrator). P0
- A4 Org units (teams) in a tree of unlimited depth, [DEFAULT] soft cap 6 levels. P0
- A5 Invitations: single-use or limited-use codes, expiring, role pre-set, revocable; delivered by link or code. P0
- A6 Roles: Administrator, Supervisor, Team Leader, Member. P0
- A7 Delegated permissions: named grants (e.g. can_assign, can_invite, can_view_team_analytics) scoped to a unit subtree, expiring, revocable. P1
- A8 Server-side authorization only (RLS plus RPC). P0
- A9 Hierarchy cycle prevention, enforced in DB. P0
- A10 A user belongs to exactly one org. [DEFAULT] Multi-org later without schema redesign (membership table already keyed by org). [OPEN]

### B. Task Management (Phase 4)
- B1 CRUD, assign, reassign, soft delete. P0
- B2 Daily and weekly scheduling. Week is Saturday to Friday. P0
- B3 Priority: low, normal, high, urgent. P0
- B4 Start date, due date, optional due time, deadline vs planned date kept separate. P0
- B5 Status: todo, in_progress, blocked, done, canceled. Overdue is derived, not stored. P0
- B6 Recurring weekly tasks (weekday set, optional end). Occurrences are materialized rows. P0
- B7 Smart carry-over: unfinished tasks from a past day roll to a suggestion, never silently moved (see K). P1
- B8 Realtime updates for team tasks. P0
- B9 Completion timestamp assigned by server only; device time stored as claim. P0

### C. Subtasks and Dependencies (Phase 4)
- C1 Max depth: root, child, grandchild (two levels below root). Enforced by trigger. P0
- C2 Subtask flag: required or optional. P0
- C3 Parent cannot complete while any required descendant is open (server-enforced). P0
- C4 Progress = weighted share of done descendants (definition in section 6). P0
- C5 Reorder and reassign subtasks. P0
- C6 Dependencies: task A blocks task B (same org, acyclic, DB-checked). B cannot start/complete until A done. P1
- C7 All of the above work offline with deterministic replay (see OFFLINE_SYNC_ARCHITECTURE). P0

### D. Personal Space (Phase 8 UI; schema, sync and audit capture from Phase 2/3)
- D1 Personal tasks and notes visible only to the owner. No role, including Administrator, can read them. P0
- D2 Personal data never joins team analytics, org audit, or notifications to others. P0
- D3 Personal tasks support the same planning capability as team tasks: subtasks (same two-level limit, required/optional, parent gate), recurrence, dependencies (P1), attachments, and an owner-only history. [DEFAULT, confirm: this is my reading of "completely private personal tasks"; a narrower personal space is an option] P0
- D4 A personal or team task can be placed in My Day privately. P0
- D5 Owner-only productivity stats computed from personal data. Excluded from admin export and org analytics. Deleted on account deletion. P0

### E. Team Pulse and Management (Phase 6, 9)
- E1 Team overview: counts by status, overdue, due this week. P0
- E2 Per-member progress and workload, visible to those with authority over that member only. P0
- E3 Gentle reminder: a rate-limited, kind nudge from a manager. P0
- E4 Manager feedback and follow-up requests on a task. P1

### F. Follow-ups and Communication (Phase 6)
- F1 Per-task chronological thread: progress update, comment, manager reply. P0
- F2 Visibility: task participants and those with authority over the assignee. P0
- F3 Notification on new entry for relevant participants. P0
- F4 Edit window and soft-delete with audit (no silent rewrites). P1

### G. My Day (Phase 8)
- G1 Pick items for today from team and personal tasks. Add, remove, focus and reorder are explicit per-item operations (see OFFLINE_SYNC_ARCHITECTURE section 13). P0
- G2 Mark up to N "focus" items. [DEFAULT] N = 3. P0
- G3 Day plan is private. Managers see task status, never the plan. P0
- G4 End-of-day review feeds carry-over suggestions. P1

### H. Activity Timeline and Audit (Phase 7, tables from Phase 2)
- H1 Append-only events for every mutation in the list of the directive. P0
- H2 UPDATE and DELETE on events blocked for all roles including service role in app paths. P0
- H3 Per-task timeline and org audit view (Admin). P0
- H4 Tamper evidence via per-org hash chain. [DEFAULT] on. [OPEN]

### I. Analytics (Phase 9)
- I1 Completion rate, on-time rate, overdue count, deferred count, average completion delay, workload completion, trends. P0
- I2 Exact definitions in section 6. Personal tasks excluded. P0
- I3 Aggregates computed server-side from events and tasks. P0

### J. Workload Balancing (Phase 9)
- J1 Effort estimate in minutes on tasks (optional, falls back to default by priority). P0
- J2 Load = sum of remaining estimate in the week vs capacity. [DEFAULT] capacity 25 h/week per member, editable per member. [OPEN]
- J3 Overload flag at > 100% capacity. [DEFAULT]
- J4 Suggestions only. Reassignment needs approval by someone with assign authority over both people. P0

### K. Smart Rescheduling (Phase 10)
- K1 Detect overdue and at-risk tasks. P0
- K2 Proposal engine: deterministic rules (priority, deadline, dependencies, workload). No AI model required. [DEFAULT] P0
- K3 User approves per task or in bulk. Accepted changes recorded as events with reason. P0
- K4 Optional LLM explanation later. [OPEN, default no]

### L. Attachments and Evidence (Phase 11)
- L1 Private bucket, signed URLs, per-task authorization. P0
- L2 Validation: allowlist of types, max size [DEFAULT] 15 MB, content sniffing, filename sanitation. P0
- L3 Evidence history: who, when, replaced or removed, never hard-deleted for completed tasks. P0
- L4 Offline: queue upload, resumable, visible state. P1

### M. Notifications (Phase 6)
- M1 Daily summary at user-configured time (local). P0
- M2 Assignment, follow-up, status notifications. P0
- M3 Gentle nudges, capped. [DEFAULT] max 1 nudge per task per assignee per 24h. P0
- M4 Push token security: tokens bound to user and device, rotated, deleted on sign-out. P0
- M5 Dedup via unique key per (recipient, kind, subject, window). P0

## 4. Cross-cutting
- Languages: Arabic (RTL) and English (LTR), switch at runtime. Hijri display optional [OPEN]. Numerals: [DEFAULT] follow locale, user can force Western digits.
- Themes: Light, Dark, System.
- Accessibility: WCAG 2.2 AA contrast, dynamic type, screen reader labels, 44 pt targets.
- Platforms: iOS and Android phones first. Tablet layout responsive. Web: not in scope [OPEN].
- Performance: cold start to My Day under 2 s on mid-range Android; list scroll 60 fps with 5k local tasks.
- Privacy: GDPR-style export and delete. [OPEN: legal region]

## 5. Out of scope for v1 (proposed)
Calendar sync, email-to-task, time tracking, web app, public API, third-party integrations, AI chat.

## 6. Metric definitions (normative)
Scope: team tasks only, assignee-attributed, within a period in the org timezone (week Sat to Fri).
- Assigned in period: tasks with due date in period and not canceled.
- Completion rate = done / assigned in period.
- On-time rate = done with completed_at <= deadline end / done.
- Overdue = not done, not canceled, deadline < now (derived).
- Deferred = number of accepted reschedule events moving the planned date later; a task counts once per period.
- Average completion delay = mean of max(0, completed_at - deadline) over done late tasks, in hours. On-time tasks excluded from the mean. Also published as mean including zeros.
- Workload completion = sum estimate of done / sum estimate of assigned.
- Tasks reassigned mid-period attribute to the assignee at completion time; events retain history.
- Reopened tasks: completion rate uses current state; reopen count reported separately.
