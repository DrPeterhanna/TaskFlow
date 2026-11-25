"""Server-side sync recovery tests (0017). Local PostgreSQL + auth shim. NOT Supabase verification."""
from __future__ import annotations

from harness import Env, expect_tf, test
from test_phase2 import fixture


@test
def sync_status_flags_cursor_older_than_floor_only(env: Env) -> None:
    f = fixture(env)
    q = lambda after: env.as_user(f.mem, "select app_api.sync_status('personal_tasks', %s::xid8)", (after,))[0][0]["data"]  # noqa: E731
    assert q("0") == {"floor_xid": "0", "full_resync_required": False, "mutation_safety_version": 2}
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


@test
def checked_delete_refuses_a_remote_edit_and_a_remote_subtask_edit_unseen_by_the_device(env: Env) -> None:
    from harness import new_op
    u = env.user("c3@a.test", name="C3")
    t = _task(env, u, "parent")
    child = _task(env, u, "child", t)
    st, ver, _, _ = _row(env, t)
    sub = env.su("select count(*), coalesce(sum(row_version),0) from app.personal_tasks where parent_id = %s and deleted_at is null", (t,))[0]
    base = {"row_version": ver, "subtree": {"n": sub[0], "sum": int(sub[1])}}
    env.rpc(u, "update_personal_task_checked", child, {"title": "edited elsewhere"}, {"title": "child"})   # remote edit of a subtask
    op = new_op()
    r = env.rpc(u, "delete_personal_task_checked", t, base, op=op)
    assert r["ok"] is False and r["code"] == "stale_conflict"
    assert _row(env, t)[2] is False and _row(env, child)[2] is False and _row(env, child)[3] == "edited elsewhere"
    assert env.rpc(u, "delete_personal_task_checked", t, base, op=op)["code"] == "stale_conflict"          # terminal on resend
    # the parent itself edited elsewhere
    env.rpc(u, "update_personal_task_checked", t, {"notes": "n"}, {"notes": None})
    _, ver2, _, _ = _row(env, t)
    sub2 = env.su("select count(*), coalesce(sum(row_version),0) from app.personal_tasks where parent_id = %s and deleted_at is null", (t,))[0]
    assert env.rpc(u, "delete_personal_task_checked", t, {"row_version": ver}, op=new_op())["code"] == "stale_conflict"
    fresh = env.rpc(u, "delete_personal_task_checked", t, {"row_version": ver2, "subtree": {"n": sub2[0], "sum": int(sub2[1]), "members": [{"id": child, "rv": _row(env, child)[1]}]}})
    assert fresh["ok"] is True and fresh["data"]["rows"] == 2 and _row(env, t)[2] and _row(env, child)[2]
    again = env.rpc(u, "delete_personal_task_checked", t, base)                                              # already deleted: idempotent
    assert again["ok"] is True and again["data"]["already"] is True


@test
def checked_mutations_require_a_base_refuse_other_users_and_deleted_tasks(env: Env) -> None:
    u, w = env.user("c4@a.test", name="C4"), env.user("c5@a.test", name="C5")
    t = _task(env, u)
    for fn, base in (("complete_personal_task_checked", {}), ("reopen_personal_task_checked", {}), ("delete_personal_task_checked", {})):
        expect_tf("validation", lambda fn=fn, base=base: env.rpc(u, fn, t, base))
    for fn, base in (("complete_personal_task_checked", {"status": "todo"}), ("delete_personal_task_checked", {"row_version": 1})):
        expect_tf("not_found", lambda fn=fn, base=base: env.rpc(w, fn, t, base))                    # not the owner
    assert env.rpc(u, "delete_personal_task_checked", t, {"row_version": _row(env, t)[1]})["ok"]
    expect_tf("not_found", lambda: env.rpc(u, "complete_personal_task_checked", t, {"status": "todo"}))   # tombstone
    assert _row(env, t)[2] is True


