"""Docker-free genuine Supabase Auth bootstrap smoke test. Disposable local data only."""
import os,sys,tempfile,subprocess,time,json,urllib.request,urllib.error,secrets,base64,hmac,hashlib
from pathlib import Path
import pgserver,psycopg2
ROOT=Path(__file__).resolve().parents[2]
AUTH=Path(os.environ.get('TASKFLOW_AUTH_SOURCE','/downloads/taskflow-real-auth/auth-source'))
BIN=Path(os.environ.get('TASKFLOW_AUTH_BINARY',str(AUTH.parent/'auth-v2.198.0')))
def token(secret,claims):
 enc=lambda x:base64.urlsafe_b64encode(json.dumps(x).encode()).rstrip(b'=').decode()
 a=enc({'alg':'HS256','typ':'JWT'}); b=enc(claims)
 sig=base64.urlsafe_b64encode(hmac.new(secret.encode(),(a+'.'+b).encode(),hashlib.sha256).digest()).rstrip(b'=').decode()
 return a+'.'+b+'.'+sig

def main():
 d=tempfile.mkdtemp(prefix='tf-real-auth-only-'); server=pgserver.get_server(d,cleanup_mode='stop')
 conn=psycopg2.connect(server.get_uri()); conn.autocommit=True
 q=conn.cursor(); q.execute('create database taskflow_real_auth_disposable')
 uri=server.get_uri('taskflow_real_auth_disposable'); auth_uri=uri+'&options=-csearch_path%3Dauth%2Cpublic'; db=psycopg2.connect(uri); db.autocommit=True; cur=db.cursor()
 cur.execute('create schema auth; create role anon nologin; create role authenticated nologin; create role service_role nologin;')
 secret=secrets.token_urlsafe(48)
 env=dict(os.environ,GOTRUE_JWT_SECRET=secret,GOTRUE_JWT_AUD='authenticated',GOTRUE_JWT_EXP='3600',GOTRUE_JWT_DEFAULT_GROUP_NAME='authenticated',GOTRUE_JWT_ADMIN_ROLES='service_role',GOTRUE_DB_DRIVER='postgres',GOTRUE_DB_DATABASE_URL=auth_uri,GOTRUE_DB_NAMESPACE='auth',GOTRUE_DB_MIGRATIONS_PATH=str(AUTH/'migrations'),API_EXTERNAL_URL='http://127.0.0.1:3999',GOTRUE_API_HOST='127.0.0.1',PORT='3999',GOTRUE_SITE_URL='http://127.0.0.1:3999',GOTRUE_EXTERNAL_EMAIL_ENABLED='true',GOTRUE_MAILER_AUTOCONFIRM='false',GOTRUE_DISABLE_SIGNUP='true',GOTRUE_LOG_LEVEL='error')
 log=open('/downloads/offline-sync-evidence/real-auth-bootstrap-service.log','w')
 proc=subprocess.Popen([str(BIN)],cwd=AUTH,env=env,stdout=log,stderr=subprocess.STDOUT)
 def call(path,body=None,bearer=None,method='POST'):
  req=urllib.request.Request('http://127.0.0.1:3999'+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+bearer} if bearer else {})})
  try:
   with urllib.request.urlopen(req,timeout=10) as r:return r.status,json.loads(r.read() or b'{}')
  except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or b'{}')
 try:
  for _ in range(80):
   if proc.poll() is not None: raise RuntimeError('Auth exited; inspect service log')
   try:
    if call('/health',method='GET')[0]==200:break
   except OSError:time.sleep(.25)
  else:raise RuntimeError('Auth health timeout')
  print('PASS genuine_auth_bootstrap_health')
  # Fresh isolated cluster only: application baseline intentionally excludes held0014/0015.
  cur.execute('grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;')
  for name in (ROOT/'dev/local-backend/manifest.txt').read_text().splitlines():
   cur.execute((ROOT/'supabase/migrations'/name).read_text())
  cur.execute((ROOT/'dev/local-backend/0015_my_membership_baseline.sql').read_text())
  # Capture exact catalog before authorization patch.
  cur.execute("select n.nspname,p.proname,pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('app_private','app_api') order by 1,2")
  Path('/downloads/offline-sync-evidence/real-auth-before-functions.json').write_text(json.dumps(cur.fetchall(),indent=2))
  cur.execute("select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='app' order by tablename,policyname")
  Path('/downloads/offline-sync-evidence/real-auth-before-policies.json').write_text(json.dumps(cur.fetchall(),indent=2))
  from rollback import capture,verify
  rollback_path=Path('/downloads/offline-sync-evidence/real-auth-rollback.sql')
  before=capture(db,rollback_path)
  cur.execute((ROOT/'dev/real-auth/authorization.sql').read_text())
  print('PASS application_baseline_and_revocation_patch_applied_disposable_only')
  cur.execute("select column_name,data_type from information_schema.columns where table_schema='auth' and table_name='sessions' order by ordinal_position")
  print('Actual auth.sessions columns:',cur.fetchall())
  admin=token(secret,{'role':'service_role','exp':int(time.time())+600,'aud':'authenticated'})
  password=secrets.token_urlsafe(26)
  status,user=call('/admin/users',{'email':'tf-designated-local-a@local.test','password':password,'email_confirm':True},admin)
  if status not in (200,201): raise RuntimeError(('create designated account failed',status,user))
  uid=user['id']
  status,session=call('/token?grant_type=password',{'email':'tf-designated-local-a@local.test','password':password})
  if status!=200:raise RuntimeError(('real password signin failed',status,session))
  access=session['access_token']; claims=json.loads(base64.urlsafe_b64decode(access.split('.')[1]+'===')); sid=claims['session_id']
  cur.execute('select count(*) from auth.sessions where id=%s and user_id=%s',(sid,uid)); assert cur.fetchone()[0]==1
  print('PASS real_auth_password_signin_has_live_session_id')
  def as_token(sql,args=()):
   c=psycopg2.connect(uri)
   try:
    with c.cursor() as x:
     x.execute('set local role authenticated')
     x.execute("select set_config('request.jwt.claims',%s,true)",(json.dumps(claims),))
     x.execute(sql,args); rows=x.fetchall() if x.description else []
    c.commit();return rows
   finally:c.close()
  assert str(as_token('select app_private.uid()')[0][0])==uid
  cur.execute('create role authenticator login noinherit; grant authenticated,anon to authenticator')
  from psycopg2.extensions import parse_dsn
  dsn=parse_dsn(uri)
  rest_env=dict(os.environ,PGRST_DB_URI='postgres://authenticator@/taskflow_real_auth_disposable?host='+dsn['host'],PGRST_DB_PRE_REQUEST='app_private.authorize_request',PGRST_DB_SCHEMAS='app_api',PGRST_DB_ANON_ROLE='anon',PGRST_JWT_SECRET=secret,PGRST_SERVER_PORT='3998',PGRST_SERVER_HOST='127.0.0.1')
  rest_log=open('/downloads/offline-sync-evidence/real-auth-postgrest.log','w')
  rest=subprocess.Popen(['/tmp/postgrest.bin'],env=rest_env,stdout=rest_log,stderr=subprocess.STDOUT)
  def rpc(name,args,bearer=None):
   req=urllib.request.Request('http://127.0.0.1:3998/rpc/'+name,data=json.dumps(args).encode(),headers={'Content-Type':'application/json','Content-Profile':'app_api','Accept-Profile':'app_api','Authorization':'Bearer '+(bearer or access)})
   try:
    with urllib.request.urlopen(req,timeout=5) as r:return r.status,json.loads(r.read() or b'{}')
   except urllib.error.HTTPError as e:return e.code,json.loads(e.read() or b'{}')
  for _ in range(40):
   try:
    status,response=rpc('my_membership',{});break
   except OSError:time.sleep(.1)
  assert status==200 and response['ok'],(status,response)
  sys.path.insert(0,str(ROOT/'tests'))
  from harness import new_op
  tid=new_op(); op=new_op()
  args={'p_op_id':op,'p_id':tid,'p_parent_id':None,'p_title':'Real Auth HTTP task','p_planned_date':None}
  status,created=rpc('create_personal_task',args);assert status==200 and created['ok'],(status,created)
  assert rpc('create_personal_task',args)[1]==created
  print('PASS genuine_auth_postgrest_create_and_exact_replay')
  cur.execute('update app.profiles set deleted_at=now() where id=%s',(uid,))
  assert rpc('create_personal_task',{**args,'p_op_id':new_op(),'p_id':new_op()})[0] in (400,401,403)
  assert rpc('create_personal_task',args)[0] in (400,401,403)
  for fn,params in [('current_epoch',{}),('sync_status',{'p_stream':'personal_tasks','p_after_xid':'0'}),('sync_pull',{'p_stream':'personal_tasks','p_after_xid':'0','p_after_id':'','p_horizon':None,'p_limit':50}),('list_units',{}),('list_members',{}),('list_invitations',{})]:
   assert rpc(fn,params)[0] in (400,401,403),(fn,rpc(fn,params))
  print('PASS genuine_stale_jwt_http_write_receipt_and_read_RPC_denied_after_profile_delete')
  assert as_token('select app_private.uid()')==[(None,)]
  try:as_token('select app_api.update_profile(%s,%s::jsonb)',('00000000-0000-7000-8000-000000000001','{"theme":"dark"}'))
  except psycopg2.Error:pass
  else:raise AssertionError('deleted profile write allowed')
  cur.execute('update app.profiles set deleted_at=null where id=%s',(uid,))
  assert str(as_token('select app_private.uid()')[0][0])==uid
  cur.execute('insert into app.account_access_guard(user_id,suspended) values(%s,true)',(uid,))
  assert as_token('select app_private.uid()')==[(None,)]
  assert rpc('my_membership',{})[0] in (400,401,403)
  assert rpc('create_personal_task',args)[0] in (400,401,403)
  cur.execute('update app.account_access_guard set suspended=false where user_id=%s',(uid,))
  cur.execute("update auth.sessions set not_after=now()-interval '1 second' where id=%s",(sid,))
  assert as_token('select app_private.uid()')==[(None,)]
  cur.execute('select count(*) from auth.sessions where id=%s',(sid,));assert cur.fetchone()[0]==1
  assert rpc('my_membership',{})[0] in (400,401,403)
  assert rpc('create_personal_task',args)[0] in (400,401,403)
  cur.execute('update auth.sessions set not_after=null where id=%s',(sid,))
  print('PASS real_auth_token_with_database_softdelete_suspension_and_expired_existing_session')
  cur.execute("update auth.users set banned_until=now()+interval '1 hour' where id=%s",(uid,))
  assert rpc('my_membership',{})[0] in (400,401,403)
  cur.execute('update auth.users set banned_until=null where id=%s',(uid,))
  print('PASS genuine_stale_jwt_http_denied_by_live_auth_ban')
  # Genuine second account and role/status changes using current DB state, not cached JWT role.
  password_b=secrets.token_urlsafe(26)
  status,user_b=call('/admin/users',{'email':'tf-designated-local-b@local.test','password':password_b,'email_confirm':True},admin)
  assert status in (200,201),(status,user_b)
  status,session_b=call('/token?grant_type=password',{'email':'tf-designated-local-b@local.test','password':password_b})
  assert status==200
  token_b=session_b['access_token']
  status,org=rpc('create_organization',{'p_op_id':new_op(),'p_name':'Genuine local Auth org','p_timezone':'Africa/Cairo'})
  assert status==200 and org['ok'],(status,org)
  root=org['data']['unit_id']
  status,inv=rpc('create_invitation',{'p_op_id':new_op(),'p_role':'member','p_unit_id':root,'p_max_uses':1,'p_expires_at':'2027-01-01T00:00:00Z'})
  assert status==200 and inv['ok'],(status,inv)
  status,joined=rpc('redeem_invitation',{'p_op_id':new_op(),'p_code':inv['data']['code']},token_b)
  assert status==200 and joined['ok'],(status,joined)
  cur.execute('select id from app.memberships where user_id=%s',(user_b['id'],));mid_b=str(cur.fetchone()[0])
  assert rpc('set_member_role',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_role':'admin'})[1]['ok']
  privileged=lambda:rpc('set_member_status',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_status':'active'},token_b)
  assert privileged()[1]['ok']
  assert rpc('set_member_role',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_role':'member'})[1]['ok']
  assert privileged()[0] in (400,401,403)
  print('PASS genuine_stale_jwt_role_demotion_enforced_HTTP')
  # Current delegated permission grant/revoke/expiry, same saved genuine token.
  assert rpc('set_member_role',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_role':'supervisor'})[1]['ok']
  status,unit=rpc('create_unit',{'p_op_id':new_op(),'p_parent_id':root,'p_name':'Permission scope'})
  assert status==200 and unit['ok'],(status,unit)
  scope=unit['data']['unit_id']
  assert rpc('move_member',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_unit_id':scope})[1]['ok']
  grant_args={'p_membership_id':mid_b,'p_permission':'manage_units','p_scope_unit_id':scope,'p_expires_at':'2027-01-01T00:00:00Z'}
  status,grant=rpc('grant_permission',{'p_op_id':new_op(),**grant_args})
  assert status==200 and grant['ok'],(status,grant)
  delegated=lambda:rpc('create_unit',{'p_op_id':new_op(),'p_parent_id':scope,'p_name':'Delegated child'},token_b)
  assert delegated()[1]['ok']
  assert rpc('revoke_permission',{'p_op_id':new_op(),'p_grant_id':grant['data']['grant_id']})[1]['ok']
  assert delegated()[0] in (400,401,403)
  status,grant=rpc('grant_permission',{'p_op_id':new_op(),**grant_args})
  assert status==200 and grant['ok']
  cur.execute("update app.permission_grants set expires_at=now()-interval '1 second' where id=%s",(grant['data']['grant_id'],))
  assert delegated()[0] in (400,401,403)
  print('PASS genuine_stale_jwt_HTTP_delegated_permission_revoke_and_expiry')

  assert rpc('set_member_status',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_status':'suspended'})[1]['ok']
  assert rpc('create_unit',{'p_op_id':new_op(),'p_parent_id':root,'p_name':'Denied'},token_b)[0] in (400,401,403)
  personal_b={'p_op_id':new_op(),'p_id':new_op(),'p_parent_id':None,'p_title':'Private during org suspension','p_planned_date':None}
  assert rpc('create_personal_task',personal_b,token_b)[1]['ok']
  assert rpc('set_member_status',{'p_op_id':new_op(),'p_membership_id':mid_b,'p_status':'removed'})[1]['ok']
  assert rpc('create_unit',{'p_op_id':new_op(),'p_parent_id':root,'p_name':'Denied again'},token_b)[0] in (400,401,403)
  assert rpc('create_personal_task',{**personal_b,'p_op_id':new_op(),'p_id':new_op()},token_b)[1]['ok']
  print('PASS genuine_stale_jwt_org_suspension_removal_denies_org_preserves_personal_HTTP')


  # Real Auth user soft deletion must deny a still-stored old JWT too.
  cur.execute('update auth.users set deleted_at=now() where id=%s',(user_b['id'],))
  assert rpc('my_membership',{},token_b)[0] in (400,401,403)
  assert rpc('create_personal_task',personal_b,token_b)[0] in (400,401,403)
  cur.execute('update auth.users set deleted_at=null where id=%s',(user_b['id'],))
  print('PASS genuine_stale_jwt_HTTP_denied_after_Auth_identity_soft_delete')
  status,second_session=call('/token?grant_type=password',{'email':'tf-designated-local-b@local.test','password':password_b})
  assert status==200
  status,_=call('/logout?scope=global',bearer=second_session['access_token'])
  assert status==204
  for saved in (token_b,second_session['access_token']):
   assert rpc('my_membership',{},saved)[0] in (400,401,403)
  print('PASS real_global_logout_HTTP_denies_both_existing_sessions')
  status,_=call('/logout?scope=local',bearer=access)
  assert status==204,status
  cur.execute('select count(*) from auth.sessions where id=%s',(sid,)); assert cur.fetchone()[0]==0
  print('PASS real_auth_logout_local_deletes_session')
  assert as_token('select app_private.uid()')==[(None,)]
  assert rpc('my_membership',{})[0] in (400,401,403)
  assert rpc('create_personal_task',args)[0] in (400,401,403)
  print('PASS saved_genuine_token_denied_after_logout_HTTP')
  cur.execute(rollback_path.read_text())
  verify(db,before)
  print('PASS exact_catalog_rollback_functions_policies_auth_column_ACLs')
  print('Rollback verified; named PASS lines above; genuine local Auth + PostgreSQL/PostgREST, no hosted/device validation')
 finally:
  if 'rest' in locals():
   rest.terminate();rest.wait(timeout=8);rest_log.close()
  proc.terminate()
  try:proc.wait(timeout=8)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
  log.close();db.close();conn.close();server.cleanup()
if __name__=='__main__':main()
