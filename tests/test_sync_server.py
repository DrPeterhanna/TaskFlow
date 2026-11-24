"""Server-side sync recovery tests (0017). Local PostgreSQL + auth shim. NOT Supabase verification."""
from __future__ import annotations

from harness import Env, expect_tf, test
from test_phase2 import fixture


@test
def sync_status_flags_cursor_older_than_floor_only(env: Env) -> None:
    f = fixture(env)
    q = lambda after: env.as_user(f.mem, "select app_api.sync_status('personal_tasks', %s::xid8)", (after,))[0][0]["data"]  # noqa: E731
    assert q("0") == {"floor_xid": "0", "full_resync_required": False}
    env.su("insert into app.sync_floor (stream, floor_xid) values ('personal_tasks', '1000'::xid8) on conflict (stream) do update set floor_xid = excluded.floor_xid")
    assert q("0")["full_resync_required"] is False                  # a brand-new client never needs a resync
    assert q("999")["full_resync_required"] is True                 # cursor older than purged tombstones
    assert q("1000")["full_resync_required"] is False
    assert q("5000")["full_resync_required"] is False
    expect_tf("validation", lambda: env.as_user(f.mem, "select app_api.sync_status('events')"))
    # the floor is per stream
    assert env.as_user(f.mem, "select app_api.sync_status('personal_notes', '999'::xid8)")[0][0]["data"]["full_resync_required"] is False


@test
def complete_refuses_a_soft_deleted_task_and_leaves_the_tombstone_untouched(env: Env) -> None:
    """Needs 0018. On the 0001-0013 baseline this fails by design (documented defect in 0010)."""
    import uuid
    u = env.user("solo@a.test", name="Solo")
    tid = str(uuid.uuid4())
    env.rpc(u, "create_personal_task", tid, None, "T", None)
    env.rpc(u, "delete_personal_task", tid)
    before = env.su("select status, completed_at, change_xid::text from app.personal_tasks where id = %s", (tid,))
    expect_tf("not_found", lambda: env.rpc(u, "complete_personal_task", tid))
    assert env.su("select status, completed_at, change_xid::text from app.personal_tasks where id = %s", (tid,)) == before
    # a live task still completes
    t2 = str(uuid.uuid4())
    env.rpc(u, "create_personal_task", t2, None, "T2", None)
    assert env.rpc(u, "complete_personal_task", t2)["ok"] is True


@test
def update_checked_refuses_unseen_changes_and_never_overwrites(env: Env) -> None:
    """Needs 0019."""
    import uuid
    from harness import new_op
    u = env.user("chk@a.test", name="Chk")
    t = str(uuid.uuid4())
    env.rpc(u, "create_personal_task", t, None, "Original", None)
    env.rpc(u, "update_personal_task", t, {"title": "Other device"})                      # another device got there first
    before = env.su("select title, planned_date, change_xid::text from app.personal_tasks where id = %s", (t,))
    r0 = env.rpc(u, "update_personal_task_checked", t, {"title": "Mine", "planned_date": "2026-12-01"}, {"title": "Original", "planned_date": None})
    assert r0["ok"] is False and r0["code"] == "stale_conflict" and r0["current"] == {"title": "Other device"}, r0
    assert env.su("select title, planned_date, change_xid::text from app.personal_tasks where id = %s", (t,)) == before   # nothing applied, not even the unrelated field
    assert env.su("select count(*) from app.personal_events where kind = 'ptask.updated'")[0][0] == 1                    # only the other device's edit
    # the refusal is terminal: resend returns the same refusal, and it STILL does after the values change back to the base
    op = new_op()
    first = env.rpc(u, "update_personal_task_checked", t, {"title": "Mine"}, {"title": "Original"}, op=op)
    assert first["ok"] is False and first["code"] == "stale_conflict"
    assert env.rpc(u, "update_personal_task_checked", t, {"title": "Mine"}, {"title": "Original"}, op=op) == first
    env.rpc(u, "update_personal_task", t, {"title": "Original"})                     # values change back to what the refused op expected
    assert env.rpc(u, "update_personal_task_checked", t, {"title": "Mine"}, {"title": "Original"}, op=op) == first
    assert env.su("select title from app.personal_tasks where id = %s", (t,)) == [("Original",)]   # the old op did NOT commit
    env.rpc(u, "update_personal_task", t, {"title": "Other device"})
    # fresh op with a fresh base (the user saw "Other device" and chose to keep theirs) applies
    r = env.rpc(u, "update_personal_task_checked", t, {"title": "Mine"}, {"title": "Other device"})
    assert r["ok"] is True and r["data"]["overwritten"] == {}
    assert env.su("select title from app.personal_tasks where id = %s", (t,)) == [("Mine",)]
    # writing the value that is already there is not a conflict
    assert env.rpc(u, "update_personal_task_checked", t, {"title": "Mine"}, {"title": "Stale"})["ok"] is True
    # replay of an applied op returns the stored answer
    op2 = new_op()
    a = env.rpc(u, "update_personal_task_checked", t, {"title": "Y"}, {"title": "Mine"}, op=op2)
    b = env.rpc(u, "update_personal_task_checked", t, {"title": "Y"}, {"title": "Mine"}, op=op2)
    assert a == b
    # base is required; other users cannot touch the task; server-controlled fields refused
    expect_tf("validation", lambda: env.rpc(u, "update_personal_task_checked", t, {"title": "Z"}, None))
    other = env.user("chk2@a.test", name="Chk2")
    expect_tf("not_found", lambda: env.rpc(other, "update_personal_task_checked", t, {"title": "Z"}, {"title": "Y"}))
    expect_tf("validation", lambda: env.rpc(u, "update_personal_task_checked", t, {"completed_at": "2026-01-01"}, {}))


