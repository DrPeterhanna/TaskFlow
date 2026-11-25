"""Persistent, Linux/WSL-only local backend. No remote DB URI or reset option exists."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

import pgserver
import psycopg2
from psycopg2.extensions import parse_dsn

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
DATA = Path.home() / '.local/share/taskflow-disposable-v1'
DATABASE = 'taskflow_local_dev'
CHILDREN = []


def wait_health(url, process):
    for _ in range(120):
        if process.poll() is not None:
            raise RuntimeError('Service exited. Check private logs in ' + str(DATA / 'logs'))
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(.25)
    raise RuntimeError('Health timeout: ' + url)


def main():
    if sys.platform != 'linux' or os.geteuid() == 0:
        raise RuntimeError('Use Linux/WSL as your regular user, not root.')
    os.umask(0o077)
    if DATA.exists() and not (DATA / 'TASKFLOW_LOCAL_ONLY').is_file():
        raise RuntimeError('Existing unmarked data directory. Refusing to alter it.')
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / 'TASKFLOW_LOCAL_ONLY').touch()
    lock = open(DATA / 'launcher.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('TaskFlow backend is already running. Use its existing window.')
    for port in (3997, 3998, 3999, 54321):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
            s.bind(('127.0.0.1', port))
    source = HERE / 'vendor/auth-source'
    auth = HERE / 'bin/auth'
    rest = HERE / 'bin/postgrest'
    manifest=json.loads((HERE/'runtime-manifest.json').read_text())
    for relative,expected in manifest.items():
        runtime_path=HERE/relative
        if not runtime_path.is_file() or hashlib.sha256(runtime_path.read_bytes()).hexdigest()!=expected:
            raise RuntimeError('Runtime integrity check failed: '+relative)
    for path in (auth, rest, source / 'migrations'):
        if not path.exists():
            raise RuntimeError('Missing runtime: ' + str(path) + '. Run Setup first.')
    sql_paths = [ROOT / 'supabase/migrations' / name for name in (ROOT / 'dev/local-backend/manifest.txt').read_text().splitlines()]
    sql_paths += [ROOT / 'dev/local-backend/0015_my_membership_baseline.sql', HERE / 'authorization.sql']
    inventory = {str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sql_paths}
    saved_inventory = DATA / 'applied-inventory.json'
    if saved_inventory.exists() and json.loads(saved_inventory.read_text()) != inventory:
        raise RuntimeError('SQL changed since initialization. No automatic upgrade/reset. Preserve data and request an explicit upgrade plan.')
    secret_file = DATA / 'signing-key'
    if not secret_file.exists():
        if saved_inventory.exists():
            raise RuntimeError('Signing key missing. Refusing silent identity/key replacement.')
        import secrets
        secret_file.write_text(secrets.token_urlsafe(48))
    secret = secret_file.read_text()
    (DATA / 'logs').mkdir(exist_ok=True)
    pg = pgserver.get_server(DATA / 'postgres', cleanup_mode='stop')
    conn = psycopg2.connect(pg.get_uri())
    conn.autocommit = True
    cur = conn.cursor()
    cur.execute('select 1 from pg_database where datname=%s', (DATABASE,))
    exists = bool(cur.fetchone())
    if not exists:
        cur.execute('create database taskflow_local_dev')
    if exists and not saved_inventory.exists():
        raise RuntimeError('Incomplete or unknown database. No reset performed. Preserve this directory for recovery.')
    uri = pg.get_uri(DATABASE)
    db = psycopg2.connect(uri)
    db.autocommit = True
    q = db.cursor()
    if not exists:
        q.execute('create schema auth; create role anon nologin; create role authenticated nologin; create role service_role nologin; create role authenticator login noinherit; grant anon,authenticated to authenticator')
    # Fresh environment instead of inheriting arbitrary GOTRUE/PGRST session policy settings.
    env = {k:v for k,v in os.environ.items() if not k.startswith(('GOTRUE_', 'PGRST_'))}
    env.update(GOTRUE_JWT_SECRET=secret, GOTRUE_JWT_AUD='authenticated', GOTRUE_JWT_EXP='3600', GOTRUE_JWT_DEFAULT_GROUP_NAME='authenticated', GOTRUE_JWT_ADMIN_ROLES='service_role', GOTRUE_DB_DRIVER='postgres', GOTRUE_DB_DATABASE_URL=uri + '&options=-csearch_path%3Dauth%2Cpublic', GOTRUE_DB_NAMESPACE='auth', GOTRUE_DB_MIGRATIONS_PATH=str(source / 'migrations'), API_EXTERNAL_URL='http://127.0.0.1:54321/auth/v1', GOTRUE_API_HOST='127.0.0.1', PORT='3999', GOTRUE_SITE_URL='http://127.0.0.1:54321', GOTRUE_EXTERNAL_EMAIL_ENABLED='true', GOTRUE_MAILER_AUTOCONFIRM='true', GOTRUE_DISABLE_SIGNUP='false', GOTRUE_LOG_LEVEL='error', GOTRUE_SESSIONS_SINGLE_PER_USER='false')
    def start(binary, child_env, name, cwd=None):
        log = open(DATA / 'logs' / (name + '.log'), 'a')
        p = subprocess.Popen(binary, env=child_env, cwd=cwd, stdout=log, stderr=subprocess.STDOUT)
        CHILDREN.append((p, log))
        return p
    try:
        authp = start([str(auth)], env, 'auth', source)
        wait_health('http://127.0.0.1:3999/health', authp)
        print('Auth: healthy', flush=True)
        if not exists:
            q.execute('grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated')
            from rollback import capture
            for path in sql_paths:
                if path.name == 'authorization.sql':
                    capture(db, DATA / 'authorization-rollback.sql')
                q.execute(path.read_text())
            saved_inventory.write_text(json.dumps(inventory, indent=2))
        q.execute('select 1')
        print('PostgreSQL and application schema: healthy', flush=True)
        dsn = parse_dsn(uri)
        renv = dict(env, PGRST_DB_URI='postgres://authenticator@/taskflow_local_dev?host=' + dsn['host'], PGRST_DB_PRE_REQUEST='app_private.authorize_request', PGRST_DB_SCHEMAS='app_api', PGRST_DB_ANON_ROLE='anon', PGRST_JWT_SECRET=secret, PGRST_ADMIN_SERVER_PORT='3997', PGRST_SERVER_PORT='3998', PGRST_SERVER_HOST='127.0.0.1')
        rp = start([str(rest)], renv, 'api')
        wait_health('http://127.0.0.1:3997/ready', rp)
        print('API: healthy', flush=True)
        gp = start([sys.executable, str(HERE / 'gateway.py')], env, 'gateway')
        wait_health('http://127.0.0.1:54321/health', gp)
        print('Gateway: healthy. Local backend READY at http://127.0.0.1:54321', flush=True)
        print('Disposable development accounts only. Email confirmation is local-only automatic. No outbound email configured.', flush=True)
        print('Leave this window open. Ctrl+C stops services without deleting data.', flush=True)
        while True:
            if any(p.poll() is not None for p,_ in CHILDREN):
                raise RuntimeError('A service stopped. Backend is NOT healthy. Check private logs.')
            time.sleep(2)
    finally:
        for p,log in reversed(CHILDREN):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()
            log.close()
        db.close()
        conn.close()
        pg.cleanup()

if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        main()
    except KeyboardInterrupt:
        print('Stopped. Local data retained.')
    except Exception as exc:
        print('STOPPED: ' + str(exc), file=sys.stderr)
        sys.exit(1)
