import type { SxProps, Theme } from '@mui/material/styles';
import { MONOSPACE } from '../theme/theme';

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

export const codeBlock: SxProps<Theme> = {
  my: 1,
  p: 1.5,
  fontFamily: MONOSPACE,
  fontSize: 12.5,
  lineHeight: 1.5,
  overflowX: 'auto',
  bgcolor: 'action.hover',
  borderRadius: 1,
};

/** The first heading in an answer sits flush; later ones get space above. */
export const heading: Record<'first' | 'later', SxProps<Theme>> = {
  first: { mt: 0, mb: 0.5, fontWeight: 600 },
  later: { mt: 1.5, mb: 0.5, fontWeight: 600 },
};

export const list: SxProps<Theme> = { my: 0.5, pl: 3, '& li': { mb: 0.25 } };

/** Newlines inside one paragraph are meaningful in an answer about code. */
export const paragraph: SxProps<Theme> = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' };