@test
def checked_patch_missing_field_base_never_bypasses_guard(env: Env) -> None:
    u = env.user('strict-base@test.dev', name='Strict')
    t = _task(env, u, 'Original')
    expect_tf('validation', lambda: env.rpc(u, 'update_personal_task_checked', t, {'title': 'Overwrite'}, {}))
    assert _row(env, t)[3] == 'Original'


@test
def subtree_requires_exact_members_not_only_count_and_sum(env: Env) -> None:
    u = env.user('exact-subtree@test.dev', name='Exact')
    t = _task(env, u, 'Root')
    c = _task(env, u, 'Child', t)
    rv = _row(env, t)[1]
    for base in ({'row_version': rv}, {'row_version': rv, 'subtree': {'n': 1, 'sum': 1}},
                 {'row_version': None, 'subtree': {'n': 1, 'sum': 1, 'members': [{'id': c, 'rv': 1}]}}):
        r = env.rpc(u, 'delete_personal_task_checked', t, base)
        assert not r['ok'] and r['code'] == 'stale_conflict'
    assert not _row(env, t)[2] and not _row(env, c)[2]
    r = env.rpc(u, 'delete_personal_task_checked', t, {'row_version': rv, 'subtree': {'n': 1, 'sum': 1, 'members': [{'id': c, 'rv': 1}]}})
    assert r['ok'] and r['data']['rows'] == 2


@test
def subtree_delete_serializes_with_uncommitted_descendant_edit(env: Env) -> None:
    import psycopg2
    from psycopg2.extras import Json
    from harness import new_op
    u = env.user('subtree-lock@test.dev', name='Lock')
    t = _task(env, u, 'Root')
    child = _task(env, u, 'Child', t)
    c1 = env.conn()
    c1.cursor().execute('update app.personal_tasks set title=%s where id=%s', ('Remote child edit', child))
    c2 = env.conn(u)
    q = c2.cursor()
    q.execute("set lock_timeout = '400ms'")
    try:
        q.execute('select app_api.delete_personal_task_checked(%s,%s,%s)', (new_op(), t, Json({'row_version': 1, 'subtree': {'n': 1, 'sum': 1, 'members': [{'id': child, 'rv': 1}]}})))
        raise AssertionError('delete failed to wait for descendant writer')
    except psycopg2.Error as e:
        assert e.pgcode == '55P03', e.pgcode
    c2.rollback()
    c1.commit()
    r = env.rpc(u, 'delete_personal_task_checked', t, {'row_version': 1, 'subtree': {'n': 1, 'sum': 1, 'members': [{'id': child, 'rv': 1}]}})
    assert not r['ok'] and r['code'] == 'stale_conflict'
    assert _row(env, child)[3] == 'Remote child edit' and not _row(env, child)[2]


@test
def queued_child_cannot_create_beneath_a_deleted_parent(env: Env) -> None:
    import uuid
    u = env.user('deleted-parent@test.dev', name='Parent')
    root = _task(env, u, 'Root')
    assert env.rpc(u, 'delete_personal_task_checked', root, {'row_version': 1})['ok']
    child = str(uuid.uuid4())
    expect_tf('not_found', lambda: env.rpc(u, 'create_personal_task', child, root, 'Queued child', None))
    assert env.su('select count(*) from app.personal_tasks where id=%s', (child,))[0][0] == 0


@test
def expired_offline_operation_cannot_reexecute_even_after_receipt_loss(env: Env) -> None:
    from harness import new_op, old_op
    u = env.user('expired-offline@test.dev', name='Expired')
    t = _task(env, u, 'Safe')
    before = _row(env, t)
    expect_tf('op_expired', lambda: env.rpc(u, 'update_personal_task_checked', t, {'title': 'Too late'}, {'title': 'Safe'}, op=old_op(120)))
    assert _row(env, t) == before
    # Deleting a receipt manually cannot bypass the age check. No cleanup job is being enabled here.
    op = new_op()
    assert env.rpc(u, 'update_personal_task_checked', t, {'title': 'Committed'}, {'title': 'Safe'}, op=op)['ok']
    env.su('delete from app.op_receipts where op_id=%s', (op,))
    expect_tf('op_expired', lambda: env.rpc(u, 'update_personal_task_checked', t, {'title': 'Too late'}, {'title': 'Committed'}, op=old_op(120)))
    assert _row(env, t)[3] == 'Committed'


