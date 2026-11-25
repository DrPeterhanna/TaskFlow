# Disposable Android backend preparation, review only

This helper prepares a NEW local Supabase work directory. It does not start services, connect to a database, apply migrations, create accounts, or contact hosted Supabase. It refuses any existing destination and records SHA-256 hashes for its exact SQL inputs.

## Included and excluded SQL

`manifest.txt` selects 22 original SQL files: 0001 through 0013, then 0016 through 0024. It explicitly excludes held policy migration 0014 and existing 0015. A separate read-only `0015_my_membership_baseline.sql` uses the original `profiles.id = auth.users.id` identity instead of 0014's `auth_user_id`. No account erasure, leave or organization closure policy is installed.

This is a local development proposal, not migration or hosted deployment approval. None of the original migration files was edited. Do not copy its SQL into production or run all repository migrations.

## What was verified

- `python tests/local_backend_manifest.py`: 7 checks pass against disposable PostgreSQL with an Auth schema shim. This is not real Supabase Auth or Android validation.
- Exact original grant-set assertions were isolated: expected native APIs are present; only held `leave_organization` and `close_organization` are absent. Client write privileges remain absent. Private helper grants match baseline without the additional held-policy `uid` grant.
- Verified/unverified/no-org membership, anonymous refusal, removed-member filtering, closed-org filtering and membership owner isolation pass independently of account deletion tests.
- Checked personal mutation, cross-owner refusal and mutation-safety capability pass.
- Baseline Auth account deletion refuses atomically and preserves data. Account deletion is not a supported native acceptance flow for this manifest.
- Supabase CLI 3.3.0 `config validate` passed for the generated config with no warnings.
- A second preparation into the same destination was refused as intended.
- An actual local `supabase start` attempt failed before startup because Docker and Podman are both absent here. No standard Supabase stack was run.

The original all-proposal regression baseline remains **96/96 passing**, including 0014. The alternate manifest's original full suite is **83 passed, 13 failed of 96**. Do not combine these counts or call the alternate manifest fully compatible. The seven isolated checks add evidence but do not turn those 13 failures into passes.

## All 13 failures reconciled

| Original failing test | Cause and isolated required behavior |
|---|---|
| `lint_clients_have_no_write_privileges_and_anon_has_none` | Its exact API list demands held leave/close functions and an extra uid grant. Independent exact baseline API/private-grant and no-client-writes checks pass. No grant was relaxed. |
| `lifecycle_member_deletion_erases_personal_data_keeps_org_history_and_blocks_stale_jwt` | Requires held deletion/anonymization policy. Baseline FK/append-only guards reject deletion rather than erase; independent atomic refusal/preservation check passes. Erasure is not supported. |
| `lifecycle_last_admin_blocked_is_atomic_then_retry_succeeds` | Requires held dedicated last-admin deletion/leave behavior. Baseline generic FK refusal occurs first. No promise of delete-after-transfer or leave. |
| `lifecycle_close_empty_org_then_delete_admin_full_cleanup` | Requires held close/leave and erasure APIs, absent deliberately. |
| `lifecycle_close_refused_when_org_has_work_and_other_orgs_untouched` | Requires held close/work policy. Not supported in this native testing manifest. |
| `lifecycle_leave_organization_member_ok_admin_rules_and_replay` | Requires absent held leave API. Not part of native personal-task acceptance. |
| `lifecycle_concurrent_deletion_of_both_admins_keeps_one` | Held policy permits one deletion; baseline refuses both by FK, retaining both accounts. It is not the held policy outcome. |
| `lifecycle_user_without_org_deletes_cleanly_and_profiles_only_orphaned_when_anonymised` | Held identity split/anonymization absent; baseline personal audit append-only guard refuses deletion with history. |
| `lint_identity_is_resolved_only_through_uid` | Demands the held global identity rewrite. Baseline helpers still use auth.uid directly. This is a known identity-policy limitation, not an irrelevant lint. Administrative soft-deletion of a profile does not gain held-policy revocation behavior. |
| `lifecycle_guard_lock_serialises_deterministically` | Requires held pre-deletion advisory lock. Baseline deletion fails FK before that policy exists. No serialization claim. |
| `my_membership_reports_own_state_only` | Membership/no-org/anonymous assertions pass before its bundled Auth-user deletion fails. Independently tested owner-only/no-org/anonymous/removed-member behavior passes; deleted-account flow remains unsupported. |
| `my_membership_verified_flag_and_closed_org` | Verified flag refresh and org membership assertions pass, then absent held close API fails. Independent verification-refresh and soft-closed-org filtering pass without close policy. |
| `admin_of_closed_org_may_be_deleted_and_soft_deleted_profile_cannot_authenticate` | Baseline FK blocks account deletion before the bundled soft-deleted-profile assertion. That later assertion must not be dismissed: baseline uid/require_uid lack the held deleted-profile checks. This remains an actual administrative revocation limitation. Do not perform Auth account/profile deletion while testing this baseline. Resolve identity-policy design separately before production. |

No failing test was removed or edited. The alternate manifest is suitable for further limited local compatibility investigation, not a claim of production or complete identity safety.

## Prepare on a computer, without starting anything

From the repository root, choose a destination that does not exist:

```sh
python dev/local-backend/prepare.py ../taskflow-android-disposable
cd ../taskflow-android-disposable
npx supabase@3.3.0 config validate
```

The destination contains no linked hosted project. The helper writes a new config with email confirmation enabled, no seeds, and `app_api` exposed. It records the exact 23 SQL file hashes in `migration-inventory.json`.

Prerequisites before an eventual start: an installed supported Docker-compatible container runtime; Supabase CLI; adequate memory and free ports 54320-54322. The official CLI reference recommends at least 7GB RAM for all services. Docker Desktop's license depends on the user's organization; do not activate a paid plan. Choose a free permitted local runtime for the user's situation. No paid cloud or build service is needed.

The next local command, once reviewed and with a NEW disposable directory only, would be `npx supabase@3.3.0 start`. This has not been verified to finish here. It creates containers and applies this manifest to that NEW local database, not production. Do not run reset, db push, link, or any hosted command. Do not run it in the original repository's supabase directory, where held migrations remain for historical/local test coverage.

Account creation requires the user's decision and should use only this disposable local service. Do not create accounts silently or use production credentials. No account is seeded by preparation.

## Phone versus emulator URL

For an Android Studio emulator, a configured rebuild can use `http://10.0.2.2:54321` once the local stack works.

For a physical Galaxy A56 connected to that computer over USB with adb:

```sh
adb reverse tcp:54321 tcp:54321
```

Then a configured rebuild uses `http://127.0.0.1:54321`. The USB reverse connection and local stack must stay running. Never put privileged secrets into EXPO_PUBLIC values. The supplied setup-only APK cannot acquire a new build-time environment without rebuilding.

## Sources inspected

- https://supabase.com/docs/reference/cli/start
- https://supabase.com/docs/guides/local-development/cli/config
- Local Supabase CLI 3.3.0 generated config and validation output
- Existing repository migrations, tests and exact alternate-manifest output

## Remaining gates

Standard Supabase stack startup, real Auth/PostgREST/RLS behavior, account creation decision, configured ARM64 rebuild, and actual phone acceptance all remain open. No production readiness claim. Cleanup stays disabled, SQLite remains plaintext, legacy import remains unresolved.
