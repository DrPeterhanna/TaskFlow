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
