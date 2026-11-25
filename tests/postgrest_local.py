"""Standalone PostgREST v16.6 on LOCAL PostgreSQL (pgserver) with self-signed HS256 JWTs.
NOT Supabase: no GoTrue, no Kong gateway, no hosted settings. Checks the REST/RPC path: named params, JWT role switch, schema exposure."""
import base64, glob, hashlib, hmac, json, os, subprocess, sys, tempfile, time, urllib.request, urllib.error
import pgserver, psycopg2
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import new_op
from psycopg2.extensions import parse_dsn

import secrets
SECRET = secrets.token_urlsafe(48)
def b64(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def jwt(claims):
    h = b64(json.dumps({"alg": "HS256", "typ": "JWT"}).encode()); p = b64(json.dumps(claims).encode())
    return f"{h}.{p}.{b64(hmac.new(SECRET.encode(), f'{h}.{p}'.encode(), hashlib.sha256).digest())}"

d = tempfile.mkdtemp(); s = pgserver.get_server(d)
su = psycopg2.connect(s.get_uri()); su.autocommit = True; q = su.cursor()
q.execute("create database t"); 
t = psycopg2.connect(s.get_uri('t')); t.autocommit = True; tq = t.cursor()
shim = open('support/00_supabase_shim.sql').read().replace(
    "nullif(current_setting('request.jwt.claim.sub', true), '')::uuid",
    "coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid")
tq.execute(shim)
for f in sorted(glob.glob('../supabase/migrations/*.sql')): tq.execute(open(f).read())
tq.execute("create role authenticator login noinherit; grant anon, authenticated to authenticator")
tq.execute("insert into auth.users (id,email,email_confirmed_at) values ('11111111-1111-1111-1111-111111111111','a@x.test',now()),('22222222-2222-2222-2222-222222222222','b@x.test',now())")
dsn = parse_dsn(s.get_uri('t'))
env = dict(os.environ, PGRST_DB_URI=f"postgres://authenticator@/t?host={dsn['host']}", PGRST_DB_SCHEMAS="app_api", PGRST_DB_ANON_ROLE="anon",
           PGRST_JWT_SECRET=SECRET, PGRST_SERVER_PORT="3911", PGRST_SERVER_HOST="127.0.0.1")
proc = subprocess.Popen(['/tmp/postgrest.bin'], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
res = []
def call(path, body=None, token=None, profile="app_api", method="POST"):
    r = urllib.request.Request("http://127.0.0.1:3911" + path, data=json.dumps(body).encode() if body is not None else None, method=method,
        headers={"Content-Type": "application/json", "Content-Profile": profile, "Accept-Profile": profile, **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(r, timeout=10) as x: return x.status, json.loads(x.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
def check(name, ok, info=""):
    res.append(ok); print(("PASS " if ok else "FAIL ") + name, "" if ok else info)
try:
    for _ in range(40):
        try: urllib.request.urlopen("http://127.0.0.1:3911/", timeout=1); break
        except urllib.error.HTTPError: break
        except Exception: time.sleep(0.5)
    A, B = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"
    ta = jwt({"sub": A, "role": "authenticated", "exp": int(time.time()) + 600}); tb = jwt({"sub": B, "role": "authenticated", "exp": int(time.time()) + 600})
    code, _ = call("/rpc/current_epoch", {}); check("anon (no JWT) denied on app_api", code in (401, 403), code)
    code, _ = call("/rpc/current_epoch", {}, ta, profile="app"); check("schema app not exposed", code == 406, code)
    code, _ = call("/rpc/current_epoch", {}, jwt({"sub": A, "role": "authenticated", "exp": 1}))
    check("expired JWT rejected", code == 401, code)
    code, _ = call("/rpc/current_epoch", {}, jwt({"sub": A, "role": "service_role", "exp": int(time.time()) + 600}))
    check("role claim service_role not usable (role absent locally)", code >= 400, code)
    op = new_op(); tid = new_op()
    code, r = call("/rpc/create_personal_task", {"p_op_id": op, "p_id": tid, "p_parent_id": None, "p_title": "via PostgREST", "p_planned_date": None}, ta)
    check("named-param RPC create_personal_task as user A", code == 200 and isinstance(r, dict) and r.get("ok") is True, (code, r))
    code, r2 = call("/rpc/create_personal_task", {"p_op_id": op, "p_id": tid, "p_parent_id": None, "p_title": "via PostgREST", "p_planned_date": None}, ta)
    check("same op id replays (idempotent)", code == 200 and r2 == r, (code, r2))
    code, r = call("/rpc/sync_pull", {"p_stream": "personal_tasks", "p_after_xid": "0", "p_after_id": "", "p_horizon": None, "p_limit": 50}, ta)
    rows = (r or {}).get("rows", []) if isinstance(r, dict) else []
    check("sync_pull as A returns A's task", code == 200 and any(x.get("id") == tid for x in rows), (code, str(r)[:200]))
    code, r = call("/rpc/sync_pull", {"p_stream": "personal_tasks", "p_after_xid": "0", "p_after_id": "", "p_horizon": None, "p_limit": 50}, tb)
    rows = (r or {}).get("rows", []) if isinstance(r, dict) else []
    check("sync_pull as B does NOT return A's task", code == 200 and not any(x.get("id") == tid for x in rows), (code, str(r)[:200]))
    code, r = call("/rpc/complete_personal_task", {"p_op_id": new_op(), "p_id": tid}, tb)
    check("B cannot complete A's task", not (isinstance(r, dict) and r.get("ok") is True), (code, r))
    code, r = call("/rpc/complete_personal_task", {"p_op_id": new_op(), "p_id": tid}, ta)
    check("A completes own task", code == 200 and isinstance(r, dict) and r.get("ok") is True, (code, r))
    # account deletion: B's UNEXPIRED token must stop working
    tq.execute("delete from auth.users where id=%s", (B,))
    code, r = call("/rpc/create_personal_task", {"p_op_id": new_op(), "p_id": new_op(), "p_parent_id": None, "p_title": "ghost", "p_planned_date": None}, tb)
    check("deleted user's unexpired JWT cannot write", code >= 400 and 'unauthenticated' in json.dumps(r), (code, r))
    code, r = call("/rpc/sync_pull", {"p_stream": "personal_tasks", "p_after_xid": "0", "p_after_id": "", "p_horizon": None, "p_limit": 50}, tb)
    check("deleted user's unexpired JWT reads nothing", code >= 400 or not (r or {}).get("rows"), (code, str(r)[:150]))
    code, r = call("/rpc/sync_pull", {"p_stream": "personal_tasks", "p_after_xid": "0", "p_after_id": "", "p_horizon": None, "p_limit": 50}, ta)
    check("other user unaffected", code == 200, (code, str(r)[:150]))
finally:
    proc.terminate()
print(f"\n{sum(res)} passed, {len(res)-sum(res)} failed, {len(res)} total")
sys.exit(0 if all(res) else 1)
