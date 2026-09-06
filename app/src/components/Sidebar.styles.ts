import type { SxProps, Theme } from '@mui/material/styles';
import { MONOSPACE } from '../theme/theme';

export const panel: SxProps<Theme> = { height: '100%' };
export const header: SxProps<Theme> = { p: 2, pb: 1 };
export const headerActions: SxProps<Theme> = { mt: 1 };

export const progress: SxProps<Theme> = { px: 2, pb: 1 };
export const progressBar: SxProps<Theme> = { mt: 0.5 };
export const progressFooter: SxProps<Theme> = { mt: 0.5, alignItems: 'center' };
export const currentFile: SxProps<Theme> = { fontFamily: MONOSPACE, flex: 1, minWidth: 0 };
export const spacer: SxProps<Theme> = { flex: 1 };

export const rootList: SxProps<Theme> = { flex: 1, overflowY: 'auto', py: 0 };
export const rootPath: SxProps<Theme> = { fontFamily: MONOSPACE, display: 'block' };
/** Shared by every status chip on a folder row, so they line up with each other. */
export const staleChip: SxProps<Theme> = { ml: 1, height: 18 };
export const footer: SxProps<Theme> = { px: 2, py: 1 };

/** Sits above the build line, and only when there is something to install. */
export const updateBanner: SxProps<Theme> = {
  px: 2,
  py: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 1,
};

/** The empty-state row's secondary line is one size down from a folder's. */
export const emptyStateText = { secondary: { variant: 'caption' } } as const;

/**
 * A `span`, because the secondary slot renders inside a `<p>` and the folder rows
 * put block elements in it — a `div` there is invalid markup that React warns about.
 */
export const rootItemText = { secondary: { component: 'span' } } as const;
