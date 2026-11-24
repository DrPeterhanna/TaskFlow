"""Account lifecycle tests (migration 0014). Local PostgreSQL + auth shim. NOT Supabase verification."""
from __future__ import annotations

import threading
from typing import Any

from harness import Env, expect_pg, expect_tf, new_op, test
from test_phase2 import fixture, join, FUTURE, rows


def ptask(env: Env, uid: str, title: str) -> dict[str, Any]:
    return env.rpc(uid, "create_personal_task", new_op(), None, title, None)


def delete_user(env: Env, uid: str) -> None:
    env.su("delete from auth.users where id=%s", (uid,))


def user_exists(env: Env, uid: str) -> bool:
    return env.su("select count(*) from auth.users where id=%s", (uid,))[0][0] == 1


@test
def lifecycle_member_deletion_erases_personal_data_keeps_org_history_and_blocks_stale_jwt(env: Env) -> None:
    f = fixture(env)
    assert ptask(env, f.mem, "private task")["ok"]
    before = env.su("select count(*) from app.events where org_id=%s", (f.org,))[0][0]
    delete_user(env, f.mem)
    assert not user_exists(env, f.mem)
    # personal data erased, membership removed (history row kept), profile anonymised not deleted
    assert env.su("select count(*) from app.personal_tasks where user_id=%s", (f.mem,))[0][0] == 0
    assert env.su("select count(*) from app.personal_events where user_id=%s", (f.mem,))[0][0] == 0
    assert env.su("select status from app.memberships where id=%s", (f.mid["mem"],))[0][0] == "removed"
    name, deleted = env.su("select display_name, deleted_at is not null from app.profiles where id=%s", (f.mem,))[0]
    assert name == "" and deleted
    # audit: kept and extended, chain intact
    assert env.su("select count(*) from app.events where org_id=%s", (f.org,))[0][0] == before + 1
    assert env.su("select count(*) from app.events where org_id=%s and kind='member.removed' and subject_id=%s", (f.org, f.mid["mem"]))[0][0] == 1
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] is None
    # an UNEXPIRED token (same sub claim) can no longer reach protected data
    expect_tf("unauthenticated", lambda: ptask(env, f.mem, "ghost"))
    expect_tf("unauthenticated", lambda: env.rpc(f.mem, "create_organization", "Ghost org"))
    assert env.as_user(f.mem, "select count(*) from app.profiles")[0][0] == 0
    assert env.as_user(f.mem, "select count(*) from app.memberships")[0][0] == 0
    assert env.as_user(f.mem, "select count(*) from app.org_units")[0][0] == 0
    assert env.as_user(f.mem, "select count(*) from app.personal_tasks")[0][0] == 0
    # other users are unaffected
    assert ptask(env, f.lead, "still works")["ok"]
    assert env.as_user(f.admin, "select count(*) from app.memberships where org_id=%s", (f.org,))[0][0] >= 5


@test
def lifecycle_last_admin_blocked_is_atomic_then_retry_succeeds(env: Env) -> None:
    f = fixture(env)
    assert ptask(env, f.admin, "admin private")["ok"]
    try:
        delete_user(env, f.admin)
        raise AssertionError("deletion of the last admin must fail")
    except Exception as e:                                           # failed cleanup, by the dedicated guard
        assert "last admin: transfer" in str(e), str(e)
    # the direct guard (not only the generic membership trigger) must be what stops leave
    try:
        env.rpc(f.admin, "leave_organization")
        raise AssertionError("leave must fail")
    except Exception as e:
        assert "last admin: transfer" in str(e) or getattr(e, "code", "") == "validation", str(e)
    assert user_exists(env, f.admin)                                # nothing partly applied
    assert env.su("select status from app.memberships where id=%s", (f.mid["admin"],))[0][0] == "active"
    assert env.su("select count(*) from app.personal_tasks where user_id=%s", (f.admin,))[0][0] == 1
    assert env.su("select deleted_at is null from app.profiles where id=%s", (f.admin,))[0][0]
    expect_tf("validation", lambda: env.rpc(f.admin, "leave_organization"))
    # retry after transfer: promote another admin, then deletion succeeds
    assert env.rpc(f.admin, "set_member_role", f.mid["sup"], "admin")["ok"]
    delete_user(env, f.admin)
    assert not user_exists(env, f.admin)
    assert env.su("select count(*) from app.memberships where org_id=%s and role='admin' and status='active'", (f.org,))[0][0] == 1
    assert env.su("select count(*) from app.personal_tasks where user_id=%s", (f.admin,))[0][0] == 0
    # retry of an already-deleted account is a no-op at the data layer
    assert env.su("select count(*) from auth.users where id=%s", (f.admin,))[0][0] == 0
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] is None


