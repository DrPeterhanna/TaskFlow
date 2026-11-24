export type Locale = 'en' | 'ar';
const dict = {
  en: {
    title: 'My tasks', add: 'Add', placeholder: 'Add a task', empty: 'Nothing here yet. Add your first task.',
    synced: 'All changes saved', waiting: (n: number) => `${n} waiting to sync`, offline: 'Offline. Changes are kept on this device.',
    inbox: (n: number) => `${n} change${n === 1 ? '' : 's'} need attention`, done: 'Done', open: 'Open',
    preview: 'Preview data, kept in memory only', offlineToggle: 'Offline',
  },
  ar: {
    title: 'مهامي', add: 'إضافة', placeholder: 'أضف مهمة', empty: 'لا توجد مهام بعد. أضف أول مهمة.',
    synced: 'تم حفظ كل التغييرات', waiting: (n: number) => `${n} بانتظار المزامنة`, offline: 'غير متصل. التغييرات محفوظة على هذا الجهاز.',
    inbox: (n: number) => `${n} تغييرات تحتاج انتباهك`, done: 'مكتملة', open: 'مفتوحة',
    preview: 'بيانات تجريبية في الذاكرة فقط', offlineToggle: 'غير متصل',
  },
} as const;
export type Strings = (typeof dict)[Locale];
export const strings = (l: Locale): Strings => dict[l];
export const isRtl = (l: Locale): boolean => l === 'ar';
