import { describe, expect, it } from 'vitest';
import { createAppTheme, type ThemeMode } from './theme';
import { AA_SMALL_TEXT, contrast } from '../test/contrast';

/**
 * `warning.main` is why this file exists: MUI's light default (#ed6c02) measures
 * 3.11:1 on white, and the browser scan only caught it on the runs where a folder
 * happened to be stale.
 */

/** Every palette colour that can reach small text over a page surface. */
const SMALL_TEXT = [
  'text.primary',
  'text.secondary',
  // Outlined chips: the vector store and tool calls (secondary), the connection
  // state (success/error), a failed tool call (error), a stale root (warning).
  'secondary.main',
  'success.main',
  'error.main',
  'warning.main',
  // Not rendered today, but `severity` and `color` accept it, so it is held to
  // the same bar rather than left as a landmine for whoever reaches for it.
  'info.main',
] as const;

const resolve = (theme: ReturnType<typeof createAppTheme>, token: string): string => {
  const [group = '', key = ''] = token.split('.');
  const palette = theme.palette as unknown as Record<string, Record<string, string>>;
  const value = palette[group]?.[key];
  if (value === undefined) throw new Error(`no palette entry for ${token}`);

  return value;
};

describe.each<ThemeMode>(['dark', 'light'])('the %s palette', (mode) => {
  const theme = createAppTheme(mode);

  // `background.default` sits behind the transparent app bar, `background.paper`
  // is the drawer and the assistant bubble. The same chips appear on both.
  describe.each(['default', 'paper'] as const)('on background.%s', (surface) => {
    const background = theme.palette.background[surface];

    it.each(SMALL_TEXT)('reads %s at AA', (token) => {
      expect(contrast(resolve(theme, token), background)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    });
  });

  it('reads the user bubble label against its own filled background', () => {
    const { main, contrastText } = theme.palette.primary;

    expect(contrast(contrastText, main)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });
});
