-- 0018: Hosted Supabase compatibility (ownership, auth trigger, and app_api grants)

CREATE OR REPLACE FUNCTION app_private.require_uid()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ok boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthenticated' USING errcode = 'TF001';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app.profiles p
    JOIN auth.users u ON u.id = p.id
    WHERE p.id = v_uid
      AND p.deleted_at IS NULL
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until <= statement_timestamp())
      AND NOT EXISTS (
        SELECT 1 FROM app.account_access_guard g
        WHERE g.user_id = p.id AND g.suspended
      )
  ) INTO v_ok;

  IF NOT v_ok THEN
    RAISE EXCEPTION 'account unavailable' USING errcode = 'TF001';
  END IF;

  RETURN v_uid;
END $$;

CREATE OR REPLACE FUNCTION app_private.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO app.profiles (id, display_name)
  VALUES (NEW.id, COALESCE(split_part(NEW.email, '@', 1), 'User'))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created_taskflow ON auth.users;
CREATE TRIGGER on_auth_user_created_taskflow
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app_private.handle_new_auth_user();

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema_name,
           p.proname AS func_name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('app_api', 'app_private')
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) OWNER TO postgres;', r.schema_name, r.func_name, r.args);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA app_api TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app_api TO authenticated, service_role;
