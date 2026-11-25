# Open TaskFlow in Android Studio on Windows

For the local AI/workflow transition and offline Git history, see
[Transition plan](docs/transition/WINDOWS-LOCAL-WORKFLOW.md) and
[Git recovery](docs/transition/GIT-RECOVERY.md).

You do NOT need WSL or a running backend to open, edit, sync Gradle, build,
install, inspect native code or use Android Studio Logcat. The backend is a
separate setup, needed only for real sign-in and server sync.

## Signing and side-by-side safety

This credential-free export uses applicationId app.taskflow.placeholder.windowsdev
for debug builds. Android's Gradle plugin generates/reuses a debug key locally;
no signing key or password ships in this source or recovery history. This app
installs beside the earlier app.taskflow.placeholder APK, not as its update.
Existing tasks/pending work in that earlier app remain untouched. No automatic
account/cache/task migration is included. Both apps may be labelled TaskFlow;
check the package identifier in Android Studio/adb before launching or debugging.

## 1. Prepare Windows once

Extract to a short folder such as C:\TaskFlow (avoid OneDrive/network folders).
Install Android Studio and a current Node.js LTS supporting this lockfile.
The tested Node version here is22.23.5. React Native requires22.13+ on22.x,
24.3+ on24.x, or26+. Use22.23.5 for the closest reproduction.
Install JDK17 and set Android Studio's Gradle JDK to JDK17.
In SDK Manager install:
- Android SDK Platform36 and Build-Tools36.0.0
- Platform-Tools (adb)
- NDK27.1.12297006 and CMake3.22.1 (enable Show Package Details)

From PowerShell, in the extracted app folder:

    npm ci
    npm run typecheck

First install/build downloads free dependencies. No paid build service is used.
Open the extracted app\android folder in Android Studio, NOT the repository root.
Allow Gradle sync using the included wrapper9.4.1. Do not upgrade dependencies
or regenerate the Android project merely because the IDE suggests it.
SDK paths are machine-local. Let Android Studio create local.properties; do not
copy Linux paths from build logs. SDK/NDK/Gradle configuration is in the project.

## 2. Build and run without a backend

Select debug build variant and your connected Galaxy A56. ARM64 is the phone ABI.
For the tested explicit local-backend command-line build from app:

    node scripts/build-local-android.mjs

This pins loopback54321, refreshes generated JS and uses one-worker compilation.
The script is Linux-tested, Windows wrapper not yet executed. A bare Gradle
build without configuration may intentionally show setup-required instead.

The default debug APK embeds JS, so it cold-starts without Metro. It is still
an Android debuggable build: native breakpoints/Logcat work in Android Studio.
A bare Android Studio build without app\.env.local shows a setup-required screen, not synthetic tasks. The local build script above sets explicit disposable configuration for that invocation.
This is intentional. WSL setup is not a build prerequisite.
Output: app\android\app\build\outputs\apk\debug\app-debug.apk.
The supplied LOCAL APK is already configured, unlike the earlier setup-only APK.

Do not uninstall or clear app storage to solve an install/signing conflict.
Preserve pending work and ask for a separate development package/migration plan.

## 3. Optional JS/TypeScript live debugging

Default standalone mode does not load Metro. To opt into live JS debugging,
add taskflow.metro=true to app\android\gradle.properties locally, then rebuild
and run debug from Android Studio. In another PowerShell window in app:

    npx expo start --localhost --port 8081

Run Windows adb reverse tcp:8081 tcp:8081 for the phone. Use React Native DevTools
from the Expo terminal for JS breakpoints, not Android Studio's native debugger.
Remove that property/revert it to false and rebuild for embedded offline startup.
This optional Metro mode is configured but has NOT been built/run here.
Never use Metro-dependent mode as proof of offline cold-start behavior.

## 4. Connect the independent backend later

See dev\real-auth\WINDOWS-SETUP.md. Backend setup uses WSL2 Ubuntu only, not
Android Studio. Once it is healthy, run Connect-Phone.cmd there to verify Windows
localhost access and create adb reverse tcp:54321 tcp:54321.
In app, run the local build-config helper once:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\Configure-Local-Backend.ps1

It refuses to overwrite an existing .env.local. The values are loopback and a
non-secret local development key. Use node scripts/build-local-android.mjs to rebuild after creating/changing the file. Changing an environment value alone did not invalidate a cached bundle during Linux testing; the helper removes only generated JS outputs before bundling.
Do not point the app at production or enter service keys/database credentials.
For an emulator on this PC the same adb reverse method can be used, with exactly
one connected device. An ARM64 APK cannot run on an x86-only emulator; rebuild
with -PreactNativeArchitectures=x86_64 for that emulator.

## 5. Tests and honest validation status

From app on Windows: npm run test:unit and npm run typecheck. The portable unit
selection needs no Python/backend. It is executed here on Linux, not proven on
Windows. Full npm test also includes Python/PostgreSQL bridge and POSIX SIGKILL
scenarios and must be run in the separate Linux test environment, not assumed
portable to Windows. All these tiers use node SQLite, not Android SQLite.
The real-Auth opt-in suite also requires the separate Linux backend runtime.
181 app regression tests passed. Five opt-in tests passed through the production
Supabase JS adapter and genuine local Auth/PostgREST. Native ARM64 assembly and
APK v2 signature verification passed on Linux. Windows Gradle, Android Studio,
WSL, physical USB, actual launch/rendering and Galaxy offline behavior remain
unverified. The configured APK must be installed and tested to close that gap.

Use Android Studio Logcat with package:app.taskflow.placeholder.windowsdev. Do not share
raw tokens/passwords or private account logs. No production/hosted environment
was changed; no cleanup/lifecycle policy was enabled. Preserve original data.
Recovery uses the sanitized local Git bundle, not the original full history.
See docs/transition/GIT-RECOVERY.md for mapped checkpoint instructions.

## Current acceptance and Thursday order

Use docs/transition/THURSDAY-LOCAL-TESTING.md for ordered checks and data-preserving stop conditions. The current source has personal-first entry, checked title editor and local-only identity after retryable offline token-refresh failure. No Windows/WSL/USB/native device acceptance has been claimed. Read docs/ANDROID_DEVELOPMENT.md for current status; historical evidence is separate.
