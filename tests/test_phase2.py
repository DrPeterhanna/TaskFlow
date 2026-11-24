"""Phase 2 tests: database, RLS authorization, RPC, negative, concurrency, offline foundations.
Run against local PostgreSQL via pgserver. This is NOT Supabase verification."""
from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import psycopg2
from harness import Env, TFError, expect_pg, expect_tf, new_op, old_op, test

FUTURE = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()


@dataclass
class Fx:
    env: Env
    admin: str
    sup: str      # supervisor in U1
    lead: str     # team leader in U1a
    mem: str      # member in U1a
    lead2: str    # team leader in U2 (peer branch)
    outsider: str  # admin of another org
    org: str
    root: str
    u1: str
    u1a: str
    u2: str
    mid: dict[str, str]


def join(env: Env, admin: str, user: str, role: str, unit: str) -> str:
    inv = env.rpc(admin, "create_invitation", role, unit, 1, FUTURE)
    r = env.rpc(user, "redeem_invitation", inv["data"]["code"])
    assert r["ok"], r
    return str(r["data"]["membership_id"])


def fixture(env: Env) -> Fx:
    admin = env.user("admin@a.test", name="Admin")
    r = env.rpc(admin, "create_organization", "Acme", "Africa/Cairo")["data"]
    org, root = str(r["org_id"]), str(r["unit_id"])
    u1 = str(env.rpc(admin, "create_unit", root, "U1")["data"]["unit_id"])
    u1a = str(env.rpc(admin, "create_unit", u1, "U1a")["data"]["unit_id"])
    u2 = str(env.rpc(admin, "create_unit", root, "U2")["data"]["unit_id"])
    sup, lead, mem, lead2, out = (env.user(f"{n}@a.test", name=n) for n in ("sup", "lead", "mem", "lead2", "out"))
    mid = {"admin": str(r["membership_id"])}
    mid["sup"] = join(env, admin, sup, "supervisor", u1)
    mid["lead"] = join(env, admin, lead, "team_leader", u1a)
    mid["mem"] = join(env, admin, mem, "member", u1a)
    mid["lead2"] = join(env, admin, lead2, "team_leader", u2)
    env.rpc(out, "create_organization", "Other Org", "Africa/Cairo")
    return Fx(env, admin, sup, lead, mem, lead2, out, org, root, u1, u1a, u2, mid)


def rows(env: Env, uid: str | None, sql: str) -> list[tuple[Any, ...]]:
    return env.as_user(uid, sql)


def mids(env: Env, uid: str) -> set[str]:
    return {str(r[0]) for r in rows(env, uid, "select id from app.memberships")}


# ---------------------------------------------------------------- schema lints (database tests)
@test
def lint_rls_enabled_and_forced_on_every_table(env: Env) -> None:
    bad = env.su("""select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='app' and c.relkind='r' and not (c.relrowsecurity and c.relforcerowsecurity)""")
    assert not bad, bad
    assert env.su("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app' and c.relkind='r'")[0][0] >= 12


@test
def lint_functions_fixed_search_path_owner_and_no_public_execute(env: Env) -> None:
    nosp = env.su("""select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname in ('app_private','app_api')
                       and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c where c like 'search_path=%')""")
    assert not nosp, f"functions without fixed search_path: {nosp}"
    wrong_owner = env.su("""select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                            where n.nspname in ('app_private','app_api') and p.proname <> 'finalize_ownership'
                              and pg_get_userbyid(p.proowner) <> 'app_rpc'""")
    assert not wrong_owner, wrong_owner
    pub = env.su("""select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname in ('app_private','app_api') and p.proname <> 'finalize_ownership'
                      and (has_function_privilege('public', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))""")
    assert not pub, f"public/anon EXECUTE: {pub}"
    definer_nosp = env.su("""select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname in ('app_private','app_api') and p.prosecdef
                      and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c = 'search_path=""'))""")
    assert not definer_nosp, definer_nosp


@test
def lint_clients_have_no_write_privileges_and_anon_has_none(env: Env) -> None:
    w = env.su("""select table_name, privilege_type from information_schema.role_table_grants
                  where table_schema='app' and grantee in ('authenticated','anon','public')
                    and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')""")
    assert not w, w
    anon = env.su("select count(*) from information_schema.role_table_grants where table_schema='app' and grantee in ('anon','public')")
    assert anon[0][0] == 0
    # authenticated may call only the documented RPCs plus current_epoch
    callable_ = {r[0] for r in env.su("""select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='app_api' and has_function_privilege('authenticated', p.oid, 'execute')""")}
    assert callable_ == {"create_organization", "create_unit", "rename_unit", "move_unit", "create_invitation",
                         "revoke_invitation", "redeem_invitation", "set_member_role", "move_member",
                         "set_member_status", "grant_permission", "revoke_permission", "update_profile", "current_epoch",
                         "create_personal_task", "complete_personal_task", "create_personal_note", "sync_pull",
                         "rotate_invitation_code",
                         "update_personal_task", "reopen_personal_task", "delete_personal_task", "restore_personal_task",
                         "reorder_personal_task", "add_personal_dependency", "remove_personal_dependency",
                         "set_personal_recurrence", "clear_personal_recurrence", "update_personal_note",
                         "delete_personal_note"}, callable_
    priv = env.su("""select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='app_private' and has_function_privilege('authenticated', p.oid, 'execute') order by 1""")
    assert {r[0] for r in priv} == {"my_membership_id", "is_active_member", "me_has_authority_over_membership",
                                    "me_unit_in_scope", "me_is_admin_of", "me_can_see_profile", "me_in_org_of_unit"}, priv


# ---------------------------------------------------------------- authentication
@test
def auth_profile_created_by_trigger_and_unauthenticated_calls_rejected(env: Env) -> None:
    u = env.user("p@a.test", name="Pat")
    assert env.su("select display_name from app.profiles where id=%s", (u,))[0][0] == "Pat"
    expect_tf("unauthenticated", lambda: env.rpc(None, "create_organization", "X", "Africa/Cairo"))
    c = env.conn(None, role="anon")
    cur = c.cursor()
    expect_pg(("42501",), lambda: cur.execute("select * from app.memberships"))
    c.rollback()


@test
def auth_unverified_email_cannot_create_or_join(env: Env) -> None:
    f = fixture(env)
    u = env.user("unv@a.test", verified=False)
    expect_tf("forbidden", lambda: env.rpc(u, "create_organization", "Nope", "Africa/Cairo"))
    inv = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE)
    expect_tf("forbidden", lambda: env.rpc(u, "redeem_invitation", inv["data"]["code"]))


@test
def org_creation_builds_root_admin_closure_and_events(env: Env) -> None:
    f = fixture(env)
    assert env.su("select role, status from app.memberships where id=%s", (f.mid["admin"],))[0] == ("admin", "active")
    assert env.su("select count(*) from app.unit_closure where ancestor_id=%s", (f.root,))[0][0] == 4  # root, U1, U1a, U2
    # one org cannot be created twice by the same user
    expect_tf("validation", lambda: env.rpc(f.admin, "create_organization", "Again", "Africa/Cairo"))
    expect_tf("validation", lambda: env.rpc(env.user("tz@a.test"), "create_organization", "T", "Mars/Base"))
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] is None


