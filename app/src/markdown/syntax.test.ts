import { describe, expect, it } from 'vitest';
import { createAppTheme, type ThemeMode } from '../theme/theme';
import { AA_SMALL_TEXT, contrast } from '../test/contrast';
import { CODE_SURFACE, SYNTAX } from './Markdown.styles';

/**
 * A syntax theme borrowed from a highlighter is chosen against that
 * highlighter's background, not this app's — which is how light themes end up
 * with 3:1 comments that look fine to whoever picked them. These are ours, so
 * they are measured like every other colour in the app.
 *
 * `punctuation` is in here deliberately: braces and semicolons carry meaning in
 * code, so they do not get to be decoratively faint.
 */
describe.each<ThemeMode>(['dark', 'light'])('the %s code block', (mode) => {
  const surface = CODE_SURFACE[mode];
  // `SYNTAX` is typed against `TokenKind`, so a kind with no colour is a
  // compile error rather than something this file has to restate.
  const entries = Object.entries(SYNTAX[mode]);

  it.each(entries)('reads %s at AA on the code surface', (_kind, colour) => {
    expect(contrast(colour, surface)).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
  });

  it('reads unhighlighted code at AA too', () => {
    // Plain tokens inherit `text.primary`, and the block sets that explicitly
    // because inside a user bubble it would otherwise inherit white.
    expect(contrast(createAppTheme(mode).palette.text.primary, surface)).toBeGreaterThanOrEqual(
      AA_SMALL_TEXT,
    );
  });
});
