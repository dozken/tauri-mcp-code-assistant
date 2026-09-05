import type { SxProps, Theme } from '@mui/material/styles';

/** The permanent drawer's width; the overlay one takes no layout space. */
const SIDEBAR_WIDTH = 300;

export const shell: SxProps<Theme> = { display: 'flex', height: '100vh' };

/**
 * Above a permanent drawer, below a temporary one. With the overlay drawer the
 * scrim must cover the whole app: at `drawer + 1` the bar was half bright and
 * half dimmed, and its chips sat at 1.2:1 through the scrim.
 */
const appBarCompact: SxProps<Theme> = {
  zIndex: (theme) => theme.zIndex.appBar,
  backdropFilter: 'blur(8px)',
};

const appBarWide: SxProps<Theme> = {
  zIndex: (theme) => theme.zIndex.drawer + 1,
  backdropFilter: 'blur(8px)',
};

export const appBar = (compact: boolean): SxProps<Theme> => (compact ? appBarCompact : appBarWide);

export const toolbar: SxProps<Theme> = { borderBottom: 1, borderColor: 'divider' };
export const menuButton: SxProps<Theme> = { mr: 1 };
export const title: SxProps<Theme> = { fontWeight: 600, flexGrow: 1 };
export const statusChips: SxProps<Theme> = { alignItems: 'center' };

const paper = { [`& .MuiDrawer-paper`]: { width: SIDEBAR_WIDTH, boxSizing: 'border-box' } };

const drawerCompact: SxProps<Theme> = { width: 0, flexShrink: 0, ...paper };
const drawerWide: SxProps<Theme> = { width: SIDEBAR_WIDTH, flexShrink: 0, ...paper };

/** The overlay drawer floats, so it must not reserve a column of layout. */
export const drawer = (compact: boolean): SxProps<Theme> => (compact ? drawerCompact : drawerWide);

export const main: SxProps<Theme> = {
  flexGrow: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
};

export const chatArea: SxProps<Theme> = { flex: 1, minHeight: 0 };
