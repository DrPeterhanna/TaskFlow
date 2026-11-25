# Sanitized Windows source export

The Windows source export builds a separate debug app:
`app.taskflow.placeholder.windowsdev`. It does not overwrite the earlier APK
(`app.taskflow.placeholder`) and does not move/delete that app's pending data.
AGP creates or reuses your local Android debug key, which is not included here.
There is no promise that this key matches the already delivered APK's signer.
See OPEN-IN-ANDROID-STUDIO.md and docs/transition/GIT-RECOVERY.md.

Historical build evidence below refers to the earlier APK's package/signature,
not this sanitized source's separate application identifier.

# Current Android development handoff

Start with [Open in Android Studio](../OPEN-IN-ANDROID-STUDIO.md).
Windows Android source work does not require WSL or a running backend.
The separate [backend guide](../dev/real-auth/WINDOWS-SETUP.md) covers WSL2/USB.

Current local-configured ARM64 APK: 53,697,985 bytes, SHA256
`d8dbc611928da654cc0613eec8a52f75d7caa91365634047a71453f7d1a6b21e`.
Native build and v2 signature pass; actual Android launch/Windows/WSL are unverified.
Genuine local Auth now runs with PostgREST and the revocation patch, unlike the
older build record below. No hosted/original database was changed.

## Historical first-build evidence, superseded limitations retained as history

# TaskFlow Android development build

## First verified APK, 24 November 2026

This is a real native Android debug APK, not a browser preview. It contains the native SQLite module and an embedded Hermes/JavaScript bundle. A development backend was NOT configured for this first build. Its code selects a setup-required screen instead of demo tasks, but launch and rendering have not been verified on Android. It is not yet a usable signed-in task-testing build.

- Package: `app.taskflow.placeholder` (temporary development identifier)
- Version: `0.1.0`, version code `1`
- Build type: debug, Android Debug signing certificate, APK v2 signature verified
- Architecture: **x86_64 only**. Use an x86_64 Android Emulator. This APK is not for ordinary ARM Android phones or ARM-only emulators on Apple Silicon.
- Minimum OS: Android 7.0 / API 24
- Compile and target SDK: API 36
- Size: 51,225,525 bytes
- SHA-256: `0cc0227e1c7f451c5380c7b6b005b1c92e2a48ade582a5c2d8136f81d59d1c48`
- Build output: `app/android/app/build/outputs/apk/debug/app-debug.apk`
- No emulator installation or launch was performed here. No Android behavior tests have passed or failed yet.

## ARM64 phone artifact, 24 November 2026

An additional ARM64 build completed and was signature/archive verified. It has not been installed or launched. Its backend is still unconfigured, so the expected setup-only limitation is unchanged.

- Filename: `TaskFlow-0.1.0-debug-arm64-v8a.apk`
- APK size: 51,648,784 bytes
- SHA-256: `78e733f6bf3459299644789ae325191acac512854ccd0d5f4b904a519858745e`
- Actual ZIP archive for private transfer: `TaskFlow-0.1.0-debug-arm64-v8a.zip`, 20,930,558 bytes
- Package/version/SDK are the same as above, but native ABI is `arm64-v8a` only.
- Build command uses `-PreactNativeArchitectures=arm64-v8a` instead of x86_64.
- For local backend access from a USB-connected phone, use `adb reverse tcp:54321 tcp:54321` and compile with `EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`. Do not use the emulator-only 10.0.2.2 address on a physical phone. This requires a functioning local backend on the same computer, a configured rebuild and an active adb connection. Real behavior is not yet verified.

## Install the x86_64 APK in Android Studio

1. Install Android Studio using the Android developer site's download offered for your computer.
2. Open Android Studio. From the welcome screen choose **More Actions > Virtual Device Manager**. In an open project use **Tools > Device Manager**.
3. Create a phone virtual device, for example a Pixel. Download an **x86_64 Android 16 / API 36** system image. If Android Studio only offers ARM images for your machine, do not try this x86_64 artifact; request an arm64 build.
4. Finish creating the device and start it. Wait for its Android home screen.
5. Drag the actual `.apk` file onto the running emulator. Do not drag a ZIP or transfer chunk. Open **TaskFlow** in the emulator's app drawer after installation.
6. For this first artifact, the expected result is **TaskFlow development setup required**. Confirming that screen would validate launch, not signed-in or offline task behavior.

Command-line alternative using your Android SDK's `platform-tools/adb`:

```sh
adb devices
adb install -r TaskFlow-0.1.0-debug-x86_64.apk
adb shell am start -n app.taskflow.placeholder/.MainActivity
```

If installation reports a signing conflict, do not uninstall an existing TaskFlow installation containing unsent work. Keep that installation and its data, and ask for a separate development package or an explicit safe migration plan.

## Logs

