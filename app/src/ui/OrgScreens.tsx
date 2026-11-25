import React, { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../design/ThemeContext';
import { space } from '../design/tokens';
import { strings, type Locale } from '../i18n';
import { orgErrorKey, type Membership, type OrgErrorKey } from '../shell/shellModel';
import type { RpcResult } from '../sync/types';
import { ErrorLine, Field, Screen } from './AuthScreens';
import { Button, T } from './primitives';

export function OrgGateScreen({ locale, onCreate, onJoin, onSignOut }: {
  locale: Locale; onCreate: (name: string) => Promise<RpcResult>; onJoin: (code: string) => Promise<RpcResult>; onSignOut: () => void;
}) {
  const t = strings(locale);
  const th = useTheme();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<OrgErrorKey | null>(null);
  const run = async (f: () => Promise<RpcResult>) => {
    if (busy) return;
    setBusy(true); setErr(null);
    try { const r = await f(); if (!r.ok) setErr(orgErrorKey(r.code, r.message)); }
    catch { setErr('network'); }
    finally { setBusy(false); }
  };
  return (
    <Screen locale={locale}>
      <T variant="display" weight={700} accessibilityRole="header">{t.org.gateTitle}</T>
      <T color={th.textMuted}>{t.org.oneOrg}</T>
      <ErrorLine text={err ? t.org.errors[err] : null} />
      <View style={{ gap: space.md }}>
        <T variant="heading" weight={600}>{t.org.createTitle}</T>
        <Field label={t.org.orgName} value={name} onChange={setName} testID="org-name" />
        <Button label={t.org.create} onPress={() => void run(() => onCreate(name))} />
      </View>
      <View style={{ gap: space.md }}>
        <T variant="heading" weight={600}>{t.org.joinTitle}</T>
        <Field label={t.org.code} value={code} onChange={setCode} testID="org-code" />
        <Button label={t.org.join} kind="secondary" onPress={() => void run(() => onJoin(code))} />
      </View>
      <Button label={t.auth.signOut} kind="secondary" onPress={onSignOut} />
    </Screen>
  );
}

export function OrgHome({ locale, membership, email, onSignOut }: { locale: Locale; membership: Membership; email: string; onSignOut: () => void }) {
  const t = strings(locale);
  const th = useTheme();
  return (
    <Screen locale={locale}>
      <T variant="display" weight={700} accessibilityRole="header">{membership.org_name}</T>
      <T color={th.textMuted}>{t.org.yourRole}: {t.org.roles[membership.role]}</T>
      <T color={th.textMuted}>{email}</T>
      <Button label={t.auth.signOut} kind="secondary" onPress={onSignOut} />
    </Screen>
  );
}
