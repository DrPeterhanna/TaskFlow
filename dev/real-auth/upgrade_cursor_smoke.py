"""Disposable local upgrade acceptance, including preserved Auth/session/task and restart."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import io

HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[1]

def main():
    target=Path(tempfile.mkdtemp(prefix='tf-before-cursor-upgrade-'))
    # Reference is the verified immediate pre0025 development checkpoint, not arbitrary working state.
    introduced=subprocess.check_output(['git','log','--format=%H','--reverse','--','supabase/migrations/0025_sync_pull_numeric_cursor.sql'],cwd=ROOT,text=True).splitlines()[0]
    prior=subprocess.check_output(['git','rev-parse',introduced+'^'],cwd=ROOT,text=True).strip()
    archive=subprocess.check_output(['git','archive',prior],cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as t:t.extractall(target,filter='data')
    for n in ('bin','vendor','wheels'):(target/'dev/real-auth'/n).symlink_to(HERE/n,target_is_directory=True)
    # Reuse the proven launcher health/signup/refresh/restart verifier, inserting the explicit upgrade.
    source=(HERE/'launcher_smoke.py').read_text()
    source=source.replace("HERE=Path(__file__).resolve().parent",'HERE=Path('+repr(str(target/'dev/real-auth'))+')')
    source=source.replace("print('PASS gateway signup/password/refresh and authenticated task create')", "print('PASS gateway signup/password/refresh and authenticated task create')\n                blocked=subprocess.run([sys.executable,"+repr(str(HERE/'upgrade-cursor-0025.py'))+",'--apply-local-only'],env=env,capture_output=True);assert blocked.returncode != 0;print('PASS upgrade refuses while launcher lock held')")
    source=source.replace('p.terminate();p.wait(timeout=20);log.close()', '''p.terminate();p.wait(timeout=20);log.close()
            if run==1:
                import pgserver,psycopg2
                pg=pgserver.get_server(Path(home)/'.local/share/taskflow-disposable-v1/postgres',cleanup_mode='stop')
                db=psycopg2.connect(pg.get_uri('taskflow_local_dev'));q=db.cursor()
                q.execute('select title,row_version from app.personal_tasks where id=%s',(tid,));before=q.fetchone();db.close();pg.cleanup()
                upgrade=Path('''+repr(str(HERE/'upgrade-cursor-0025.py'))+''')
                subprocess.run([sys.executable,str(upgrade),'--apply-local-only'],env=env,check=True)
                subprocess.run([sys.executable,str(upgrade),'--apply-local-only'],env=env,check=True)
                # Restart uses current source with exact updated inventory.
                HERE=upgrade.parent
                pg=pgserver.get_server(Path(home)/'.local/share/taskflow-disposable-v1/postgres',cleanup_mode='stop')
                db=psycopg2.connect(pg.get_uri('taskflow_local_dev'));q=db.cursor()
                q.execute('select title,row_version from app.personal_tasks where id=%s',(tid,));assert q.fetchone()==before
                q.execute("select pg_get_functiondef('app_api.sync_pull(text,xid8,text,xid8,integer)'::regprocedure)");assert 'q.change_xid desc' in q.fetchone()[0]
                db.close();pg.cleanup()
                print('PASS exact prior inventory upgrade, unchanged task/version, idempotent rerun and numeric cursor definition')''')
    source=source.replace('for run in (1,2):','for run in (1,2,3):')
    source=source.replace("print('PASS exact prior inventory upgrade, unchanged task/version, idempotent rerun and numeric cursor definition')", """print('PASS exact prior inventory upgrade, unchanged task/version, idempotent rerun and numeric cursor definition')
            if run==2:
                import pgserver,psycopg2
                import shutil
                data=Path(home)/'.local/share/taskflow-disposable-v1'
                recovery=sorted(data.glob('cursor-0025-recovery-*'))[0]
                pg=pgserver.get_server(data/'postgres',cleanup_mode='stop')
                db=psycopg2.connect(pg.get_uri('taskflow_local_dev'))
                with db:
                    with db.cursor() as q:
                        q.execute((recovery/'function-before.sql').read_text())
                        q.execute("select pg_get_functiondef('app_api.sync_pull(text,xid8,text,xid8,integer)'::regprocedure)")
                        assert q.fetchone()[0]==(recovery/'function-before.sql').read_text()
                db.close();pg.cleanup()
                shutil.copyfile(recovery/'inventory-before.json',data/'applied-inventory.json')
                HERE=Path("""+repr(str(target/'dev/real-auth'))+""")
                print('PASS operator rollback restores exact function and inventory, preserves data, restarts old source next')""")
    # global assignment is required because the injected main switches its launcher directory.
    source=source.replace('def main():','def main():\n    global HERE')
    exec(compile(source,str(HERE/'launcher_smoke.py'),'exec'),{'__name__':'__main__','__file__':str(HERE/'launcher_smoke.py')})

if __name__=='__main__':main()
