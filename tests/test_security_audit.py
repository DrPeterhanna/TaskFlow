"""Catalog-level security audit of the sync-relevant schema. Local PostgreSQL + auth shim. NOT Supabase verification."""
from __future__ import annotations

import json

from harness import Env, test

SCHEMAS = ("app", "app_api", "app_private")


_FN = """select n.nspname, p.proname, p.prosecdef, coalesce(p.proconfig::text,''),
    has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
    has_function_privilege('public', p.oid, 'execute'), pg_get_userbyid(p.proowner)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = any(%s) and p.prokind = 'f' order by 1,2"""


@test
def audit_security_definer_functions_have_a_pinned_empty_search_path(env: Env) -> None:
    rows = env.su(_FN.replace("coalesce(p.proconfig::text,'')", "('search_path=\"\"' = any(coalesce(p.proconfig, '{}')))::text"), (list(SCHEMAS),))
    assert len(rows) >= 80
    bad = [(r[0], r[1]) for r in rows if r[2] and r[3] != 'true']
    assert bad == [], f"SECURITY DEFINER without search_path='' : {bad}"


@test
def audit_no_function_is_executable_by_anon_or_public(env: Env) -> None:
    bad = [(r[0], r[1]) for r in env.su(_FN, (list(SCHEMAS),)) if r[4] or r[6]]
    assert bad == [], f"executable by anon/PUBLIC: {bad}"


@test
def audit_authenticated_can_execute_only_the_api_and_the_rls_helper_set(env: Env) -> None:
    rows = env.su(_FN, (list(SCHEMAS),))
    api = {r[1] for r in rows if r[0] == 'app_api' and r[5]}
    assert len(api) == 38
    helpers = {r[1] for r in rows if r[0] == 'app_private' and r[5]}
    # only the pure read-only helpers that RLS policies call; every writer (begin_op, finish_op, emit_*, remove_membership...) is closed
    assert helpers == {'is_active_member', 'me_can_see_profile', 'me_has_authority_over_membership', 'me_in_org_of_unit',
                       'me_is_admin_of', 'me_unit_in_scope', 'my_membership_id', 'uid'}, helpers
    assert [r for r in rows if r[0] == 'app' and r[5]] == []


@test
def audit_only_four_api_functions_run_as_invoker_and_they_are_read_only(env: Env) -> None:
    rows = env.su(_FN, (list(SCHEMAS),))
    inv = sorted(r[1] for r in rows if r[0] == 'app_api' and not r[2])
    assert inv == ['list_invitations', 'list_members', 'list_units', 'sync_pull'], inv   # these rely on RLS for authorisation
    vol = env.su("select p.proname, p.provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_api' and p.proname = any(%s)", (inv,))
    assert all(v[1] in ('s', 'v') for v in vol)
    for name in inv:
        body = env.su("select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_api' and p.proname=%s", (name,))[0][0].lower()
        assert not any(w in body for w in ('insert into', 'update app', 'delete from')), name


@test
def audit_every_table_has_forced_rls_and_anon_has_no_privilege(env: Env) -> None:
    rows = env.su("""select n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity,
        has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert') or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'),
        (select count(*) from pg_policy x where x.polrelid = c.oid)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname = any(%s) and c.relkind in ('r','p')""", (list(SCHEMAS),))
    assert len(rows) == 20
    assert [r[:2] for r in rows if not (r[2] and r[3])] == []
    assert [r[:2] for r in rows if r[4]] == []
    assert [r[:2] for r in rows if r[5] == 0] == []


