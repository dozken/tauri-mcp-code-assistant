import { keyframes } from '@mui/material/styles';
import type { SxProps, Theme } from '@mui/material/styles';

const fadeUp = keyframes`
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
`;

/** Hoisted out of render: the transcript re-renders on every streamed token. */
export const panel: SxProps<Theme> = { height: '100%', minWidth: 0 };
export const transcript: SxProps<Theme> = { flex: 1, overflowY: 'auto', px: 2, pt: 2 };

/**
 * The transcript's bottom breathing room, as content rather than padding on the
 * scroll container: `scrollIntoView({ block: 'end' })` stops at the scrollport
 * edge, so padding below the last message is space you can never scroll to and
 * the newest answer ends up jammed against the composer.
 */
export const transcriptEnd: SxProps<Theme> = { height: (theme) => theme.spacing(2) };

export const emptyState: SxProps<Theme> = {
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
};

export const examples: SxProps<Theme> = { flexWrap: 'wrap', justifyContent: 'center' };

/**
 * Without the label override a chip wider than the column is clipped by the
 * viewport instead of wrapping — `flex-wrap` cannot break a single item.
 */
export const exampleChip: SxProps<Theme> = {
  maxWidth: '100%',
  height: 'auto',
  py: 0.5,
  '& .MuiChip-label': { whiteSpace: 'normal' },
};

export const errorAlert: SxProps<Theme> = { mx: 2, mb: 1 };
export const composer: SxProps<Theme> = { p: 1.5, borderLeft: 0, borderRight: 0, borderBottom: 0 };
export const composerRow: SxProps<Theme> = { alignItems: 'flex-end' };
export const composerFooter: SxProps<Theme> = { mt: 1, alignItems: 'center' };
export const spacer: SxProps<Theme> = { flex: 1 };

/**
 * Floats over the foot of the transcript rather than pushing it: a control that
 * appears mid-stream and reflows the text is worse than the problem it solves.
 */
export const jumpAnchor: SxProps<Theme> = {
  position: 'relative',
  display: 'flex',
  justifyContent: 'center',
  height: 0,
};

export const jumpButton: SxProps<Theme> = {
  position: 'absolute',
  bottom: 8,
  borderRadius: 5,
  '@media (prefers-reduced-motion: no-preference)': { animation: `${fadeUp} 140ms ease-out` },
};
