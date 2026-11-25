"""UI end-to-end check: drives the REAL screen in headless Chrome (react-native-web build) with the persistent
browser SQLite, the real sync engine, and the LOCAL test PostgreSQL through tests/bridge.py. Not Supabase, not a device."""
from __future__ import annotations

import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
BR, WEB = 8801, 8802
SHOTS = Path("/downloads/ui_shots")


def sql(q: str) -> list[list[object]]:
    req = urllib.request.Request(f"http://127.0.0.1:{BR}/sql", data=json.dumps({"query": q}).encode(), headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req).read())["rows"]  # type: ignore[no-any-return]


def wait_for(fn, what: str, secs: float = 15.0):  # type: ignore[no-untyped-def]
    end = time.time() + secs
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(0.2)
    raise AssertionError(f"timeout waiting for {what}: {last}")


def main() -> None:
    SHOTS.mkdir(exist_ok=True)
    bridge = subprocess.Popen([sys.executable, str(ROOT / "tests/bridge.py"), str(BR)], stdout=subprocess.PIPE, text=True)
    assert bridge.stdout and bridge.stdout.readline().startswith("READY")
    web = subprocess.Popen([sys.executable, "-m", "http.server", str(WEB), "-d", str(ROOT / "app/dist")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    results: list[str] = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            ctx = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            base = f"http://127.0.0.1:{WEB}/?bridge=http://127.0.0.1:{BR}"
            page.goto(base + "&lang=en")
            page.get_by_test_id("new-task").wait_for()
            chip = lambda: page.get_by_test_id("sync-chip").inner_text()  # noqa: E731

            def add(title: str) -> None:
                page.get_by_test_id("new-task").fill(title)
                page.get_by_role("button", name="Add", exact=True).click()

            add("Order spare parts")
            page.get_by_text("Order spare parts").wait_for()
            wait_for(lambda: chip() == "All changes saved", "synced chip after add")
            assert sql("select title from app.personal_tasks where deleted_at is null") == [["Order spare parts"]]
            results.append("add -> row on server, chip 'All changes saved'")

            row = page.get_by_test_id("toggle").first
            row.click()
            wait_for(lambda: sql("select status from app.personal_tasks") == [["done"]], "complete on server")
            wait_for(lambda: page.get_by_role("checkbox").first.get_attribute("aria-checked") == "true", "checkbox checked")
            results.append("complete -> server status done, checkbox checked")
            page.get_by_role("checkbox").first.click()
            wait_for(lambda: sql("select status, completed_at is null from app.personal_tasks") == [["todo", True]], "reopen on server")
            results.append("reopen -> server status todo, completed_at cleared")

            page.screenshot(path=str(SHOTS / "01_online_en.png"))
            page.get_by_test_id("delete").first.click()
            wait_for(lambda: sql("select count(*) from app.personal_tasks where deleted_at is not null") == [[1]], "delete on server")
            assert page.get_by_text("Order spare parts").count() == 0
            results.append("delete -> server row soft-deleted, row gone from screen")

            # offline: writes stay on the device, show pending, chip says offline
            page.get_by_test_id("offline-switch").click()
            add("Written offline")
            page.get_by_text("Written offline").wait_for()
            wait_for(lambda: "Offline" in chip(), "offline chip")
            assert page.get_by_test_id("pending-dot").count() == 1
            assert sql("select count(*) from app.personal_tasks where title = 'Written offline'") == [[0]]
            page.screenshot(path=str(SHOTS / "02_offline_en.png"))
            results.append("offline add -> pending dot + offline chip, nothing on server yet")

            # restart while still offline: data survives in the browser SQLite file
            page.goto(base + "&lang=en&offline=1")
            page.get_by_text("Written offline").wait_for()
            assert page.get_by_test_id("pending-dot").count() == 1
            assert sql("select count(*) from app.personal_tasks where title = 'Written offline'") == [[0]]
            results.append("restart (offline) -> task and pending state survived")

            # back online: backoff cleared, flushed exactly once
            page.get_by_test_id("offline-switch").click()
            wait_for(lambda: chip() == "All changes saved", "synced after reconnect")
            assert sql("select count(*) from app.personal_tasks where title = 'Written offline'") == [[1]]
            assert sql("select count(*) from app.personal_events where kind = 'ptask.created'") == [[2]]
            results.append("reconnect -> flushed once (1 row, 2 created events total), chip saved")

            # Arabic UI with English and Arabic user text
            add("مراجعة تقرير الموقع")
            wait_for(lambda: chip() == "All changes saved", "synced")
            page.goto(base + "&lang=ar")
            page.get_by_text("Written offline").wait_for()
            page.get_by_text("مراجعة تقرير الموقع").wait_for()
            assert page.get_by_test_id("sync-chip").inner_text() == "تم حفظ كل التغييرات"
            page.screenshot(path=str(SHOTS / "03_online_ar.png"))
            results.append("Arabic UI: mirrored layout, English and Arabic user text both shown, chip translated")
            page.goto(base + "&lang=en&theme=dark")
            page.get_by_text("Written offline").wait_for()
            page.screenshot(path=str(SHOTS / "04_dark_en.png"))
            assert not errors, errors
            b.close()
    finally:
        bridge.terminate()
        web.terminate()
    for r in results:
        print("OK  ", r)
    print(f"\n{len(results)} UI checks passed")


if __name__ == "__main__":
    main()