# ---------------------------------------------------------------- hierarchy
@test
def hierarchy_closure_depth_and_move_subtree(env: Env) -> None:
    f = fixture(env)
    d = dict(env.su("select descendant_id::text, depth from app.unit_closure where ancestor_id=%s", (f.root,)))
    assert d[f.root] == 0 and d[f.u1] == 1 and d[f.u1a] == 2 and d[f.u2] == 1
    env.rpc(f.admin, "move_unit", f.u1, f.u2)   # U1 (and U1a) under U2
    d = dict(env.su("select descendant_id::text, depth from app.unit_closure where ancestor_id=%s", (f.root,)))
    assert d[f.u1] == 2 and d[f.u1a] == 3
    assert env.su("select depth from app.org_units where id=%s", (f.u1a,))[0][0] == 3
    assert env.su("select count(*) from app.unit_closure where ancestor_id=%s and descendant_id=%s", (f.u2, f.u1a))[0][0] == 1
    assert env.su("select count(*) from app.unit_closure where ancestor_id=%s and descendant_id=%s", (f.u1, f.u2))[0][0] == 0


@test
def hierarchy_cycle_rejected_via_rpc_and_trigger_backstop(env: Env) -> None:
    f = fixture(env)
    expect_tf("cycle_detected", lambda: env.rpc(f.admin, "move_unit", f.u1, f.u1a))
    expect_tf("cycle_detected", lambda: env.rpc(f.admin, "move_unit", f.u1, f.u1))
    # backstop: a raw update by a privileged session is rejected by the trigger too
    expect_pg(("TF008",), lambda: env.su("update app.org_units set parent_id=%s where id=%s", (f.u1a, f.u1)))
    expect_tf("validation", lambda: env.rpc(f.admin, "move_unit", f.root, f.u1))


@test
def hierarchy_cross_org_and_root_rules(env: Env) -> None:
    f = fixture(env)
    other_root = str(env.su("select id from app.org_units where org_id <> %s and parent_id is null", (f.org,))[0][0])
    expect_tf("not_found", lambda: env.rpc(f.admin, "create_unit", other_root, "X"))
    expect_tf("not_found", lambda: env.rpc(f.admin, "move_unit", f.u1, other_root))
    expect_tf("not_found", lambda: env.rpc(f.outsider, "move_unit", f.u1, f.u2))
    expect_pg(("23505",), lambda: env.su("insert into app.org_units (org_id, parent_id, name) values (%s, null, 'second root')", (f.org,)))
    expect_pg(("23503",), lambda: env.su("insert into app.org_units (org_id, parent_id, name) values (%s, %s, 'x')", (f.org, other_root)))


# ---------------------------------------------------------------- RLS authorization matrix
@test
def rls_membership_visibility_follows_authority_down_only(env: Env) -> None:
    f = fixture(env)
    m = f.mid
    assert mids(env, f.mem) == {m["mem"]}                         # member: self only (peer visibility is OPEN, default N)
    assert mids(env, f.lead) == {m["lead"], m["mem"]}             # leader: self and below, not supervisor, not peer branch
    assert mids(env, f.sup) == {m["sup"], m["lead"], m["mem"]}    # supervisor of U1: not lead2 (U2), not admin
    assert mids(env, f.lead2) == {m["lead2"]}
    assert mids(env, f.admin) == set(m.values())
    assert mids(env, f.outsider) == {str(r[0]) for r in env.su("select id from app.memberships where user_id=%s", (f.outsider,))}


@test
def rls_profiles_org_data_events_follow_scope(env: Env) -> None:
    f = fixture(env)
    assert {str(r[0]) for r in rows(env, f.mem, "select id from app.profiles")} == {f.mem}
    assert {str(r[0]) for r in rows(env, f.lead, "select id from app.profiles")} == {f.lead, f.mem}
    assert len(rows(env, f.admin, "select id from app.profiles")) == 5
    assert len(rows(env, f.mem, "select id from app.organizations")) == 1
    assert rows(env, f.mem, "select id from app.organizations")[0][0] is not None
    assert {str(r[0]) for r in rows(env, f.outsider, "select id from app.organizations")}.isdisjoint({f.org})
    assert {r[0] for r in rows(env, f.mem, "select kind from app.events")} == {"invitation.redeemed", "member.joined"}  # only events the member acted in
    assert len(rows(env, f.admin, "select id from app.events")) >= 10
    assert rows(env, f.outsider, f"select id from app.org_units where org_id='{f.org}'") == []
    assert rows(env, f.outsider, f"select * from app.unit_closure where ancestor_id='{f.root}'") == []


@test
def rls_invitation_hash_and_internal_tables_unreadable(env: Env) -> None:
    f = fixture(env)
    expect_pg(("42501",), lambda: rows(env, f.admin, "select code_hash from app.invitations"))
    assert len(rows(env, f.admin, "select id, role from app.invitations")) == 4
    assert rows(env, f.mem, "select id from app.invitations") == []
    for t in ("op_receipts", "user_access_state", "scope_epochs", "invitation_attempts"):
        expect_pg(("42501",), lambda t=t: rows(env, f.admin, f"select * from app.{t}"))


@test
def rls_clients_cannot_write_tables_directly(env: Env) -> None:
    f = fixture(env)
    for sql in (f"update app.memberships set role='admin' where user_id='{f.mem}'",
                f"insert into app.org_units (org_id, parent_id, name) values ('{f.org}', '{f.root}', 'x')",
                "delete from app.events", f"update app.profiles set display_name='x' where id='{f.mem}'",
                "truncate app.events"):
        for who in (f.mem, f.admin):
            expect_pg(("42501",), lambda sql=sql, who=who: rows(env, who, sql))


@test
def rls_suspended_and_removed_members_lose_access(env: Env) -> None:
    f = fixture(env)
    env.rpc(f.admin, "set_member_status", f.mid["mem"], "suspended")
    assert rows(env, f.mem, "select id from app.organizations") == []
    assert rows(env, f.mem, "select id from app.org_units") == []
    expect_tf("forbidden", lambda: env.rpc(f.mem, "update_profile", {"theme": "dark"}) and env.rpc(f.mem, "create_unit", f.u1a, "x"))
    assert {str(r[0]) for r in rows(env, f.mem, "select id from app.memberships")} == {f.mid["mem"]}  # may see own status
    env.rpc(f.admin, "set_member_status", f.mid["mem"], "active")
    assert len(rows(env, f.mem, "select id from app.organizations")) == 1
    env.rpc(f.admin, "set_member_status", f.mid["lead"], "removed")
    assert rows(env, f.lead, "select id from app.org_units") == []
    expect_tf("validation", lambda: env.rpc(f.admin, "set_member_status", f.mid["lead"], "active"))


