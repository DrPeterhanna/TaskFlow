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
    auth: {
      signInTitle: 'Sign in', signUpTitle: 'Create your account', email: 'Email', password: 'Password', signIn: 'Sign in', signUp: 'Create account',
      toSignUp: 'New here? Create an account', toSignIn: 'Already have an account? Sign in', hintPassword: 'At least 8 characters',
      verifyTitle: 'Check your email', verifyBody: (e: string) => `We sent a link to ${e}. Open it, then come back and tap the button below.`,
      resend: 'Send the email again', checked: 'I have verified my email', sent: 'Email sent.', signOut: 'Sign out',
      errors: { invalid_email: 'Enter a valid email address.', weak_password: 'Use at least 8 characters.', invalid_credentials: 'Email or password is not correct.',
        email_not_verified: 'Verify your email first. Check your inbox.', already_registered: 'An account with this email already exists. Sign in instead.',
        rate_limited: 'Too many tries. Wait a minute and try again.', network: 'No connection. Check your internet and try again.', unknown: 'Something went wrong. Try again.' },
    },
    org: {
      gateTitle: 'Join or create your organization', createTitle: 'Create an organization', joinTitle: 'Join with an invitation code',
      orgName: 'Organization name', code: 'Invitation code', create: 'Create', join: 'Join', oneOrg: 'You can belong to one organization.',
      errors: { name: 'Enter a name up to 120 characters.', code: 'This code is not valid or has expired.', already_member: 'You already belong to an organization.',
        verify: 'Verify your email before creating an organization.', rate: 'Too many tries. Wait and try again.', generic: 'Could not complete this. Try again.', network: 'No connection. Try again.' },
      roles: { member: 'Member', team_leader: 'Team leader', supervisor: 'Supervisor', admin: 'Admin' },
      yourRole: 'Your role', tabTasks: 'My tasks', tabOrg: 'Organization', tabAccount: 'Account', retry: 'Try again', loadError: 'Could not load your account.',
    },
  },
  ar: {
    title: 'مهامي', add: 'إضافة', placeholder: 'أضف مهمة', empty: 'لا توجد مهام بعد', emptyHint: 'أضف أول مهمة أعلاه. تعمل بدون إنترنت.',
    synced: 'تم حفظ كل التغييرات', waiting: (n: number) => `${n} بانتظار المزامنة`, offline: 'غير متصل. التغييرات محفوظة على هذا الجهاز.',
    inbox: (n: number) => `${n} تغييرات تحتاج انتباهك`,
    taskState: (title: string, done: boolean) => `${title}، ${done ? 'مكتملة' : 'مفتوحة'}`,
    del: (title: string) => `حذف ${title}`, pendingDot: 'بانتظار المزامنة',
    previewNote: 'نسخة تجريبية. تُحفظ البيانات في قاعدة بيانات اختبار محلية وليس Supabase.', simulateOffline: 'محاكاة عدم الاتصال',
    loading: 'جارٍ التحميل', error: 'تعذّر البدء',
    auth: {
      signInTitle: 'تسجيل الدخول', signUpTitle: 'أنشئ حسابك', email: 'البريد الإلكتروني', password: 'كلمة المرور', signIn: 'دخول', signUp: 'إنشاء حساب',
      toSignUp: 'جديد هنا؟ أنشئ حسابًا', toSignIn: 'لديك حساب؟ سجّل الدخول', hintPassword: '٨ أحرف على الأقل',
      verifyTitle: 'تحقق من بريدك', verifyBody: (e: string) => `أرسلنا رابطًا إلى ${e}. افتحه ثم عد واضغط الزر أدناه.`,
      resend: 'أعد إرسال الرسالة', checked: 'تحققت من بريدي', sent: 'تم إرسال الرسالة.', signOut: 'تسجيل الخروج',
      errors: { invalid_email: 'أدخل بريدًا إلكترونيًا صحيحًا.', weak_password: 'استخدم ٨ أحرف على الأقل.', invalid_credentials: 'البريد أو كلمة المرور غير صحيحة.',
        email_not_verified: 'تحقق من بريدك أولًا.', already_registered: 'يوجد حساب بهذا البريد. سجّل الدخول بدلًا من ذلك.',
        rate_limited: 'محاولات كثيرة. انتظر دقيقة ثم أعد المحاولة.', network: 'لا يوجد اتصال. تحقق من الإنترنت وأعد المحاولة.', unknown: 'حدث خطأ. أعد المحاولة.' },
    },
    org: {
      gateTitle: 'انضم إلى مؤسستك أو أنشئها', createTitle: 'إنشاء مؤسسة', joinTitle: 'الانضمام برمز دعوة',
      orgName: 'اسم المؤسسة', code: 'رمز الدعوة', create: 'إنشاء', join: 'انضمام', oneOrg: 'يمكنك الانتماء إلى مؤسسة واحدة.',
      errors: { name: 'أدخل اسمًا لا يزيد عن ١٢٠ حرفًا.', code: 'هذا الرمز غير صالح أو منتهي.', already_member: 'أنت منتمٍ لمؤسسة بالفعل.',
        verify: 'تحقق من بريدك قبل إنشاء مؤسسة.', rate: 'محاولات كثيرة. انتظر ثم أعد المحاولة.', generic: 'تعذّر إتمام ذلك. أعد المحاولة.', network: 'لا يوجد اتصال. أعد المحاولة.' },
      roles: { member: 'عضو', team_leader: 'قائد فريق', supervisor: 'مشرف', admin: 'مدير' },
      yourRole: 'دورك', tabTasks: 'مهامي', tabOrg: 'المؤسسة', tabAccount: 'الحساب', retry: 'أعد المحاولة', loadError: 'تعذّر تحميل حسابك.',
    },
  },
} as const;
export type Strings = (typeof dict)[Locale];
export const strings = (l: Locale): Strings => dict[l];
export const isRtl = (l: Locale): boolean => l === 'ar';
