import React, { useCallback, useEffect, useState, useRef, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Pressable, View } from 'react-native';
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

/** Signed-in navigation: auth -> verify email -> personal-first tabs. Organization onboarding is optional. The route is derived, never stored. */
export function Shell({ auth, api, makeStore, locale, adminApi }: { auth: AuthController; api: Api; adminApi: OrgAdminApi; makeStore: (userId: string) => TaskStore; locale: Locale }) {
  const a = useSyncExternalStore(auth.subscribe, auth.getState);
  const t = strings(locale);
  const th = useTheme();
  const [meEntry, setMeEntry] = useState<{ owner: string | null; me: Me } | null>(null);
  const [err, setErr] = useState<ShellError | null>(null);
  const [tab, setTab] = useState<'tasks' | 'org'>('tasks');
  const [storageFailed, setStorageFailed] = useState(false);
  const [storeEntry, setStoreEntry] = useState<{owner: string; store: TaskStore} | null>(null);
  const uid = a.session?.userId ?? null;
  const me = meEntry?.owner === uid ? meEntry.me : null;
  const store = storeEntry?.owner === uid ? storeEntry.store : null;

  const currentUid = useRef(uid); currentUid.current = uid;
  const refresh = useCallback(async () => {
    setErr(null);
    const forUid = currentUid.current;
    const r = await api.me();
    if (currentUid.current !== forUid) return;
    if (r.ok) setMeEntry({owner: forUid, me: r.me}); else setErr(r.error);
  }, [api]);
  // identity change (sign-out, different user) drops every piece of the previous user's state
  useEffect(() => { setMeEntry(null); setErr(null); setStoreEntry(null); setTab('tasks'); if (uid) void refresh(); }, [uid, refresh]);
  useEffect(() => { if (!uid) return; setStorageFailed(false); try { const s = makeStore(uid); setStoreEntry({ owner: uid, store: s }); return () => s.dispose?.(); } catch { setStorageFailed(true); } }, [uid, makeStore]);
  useEffect(() => { if (store && uid) { store.retryNow?.(); void refresh(); } }, [a.session, store, uid, refresh]);
  useEffect(() => {
    if (!store) return;
    const resume = () => { void store.connectivityRestored?.(); };
    const sub = AppState.addEventListener('change', s => { if (s === 'active') resume(); });
    // No native network module required. Foreground-only safety check catches reconnects within one minute.
    const interval = setInterval(() => { if (AppState.currentState === 'active') void store.sync?.(); }, 60_000);
    return () => { sub.remove(); clearInterval(interval); };
  }, [store]);

  if (storageFailed && uid) return <Screen locale={locale}><T>{locale === 'ar' ? 'تعذر فتح التخزين المحلي. لم يتم حذف البيانات. أعد تشغيل التطبيق أو اطلب المساعدة.' : 'Cannot open local storage. No data was deleted. Restart the app or ask for help.'}</T><Button label={t.auth.signOut} onPress={() => void auth.signOut().catch(() => undefined)} /></Screen>;
  const route = routeFor(a.phase, me, err);
  if (a.phase === 'signedIn' && a.session?.localOnly && store) return <Screen locale={locale}><PersonalTasksScreen store={store} locale={locale} /><T>{locale === 'ar' ? 'مساحة محلية فقط. ستعود المزامنة بعد تجديد الجلسة عند الاتصال.' : 'Local workspace only. Sync resumes after the session refreshes online.'}</T><Button label={t.org.retry} onPress={() => void refresh()} /><Button label={t.auth.signOut} onPress={() => void auth.signOut().catch(() => undefined)} /></Screen>;
  if (route === 'loading' && a.phase === 'signedIn' && store) return <Screen locale={locale}><PersonalTasksScreen store={store} locale={locale} /><Button label={t.org.retry} onPress={() => void refresh()} /><Button label={t.auth.signOut} onPress={() => void auth.signOut().catch(() => undefined)} /></Screen>;
  if (route === 'loading') return <Screen locale={locale}><ActivityIndicator accessibilityLabel={t.loading} /></Screen>;
  if (route === 'auth') return <AuthScreen auth={auth} locale={locale} />;
  // Personal cache remains usable when membership cannot be fetched offline. No cached org authority is inferred.
  if (route === 'error' && err === 'network' && store) return <Screen locale={locale}><PersonalTasksScreen store={store} locale={locale} /><Button label={t.org.retry} onPress={() => void refresh()} /><Button label={t.auth.signOut} onPress={() => void auth.signOut().catch(() => undefined)} /></Screen>;
  if (route === 'error') return <Screen locale={locale}><T>{t.org.loadError}</T><Button label={t.org.retry} onPress={() => void refresh()} />
    <Button label={t.auth.signOut} kind="secondary" onPress={() => void auth.signOut().catch(() => undefined)} /></Screen>;
  if (route === 'verify') return <Screen locale={locale}><T variant="display" weight={700} accessibilityRole="header">{t.auth.verifyTitle}</T>
    <T>{t.auth.verifyBody(a.session?.email ?? '')}</T><Button label={t.auth.checked} onPress={() => void refresh()} />
    <Button label={t.auth.signOut} kind="secondary" onPress={() => void auth.signOut().catch(() => undefined)} /></Screen>;
  if (route === 'join_or_create') return (
    <OrgGateScreen locale={locale} onSignOut={() => void auth.signOut().catch(() => undefined)}
      onCreate={async (n) => { const r = await api.createOrg(n, Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo'); if (r.ok) await refresh(); return r; }}
      onJoin={async (c) => { const r = await api.joinOrg(c); if (r.ok) await refresh(); return r; }} />);
  const m = me!.membership ?? null;
  return (
    <View style={{ flex: 1, backgroundColor: th.bg }}>
      <View style={{ flex: 1 }}>
        {tab === 'tasks' && store ? <PersonalTasksScreen store={store} locale={locale} />
          : m ? <OrgManage locale={locale} membership={m} email={a.session?.email ?? ''} api={adminApi} onSignOut={() => void auth.signOut().catch(() => undefined)} onLeft={() => void refresh()} />
          : <OrgGateScreen locale={locale} onSignOut={() => void auth.signOut().catch(() => undefined)}
              onCreate={async n => { const r = await api.createOrg(n, Intl.DateTimeFormat().resolvedOptions().timeZone || 'Africa/Cairo'); if (r.ok) await refresh(); return r; }}
              onJoin={async c => { const r = await api.joinOrg(c); if (r.ok) await refresh(); return r; }} />}
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
