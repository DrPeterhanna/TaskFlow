/**
 * Approved design tokens (UI_UX_DESIGN_SYSTEM.md section 1). Deep teal primary, marigold accent (sparingly), Cairo font.
 * Values were measured against WCAG AA in test/tokens.test.ts. Measured changes from the proposal:
 *  - warning (light) #B26A00 failed 4.5:1 on white (4.24), darkened to #9A5A00.
 *  - border (#E3E1DA, 1.3:1) is decoration only; interactive boundaries use borderStrong (>= 3:1).
 */
export interface Theme {
  primary: string; primaryPressed: string; onPrimary: string; accent: string; onAccent: string;
  bg: string; surface: string; border: string; borderStrong: string; text: string; textMuted: string;
  success: string; warning: string; danger: string; successBg: string; warningBg: string; dangerBg: string;
}
export const lightTheme: Theme = {
  primary: '#0F5C63', primaryPressed: '#0B464C', onPrimary: '#FFFFFF', accent: '#F2A900', onAccent: '#141B1D',
  bg: '#F6F5F1', surface: '#FFFFFF', border: '#E3E1DA', borderStrong: '#6F7B7D', text: '#141B1D', textMuted: '#5B6769',
  success: '#2E7D5B', warning: '#9A5A00', danger: '#B3261E', successBg: '#F0F8F4', warningBg: '#FFF1D6', dangerBg: '#FBE9E7',
};
export const darkTheme: Theme = {
  primary: '#4FB3BA', primaryPressed: '#7CCBD0', onPrimary: '#0E1517', accent: '#FFC24D', onAccent: '#0E1517',
  bg: '#0E1517', surface: '#162023', border: '#26363A', borderStrong: '#6F8588', text: '#ECF1F1', textMuted: '#9AAAAD',
  success: '#5DC49A', warning: '#FFB454', danger: '#FF8A80', successBg: '#173628', warningBg: '#3A2A10', dangerBg: '#3E1D1B',
};
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;   // 4 pt grid
export const radius = { control: 8, card: 14, sheet: 20, pill: 999 } as const;
export const type = {
  display: { size: 28, line: 36 }, title: { size: 22, line: 30 }, heading: { size: 18, line: 26 },
  body: { size: 16, line: 24 }, caption: { size: 13, line: 18 },
} as const;
export const minTouch = 44;
export const fontFamily = { 400: 'Cairo_400Regular', 500: 'Cairo_500Medium', 600: 'Cairo_600SemiBold', 700: 'Cairo_700Bold' } as const;

export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}
