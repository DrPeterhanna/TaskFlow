-- LOCAL DISPOSABLE ONLY. Executed in Docker-free real-Auth tests, never hosted.
-- Target: disposable baseline 0001-0013 + 0016-0024 + reviewed baseline my_membership.
-- Never apply against held0014 identity layout or production. Transactional DDL.
-- Requires real Auth columns auth.users.banned_until/deleted_at and auth.sessions(id,user_id).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='app' AND table_name='profiles' AND column_name='auth_user_id') THEN
    RAISE EXCEPTION 'Held lifecycle identity layout detected; this proposal is not for that layout';
  END IF;
  IF to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION 'Real Auth sessions schema required; shim is not sufficient';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_rpc' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unsafe app_rpc role attributes';
  END IF;
END $$;

-- No public/global suspension API is introduced. An approved operator controls this table.
-- No row means no extra global suspension. Original membership suspension stays org-scoped.
CREATE TABLE app.account_access_guard (
  user_id uuid PRIMARY KEY REFERENCES app.profiles(id) ON DELETE RESTRICT,
  suspended boolean NOT NULL DEFAULT false,
  changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.account_access_guard ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.account_access_guard FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.account_access_guard FROM PUBLIC, anon, authenticated, app_rpc;
GRANT SELECT ON app.account_access_guard TO app_rpc;
CREATE POLICY account_access_guard_rpc_read ON app.account_access_guard
  FOR SELECT TO app_rpc USING (true);

-- Least-privilege reads, no mutation of the Auth-owned schema.
GRANT SELECT (banned_until,deleted_at) ON auth.users TO app_rpc;
GRANT SELECT (id,user_id,not_after) ON auth.sessions TO app_rpc;
-- Pinned real Auth enables RLS with no app_rpc policy; column grants alone return no rows.
-- Local-only explicit read policies, no writes/owner changes/BYPASSRLS.
CREATE POLICY taskflow_auth_guard_users_read ON auth.users FOR SELECT TO app_rpc USING (true);
CREATE POLICY taskflow_auth_guard_sessions_read ON auth.sessions FOR SELECT TO app_rpc USING (true);

CREATE OR REPLACE FUNCTION app_private.uid()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.id
  FROM app.profiles p
  JOIN auth.users u ON u.id=p.id
  WHERE p.id=auth.uid()
    AND p.deleted_at IS NULL
    AND u.deleted_at IS NULL
    AND (u.banned_until IS NULL OR u.banned_until <= statement_timestamp())
    AND NOT EXISTS (SELECT 1 FROM app.account_access_guard g WHERE g.user_id=p.id AND g.suspended)
    AND EXISTS (
      SELECT 1 FROM auth.sessions s
      WHERE s.user_id=p.id
        AND (s.not_after IS NULL OR s.not_after > statement_timestamp())
        AND s.id::text = (nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'session_id')
    )
$$;
ALTER FUNCTION app_private.uid() OWNER TO app_rpc;
REVOKE ALL ON FUNCTION app_private.uid() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.uid() TO app_rpc, authenticated;

CREATE OR REPLACE FUNCTION app_private.require_uid()
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v uuid := app_private.uid();
BEGIN
  IF v IS NULL THEN PERFORM app_private.raise_tf('unauthenticated'); END IF;
  RETURN v;
END $$;
ALTER FUNCTION app_private.require_uid() OWNER TO app_rpc;
REVOKE ALL ON FUNCTION app_private.require_uid() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_private.require_uid() TO app_rpc;

CREATE OR REPLACE FUNCTION app_private.my_membership_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT m.id FROM app.memberships m WHERE m.user_id=app_private.uid() AND m.status='active' $$;
CREATE OR REPLACE FUNCTION app_private.is_active_member(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=app_private.uid() AND m.org_id=p_org AND m.status='active') $$;
CREATE OR REPLACE FUNCTION app_private.me_is_admin_of(p_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=app_private.uid() AND m.org_id=p_org AND m.role='admin' AND m.status='active') $$;
CREATE OR REPLACE FUNCTION app_private.me_can_see_profile(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$ SELECT p_user=app_private.uid() OR EXISTS(SELECT 1 FROM app.memberships m WHERE m.user_id=p_user AND app_private.has_authority_over_membership(app_private.my_membership_id(),m.id)) $$;
CREATE OR REPLACE FUNCTION app_private.require_verified_email()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = ''
AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth.users u WHERE u.id=app_private.require_uid() AND u.email_confirmed_at IS NOT NULL) THEN
    PERFORM app_private.raise_tf('forbidden','verified email required');
  END IF;
END $$;

-- Existing ownership and grants survive CREATE OR REPLACE for these five helpers.
-- Grant no new RPCs and do not use finalize_ownership to mask unknown new objects.
ALTER POLICY memberships_select ON app.memberships USING (
  user_id=app_private.uid() OR (app_private.is_active_member(org_id) AND app_private.me_has_authority_over_membership(id))
);
ALTER POLICY personal_tasks_owner ON app.personal_tasks USING (user_id=app_private.uid());
ALTER POLICY personal_task_dependencies_owner ON app.personal_task_dependencies USING (user_id=app_private.uid());
ALTER POLICY personal_recurrence_rules_owner ON app.personal_recurrence_rules USING (user_id=app_private.uid());
ALTER POLICY personal_attachments_owner ON app.personal_attachments USING (user_id=app_private.uid());
ALTER POLICY personal_notes_owner ON app.personal_notes USING (user_id=app_private.uid());
ALTER POLICY personal_events_owner ON app.personal_events USING (user_id=app_private.uid());

-- Every PostgREST request validates current access before RPC dispatch or receipt lookup.
CREATE FUNCTION app_private.authorize_request()
RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$ BEGIN PERFORM app_private.require_uid(); END $$;
ALTER FUNCTION app_private.authorize_request() OWNER TO app_rpc;
REVOKE ALL ON FUNCTION app_private.authorize_request() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.authorize_request() TO authenticated;

-- No Auth deletion hooks. No lifecycle/cleanup triggers. No policy disabling.
-- Scope: local disposable development only; not a hosted migration.
COMMIT;
