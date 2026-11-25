# Credential-free Thursday source recovery

This guide applies to the NEW Thursday follow-up candidate, not the unchanged six-file delivery. The earlier recovery instructions remain in GIT-RECOVERY-DELIVERED-HISTORY.md. Do not use one package's branch/file names with another package's hashes.

The new TaskFlow-Thursday-History.bundle contains sanitized development history with two explicitly exported refs:

- delivery-baseline: sanitized original recovery snapshot.
- thursday-mvp: current Thursday follow-up, including personal-first/edit/offline session fixes and test/docs additions.

The original repository/full history remain untouched and are intentionally not included. Conventional original debug signing material and fixed dummy credentials were excluded before sanitized history creation. The actual next bundle is scanned across ALL stored objects, historical paths and metadata, not just HEAD. Pattern scanning cannot prove absence of every encoding.

If Git is installed, in PowerShell clone into a NEW folder, never an existing project:

    git clone --branch thursday-mvp .\TaskFlow-Thursday-History.bundle C:\TF-Thursday
    cd C:\TF-Thursday
    git status
    git log --all --oneline

The clone origin is the local bundle only. Do not add remotes/push to GitHub during setup. To inspect baseline without overwriting current work:

    git worktree add --detach C:\TF-Baseline delivery-baseline

The source ZIP is an alternative for opening/building without Git, not a restored original repository. Its root contains app, dev and supabase. Runtime ZIPs must be extracted INTO that root. Source-only files do not include binaries/wheels, accounts or task databases.

Check git status before each session. Preserve reviewed commits or a separate working-folder copy. Never stage dependency symlinks, node_modules, build output, .env.local, signing keys, private sessions/account data or logs. Do not use destructive reset/clean to repair setup. Do not clear app data/uninstall to fix signing errors. A source rollback does not roll back schemas or pending task data. The old baseline has weaker authorization and must not replace a running exposed service. Backend rollback requires stopped writers and its separately captured exact catalog recovery procedure; never target an original/hosted database.
