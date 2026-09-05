import { createTheme, type Theme } from '@mui/material/styles';
import { DESIGN_TOKENS } from './theme.styles';

export type ThemeMode = 'light' | 'dark';

/**
 * Two palettes, one component tree.
 *
 * Every component takes its colours from semantic tokens (`text.secondary`,
 * `action.hover`, `color="warning"`), so supporting both modes is a change to
 * this file and nowhere else. The desktop shell follows the OS preference, which
 * is what a native app is expected to do when it sits beside an editor.
 *
 * Both palettes are chosen for contrast against their own surfaces: the dark
 * accents are light enough to read on #0f1117, and the light accents are dark
 * enough to read on white, which is why they are not the same two hues.
 */
const PALETTES = {
  dark: {
    primary: { main: '#7c9cff' },
    secondary: { main: '#57d9a3' },
    background: { default: '#0f1117', paper: '#161923' },
  },
  light: {
    // Darkened from the dark-mode accents: #7c9cff on white is roughly 2:1 and
    // fails AA for the small text and outlined chips that use it. The greens are
    // measured, not guessed — #0f8f66 lands at 4.08:1 on white, just under AA,
    // which the axe scan caught; #0b7f5a is 5.0:1.
    primary: { main: '#3f51c4' },
    secondary: { main: '#0b7f5a' },
    // MUI's own light warning and info fail AA as text: #ed6c02 is 2.9:1 on the
    // page and #0288d1 is 3.6:1, both well under the 4.5:1 that 13px chip labels
    // need. These replacements keep the hue and clear it — see theme.test.ts,
    // which measures every one of these. Info is not rendered today, but it is
    // one `color="info"` away from being, and a palette with a hole in it is a
    // trap rather than a saving.
    warning: { main: '#a85400' },
    info: { main: '#01699f' },
    background: { default: '#f6f7f9', paper: '#ffffff' },
  },
} as const;

export const createAppTheme = (mode: ThemeMode): Theme =>
  createTheme({ ...DESIGN_TOKENS, palette: { mode, ...PALETTES[mode] } });

/** The default used by tests and by any render that does not care about mode. */
export const theme = createAppTheme('dark');

// Re-exported so callers import one thing from one place; it lives with the
// other design tokens because that is what it is.
export { MONOSPACE } from './theme.styles';
