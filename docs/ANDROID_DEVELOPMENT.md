# TaskFlow local Android development

This guide describes the current follow-up source, not the unchanged six files delivered earlier. Historical build evidence is preserved in [Android build history](transition/ANDROID-BUILD-HISTORY.md). Follow the final candidate manifest for exact revision, APK bytes and SHA256, not a hash copied from older history.

## Current behavior

The native entry uses genuine local Auth/PostgREST and account-separated Expo SQLite. It never imports preview/fake account/task data. Personal tasks open without organization onboarding. Title edits use a checked outbox operation and preserve drafts after a failed save or changed edit base. Organization features remain available.

An established secure stored session can unlock local personal identity after access-token expiry only when refresh fails with a retryable network/server error. It does not grant organization authority or a network token. Server calls still require the current session and server authorization. Offline logout locks local access immediately even if remote revocation fails; task queues remain stored. Cached personal data cannot detect a remote revocation while disconnected. This is a local development MVP, not production security acceptance.

## Build

Prerequisites used: Node22.23.5, lockfile dependencies, JDK17.0.21.1, Android SDK36, Build-Tools36.0.0, platform-tools, NDK27.1.12297006, CMake3.22.1, Gradle wrapper9.4.1. Windows tools/prerequisites have not been installed or executed by this handoff's tests.

From app:

    npm ci
    npm run typecheck
    node scripts/build-local-android.mjs

Set JAVA_HOME and ANDROID_HOME to your installed paths. Android Studio can generate untracked android/local.properties for its SDK. The helper explicitly sets the disposable loopback backend environment, removes only generated debug JS outputs, asks Metro to reset its transform cache, and runs :app:assembleDebug with one worker/in-process Kotlin. It does not touch app/backend data. Clean dependency/native compilation takes longer than the reported warmed builds. Network downloads required on a clean machine; no paid build services or API keys.

Output: app/android/app/build/outputs/apk/debug/app-debug.apk. Default debug embeds JS and does not need Metro. Source/environment changes require rebuilding. A plain environment-variable change did not invalidate an old JS bundle during testing, which is why the helper clears generated outputs. Do not regenerate Android source and assume the changes survive without review.

The sanitized source uses app.taskflow.placeholder.windowsdev, separate from the earlier APK's app.taskflow.placeholder. A debug key is generated/reused locally, never shipped in source. Another computer's debug signer may not update a supplied APK with the same package. Never uninstall a populated app to fix a signature error. No pending-data migration has been tested.

## Setup and acceptance

- [Open in Android Studio](../OPEN-IN-ANDROID-STUDIO.md)
- [Backend Windows/WSL guide](../dev/real-auth/WINDOWS-SETUP.md)
- [Ordered Thursday test plan](transition/THURSDAY-LOCAL-TESTING.md)

Windows source opening/building does not need WSL. Signin/sync requires the running laptop backend and USB reverse to http://127.0.0.1:54321. Source helpers never select hosted/production projects.

Native compilation, APK ARM64 contents, package metadata, embedded configuration and v2 signature have passed Linux checks. Android installation, launch, native SQLite/SecureStore, keyboard rendering, Windows, Android Studio, WSL and USB/device tests remain unverified. Browser/Python/node tests are separate evidence, never native acceptance.

Foreground/app-resume sync only. A periodic foreground check runs every60seconds. SDK refresh failures have a60second cooldown; expired offline cold boot took about25seconds in simulation before local access opened. Allow roughly two minutes plus request time for reconnect acceptance. Do not claim instant/background/killed-app sync.

Keep original project/database, hosted environments and all delivered six files untouched. No deployment, hosted migrations, migration0014, cleanup policy, paid services or API credits. Preserve data and rollback records. Plaintext local SQLite, untested device backups, remote synchronization and broader security/load reviews remain future requirements.