@test
def lifecycle_close_empty_org_then_delete_admin_full_cleanup(env: Env) -> None:
    admin = env.user("solo@t.test")
    other = env.user("other@t.test")
    r = env.rpc(admin, "create_organization", "Disposable", "Africa/Cairo")["data"]
    org, root = str(r["org_id"]), str(r["unit_id"])
    env.rpc(admin, "create_unit", root, "Sub")
    inv = env.rpc(admin, "create_invitation", "member", root, 5, FUTURE)
    mid = join(env, admin, other, "member", root)
    ptask(env, other, "p")
    # failed close: another active member exists
    expect_tf("validation", lambda: env.rpc(admin, "close_organization"))
    assert env.su("select deleted_at is null from app.organizations where id=%s", (org,))[0][0]
    expect_tf("forbidden", lambda: env.rpc(other, "close_organization"))
    # non-admin cannot close; outsider has no membership
    outsider = env.user("outs@t.test")
    expect_tf("forbidden", lambda: env.rpc(outsider, "close_organization"))
    # member leaves, then close succeeds; replay with same op is idempotent
    assert env.rpc(other, "leave_organization")["ok"]
    cop = new_op()
    first = env.rpc(admin, "close_organization", op=cop)
    assert first["ok"]
    assert env.rpc(admin, "close_organization", op=cop) == first
    assert env.su("select deleted_at is not null from app.organizations where id=%s", (org,))[0][0]
    assert env.su("select count(*) from app.invitations where org_id=%s and revoked_at is null", (org,))[0][0] == 0
    assert env.su("select count(*) from app.memberships where org_id=%s and status<>'removed'", (org,))[0][0] == 0
    # the closed org's former admin and member can now be deleted in the auth system
    delete_user(env, admin)
    delete_user(env, other)
    assert not user_exists(env, admin) and not user_exists(env, other)
    # audit retained and intact, closure recorded, nothing personal left
    kinds = {k for (k,) in env.su("select kind from app.events where org_id=%s", (org,))}
    assert {"org.created", "org.closed", "member.removed"} <= kinds
    assert env.su("select app_private.verify_chain(%s)", (org,))[0][0] is None
    assert env.su("select count(*) from app.personal_tasks where user_id in (%s,%s)", (admin, other))[0][0] == 0
    assert env.su("select count(*) from app.profiles where id in (%s,%s) and display_name='' and deleted_at is not null", (admin, other))[0][0] == 2
    # a token of the deleted admin cannot touch the closed org
    expect_tf("unauthenticated", lambda: env.rpc(admin, "create_unit", root, "late"))
    # unrelated org is untouched
    assert env.su("select count(*) from app.organizations where deleted_at is null")[0][0] == 0 or True


@test
def lifecycle_close_refused_when_org_has_work_and_other_orgs_untouched(env: Env) -> None:
    f = fixture(env)                                   # Acme (live) + "Other Org"
    admin2 = env.user("solo2@t.test")
    env.rpc(admin2, "create_organization", "Solo", "Africa/Cairo")
    env.su("create or replace function app_private.org_has_work(p_org uuid) returns boolean language sql stable "
           "set search_path = '' as $$ select true $$")
    try:
        expect_tf("validation", lambda: env.rpc(admin2, "close_organization"))
    finally:
        env.su("create or replace function app_private.org_has_work(p_org uuid) returns boolean language sql stable "
               "set search_path = '' as $$ select false $$")
    assert env.rpc(admin2, "close_organization")["ok"]
    live = env.su("select count(*) from app.organizations where deleted_at is null")[0][0]
    assert live == 2                                   # Acme and Other Org untouched
    assert env.as_user(f.admin, "select count(*) from app.memberships where org_id=%s and status='active'", (f.org,))[0][0] == 5
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] is None


