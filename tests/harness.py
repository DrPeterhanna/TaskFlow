"""Test harness: real PostgreSQL (local, via pgserver), NOT Supabase. Template DB per run."""
from __future__ import annotations

import json
import random
import tempfile
import time
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pgserver
import psycopg2
import psycopg2.extensions
from psycopg2.extras import Json

ROOT = Path(__file__).resolve().parent.parent
TESTS: list[tuple[str, Callable[["Env"], None]]] = []


def test(fn: Callable[["Env"], None]) -> Callable[["Env"], None]:
    TESTS.append((fn.__name__, fn))
    return fn


class TFError(Exception):
    def __init__(self, code: str, state: str):
        super().__init__(f"{code} ({state})")
        self.code = code
        self.state = state


def new_op() -> str:
    ms = int(time.time() * 1000)
    h = f"{ms:012x}" + "7" + f"{random.getrandbits(12):03x}" + f"{0x8000 | random.getrandbits(14):04x}" + f"{random.getrandbits(48):012x}"
    return str(uuid.UUID(h))


def old_op(days: int) -> str:
    ms = int((time.time() - days * 86400) * 1000)
    h = f"{ms:012x}" + "7" + f"{random.getrandbits(12):03x}" + f"{0x8000 | random.getrandbits(14):04x}" + f"{random.getrandbits(48):012x}"
    return str(uuid.UUID(h))


class Env:
    def __init__(self, uri_for: Callable[[str], str], dbname: str):
        self.uri_for = uri_for
        self.dbname = dbname
        self._conns: list[Any] = []

    def conn(self, uid: str | None = None, role: str = "authenticated") -> Any:
        c = psycopg2.connect(self.uri_for(self.dbname))
        self._conns.append(c)
        with c.cursor() as cur:
            if uid is not None:
                cur.execute("select set_config('request.jwt.claim.sub', %s, false)", (uid,))
            if uid is not None or role == "anon":
                cur.execute(f"set role {role}")
        c.commit()
        return c

    def su(self, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        c = self.conn()
        try:
            with c.cursor() as cur:
                cur.execute(sql, params or None)
                rows = cur.fetchall() if cur.description else []
            c.commit()
            return rows
        finally:
            c.close()

    def as_user(self, uid: str | None, sql: str, params: tuple[Any, ...] = ()) -> list[tuple[Any, ...]]:
        c = self.conn(uid)
        try:
            with c.cursor() as cur:
                try:
                    cur.execute(sql, params or None)
                except psycopg2.Error as e:
                    c.rollback()
                    raise wrap(e) from e
                rows = cur.fetchall() if cur.description else []
            try:
                c.commit()
            except psycopg2.Error as e:
                c.rollback()
                raise wrap(e) from e
            return rows
        finally:
            c.close()

    def rpc(self, uid: str | None, fn: str, *args: Any, op: str | None = None, casts: str = "") -> dict[str, Any]:
        op = op or new_op()
        ph = ", ".join(["%s"] * (len(args) + 1))
        sql = f"select app_api.{fn}({ph})"
        conv = tuple(Json(a) if isinstance(a, dict) else a for a in args)
        rows = self.as_user(uid, sql, (op, *conv))
        res = rows[0][0]
        return res if isinstance(res, dict) else json.loads(res)

    def user(self, email: str, verified: bool = True, name: str = "") -> str:
        rows = self.su(
            "insert into auth.users (email, email_confirmed_at, raw_user_meta_data) "
            "values (%s, case when %s then now() end, %s) returning id",
            (email, verified, json.dumps({"display_name": name})),
        )
        return str(rows[0][0])

    def close(self) -> None:
        for c in self._conns:
            try:
                c.close()
            except Exception:
                pass


def wrap(e: psycopg2.Error) -> Exception:
    state = e.pgcode or ""
    if state.startswith("TF"):
        detail = (e.diag.message_detail or "{}")
        try:
            code = json.loads(detail).get("code", state)
        except ValueError:
            code = state
        return TFError(code, state)
    return e


def expect_tf(code: str, fn: Callable[[], Any]) -> None:
    try:
        fn()
    except TFError as e:
        assert e.code == code, f"expected {code}, got {e.code}"
        return
    raise AssertionError(f"expected TF error {code}, call succeeded")


def expect_pg(states: tuple[str, ...], fn: Callable[[], Any]) -> None:
    try:
        fn()
    except psycopg2.Error as e:
        assert e.pgcode in states, f"expected one of {states}, got {e.pgcode}: {e}"
        return
    except TFError as e:
        assert e.state in states, f"expected one of {states}, got {e.state}"
        return
    raise AssertionError(f"expected db error {states}, call succeeded")


class Cluster:
    def __init__(self, migrations_dir: Path):
        self.tmp = tempfile.mkdtemp(prefix="tf-pg-")
        self.server = pgserver.get_server(self.tmp, cleanup_mode="stop")
        base = self.server.get_uri()
        self.base = base
        self.migrations_dir = migrations_dir
        self._make_template()

    def uri_for(self, db: str) -> str:
        return self.base.replace("/postgres?", f"/{db}?") if "/postgres?" in self.base else self.base.rsplit("/", 1)[0] + "/" + db

    def _admin(self) -> Any:
        c = psycopg2.connect(self.base)
        c.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
        return c

    def _make_template(self) -> None:
        a = self._admin()
        a.cursor().execute("create database tf_template")
        a.close()
        c = psycopg2.connect(self.uri_for("tf_template"))
        c.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
        cur = c.cursor()
        cur.execute((ROOT / "tests/support/00_supabase_shim.sql").read_text())
        for f in sorted(self.migrations_dir.glob("*.sql")):
            try:
                cur.execute(f.read_text())
            except psycopg2.Error as e:
                raise RuntimeError(f"migration {f.name} failed: {e}") from e
        c.close()

    def fresh(self) -> Env:
        name = "tf_" + uuid.uuid4().hex[:10]
        a = self._admin()
        a.cursor().execute(f"create database {name} template tf_template")
        a.close()
        return Env(self.uri_for, name)

    def drop(self, env: Env) -> None:
        env.close()
        a = self._admin()
        a.cursor().execute(f"drop database if exists {env.dbname} with (force)")
        a.close()


def run_all(migrations_dir: Path, only: list[str] | None = None) -> dict[str, str]:
    results: dict[str, str] = {}
    cluster = Cluster(migrations_dir)
    try:
        for name, fn in TESTS:
            if only and name not in only:
                continue
            env = cluster.fresh()
            try:
                fn(env)
                results[name] = "pass"
            except Exception as e:  # noqa: BLE001
                import traceback
                fr = [f for f in traceback.extract_tb(e.__traceback__) if f.filename.endswith(("test_phase2.py", "test_lifecycle.py"))]
                results[name] = f"FAIL: {type(e).__name__}: {str(e)[:300]}" + (f" @{fr[-1].filename.split(chr(47))[-1]}:{fr[-1].lineno}" if fr else "")
            finally:
                cluster.drop(env)
    finally:
        cluster.server.cleanup()
    return results
