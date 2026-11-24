export type Locale = 'en' | 'ar';
const dict = {
  en: {
    title: 'My tasks', add: 'Add', placeholder: 'Add a task', empty: 'Nothing here yet', emptyHint: 'Add your first task above. It works offline.',
    synced: 'All changes saved', waiting: (n: number) => `${n} waiting to sync`, offline: 'Offline. Changes are kept on this device.',
    inbox: (n: number) => `${n} change${n === 1 ? '' : 's'} need attention`,
    taskState: (title: string, done: boolean) => `${title}, ${done ? 'done' : 'open'}`,
    del: (title: string) => `Delete ${title}`, pendingDot: 'Waiting to sync',
    previewNote: 'Preview build. Data goes to a local test database, not Supabase.', simulateOffline: 'Simulate offline',
    loading: 'Loading', error: 'Could not start',
  },
  ar: {
    title: 'مهامي', add: 'إضافة', placeholder: 'أضف مهمة', empty: 'لا توجد مهام بعد', emptyHint: 'أضف أول مهمة أعلاه. تعمل بدون إنترنت.',
    synced: 'تم حفظ كل التغييرات', waiting: (n: number) => `${n} بانتظار المزامنة`, offline: 'غير متصل. التغييرات محفوظة على هذا الجهاز.',
    inbox: (n: number) => `${n} تغييرات تحتاج انتباهك`,
    taskState: (title: string, done: boolean) => `${title}، ${done ? 'مكتملة' : 'مفتوحة'}`,
    del: (title: string) => `حذف ${title}`, pendingDot: 'بانتظار المزامنة',
    previewNote: 'نسخة تجريبية. تُحفظ البيانات في قاعدة بيانات اختبار محلية وليس Supabase.', simulateOffline: 'محاكاة عدم الاتصال',
    loading: 'جارٍ التحميل', error: 'تعذّر البدء',
  },
} as const;
export type Strings = (typeof dict)[Locale];
export const strings = (l: Locale): Strings => dict[l];
export const isRtl = (l: Locale): boolean => l === 'ar';