@test
def child_insert_waiting_behind_delete_cannot_use_stale_parent_snapshot(env: Env) -> None:
    import psycopg2
    from psycopg2.extras import Json
    from harness import new_op
    import threading
    import time
    import uuid
    u = env.user('insert-after-delete@test.dev', name='Insert')
    root = _task(env, u, 'Root')
    c1 = env.conn(u)
    q = c1.cursor()
    q.execute('select app_api.delete_personal_task_checked(%s,%s,%s)', (new_op(), root, Json({'row_version': 1})))
    result = []
    child = str(uuid.uuid4())
    def insert():
        try:
            result.append(env.rpc(u, 'create_personal_task', child, root, 'Racing child', None))
        except Exception as e:
            result.append(e)
    thread = threading.Thread(target=insert)
    thread.start()
    time.sleep(0.1)
    assert thread.is_alive(), 'child insert did not wait behind destructive lock'
    c1.commit()
    thread.join(5)
    assert not thread.is_alive(), 'child writer failed to settle'
    assert len(result) == 1 and not isinstance(result[0], dict), result
    assert env.su('select count(*) from app.personal_tasks where id=%s', (child,))[0][0] == 0


@test
def coarse_delete_lock_concurrent_local_stress_and_same_id_retry(env: Env) -> None:
    import threading
    import uuid
    import time
    from harness import new_op
    users = [env.user(f'stress-{i}@test.dev', name=f'Stress{i}') for i in range(4)]
    roots = [(u, _task(env, u, f'Root{i}')) for i, u in enumerate(users)]
    barrier = threading.Barrier(12)
    outcomes = []
    lock = threading.Lock()
    def worker(index):
        uid, root = roots[index // 3]
        op = new_op()
        try:
            barrier.wait(timeout=5)
            if index % 3 == 0:
                result = env.rpc(uid, 'delete_personal_task_checked', root, {'row_version': 1, 'subtree': {'n': 0, 'sum': 0, 'members': []}}, op=op)
                assert env.rpc(uid, 'delete_personal_task_checked', root, {'row_version': 1, 'subtree': {'n': 0, 'sum': 0, 'members': []}}, op=op) == result
            elif index % 3 == 1:
                result = env.rpc(uid, 'update_personal_task_checked', root, {'title': 'Remote edit'}, {'title': f'Root{index//3}'}, op=op)
            else:
                result = env.rpc(uid, 'create_personal_task', str(uuid.uuid4()), root, 'Concurrent child', None, op=op)
            with lock:
                outcomes.append(('ok', result))
        except Exception as e:
            # Business refusal is expected if delete committed first. Deadlocks/unexpected SQL errors are not.
            from harness import TFError
            with lock:
                outcomes.append(('refused' if isinstance(e, TFError) and e.code == 'not_found' else 'error', str(e)))
    started = time.monotonic()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(12)]
    for th in threads: th.start()
    for th in threads: th.join(15)
    assert not any(th.is_alive() for th in threads), 'stress stalled'
    assert len(outcomes) == 12, len(outcomes)
    errors = [r for r in outcomes if r[0] == 'error']
    if errors: print('STRESS ERRORS', errors, flush=True)
    assert not errors, errors
    assert env.su('select count(*) from app.personal_tasks c join app.personal_tasks p on p.id=c.parent_id where c.deleted_at is null and p.deleted_at is not null')[0][0] == 0
    assert env.su('select count(*) from app.op_receipts where result is null')[0][0] == 0
    elapsed = time.monotonic() - started
    print(f'LOCAL lock stress: 12 concurrent operations, 4 accounts, {elapsed:.3f}s; not a hosted throughput benchmark', flush=True)


