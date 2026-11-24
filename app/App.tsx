import { Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, useFonts } from '@expo-google-fonts/cairo';
import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ThemeProvider } from './src/design/ThemeContext';
import { darkTheme, lightTheme } from './src/design/tokens';
import type { Locale } from './src/i18n';
import { strings } from './src/i18n';
import { createMemoryStore } from './src/store/memoryStore';
import { createPreviewClient, previewCreateUser } from './src/store/previewHttpClient';
import { createSqliteStore } from './src/store/sqliteStore';
import { createSqlJsDriver } from './src/store/webSqlJsDriver';
import type { TaskStore } from './src/store/TaskStore';
import { PersonalTasksScreen } from './src/ui/PersonalTasksScreen';

/**
 * Web preview entry (the device build will construct the expo-sqlite store with the Supabase client instead).
 * ?bridge=http://127.0.0.1:PORT  -> PERSISTENT mode: sql.js SQLite in the browser + the real sync engine + local test Postgres.
 * no bridge                      -> in-memory demo data only.
 */
export default function App() {
  const [fontsLoaded] = useFonts({ Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold });
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const locale: Locale = q.get('lang') === 'ar' ? 'ar' : 'en';
  const theme = q.get('theme') === 'dark' ? darkTheme : lightTheme;
  const bridge = q.get('bridge');
  const [offline, setOffline] = useState(q.get('offline') === '1');
  const offlineRef = useMemo(() => ({ v: q.get('offline') === '1' }), []);
  offlineRef.v = offline;
  const [store, setStore] = useState<TaskStore | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!bridge) {
        setStore(createMemoryStore([
          { id: 'a', title: 'Prepare the weekly plan', done: false, pending: false },
          { id: 'b', title: 'مراجعة تقرير الموقع', done: true, pending: false },
        ]));
        return;
      }
      const initSqlJs = (await import('sql.js/dist/sql-wasm.js')).default as (c: object) => Promise<any>;
      const SQL = await initSqlJs({ locateFile: () => '/sql-wasm.wasm' });
      let uid = localStorage.getItem('tf_preview_uid');
      if (!uid) { uid = await previewCreateUser(bridge, `preview-${Date.now()}@local.test`); localStorage.setItem('tf_preview_uid', uid); }
      const db = createSqlJsDriver(SQL, `tf_${uid}`);
      const s = createSqliteStore(db, createPreviewClient(bridge, uid, () => offlineRef.v));
      (window as unknown as { __store: unknown }).__store = s;
      await s.sync();
      if (!cancelled) setStore(s);
    })().catch((e) => setErr(String(e)));
    return () => { cancelled = true; };
  }, [bridge, offlineRef]);

  // coming back online triggers a sync, like regaining connectivity on a device
  useEffect(() => { if (!offline && store && 'connectivityRestored' in store) void (store as unknown as { connectivityRestored(): Promise<void> }).connectivityRestored(); }, [offline, store]);

  if (!fontsLoaded || (!store && !err)) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator accessibilityLabel={strings(locale).loading} /></View>;
  if (err || !store) return <View style={{ padding: 24 }}>{null}</View>;
  return (
    <ThemeProvider value={theme}>
      <PersonalTasksScreen store={store} locale={locale} previewNote simulateOffline={bridge ? { value: offline, set: setOffline } : undefined} />
    </ThemeProvider>
  );
}
