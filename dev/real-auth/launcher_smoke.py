"""Exercise packaged gateway and persistent launcher with genuine Auth, then restart."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import urllib.request
import urllib.error
from integration import token
from gateway import PUBLIC_KEY

HERE=Path(__file__).resolve().parent


def call(path, body=None, bearer=PUBLIC_KEY, method='POST'):
    headers={'apikey':PUBLIC_KEY,'Authorization':'Bearer '+bearer,'Content-Type':'application/json','Content-Profile':'app_api','Accept-Profile':'app_api'}
    req=urllib.request.Request('http://127.0.0.1:54321'+path, data=json.dumps(body).encode() if body is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:return r.status,json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or b'{}')


def main():
    import sys
    sys.path.insert(0,str(HERE.parents[1]/'tests'))
    from harness import new_op
    home=tempfile.mkdtemp(prefix='tf-launcher-smoke-')
    env=dict(os.environ,HOME=home)
    email='launcher-local@local.test'
    password=secrets.token_urlsafe(32)
    access=None
    tid=new_op()
    for run in (1,2):
        log=open(Path(home)/('run'+str(run)+'.log'),'w')
        p=subprocess.Popen([sys.executable,str(HERE/'launch.py')],env=env,stdout=log,stderr=subprocess.STDOUT)
        try:
            for _ in range(100):
                if p.poll() is not None:raise RuntimeError(Path(log.name).read_text())
                try:
                    if call('/health',method='GET')[1].get('ok'):break
                except OSError:time.sleep(.1)
            else:raise AssertionError('gateway health timeout')
            if run==1:
                status,session=call('/auth/v1/signup',{'email':email,'password':password})
                assert status==200,(status,session)
                access=session['access_token']
                assert session['user']['email_confirmed_at']
                status,result=call('/rest/v1/rpc/create_personal_task',{'p_op_id':new_op(),'p_id':tid,'p_parent_id':None,'p_title':'Survives launcher restart','p_planned_date':None},access)
                assert status==200 and result['ok'],(status,result)
                refresh=session['refresh_token']
                status,renewed=call('/auth/v1/token?grant_type=refresh_token',{'refresh_token':refresh})
                assert status==200 and renewed['access_token'],status
                access=renewed['access_token']
                print('PASS gateway signup/password/refresh and authenticated task create')
            else:
                status,result=call('/rest/v1/rpc/my_membership',{},access)
                assert status==200 and result['ok'],(status,result)
                status,session=call('/auth/v1/token?grant_type=password',{'email':email,'password':password})
                assert status==200,status
                # Verify real persisted row via local PostgreSQL, without changing user data.
                import pgserver,psycopg2
                pg=pgserver.get_server(Path(home)/'.local/share/taskflow-disposable-v1/postgres',cleanup_mode='stop')
                db=psycopg2.connect(pg.get_uri('taskflow_local_dev'))
                c=db.cursor();c.execute('select title from app.personal_tasks where id=%s',(tid,))
                assert c.fetchone()==('Survives launcher restart',)
                db.close()
                print('PASS restart preserves account, password, signing key, token session and task data')
        finally:
            p.terminate();p.wait(timeout=20);log.close()
    print('PASS launcher/gateway Linux execution. Windows/WSL/USB remain untested.')

if __name__=='__main__':main()
