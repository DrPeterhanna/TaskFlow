# Credential-free Git recovery

The separate TaskFlow-development-history.bundle contains TWO sanitized source
checkpoints only. The original full history was deliberately omitted because it
contained a conventional debug private key/password and a dummy local JWT secret.
No original repository or approved branch was rewritten.

- delivery-baseline: sanitized recovery snapshot mapped to original
  563aa9901d01e6a91a0648a777cdec213d3c2083.
- windows-transition: sanitized current snapshot mapped to original
  9c227e000fafde523ace84959012c94c4f4eb99a, plus this export's signing/docs changes.

Both snapshots exclude the old debug signing material, use ephemeral test JWT
secrets, and build debug as app.taskflow.placeholder.windowsdev. Original hashes
are provenance mappings, not commits present in the sanitized history. Actual
sanitized commit hashes are recorded in DELIVERY-CHECKPOINTS.json.

In PowerShell, clone into a NEW folder, never an existing project:

    git clone --branch windows-transition .\TaskFlow-development-history.bundle C:\TF-Transition
    cd C:\TF-Transition
    git status
    git log --all --oneline

No GitHub remote is configured. The clone origin is only the bundle file. Do not
add GitHub remotes or push during setup. To inspect baseline without overwriting
work, use a separate checkout:

    git worktree add --detach C:\TF-Baseline delivery-baseline

Check git status before each session. Commit reviewed changes locally or copy the
working folder. Never commit generated keys, .env.local, account data or tokens.
Avoid destructive reset/clean and never clear app data to make a test pass.
Code rollback does not roll back backend schema; see its separate stopped-writer
recovery instructions. The old baseline has weaker authorization behavior.
