/**
 * A small syntax highlighter, for the same reason `parse.ts` is a small Markdown
 * parser: the alternatives cost more than the feature.
 *
 * `highlight.js` is ~25 kB gzipped before a single language and ships its own
 * colour themes, which are chosen against their own backgrounds rather than
 * ours — the light ones do not clear WCAG AA on this app's code blocks. Both it
 * and Prism also hand back HTML, and this app has a strict CSP and a standing
 * rule that model output never becomes markup. So: tokens as data, rendered by
 * React as spans, coloured from the app's own palette and measured like every
 * other colour in it.
 *
 * The scanner is deliberately generic. It knows comments, strings, numbers,
 * identifiers and punctuation, and a per-language keyword list does the rest —
 * which is most of the value of highlighting and none of the cost of a real
 * grammar. A language it does not know is left alone rather than guessed at.
 */

export type TokenKind =
  'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function' | 'punctuation' | 'plain';

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
}

interface Grammar {
  readonly lineComment?: string;
  readonly blockComment?: readonly [string, string];
  /** Quote characters that terminate at the end of the line if left unclosed. */
  readonly quotes: string;
  /** Quote characters a string may legitimately span lines with. */
  readonly spanningQuotes: string;
  readonly keywords: ReadonlySet<string>;
  /** SQL is written `SELECT` at least as often as `select`, and means the same. */
  readonly ignoreKeywordCase?: boolean;
}

const words = (list: string): ReadonlySet<string> => new Set(list.split(' '));

const JS_KEYWORDS = words(
  'as async await break case catch class const continue debugger declare default delete do else' +
    ' enum export extends false finally for from function get if implements import in infer' +
    ' instanceof interface is keyof let new null of private protected public readonly return satisfies' +
    ' set static super switch this throw true try type typeof undefined var void while with yield',
);

const PYTHON_KEYWORDS = words(
  'and as assert async await break class continue def del elif else except False finally for from' +
    ' global if import in is lambda None nonlocal not or pass raise return True try while with yield',
);

const RUST_KEYWORDS = words(
  'as async await break const continue crate dyn else enum extern false fn for if impl in let loop' +
    ' match mod move mut pub ref return self Self static struct super trait true type unsafe use where while',
);

const GO_KEYWORDS = words(
  'break case chan const continue default defer else fallthrough false for func go goto if import' +
    ' interface map nil package range return select struct switch true type var',
);

const C_KEYWORDS = words(
  'abstract bool break byte case catch char class const continue default do double else enum extends' +
    ' false final finally float for if implements import instanceof int interface long namespace new' +
    ' null private protected public return short static struct switch this throw throws true try' +
    ' typedef union unsigned using virtual void volatile while',
);

const SHELL_KEYWORDS = words(
  'case do done elif else esac exit export fi for function if in local read return set then unset until while',
);

const SQL_KEYWORDS = words(
  'and as asc between by case create delete desc distinct drop else end from group having in inner' +
    ' insert into is join left limit not null on or order outer right select set table then union' +
    ' update values where',
);

const JSON_KEYWORDS = words('true false null');

const C_LIKE = {
  lineComment: '//',
  blockComment: ['/*', '*/'] as const,
  quotes: `'"`,
  spanningQuotes: '',
};

/**
 * Keyed by the fence's info string, lower-cased. Unlisted languages render
 * unhighlighted: a wrong colour is worse than no colour, and guessing from the
 * source is how a shell script ends up painted as Perl.
 */
