import React, { useEffect, useMemo } from 'react';
import { createAuthController, createSupabaseAuthApi } from '../auth/authController';
import { createShellApi } from '../shell/shellModel';
import { createSupabase } from '../supabase/client';
import { createSupabaseRpcClient } from '../supabase/rpcClient';
import { openAccountDb } from '../store/expoSqliteDriver';
import { createSqliteStore } from '../store/sqliteStore';
import type { Locale } from '../i18n';
import { Shell } from './Shell';

/** Device/hosted entry. Needs an explicit EXPO_PUBLIC_TASKFLOW_ENV (see supabase/config.ts). NOT run against any real Supabase yet. */
export function HostedApp({ locale }: { locale: Locale }) {
  const { sb, auth, api } = useMemo(() => {
    const sb = createSupabase();
    const rpc = createSupabaseRpcClient(sb);
    return { sb, auth: createAuthController(createSupabaseAuthApi(sb)), api: createShellApi((fn, args) => sb.schema('app_api').rpc(fn, args) as never, rpc) };
  }, []);
  useEffect(() => { void auth.start(); return () => auth.dispose(); }, [auth]);
  const makeStore = useMemo(() => {
    const rpc = createSupabaseRpcClient(sb);
    return (userId: string) => createSqliteStore(openAccountDb(userId), rpc);
  }, [sb]);
  return <Shell auth={auth} api={api} makeStore={makeStore} locale={locale} />;
}
