/** Explicit environment selection. No default target: a missing or inconsistent selection throws. Pure, testable. */
export type TfEnv = 'local' | 'test' | 'production';
export interface RawEnv { name?: string; url?: string; key?: string; testRef?: string; allowProd?: string }

// Production project ref is a public identifier; it is blocked unless the build is explicitly named production.
export const PRODUCTION_REF = 'utgqjzxfxhtrartcskbf';

export function resolveSupabaseConfig(e: RawEnv): { env: TfEnv; url: string; key: string } {
  if (e.name !== 'local' && e.name !== 'test' && e.name !== 'production')
    throw new Error('EXPO_PUBLIC_TASKFLOW_ENV must be set to local, test or production (no default)');
  if (!e.url || !e.key) throw new Error('Supabase URL and publishable key are required');
  if (/^sb_secret_|service_role/.test(e.key)) throw new Error('A secret key must never be used in the app');
  const ref = /^https:\/\/([a-z0-9]+)\.supabase\.co/.exec(e.url)?.[1];
  const isProdUrl = ref === PRODUCTION_REF;
  if (e.name === 'production') {
    if (!isProdUrl) throw new Error('production env requires the production project URL');
    if (e.allowProd !== 'yes-i-mean-production') throw new Error('production requires EXPO_PUBLIC_ALLOW_PRODUCTION=yes-i-mean-production');
  } else {
    if (isProdUrl) throw new Error(`${e.name} build must not target the production project`);
    if (e.name === 'test' && (!ref || ref !== e.testRef)) throw new Error('test env requires EXPO_PUBLIC_TEST_PROJECT_REF matching the URL');
    if (e.name === 'local' && !/^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)/.test(e.url)) throw new Error('local env requires a localhost URL');
  }
  return { env: e.name, url: e.url, key: e.key };
}
