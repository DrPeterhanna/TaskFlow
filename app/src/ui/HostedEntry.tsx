import type { Locale } from '../i18n';
// Web build: the hosted/device entry (expo-sqlite) is native-only; the web build is the preview only.
export const hostedAvailable = false;
export function HostedEntry(_: { locale: Locale }) { return null; }
