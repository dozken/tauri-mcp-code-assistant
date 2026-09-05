import type { SxProps, Theme } from '@mui/material/styles';

/** Hoisted out of render: the transcript re-renders on every streamed token. */
export const panel: SxProps<Theme> = { height: '100%', minWidth: 0 };
export const transcript: SxProps<Theme> = { flex: 1, overflowY: 'auto', p: 2 };

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
