"""Apply migrations as a NON-superuser CREATEROLE user (hosted-like) on local PG. Not Supabase verification."""
import glob, tempfile, pgserver, psycopg2
d = tempfile.mkdtemp(); s = pgserver.get_server(d)
su = psycopg2.connect(s.get_uri()); su.autocommit = True; q = su.cursor()
q.execute("create role hosted_postgres login createrole createdb password 'x'")
q.execute("create database t owner hosted_postgres")
t = psycopg2.connect(s.get_uri('t')); t.autocommit = True; tq = t.cursor()
tq.execute(open('support/00_supabase_shim.sql').read())
tq.execute("alter schema auth owner to hosted_postgres; alter table auth.users owner to hosted_postgres; alter function auth.uid() owner to hosted_postgres")
tq.execute("create schema extensions; grant usage on schema extensions to public")
import re
dsn = psycopg2.extensions.parse_dsn(s.get_uri('t')); dsn['user'] = 'hosted_postgres'; dsn.pop('password', None)
c = psycopg2.connect(**dsn); c.autocommit = False; cq = c.cursor()
cq.execute("select rolsuper from pg_roles where rolname=current_user"); print("superuser:", cq.fetchone()[0]); c.commit()
for f in sorted(glob.glob('../supabase/migrations/*.sql')):
    try:
        cq.execute(open(f).read()); c.commit(); print("APPLIED", f.split('/')[-1])
    except Exception as e:
        c.rollback(); print("FAILED", f.split('/')[-1], str(e).splitlines()[0]); break
