"""TEST-ONLY HTTP bridge: exposes the LOCAL PostgreSQL RPCs to the TypeScript client tests.
It is NOT Supabase/PostgREST: no real JWTs, no pooler. It sets request.jwt.claim.sub per call like the shim does.
Endpoints (POST JSON): /user, /rpc, /pull, /sql (superuser, assertions only), /fault (drop next N responses after applying)."""
from __future__ import annotations

import json

import psycopg2 as psycopg
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402

state = {"drop": 0}
lock = threading.Lock()


class H(BaseHTTPRequestHandler):
    env: harness.Env

    def log_message(self, *a: object) -> None:  # silence
        pass

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _cors(self) -> None:   # test-only: the browser preview runs on another local port
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-allow-methods", "POST, OPTIONS")

    def _send(self, code: int, body: object) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self._cors()
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        try:
            if self.path == "/user":
                self._send(200, {"id": self.env.user(body["email"], True, body.get("name", ""))})
            elif self.path == "/fault":
                with lock:
                    state["drop"] = int(body["drop"])
                self._send(200, {"ok": True})
            elif self.path == "/sql":
                rows = self.env.su(body["query"])
                self._send(200, {"rows": json.loads(json.dumps(rows, default=str))})
            elif self.path == "/rpc":
                try:
                    res = self.env.rpc(body["uid"], body["fn"], *body["args"], op=body["op"])
                except harness.TFError as e:
                    res = {"ok": False, "code": e.code}
                with lock:
                    drop = state["drop"] > 0
                    if drop:
                        state["drop"] -= 1
                if drop:   # applied on the server, response lost on the wire
                    self._send(503, {"error": "dropped"})
                    return
                self._send(200, res)
            elif self.path == "/pull":
                rows = self.env.as_user(
                    body["uid"], "select app_api.sync_pull(%s, %s::xid8, %s, %s::xid8, %s)::jsonb",
                    (body["stream"], body["after_xid"], body["after_id"], body["horizon"], body["limit"]))
                self._send(200, rows[0][0])
            elif self.path == "/status":
                rows = self.env.as_user(
                    body["uid"], "select app_api.sync_status(%s, %s::xid8)::jsonb", (body["stream"], body["after_xid"]))
                self._send(200, rows[0][0])
            else:
                self._send(404, {"error": "unknown"})
        except psycopg.Error as e:
            # like PostgREST: constraint / data errors are HTTP 400 carrying the SQLSTATE; anything else is a server error
            if e.pgcode == "42883":
                self._send(404, {"error": str(e)[:300], "pgcode": e.pgcode})
            elif (e.pgcode or "")[:2] in ("22", "23"):
                self._send(400, {"error": str(e)[:300], "sqlstate": e.pgcode})
            else:
                self._send(500, {"error": f"{type(e).__name__}: {str(e)[:300]}"})
        except Exception as e:  # noqa: BLE001
            self._send(500, {"error": f"{type(e).__name__}: {str(e)[:300]}"})


def main() -> None:
    cluster = harness.Cluster(Path(os.environ.get("TASKFLOW_MIGRATIONS_DIR", str(harness.ROOT / "supabase/migrations"))))
    H.env = cluster.fresh()
    srv = ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0), H)
    print(f"READY {srv.server_address[1]}", flush=True)
    try:
        srv.serve_forever()
    finally:
        cluster.server.cleanup()


if __name__ == "__main__":
    main()
