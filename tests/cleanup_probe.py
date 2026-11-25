"""LOCAL shim check: can an auth user who created/joined an org be deleted? (hosted dashboard deletion would behave the same on the FK)."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harness, psycopg2
from pathlib import Path
res = {}
def t(env):
    a = env.user("a@x.test"); o = env.user("o@x.test")
    r = env.rpc(a, "create_organization", "Probe org"); assert r["ok"], r
    for who, label in ((o, "no-org user"), (a, "org creator")):
        try:
            env.su("delete from auth.users where id=%s", (who,)); res[label] = "deleted"
        except Exception as e:
            res[label] = "BLOCKED: " + str(e).splitlines()[0][:110]
harness.TESTS.clear(); harness.TESTS.append(("probe", t))
harness.run_all(Path("../supabase/migrations"), None)
print(res)
