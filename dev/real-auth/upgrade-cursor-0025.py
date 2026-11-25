"""Explicit, local-only cursor-function upgrade. Stop the backend first. No reset."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import pgserver
import psycopg2

ROOT = Path(__file__).resolve().parents[2]
DATA = Path.home() / '.local/share/taskflow-disposable-v1'
NEW = 'supabase/migrations/0025_sync_pull_numeric_cursor.sql'
SIGNATURE = 'app_api.sync_pull(text,xid8,text,xid8,integer)'


def main():
    if sys.platform != 'linux' or os.geteuid() == 0:
        raise RuntimeError('Use your ordinary Linux/WSL account, not root.')
    if sys.argv[1:] != ['--apply-local-only']:
        raise RuntimeError('Read upgrade-cursor-0025.md first; explicit --apply-local-only required.')
    os.umask(0o077)
    if not (DATA / 'TASKFLOW_LOCAL_ONLY').is_file():
        raise RuntimeError('No marked local backend. No changes made.')
    lock = open(DATA / 'launcher.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    applied = DATA / 'applied-inventory.json'
    old = json.loads(applied.read_text())
    paths = [ROOT / 'supabase/migrations' / n for n in (ROOT / 'dev/local-backend/manifest.txt').read_text().splitlines()]
    paths += [ROOT / 'dev/local-backend/0015_my_membership_baseline.sql', ROOT / 'dev/real-auth/authorization.sql']
    desired = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
    if old == desired:
        print('Already current. No changes made.');return
    if NEW in old or {k:v for k,v in desired.items() if k != NEW} != old:
        raise RuntimeError('Not the exact prior inventory plus0025. Refusing unknown upgrade.')
    # No supplied host/URI is accepted. Only the known marked local pgserver directory.
    server = pgserver.get_server(DATA / 'postgres', cleanup_mode='stop')
    db = psycopg2.connect(server.get_uri('taskflow_local_dev'))
    backup = DATA / ('cursor-0025-recovery-' + str(time.time_ns()))
    backup.mkdir(mode=0o700)
    (backup / 'inventory-before.json').write_text(json.dumps(old, indent=2))
    try:
        with db:
            with db.cursor() as q:
                q.execute('select pg_get_functiondef(%s::regprocedure)', (SIGNATURE,))
                previous = q.fetchone()[0]
                q.execute('select pg_get_userbyid(proowner),prosecdef,proacl::text from pg_proc where oid=%s::regprocedure', (SIGNATURE,))
                security = q.fetchone()
                (backup / 'function-before.sql').write_text(previous)
                q.execute((ROOT / NEW).read_text())
                q.execute('select pg_get_userbyid(proowner),prosecdef,proacl::text from pg_proc where oid=%s::regprocedure', (SIGNATURE,))
                if q.fetchone() != security:
                    raise RuntimeError('Function security changed unexpectedly. Rolled back.')
        # If interrupted here the old inventory deliberately prevents launching. Recovery is documented.
        temp = DATA / 'applied-inventory.cursor0025.tmp'
        temp.write_text(json.dumps(desired, indent=2))
        os.replace(temp, applied)
        (backup / 'COMMITTED').touch()
        print('Local0025 applied. Prior function and inventory preserved privately in ' + str(backup))
    finally:
        db.close()
        server.cleanup()


if __name__ == '__main__':
    main()