@test
def max_purged_xid_is_not_a_safe_contiguous_retention_watermark(env: Env) -> None:
    """Prove why purge remains disabled: a lower in-flight xid can commit behind a guessed floor."""
    u = env.user('watermark-counterexample@test.dev', name='Watermark')
    task = _task(env, u, 'Old')
    c1 = env.conn()
    q1 = c1.cursor()
    q1.execute('update app.personal_tasks set title=%s where id=%s returning change_xid::text', ('Late commit', task))
    old_xid = q1.fetchone()[0]
    marker = _task(env, u, 'Newer transaction')
    high_xid = env.su('select change_xid::text from app.personal_tasks where id=%s', (marker,))[0][0]
    assert int(old_xid) < int(high_xid)
    c1.commit()
    # A fictional consumer that trusted max-purged-xid would skip the late committed edit.
    result = env.as_user(u, "select app_api.sync_pull('personal_tasks',%s::xid8,'',null,200)", (high_xid,))[0][0]
    assert task not in [r['id'] for r in result['rows']]
    assert _row(env, task)[3] == 'Late commit'
    # Existing true xmin horizon does not advance past an in-flight writer. No cleanup/floor mutation here.


@test
def seeded_mixed_personal_rpc_replay_after_simulated_lost_responses(env: Env) -> None:
    import random
    import threading
    import uuid
    from harness import new_op
    users = [env.user(f'model-{i}@test.dev', name=f'Model{i}') for i in range(4)]
    barrier = threading.Barrier(4)
    errors = []
    replayed = []
    def worker(index):
        rng = random.Random(9000 + index)
        uid = users[index]
        try:
            barrier.wait(5)
            for round_no in range(12):
                tid = str(uuid.uuid4())
                title = f'Model {index}-{round_no}'
                op = new_op()
                first = env.rpc(uid, 'create_personal_task', tid, None, title, None, op=op)
                # Client loses the result, replays the exact call. No new operation ID is generated.
                assert env.rpc(uid, 'create_personal_task', tid, None, title, None, op=op) == first
                versions = 1
                for edit in range(rng.randrange(1, 4)):
                    new_title = f'{title}:{edit}'
                    op = new_op()
                    first = env.rpc(uid, 'update_personal_task_checked', tid, {'title': new_title}, {'title': title}, op=op)
                    assert first['ok'], first
                    assert env.rpc(uid, 'update_personal_task_checked', tid, {'title': new_title}, {'title': title}, op=op) == first
                    title = new_title
                    versions += 1
                assert _row(env, tid)[1] == versions
                if rng.randrange(2):
                    op = new_op()
                    base = {'row_version': versions, 'subtree': {'n': 0, 'sum': 0, 'members': []}}
                    first = env.rpc(uid, 'delete_personal_task_checked', tid, base, op=op)
                    assert first['ok'], first
                    assert env.rpc(uid, 'delete_personal_task_checked', tid, base, op=op) == first
                    assert _row(env, tid)[2]
                else:
                    assert _row(env, tid)[3] == title and not _row(env, tid)[2]
                replayed.append(tid)
        except Exception as e:
            errors.append(repr(e))
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
    for th in threads: th.start()
    for th in threads: th.join(30)
    assert not any(th.is_alive() for th in threads), 'mixed replay test stalled'
    assert not errors, errors
    assert len(replayed) == 48
    assert env.su('select count(*) from app.op_receipts where result is null')[0][0] == 0