@test
def audit_internal_tables_are_closed_to_signed_in_users(env: Env) -> None:
    closed = env.su("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relkind='r'
        and not (has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert')
                 or has_table_privilege('authenticated', c.oid, 'update') or has_table_privilege('authenticated', c.oid, 'delete')) order by 1""")
    assert [r[0] for r in closed] == ['invitation_attempts', 'invitations', 'op_receipts', 'scope_epochs', 'server_secrets', 'sync_floor', 'user_access_state']


@test
def audit_sync_tables_cannot_be_written_directly_by_a_signed_in_user(env: Env) -> None:
    """Sync streams are written only through the RPCs, so a queued op cannot bypass them with a direct table write."""
    from harness import ROOT  # noqa: F401
    u = env.user("direct@a.test", name="Direct")
    for sql in ("insert into app.personal_tasks (id, user_id, title) values (gen_random_uuid(), app_private.uid(), 'x')",
                "update app.personal_tasks set title = 'hacked'", "delete from app.personal_tasks",
                "insert into app.personal_notes (id, user_id, body) values (gen_random_uuid(), app_private.uid(), 'x')"):
        try:
            env.as_user(u, sql)
        except Exception as e:  # noqa: BLE001
            assert 'permission denied' in str(e).lower() or 'row-level security' in str(e).lower() or 'violates' in str(e).lower(), (sql, e)
        else:
            raise AssertionError(f"direct write succeeded: {sql}")


# ---------------------------------------------------------------- revoked access cannot keep syncing protected data
def _pull_units(env: Env, uid: str, after: str = "0") -> list[dict]:
    r = env.as_user(uid, "select app_api.sync_pull('org_units', %s::xid8, '', null, 1000)", (after,))[0][0]
    return r["rows"] if isinstance(r, dict) else json.loads(r)["rows"]


def _try(env: Env, uid: str, fn: str, *args):
    """Returns ('ok'|'refused', result_or_code). A refusal may be a TF exception or an ok:false data result."""
    from harness import TFError
    try:
        r = env.rpc(uid, fn, *args)
    except TFError as e:
        return "refused", e.code
    return ("ok", r) if r.get("ok", True) else ("refused", r.get("code"))


@test
def revoked_suspended_and_removed_members_get_no_org_rows_even_with_an_old_cursor(env: Env) -> None:
    from test_phase2 import fixture
    f = fixture(env)
    n0 = len(_pull_units(env, f.mem)); assert n0 >= 4, n0              # active member: root, U1, U1a, U2
    stale = env.as_user(f.mem, "select app_api.sync_pull('org_units', '0'::xid8, '', null, 1000)")[0][0]
    stale = stale["next_xid"] if isinstance(stale, dict) else json.loads(stale)["next_xid"]
    assert _pull_units(env, f.outsider) != _pull_units(env, f.mem) and all(str(u["org_id"]) != f.org for u in _pull_units(env, f.outsider))
    assert f.mid["mem"] and env.rpc(f.admin, "set_member_status", f.mid["mem"], "suspended")["ok"]
    assert _pull_units(env, f.mem) == [] and _pull_units(env, f.mem, stale) == []
    assert env.rpc(f.admin, "set_member_status", f.mid["mem"], "active")["ok"]
    assert len(_pull_units(env, f.mem)) >= 4                       # reinstated: access returns, nothing was left behind
    assert env.rpc(f.admin, "set_member_status", f.mid["mem"], "removed")["ok"]
    assert _pull_units(env, f.mem) == [] and _pull_units(env, f.mem, stale) == []
    assert env.as_user(f.mem, "select count(*) from app.org_units")[0][0] == 0
    # a removed member can still read their OWN membership row (status removed) but no other member's
    assert env.as_user(f.mem, "select count(*) from app.memberships where org_id = %s and user_id <> app_private.uid()", (f.org,))[0][0] == 0


@test
def suspended_removed_and_grant_revoked_members_cannot_write_and_changes_apply_at_once(env: Env) -> None:
    from test_phase2 import fixture, FUTURE
    f = fixture(env)
    assert _try(env, f.mem, "create_unit", f.u1a, "Nope")[0] == "refused"             # no manage_units grant
    g = env.rpc(f.admin, "grant_permission", f.mid["mem"], "manage_units", f.u1a, FUTURE)["data"]["grant_id"]
    assert _try(env, f.mem, "create_unit", f.u1a, "Granted")[0] == "ok"
    assert env.rpc(f.admin, "revoke_permission", g)["ok"]
    assert _try(env, f.mem, "create_unit", f.u1a, "Revoked")[0] == "refused"          # revocation takes effect at once, no re-login
    g2 = env.rpc(f.admin, "grant_permission", f.mid["mem"], "manage_units", f.u1a, FUTURE)["data"]["grant_id"]
    assert env.rpc(f.admin, "set_member_status", f.mid["mem"], "suspended")["ok"]
    assert _try(env, f.mem, "create_unit", f.u1a, "Suspended")[0] == "refused"         # a live grant does not survive suspension
    assert env.rpc(f.admin, "set_member_status", f.mid["mem"], "removed")["ok"]
    assert _try(env, f.mem, "create_unit", f.u1a, "Removed")[0] == "refused"
    assert g2
    assert env.su("select count(*) from app.org_units where name in ('Nope','Revoked','Suspended','Removed')")[0][0] == 0
    assert env.su("select count(*) from app.org_units where name = 'Granted'")[0][0] == 1


@test
def an_op_authorised_before_a_revocation_replays_identically_and_a_new_op_is_refused(env: Env) -> None:
    from test_phase2 import fixture, FUTURE
    from harness import new_op
    f = fixture(env)
    g = env.rpc(f.admin, "grant_permission", f.mid["lead"], "manage_units", f.u1a, FUTURE)["data"]["grant_id"]
    op = new_op()
    r1 = env.rpc(f.lead, "create_unit", f.u1a, "Before", op=op)
    assert r1["ok"]
    env.rpc(f.admin, "revoke_permission", g)
    assert _try(env, f.lead, "create_unit", f.u1a, "After")[0] == "refused"
    assert env.rpc(f.lead, "create_unit", f.u1a, "Before", op=op) == r1               # stored result of an op that WAS authorised
    assert env.su("select count(*) from app.org_units where name = 'Before'")[0][0] == 1


@test
def personal_streams_follow_the_owner_only_and_other_users_never_see_them(env: Env) -> None:
    """Personal data is owned by the signed-in user: org suspension does not change it (documented), and no other user can pull it."""
    from test_phase2 import fixture
    import uuid
    f = fixture(env)
    t = str(uuid.uuid4())
    env.rpc(f.mem, "create_personal_task", t, None, "mine", None)
    pull = lambda uid: env.as_user(uid, "select app_api.sync_pull('personal_tasks', '0'::xid8, '', null, 1000)")[0][0]  # noqa: E731
    rows_of = lambda r: (r if isinstance(r, dict) else json.loads(r))["rows"]  # noqa: E731
    assert [x["id"] for x in rows_of(pull(f.mem))] == [t]
    assert rows_of(pull(f.admin)) == [] and rows_of(pull(f.outsider)) == []
    env.rpc(f.admin, "set_member_status", f.mid["mem"], "suspended")
    assert [x["id"] for x in rows_of(pull(f.mem))] == [t]
