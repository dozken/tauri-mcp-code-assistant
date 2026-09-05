import { keyframes } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';
import type { ChatMessage } from '../types';
import { MONOSPACE } from '../theme/theme';

const rise = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
`;

/**
 * A message arrives rather than appearing. 180ms is under the threshold where
 * motion starts to feel like waiting, and it runs on mount only — a re-render per
 * streamed token does not restart a CSS animation.
 *
 * Opt-in via `no-preference`, so a reader who has asked their OS for less motion
 * gets none rather than a shorter version of it.
 */
const arrives = {
  '@media (prefers-reduced-motion: no-preference)': {
    animation: `${rise} 180ms ease-out`,
  },
};

/**
 * Hoisted out of render. An inline `sx={{…}}` allocates a fresh object every
 * time, which misses emotion's cache and re-serialises the same rules; this
 * component re-renders on every streamed token, so that is the hot path.
 *
 * Keyed by role rather than a boolean, so the two variants sit side by side and
 * neither can be picked by accident.
 */
export const row: Record<ChatMessage['role'], SxProps<Theme>> = {
  user: { justifyContent: 'flex-end', ...arrives },
  assistant: { justifyContent: 'flex-start', ...arrives },
};

/**
 * `primary.main` with its own `contrastText`, rather than `primary.dark` with
 * inherited body text: MUI guarantees that pair meets contrast in both palettes,
 * and the inherited version measured 1.94:1 in light mode.
 */
export const bubble: Record<ChatMessage['role'], SxProps<Theme>> = {
  user: {
    maxWidth: '75%',
    px: 2,
    py: 1.25,
    bgcolor: 'primary.main',
    color: 'primary.contrastText',
    borderColor: 'primary.main',
  },
  assistant: {
    maxWidth: '92%',
    px: 2,
    py: 1.25,
    bgcolor: 'background.paper',
    color: 'text.primary',
    borderColor: 'divider',
  },
};

export const toolAccordion: SxProps<Theme> = { bgcolor: 'transparent', mb: 1 };
export const toolSummary: SxProps<Theme> = { minHeight: 0, px: 0 };
export const toolChips: SxProps<Theme> = { alignItems: 'center', flexWrap: 'wrap' };
export const toolDetails: SxProps<Theme> = { px: 0 };
export const toolEntry: SxProps<Theme> = { mb: 1 };

export const toolOutput: SxProps<Theme> = {
  m: 0,
  p: 1,
  fontFamily: MONOSPACE,
  fontSize: 12,
  maxHeight: 180,
  overflow: 'auto',
  bgcolor: 'action.hover',
  borderRadius: 1,
};

export const errorAlert: SxProps<Theme> = { mt: 1 };

/**
 * The quiet line under a message: its time on the left, its actions on the right.
 * Under, never beside — nothing belongs between the answer and the eye reading it.
 */
export const footer: SxProps<Theme> = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1,
  mt: 0.5,
  minHeight: 28,
};

/**
 * The timestamp takes its colour from the bubble it sits in, not from the page.
 *
 * `text.secondary` is dark grey, which is right on the assistant's paper and
 * unreadable on the user's filled accent — where the bubble's own `contrastText`
 * is the colour MUI guarantees against that background. An `opacity` here to make
 * it quieter cost 1.5:1 and failed the light-theme axe scan; the caption size does
 * that job without spending contrast on it.
 */
export const time: Record<ChatMessage['role'], SxProps<Theme>> = {
  user: { color: 'inherit' },
  assistant: { color: 'text.secondary' },
};
