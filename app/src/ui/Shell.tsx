import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import type { AuthController } from '../auth/authController';
import { useTheme } from '../design/ThemeContext';
import { minTouch, space } from '../design/tokens';
import { strings, type Locale } from '../i18n';
import { routeFor, type createShellApi, type Me, type ShellError } from '../shell/shellModel';
import type { TaskStore } from '../store/TaskStore';
import { AuthScreen, Screen } from './AuthScreens';
import { OrgGateScreen } from './OrgScreens';
import { OrgManage } from './OrgManage';
import type { OrgAdminApi } from '../shell/orgAdmin';
import { PersonalTasksScreen } from './PersonalTasksScreen';
import { Button, T } from './primitives';

type Api = ReturnType<typeof createShellApi>;

/** Signed-in navigation: auth -> verify email -> join/create organization -> tabs. The route is derived, never stored. */
export function Shell({ auth, api, makeStore, locale, adminApi }: { auth: AuthController; api: Api; adminApi: OrgAdminApi; makeStore: (userId: string) => TaskStore; locale: Locale }) {
  const a = useSyncExternalStore(auth.subscribe, auth.getState);
  const t = strings(locale);
  const th = useTheme();
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<ShellError | null>(null);
  const [tab, setTab] = useState<'tasks' | 'org'>('tasks');
  const [store, setStore] = useState<TaskStore | null>(null);
  const uid = a.session?.userId ?? null;

  const refresh = useCallback(async () => {
    setErr(null);
    const r = await api.me();
    if (r.ok) setMe(r.me); else setErr(r.error);
  }, [api]);
  // identity change (sign-out, different user) drops every piece of the previous user's state
  useEffect(() => { setMe(null); setErr(null); setStore(null); setTab('tasks'); if (uid) void refresh(); }, [uid, refresh]);
  useEffect(() => { if (uid) setStore(makeStore(uid)); }, [uid, makeStore]);

  const route = routeFor(a.phase, me, err);
  if (route === 'loading') return <Screen locale={locale}><ActivityIndicator accessibilityLabel={t.loading} /></Screen>;
  if (route === 'auth') return <AuthScreen auth={auth} locale={locale} />;
  if (route === 'error') return <Screen locale={locale}><T>{t.org.loadError}</T><Button label={t.org.retry} onPress={() => void refresh()} />
    <Button label={t.auth.signOut} kind="secondary" onPress={() => void auth.signOut()} /></Screen>;
  if (route === 'verify') return <Screen locale={locale}><T variant="display" weight={700} accessibilityRole="header">{t.auth.verifyTitle}</T>
    <T>{t.auth.verifyBody(a.session?.email ?? '')}</T><Button label={t.auth.checked} onPress={() => void refresh()} />
    <Button label={t.auth.signOut} kind="secondary" onPress={() => void auth.signOut()} /></Screen>;
  if (route === 'join_or_create') return (
    <OrgGateScreen locale={locale} onSignOut={() => void auth.signOut()}
      onCreate={async (n) => { const r = await api.createOrg(n, Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo'); if (r.ok) await refresh(); return r; }}
      onJoin={async (c) => { const r = await api.joinOrg(c); if (r.ok) await refresh(); return r; }} />);
  const m = me!.membership!;
  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ flex: 1 }}>
        {tab === 'tasks' && store ? <PersonalTasksScreen store={store} locale={locale} />
          : <OrgManage locale={locale} membership={m} email={a.session?.email ?? ''} api={adminApi} onSignOut={() => void auth.signOut()} onLeft={() => void refresh()} />}
      </View>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: th.border, backgroundColor: th.surface }}>
        {([['tasks', t.org.tabTasks], ['org', t.org.tabOrg]] as const).map(([k, label]) => (
          <Pressable key={k} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} accessibilityLabel={label} onPress={() => setTab(k)}
            style={{ flex: 1, minHeight: minTouch + space.md, alignItems: 'center', justifyContent: 'center', borderTopWidth: 3, borderColor: tab === k ? th.primary : 'transparent' }}>
            <T weight={tab === k ? 700 : 500} color={tab === k ? th.primary : th.textMuted}>{label}</T>
          </Pressable>))}
      </View>
    </View>
  );
}
