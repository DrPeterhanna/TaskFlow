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
def update_checked_reports_overwritten_fields_atomically(env: Env) -> None:
    """Needs 0019."""
    import uuid
    u = env.user("chk@a.test", name="Chk")
    t = str(uuid.uuid4())
    env.rpc(u, "create_personal_task", t, None, "Original", None)
    env.rpc(u, "update_personal_task", t, {"title": "Other device"})                      # another device got there first
    r = env.rpc(u, "update_personal_task_checked", t, {"title": "Mine", "planned_date": "2026-12-01"}, {"title": "Original", "planned_date": None})
    assert r["ok"] is True and r["data"]["overwritten"] == {"title": "Other device"}, r   # planned_date was as the client saw it
    assert env.su("select title from app.personal_tasks where id = %s", (t,)) == [("Mine",)]   # last writer still wins
    r2 = env.rpc(u, "update_personal_task_checked", t, {"title": "Mine 2"}, {"title": "Mine"})
    assert r2["data"]["overwritten"] == {}
    r3 = env.rpc(u, "update_personal_task_checked", t, {"title": "Mine 3"}, None)           # no base: nothing reported
    assert r3["data"]["overwritten"] == {}
    from harness import new_op
    op = new_op()
    env.rpc(u, "update_personal_task", t, {"title": "X"})
    a = env.rpc(u, "update_personal_task_checked", t, {"title": "Y"}, {"title": "Mine 3"}, op=op)
    b = env.rpc(u, "update_personal_task_checked", t, {"title": "Y"}, {"title": "Mine 3"}, op=op)
    assert a == b and a["data"]["overwritten"] == {"title": "X"}                            # replay returns the stored answer
    other = env.user("chk2@a.test", name="Chk2")
    expect_tf("not_found", lambda: env.rpc(other, "update_personal_task_checked", t, {"title": "Z"}, {"title": "Y"}))
    expect_tf("validation", lambda: env.rpc(u, "update_personal_task_checked", t, {"completed_at": "2026-01-01"}, {}))
