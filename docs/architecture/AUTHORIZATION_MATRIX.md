# Authorization Matrix

> Status: proposal for approval. Behaviors described are intended design. Nothing here has been implemented, executed or validated yet. See TESTING_STRATEGY section 0.

Scope terms: **Own** = own record. **Sub** = users/units below actor in hierarchy (via unit_closure). **Org** = whole org. **Grant** = needs delegated permission scoped to the subtree. All checks are server-side.
Y = allowed, N = never, S = within scope, G = only with a matching grant.

| Action | Member | Team Leader | Supervisor | Admin |
|---|---|---|---|---|
| View own team tasks assigned to me | Y | Y | Y | Y |
| View tasks of others in my unit | N [OPEN: peer visibility] | S | S | Org |
| Create task for self | Y | Y | Y | Y |
| Assign task to others | N (G) | S | S | Org |
| Reassign / bulk reassign | N | S, approval flow | S, approval flow | Org, approval flow |
| Edit task fields | Own assigned: status, subtasks, followups only | S all | S all | Org all |
| Delete (soft) task | N | S | S | Org |
| Complete task | Own | S | S | Org |
| Reopen task | N (G) | S | S | Org |
| Create subtask | Own tasks | S | S | Org |
| Reorder subtasks | Own tasks | S | S | Org |
| Post follow-up | participants | S | S | Org |
| Manager reply/feedback | N | S | S | Org |
| Send gentle reminder | N | S | S | Org |
| View team pulse | N (own stats only) | S | S | Org |
| View analytics of member | Own | S | S | Org |
| View workload / suggestions | Own | S | S | Org |
| Approve reschedule of own task | Y | Y | Y | Y |
| Approve reschedule of others' task | N | S | S | Org |
| Create/move org units | N | N | S (G) | Y |
| Change roles | N | N | Down to Leader/Member within scope (G) | Y |
| Create invitations | N | G | S | Y |
| Remove member | N | N | N (G) | Y |
| Grant delegated permission | N | N | N | Y |
| View audit trail | task timeline of visible tasks | S | S | Org |
| Upload attachment | assigned tasks | S | S | Org |
| Download attachment | visible tasks | S | S | Org |
| Remove attachment | own uploads before completion | S | S | Org (soft) |
| Personal space (tasks, subtasks, recurrence, attachments, history, notes, My Day) | Own only | Own only | Own only | Own only, NEVER others |
| Read others' personal data | N | N | N | N |
| Register push token | Own | Own | Own | Own |

## Rules
1. Authority flows down only; peers and ancestors are not in scope.
2. Delegated grants widen specific actions to a subtree, expire, are audited, and can never grant personal-space access or exceed the grantor's own authority.
3. Suspended or removed memberships lose all access immediately (RLS checks status).
4. Cross-org access: none.
5. Consequential changes (reassign, reschedule of others' tasks) are proposals needing approval by a user with authority over both the old and the new assignee.
6. Every denied attempt on RPC returns a typed error (`forbidden`) and writes a security counter (not a full event) for rate-limit detection.