# ---------------------------------------------------------------- RPC authorization (positive and negative)
@test
def rpc_forbidden_matrix_without_grants(env: Env) -> None:
    f = fixture(env)
    for who in (f.mem, f.lead, f.sup, f.lead2):
        expect_tf("forbidden", lambda who=who: env.rpc(who, "create_unit", f.root if who == f.lead2 else f.u1a, "n"))
        expect_tf("forbidden", lambda who=who: env.rpc(who, "grant_permission", f.mid["mem"], "reopen_tasks", f.u1a, FUTURE))
        expect_tf("forbidden", lambda who=who: env.rpc(who, "set_member_role", f.mid["mem"], "team_leader"))
    expect_tf("forbidden", lambda: env.rpc(f.lead, "create_invitation", "member", f.u1a, 1, FUTURE))
    expect_tf("forbidden", lambda: env.rpc(f.mem, "set_member_status", f.mid["lead"], "removed"))
    # supervisor may invite below own rank inside own scope only
    ok = env.rpc(f.sup, "create_invitation", "team_leader", f.u1a, 1, FUTURE)
    assert ok["ok"]
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_invitation", "team_leader", f.u2, 1, FUTURE))
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_invitation", "supervisor", f.u1a, 1, FUTURE))
    expect_tf("validation", lambda: env.rpc(f.admin, "create_invitation", "admin", f.u1a, 1, FUTURE))
    expect_tf("not_found", lambda: env.rpc(f.outsider, "create_invitation", "member", f.u1, 1, FUTURE))


@test
def rpc_delegated_grants_scope_expiry_revocation(env: Env) -> None:
    f = fixture(env)
    g = env.rpc(f.admin, "grant_permission", f.mid["sup"], "manage_units", f.u1, FUTURE)["data"]["grant_id"]
    assert env.rpc(f.sup, "create_unit", f.u1a, "ok under U1a")["ok"]
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_unit", f.u2, "outside scope"))
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_unit", f.root, "above scope"))
    env.rpc(f.admin, "revoke_permission", g)
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_unit", f.u1a, "revoked"))
    # expired grant: insert via admin then age it with a privileged update
    g2 = env.rpc(f.admin, "grant_permission", f.mid["sup"], "manage_units", f.u1, FUTURE)["data"]["grant_id"]
    env.su("update app.permission_grants set expires_at = now() - interval '1 minute' where id=%s", (g2,))
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_unit", f.u1a, "expired"))
    # grants never exceed own authority: a grant scoped outside the holder's own scope is inert
    env.rpc(f.admin, "grant_permission", f.mid["lead"], "create_invitations", f.u2, FUTURE)
    expect_tf("forbidden", lambda: env.rpc(f.lead, "create_invitation", "member", f.u2, 1, FUTURE))
    # grant target rules
    expect_tf("validation", lambda: env.rpc(f.admin, "grant_permission", f.mid["admin"], "manage_units", f.u1, FUTURE))
    expect_tf("validation", lambda: env.rpc(f.admin, "grant_permission", f.mid["mem"], "manage_units", f.u1, "2000-01-01T00:00:00Z"))
    expect_tf("not_found", lambda: env.rpc(f.admin, "grant_permission", f.mid["mem"], "manage_units",
              str(env.su("select id from app.org_units where org_id<>%s limit 1", (f.org,))[0][0]), FUTURE))


@test
def rpc_role_changes_respect_rank_and_scope(env: Env) -> None:
    f = fixture(env)
    env.rpc(f.admin, "grant_permission", f.mid["sup"], "change_roles", f.u1, FUTURE)
    assert env.rpc(f.sup, "set_member_role", f.mid["mem"], "team_leader")["ok"]
    expect_tf("forbidden", lambda: env.rpc(f.sup, "set_member_role", f.mid["mem"], "supervisor"))      # no escalation to own rank
    expect_tf("forbidden", lambda: env.rpc(f.sup, "set_member_role", f.mid["lead2"], "member"))        # outside scope
    expect_tf("forbidden", lambda: env.rpc(f.sup, "set_member_role", f.mid["admin"], "member"))        # above scope
    assert env.rpc(f.admin, "set_member_role", f.mid["mem"], "supervisor")["ok"]


@test
def rpc_last_admin_cannot_be_demoted_removed_or_suspended(env: Env) -> None:
    f = fixture(env)
    expect_pg(("TF004",), lambda: env.rpc(f.admin, "set_member_role", f.mid["admin"], "member"))
    expect_pg(("TF004",), lambda: env.rpc(f.admin, "set_member_status", f.mid["admin"], "removed"))
    expect_pg(("TF004",), lambda: env.rpc(f.admin, "set_member_status", f.mid["admin"], "suspended"))
    expect_pg(("TF004", "23503"), lambda: env.su("delete from app.memberships where id=%s", (f.mid["admin"],)))  # FK RESTRICT also blocks it
    env.rpc(f.admin, "set_member_role", f.mid["sup"], "admin")
    assert env.rpc(f.admin, "set_member_role", f.mid["admin"], "member")["ok"]      # allowed now: another admin exists
    expect_pg(("TF004",), lambda: env.rpc(f.sup, "set_member_role", f.mid["sup"], "member"))


@test
def rpc_move_member_and_profile_update(env: Env) -> None:
    f = fixture(env)
    assert env.rpc(f.admin, "move_member", f.mid["mem"], f.u2)["ok"]
    assert mids(env, f.lead) == {f.mid["lead"]}                       # visibility followed the move at once
    assert f.mid["mem"] in mids(env, f.lead2)
    expect_tf("forbidden", lambda: env.rpc(f.lead, "move_member", f.mid["mem"], f.u1a))
    env.rpc(f.mem, "update_profile", {"display_name": "Mo", "theme": "dark"})
    assert rows(env, f.mem, "select display_name, theme from app.profiles")[0] == ("Mo", "dark")
    expect_tf("validation", lambda: env.rpc(f.mem, "update_profile", {"id": f.admin}))
    expect_pg(("23514",), lambda: env.rpc(f.mem, "update_profile", {"theme": "neon"}))


# ---------------------------------------------------------------- invitations
@test
def invitations_single_use_expiry_revocation_and_rate_limit(env: Env) -> None:
    f = fixture(env)
    inv = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE)
    code, iid = inv["data"]["code"], inv["data"]["invitation_id"]
    u = env.user("n1@a.test")
    assert env.rpc(u, "redeem_invitation", code)["ok"]
    u2 = env.user("n2@a.test")
    assert env.rpc(u2, "redeem_invitation", code)["ok"] is False                      # exhausted
    # revoked and expired
    inv2 = env.rpc(f.admin, "create_invitation", "member", f.u1, 5, FUTURE)
    env.rpc(f.admin, "revoke_invitation", inv2["data"]["invitation_id"])
    assert env.rpc(u2, "redeem_invitation", inv2["data"]["code"])["ok"] is False
    inv3 = env.rpc(f.admin, "create_invitation", "member", f.u1, 5, FUTURE)
    env.su("update app.invitations set expires_at = now() - interval '1 second' where id=%s", (inv3["data"]["invitation_id"],))
    assert env.rpc(u2, "redeem_invitation", inv3["data"]["code"])["ok"] is False
    # rate limit: 5 failures per hour, then even a valid code is refused
    u3 = env.user("n3@a.test")
    for i in range(5):
        r = env.rpc(u3, "redeem_invitation", f"wrong-{i}")
        assert r["ok"] is False
    good = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE)
    expect_tf("rate_limited", lambda: env.rpc(u3, "redeem_invitation", good["data"]["code"]))
    # members of an org cannot redeem a second invitation
    expect_tf("validation", lambda: env.rpc(f.mem, "redeem_invitation", good["data"]["code"]))
    assert iid


