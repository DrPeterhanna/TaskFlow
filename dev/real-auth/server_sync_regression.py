"""Existing server sync scenarios against genuine Auth identities/sessions (SQL role path).
Not an HTTP transport test. Separate production TS adapter tests cover HTTP.
"""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

import pgserver
import psycopg2

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parents[1]/'tests'))
from harness import Env,TESTS
import test_sync_server

class RealEnv(Env):
    def __init__(self,uri):
        super().__init__(lambda _:uri,'taskflow_local_dev')
        self.claims={}
    def user(self,email,verified=True,name=''):
        import secrets
        body={'email':email,'password':secrets.token_urlsafe(28),'data':{'display_name':name}}
        req=urllib.request.Request('http://127.0.0.1:54321/auth/v1/signup',data=json.dumps(body).encode(),headers={'Content-Type':'application/json','apikey':'taskflow-local-development-only'})
        with urllib.request.urlopen(req,timeout=5) as r: session=json.load(r)
        access=session['access_token'];uid=session['user']['id']
        self.claims[uid]=json.loads(base64.urlsafe_b64decode(access.split('.')[1]+'==='))
        return uid
    def conn(self,uid=None,role='authenticated'):
        c=psycopg2.connect(self.uri_for(self.dbname));self._conns.append(c)
        with c.cursor() as q:
            if uid is not None:
                q.execute("select set_config('request.jwt.claims',%s,false)",(json.dumps(self.claims[uid]),))
            if uid is not None or role=='anon':q.execute('set role '+role)
        c.commit();return c


def main():
    tests=[(n,f) for n,f in TESTS if f.__module__=='test_sync_server']
    failures=[]
    for name,fn in tests:
        home=tempfile.mkdtemp(prefix='tf-real-server-')
        log=open(Path(home)/'service.log','w')
        p=subprocess.Popen([sys.executable,str(HERE/'launch.py')],env=dict(os.environ,HOME=home),stdout=log,stderr=subprocess.STDOUT)
        env=None
        try:
            for _ in range(150):
                if p.poll() is not None:raise RuntimeError(Path(log.name).read_text())
                try:
                    with urllib.request.urlopen('http://127.0.0.1:54321/health') as r:
                        if r.status==200:break
                except OSError:time.sleep(.1)
            else:raise RuntimeError('backend readiness timeout')
            pg=pgserver.get_server(Path(home)/'.local/share/taskflow-disposable-v1/postgres',cleanup_mode='stop')
            env=RealEnv(pg.get_uri('taskflow_local_dev'))
            fn(env)
            print('PASS',name,flush=True)
        except Exception as exc:
            import traceback
            traceback.print_exc()
            failures.append(name);print('FAIL',name,str(exc),flush=True)
        finally:
            if env:env.close()
            p.terminate();p.wait(timeout=20);log.close()
    print(str(len(tests)-len(failures))+' passed, '+str(len(failures))+' failed, '+str(len(tests))+' total; genuine Auth SQL-role tier, not HTTP/device')
    return bool(failures)

if __name__=='__main__':sys.exit(main())
