"""Run the suite. Usage: python tests/run.py [--migrations DIR] [test names...]"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import harness  # noqa: E402
import test_phase2  # noqa: E402,F401


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--migrations", default=str(harness.ROOT / "supabase/migrations"))
    ap.add_argument("names", nargs="*")
    ns = ap.parse_args()
    res = harness.run_all(Path(ns.migrations), ns.names or None)
    failed = {k: v for k, v in res.items() if v != "pass"}
    for k, v in res.items():
        print(f"{'PASS' if v == 'pass' else 'FAIL'}  {k}" + ("" if v == "pass" else f"  -> {v}"))
    print(f"\n{len(res) - len(failed)} passed, {len(failed)} failed, {len(res)} total")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