# ---------------------------------------------------------------- 0020 conditional complete / reopen / delete
def _task(env: Env, u: str, title: str = "T", parent: str | None = None) -> str:
    import uuid
    t = str(uuid.uuid4())
    env.rpc(u, "create_personal_task", t, parent, title, None)
    return t


def _row(env: Env, t: str):
    return env.su("select status, row_version, deleted_at is not null, title from app.personal_tasks where id = %s", (t,))[0]


def _events(env: Env, t: str) -> int:
    return env.su("select count(*) from app.personal_events where subject_id = %s", (t,))[0][0]


@test
def checked_complete_refuses_when_status_changed_elsewhere_and_the_refusal_is_terminal(env: Env) -> None:
    """Needs 0020. Device saw 'todo'; another device cancelled the task. Completing must not silently overwrite that."""
    from harness import new_op
    u = env.user("c1@a.test", name="C1")
    t = _task(env, u)
    env.rpc(u, "update_personal_task_checked", t, {"status": "canceled"}, {"status": "todo"})
    before, ev = _row(env, t), _events(env, t)
    op = new_op()
    r = env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"}, op=op)
    assert r["ok"] is False and r["code"] == "stale_conflict" and r["current"]["status"] == "canceled"
    assert _row(env, t) == before and _events(env, t) == ev               # nothing changed, nothing emitted
    env.rpc(u, "update_personal_task_checked", t, {"status": "todo"}, {"status": "canceled"})   # values change BACK to what the device saw
    assert env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"}, op=op)["code"] == "stale_conflict"   # same op: terminal
    assert _row(env, t)[0] == "todo"
    fresh = env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"})                # explicit fresh op with a fresh base
    assert fresh["ok"] is True and _row(env, t)[0] == "done"


@test
def checked_complete_and_reopen_are_idempotent_when_the_goal_is_already_reached(env: Env) -> None:
    u = env.user("c2@a.test", name="C2")
    t = _task(env, u)
    assert env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"})["ok"]
    ev = _events(env, t)
    r = env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"})                     # second device, stale base, same goal
    assert r["ok"] is True and r["data"]["already"] is True and _events(env, t) == ev
    assert env.rpc(u, "reopen_personal_task_checked", t, {"status": "done"})["ok"]
    ev = _events(env, t)
    r = env.rpc(u, "reopen_personal_task_checked", t, {"status": "done"})
    assert r["data"]["already"] is True and _events(env, t) == ev and _row(env, t)[0] == "todo"
    # reopen refused when the task moved on to another state the device never saw
    env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"})
    env.rpc(u, "reopen_personal_task_checked", t, {"status": "done"})
    env.rpc(u, "update_personal_task_checked", t, {"status": "in_progress"}, {"status": "todo"})
    r = env.rpc(u, "reopen_personal_task_checked", t, {"status": "done"})
    assert r["ok"] is False and r["code"] == "stale_conflict" and _row(env, t)[0] == "in_progress"


def _subtree_base(env: Env, t: str, own: list[str] | None = None) -> dict:
    rows = env.su("""with recursive sub as (select id, row_version from app.personal_tasks where id = %s and deleted_at is null
                     union all select c.id, c.row_version from app.personal_tasks c join sub s on c.parent_id = s.id where c.deleted_at is null)
                     select id::text, row_version from sub""", (t,))
    return {"rows": {r[0]: r[1] for r in rows}, "own_ops": own or []}


