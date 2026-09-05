import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { AppThemeProvider } from './AppThemeProvider';

/** jsdom has no media-query engine; this reports whatever the test asks for. */
const preferDark = (dark: boolean): void => {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('dark') && dark,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
        onchange: null,
      }) as unknown as MediaQueryList,
  );
};

const ShowMode = () => <Box data-testid="mode">{useTheme().palette.mode}</Box>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppThemeProvider', () => {
  it.each([
    ['dark', true],
    ['light', false],
  ])('follows the OS preference for %s', (mode, dark) => {
    preferDark(dark);

    render(
      <AppThemeProvider>
        <ShowMode />
      </AppThemeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent(mode);
  });

  it('rebuilds the theme when the preference changes, rather than caching the first one', () => {
    // An empty dependency list still passes both cases above, because each starts
    // a fresh render. It only shows up when the OS flips while the app is open,
    // which is exactly when a desktop user notices.
    preferDark(false);
    const { rerender } = render(
      <AppThemeProvider>
        <ShowMode />
      </AppThemeProvider>,
    );
    expect(screen.getByTestId('mode')).toHaveTextContent('light');

    preferDark(true);
    rerender(
      <AppThemeProvider>
        <ShowMode />
      </AppThemeProvider>,
    );

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
  });

  it('renders its children', () => {
    preferDark(true);

    render(
      <AppThemeProvider>
        <Box data-testid="child">hello</Box>
      </AppThemeProvider>,
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
