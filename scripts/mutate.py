"""Mutation testing of critical invariants: break one rule in a copy of the migrations and
require the suite to fail. A surviving mutant means a missing or weak test."""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))
import harness  # noqa: E402
import test_phase2  # noqa: E402,F401
import test_lifecycle  # noqa: E402,F401

M = [
    ("0003_organizations_units_closure.sql", "perform app_private.raise_tf('cycle_detected', 'unit cannot move under itself or a descendant');", "null;", "cycle guard removed"),
    ("0003_organizations_units_closure.sql", "as $$ select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-structure:' || p_org::text, 0)) $$;", "as $$ select 1 $$;", "structure lock made a no-op"),
    ("0003_organizations_units_closure.sql", "alter table app.memberships", "alter table app.memberships", "noop-guard"),
    ("0004_memberships_grants_invitations.sql", "alter table app.%I force row level security", "alter table app.%I disable row level security", "RLS not forced on memberships group"),
    ("0004_memberships_grants_invitations.sql", "perform app_private.raise_tf('validation', 'an organization must keep at least one active admin');", "null;", "last admin check removed"),
    ("0004_memberships_grants_invitations.sql", "if old.role = 'admin' and old.status = 'active' then\n      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || old.org_id::text, 0));\n    end if;\n  end if;", "null;\n  end if;", "admin lock removed (update path)"),
    ("0005_authz_helpers.sql", "app_private.role_rank(a.role) > app_private.role_rank(t.role)", "app_private.role_rank(a.role) >= app_private.role_rank(t.role)", "rank strictness weakened"),
    ("0005_authz_helpers.sql", "or exists (select 1 from app.unit_closure c\n                      where c.ancestor_id = a.unit_id and c.descendant_id = p_unit)", "or true", "scope check removed from unit_in_scope"),
    ("0005_authz_helpers.sql", "g.revoked_at is null and g.expires_at > now()", "g.revoked_at is null", "grant expiry ignored"),
    ("0005_authz_helpers.sql", "g.revoked_at is null and g.expires_at > now()", "g.expires_at > now()", "grant revocation ignored"),
    ("0005_authz_helpers.sql", "where a.id = p_actor and a.status = 'active' and a.id <> t.id", "where a.id = p_actor and a.id <> t.id", "suspended actor keeps authority"),
    ("0006_events_audit_chain.sql", "create trigger events_no_update before update or delete on app.events\n  for each row execute function app_private.events_immutable();", "", "events update/delete trigger removed"),
    ("0006_events_audit_chain.sql", "unique (org_id, prev_hash),", "", "chain fork constraint removed"),
    ("0006_events_audit_chain.sql", "p_prev || '|' || p_org::text || '|' || p_id::text || '|' || p_kind || '|' || p_payload::text || '|' ||", "p_prev || '|' || p_org::text || '|' || p_id::text || '|' || p_kind || '|' ||", "payload excluded from hash"),
    ("0007_receipts_epochs.sql", "if v_rec.rpc <> p_rpc or v_rec.args_hash <> v_hash then", "if v_rec.rpc <> p_rpc then", "args hash mismatch ignored"),
    ("0007_receipts_epochs.sql", "if v_time < now() - interval '90 days' then", "if false then", "op expiry check removed"),
    ("0007_receipts_epochs.sql", "on conflict (user_id, op_id) do nothing;", "on conflict (user_id, op_id) do update set rpc = excluded.rpc, args_hash = excluded.args_hash, result = null;", "receipt overwritten on conflict"),
    ("0007_receipts_epochs.sql", "select ancestor_id as id from app.unit_closure where descendant_id = p_unit\n     union\n     select descendant_id", "select ancestor_id as id from app.unit_closure where descendant_id = p_unit and false\n     union\n     select descendant_id", "epoch bump skips ancestors"),
    ("0007_receipts_epochs.sql", "create trigger memberships_epoch after insert or update or delete on app.memberships\n  for each row execute function app_private.epoch_on_membership();", "", "membership epoch trigger removed"),
    ("0011_invitation_stable_replay.sql", "or (v_actor.role = 'supervisor' and app_private.unit_in_scope(v_actor.id, p_unit_id)\n              and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))", "or (v_actor.role = 'supervisor' and app_private.role_rank(p_role) < app_private.role_rank(v_actor.role))", "supervisor invitation scope removed"),
    ("0008_rls_and_rpc.sql", "or p_role not in ('team_leader', 'member') then", "then", "role escalation by grant holder"),
    ("0008_rls_and_rpc.sql", "if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;\n  select * into v_t from app.memberships where id = p_membership_id;\n  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;\n  if v_t.status <> 'active' or v_t.role = 'admin'", "select * into v_t from app.memberships where id = p_membership_id;\n  if v_t.id is null or v_t.org_id <> v_actor.org_id then perform app_private.raise_tf('not_found', 'membership'); end if;\n  if v_t.status <> 'active' or v_t.role = 'admin'", "anyone may grant permissions"),
    ("0009_rejoin_and_invitation_retry.sql", "(select count(*) from app.invitation_attempts\n      where user_id = v_uid and attempted_at > now() - interval '1 hour') >= 5", "false", "invitation rate limit removed"),
    ("0008_rls_and_rpc.sql", "or created_by = app_private.my_membership_id());", "or true);", "invitation list visible to everyone"),
    ("0008_rls_and_rpc.sql", "using (app_private.is_active_member(org_id));\ncreate policy unit_closure_select", "using (true);\ncreate policy unit_closure_select", "org_units readable across orgs"),
    ("0008_rls_and_rpc.sql", "grant select (id, org_id, role,", "grant select (code_hash, id, org_id, role,", "code_hash readable by clients"),
    ("0008_rls_and_rpc.sql", "if v_t.status = 'removed' then perform app_private.raise_tf('validation', 'removed members cannot be reactivated'); end if;", "null;", "removed members reactivatable"),
    ("0009_rejoin_and_invitation_retry.sql", "where status <> 'removed';", "where false;", "multiple live memberships allowed"),
    ("0011_invitation_stable_replay.sql", "or v_inv.revoked_at is not null or v_inv.expires_at <= now() or v_inv.uses >= v_inv.max_uses then\n      return v_prev;", "or v_inv.revoked_at is not null or v_inv.expires_at <= now() then\n      return v_prev;", "replay returns code for a used-up invitation"),
    ("0012_standard_hmac.sql", "# 54);   -- 0x36", "# 55);   -- 0x36", "HMAC ipad constant wrong"),
    ("0012_standard_hmac.sql", "v_key := pg_catalog.sha256(v_key);", "v_key := pg_catalog.substr(v_key, 1, 64);", "HMAC long-key hashing replaced by truncation"),
    ("0012_standard_hmac.sql", "p_label || '|' || p_user::text", "p_user::text", "derive_code label dropped"),
    ("0013_personal_rpcs_complete.sql", "where id = p_id and user_id = p_uid for update;", "where id = p_id for update;", "personal task ownership check removed"),
    ("0013_personal_rpcs_complete.sql", "    perform app_private.raise_tf('cycle_detected', 'dependency would create a cycle');", "    null;", "personal dependency cycle check removed"),
    ("0013_personal_rpcs_complete.sql", "  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('personal-deps:' || v_uid::text, 0));\n", "", "personal dependency lock removed"),
    ("0013_personal_rpcs_complete.sql", "    if k not in ('title', 'notes', 'priority', 'status', 'planned_date', 'due_date', 'estimate_min', 'is_required') then", "    if false then", "update field whitelist removed"),
    ("0013_personal_rpcs_complete.sql", "    select c.id from app.personal_tasks c join sub s on c.parent_id = s.id where c.user_id = v_uid)", "    select c.id from app.personal_tasks c join sub s on c.parent_id = s.id where false)", "delete does not cascade to subtasks"),
    ("0013_personal_rpcs_complete.sql", "    perform app_private.raise_tf('validation', 'restore the parent first');", "    null;", "restore under a deleted parent allowed"),
    ("0013_personal_rpcs_complete.sql", "update app.personal_recurrence_rules set active = false, deleted_at = now() where id = p_id and user_id = v_uid;", "update app.personal_recurrence_rules set active = false, deleted_at = now() where id = p_id;", "clear recurrence ignores owner"),
    ("0013_personal_rpcs_complete.sql", "  where id = p_id and user_id = v_uid and deleted_at is null;\n  get diagnostics v_n = row_count;\n  if v_n = 0 then perform app_private.raise_tf('not_found', 'note'); end if;\n  perform app_private.emit_personal_event(v_uid, 'pnote.updated'", "  where id = p_id and deleted_at is null;\n  get diagnostics v_n = row_count;\n  if v_n = 0 then perform app_private.raise_tf('not_found', 'note'); end if;\n  perform app_private.emit_personal_event(v_uid, 'pnote.updated'", "note update ignores owner"),
    ("0011_invitation_stable_replay.sql", "grant select on app.server_secrets to app_rpc;", "grant select on app.server_secrets to app_rpc, authenticated;", "secret readable by clients"),
    ("0011_invitation_stable_replay.sql", "if not (v_actor.role = 'admin' or v_inv.created_by = v_actor.id) then perform app_private.raise_tf('forbidden'); end if;\n  if v_prev", "if v_prev", "anyone may rotate an invitation code"),
    ("0009_rejoin_and_invitation_retry.sql", "role = v_inv.role, unit_id = v_inv.unit_id where id = v_old.id", "unit_id = v_inv.unit_id where id = v_old.id", "rejoin keeps old role"),
    ("0010_personal_space_and_sync_pull.sql", "and t.change_xid < $3", "", "sync horizon ignored"),
    ("0010_personal_space_and_sync_pull.sql", "for select to authenticated using (user_id = auth.uid())", "for select to authenticated using (true)", "personal data readable by all"),
    ("0010_personal_space_and_sync_pull.sql", "and c.status not in ('done', 'canceled') and c.deleted_at is null) then", "and false) then", "personal completion gate removed"),
    ("0010_personal_space_and_sync_pull.sql", "if v_parent.depth >= 2 then", "if false then", "personal depth limit removed"),
    ("0008_rls_and_rpc.sql", "perform app_private.require_verified_email();\n  if p_name is null", "if p_name is null", "unverified email may create org"),
    ('0014_account_lifecycle.sql', "    perform app_private.raise_tf('validation', 'last admin: transfer the admin role or close the organization first');", '    null;', '0014 last-admin guard removed'),
    ('0014_account_lifecycle.sql', "  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('org-admins:' || v_m.org_id::text, 0));\n  if not exists", '  if not exists', '0014 last-admin lock removed'),
    ('0014_account_lifecycle.sql', '  if exists (select 1 from app.organizations o where o.id = v_m.org_id and o.deleted_at is not null) then return; end if;\n', '', '0014 closed-org exemption removed'),
    ('0014_account_lifecycle.sql', "  if tg_op = 'DELETE' and pg_catalog.current_setting('app_private.erasing_user', true) = old.user_id::text then", "  if tg_op = 'DELETE' then", '0014 personal events deletable by anyone'),
    ('0014_account_lifecycle.sql', '  perform app_private.assert_not_last_admin(v_actor.id);\n  perform app_private.remove_membership(v_actor.id, v_actor.id, p_op_id', '  perform app_private.remove_membership(v_actor.id, v_actor.id, p_op_id', '0014 leave skips last-admin check'),
    ('0014_account_lifecycle.sql', "  if v_actor.role <> 'admin' then perform app_private.raise_tf('forbidden'); end if;\n  v_org := v_actor.org_id;", '  v_org := v_actor.org_id;', '0014 anyone may close org'),
    ('0014_account_lifecycle.sql', "    perform app_private.raise_tf('validation', 'remove or transfer all other members first');", '    null;', '0014 close with other members allowed'),
    ('0014_account_lifecycle.sql', "    execute pg_catalog.format('delete from %s where %I = $1', r.tbl, r.col) using v_uid;", '    null;', '0014 personal data not erased'),
    ('0014_account_lifecycle.sql', '  select p.id from app.profiles p where p.auth_user_id = auth.uid() and p.deleted_at is null\n', '  select p.id from app.profiles p where p.auth_user_id = auth.uid()\n', '0014 deleted profile still authenticates (uid)'),
    ('0014_account_lifecycle.sql', "  if v is null then perform app_private.raise_tf('unauthenticated'); end if;", '  null;', '0014 require_uid does not reject'),
    ('0014_account_lifecycle.sql', '                          auth_user_id = null, deleted_at', '                          deleted_at', '0014 profile keeps auth link after deletion'),
]


def main() -> int:
    survived: list[str] = []
    killed = 0
    lo, hi = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (0, len(M))
    for fname, old, new, label in M[lo:hi]:
        if label == "noop-guard":
            continue
        tmp = Path(tempfile.mkdtemp(prefix="mut-"))
        shutil.copytree(ROOT / "supabase/migrations", tmp / "m")
        f = tmp / "m" / fname
        src = f.read_text()
        if old not in src:
            print(f"SKIP (pattern not found): {label}")
            survived.append(f"{label} [pattern not found]")
            continue
        f.write_text(src.replace(old, new, 1))
        try:
            res = harness.run_all(tmp / "m")
        except RuntimeError as e:
            print(f"KILLED  {label}  (migration no longer applies: {str(e)[:80]})")
            killed += 1
            continue
        fails = [k for k, v in res.items() if v != "pass"]
        if fails:
            killed += 1
            print(f"KILLED  {label}  <- {fails[0]}")
        else:
            survived.append(label)
            print(f"SURVIVED  {label}")
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\nmutants killed: {killed}, survived: {len(survived)}")
    for s in survived:
        print("  survivor:", s)
    return 1 if survived else 0


if __name__ == "__main__":
    raise SystemExit(main())
