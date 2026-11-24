"""Refuses to run hosted scripts against the production project. Every hosted script must call require_test_target()."""
import os, re, sys

PRODUCTION_REFS = {"utgqjzxfxhtrartcskbf"}   # TaskFlow production project: never a test target


def project_ref(text: str) -> str | None:
    m = re.search(r"(?:postgres\.|https?://)([a-z]{20})\b", text or "")
    return m.group(1) if m else None


def require_test_target(*identifiers: str, allowed_ref: str | None = None) -> str:
    refs = {r for r in (project_ref(i) for i in identifiers) if r}
    if not refs:
        raise SystemExit("target guard: no project reference found; refusing")
    if refs & PRODUCTION_REFS:
        raise SystemExit("target guard: PRODUCTION project reference detected; refusing")
    allowed = allowed_ref or os.environ.get("TASKFLOW_TEST_PROJECT_REF")
    if not allowed:
        raise SystemExit("target guard: set TASKFLOW_TEST_PROJECT_REF to the dedicated test project's ref")
    if refs != {allowed}:
        raise SystemExit("target guard: reference does not match the allowed test project; refusing")
    return allowed
