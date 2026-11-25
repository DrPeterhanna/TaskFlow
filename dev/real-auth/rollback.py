"""Generate an exact local patch rollback from the pre-patch catalog. Not a hosted migration."""
import json
from pathlib import Path
from psycopg2 import sql

HELPERS = ('uid','require_uid','my_membership_id','is_active_member','me_is_admin_of','me_can_see_profile','require_verified_email')
POLICIES = ('memberships_select','personal_tasks_owner','personal_task_dependencies_owner','personal_recurrence_rules_owner','personal_attachments_owner','personal_notes_owner','personal_events_owner')


def capture(connection, destination):
    destination = Path(destination)
    c = connection.cursor()
    c.execute("select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname=ANY(%s) order by p.proname", (list(HELPERS),))
    definitions = [r[0] for r in c.fetchall()]
    c.execute("select p.proname,pg_get_userbyid(p.proowner),p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname=ANY(%s) order by p.proname", (list(HELPERS),))
    function_acls=c.fetchall()
    assert len(definitions) == len(HELPERS)
    c.execute("select schemaname,tablename,policyname,qual,with_check from pg_policies where schemaname='app' and policyname=ANY(%s) order by policyname", (list(POLICIES),))
    policies = c.fetchall()
    assert len(policies) == len(POLICIES)
    c.execute("select n.nspname,cl.relname,a.attname,a.attacl::text from pg_attribute a join pg_class cl on cl.oid=a.attrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='auth' and cl.relname in ('users','sessions') and a.attnum>0 and not a.attisdropped order by 1,2,3")
    acls = c.fetchall()
    c.execute("select rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls from pg_roles order by rolname")
    roles=c.fetchall()
    c.execute("select pg_get_userbyid(roleid),pg_get_userbyid(member),admin_option from pg_auth_members order by 1,2")
    memberships=c.fetchall()
    c.execute("select n.nspname,cl.relname,pg_get_userbyid(cl.relowner),cl.relacl::text,cl.relrowsecurity,cl.relforcerowsecurity from pg_class cl join pg_namespace n on n.oid=cl.relnamespace where n.nspname in ('app','auth') and cl.relkind='r' order by 1,2")
    table_security=c.fetchall()
    c.execute("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname in ('app','auth') order by 1,2,3")
    all_policies=c.fetchall()
    # The added grants must not already exist; don't remove a pre-existing grant on rollback.
    for table, cols in [('users',['banned_until','deleted_at']),('sessions',['id','user_id','not_after'])]:
        for col in cols:
            c.execute('select has_column_privilege(%s,%s,%s,%s)', ('app_rpc','auth.' + table,col,'SELECT'))
            assert not c.fetchone()[0], 'Pre-existing permission requires a reviewed rollback plan'
    statements = ['BEGIN;', "SET LOCAL lock_timeout='5s';"] + [definition.rstrip() + ';' for definition in definitions]
    for schema,table,name,qual,check in policies:
        statement = sql.SQL('ALTER POLICY {} ON {}.{} USING ({});').format(sql.Identifier(name),sql.Identifier(schema),sql.Identifier(table),sql.SQL(qual)).as_string(connection)
        # These baseline policies have no separate WITH CHECK; this patch changes only USING.
        statements.append(statement)
    statements += ['DROP FUNCTION app_private.authorize_request();', 'REVOKE EXECUTE ON FUNCTION app_private.uid() FROM authenticated;', 'DROP POLICY taskflow_auth_guard_users_read ON auth.users;', 'DROP POLICY taskflow_auth_guard_sessions_read ON auth.sessions;', 'REVOKE SELECT (banned_until,deleted_at) ON auth.users FROM app_rpc;', 'REVOKE SELECT (id,user_id,not_after) ON auth.sessions FROM app_rpc;', 'DROP TABLE app.account_access_guard;', 'COMMIT;']
    destination.write_text('\n'.join(statements) + '\n')
    snapshot={'roles':roles,'memberships':memberships,'table_security':table_security,'all_policies':all_policies}
    destination.with_suffix('.catalog.json').write_text(json.dumps(snapshot,indent=2,default=str)+'\n')
    return {'function_acls':function_acls,'functions':definitions, 'policies':policies, 'auth_column_acls':acls}


def verify(connection, expected):
    c = connection.cursor()
    c.execute("select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname=ANY(%s) order by p.proname", (list(HELPERS),))
    assert [r[0] for r in c.fetchall()] == expected['functions']
    c.execute("select p.proname,pg_get_userbyid(p.proowner),p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and p.proname=ANY(%s) order by p.proname", (list(HELPERS),))
    assert c.fetchall()==expected['function_acls']
    c.execute("select schemaname,tablename,policyname,qual,with_check from pg_policies where schemaname='app' and policyname=ANY(%s) order by policyname", (list(POLICIES),))
    assert c.fetchall() == expected['policies']
    c.execute("select n.nspname,cl.relname,a.attname,a.attacl::text from pg_attribute a join pg_class cl on cl.oid=a.attrelid join pg_namespace n on n.oid=cl.relnamespace where n.nspname='auth' and cl.relname in ('users','sessions') and a.attnum>0 and not a.attisdropped order by 1,2,3")
    assert c.fetchall() == expected['auth_column_acls']
    c.execute("select to_regclass('app.account_access_guard')")
    assert c.fetchone()[0] is None