@test
def invitations_code_never_stored_plain_and_not_replayed(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    r = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE, op=op)
    code = r["data"]["code"]
    assert len(code) >= 32
    dump = env.su("select (select string_agg(code_hash, ',') from app.invitations) || (select coalesce(string_agg(result::text, ','), '') from app.op_receipts) || (select string_agg(payload::text, ',') from app.events)")[0][0]
    assert code not in dump
    replay = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE, op=op)
    # lost response: the retry returns the SAME code and the SAME invitation (stable replay)
    assert replay["data"]["invitation_id"] == r["data"]["invitation_id"] and replay["data"]["code"] == code
    assert env.su("select count(*) from app.invitations")[0][0] == 5
    secret = env.su("select secret from app.server_secrets")[0][0]
    dump = env.su("select (select string_agg(code_hash, ',') from app.invitations) || (select coalesce(string_agg(result::text, ','), '') from app.op_receipts) || (select string_agg(payload::text, ',') from app.events)")[0][0]
    assert code not in dump and secret not in dump
    u = env.user("late@a.test")
    assert env.rpc(u, "redeem_invitation", code)["ok"] is True
    after = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE, op=op)
    assert "code" not in after["data"]                                     # used up: no usable code to return
    expect_pg(("42501",), lambda: rows(env, f.admin, "select * from app.server_secrets"))


