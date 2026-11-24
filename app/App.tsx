import React, { useMemo } from 'react';
import { PersonalTasksScreen } from './src/ui/PersonalTasksScreen';
import { createMemoryStore } from './src/store/memoryStore';
import type { Locale } from './src/i18n';

/** Web preview entry. The device build will construct the SQLite-backed store here instead (see src/store/sqliteStore.ts). */
export default function App() {
  const locale: Locale = typeof window !== 'undefined' && window.location.search.includes('lang=ar') ? 'ar' : 'en';
  const store = useMemo(() => createMemoryStore([
    { id: 'a', title: 'Prepare the weekly plan', done: false, pending: false },
    { id: 'b', title: 'Call the supplier about delivery', done: true, pending: false },
    { id: 'c', title: 'Review field report', done: false, pending: true },
  ]), []);
  return <PersonalTasksScreen store={store} locale={locale} preview />;
}
