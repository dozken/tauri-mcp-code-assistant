import { useMemo, type ReactNode } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { ThemeProvider } from '@mui/material/styles';
import { createAppTheme } from './theme';

export interface AppThemeProviderProps {
  children: ReactNode;
}

/**
 * Follows the OS light/dark preference, the way a desktop app is expected to.
 *
 * `noSsr` because there is no server render to match: without it the first paint
 * is always the light default and then flips, which reads as a flash.
 */
export const AppThemeProvider = ({ children }: AppThemeProviderProps) => {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', { noSsr: true });
  const theme = useMemo(() => createAppTheme(prefersDark ? 'dark' : 'light'), [prefersDark]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
};