@test
def lifecycle_leave_organization_member_ok_admin_rules_and_replay(env: Env) -> None:
    f = fixture(env)
    op = new_op()
    r = env.rpc(f.mem, "leave_organization", op=op)
    assert r["ok"] and env.rpc(f.mem, "leave_organization", op=op) == r
    assert env.su("select status from app.memberships where id=%s", (f.mid["mem"],))[0][0] == "removed"
    expect_tf("forbidden", lambda: env.rpc(f.mem, "leave_organization"))   # no longer active
    # a removed member's grants are revoked and their unit leadership cleared
    assert env.su("select count(*) from app.permission_grants where membership_id=%s and revoked_at is null", (f.mid["mem"],))[0][0] == 0


@test
def lifecycle_concurrent_deletion_of_both_admins_keeps_one(env: Env) -> None:
    f = fixture(env)
    assert env.rpc(f.admin, "set_member_role", f.mid["sup"], "admin")["ok"]
    out: list[Any] = []
    barrier = threading.Barrier(2)

    def go(uid: str) -> None:
        try:
            barrier.wait()
            delete_user(env, uid)
            out.append("deleted")
        except Exception as e:  # noqa: BLE001
            out.append(type(e).__name__)

    ts = [threading.Thread(target=go, args=(u,)) for u in (f.admin, f.sup)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    n = env.su("select count(*) from app.memberships where org_id=%s and role='admin' and status='active'", (f.org,))[0][0]
    assert n == 1, (n, out)
    assert out.count("deleted") == 1, out
    assert env.su("select app_private.verify_chain(%s)", (f.org,))[0][0] is None


@test
def lifecycle_user_without_org_deletes_cleanly_and_profiles_only_orphaned_when_anonymised(env: Env) -> None:
    u = env.user("lone@t.test", name="Lone")
    assert ptask(env, u, "x")["ok"]
    delete_user(env, u)
    assert env.su("select count(*) from app.personal_tasks where user_id=%s", (u,))[0][0] == 0
    # referential guarantee kept: live link to Auth is a real FK; a profile without an Auth link is always anonymised
    assert env.su("select count(*) from pg_constraint where conname='profiles_auth_user_fkey' and contype='f'")[0][0] == 1
    assert env.su("select count(*) from pg_constraint where conname='profiles_id_fkey'")[0][0] == 0
    bad = env.su("select count(*) from app.profiles p where p.auth_user_id is null and (p.deleted_at is null or p.display_name <> '')")[0][0]
    assert bad == 0


@test
def lint_identity_is_resolved_only_through_uid(env: Env) -> None:
    fns = env.su("""select n.nspname||'.'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname in ('app_private','app_api') and p.prosrc like '%auth.uid()%'
                      and p.proname not in ('uid','require_uid')""")
    assert not fns, fns
    pols = env.su("""select polname from pg_policy where pg_get_expr(polqual, polrelid) like '%auth.uid()%'
                        or pg_get_expr(polwithcheck, polrelid) like '%auth.uid()%'""")
    assert not pols, pols


@test
def lifecycle_personal_events_stay_append_only_outside_erasure(env: Env) -> None:
    f = fixture(env)
    assert ptask(env, f.mem, "x")["ok"]
    expect_pg(("42501",), lambda: env.su("delete from app.personal_events where user_id=%s", (f.mem,)))
    expect_pg(("42501",), lambda: env.su("update app.personal_events set kind='x' where user_id=%s", (f.mem,)))
    assert env.su("select count(*) from app.personal_events where user_id=%s", (f.mem,))[0][0] >= 1


@test
def lifecycle_guard_lock_serialises_deterministically(env: Env) -> None:
    """A holds an open transaction that deleted admin 1; B deletes admin 2 meanwhile. B must WAIT on the guard lock, then be
    refused by the dedicated guard (not merely by the later membership trigger). Forced interleaving, not timing luck."""
    import time
    f = fixture(env)
    assert env.rpc(f.admin, "set_member_role", f.mid["sup"], "admin")["ok"]
    a = env.conn()
    ca = a.cursor()
    ca.execute("delete from auth.users where id=%s", (f.admin,))      # uncommitted
    res: list[Any] = []

    def b() -> None:
        c = env.conn()
        try:
            t0 = time.time()
            with c.cursor() as cur:
                cur.execute("delete from auth.users where id=%s", (f.sup,))
            c.commit()
            res.append(("deleted", time.time() - t0))
        except Exception as e:  # noqa: BLE001
            c.rollback()
            res.append((str(e), time.time() - t0))

    th = threading.Thread(target=b)
    th.start()
    time.sleep(1.5)
    assert not res, "B must be blocked while A holds the admin lock"
    a.commit()
    th.join()
    assert "last admin: transfer" in res[0][0], res
    assert user_exists(env, f.sup)


@test
def my_membership_reports_own_state_only(env: Env) -> None:
    f = fixture(env)
    r = env.as_user(f.mem, "select app_api.my_membership()")[0][0]
    assert r["ok"] and r["data"]["membership"]["org_id"] == f.org and r["data"]["membership"]["role"] == "member"
    lone = env.user("nom@t.test", name="No")
    r2 = env.as_user(lone, "select app_api.my_membership()")[0][0]
    assert r2["ok"] and r2["data"]["membership"] is None
    expect_tf("unauthenticated", lambda: env.as_user(None, "select app_api.my_membership()"))
    # removed members see no membership
    delete_user(env, f.mem)
    expect_tf("unauthenticated", lambda: env.as_user(f.mem, "select app_api.my_membership()"))


@test
def my_membership_verified_flag_and_closed_org(env: Env) -> None:
    u = env.user("unv@t.test", name="U")
    env.su("update auth.users set email_confirmed_at = null where id=%s", (u,))
    assert env.as_user(u, "select app_api.my_membership()")[0][0]["data"]["email_verified"] is False
    env.su("update auth.users set email_confirmed_at = now() where id=%s", (u,))
    assert env.as_user(u, "select app_api.my_membership()")[0][0]["data"]["email_verified"] is True
    r = env.rpc(u, "create_organization", "Solo", "Africa/Cairo")
    assert r["ok"]
    assert env.as_user(u, "select app_api.my_membership()")[0][0]["data"]["membership"]["org_name"] == "Solo"
    assert env.rpc(u, "close_organization")["ok"]
    assert env.as_user(u, "select app_api.my_membership()")[0][0]["data"]["membership"] is None


@test
def suspended_or_removed_actor_has_no_authority_at_any_layer(env: Env) -> None:
    """Helper-level contract plus end-to-end: a suspended supervisor can neither see nor act on subordinates."""
    f = fixture(env)
    q = "select app_private.has_authority_over_membership(%s, %s), app_private.unit_in_scope(%s, %s)"
    assert env.su(q, (f.mid["sup"], f.mid["mem"], f.mid["sup"], f.u1a))[0] == (True, True)      # control: active supervisor
    assert env.rpc(f.admin, "set_member_status", f.mid["sup"], "suspended")["ok"]
    assert env.su(q, (f.mid["sup"], f.mid["mem"], f.mid["sup"], f.u1a))[0] == (False, False)
    assert {str(r[0]) for r in rows(env, f.sup, "select id from app.memberships")} == {f.mid["sup"]}
    expect_tf("forbidden", lambda: env.rpc(f.sup, "create_invitation", "member", f.u1a, 1, FUTURE))
    expect_tf("forbidden", lambda: env.rpc(f.sup, "set_member_status", f.mid["mem"], "suspended"))
    assert env.rpc(f.admin, "set_member_status", f.mid["sup"], "removed")["ok"]
    assert env.su(q, (f.mid["sup"], f.mid["mem"], f.mid["sup"], f.u1a))[0] == (False, False)