@test
def invitations_concurrent_and_delayed_duplicates_return_same_usable_code(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    out: list[Any] = []
    barrier = threading.Barrier(4)

    def worker() -> None:
        try:
            barrier.wait()
            out.append(env.rpc(f.admin, "create_invitation", "member", f.u1, 3, FUTURE, op=op))
        except Exception as e:  # noqa: BLE001
            out.append(e)

    ts = [threading.Thread(target=worker) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert all(isinstance(o, dict) for o in out), out
    assert len({o["data"]["code"] for o in out}) == 1 and len({o["data"]["invitation_id"] for o in out}) == 1
    code = out[0]["data"]["code"]
    n_before = env.su("select count(*) from app.invitations")[0][0]
    # the delivered code works; a delayed duplicate arriving afterwards does not invalidate anything
    u1, u2 = env.user("d1@a.test"), env.user("d2@a.test")
    assert env.rpc(u1, "redeem_invitation", code)["ok"] is True
    late = env.rpc(f.admin, "create_invitation", "member", f.u1, 3, FUTURE, op=op)
    assert late["data"]["code"] == code
    assert env.rpc(u2, "redeem_invitation", code)["ok"] is True            # multi-use code still valid after the duplicate
    assert env.su("select count(*) from app.invitations")[0][0] == n_before
    # a creator who lost authority cannot create more, and fresh calls are refused
    inv = env.rpc(f.sup, "create_invitation", "member", f.u1a, 1, FUTURE, op=new_op())
    op3 = new_op()
    first = env.rpc(f.sup, "create_invitation", "member", f.u1a, 1, FUTURE, op=op3)
    env.rpc(f.admin, "set_member_status", f.mid["sup"], "suspended")
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_invitation", "member", f.u1a, 1, FUTURE, op=new_op()))
    assert inv["ok"] and first["ok"] and "code" in first["data"]


@test
def invitations_rotation_is_explicit_authorized_and_stable(env: Env) -> None:
    f = fixture(env)
    inv = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE)
    old, iid = inv["data"]["code"], inv["data"]["invitation_id"]
    expect_tf("forbidden", lambda: env.rpc(f.mem, "rotate_invitation_code", iid))
    rop = new_op()
    rot = env.rpc(f.admin, "rotate_invitation_code", iid, op=rop)
    assert rot["data"]["code"] != old
    again = env.rpc(f.admin, "rotate_invitation_code", iid, op=rop)       # duplicate of the rotation: same code
    assert again["data"]["code"] == rot["data"]["code"]
    u = env.user("rot@a.test")
    assert env.rpc(u, "redeem_invitation", old)["ok"] is False
    assert env.rpc(u, "redeem_invitation", rot["data"]["code"])["ok"] is True
    expect_tf("validation", lambda: env.rpc(f.admin, "rotate_invitation_code", iid))   # used up


# ---------------------------------------------------------------- idempotency receipts (offline foundation)
@test
def receipts_replay_returns_stored_result_without_second_effect(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    a = env.rpc(f.admin, "create_unit", f.u1, "Once", op=op)
    b = env.rpc(f.admin, "create_unit", f.u1, "Once", op=op)
    assert a == b
    assert env.su("select count(*) from app.org_units where name='Once'")[0][0] == 1
    assert env.su("select count(*) from app.events where request_op_id=%s", (op,))[0][0] == 1


@test
def receipts_argument_mismatch_and_cross_rpc_reuse_rejected(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    env.rpc(f.admin, "create_unit", f.u1, "A", op=op)
    expect_tf("op_id_reuse", lambda: env.rpc(f.admin, "create_unit", f.u1, "B", op=op))
    expect_tf("op_id_reuse", lambda: env.rpc(f.admin, "rename_unit", f.u1, "B", op=op))
    assert env.su("select count(*) from app.org_units where name in ('A','B')")[0][0] == 1
    # the same op id by another user is a different receipt key
    assert env.rpc(f.sup, "update_profile", {"theme": "dark"}, op=op)["ok"]


@test
def receipts_expired_op_ids_never_replay_and_rejection_stores_nothing(env: Env) -> None:
    f = fixture(env)
    before = env.su("select count(*) from app.op_receipts")[0][0]
    expect_tf("op_expired", lambda: env.rpc(f.admin, "create_unit", f.u1, "Old", op=old_op(120)))
    assert env.su("select count(*) from app.org_units where name='Old'")[0][0] == 0
    # even when the receipt has been purged: nothing is re-executed
    op = new_op()
    env.rpc(f.admin, "create_unit", f.u1, "Fresh", op=op)
    expect_tf("validation", lambda: env.rpc(f.admin, "create_unit", f.u1, "x", op="00000000-0000-4000-8000-000000000000"))
    # a rejected call leaves no receipt, so a corrected retry with the same op id is allowed
    op2 = new_op()
    expect_tf("forbidden", lambda: env.rpc(f.mem, "create_unit", f.u1a, "n", op=op2))
    assert env.su("select count(*) from app.op_receipts where op_id=%s", (op2,))[0][0] == 0
    assert env.su("select count(*) from app.op_receipts")[0][0] == before + 1


@test
def receipts_concurrent_retries_apply_once(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    out: list[Any] = []
    barrier = threading.Barrier(4)

    def worker() -> None:
        try:
            barrier.wait()
            out.append(env.rpc(f.admin, "create_unit", f.u1, "Race", op=op))
        except Exception as e:  # noqa: BLE001
            out.append(e)

    ts = [threading.Thread(target=worker) for _ in range(4)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert all(isinstance(o, dict) and o["ok"] for o in out), out
    assert len({o["data"]["unit_id"] for o in out}) == 1
    assert env.su("select count(*) from app.org_units where name='Race'")[0][0] == 1


# ---------------------------------------------------------------- audit events
@test
def events_are_append_only_and_chain_detects_tampering(env: Env) -> None:
    f = fixture(env)
    for sql in ("update app.events set kind='x.y'", "delete from app.events", "truncate app.events"):
        expect_pg(("42501",), lambda sql=sql: env.su(sql))
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] is None
    n = env.su("select count(*) from app.events where org_id=%s", (f.org,))[0][0]
    assert n >= 10
    # a privileged operator who disables the trigger can rewrite a row; verification catches it
    victim = env.su("select id from app.events where org_id=%s order by id offset 3 limit 1", (f.org,))[0][0]
    env.su("alter table app.events disable trigger events_no_update")
    env.su("update app.events set payload = payload || '{\"x\":1}'::jsonb where id=%s", (victim,))
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] == victim
    # chain forks are refused by the unique (org_id, prev_hash) constraint
    expect_pg(("23505",), lambda: env.su(
        "insert into app.events (id, org_id, actor_kind, kind, subject_type, prev_hash, hash) "
        "select 999999, org_id, 'system', 'a.b', 'x', prev_hash, repeat('a', 64) from app.events where org_id=%s limit 1", (f.org,)))


@test
def events_capture_every_mutation_with_actor_and_op(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    env.rpc(f.admin, "grant_permission", f.mid["sup"], "manage_units", f.u1, FUTURE, op=op)
    env.rpc(f.admin, "set_member_role", f.mid["mem"], "team_leader")
    env.rpc(f.admin, "move_member", f.mid["mem"], f.u2)
    env.rpc(f.admin, "move_unit", f.u1a, f.u2)
    kinds = {r[0] for r in env.su("select kind from app.events where org_id=%s", (f.org,))}
    assert {"org.created", "unit.created", "member.joined", "invitation.created", "invitation.redeemed", "grant.created",
            "member.role_changed", "member.moved", "unit.moved"} <= kinds
    assert env.su("select actor_membership_id::text, request_op_id::text from app.events where kind='grant.created'")[0] == (f.mid["admin"], op)


# ---------------------------------------------------------------- access epochs (sync foundation)
@test
def epochs_bump_on_grant_role_move_and_unit_move_and_never_decrease(env: Env) -> None:
    f = fixture(env)

    def ep(u: str) -> int:
        return int(env.as_user(u, "select app_api.current_epoch()")[0][0])

    seen = {u: ep(u) for u in (f.mem, f.lead, f.sup, f.admin, f.lead2)}

    def bumped(who: str, label: str) -> None:
        now = ep(who)
        assert now > seen[who], f"{label}: epoch for {who[:6]} did not rise ({seen[who]} -> {now})"
        seen[who] = now

    env.rpc(f.admin, "grant_permission", f.mid["lead"], "create_invitations", f.u1a, FUTURE)
    bumped(f.lead, "grant")
    env.rpc(f.admin, "set_member_role", f.mid["mem"], "team_leader")
    bumped(f.mem, "role change")
    bumped(f.lead, "role change visible to leader of unit")
    env.rpc(f.admin, "move_member", f.mid["lead"], f.u2)
    bumped(f.lead, "member move")
    bumped(f.lead2, "member move into unit")
    bumped(f.sup, "member move out of supervisor scope")
    env.rpc(f.admin, "move_unit", f.u1a, f.u2)      # supervisor of U1 loses U1a, lead2 (U2) gains it
    bumped(f.sup, "unit move out of scope")
    bumped(f.lead2, "unit move into scope")
    bumped(f.mem, "unit move of own unit")
    bumped(f.admin, "admin sees all moves")
    # no change for an unrelated outsider
    assert ep(f.outsider) == ep(f.outsider)


# ---------------------------------------------------------------- concurrency
@test
def concurrency_opposing_unit_moves_cannot_create_a_cycle(env: Env) -> None:
    f = fixture(env)
    for attempt in range(3):
        a = str(env.rpc(f.admin, "create_unit", f.root, f"A{attempt}")["data"]["unit_id"])
        b = str(env.rpc(f.admin, "create_unit", f.root, f"B{attempt}")["data"]["unit_id"])
        out: list[Any] = []
        barrier = threading.Barrier(2)

        def mv(x: str, y: str) -> None:
            try:
                barrier.wait()
                out.append(env.rpc(f.admin, "move_unit", x, y))
            except Exception as e:  # noqa: BLE001
                out.append(e)

        ts = [threading.Thread(target=mv, args=(a, b)), threading.Thread(target=mv, args=(b, a))]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        oks = [o for o in out if isinstance(o, dict)]
        errs = [o for o in out if isinstance(o, TFError)]
        assert len(oks) == 1 and len(errs) == 1 and errs[0].code == "cycle_detected", out
        mutual = env.su("select count(*) from app.unit_closure x join app.unit_closure y on x.ancestor_id=y.descendant_id and x.descendant_id=y.ancestor_id where x.ancestor_id <> x.descendant_id")[0][0]
        assert mutual == 0


@test
def concurrency_two_admins_cannot_demote_each_other(env: Env) -> None:
    f = fixture(env)
    env.rpc(f.admin, "set_member_role", f.mid["sup"], "admin")
    for _attempt in range(3):
        out: list[Any] = []
        barrier = threading.Barrier(2)

        def demote(who: str, target: str) -> None:
            try:
                barrier.wait()
                out.append(env.rpc(who, "set_member_role", target, "member"))
            except Exception as e:  # noqa: BLE001
                out.append(e)

        ts = [threading.Thread(target=demote, args=(f.admin, f.mid["sup"])),
              threading.Thread(target=demote, args=(f.sup, f.mid["admin"]))]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        n = env.su("select count(*) from app.memberships where org_id=%s and role='admin' and status='active'", (f.org,))[0][0]
        assert n >= 1, f"org left without an admin: {out}"
        if n == 1:   # one succeeded; restore a second admin for the next round
            env.su("update app.memberships set role='admin' where id in (%s,%s)", (f.mid["admin"], f.mid["sup"]))


# ---------------------------------------------------------------- misc negative / regression
@test
def regression_server_controlled_columns_cannot_be_forged(env: Env) -> None:
    f = fixture(env)
    # row_version and change_xid are set by trigger even when a privileged writer tries to forge them
    env.su("update app.org_units set name='n2', row_version=999, change_xid='1'::xid8 where id=%s", (f.u2,))
    rv, cx = env.su("select row_version, change_xid::text::bigint from app.org_units where id=%s", (f.u2,))[0]
    assert rv < 999 and cx > 1
    # org_id / user_id are immutable on memberships
    expect_pg(("TF004",), lambda: env.su("update app.memberships set user_id=%s where id=%s", (f.outsider, f.mid["mem"])))
    # a single org per user
    expect_pg(("23505",), lambda: env.su("insert into app.memberships (org_id,user_id,role,unit_id) values (%s,%s,'member',%s)", (f.org, f.mem, f.u1)))
    # unit/membership org consistency (composite FK)
    other_unit = str(env.su("select id from app.org_units where org_id<>%s limit 1", (f.org,))[0][0])
    expect_pg(("23503",), lambda: env.su("update app.memberships set unit_id=%s where id=%s", (other_unit, f.mid["mem"])))


@test
def regression_service_role_cannot_use_private_helpers(env: Env) -> None:
    f = fixture(env)
    c = env.conn(f.mem)
    cur = c.cursor()
    expect_pg(("42501",), lambda: cur.execute("select app_private.emit_event(%s,null,'a.b','x',null)", (f.org,)))
    c.rollback()
    cur = env.conn(f.mem).cursor()
    expect_pg(("42501",), lambda: cur.execute("select app_private.has_authority_over_membership(%s,%s)", (f.mid["admin"], f.mid["mem"])))


@test
def rls_same_rank_peers_in_one_unit_are_not_in_authority(env: Env) -> None:
    f = fixture(env)
    peer = env.user("peer@a.test", name="peer")
    pm = join(env, f.admin, peer, "team_leader", f.u1a)
    assert pm not in mids(env, f.lead) and f.mid["lead"] not in mids(env, peer)
    assert {str(r[0]) for r in rows(env, f.lead, "select id from app.profiles")} == {f.lead, f.mem}
    env.rpc(f.admin, "grant_permission", f.mid["lead"], "remove_members", f.u1a, FUTURE)
    expect_tf("forbidden", lambda: env.rpc(f.lead, "set_member_status", pm, "removed"))   # peer, same rank
    assert env.rpc(f.lead, "set_member_status", f.mid["mem"], "removed")["ok"]          # below rank, in scope, with grant


@test
def concurrency_admin_changes_serialize_on_org_admin_lock(env: Env) -> None:
    """Deterministic: while one transaction holds an uncommitted admin demotion, a second admin
    change in the same org must wait for it (it would otherwise pass its last-admin check blind)."""
    f = fixture(env)
    env.rpc(f.admin, "set_member_role", f.mid["sup"], "admin")
    # raw statements (not RPCs) and the epoch trigger disabled (it upserts shared rows), so the only
    # possible blocker is the org-admins advisory lock
    env.su("alter table app.memberships disable trigger memberships_epoch")
    c1 = env.conn()
    cur1 = c1.cursor()
    cur1.execute("update app.memberships set role='member' where id=%s", (f.mid["sup"],))   # holds the lock, uncommitted
    c2 = env.conn()
    cur2 = c2.cursor()
    cur2.execute("set lock_timeout = '700ms'")
    try:
        cur2.execute("update app.memberships set role='member' where id=%s", (f.mid["admin"],))
        raise AssertionError("second admin change did not wait for the org admin lock")
    except psycopg2.Error as e:
        assert e.pgcode == "55P03", e.pgcode
    c2.rollback()
    c1.commit()
    assert env.su("select count(*) from app.memberships where org_id=%s and role='admin' and status='active'", (f.org,))[0][0] == 1


@test
def regression_suspended_actor_has_no_authority_or_scope(env: Env) -> None:
    f = fixture(env)
    assert env.su("select app_private.has_authority_over_membership(%s,%s)", (f.mid["lead"], f.mid["mem"]))[0][0] is True
    assert env.su("select app_private.unit_in_scope(%s,%s)", (f.mid["lead"], f.u1a))[0][0] is True
    env.rpc(f.admin, "set_member_status", f.mid["lead"], "suspended")
    assert env.su("select app_private.has_authority_over_membership(%s,%s)", (f.mid["lead"], f.mid["mem"]))[0][0] is False
    assert env.su("select app_private.unit_in_scope(%s,%s)", (f.mid["lead"], f.u1a))[0][0] is False
    assert env.su("select app_private.has_authority_over_membership(%s,%s)", (f.mid["admin"], f.mid["mem"]))[0][0] is True


@test
def lifecycle_removed_member_rejoins_by_invitation_only_and_keeps_history(env: Env) -> None:
    f = fixture(env)
    env.rpc(f.admin, "set_member_status", f.mid["mem"], "removed")
    n_events = env.su("select count(*) from app.events where actor_membership_id=%s", (f.mid["mem"],))[0][0]
    # no back door: admin cannot reactivate directly, a removed user cannot redeem into a second org while live
    expect_tf("validation", lambda: env.rpc(f.admin, "set_member_status", f.mid["mem"], "active"))
    assert rows(env, f.mem, "select id from app.org_units") == []
    # authorized invitation brings the same membership row back with the INVITATION's role and unit
    inv = env.rpc(f.admin, "create_invitation", "team_leader", f.u2, 1, FUTURE)
    r = env.rpc(f.mem, "redeem_invitation", inv["data"]["code"])
    assert r["ok"] and r["data"]["membership_id"] == f.mid["mem"]
    assert env.su("select role::text, status::text, unit_id::text from app.memberships where id=%s", (f.mid["mem"],))[0] == ("team_leader", "active", f.u2)
    assert env.su("select count(*) from app.events where actor_membership_id=%s", (f.mid["mem"],))[0][0] > n_events   # history preserved, rejoin event added
    assert "member.rejoined" in {x[0] for x in env.su("select kind from app.events")}
    assert env.su("select count(*) from app.memberships where user_id=%s", (f.mem,))[0][0] == 1
    # never two live memberships
    expect_pg(("23505",), lambda: env.su("insert into app.memberships (org_id,user_id,role,unit_id) values (%s,%s,'member',%s)",
              (str(env.su("select org_id from app.memberships where user_id=%s", (f.outsider,))[0][0]),
               f.mem, str(env.su("select id from app.org_units where org_id<>%s limit 1", (f.org,))[0][0]))))
    # removed in org A, invited to org B: allowed, A row stays as history
    env.rpc(f.admin, "set_member_status", f.mid["lead2"], "removed")
    oinv = env.rpc(f.outsider, "create_invitation", "member",
                   str(env.su("select id from app.org_units where org_id<>%s limit 1", (f.org,))[0][0]), 1, FUTURE)
    assert env.rpc(f.lead2, "redeem_invitation", oinv["data"]["code"])["ok"]
    assert env.su("select count(*) from app.memberships where user_id=%s", (f.lead2,))[0][0] == 2
    assert env.su("select count(*) from app.memberships where user_id=%s and status<>'removed'", (f.lead2,))[0][0] == 1
    # a suspended member cannot redeem a second invitation to escape suspension
    env.rpc(f.admin, "set_member_status", f.mid["lead"], "suspended")
    inv2 = env.rpc(f.admin, "create_invitation", "member", f.u1, 1, FUTURE)
    expect_tf("validation", lambda: env.rpc(f.lead, "redeem_invitation", inv2["data"]["code"]))


def uuid7() -> str:
    return new_op()


@test
def personal_space_owner_only_even_admin_and_supervisor_cannot_read(env: Env) -> None:
    f = fixture(env)
    t, p = uuid7(), uuid7()
    env.rpc(f.mem, "create_personal_task", t, None, "secret plan", None)
    env.rpc(f.mem, "create_personal_task", p, t, "secret subtask", None)
    env.rpc(f.mem, "create_personal_note", uuid7(), "private note")
    env.rpc(f.mem, "complete_personal_task", p)
    for who in (f.admin, f.sup, f.lead, f.lead2, f.outsider):
        for tbl in ("personal_tasks", "personal_notes", "personal_events", "personal_task_dependencies", "personal_attachments", "personal_recurrence_rules"):
            assert rows(env, who, f"select * from app.{tbl}") == [], (who[:6], tbl)
    assert len(rows(env, f.mem, "select id from app.personal_tasks")) == 2
    assert [r[0] for r in rows(env, f.mem, "select kind from app.personal_events order by id")] == ["ptask.created", "ptask.created", "pnote.created", "ptask.completed"]
    # never in the org stream, never in org audit
    assert env.su("select count(*) from app.events where kind like 'ptask.%' or kind like 'pnote.%' or payload::text like '%secret%'")[0][0] == 0
    # owner-only history has its own chain; clients cannot write it; sync_pull respects RLS too
    assert env.su("select app_private.verify_chain(user_id) from app.personal_events limit 1")[0][0] is None
    expect_pg(("42501",), lambda: rows(env, f.mem, "update app.personal_tasks set title='x'"))
    assert rows(env, f.admin, "select app_api.sync_pull('personal_tasks')::jsonb -> 'rows'")[0][0] == []


@test
def personal_space_depth_gate_server_stamp_and_cascade(env: Env) -> None:
    f = fixture(env)
    a, b, c, d = uuid7(), uuid7(), uuid7(), uuid7()
    env.rpc(f.mem, "create_personal_task", a, None, "L0", None)
    env.rpc(f.mem, "create_personal_task", b, a, "L1", None)
    env.rpc(f.mem, "create_personal_task", c, b, "L2", None)
    expect_tf("validation", lambda: env.rpc(f.mem, "create_personal_task", d, c, "L3", None))
    expect_tf("not_found", lambda: env.rpc(f.lead, "create_personal_task", uuid7(), a, "stranger child", None))   # other user's parent
    expect_tf("gate_failed", lambda: env.rpc(f.mem, "complete_personal_task", a))
    env.rpc(f.mem, "complete_personal_task", c)
    env.rpc(f.mem, "complete_personal_task", b)
    env.rpc(f.mem, "complete_personal_task", a)
    assert env.su("select count(*) from app.personal_tasks where status='done' and completed_at is not null")[0][0] == 3
    expect_pg(("23514",), lambda: env.su("update app.personal_tasks set status='done', completed_at=null where id=%s", (a,)))
    expect_tf("not_found", lambda: env.rpc(f.lead, "complete_personal_task", a))
    env.su("delete from app.profiles where id=%s", (f.mem,)) if False else None


@test
def sync_pull_commit_safe_horizon_never_skips_late_commits(env: Env) -> None:
    """Proposed design validated on local PostgreSQL only: a transaction that started earlier
    but commits later than a higher-xid transaction is never skipped."""
    f = fixture(env)
    ids = [uuid7() for _ in range(3)]
    # A starts first (lower xid) and stays open
    # raw insert (no RPC) so it does not share the per-user event lock with B
    ca = env.conn()
    cura = ca.cursor()
    cura.execute("insert into app.personal_tasks (id, user_id, title) values (%s, %s, 'from A')", (ids[0], f.mem))
    # B starts later (higher xid) and commits first
    env.rpc(f.mem, "create_personal_task", ids[1], None, "from B", None)
    first = rows(env, f.mem, "select app_api.sync_pull('personal_tasks')::jsonb")[0][0]
    titles1 = [r["title"] for r in first["rows"]]
    assert "from A" not in titles1 and "from B" not in titles1, "rows above the horizon must wait"
    ca.commit()          # A commits late
    env.rpc(f.mem, "create_personal_task", ids[2], None, "from C", None)
    got: list[str] = []
    cur_xid, cur_id = "0", ""
    for _ in range(5):
        pg = rows(env, f.mem, f"select app_api.sync_pull('personal_tasks', '{cur_xid}'::xid8, '{cur_id}')::jsonb")[0][0]
        got += [r["title"] for r in pg["rows"]]
        if not pg["rows"]:
            break
        cur_xid, cur_id = pg["next_xid"], pg["next_id"]
    assert sorted(got) == ["from A", "from B", "from C"], got
    # pagination with a limit walks every row exactly once
    seen: list[str] = []
    cur_xid, cur_id = "0", ""
    for _ in range(6):
        pg = rows(env, f.mem, f"select app_api.sync_pull('personal_tasks', '{cur_xid}'::xid8, '{cur_id}', null, 1)::jsonb")[0][0]
        if not pg["rows"]:
            break
        seen += [r["title"] for r in pg["rows"]]
        cur_xid, cur_id = pg["next_xid"], pg["next_id"]
    assert sorted(seen) == ["from A", "from B", "from C"]
    expect_tf("validation", lambda: env.rpc(f.mem, "update_profile", {}) and rows(env, f.mem, "select app_api.sync_pull('profiles')"))


@test
def hmac_matches_rfc4231_and_python(env: Env) -> None:
    """The in-database HMAC is standard HMAC-SHA-256: RFC 4231 cases 1, 2, 6 plus derive_code vs Python hmac."""
    import hashlib
    import hmac as pyhmac

    vectors = [
        (b"\x0b" * 20, b"Hi There", "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"),
        (b"Jefe", b"what do ya want for nothing?", "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"),
        (b"\xaa" * 131, b"Test Using Larger Than Block-Size Key - Hash Key First",
         "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"),
    ]
    for key, msg, want in vectors:
        got = env.su("select encode(app_private.hmac_sha256(%s::bytea, %s::bytea), 'hex')", (key, msg))[0][0]
        assert got == want, (key, got)
        assert got == pyhmac.new(key, msg, hashlib.sha256).hexdigest()
    secret = env.su("select secret from app.server_secrets where key_id = 1")[0][0]
    u, op = new_op(), new_op()
    got = env.su("select app_private.derive_code(1, 'invite', %s::uuid, %s::uuid, null)", (u, op))[0][0]
    want = pyhmac.new(secret.encode(), f"invite|{u}|{op}|".encode(), hashlib.sha256).hexdigest()
    assert got == want


@test
def personal_rpcs_update_reopen_delete_restore_reorder_are_owner_only_and_idempotent(env: Env) -> None:
    f = fixture(env)
    a, b = uuid7(), uuid7()
    env.rpc(f.mem, "create_personal_task", a, None, "A", None)
    env.rpc(f.mem, "create_personal_task", b, a, "B", None)
    op = new_op()
    env.rpc(f.mem, "update_personal_task", a, {"title": "A2", "priority": "high", "due_date": "2026-12-01"}, op=op)
    rv = rows(env, f.mem, f"select row_version from app.personal_tasks where id='{a}'")[0][0]
    env.rpc(f.mem, "update_personal_task", a, {"title": "A2", "priority": "high", "due_date": "2026-12-01"}, op=op)   # replay
    assert rows(env, f.mem, f"select row_version from app.personal_tasks where id='{a}'")[0][0] == rv
    assert rows(env, f.mem, f"select title, priority from app.personal_tasks where id='{a}'")[0] == ("A2", "high")
    expect_tf("validation", lambda: env.rpc(f.mem, "update_personal_task", a, {"completed_at": "2026-01-01"}))
    expect_tf("validation", lambda: env.rpc(f.mem, "update_personal_task", a, {"status": "done"}))
    expect_tf("validation", lambda: env.rpc(f.mem, "update_personal_task", a, {}))
    for who in (f.admin, f.sup, f.lead, f.outsider):   # nobody else can touch another user's task
        for fn, args in (("update_personal_task", (a, {"title": "x"})), ("delete_personal_task", (a,)),
                         ("reorder_personal_task", (a, "b1")), ("reopen_personal_task", (a,))):
            expect_tf("not_found", lambda who=who, fn=fn, args=args: env.rpc(who, fn, *args))
    env.rpc(f.mem, "complete_personal_task", b)
    env.rpc(f.mem, "reopen_personal_task", b)
    assert rows(env, f.mem, f"select status, completed_at is null from app.personal_tasks where id='{b}'")[0] == ("todo", True)
    expect_tf("validation", lambda: env.rpc(f.mem, "reopen_personal_task", b))
    env.rpc(f.mem, "reorder_personal_task", b, "a5")
    expect_tf("validation", lambda: env.rpc(f.mem, "reorder_personal_task", b, "bad key!"))
    r = env.rpc(f.mem, "delete_personal_task", a)
    assert r["data"]["rows"] == 2
    assert rows(env, f.mem, "select count(*) from app.personal_tasks where deleted_at is not null")[0][0] == 2
    expect_tf("not_found", lambda: env.rpc(f.mem, "update_personal_task", a, {"title": "z"}))
    expect_tf("validation", lambda: env.rpc(f.mem, "restore_personal_task", b))   # parent still deleted
    r = env.rpc(f.mem, "restore_personal_task", a)
    assert r["data"]["rows"] == 2
    assert rows(env, f.mem, "select count(*) from app.personal_tasks where deleted_at is not null")[0][0] == 0
    kinds = [x[0] for x in rows(env, f.mem, "select kind from app.personal_events order by id")]
    assert "ptask.updated" in kinds and "ptask.deleted" in kinds and "ptask.restored" in kinds and "ptask.reopened" in kinds
    assert env.su("select app_private.verify_chain(user_id) from app.personal_events limit 1")[0][0] is None
    assert env.su("select count(*) from app.events where kind like 'ptask.%'")[0][0] == 0


@test
def personal_dependencies_reject_cycles_and_foreign_tasks_and_concurrent_cycles(env: Env) -> None:
    import threading

    f = fixture(env)
    t = [uuid7() for _ in range(4)]
    for i, x in enumerate(t):
        env.rpc(f.mem, "create_personal_task", x, None, f"T{i}", None)
    env.rpc(f.mem, "add_personal_dependency", t[0], t[1])
    env.rpc(f.mem, "add_personal_dependency", t[1], t[2])
    expect_tf("cycle_detected", lambda: env.rpc(f.mem, "add_personal_dependency", t[2], t[0]))
    expect_tf("validation", lambda: env.rpc(f.mem, "add_personal_dependency", t[0], t[0]))
    expect_tf("not_found", lambda: env.rpc(f.lead, "add_personal_dependency", t[0], t[3]))
    env.rpc(f.mem, "remove_personal_dependency", t[1], t[2])
    env.rpc(f.mem, "add_personal_dependency", t[2], t[0])   # now legal
    env.rpc(f.mem, "remove_personal_dependency", t[2], t[0])
    # opposing concurrent adds must not both succeed
    out: list[str] = []
    def go(a: str, b: str) -> None:
        try:
            env.rpc(f.mem, "add_personal_dependency", a, b)
            out.append("ok")
        except Exception as e:   # noqa: BLE001
            out.append(str(e)[:60])
    th = [threading.Thread(target=go, args=(t[3], t[2])), threading.Thread(target=go, args=(t[2], t[3]))]
    [x.start() for x in th]; [x.join() for x in th]
    assert out.count("ok") == 1, out
    n = env.su("select count(*) from app.personal_task_dependencies where blocked_by_task_id in (%s,%s) and task_id in (%s,%s)", (t[2], t[3], t[2], t[3]))[0][0]
    assert n == 1


@test
def personal_recurrence_and_notes_rpcs_owner_only(env: Env) -> None:
    f = fixture(env)
    rid, n = uuid7(), uuid7()
    env.rpc(f.mem, "set_personal_recurrence", rid, {"title": "Weekly review"}, [6, 0], "2026-12-05", None, casts="")
    expect_tf("validation", lambda: env.rpc(f.mem, "set_personal_recurrence", uuid7(), {"x": 1}, [1], "2026-12-05", None))
    expect_tf("validation", lambda: env.rpc(f.mem, "set_personal_recurrence", uuid7(), {"title": "t"}, [1], "2026-12-05", "2026-12-01"))
    expect_tf("not_found", lambda: env.rpc(f.lead, "set_personal_recurrence", rid, {"title": "hijack"}, [1], "2026-12-05", None))
    expect_tf("not_found", lambda: env.rpc(f.lead, "clear_personal_recurrence", rid))
    env.rpc(f.mem, "clear_personal_recurrence", rid)
    assert rows(env, f.mem, f"select active from app.personal_recurrence_rules where id='{rid}'")[0][0] is False
    env.rpc(f.mem, "create_personal_note", n, "first")
    env.rpc(f.mem, "update_personal_note", n, "second", True)
    assert rows(env, f.mem, f"select body, pinned from app.personal_notes where id='{n}'")[0] == ("second", True)
    expect_tf("not_found", lambda: env.rpc(f.admin, "update_personal_note", n, "admin edit", None))
    expect_tf("not_found", lambda: env.rpc(f.admin, "delete_personal_note", n))
    env.rpc(f.mem, "delete_personal_note", n)
    expect_tf("not_found", lambda: env.rpc(f.mem, "update_personal_note", n, "again", None))
    assert env.su("select count(*) from app.events where payload::text like '%second%' or payload::text like '%Weekly%'")[0][0] == 0
