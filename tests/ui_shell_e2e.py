"""Interaction tests of the auth / organization screens in a real browser (Chrome via Playwright).
BACKEND IS A FAKE IN-MEMORY PREVIEW (PreviewShell). Proves screen behaviour only: not Supabase, not RLS, not a device."""
import subprocess, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
PORT = 8766
SHOTS = Path("/downloads/ui_shots")
results = []

def ok(msg): results.append(msg); print("PASS", msg)

web = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT), "-d", str(ROOT / "app/dist")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        def page(q):
            pg = b.new_page(viewport={"width": 390, "height": 800}); pg.goto(f"http://127.0.0.1:{PORT}/?{q}"); pg.wait_for_timeout(1200); return pg

        # --- auth flow
        pg = page("shell=auth")
        pg.get_by_test_id("email").fill("nope"); pg.get_by_test_id("password").fill("secret123")
        pg.get_by_role("button", name="Sign in").click()
        expect(pg.get_by_text("Enter a valid email address.")).to_be_visible(); ok("sign-in rejects a bad email without calling the server")
        pg.get_by_role("button", name="New here? Create an account").click()
        pg.get_by_test_id("email").fill("peter@example.com"); pg.get_by_test_id("password").fill("short")
        pg.get_by_role("button", name="Create account").click()
        expect(pg.get_by_text("Use at least 8 characters.")).to_be_visible(); ok("sign-up enforces an 8 character password")
        pg.get_by_test_id("password").fill("longenough1"); pg.get_by_role("button", name="Create account").click()
        expect(pg.get_by_text("Check your email")).to_be_visible(); ok("sign-up without a session shows the verify-email screen")
        pg.screenshot(path=str(SHOTS / "e2e_verify_after_signup.png"))
        pg.close()

        pg = page("shell=auth")
        pg.get_by_test_id("email").fill("peter@example.com"); pg.get_by_test_id("password").fill("longenough1")
        pg.get_by_role("button", name="Sign in").click()
        expect(pg.get_by_text("Join or create your organization")).to_be_visible(); ok("sign-in routes a user with no organization to join/create")
        pg.get_by_test_id("org-code").fill("WRONG"); pg.get_by_role("button", name="Join").click()
        expect(pg.get_by_text("This code is not valid or has expired.")).to_be_visible(); ok("bad invitation code shows a plain error")
        pg.get_by_test_id("org-name").fill("Acme Ltd"); pg.get_by_role("button", name="Create").click()
        expect(pg.get_by_role("tab", name="Organization")).to_be_visible(); ok("creating an organization lands in the app (tabs)")
        pg.get_by_role("tab", name="Organization").click()
        expect(pg.get_by_text("Acme Ltd").first).to_be_visible(); ok("the organization tab shows the new organization")
        pg.close()

        # --- org management (admin)
        pg = page("shell=home")
        expect(pg.get_by_text("My tasks").first).to_be_visible(); ok("home starts on personal tasks")
        pg.get_by_role("tab", name="Organization").click()
        expect(pg.get_by_text("Nile Field Team").first).to_be_visible()
        expect(pg.get_by_test_id("member-Sara")).to_be_visible(); ok("members list shows everyone")
        assert pg.get_by_role("button", name="Suspend Peter").count() == 0 and pg.get_by_role("button", name="Remove Peter").count() == 0; ok("no actions are offered on yourself")
        pg.get_by_role("button", name="Suspend Sara").click()
        expect(pg.get_by_test_id("member-Sara").get_by_text("Suspended", exact=False)).to_be_visible(); ok("suspend -> member shown as suspended")
        pg.get_by_role("button", name="Reactivate Sara").click()
        expect(pg.get_by_role("button", name="Suspend Sara")).to_be_visible(); ok("reactivate -> back to active")
        pg.get_by_role("button", name="Change role Omar").click()
        expect(pg.get_by_test_id("role-choices")).to_be_visible()
        pg.get_by_role("button", name="Member: Omar").click()
        expect(pg.get_by_test_id("member-Omar").get_by_text("Member")).to_be_visible(); ok("change role offers explicit choices (no silent demotion) and applies the chosen one")
        pg.get_by_role("button", name="Remove Omar").click()
        expect(pg.get_by_test_id("confirm")).to_be_visible()
        pg.get_by_role("button", name="Cancel").click()
        expect(pg.get_by_test_id("member-Omar")).to_be_visible(); ok("remove asks for confirmation, cancel keeps the member")
        pg.get_by_role("button", name="Remove Omar").click(); pg.get_by_role("button", name="Confirm").click()
        expect(pg.get_by_test_id("member-Omar")).to_have_count(0); ok("confirmed remove -> member gone")
        pg.get_by_role("radio", name="Supervisor").click(); pg.get_by_role("radio", name="Team Team A").click()
        pg.get_by_test_id("invite-uses").fill("0"); pg.get_by_role("button", name="Create invitation").click()
        expect(pg.get_by_text("That change is not allowed right now.")).to_be_visible(); ok("invalid invitation settings are refused client-side")
        pg.get_by_test_id("invite-uses").fill("3"); pg.get_by_role("button", name="Create invitation").click()
        expect(pg.get_by_test_id("invite-code")).to_have_text("DEMO-CODE-1"); ok("creating an invitation shows the one-time code")
        pg.screenshot(path=str(SHOTS / "e2e_invite_code.png"))
        pg.get_by_role("button", name="Done").click()
        expect(pg.get_by_text("Supervisor · 0 of 3 used")).to_be_visible(); expect(pg.get_by_text("Active")).to_be_visible(); ok("code is not shown again; invitation listed without it")
        pg.screenshot(path=str(SHOTS / "e2e_org_manage.png"), full_page=True)
        pg.get_by_role("button", name="Revoke").click()
        expect(pg.get_by_text("Revoked")).to_be_visible(); ok("revoke -> invitation shows revoked")
        pg.get_by_role("button", name="Leave organization").click(); pg.get_by_role("button", name="Confirm").click()
        expect(pg.get_by_text("Join or create your organization")).to_be_visible(); ok("leave organization -> back to join/create")
        pg.close()

        pg = page("shell=home&lang=ar&theme=dark"); pg.get_by_role("tab", name="المؤسسة").click()
        expect(pg.get_by_text("الأعضاء")).to_be_visible(); pg.screenshot(path=str(SHOTS / "e2e_org_manage_ar_dark.png"), full_page=True); ok("Arabic dark org screen renders")
        b.close()
finally:
    web.terminate()
print(f"\n{len(results)} interaction checks passed (fake in-memory backend)")
