"""UI check of Sync details and recovery. REAL screen in headless Chrome (react-native-web), browser SQLite, real sync engine,
LOCAL test PostgreSQL through tests/bridge.py. Two browser contexts act as two devices of ONE user. Not Supabase, not a device."""
from __future__ import annotations

import subprocess
import sys
import time

from playwright.sync_api import sync_playwright

from ui_e2e import ROOT, SHOTS, sql, wait_for

BR, WEB = 8811, 8812


def main() -> None:
    import ui_e2e
    ui_e2e.BR = BR
    SHOTS.mkdir(exist_ok=True)
    bridge = subprocess.Popen([sys.executable, str(ROOT / "tests/bridge.py"), str(BR)], stdout=subprocess.PIPE, text=True)
    assert bridge.stdout and bridge.stdout.readline().startswith("READY")
    web = subprocess.Popen([sys.executable, "-m", "http.server", str(WEB), "-d", str(ROOT / "app/dist")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    results: list[str] = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            base = f"http://127.0.0.1:{WEB}/?bridge=http://127.0.0.1:{BR}&lang=en"
            errors: list[str] = []
            ctxa = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
            a = ctxa.new_page(); a.on("pageerror", lambda e: errors.append(str(e)))
            a.goto(base); a.get_by_test_id("new-task").wait_for()
            uid = a.evaluate("localStorage.getItem('tf_preview_uid')")
            ctxb = b.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
            ctxb.add_init_script(f"localStorage.setItem('tf_preview_uid', '{uid}')")
            d = ctxb.new_page(); d.on("pageerror", lambda e: errors.append(str(e)))
            d.goto(base); d.get_by_test_id("new-task").wait_for()

            chip = lambda pg: pg.get_by_test_id("sync-chip").inner_text()  # noqa: E731
            a.get_by_test_id("new-task").fill("Shared task"); a.get_by_role("button", name="Add", exact=True).click()
            wait_for(lambda: chip(a) == "All changes saved", "A synced")
            # B downloads it (reload = restart + pull)
            d.goto(base); d.get_by_text("Shared task").wait_for()
            results.append("device B received the task created on device A")

            # A goes offline and completes it; B deletes it meanwhile (online)
            a.get_by_test_id("offline-switch").click()
            a.get_by_test_id("toggle").first.click()
            wait_for(lambda: "Offline" in chip(a), "A offline chip")
            a.get_by_test_id("sync-chip-button").click()
            wait_for(lambda: "saved on this device" in a.get_by_test_id("sync-queued").inner_text(), "queued text")
            a.screenshot(path=str(SHOTS / "05_sync_panel_offline.png"))
            results.append("offline: panel says 1 change is saved on this device, not yet on the server")
            d.get_by_test_id("delete").first.click()
            wait_for(lambda: sql("select count(*) from app.personal_tasks where deleted_at is not null") == [[1]], "B delete on server")

            # A reconnects: the server (migration 0018) refuses to complete a deleted task; A is told why, nothing comes back
            a.get_by_test_id("offline-switch").click()
            wait_for(lambda: a.get_by_test_id("inbox-rejected").count() == 1, "rejected item in inbox", 20)
            txt = a.get_by_test_id("inbox-rejected").inner_text()
            assert "Shared task" in txt and "no longer exists" in txt, txt
            assert sql("select status, completed_at is null, deleted_at is not null from app.personal_tasks") == [["todo", True, True]]   # tombstone untouched
            assert "need your decision" in chip(a), chip(a)
            a.screenshot(path=str(SHOTS / "06_sync_panel_rejected.png"))
            results.append("reconnect: server refused the stale edit, inbox says why, tombstone unchanged, chip says decision needed")
            a.get_by_role("button", name="Discard change").click()
            wait_for(lambda: a.get_by_test_id("inbox-rejected").count() == 0, "discarded")
            wait_for(lambda: chip(a) == "All changes saved", "back to saved", 20)
            assert a.get_by_text("Shared task", exact=True).count() == 0, "deleted task must not reappear"
            results.append("discard: inbox clears, chip returns to 'All changes saved', deleted task did not reappear")
            assert not errors, errors
            b.close()
    finally:
        bridge.terminate()
        web.terminate()
    for r in results:
        print("OK  ", r)
    print(f"\n{len(results)} UI sync checks passed")


if __name__ == "__main__":
    main()