Open the native project folder `app/android` in Android Studio. Open **View > Tool Windows > Logcat**, select the running emulator, then use the query `package:app.taskflow.placeholder`. For an installation made from the APK alone, choose the process after launching it. To collect command-line logs:

```sh
adb logcat -v time ReactNativeJS:V AndroidRuntime:E '*:S'
```

Do not share access tokens, email verification links or account details in logs. Keep logs private until reviewed. The APK loads embedded JS without Metro. Source edits or environment changes require a rebuild. Native developer-server loading is disabled in this standalone build, while Android Logcat remains available.

## Development backend status

There is currently **no configured development backend**. Do not point this build at production. The existing production project remains frozen and no hosted migrations were run.

The real application uses Supabase Auth plus PostgREST RPCs in `app_api`. Native task storage uses expo-sqlite. A plain PostgreSQL test database or the browser preview bridge is not a substitute for that backend.

A disposable local Supabase stack must be prepared with `app_api` exposed and an explicitly reviewed migration manifest. Do not apply all migration files: 0014 is a held account-lifecycle policy proposal, and 0015 currently depends on its identity change. The native shell requires `my_membership`, so a compatible read-only alternative to 0015 must be tested without installing 0014 before signed-in task testing can proceed. That backend compatibility work is still outstanding. Do not run a reset command against any existing database or shared project. Creating synthetic/test accounts remains a separate explicit decision, not something this APK has done.

For an Android Studio emulator, the eventual local configuration in untracked `app/.env.local` has this shape:

```dotenv
EXPO_PUBLIC_TASKFLOW_ENV=local
EXPO_PUBLIC_SUPABASE_URL=http://10.0.2.2:54321
EXPO_PUBLIC_SUPABASE_KEY=<publishable-or-anon-key-from-the-disposable-local-stack>
```

`10.0.2.2` refers to the emulator host computer, so the backend must be reachable from that computer. Never enter a service-role key, secret key, database password or production key here. Environment values are embedded when JS is bundled. The supplied unconfigured APK will not pick up a new `.env.local` on the user's computer; it must be rebuilt.

## Reproduce the build

Use the existing branch `feature/offline-sync`. Keep `main` and `wip/delete-subtree-guard` unchanged.

Required installed components used for this build:

- Node and dependencies from the repository lockfile
- JDK 17
- Android SDK Platform 36, Build-Tools 36.0.0 and platform-tools
- NDK 27.1.12297006
- SDK CMake 3.22.1, including Ninja
- Gradle wrapper 9.4.1 already in `app/android`

Set `JAVA_HOME` and `ANDROID_HOME` for your own installation. Android Studio may instead generate an untracked `app/android/local.properties` with its SDK path. Do not copy machine-specific paths into Git.

```sh
cd app
npm ci
npm run typecheck
cd android
./gradlew --no-daemon --max-workers=1 \
  -Dorg.gradle.jvmargs='-Xmx1000m -XX:MaxMetaspaceSize=480m' \
  -Pkotlin.compiler.execution.strategy=in-process \
  :app:assembleDebug -PreactNativeArchitectures=x86_64
```

On Windows use `gradlew.bat` and put the flags on one line. The final successful invocation used a lower heap of 800m and metaspace 420m on a memory-constrained machine; machines with more RAM can use more. All commands run locally and do not use paid build infrastructure.

Expo 58's precompiled modules require Android API 37, which was not available in the SDK repository inspected during this build. The repository explicitly compiles against available API 36 and uses Expo's `expo.autolinking.android.buildFromSource` option for installed modules. All source compilation and Android dependency metadata validation passed. No dependency version was changed and no compatibility check was disabled. Do not regenerate `app/android` with prebuild and assume the standalone-bundle, backup and SDK changes will survive; review those changes after any regeneration.

## Tests to run after backend setup and a configured rebuild

These are **not yet executed on Android**:

- Sign in and reach the personal task screen.
- Create, edit, complete and delete tasks; verify server convergence.
- Sync once, force-stop, turn on airplane mode, launch again and verify saved tasks remain.
- Make offline edits, force-stop, reopen, reconnect and verify exactly-once convergence.
- Switch accounts while work is pending; verify no tasks or worker operations leak to the other account.
- Exercise expired auth, lost responses, conflict resolution and guarded subtree deletion.
- Verify actual SQLite persistence and safe recovery without clearing application storage.

Do not use **Clear storage**, uninstall or erase the emulator while it contains pending work. Cleanup remains disabled. Existing limitations include plaintext local SQLite, unverified hosted/device auth and lifecycle behavior, unresolved legacy database import, and retention safety not yet proven.

## Evidence

Detailed command output is retained in the local evidence directory. The decisive successful build log is `android-build-source7.txt`; APK checks are `android-apk-badging.txt` and `android-apk-signature.txt`. Before Android project work, local regression tests were 96 server tests and 181 app tests passing. Those are not native Android acceptance results.