const GRAMMARS: Readonly<Record<string, Grammar>> = {
  ...forEach('ts typescript tsx js javascript jsx mjs cjs', {
    ...C_LIKE,
    quotes: `'"`,
    spanningQuotes: '`',
    keywords: JS_KEYWORDS,
  }),
  ...forEach('json jsonc', { ...C_LIKE, keywords: JSON_KEYWORDS }),
  ...forEach('py python', {
    lineComment: '#',
    quotes: `'"`,
    spanningQuotes: '',
    keywords: PYTHON_KEYWORDS,
  }),
  ...forEach('rs rust', { ...C_LIKE, keywords: RUST_KEYWORDS }),
  ...forEach('go golang', { ...C_LIKE, spanningQuotes: '`', keywords: GO_KEYWORDS }),
  ...forEach('java kt kotlin c h cpp cc cxx hpp cs csharp swift scala dart php', {
    ...C_LIKE,
    keywords: C_KEYWORDS,
  }),
  ...forEach('sh bash zsh shell console', {
    lineComment: '#',
    quotes: `'"`,
    spanningQuotes: '',
    keywords: SHELL_KEYWORDS,
  }),
  ...forEach('sql', {
    lineComment: '--',
    blockComment: ['/*', '*/'],
    quotes: `'"`,
    spanningQuotes: '',
    keywords: SQL_KEYWORDS,
    ignoreKeywordCase: true,
  }),
  ...forEach('yaml yml toml ini', {
    lineComment: '#',
    quotes: `'"`,
    spanningQuotes: '',
    keywords: JSON_KEYWORDS,
  }),
  ...forEach('css scss less', {
    blockComment: ['/*', '*/'],
    quotes: `'"`,
    spanningQuotes: '',
    keywords: words('and false important not null or true'),
  }),
};

/** One grammar under several names, so the table reads as the list it is. */
function forEach(names: string, grammar: Grammar): Record<string, Grammar> {
  return Object.fromEntries(names.split(' ').map((name) => [name, grammar]));
}

const PUNCTUATION = new Set('{}[]()<>.,;:+-*/%=!&|^~?@#');

/**
 * `code[index]`, with the past-the-end case spelled once.
 *
 * `noUncheckedIndexedAccess` types every index read as `string | undefined`, and
 * nine `?? ''` fallbacks scattered through the scanner are nine places to get the
 * same one-character branch wrong.
 */
// Stryker disable next-line all: only reachable past the end of the input, where
// any fallback that is not a digit, an identifier character or a quote behaves the same.
const charAt = (code: string, index: number): string => code[index] ?? '';

const isDigit = (char: string): boolean => char >= '0' && char <= '9';
const isIdentifierStart = (char: string): boolean => /[A-Za-z_$]/.test(char);
const isIdentifierPart = (char: string): boolean => /[\w$]/.test(char);

/** Where a token ends and what it is. `end` is always past `index`, so scanning terminates. */
interface Match {
  readonly kind: TokenKind;
  readonly end: number;
}

type Matcher = (code: string, index: number, grammar: Grammar) => Match | undefined;

const matchLineComment: Matcher = (code, index, grammar) => {
  if (grammar.lineComment === undefined || !code.startsWith(grammar.lineComment, index)) return;
  const newline = code.indexOf('\n', index);
  return { kind: 'comment', end: newline === -1 ? code.length : newline };
};

const matchBlockComment: Matcher = (code, index, grammar) => {
  if (grammar.blockComment === undefined) return;
  const [open, close] = grammar.blockComment;
  if (!code.startsWith(open, index)) return;
  const closed = code.indexOf(close, index + open.length);
  // An unterminated block comment runs to the end, which is what a compiler sees
  // too — and what a half-streamed answer produces constantly.
  return { kind: 'comment', end: closed === -1 ? code.length : closed + close.length };
};

const matchString: Matcher = (code, index, grammar) => {
  const quote = charAt(code, index);
  const spanning = grammar.spanningQuotes.includes(quote);
  if (!spanning && !grammar.quotes.includes(quote)) return;

  let cursor = index + 1;
  // Stryker disable next-line EqualityOperator: one extra pass past the end reads
  // no character and falls out of the same return — see docs/testing.md.
  while (cursor < code.length) {
    const char = code[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === quote) return { kind: 'string', end: cursor + 1 };
    // An unterminated quote must not paint the rest of the file as a string;
    // half a streamed line is the common case, not a broken snippet.
    if (char === '\n' && !spanning) return { kind: 'string', end: cursor };
    cursor += 1;
  }
  return { kind: 'string', end: code.length };
};

