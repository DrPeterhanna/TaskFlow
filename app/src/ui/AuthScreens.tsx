import React, { useState, useSyncExternalStore } from 'react';
import { SafeAreaView, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { authErrorMessage } from '../auth/errorMessage';
import type { AuthController } from '../auth/authController';
import { useTheme } from '../design/ThemeContext';
import { fontFamily, minTouch, radius, space, type } from '../design/tokens';
import { isRtl, strings, type Locale } from '../i18n';
import { Button, T } from './primitives';

export function Field({ label, value, onChange, secure, hint, testID, keyboard }: {
  label: string; value: string; onChange: (v: string) => void; secure?: boolean; hint?: string; testID: string; keyboard?: 'email-address' | 'default';
}) {
  const th = useTheme();
  return (
    <View style={{ gap: space.xs }}>
      <T weight={600}>{label}</T>
      <TextInput value={value} onChangeText={onChange} secureTextEntry={secure} accessibilityLabel={label} testID={testID}
        autoCapitalize="none" autoCorrect={false} keyboardType={keyboard ?? 'default'} textContentType={secure ? 'password' : keyboard === 'email-address' ? 'emailAddress' : 'none'}
        placeholderTextColor={th.textMuted}
        style={[s.input, { backgroundColor: th.surface, borderColor: th.borderStrong, color: th.text, fontFamily: fontFamily[400], fontSize: type.body.size }]} />
      {hint ? <T variant="caption" color={th.textMuted}>{hint}</T> : null}
    </View>
  );
}

export function ErrorLine({ text, testID }: { text: string | null; testID?: string }) {
  const th = useTheme();
  if (!text) return null;
  return <View style={[s.err, { backgroundColor: th.dangerBg }]} accessibilityLiveRegion="assertive" testID={testID ?? 'error'}><T color={th.danger} weight={500}>{text}</T></View>;
}

export function Screen({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const th = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: th.bg, direction: isRtl(locale) ? 'rtl' : 'ltr' } as object}>
      <ScrollView contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">{children}</ScrollView>
    </SafeAreaView>
  );
}

export function AuthScreen({ auth, locale }: { auth: AuthController; locale: Locale }) {
  const st = useSyncExternalStore(auth.subscribe, auth.getState);
  const t = strings(locale).auth;
  const errorText = authErrorMessage(st.error,locale,{name:process.env.EXPO_PUBLIC_TASKFLOW_ENV,url:process.env.EXPO_PUBLIC_SUPABASE_URL});
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const th = useTheme();
  const go = () => (mode === 'in' ? auth.signIn(email, pw) : auth.signUp(email, pw));
  if (st.verifyEmail && (st.notice === 'verification_sent' || st.error === 'email_not_verified')) {
    return (
      <Screen locale={locale}>
        <T variant="display" weight={700} accessibilityRole="header">{t.verifyTitle}</T>
        <T>{t.verifyBody(st.verifyEmail)}</T>
        {st.notice ? <T color={th.success} weight={600}>{t.sent}</T> : null}
        <ErrorLine text={errorText} />
        <Button label={t.resend} kind="secondary" onPress={() => void auth.resend()} />
        <Button label={t.signIn} onPress={() => { auth.clearError(); void auth.signIn(st.verifyEmail ?? email, pw); }} accessibilityLabel={strings(locale).auth.checked} />
      </Screen>
    );
  }
  return (
    <Screen locale={locale}>
      <T variant="display" weight={700} accessibilityRole="header">{mode === 'in' ? t.signInTitle : t.signUpTitle}</T>
      <Field label={t.email} value={email} onChange={setEmail} keyboard="email-address" testID="email" />
      <Field label={t.password} value={pw} onChange={setPw} secure testID="password" hint={mode === 'up' ? t.hintPassword : undefined} />
      <ErrorLine text={errorText} />
      {st.error === 'local_logout_failed' ? <Button label={t.signOut} kind="secondary" onPress={() => void auth.signOut().catch(() => undefined)} /> : null}
      <Button label={mode === 'in' ? t.signIn : t.signUp} onPress={() => void go()} />
      <Button label={mode === 'in' ? t.toSignUp : t.toSignIn} kind="secondary" onPress={() => { auth.clearError(); setMode(mode === 'in' ? 'up' : 'in'); }} />
    </Screen>
  );
}

const s = StyleSheet.create({
  body: { padding: space.xl, gap: space.lg, maxWidth: 480, width: '100%', alignSelf: 'center' },
  input: { minHeight: minTouch, borderRadius: radius.control, borderWidth: 1, paddingHorizontal: space.md },
  err: { borderRadius: radius.control, padding: space.md },
});
