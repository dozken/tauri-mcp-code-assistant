import type { SxProps, Theme } from '@mui/material/styles';
import { CODE_SURFACE } from './Markdown.styles';

/**
 * Quiet until wanted, but never hidden: `opacity` rather than `display`, so the
 * button stays in the tab order and a keyboard user can reach it. It becomes
 * fully opaque on hover of the block it sits in, and on its own focus.
 */
export const button: SxProps<Theme> = {
  opacity: 0.45,
  transition: 'opacity 120ms',
  '&:hover, &:focus-visible': { opacity: 1 },
};

/**
 * Marks the control that `anchor` brings forward on hover. A class rather than a
 * descendant selector on the button's own MUI class: this file should not be the
 * thing that breaks when MUI renames one.
 */
export const REVEAL_ON_HOVER = 'copy-on-hover';

/** The block a copy button is anchored to. */
export const anchor: SxProps<Theme> = {
  position: 'relative',
  [`&:hover .${REVEAL_ON_HOVER}`]: { opacity: 1 },
};

/**
 * Floats over the top-right of the block, and paints its own background to do it:
 * a long first line scrolls underneath, and a translucent icon on top of code is
 * a smudge rather than a control.
 */
export const corner: SxProps<Theme> = {
  position: 'absolute',
  top: 4,
  right: 4,
  zIndex: 1,
  borderRadius: 1,
  bgcolor: (theme) => CODE_SURFACE[theme.palette.mode],
};
