/** Design tokens. Contrast pairs checked in test/tokens.test.ts (WCAG AA 4.5:1 for text). */
export const color = {
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  text: '#14181F',
  textMuted: '#4B5563',
  border: '#D9DEE5',
  primary: '#1F4FD8',
  onPrimary: '#FFFFFF',
  success: '#14793C',
  warning: '#8A5300',
  warningBg: '#FFF3DC',
  danger: '#B3261E',
  dangerBg: '#FDECEA',
  okBg: '#E6F4EA',
} as const;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const radius = { sm: 8, md: 12, pill: 999 } as const;
export const font = { body: 16, small: 13, title: 28, h2: 18 } as const;
export const minTouch = 44;
