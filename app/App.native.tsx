import React from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, Text } from 'react-native';
import { Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold, useFonts } from '@expo-google-fonts/cairo';
import { ThemeProvider } from './src/design/ThemeContext';
import { lightTheme } from './src/design/tokens';
import { HostedEntry } from './src/ui/HostedEntry';
import { configuredEnvironment } from './src/supabase/client';
import { resolveSupabaseConfig } from './src/supabase/config';

/** Native builds never import the web preview, synthetic auth or in-memory task store. */
export default function App() {
  const [fontsLoaded, fontError] = useFonts({ Cairo_400Regular, Cairo_500Medium, Cairo_600SemiBold, Cairo_700Bold });
  let configurationError: string | undefined;
  try { resolveSupabaseConfig(configuredEnvironment()); }
  catch (error) { configurationError = error instanceof Error ? error.message : 'Invalid development configuration'; }
  if (configurationError) return <SafeAreaView style={styles.screen}>
    <Text accessibilityRole="header" style={styles.title}>TaskFlow development setup required</Text>
    <Text style={styles.body}>This is the native application. Demo tasks are disabled. No account or task database has been opened.</Text>
    <Text style={styles.body}>{configurationError}</Text>
    <Text style={styles.body}>Configure a disposable local backend using app/.env.example, then rebuild the APK. Do not enter a service key or database password. See docs/ANDROID_DEVELOPMENT.md.</Text>
  </SafeAreaView>;
  if (fontError) return <SafeAreaView style={styles.screen}><Text style={styles.body}>TaskFlow could not load its bundled fonts. Restart the app. Your saved tasks have not been removed.</Text></SafeAreaView>;
  if (!fontsLoaded) return <SafeAreaView style={styles.screen}><ActivityIndicator accessibilityLabel="Loading TaskFlow" /></SafeAreaView>;
  return <ThemeProvider value={lightTheme}><HostedEntry locale="en" /></ThemeProvider>;
}
const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#f7f8fa' },
  title: { fontSize: 22, fontWeight: '700', color: '#111827', marginBottom: 16 },
  body: { fontSize: 16, lineHeight: 24, color: '#1f2937', marginBottom: 16 },
});
