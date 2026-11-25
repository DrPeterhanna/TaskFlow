# Fresh local setup, November24 corrected source

This source includes the0025numeric cursor fix. It replaces the OLD transition source download for fresh setup. Keep all old files; do not combine two different source versions. The five backend runtime ZIPs are unchanged.

For the guided setup, download all six selected ZIPs into C:\TaskFlow-Downloads. Extract this source ZIP once into C:\TaskFlow-Local. Its app, dev, docs, supabase and tests folders must be directly inside C:\TaskFlow-Local. Do not add a second nested source folder. Extract each of the FIVE backend ZIPs into C:\TaskFlow-Local, NOT into dev or dev\real-auth. Windows must merge their dev\real-auth paths. This does not change the installed phone APK.

Expected paths after merging:
- C:\TaskFlow-Local\dev\real-auth\Setup-Backend.cmd
- C:\TaskFlow-Local\dev\real-auth\Start-Backend.cmd
- C:\TaskFlow-Local\dev\real-auth\Connect-Phone.cmd
- C:\TaskFlow-Local\dev\real-auth\bin\auth
- C:\TaskFlow-Local\dev\real-auth\bin\postgrest
- C:\TaskFlow-Local\dev\real-auth\vendor\auth-source\migrations
- C:\TaskFlow-Local\dev\real-auth\wheels

Do not run anything until the guided extraction check passes. The backend needs free WSL2 with a distribution named Ubuntu, Python3.10-3.12 and venv. Check existing WSL state before installing anything. Read dev/real-auth/WINDOWS-SETUP.md. No Docker, hosted database, paid service, firewall change, Android reinstall, app uninstall or storage reset is required. All source/runtime/HTTP tests were executed on Linux. Windows/WSL/USB steps remain unverified on this laptop until the owner runs them.

Since this is fresh setup, do NOT run the existing-database cursor upgrade script. Fresh launch includes0025automatically. Keep the backend window open; check Windows localhost health first, then USB forwarding, then phone health, then retry account registration ONCE using a disposable test password. Never reuse an important password.

The existing downloaded ARM64APK remains the installation under test. This source adds clearer local-backend connection wording, but no new APK was built for that wording. CursorSQLis server-side and needs no APK reinstall.
