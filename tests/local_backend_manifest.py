"""Disposable LOCAL PG + auth shim checks for the Android backend manifest. NOT Supabase Auth/device proof."""
from pathlib import Path
import shutil
import tempfile
from harness import Cluster, expect_tf

ROOT = Path(__file__).resolve().parent.parent

def main():
    with tempfile.TemporaryDirectory(prefix='tf-manifest-') as td:
        target = Path(td)
        names = (ROOT / 'dev/local-backend/manifest.txt').read_text().splitlines()
        assert len(names) == len(set(names)) == 23
        assert not any(name.startswith(('0014_', '0015_')) for name in names)
        for name in names:
            assert Path(name).name == name and name.endswith('.sql')
            shutil.copyfile(ROOT / 'supabase/migrations' / name, target / name)
        shutil.copyfile(ROOT / 'dev/local-backend/0015_my_membership_baseline.sql', target / '0015_my_membership_baseline.sql')
        cluster = Cluster(target)
        env = cluster.fresh()
        try:
            assert env.su("select count(*) from information_schema.columns where table_schema='app' and table_name='profiles' and column_name='auth_user_id'") == [(0,)]
            assert env.su("select to_regprocedure('app_api.leave_organization(uuid)'), to_regprocedure('app_api.close_organization(uuid)')") == [(None, None)]
            print('PASS held_0014_identity_and_account_policy_absent')
            a = env.user('manifest-a@local.test', verified=True)
            b = env.user('manifest-b@local.test', verified=False)
            me = lambda uid: env.as_user(uid, 'select app_api.my_membership()')[0][0]['data']
            assert me(a) == {'email_verified': True, 'membership': None}
            assert me(b) == {'email_verified': False, 'membership': None}
            expect_tf('unauthenticated', lambda: env.as_user(None, 'select app_api.my_membership()'))
            print('PASS baseline_membership_verification_anonymous_and_no_org')
            org = env.rpc(a, 'create_organization', 'Manifest org', 'Africa/Cairo')
            assert org['ok'] and me(a)['membership']['org_name'] == 'Manifest org'
            assert me(b)['membership'] is None
            print('PASS membership_owner_only_and_create_org_shell_path')
            # No deletion/leave policy is exercised or installed. Personal streams remain owner-only.
            import uuid
            task = str(uuid.uuid4())
            assert env.rpc(a, 'create_personal_task', task, None, 'Native backend compatibility', None)['ok']
            assert env.rpc(a, 'update_personal_task_checked', task, {'title': 'Edited'}, {'title': 'Native backend compatibility'})['ok']
            expect_tf('not_found', lambda: env.rpc(b, 'update_personal_task_checked', task, {'title': 'Wrong owner'}, {'title': 'Edited'}))
            assert env.as_user(a, "select app_api.sync_status('personal_tasks', '0'::xid8)")[0][0]['data']['mutation_safety_version'] == 2
            print('PASS guarded_personal_write_owner_isolation_and_safety_capability')
            assert env.su("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_api' and p.proname in ('leave_organization','close_organization')") == []
            # Isolate required assertions from failing tests that also demand held lifecycle policy.
            import ast
            tree = ast.parse((ROOT / 'tests/test_phase2.py').read_text())
            lint = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'lint_clients_have_no_write_privileges_and_anon_has_none')
            expected = next(ast.literal_eval(n.test.comparators[0]) for n in lint.body if isinstance(n, ast.Assert) and isinstance(n.test, ast.Compare) and isinstance(n.test.left, ast.Name) and n.test.left.id == 'callable_')
            actual = {r[0] for r in env.su("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_api' and has_function_privilege('authenticated',p.oid,'execute')")}
            assert actual == expected - {'leave_organization', 'close_organization'}, actual ^ expected
            assert env.su("select table_name from information_schema.role_table_grants where table_schema='app' and grantee in ('authenticated','anon','public') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')") == []
            private = {r[0] for r in env.su("select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app_private' and has_function_privilege('authenticated',p.oid,'execute')")}
            assert private == {'my_membership_id','is_active_member','me_has_authority_over_membership','me_unit_in_scope','me_is_admin_of','me_can_see_profile','me_in_org_of_unit'}
            print('PASS exact_baseline_grants_without_held_lifecycle_apis_or_uid_grant')
            from test_phase2 import fixture
            f = fixture(env)
            assert me(f.mem)['membership']['org_id'] == f.org
            env.rpc(f.admin, 'set_member_status', f.mid['mem'], 'removed')
            assert me(f.mem)['membership'] is None
            env.su("update auth.users set email_confirmed_at=now() where id=%s", (b,))
            assert me(b)['email_verified'] is True
            env.su("update app.organizations set deleted_at=now() where id=%s", (f.org,))
            assert me(f.admin)['membership'] is None
            print('PASS membership_removed_hidden_verified_refresh_and_closed_org_filter')
            # Baseline deletion refusal must be atomic and preserve pending server-side data.
            import psycopg2
            try:
                env.su('delete from auth.users where id=%s', (a,))
                raise AssertionError('Baseline account deletion unexpectedly succeeded')
            except psycopg2.Error:
                pass
            assert env.su('select count(*) from auth.users where id=%s', (a,)) == [(1,)]
            assert env.su('select title from app.personal_tasks where id=%s', (task,)) == [('Edited',)]
            print('PASS baseline_account_deletion_refuses_atomically_without_erasure')
            # Preserve evidence of the unresolved baseline revocation limitation instead of claiming it passes.
            env.su('update app.profiles set deleted_at=now() where id=%s', (a,))
            still_allowed = env.rpc(a, 'update_personal_task_checked', task, {'title': 'Baseline still permits'}, {'title': 'Edited'})
            assert still_allowed['ok'] is True
            print('KNOWN LIMITATION REPRODUCED: soft-deleted profile with live Auth identity can still write on baseline')
            print('7 checks passed, 0 check failures; 1 security limitation reproduced; disposable local PG + auth shim only')
        finally:
            cluster.drop(env)
            cluster.server.cleanup()

if __name__ == '__main__':
    main()
