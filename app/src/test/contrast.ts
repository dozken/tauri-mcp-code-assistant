/**
 * WCAG contrast, measured rather than eyeballed.
 *
 * Lives here because two suites need it: `theme.test.ts` measures the palette a
 * component can reach, and `syntax.test.ts` measures the code-block colours. A
 * colour is the one kind of design decision that has a right answer, so it gets
 * a test rather than a review comment.
 */
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

export const contrast = (foreground: string, background: string): number => {
  const behind = parse(background);
  const a = luminance(composite(parse(foreground), behind));
  const b = luminance(behind);

  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/**
 * Everything measured with this renders at 12-13px, so AA asks for 4.5:1 and the
 * large-text 3:1 allowance never applies.
 */
export const AA_SMALL_TEXT = 4.5;
