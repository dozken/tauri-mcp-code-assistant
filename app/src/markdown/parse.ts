/**
 * A deliberately small Markdown subset, parsed to data rather than to HTML.
 *
 * A real Markdown library plus a sanitiser costs roughly 19 kB gzipped against a
 * 200 kB budget that is already at 188 kB, and every one of them ends at
 * `dangerouslySetInnerHTML` — an HTML injection surface fed directly by model
 * output and by whatever happens to be in the user's indexed code. Parsing to a
 * typed tree that React renders as elements has no such surface: there is no
 * point at which a string becomes markup.
 *
 * The subset is what a model actually emits in an answer about code: fenced
 * blocks, headings, lists, and inline emphasis and code spans. Anything outside
 * it renders as the literal text the model wrote, which is the behaviour the
 * whole file existed to fix.
 */

interface InlineText {
  readonly kind: 'text';
  readonly value: string;
}
interface InlineCode {
  readonly kind: 'code';
  readonly value: string;
}
interface InlineStrong {
  readonly kind: 'strong';
  readonly children: readonly Inline[];
}
interface InlineEmphasis {
  readonly kind: 'emphasis';
  readonly children: readonly Inline[];
}

/** The members are internal; only the unions are part of the module's surface. */
export type Inline = InlineText | InlineCode | InlineStrong | InlineEmphasis;

interface ParagraphBlock {
  readonly kind: 'paragraph';
  readonly spans: readonly Inline[];
}
interface HeadingBlock {
  readonly kind: 'heading';
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly spans: readonly Inline[];
}
interface ListBlock {
  readonly kind: 'list';
  readonly ordered: boolean;
  readonly items: readonly (readonly Inline[])[];
}
interface CodeBlock {
  readonly kind: 'codeBlock';
  readonly language?: string;
  readonly content: string;
}

export type Block = ParagraphBlock | HeadingBlock | ListBlock | CodeBlock;

