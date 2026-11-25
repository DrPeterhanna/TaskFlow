# TaskFlow local backend for Windows

Status: launcher and gateway executed on Linux. Windows PowerShell, WSL2 forwarding,
USB and Samsung Galaxy A56 acceptance have NOT been executed here.
This package is a local development backend, not a hosted Supabase project.
Do not enter production passwords, private work data, or real customer data.

## Before the first run

Use an Intel/AMD x64 Windows 10/11 PC with WSL2 and Ubuntu 22.04 or 24.04.
Ubuntu's Python must be 3.10, 3.11 or 3.12; other versions are refused.
WSL2 setup can require administrator rights, virtualization and a restart.
If WSL is not installed, see Microsoft's instructions:
https://learn.microsoft.com/en-us/windows/wsl/install
Do not install or change WSL while other work depends on its current settings.

In Ubuntu, if Python venv is missing, run:

    sudo apt update
    sudo apt install python3-venv

This changes local Ubuntu packages and downloads free dependencies. It does not
create a paid account, contact a hosted database or change a Supabase project.
The SOURCE ZIP alone does not include runtime wheels or executables. Extract
the SEPARATE backend runtime archives into the same source root first. Those
archives supply wheels, Auth and PostgREST. See their runtime manifest. Backend setup itself
uses the included wheels with --no-index, not a package-server fallback.

Extract the entire ZIP to a normal folder, for example C:\TaskFlow-Local.
Keep the folder structure. The launch buttons are under dev\real-auth.

1. Double-click Setup-Backend.cmd once. It checks WSL2/Ubuntu and installs the
   included Python packages in a separate Linux virtual environment.
2. Double-click Start-Backend.cmd. Leave the window open.
3. Wait for Auth, PostgreSQL/schema, API and Gateway to report healthy.
4. In Windows, open http://127.0.0.1:54321/health. It must show ok:true.
   A healthy Linux process alone does not prove Windows forwarding works.
5. Connect the Galaxy A56 by USB, enable Developer options/USB debugging, unlock
   the phone and approve the computer's RSA prompt. Connect exactly one device.
6. Android Studio must have installed Android SDK Platform-Tools. The helper
   finds adb.exe on PATH or in %LOCALAPPDATA%\Android\Sdk\platform-tools.
7. Double-click Connect-Phone.cmd. It first verifies Windows can reach the
   healthy backend, then runs adb reverse tcp:54321 tcp:54321 and checks the rule.
8. Install the accompanying LOCAL-configured ARM64 APK. The older unconfigured
   APK still shows setup-required and cannot be configured after installation.
9. Create a disposable account in the app. Use a test email address, not a real
   password used elsewhere. This local environment confirms email automatically
   and sends no email. This is deliberately not production email verification.
10. Sign in, create a task, stop and reopen the app, and check that it remains.
    Then test offline changes with USB/backend disconnected, reconnect and sync.
    Report what the phone actually shows. No device acceptance is claimed yet.

The APK targets http://127.0.0.1:54321 with a non-secret local-only key. No signing
key, service-role token, account password or database credential is in the APK.
Windows -> WSL localhost forwarding is documented but depends on the machine:
https://learn.microsoft.com/en-us/windows/wsl/networking
https://learn.microsoft.com/en-us/windows/wsl/wsl-config
ADB reverse is documented here:
https://developer.android.com/develop/ui/views/layout/webapps/access-local-server
https://developer.android.com/tools/adb

## If it stops

Keep the error window open. No script resets or deletes your database.
No WSL networking or Windows firewall setting is changed automatically.
If localhost health fails, do not expose the server to the LAN as a workaround.
If adb says unauthorized, approve the phone's RSA prompt and run Connect again.
After unplugging/reconnecting USB or restarting adb, run Connect-Phone.cmd again.
The phone-to-backend chain is only verified after a successful app sign-in and
sync, not merely because an adb rule exists.

## Stop, restart and data

Press Ctrl+C in the backend window. Data is retained under Ubuntu:
~/.local/share/taskflow-disposable-v1
The signing key persists privately there. Do not share that directory or logs.
A restart reuses the existing database and refuses unknown/partial state or SQL
inventory changes. There is no automatic reset, migration upgrade or deletion.
The ZIP itself contains no accounts, passwords, tokens or existing database.
All listeners are loopback-only. PostgreSQL uses a local Unix socket, not TCP.

## Rollback

For source recovery use docs/transition/GIT-RECOVERY.md and the sanitized
Git bundle. It contains delivery-baseline and windows-transition snapshots,
not the full original history. Do not change approved remote branches.
For this disposable database only, the launcher records authorization-rollback.sql
from the exact pre-patch catalog before applying the patch. Remove the pre-request hook configuration only as part of rolling back the launcher; stop Auth/API and all
other writers before an operator applies it with the local database owner.
This restores the old, weaker authorization behavior and must not be used with
an exposed/running service. It does not delete task/profile data. It removes the
new access-guard table; archive any local guard decisions first. No rollback is
applied automatically. The integration test applied the rollback and verified
function definitions/ownership/grants, changed policies and Auth column ACLs match the baseline.
Preserve the entire data directory before any manual recovery. Never point the
rollback at a hosted or original database.

## Deliberate limits

No Docker, no production deployment, no hosted migrations, no Migration 0014,
no Cleanup Policy or account-lifecycle policies. No paid API calls.
Session timebox, inactivity timeout, single-session and low-AAL expiry settings
are not supported by this guard. The launcher strips inherited Auth settings
and uses the pinned default-disabled settings. Only explicit session not_after,
removed sessions, Auth/profile deletion, Auth ban and the global guard are checked.
Do not change session policy settings without extending and rerunning the tests.
No Storage, Realtime, SMTP, Studio or Edge Functions are included. TaskFlow's
current HTTP Auth/RPC sync path is the supported surface of this local stack.
