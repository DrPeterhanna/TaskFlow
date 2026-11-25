// Portable unit-test tier. Integration/Python and POSIX signal tests stay separate.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const excluded = new Set(['e2e_checked_mutations.test.ts','e2e_local_postgres.test.ts','e2e_real_auth.test.ts','e2e_sync_recovery.test.ts','store.test.ts','crashCheckpoints.test.ts','restart.test.ts']);
const tests = readdirSync('test').filter(n => n.endsWith('.test.ts') && !excluded.has(n)).map(n => 'test/' + n);
const result = spawnSync(process.execPath, ['--experimental-sqlite','--no-warnings','./node_modules/vitest/vitest.mjs','run',...tests], { stdio: 'inherit' });
process.exit(result.status ?? 1);