/** A fence line on its own: optional indent, three-or-more backticks, optional info string. */
const FENCE_LINE = /^[ \t]*(`{3,})([\w+-]*)[ \t]*$/;
/**
 * Block markers are recognised by scanning, not by regex.
 *
 * The obvious patterns (`^(#{1,6})\s+(.*)$` and friends) put `\s+` next to `.`,
 * which overlap and backtrack super-linearly on a line of runs of whitespace.
 * These run on every line of every render of a streaming answer, so they are
 * written as plain character walks that cannot backtrack at all.
 */
const isSpace = (character: string | undefined): boolean => character === ' ' || character === '\t';

const BULLET_MARKERS = new Set(['-', '*', '+']);

const isDigit = (character: string | undefined): boolean =>
  character !== undefined && character >= '0' && character <= '9';

const skipIndent = (line: string): number => {
  let index = 0;
  while (isSpace(line[index])) index += 1;
  return index;
};

interface HeadingMatch {
  readonly level: HeadingBlock['level'];
  readonly text: string;
}

const matchHeading = (line: string): HeadingMatch | undefined => {
  let hashes = 0;
  while (line[hashes] === '#') hashes += 1;
  // A bare `#hashtag` is prose; a heading needs whitespace after the run.
  if (hashes === 0 || hashes > 6 || !isSpace(line[hashes])) return undefined;
  return { level: hashes as HeadingBlock['level'], text: line.slice(hashes).trim() };
};

interface ListMatch {
  readonly ordered: boolean;
  readonly item: string;
}

const matchListItem = (line: string): ListMatch | undefined => {
  const start = skipIndent(line);
  const first = line[start];
  if (first === undefined) return undefined;

  if (BULLET_MARKERS.has(first)) {
    if (!isSpace(line[start + 1])) return undefined;
    const item = line.slice(start + 2).trim();
    return item === '' ? undefined : { ordered: false, item };
  }

  let digits = start;
  for (
    let character = line[digits];
    digits - start < 9 && isDigit(character);
    character = line[digits]
  ) {
    digits += 1;
  }
  if (digits === start) return undefined;
  const delimiter = line[digits];
  if ((delimiter !== '.' && delimiter !== ')') || !isSpace(line[digits + 1])) return undefined;
  const item = line.slice(digits + 2).trim();
  return item === '' ? undefined : { ordered: true, item };
};

interface Fence {
  readonly marker: string;
  readonly language?: string;
}

const matchFence = (line: string): Fence | undefined => {
  const match = FENCE_LINE.exec(line);
  if (match?.[1] === undefined) return undefined;
  return { marker: match[1], language: match[2] === '' ? undefined : match[2] };
};

/**
 * Inline marks, matched left to right in one pass, with named groups so the
 * alternation stays readable.
 *
 * Code spans come first and win: inside backticks, `**` is two asterisks and not
 * emphasis, which is exactly what a snippet of C or a glob pattern needs.
 *
 * Underscores are treated as word characters, which is stricter than CommonMark
 * and deliberate: this app talks about code. `some_long_name_here` must stay one
 * identifier, and `__init__` must stay a dunder rather than becoming bold "init".
 * The cost is that `__bold__` renders literally - a fair trade, since a model
 * emits `**bold**` far more often than it emits a dunder by accident, and the
 * reverse mistake corrupts source identifiers on screen.
 */
const STRONG = /\*\*(?<strongStar>\S|\S[\s\S]*?\S)\*\*/;
const EMPHASIS_STAR = /\*(?<emStar>\S|\S[\s\S]*?\S)\*/;
const EMPHASIS_SCORE = /(?<![\p{L}\p{N}_])_(?!_)(?<emScore>\S|\S[\s\S]*?[^\s_])_(?![\p{L}\p{N}_])/u;

// Order is precedence: `**` binds before `*`.
const INLINE = new RegExp(
  [STRONG, EMPHASIS_STAR, EMPHASIS_SCORE].map((part) => part.source).join('|'),
  'gu',
);

/** Length of the backtick run starting at `index`, or 0. */
const backtickRun = (text: string, index: number): number => {
  let length = 0;
  while (text[index + length] === '`') length += 1;
  return length;
};

/** Index of the next backtick run of exactly `length`, scanning forward only. */
const findCloser = (text: string, from: number, length: number): number => {
  for (let cursor = from; cursor < text.length;) {
    const run = backtickRun(text, cursor);
    if (run === length) return cursor;
    cursor += run > 0 ? run : 1;
  }
  return -1;
};

/**
 * Splits a line into code spans and the prose between them, by scanning.
 *
 * The regex form of this — a backreferenced lazy run — is super-linear on an
 * unclosed backtick, which a streaming answer produces on almost every frame.
 * Scanning also makes "a code span wins over emphasis" a structural fact rather
 * than a matter of alternation order: emphasis is only ever applied to prose.
 */
const splitCodeSpans = (text: string): { readonly code: boolean; readonly value: string }[] => {
  const parts: { code: boolean; value: string }[] = [];
  let prose = '';

  for (let index = 0; index < text.length;) {
    const opener = backtickRun(text, index);
    if (opener === 0) {
      prose += text.slice(index, index + 1);
      index += 1;
      continue;
    }

    const cursor = findCloser(text, index + opener, opener);
    if (cursor === -1) {
      // Unclosed: the backticks are literal text, which is the mid-stream state.
      prose += text.slice(index, index + opener);
      index += opener;
      continue;
    }

    if (prose !== '') parts.push({ code: false, value: prose });
    prose = '';
    parts.push({ code: true, value: text.slice(index + opener, cursor).trim() });
    index = cursor + opener;
  }

  if (prose !== '') parts.push({ code: false, value: prose });
  return parts;
};

/**
 * A character no answer contains, standing in for a code span while emphasis is
 * matched. Masking is what lets the two nest in either direction: `` `a ** b` ``
 * keeps its asterisks literal, and ``_set `X` now_`` is still one italic run.
 */
const CODE_PLACEHOLDER = '\u0000';

export const parseInline = (text: string): Inline[] => {
  const parts = splitCodeSpans(text);
  const codes = parts.filter((part) => part.code).map((part) => part.value);
  if (codes.length === 0) return parseEmphasis(text);

  const masked = parts.map((part) => (part.code ? CODE_PLACEHOLDER : part.value)).join('');
  return restoreCodeSpans(parseEmphasis(masked), codes);
};

/** Puts the code spans back where their placeholders ended up, in document order. */
const restoreCodeSpans = (spans: readonly Inline[], queue: string[]): Inline[] =>
  spans.flatMap<Inline>((span) => {
    if (span.kind === 'strong') {
      return [{ kind: 'strong', children: restoreCodeSpans(span.children, queue) }];
    }
    if (span.kind === 'emphasis') {
      return [{ kind: 'emphasis', children: restoreCodeSpans(span.children, queue) }];
    }
    if (span.kind !== 'text') return [span];

    const pieces = span.value.split(CODE_PLACEHOLDER);
    return pieces.flatMap<Inline>((piece, index) => {
      const restored: Inline[] = piece === '' ? [] : [{ kind: 'text', value: piece }];
      if (index === pieces.length - 1) return restored;
      const value = queue.shift();
      return value === undefined ? restored : [...restored, { kind: 'code', value }];
    });
  });

/** Emphasis only, over a run of prose that is known to contain no code span. */
const parseEmphasis = (text: string): Inline[] => {
  const spans: Inline[] = [];
  let lastIndex = 0;
  // A fresh matcher per call: `lastIndex` is per-regex state, and the recursion
  // below would otherwise rewind the scan its own caller is in the middle of.
  const matcher = new RegExp(INLINE.source, INLINE.flags);

  const pushText = (value: string): void => {
    if (value.length > 0) spans.push({ kind: 'text', value });
  };

  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    pushText(text.slice(lastIndex, match.index));

    const groups = match.groups;
    const strong = groups?.strongStar;
    const emphasis = groups?.emStar ?? groups?.emScore;
    // The content is strictly shorter each time, so the recursion terminates.
    if (strong !== undefined) spans.push({ kind: 'strong', children: parseEmphasis(strong) });
    else if (emphasis !== undefined)
      spans.push({ kind: 'emphasis', children: parseEmphasis(emphasis) });

    lastIndex = match.index + match[0].length;
    // A zero-length match would spin forever; the alternatives all require at
    // least one inner character, but the guard is cheaper than trusting that.
    if (match[0].length === 0) matcher.lastIndex += 1;
  }

  pushText(text.slice(lastIndex));
  return spans;
};

type LineKind =
  | { readonly kind: 'fence'; readonly fence: Fence }
  | { readonly kind: 'heading'; readonly heading: HeadingMatch }
  | { readonly kind: 'listItem'; readonly item: ListMatch }
  | { readonly kind: 'blank' }
  | { readonly kind: 'prose' };

/** One decision per line, so the accumulator below stays a flat dispatch. */
const classifyLine = (line: string): LineKind => {
  const fence = matchFence(line);
  if (fence) return { kind: 'fence', fence };

  const heading = matchHeading(line);
  if (heading) return { kind: 'heading', heading };

  const item = matchListItem(line);
  if (item) return { kind: 'listItem', item };

  return line.trim() === '' ? { kind: 'blank' } : { kind: 'prose' };
};

/**
 * Splits an answer into blocks.
 *
 * Scanned line by line rather than with one big regex: a lazy `([\s\S]*?)` closed
 * by a backreference is quadratic on unbalanced input, and this runs on every
 * render of every streamed token — so a half-typed fence would be re-scanned
 * hundreds of times per answer.
 */
export const parseBlocks = (content: string): Block[] => {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let fence: Fence | undefined;
  let code: string[] = [];

  const flushParagraph = (): void => {
    const text = paragraph.join('\n').trim();
    if (text.length > 0) blocks.push({ kind: 'paragraph', spans: parseInline(text) });
    paragraph = [];
  };

  const flushList = (): void => {
    if (list && list.items.length > 0) {
      blocks.push({
        kind: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item)),
      });
    }
    list = undefined;
  };

  const flushText = (): void => {
    flushParagraph();
    flushList();
  };

  const appendListItem = (item: ListMatch): void => {
    flushParagraph();
    // A change of marker starts a new list rather than mixing the two.
    if (list && list.ordered !== item.ordered) flushList();
    list ??= { ordered: item.ordered, items: [] };
    list.items.push(item.item);
  };

  for (const line of content.split('\n')) {
    if (fence !== undefined) {
      const closer = matchFence(line);
      // Only a fence at least as long as the opener closes it, so an inner ``` inside
      // a ```` block stays part of the snippet.
      if (closer && closer.marker.length >= fence.marker.length && closer.language === undefined) {
        blocks.push({ kind: 'codeBlock', language: fence.language, content: code.join('\n') });
        fence = undefined;
        code = [];
      } else {
        code.push(line);
      }
      continue;
    }

    const classified = classifyLine(line);
    switch (classified.kind) {
      case 'fence': {
        flushText();
        fence = classified.fence;
        break;
      }
      case 'heading': {
        flushText();
        blocks.push({
          kind: 'heading',
          level: classified.heading.level,
          spans: parseInline(classified.heading.text),
        });
        break;
      }
      case 'listItem': {
        appendListItem(classified.item);
        break;
      }
      case 'blank': {
        flushText();
        break;
      }
      case 'prose': {
        flushList();
        paragraph.push(line);
        break;
      }
    }
  }

  flushText();
  // An unterminated fence is the normal mid-stream state, not an error: render
  // what has arrived so far as code so the block does not flicker into prose.
  if (fence !== undefined && code.length > 0) {
    blocks.push({ kind: 'codeBlock', language: fence.language, content: code.join('\n') });
  }
  return blocks;
};
