import type { SxProps, Theme } from '@mui/material/styles';
import type { ChatMessage } from '../types';
import { MONOSPACE } from '../theme/theme';

/**
 * Hoisted out of render. An inline `sx={{…}}` allocates a fresh object every
 * time, which misses emotion's cache and re-serialises the same rules; this
 * component re-renders on every streamed token, so that is the hot path.
 *
 * Keyed by role rather than a boolean, so the two variants sit side by side and
 * neither can be picked by accident.
 */
export const row: Record<ChatMessage['role'], SxProps<Theme>> = {
  user: { justifyContent: 'flex-end' },
  assistant: { justifyContent: 'flex-start' },
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
