import { describe, expect, it } from 'vitest';
import { contrast, darkTheme, lightTheme, type Theme } from '../src/design/tokens.js';

const textPairs: Array<[keyof Theme, keyof Theme]> = [
  ['text', 'bg'], ['text', 'surface'], ['textMuted', 'bg'], ['textMuted', 'surface'], ['primary', 'bg'], ['primary', 'surface'],
  ['onPrimary', 'primary'], ['onAccent', 'accent'], ['success', 'surface'], ['warning', 'surface'], ['danger', 'surface'],
  ['success', 'successBg'], ['warning', 'warningBg'], ['danger', 'dangerBg'], ['primary', 'primaryPressed'],
];
for (const [name, t] of [['light', lightTheme], ['dark', darkTheme]] as const) {
  describe(`contrast (${name})`, () => {
    for (const [fg, bg] of textPairs) {
      if (fg === 'primary' && bg === 'primaryPressed') continue;
      it(`${fg} on ${bg} >= 4.5:1`, () => expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5));
    }
    it('control boundary (borderStrong) >= 3:1 on surface and bg', () => {
      expect(contrast(t.borderStrong, t.surface)).toBeGreaterThanOrEqual(3);
      expect(contrast(t.borderStrong, t.bg)).toBeGreaterThanOrEqual(3);
    });
  });
}
