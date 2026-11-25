/** Explicit disposable-backend debug build. Never selects a hosted project. */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const android = path.join(app, 'android');
// Metro and Gradle do not consistently include EXPO_PUBLIC_* changes in their cache keys.
// Drop only generated JS outputs so an old target cannot silently survive a rebuild.
for (const dir of ['assets', 'resources', 'sourcemaps']) {
  rmSync(path.join(android, 'app', 'build', 'generated', dir, 'react', 'debug'), { recursive: true, force: true });
}
const env = { ...process.env, EXPO_PUBLIC_TASKFLOW_ENV: 'local', EXPO_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', EXPO_PUBLIC_SUPABASE_KEY: 'taskflow-local-development-only', EXPO_PUBLIC_TEST_PROJECT_REF: '', EXPO_PUBLIC_ALLOW_PRODUCTION: '' };
const args = [':app:assembleDebug', '--no-daemon', '--max-workers=1', '-Dorg.gradle.jvmargs=-Xmx1300m -XX:MaxMetaspaceSize=384m -XX:+UseParallelGC', '-Pkotlin.compiler.execution.strategy=in-process', '-Pkotlin.incremental=false', '--build-cache'];
const result = process.platform === 'win32'
  ? spawnSync('cmd.exe', ['/d', '/c', 'gradlew.bat', ...args], { cwd: android, env, stdio: 'inherit' })
  : spawnSync('bash', ['./gradlew', ...args], { cwd: android, env, stdio: 'inherit' });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
