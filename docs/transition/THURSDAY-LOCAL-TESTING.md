# Thursday development handoff: local test sequence

Status: preparation in progress. Windows/Android Studio/WSL/USB and Galaxy A56 acceptance are NOT executed. Do not mistake Linux compilation or browser tests for a phone pass. The six already-delivered files remain unchanged; later source/APKs are separate follow-up candidates.

## Preserve existing work

Do not uninstall TaskFlow, clear storage, reset the database or erase an emulator containing unsent tasks. Source uses app.taskflow.placeholder.windowsdev, separate from the earlier app.taskflow.placeholder APK. A source build made on your Windows computer uses that computer's debug signer. If installation says signatures differ, STOP, do not uninstall to fix it. Ask for a data-preserving migration/separate package.

Local backend files contain no existing accounts or task data. Use disposable test accounts and passwords not used elsewhere. SQLite task data is plaintext inside the app sandbox, not encrypted. SecureStore stores session credentials. Do not put real work/customer data in this development build.

## First steps on Thursday

1. Confirm the exact handoff filenames, byte sizes and SHA256 against the final handoff manifest, using Windows PowerShell Get-FileHash. Stop on any mismatch. Do not assume earlier six-file hashes apply to newer follow-up files.
2. Check Windows PC is Intel/AMD x64; ARM Windows is not supported by these Linux backend binaries. Keep at least several GB free for Android SDK/dependencies and WSL. Exact free-disk requirement has not been measured.
3. If Android Studio is absent, install it from https://developer.android.com/studio. Use its normal SDK setup. Do not pay for a build service or enable cloud/AI features. First test is opening app/android from the new source root, not the original project.
4. Node and JDK/SDK requirements are in OPEN-IN-ANDROID-STUDIO.md. Run npm ci from app to install the lockfile dependencies. Network downloads are required on a clean machine. No paid API keys are required.
5. The tested configured build route is `node scripts/build-local-android.mjs` from app, after Node/JDK17/SDK36/Build-Tools36.0.0/NDK27.1.12297006/CMake3.22.1/platform-tools are installed. The helper explicitly embeds loopback54321, clears only generated debug JS outputs and asks Metro for fresh transforms. It does NOT clear app data or backend data. Run Gradle/app assemble only, not every dependency's library assemble task. Cold compilation may take several minutes. This command executed on Linux, Windows wrapper still unverified.
6. Opening/building Android source does not need WSL. Signing in/syncing does. Follow dev/real-auth/WINDOWS-SETUP.md for WSL2 Ubuntu22.04/24.04, included runtime archive extraction, Setup-Backend.cmd and Start-Backend.cmd. Stop if Windows cannot read http://127.0.0.1:54321/health. Do not expose the backend on LAN or change firewall settings as a shortcut.
7. Enable USB debugging on the Galaxy, approve the computer's RSA prompt, connect one device and use Connect-Phone.cmd. Run it again after reconnecting USB. The adb reverse rule alone does not prove sign-in works.
8. Install the final named separate-install ARM64 APK or use your Windows-built version. Do not install both sequentially without checking signer compatibility. The APK contains embedded JS, so no Metro server should be required for cold launch.

## Acceptance record

Record actual screen/result and time for every step. Keep test account names and logs private. Never share passwords, JWTs, refresh tokens, signing keys or the backend data directory.

- Launch: native app shows sign-in, not setup error, demo tasks or a red error screen.
- Signup/signin: create disposable account A. Local email is auto-confirmed and no email is sent. Personal task home opens without joining an organization. Optional organization tab remains available.
- CRUD: create title, edit title, complete/reopen, delete. Check server convergence while connected. All edits use guarded operations.
- Offline: after valid session and one successful sync, disconnect USB and internet. Create and edit tasks, complete/reopen. Pending indicator must say changes are on this device, not claim server saved them.
- Process restart: force-stop and reopen while still disconnected. Tasks and pending changes must remain. Do not use Clear storage. Repeat after access-token expiry: local-only workspace should remain available, never org authority. Current SDK may retry for about25seconds before opening expired-session offline cache.
- Reconnect: start backend, reconnect USB/run Connect-Phone, resume app. Foreground check is60seconds; SDK caches failed refreshes for up to60seconds. Allow roughly two minutes plus request time before declaring failure. No background/killed-app sync promise. Queue must drain once, without duplicates or silent overwrites.
- Conflict: two sessions edit same title. An old open editor whose title refreshes must refuse and retain draft. A queued stale edit should show a decision, not overwrite a newer server title.
- Isolation: sign out A with pending work, sign in B. B must never show/send A's tasks. Sign back into A, queue remains. Signing out locally is immediate even if server unreachable; server revocation cannot be guaranteed until network request succeeds. Do not call a failed offline logout a global logout.
- Suspension/removal: org restrictions must not lock personal workspace; global account suspension/session revocation must block server calls. Cached local data cannot learn remote revocation while disconnected. On reconnection the server remains authoritative.

## Limits that remain

Laptop backend+USB is required for sync. Away from it the established local workspace remains offline only. Foreground/resume sync, not guaranteed background or always-online service. No hosted project/production data changes, no migration0014/cleanup/account-lifecycle policy. No Realtime/Storage/SMTP/Studio/Edge Functions. No physical device, secure-store backup, Android keyboard layout, installation, USB or Windows networking acceptance yet. Do not erase data to hide a failure.

## Origin-scoped auth compatibility change after review

The reviewed follow-up now uses a new full-origin session/lock key, including scheme, host and port. Earlier hostname-only saved credentials are left untouched and are NOT imported automatically. Sign in online once after installing this follow-up. Existing task SQLite files and queued changes are not deleted or moved; signing into the same account and same backend origin reopens its existing account partition. If you cannot sign in, preserve the app and data, do not reset/uninstall. This avoids accidentally using a session from another local backend port.

If sign-out reports it could not confirm saving on this device, do not treat logout as safely persisted or hand the device to someone else. Current-process network tokens are blocked and SDK cleanup is attempted, but a persistent-storage failure cannot be called successful. Use the visible Sign out retry after storage recovers. A different message confirms local sign-out but says server revocation could not be confirmed when the backend is disconnected. Neither is a global logout success claim.
