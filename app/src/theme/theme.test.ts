import { describe, expect, it } from 'vitest';
import { createAppTheme, type ThemeMode } from './theme';

type Rgba = readonly [red: number, green: number, blue: number, alpha: number];

const HEX = /^#(?<digits>[\da-f]{3,8})$/i;
const FUNCTIONAL = /^rgba?\((?<parts>[^)]*)\)$/i;

/**
 * MUI hands back three notations from one palette — `#0b7f5a`, `#fff` and
 * `rgba(0, 0, 0, 0.6)` — so the test has to read all of them or it silently
 * measures `NaN` and passes nothing.
 */
const parse = (color: string): Rgba => {
  const hex = HEX.exec(color.trim())?.groups?.digits;
  if (hex !== undefined) {
    const width = hex.length <= 4 ? 1 : 2;
    const channels = Array.from({ length: hex.length / width }, (_unused, index) =>
      Number.parseInt(hex.slice(index * width, index * width + width).repeat(3 - width), 16),
    );
    const [red = 0, green = 0, blue = 0, alpha] = channels;
    return [red, green, blue, alpha === undefined ? 1 : alpha / 255];
  }

  const parts = FUNCTIONAL.exec(color.trim())?.groups?.parts;
  if (parts === undefined) throw new Error(`cannot parse the colour ${color}`);

  const [red = 0, green = 0, blue = 0, alpha = 1] = parts.split(',').map(Number);
  return [red, green, blue, alpha];
};

/** What the browser paints: a translucent foreground resolves against what is behind it. */
const composite = (foreground: Rgba, background: Rgba): Rgba =>
  [
    ...([0, 1, 2] as const).map(
      (channel) => foreground[channel] * foreground[3] + background[channel] * (1 - foreground[3]),
    ),
    1,
  ] as unknown as Rgba;

/** WCAG 2.1 relative luminance. */
const luminance = ([red, green, blue]: Rgba): number => {
  const [r = 0, g = 0, b = 0] = [red, green, blue].map((channel) => {
    const byte = channel / 255;
    return byte <= 0.039_28 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (foreground: string, background: string): number => {
  const behind = parse(background);
  const a = luminance(composite(parse(foreground), behind));
  const b = luminance(behind);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/**
 * Everything checked here renders at 12-13px, so AA asks for 4.5:1 and the
 * large-text 3:1 allowance never applies. `warning.main` is why this file
 * exists: MUI's light default (#ed6c02) measures 3.11:1 on white, and the
 * browser scan only caught it on the runs where a folder happened to be stale.
 */
const AA_SMALL_TEXT = 4.5;

/** Every palette colour that can reach small text over a page surface. */
const SMALL_TEXT = [
  'text.primary',
  'text.secondary',
  // Outlined chips: the vector store and tool calls (secondary), the connection
  // state (success/error), a failed tool call (error), a stale root (warning).
  'secondary.main',
  'success.main',
  'error.main',
  'warning.main',
  // Not rendered today, but `severity` and `color` accept it, so it is held to
  // the same bar rather than left as a landmine for whoever reaches for it.
  'info.main',
] as const;

const resolve = (theme: ReturnType<typeof createAppTheme>, token: string): string => {
  const [group = '', key = ''] = token.split('.');
  const palette = theme.palette as unknown as Record<string, Record<string, string>>;
  const value = palette[group]?.[key];
  if (value === undefined) throw new Error(`no palette entry for ${token}`);

  return value;
};

describe.each<ThemeMode>(['dark', 'light'])('the %s palette', (mode) => {
  const theme = createAppTheme(mode);

  // `background.default` sits behind the transparent app bar, `background.paper`
  // is the drawer and the assistant bubble. The same chips appear on both.
  describe.each(['default', 'paper'] as const)('on background.%s', (surface) => {
    const background = theme.palette.background[surface];

    it.each(SMALL_TEXT)('reads %s at AA', (token) => {
      expect(contrast(resolve(theme, token), background)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
    });
  });

  it('reads the user bubble label against its own filled background', () => {
    const { main, contrastText } = theme.palette.primary;

    expect(contrast(contrastText, main)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });
});

describe('contrast', () => {
  it('agrees with the reference ratios at both extremes', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // Order must not matter: the ratio is defined on the lighter of the pair.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('expands short hex the way CSS does', () => {
    expect(contrast('#fff', '#000')).toBeCloseTo(21, 5);
  });

  it('resolves a translucent foreground against what is behind it', () => {
    // 60% black on white is #666666, whichever notation it arrives in.
    expect(contrast('rgba(0, 0, 0, 0.6)', '#ffffff')).toBeCloseTo(
      contrast('#666666', '#ffffff'),
      1,
    );
    // The same ink over black is invisible rather than merely dim.
    expect(contrast('rgba(0, 0, 0, 0.6)', '#000000')).toBeCloseTo(1, 5);
  });

  it('rejects a notation it cannot measure instead of reporting NaN', () => {
    expect(() => contrast('rebeccapurple', '#fff')).toThrow(/cannot parse/);
  });
});