/**
 * The sign of an exponent belongs to the number — `1e-9` is one literal — but the
 * `E` of a hex literal is a digit, so `0xE-1` is a subtraction.
 */
const isExponentSign = (code: string, start: number, at: number): boolean =>
  (code[at] === '+' || code[at] === '-') &&
  /[Ee]/.test(charAt(code, at - 1)) &&
  isDigit(charAt(code, at + 1)) &&
  // Stryker disable next-line Regex: the anchor only matters for a literal that
  // contains `0x` after its first character, which no language has.
  !/^0[BOXbox]/.test(code.slice(start, at));

const matchNumber: Matcher = (code, index) => {
  if (!isDigit(charAt(code, index))) return;
  let end = index;
  // Stryker disable next-line EqualityOperator: past the end `charAt` returns '',
  // which is neither a digit nor a word character, so the loop stops either way.
  while (end < code.length) {
    const char = charAt(code, end);
    if (isExponentSign(code, index, end)) {
      end += 1;
      continue;
    }
    // A '.' belongs to the number only ahead of a digit, so `1.toFixed` keeps its
    // punctuation and Rust's `0..10` stays a range.
    if (char === '.' && !isDigit(charAt(code, end + 1))) break;
    if (!/[\w.]/.test(char)) break;
    end += 1;
  }
  return { kind: 'number', end };
};

/** A call is an identifier with a `(` after it, whatever the language calls one. */
const isCall = (code: string, from: number): boolean => {
  let cursor = from;
  while (code[cursor] === ' ' || code[cursor] === '\t') cursor += 1;
  return code[cursor] === '(';
};

const matchWord: Matcher = (code, index, grammar) => {
  if (!isIdentifierStart(charAt(code, index))) return;
  let end = index;
  // Stryker disable next-line EqualityOperator,ConditionalExpression: the bound is
  // belt and braces — `isIdentifierPart('')` already stops the walk at the end.
  while (end < code.length && isIdentifierPart(charAt(code, end))) end += 1;

  const word = code.slice(index, end);
  const lookup = grammar.ignoreKeywordCase === true ? word.toLowerCase() : word;
  if (grammar.keywords.has(lookup)) return { kind: 'keyword', end };
  if (isCall(code, end)) return { kind: 'function', end };
  // Capitalised is a good enough proxy for a type across every language here, and
  // being wrong about one costs a colour rather than a meaning.
  return { kind: /^[A-Z]/.test(word) ? 'type' : 'plain', end };
};

const MATCHERS: readonly Matcher[] = [
  matchLineComment,
  matchBlockComment,
  matchString,
  matchNumber,
  matchWord,
];

/** Runs of one kind become one span; a span per character of indentation would
 * treble the node count of every block. */
const append = (tokens: Token[], kind: TokenKind, value: string): void => {
  const last = tokens.at(-1);
  if (last?.kind === kind) tokens[tokens.length - 1] = { kind, value: last.value + value };
  else tokens.push({ kind, value });
};

/**
 * Splits `code` into typed tokens. Every character of the input appears in
 * exactly one token, in order, so the rendered block is always the source the
 * model wrote — the property `highlight.test.ts` checks hardest.
 */
export const highlight = (code: string, language?: string): readonly Token[] => {
  const grammar = language === undefined ? undefined : GRAMMARS[language.toLowerCase()];
  if (grammar === undefined) return code.length === 0 ? [] : [{ kind: 'plain', value: code }];

  const tokens: Token[] = [];
  let index = 0;

  while (index < code.length) {
    const match = MATCHERS.reduce<Match | undefined>(
      (found, matcher) => found ?? matcher(code, index, grammar),
      undefined,
    );

    if (match === undefined) {
      const char = charAt(code, index);
      append(tokens, PUNCTUATION.has(char) ? 'punctuation' : 'plain', char);
      index += 1;
      continue;
    }

    append(tokens, match.kind, code.slice(index, match.end));
    index = match.end;
  }

  return tokens;
};
