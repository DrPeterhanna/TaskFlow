# Genuine local Auth integration

Use WINDOWS-SETUP.md for the user-facing launcher path. Android development is
independent: see ../../OPEN-IN-ANDROID-STUDIO.md.

Pinned official Supabase Auth v2.198.0 commit
387e91f37e00b64b9060352988066bbb685f6e45, built for Linux x64 with the documented dependency fuzz-fixture exclusion.
See build/AUTH-BUILD-NOTES.md for exact provenance and regression results.
PostgREST16.6, pgserver0.1.4, psycopg2-binary2.9.13.
The package's Auth and PostgREST executables are static Linux binaries.
Auth migrations are the official pinned release's files, not an auth SQL shim.
Runtime files under bin/vendor/wheels are excluded from Git and included only
in the backend runtime archive. Auth source can be retrieved from its official
repository at the recorded commit; no patches are required for Linux.

integration.py is a fresh disposable genuine-Auth regression, with a locally
signed service-role admin token only for designated test-account creation.
User access tokens come from real password sign-in, never local fabrication.
The script currently accepts TASKFLOW_AUTH_SOURCE/TASKFLOW_AUTH_BINARY overrides;
service evidence logs are development-machine paths, not needed by launch.py.
launcher_smoke.py tests local-only signup/refresh, persistent restart and retained
task/session data. The app opt-in test uses the production Supabase JS adapter,
node SQLite and actual HTTP. These are not device SQLite/Android acceptance.

authorization.sql adds current user/session/profile/global-guard validation,
current membership/role checks, personal read policies and a PostgREST pre-request
hook. The hook is configured in launch.py so even read RPCs are denied after
revocation, rather than returning an empty result mistaken for successful sync.
The hook is required. Do not use the SQL on a different server without review.
Every deployed app raw auth.uid reference was inventoried: only the validated
uid helper retains it; no app RLS policy uses raw auth.uid after this patch.

The concurrency promise is intentionally narrow: new requests after committed
revocation are denied; an already-authorized in-flight request may finish.
Current database roles/grants are authoritative, not cached JWT app roles.
Org suspension/removal blocks org operations but retains personal work. Global
suspension, deleted Auth/profile, ban, missing/expired session block all RPCs.

No original database, hosted project, cleanup or account lifecycle migration is
changed. The manifest excludes0014/0015 and adds a local read-only compatible
my_membership. Direct hosted deployment is explicitly out of scope.

Rollback is generated from the exact pre-patch catalog. Integration verifies
function definitions/owners/grants, changed RLS policies and Auth column ACLs.
It is an operator recovery artifact, not an automatic launcher action. Stop all
writers, preserve data, and remove the hook configuration only in a coordinated
code+local-schema rollback. The baseline has known weaker revocation behavior.

Sources:
https://github.com/supabase/auth/releases/latest
https://github.com/supabase/auth/blob/master/internal/models/sessions.go
https://github.com/supabase/auth/blob/master/internal/api/logout.go
https://docs.postgrest.org/en/stable/references/auth.html
https://www.postgresql.org/docs/current/sql-createpolicy.html
