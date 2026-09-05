import type { ThemeOptions } from '@mui/material/styles';

/**
 * The mode-independent half of the theme: shape, type and component defaults.
 *
 * Split from the palette because the two are graded differently. A palette value
 * can be *wrong* — too light to read — and `theme.test.ts` measures every one of
 * them. These are taste: there is no test that can say `borderRadius: 10` is
 * correct, only one that restates it.
 */
export const DESIGN_TOKENS: ThemeOptions = {
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    fontSize: 14,
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
  },
};

export const MONOSPACE =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
