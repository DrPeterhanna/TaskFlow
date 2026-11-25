"""Browser SQLite + LOCAL PostgreSQL shim bridge. Not native, Supabase, or Auth acceptance."""
import subprocess
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
import ui_e2e as u

ROOT = Path(__file__).resolve().parent.parent

def main():
    bridge = subprocess.Popen([sys.executable, str(ROOT/'tests/bridge.py'), '8801'], stdout=subprocess.PIPE, text=True)
    assert bridge.stdout.readline().startswith('READY')
    log = open('/tmp/taskflow-title-web.log', 'w')
    web = subprocess.Popen([sys.executable, '-m', 'http.server', '8802', '--directory', str(ROOT/'app/dist')], stdout=log, stderr=subprocess.STDOUT)
    checks = []
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
            ctx = b.new_context(viewport={'width':390,'height':844})
            page = ctx.new_page()
            url = 'http://127.0.0.1:8802/?bridge=http://127.0.0.1:8801&lang=en'
            page.goto(url)
            page.get_by_test_id('new-task').fill('Before edit')
            page.get_by_role('button', name='Add', exact=True).click()
            u.wait_for(lambda:u.sql('select title from app.personal_tasks') == [['Before edit']], 'created')
            page.get_by_test_id('offline-switch').click()
            page.get_by_role('button', name='Edit Before edit', exact=True).click()
            page.get_by_test_id('edit-task-title').fill('Edited while disconnected')
            page.get_by_role('button', name='Save', exact=True).click()
            expect(page.get_by_text('Edited while disconnected', exact=True)).to_be_visible()
            assert u.sql('select title from app.personal_tasks') == [['Before edit']]
            checks.append('offline edit changes local row only')
            page.goto(url+'&offline=1')
            expect(page.get_by_text('Edited while disconnected', exact=True)).to_be_visible()
            checks.append('title and queued edit survive reload offline')
            page.get_by_test_id('offline-switch').click()
            u.wait_for(lambda:u.sql('select title from app.personal_tasks') == [['Edited while disconnected']], 'synced edit')
            u.wait_for(lambda:page.get_by_test_id('sync-chip').inner_text() == 'All changes saved', 'saved')
            checks.append('reconnect automatically sends checked edit')
            # A second browser context changes the title while this editor keeps an old draft.
            uid = page.evaluate("localStorage.getItem('tf_preview_uid')")
            other = b.new_context(viewport={'width':390,'height':844})
            other.add_init_script('localStorage.setItem("tf_preview_uid", '+__import__('json').dumps(uid)+')')
            q = other.new_page(); q.goto(url)
            page.get_by_role('button',name='Edit Edited while disconnected',exact=True).click()
            page.get_by_test_id('edit-task-title').fill('Draft based on older value')
            q.get_by_role('button',name='Edit Edited while disconnected',exact=True).click()
            q.get_by_test_id('edit-task-title').fill('Other context changed it')
            q.get_by_role('button',name='Save',exact=True).click()
            u.wait_for(lambda:u.sql('select title from app.personal_tasks') == [['Other context changed it']], 'other edit')
            page.evaluate('window.__store.sync()')
            expect(page.get_by_text('Other context changed it',exact=True)).to_be_visible()
            page.get_by_role('button',name='Save',exact=True).click()
            expect(page.get_by_test_id('edit-task-title')).to_have_value('Draft based on older value')
            expect(page.get_by_text('Edit was not saved.',exact=False)).to_be_visible()
            assert u.sql('select title from app.personal_tasks') == [['Other context changed it']]
            checks.append('stale editor refuses unseen title change and retains draft')
            page.screenshot(path='/downloads/offline-sync-evidence/mvp-stale-editor.png')
            b.close()
    finally:
        bridge.terminate(); bridge.wait(); web.terminate(); web.wait(); log.close()
    for check in checks: print('PASS', check)
    print(len(checks), 'browser title-edit checks passed')

if __name__ == '__main__': main()
