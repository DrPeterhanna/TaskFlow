# API and RPC Contracts

> Status: proposal for approval. Behaviors described are intended design. Nothing here has been implemented, executed or validated yet. See TESTING_STRATEGY section 0.

## 1. Conventions
- Exposed schema `app_api`. Functions are SECURITY DEFINER with `search_path = ''`, identity from `auth.uid()` only. Never accept user_id/org_id for the actor.
- Every mutating RPC takes `p_op_id uuid` (idempotency) and returns `{ok: true, data, server_time}` or an error.
- Errors: Postgres exception with SQLSTATE `TF***` and JSON detail. Codes: `unauthenticated, forbidden, not_found, validation, stale_conflict, gate_failed, dependency_blocked, cycle_detected, rate_limited, quota, expired, already_used`.
- Idempotency: every mutating RPC follows the receipt contract in OFFLINE_SYNC_ARCHITECTURE section 8 (atomic receipt, concurrent retry blocking, `op_id_reuse` on argument mismatch).
- Optimistic concurrency: updates carry `p_base_version`; the server compares per-field `field_versions`; a field changed since base with a different value -> `stale_conflict`.
- Pagination: sync reads use the `(change_xid, id)` keyset with a per-session horizon (OFFLINE_SYNC section 2); `row_version` is only for optimistic concurrency. Lists use keyset pagination on their sort key.
- Shared zod schemas in packages/shared mirror argument shapes and are used for client validation and contract tests.

## 2. Read access (RLS-guarded selects)
`sync_pull(stream, cursor, horizon, limit)` SECURITY INVOKER wrapper over allowed streams returning rows with `change_xid < horizon`, `next_cursor`, `horizon`, `epoch`, or `full_resync_required`; `list_visible_ids(stream, cursor, horizon, limit)` for revocation reconcile; analytics and pulse via RPC below. Realtime channel `org:{org_id}:changes` emits `{table, id, row_version}` only.

## 3. RPC catalogue
### Auth and org
| RPC | Args | Returns | Authz |
|---|---|---|---|
| create_organization | name, timezone | org, membership | verified user without org |
| redeem_invitation | code | membership | any verified user, rate limited |
| create_invitation | role, unit_id, max_uses, expires_at | code (shown once) | admin; supervisor in scope; grant |
| revoke_invitation | id | ok | creator or admin |
| create_unit / move_unit / rename_unit | ... | unit | admin (supervisor with grant) |
| set_member_role | membership_id, role | membership | per matrix |
| move_member | membership_id, unit_id | ok | per matrix |
| remove_member | membership_id | ok | admin |
| grant_permission / revoke_permission | membership_id, permission, scope_unit_id, expires_at | grant | admin |
| update_profile | fields | profile | self |
### Tasks
| RPC | Notes |
|---|---|
| create_task(id, parent_id, fields, assignee) | client supplies id; server validates depth, authority |
| update_task(id, base_version, patch) | patch whitelist; no status/completed fields |
| set_task_status(id, status, client_ts) | state machine; done path = complete_task |
| complete_task(id, client_ts) | gate: required descendants done, dependencies done; stamps completed_at |
| reopen_task(id, reason) | reason required |
| assign_task(id, assignee) | direct if actor authority over both, else creates proposal |
| delete_task(id) | soft |
| reorder_task(id, before_id, after_id) | returns sort_key; takes parent row lock; may trigger key rebalance |
| set_recurrence(task_id, rule) / cancel_recurrence | |
| add_dependency / remove_dependency | cycle check |
### Follow-ups
post_followup(id, task_id, kind, body, parent_id), edit_followup (15 min window, audited), delete_followup (soft).
### My Day and personal
my_day_add, my_day_remove, my_day_set_focus, my_day_move (per-item, no bulk replace), personal_task_* (with subtasks, recurrence, dependencies, status, complete/reopen), personal_attachment_*, personal_note_* CRUD, list_personal_history. All owner-only.
### Team and analytics
| RPC | Returns |
|---|---|
| team_pulse(unit_id, week_start) | counts, per-member progress, overdue (scope checked) |
| member_stats(membership_id, from, to) | metrics per definitions |
| team_trends(unit_id, weeks) | series |
| workload(unit_id, week_start) | load vs capacity per member |
| send_gentle_reminder(task_id or membership_id, template) | rate limited |
### Proposals
suggest_reschedule(scope) -> proposals; decide_reschedule(proposal_id, accept|reject, overrides); suggest_rebalance(unit_id); decide_reassign(proposal_id, accept|reject).
### Attachments
begin_attachment(task_id, name, mime, size, sha256) -> upload path/token; finalize_attachment(id) (after Edge validation); remove_attachment(id); get_attachment_url(id) -> signed URL.
### Notifications
register_push_token(device_id, token, platform), unregister_push_token(device_id), mark_notifications_read(ids), update_notification_prefs(reminder_time, flags).

## 4. Edge Functions
| Function | Trigger | Idempotency |
|---|---|---|
| send-push | DB webhook on notifications insert | push_state + dedup_key |
| daily-summary | cron every 5 min | unique (user, local_date) |
| materialize-recurrence | cron daily + on rule change | UNIQUE(rule, occurrence_date) |
| validate-attachment | storage upload event | status transition guard |
| verify-audit-chain | nightly | read-only |
| expire-proposals | cron hourly | status guard |
Edge Functions authenticate with service role stored as secret, verify webhook signatures.

## 5. Versioning
RPC names stable; breaking change = new suffix `_v2`, old kept one release. Minimum client version check at sign-in (`app_config.min_version`) with forced-update screen.
