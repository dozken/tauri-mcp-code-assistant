import type { SxProps, Theme } from '@mui/material/styles';
import { MONOSPACE } from '../theme/theme';
import type { ThemeMode } from '../theme/theme';
import type { TokenKind } from './highlight';

/**
 * Hoisted out of render: this renders once per streamed token, and an inline
 * `sx={{…}}` allocates a new object each time, missing emotion's cache.
 */
export const codeSpan: SxProps<Theme> = {
  fontFamily: MONOSPACE,
  fontSize: '0.875em',
  px: 0.5,
  py: 0.125,
  borderRadius: 0.75,
  bgcolor: 'action.hover',
  // A long identifier must not push the bubble wider than its column.
  overflowWrap: 'anywhere',
};

export const strong: SxProps<Theme> = { fontWeight: 600 };
export const emphasis: SxProps<Theme> = { fontStyle: 'italic' };

/**
 * A solid surface rather than `action.hover`, so a code block looks like one
 * wherever it lands. Translucent grey over the user bubble's filled `primary.main`
 * gave the same fence two different backgrounds — and the bubble's white
 * `contrastText` on the light one would have been invisible.
 */
export const CODE_SURFACE: Record<ThemeMode, string> = {
  light: '#f4f5f7',
  dark: '#23252f',
};

/**
 * The syntax palette, in the app's own hues rather than a highlighter's.
 *
 * `keyword` and `string` are the primary and secondary accents of each mode, so a
 * snippet reads as part of this app and not as a widget pasted into it. Every
 * one of these is measured against `CODE_SURFACE` at AA in `Markdown.test.tsx`'s
 * companion, `syntax.test.ts` — including `punctuation`, which carries meaning
 * and so does not get to be decoratively faint.
 */
export const SYNTAX: Record<ThemeMode, Record<Exclude<TokenKind, 'plain'>, string>> = {
  light: {
    comment: '#5d6673',
    string: '#0b7f5a',
    number: '#a85400',
    keyword: '#3f51c4',
    type: '#01699f',
    function: '#7c3aed',
    punctuation: '#4b5563',
  },
  dark: {
    comment: '#8b96a8',
    string: '#57d9a3',
    number: '#ffb26b',
    keyword: '#7c9cff',
    type: '#6fd3f7',
    function: '#c9a2ff',
    punctuation: '#a7b0c0',
  },
};

/** The class a token of this kind carries; `plain` renders as bare text. */
export const tokenClass = (kind: Exclude<TokenKind, 'plain'>): string => `tok-${kind}`;

/** `& .tok-keyword` and friends, built once per mode rather than per render. */
const tokenRules = (mode: ThemeMode): Record<string, { color: string }> =>
  Object.fromEntries(
    Object.entries(SYNTAX[mode]).map(([kind, color]) => [
      `& .${tokenClass(kind as Exclude<TokenKind, 'plain'>)}`,
      { color },
    ]),
  );

// This renders on every streamed token, so the only work left per render is one
// lookup and a spread of an object that already exists.
const TOKEN_RULES: Record<ThemeMode, Record<string, { color: string }>> = {
  light: tokenRules('light'),
  dark: tokenRules('dark'),
};

export const codeBlock: SxProps<Theme> = (theme) => ({
  my: 1,
  p: 1.5,
  fontFamily: MONOSPACE,
  fontSize: 12.5,
  lineHeight: 1.5,
  overflowX: 'auto',
  borderRadius: 1,
  bgcolor: CODE_SURFACE[theme.palette.mode],
  // Explicit, because the user bubble sets a `contrastText` that this surface is
  // not the contrast to.
  color: 'text.primary',
  ...TOKEN_RULES[theme.palette.mode],
});

/** The first heading in an answer sits flush; later ones get space above. */
export const heading: Record<'first' | 'later', SxProps<Theme>> = {
  first: { mt: 0, mb: 0.5, fontWeight: 600 },
  later: { mt: 1.5, mb: 0.5, fontWeight: 600 },
};

export const list: SxProps<Theme> = { my: 0.5, pl: 3, '& li': { mb: 0.25 } };

/** Newlines inside one paragraph are meaningful in an answer about code. */
export const paragraph: SxProps<Theme> = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };
