"""Prepare a NEW disposable local Supabase workdir. Does not start services or connect to any DB."""
import argparse
from pathlib import Path
import shutil
import hashlib
import json

ROOT = Path(__file__).resolve().parents[2]
CONFIG = '''project_id = "taskflow-android-disposable"

[api]
enabled = true
port = 54321
schemas = ["public", "app_api"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 54322
shadow_port = 54320
major_version = 17

[db.seed]
enabled = false

[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
enable_signup = true

[auth.email]
enabled = true
enable_confirmations = true
'''

def prepare(destination):
    dest = Path(destination).expanduser().resolve()
    # Never overwrite an existing directory or mutate a repository/Supabase project.
    if dest.exists():
        raise SystemExit('Refusing existing destination. Choose a new empty disposable path.')
    entries = (ROOT / 'dev/local-backend/manifest.txt').read_text().splitlines()
    if len(entries) != 22 or len(set(entries)) != 22 or any(Path(n).name != n or n.startswith(('0014_', '0015_')) for n in entries):
        raise SystemExit('Unexpected manifest; refusing preparation.')
    sources = [ROOT / 'supabase/migrations' / name for name in entries]
    sources.append(ROOT / 'dev/local-backend/0015_my_membership_baseline.sql')
    if any(not path.is_file() for path in sources):
        raise SystemExit('Missing manifest source.')
    migrations = dest / 'supabase/migrations'
    migrations.mkdir(parents=True)
    inventory = []
    for source in sorted(sources, key=lambda p: p.name):
        shutil.copyfile(source, migrations / source.name)
        inventory.append({'file': source.name, 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
    (dest / 'supabase/config.toml').write_text(CONFIG)
    (dest / 'TASKFLOW_DISPOSABLE_ONLY.txt').write_text('New local development stack only. Held account-lifecycle migration 0014 is excluded. No hosted link, no seed accounts, no automatic reset.\n')
    (dest / 'migration-inventory.json').write_text(json.dumps(inventory, indent=2) + '\n')
    print('Prepared', dest)
    print('23 SQL files: 22 explicit originals + local read-only membership compatibility RPC.')
    print('No services started, no accounts created, no database contacted. Validate config before starting.')
    return dest

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('destination', help='New path that must not already exist')
    prepare(parser.parse_args().destination)
