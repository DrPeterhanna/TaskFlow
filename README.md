# TaskFlow 2.0 (greenfield)

New project. Nothing inherited from any earlier codebase. Architecture: see the approved
proposal (12 documents). Current state: Phase 2 (database, auth, permissions, hierarchy,
offline and audit foundations). No application code, no deployment, no paid services.

## Layout
- `supabase/migrations/` ordered, forward-only SQL migrations 0001 to 0008.
- `tests/` real-PostgreSQL test suite (`python tests/run.py`), harness and a TEST-ONLY Supabase shim.
- `scripts/mutate.py` mutation testing of critical invariants.
- `docs/PHASE2_REPORT.md` what was built, tests actually run, limits.

## Run
`pip install pgserver psycopg2-binary ruff mypy`, then `python tests/run.py`, `python scripts/mutate.py`,
`ruff check tests scripts`, `mypy tests scripts`.

Local PostgreSQL (pgserver, PG 16-class build without pgcrypto) is NOT Supabase. Hosted verification is still required.
