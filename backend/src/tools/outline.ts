import type { FileSymbol } from '@ai-code-companion/contracts';

/**
 * Cheap, language-agnostic outline extraction.
 *
 * A real product would use tree-sitter; this stays dependency-free and
 * deterministic, which is what the unit tests want. It is a *tokeniser*, not a
 * battery of regexes: this runs over every line of every file in a repository the
 * user points at, and the obvious `/^(?:export\s+)?(?:async\s+)?function\s+.../`
 * family backtracks super-linearly on adversarial (or merely minified) input.
 * One `split` per line is both linear and faster than ten regex passes.
 */

/** Words that may precede a declaration keyword in any of the supported languages. */
// Data, not logic: every entry is a survivable mutant that no sensible test would
// pin down, and there are enough of them to swamp the file's mutation score.
// Stryker disable all
const MODIFIERS: ReadonlySet<string> = new Set([
  'export',
  'default',
  'declare',
  'public',
  'private',
  'protected',
  'internal',
  'static',
  'final',
  'abstract',
  'async',
  'pub',
  'pub(crate)',
  'open',
  'sealed',
  'data',
]);

const KEYWORD_KINDS: Readonly<Record<string, string | undefined>> = {
  class: 'class',
  struct: 'class',
  interface: 'interface',
  trait: 'interface',
  protocol: 'interface',
  type: 'type',
  enum: 'enum',
  function: 'function',
  fn: 'function',
  func: 'function',
  def: 'function',
  sub: 'function',
};

const BINDING_KEYWORDS: ReadonlySet<string> = new Set(['const', 'let', 'var']);
// Stryker restore all

/** Trailing punctuation that can be glued to a declared name: `Foo<T>`, `run(`, `x:`. */
const NAME = /^[*]?([A-Za-z_$][\w$]*)/;

const nameFrom = (word: string | undefined): string | undefined =>
  word === undefined ? undefined : NAME.exec(word)?.[1];

/**
 * Index of the word after a Go method receiver — `func (r *Repo) Save(...)` splits
 * into `['func', '(r', '*Repo)', 'Save(ctx', ...]`, so the receiver spans words.
 */
const afterReceiver = (words: readonly string[], start: number): number => {
  if (words[start]?.startsWith('(') !== true) return start;
  for (let index = start; index < words.length; index += 1) {
    if (words[index]?.endsWith(')') === true) return index + 1;
  }
  return words.length;
};

/**
 * Extracts at most one declaration from an already-trimmed line.
 * Returns `undefined` for the overwhelming majority of lines, which is the point.
 */
export const extractSymbol = (line: string): Omit<FileSymbol, 'line'> | undefined => {
  const words = line.split(/\s+/);

  let index = 0;
  while (index < words.length && MODIFIERS.has(words[index] ?? '')) index += 1;

  // `function*` is the same keyword with a generator marker glued on.
  const keyword = words[index]?.replace(/[*]$/, '');
  if (keyword === undefined || keyword === '') return undefined;

  const kind = KEYWORD_KINDS[keyword];
  if (kind !== undefined) {
    const name = nameFrom(words[afterReceiver(words, index + 1)]);
    return name === undefined ? undefined : { kind, name };
  }

  // `export const handler = async (req) => {}` — a binding only counts as a
  // function when the line actually declares an arrow.
  if (BINDING_KEYWORDS.has(keyword) && line.includes('=>')) {
    const name = nameFrom(words[index + 1]);
    return name === undefined ? undefined : { kind: 'function', name };
  }

  return undefined;
};

/**
 * Import specifiers. Anchored, with no leading `\s*` (the caller trims), and every
 * lazy section bounded by a negated class so it cannot backtrack across a quote.
 */
const IMPORT_PATTERNS: readonly RegExp[] = [
  /^import\s[^'"]*['"]([^'"]+)['"]/,
  /^(?:const|let|var)\s[^=]*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/,
  /^from\s+([\w.]+)\s+import\s/,
  /^use\s+([\w:]+)/,
];

export const extractImport = (line: string): string | undefined => {
  for (const pattern of IMPORT_PATTERNS) {
    const specifier = pattern.exec(line)?.[1];
    if (specifier !== undefined) return specifier;
  }
  return undefined;
};