@test
def checked_delete_refuses_any_unseen_change_in_the_subtree_and_the_refusal_is_terminal(env: Env) -> None:
    """The device saw parent > child > grandchild. Each foreign change below must be refused before anything is deleted."""
    from harness import new_op
    u = env.user("c3@a.test", name="C3")
    t = _task(env, u, "parent"); child = _task(env, u, "child", t); gc = _task(env, u, "grandchild", child)
    seen = _subtree_base(env, t)
    live = lambda *ids: [_row(env, x)[2] for x in ids]  # noqa: E731

    def refused(base: dict, why: str) -> str:
        op = new_op()
        r = env.rpc(u, "delete_personal_task_checked", t, base, op=op)
        assert r["ok"] is False and r["code"] == "stale_conflict", (why, r)
        assert live(t, child, gc) == [False, False, False], why                      # nothing deleted
        return op

    env.rpc(u, "update_personal_task_checked", gc, {"title": "edited elsewhere"}, {"title": "grandchild"})   # (a) remote edit of a deep subtask
    op = refused(seen, "grandchild edit")
    env.rpc(u, "update_personal_task_checked", gc, {"title": "grandchild"}, {"title": "edited elsewhere"})   # values change back, row_version does not
    assert env.rpc(u, "delete_personal_task_checked", t, seen, op=op)["code"] == "stale_conflict"            # same op: terminal
    refused(seen, "versions never go back")
    seen = _subtree_base(env, t)
    new_child = _task(env, u, "added elsewhere", t)                                                         # (b) remote new subtask
    refused(seen, "new subtask")
    seen = _subtree_base(env, t)
    env.rpc(u, "delete_personal_task", new_child); seen = _subtree_base(env, t)
    env.rpc(u, "restore_personal_task", new_child)                                                          # (c) remote restore of a deleted subtask
    refused(seen, "restored subtask")
    seen = _subtree_base(env, t)
    env.rpc(u, "update_personal_task_checked", t, {"notes": "n"}, {"notes": None})                          # (d) remote edit of the task itself
    refused(seen, "root edit")
    # a remotely DELETED subtask loses nothing when its parent is deleted too: allowed
    seen = _subtree_base(env, t)
    env.rpc(u, "delete_personal_task", new_child)
    seen = _subtree_base(env, t)
    r = env.rpc(u, "delete_personal_task_checked", t, seen)
    assert r["ok"] is True and live(t, child, gc) == [True, True, True]
    again = env.rpc(u, "delete_personal_task_checked", t, seen)                                             # already deleted: idempotent
    assert again["ok"] is True and again["data"]["already"] is True


@test
def checked_delete_accounts_for_the_devices_own_earlier_ops_but_not_for_anyone_elses(env: Env) -> None:
    from harness import new_op
    u = env.user("c6@a.test", name="C6")
    t = _task(env, u, "p")
    seen = _subtree_base(env, t)
    o1, o2, o3 = new_op(), new_op(), new_op()
    import uuid
    ch = str(uuid.uuid4())
    env.rpc(u, "create_personal_task", ch, t, "own child", None, op=o1)                                      # own ops after the base was taken
    env.rpc(u, "update_personal_task_checked", ch, {"title": "own child 2"}, {"title": "own child"}, op=o2)
    env.rpc(u, "update_personal_task_checked", t, {"notes": "mine"}, {"notes": None}, op=o3)
    ok = env.rpc(u, "delete_personal_task_checked", t, {**seen, "own_ops": [o1, o2, o3]})
    assert ok["ok"] is True
    # same chain, but someone else ALSO edited the child in between: not covered by own_ops
    t2 = _task(env, u, "p2"); seen2 = _subtree_base(env, t2)
    ch2 = str(uuid.uuid4()); m1 = new_op()
    env.rpc(u, "create_personal_task", ch2, t2, "c", None, op=m1)
    env.rpc(u, "update_personal_task_checked", ch2, {"title": "foreign"}, {"title": "c"})               # no own op id
    r = env.rpc(u, "delete_personal_task_checked", t2, {**seen2, "own_ops": [m1]})
    assert r["ok"] is False and r["code"] == "stale_conflict" and _row(env, t2)[2] is False


@test
def checked_mutations_require_a_base_refuse_other_users_and_deleted_tasks(env: Env) -> None:
    u, w = env.user("c4@a.test", name="C4"), env.user("c5@a.test", name="C5")
    t = _task(env, u)
    for fn, base in (("complete_personal_task_checked", {}), ("reopen_personal_task_checked", {}), ("delete_personal_task_checked", {})):
        expect_tf("validation", lambda fn=fn, base=base: env.rpc(u, fn, t, base))
    for fn, base in (("complete_personal_task_checked", {"status": "todo"}), ("delete_personal_task_checked", {"rows": {}})):
        expect_tf("not_found", lambda fn=fn, base=base: env.rpc(w, fn, t, base))                    # not the owner
    assert env.rpc(u, "delete_personal_task_checked", t, _subtree_base(env, t))["ok"]
    expect_tf("not_found", lambda: env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"}))   # tombstone
    assert _row(env, t)[2] is True
