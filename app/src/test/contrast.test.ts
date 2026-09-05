import { describe, expect, it } from 'vitest';
import { contrast } from './contrast';

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
