import { AppState } from 'react-native';
import { accountBoundRpc } from '../store/accountLifecycle';
import React, { useEffect, useMemo } from 'react';
import { createAuthController, createSupabaseAuthApi } from '../auth/authController';
import { createOrgAdminApi } from '../shell/orgAdmin';
import { createOrgTasksApi } from '../shell/orgTasks';
import { createShellApi } from '../shell/shellModel';
import { createSupabase, createAccountSupabase, configuredEnvironment } from '../supabase/client';
import { createSupabaseRpcClient } from '../supabase/rpcClient';
import { openAccountDb } from '../store/expoSqliteDriver';
import { createSqliteStore } from '../store/sqliteStore';
import type { Locale } from '../i18n';
import { Shell } from './Shell';

/** Device/hosted entry. Needs an explicit EXPO_PUBLIC_TASKFLOW_ENV (see supabase/config.ts). NOT run against any real Supabase yet. */
export function HostedApp({ locale }: { locale: Locale }) {
  const { sb, auth, api, adminApi, tasksApi } = useMemo(() => {
    const sb = createSupabase();
    const rpc = createSupabaseRpcClient(sb);
    const read = (fn: string, args: Record<string, unknown>) => sb.schema('app_api').rpc(fn, args) as never;
    return { sb, adminApi: createOrgAdminApi(read, rpc), tasksApi: createOrgTasksApi(read, rpc), auth: createAuthController(createSupabaseAuthApi(sb)), api: createShellApi((fn, args) => sb.schema('app_api').rpc(fn, args) as never, rpc) };
  }, []);
  useEffect(() => { void auth.start(); const sub = AppState.addEventListener('change', s => { if (s === 'active') sb.auth.startAutoRefresh(); else sb.auth.stopAutoRefresh(); }); return () => { sub.remove(); auth.dispose(); }; }, [auth, sb]);
  const makeStore = useMemo(() => {
    return (userId: string) => {
      const bound = accountBoundRpc(createSupabaseRpcClient(createAccountSupabase(sb, userId)), userId, () => auth.getState().session?.userId ?? null);
      const stop = auth.subscribe(() => { if (auth.getState().session?.userId !== userId) bound.dispose(); });
      try { return createSqliteStore(openAccountDb(userId, configuredEnvironment().url!), bound, { closeOnDispose: true, onDispose: () => { stop(); bound.dispose(); } }); }
      catch (e) { stop(); bound.dispose(); throw e; }
    };
  }, [sb, auth]);
  return <Shell auth={auth} api={api} adminApi={adminApi} tasksApi={tasksApi} makeStore={makeStore} locale={locale} />;
}

