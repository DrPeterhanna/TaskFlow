# Local cursor repair0025

The new source initializes fresh disposable backends with the repair. Existing
backends refuse changed SQL inventory. Nothing is automatically reset, migrated,
or deleted. This repair is not in the six older delivered files.

## Explicit upgrade for an existing local backend

Linux/WSL only, tested on Linux, not Windows. Use the same ordinary Ubuntu user
that ran the backend. Stop the backend with Ctrl+C first. Preserve the full
private ~/.local/share/taskflow-disposable-v1 directory with the backend stopped.
It contains credentials, signing keys and user data. Never upload or share it.
Keep the old source directory as well, separate from the new source.

From the NEW source root, using its installed local Python environment:

    "$HOME/.local/share/taskflow-runtime-v1/bin/python" dev/real-auth/upgrade-cursor-0025.py --apply-local-only

If your local runtime Python has a different path, use the same Python that runs
Start-Backend; do not install unrelated modules into system Python. The command
checks the marked local data directory, takes the same exclusive launcher lock,
and requires the old inventory to equal the new inventory minus exactly0025.
Any other difference is refused. There is no host/remote URI input. It changes
only the sync_pull function in one transaction and checks ownership, security
mode and ACLs did not change. Tasks, profiles, sessions, receipts, queued Android
operations and signing keys are not edited. Private recovery files preserve the
prior function definition and exact inventory. A repeated successful upgrade is
a no-op.

Restart using the new source, verify Windows localhost health and reconnect the
phone helper. No APK rebuild or reinstall is required for this SQL change.
The launcher still fails closed for any other SQL inventory mismatch.

## Failure recovery and rollback

If interrupted after database commit but before inventory replacement, the old
inventory keeps the launcher stopped. Rerun the same explicit upgrade: it
reapplies the same function and writes the exact current inventory. Do not edit
the inventory by hand, delete the data directory, clear app data or uninstall.

Each successful invocation creates a private cursor-0025-recovery-* directory
inside the local data directory. It contains function-before.sql and
inventory-before.json. Preserve it. For a rollback, stop all backend processes
and other writers, preserve the whole data directory again, then a local
operator using this marked database's owner must apply function-before.sql in
a transaction and restore inventory-before.json as applied-inventory.json.
Restart only the matching OLD source. This deliberately restores the cursor bug,
so do not call sync accepted or use this as the normal running configuration.
The procedure does not erase tasks/sessions/receipts. Never run it against any
original or hosted database. No rollback happens automatically.

## Evidence limits

upgrade_cursor_smoke.py constructs the exact pre0025 source in a temporary
folder, starts a genuinely authenticated local backend, creates a task and
refreshes its session, stops it, runs the explicit upgrade twice, then restarts
current code. Account, password, signing key, saved session, task title and
row version survive. This is Linux local evidence only, not Windows/WSL or
Android persistence. The smoke also applies the preserved prior function and inventory, checks the exact
function definition, and restarts old source with account/session/task data retained.
This is not a standalone rollback tool and has not been run on Windows.