@test
def advisory_lock_cancellation_releases_failed_writer_and_allows_same_id_retry(env: Env) -> None:
    import threading
    import time
    from harness import new_op
    from psycopg2.extras import Json
    u = env.user('lock-cancel@test.dev', name='Cancel')
    tid = _task(env, u, 'Must survive')
    op = new_op()
    holder = env.conn(u)
    q = holder.cursor()
    q.execute('select app_api.update_personal_task_checked(%s,%s,%s,%s)', (op, tid, Json({'title': 'Uncommitted'}), Json({'title': 'Must survive'})))
    pid = holder.get_backend_pid()
    waiting = []
    def retry():
        try:
            waiting.append(env.rpc(u, 'update_personal_task_checked', tid, {'title': 'Uncommitted'}, {'title': 'Must survive'}, op=op))
        except Exception as e:
            waiting.append(repr(e))
    thread = threading.Thread(target=retry)
    thread.start()
    time.sleep(0.1)
    assert thread.is_alive(), 'retry did not wait for in-flight transaction'
    assert env.su('select pg_terminate_backend(%s)', (pid,))[0][0]
    thread.join(5)
    assert not thread.is_alive() and len(waiting) == 1 and isinstance(waiting[0], dict) and waiting[0]['ok'], waiting
    assert _row(env, tid)[3] == 'Uncommitted' and _row(env, tid)[1] == 2
    assert env.rpc(u, 'update_personal_task_checked', tid, {'title': 'Uncommitted'}, {'title': 'Must survive'}, op=op) == waiting[0]
    assert env.su('select count(*) from app.op_receipts where user_id=%s and op_id=%s', (u, op))[0][0] == 1


@test
def advisory_lock_increasing_concurrency_replay_keeps_exact_versions(env: Env) -> None:
    import threading
    import uuid
    import time
    from harness import new_op
    uid = env.user('lock-load@test.dev', name='Load')
    for width in (1, 4, 16, 32):
        barrier = threading.Barrier(width)
        errors = []
        successes = []
        def worker(index):
            try:
                tid = str(uuid.uuid4())
                op = new_op()
                barrier.wait(5)
                result = env.rpc(uid, 'create_personal_task', tid, None, f'Load{width}-{index}', None, op=op)
                assert result['ok'] and env.rpc(uid, 'create_personal_task', tid, None, f'Load{width}-{index}', None, op=op) == result
                assert _row(env, tid)[1] == 1
                successes.append(tid)
            except Exception as e:
                errors.append(repr(e))
        started = time.monotonic()
        threads = [threading.Thread(target=worker, args=(i,)) for i in range(width)]
        for th in threads: th.start()
        for th in threads: th.join(15)
        assert not any(th.is_alive() for th in threads) and not errors and len(successes) == width, (width, errors)
        print(f'LOCAL concurrency width={width}, creates+duplicates={2*width}, elapsed={time.monotonic()-started:.3f}s; not hosted capacity', flush=True)

@test
def sync_pull_cursor_uses_numeric_xid_order_across_decimal_widths(env: Env) -> None:
    uid = env.user('numeric-cursor@local.test')
    import uuid
    ids = [str(uuid.uuid4()) for _ in range(3)]
    for i, tid in enumerate(ids):
        assert env.rpc(uid, 'create_personal_task', tid, None, f'Numeric cursor {i}', None)['ok']
    # Explicit fixture stamps avoid depending on naturally crossing transaction 999/1000.
    env.su('alter table app.personal_tasks disable trigger user')
    try:
        for tid, xid in zip(ids, ['9','10','100']):
            env.su('update app.personal_tasks set change_xid=%s::xid8 where id=%s', (xid,tid))
    finally:
        env.su('alter table app.personal_tasks enable trigger user')
    def pull(ax, aid, limit):
        return env.as_user(uid, 'select app_api.sync_pull(%s,%s::xid8,%s,%s::xid8,%s)', ('personal_tasks', ax, aid, '1000', limit))[0][0]
    first = pull('0','',2)
    assert [r['change_xid'] for r in first['rows']] == ['9','10']
    assert (first['next_xid'],first['next_id']) == ('10',ids[1]), first
    second = pull(first['next_xid'],first['next_id'],2)
    assert [r['id'] for r in second['rows']] == [ids[2]]
    assert (second['next_xid'],second['next_id']) == ('100',ids[2])
    whole = pull('0','',200)
    assert whole['next_xid'] == '100' and whole['next_id'] == ids[2]
