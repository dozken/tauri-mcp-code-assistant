import { describe, expect, it } from 'vitest';
import { parseBlocks, parseInline, type Block } from './parse';

const text = (value: string) => ({ kind: 'text', value });
const code = (value: string) => ({ kind: 'code', value });
const strong = (...children: unknown[]) => ({ kind: 'strong', children });
const emphasis = (...children: unknown[]) => ({ kind: 'emphasis', children });

describe('parseInline', () => {
  it('leaves plain prose alone', () => {
    expect(parseInline('just words')).toEqual([text('just words')]);
  });

  it.each([
    ['**bold**', strong(text('bold'))],
    ['*italic*', emphasis(text('italic'))],
    ['_italic_', emphasis(text('italic'))],
    ['`code`', code('code')],
  ])('parses %s', (input, expected) => {
    expect(parseInline(input)).toEqual([expected]);
  });

  it('keeps the surrounding prose', () => {
    expect(parseInline('set `API_KEY` first')).toEqual([
      text('set '),
      code('API_KEY'),
      text(' first'),
    ]);
  });

  it('treats a code span as literal, so ** inside it is not emphasis', () => {
    expect(parseInline('use `a ** b` here')).toEqual([text('use '), code('a ** b'), text(' here')]);
  });

  it('prefers strong over emphasis for a double marker', () => {
    expect(parseInline('**both**')).toEqual([strong(text('both'))]);
  });

  it.each([
    ['arithmetic', 'a * b * c'],
    ['a snake_case identifier', 'some_long_name_here'],
    ['a lone marker', 'a * b'],
    ['an unclosed marker', '**not closed'],
    ['an unclosed code span', '`not closed'],
  ])('leaves %s as text', (_label, input) => {
    expect(parseInline(input)).toEqual([text(input)]);
  });

  it.each([
    ['a snake_case identifier', 'some_long_name_here'],
    ['a leading underscore', '_privateField'],
    ['a dunder name', '__init__ and __main__'],
    ['a dunder alone', '__all__'],
    ['a URL fragment', 'see docs_v2_final for details'],
    ['literal double underscores', '__bold__'],
  ])('leaves %s alone: underscore counts as a word character here', (_label, input) => {
    expect(parseInline(input)).toEqual([text(input)]);
  });

  it('still emphasises an underscore pair at word boundaries', () => {
    expect(parseInline('set _this_ now')).toEqual([
      text('set '),
      emphasis(text('this')),
      text(' now'),
    ]);
  });

  it('allows an asterisk pair inside a word, which CommonMark does', () => {
    expect(parseInline('a*b*c')).toEqual([text('a'), emphasis(text('b')), text('c')]);
  });

  it('handles several marks in one line', () => {
    expect(parseInline('**a** and `b` and _c_')).toEqual([
      strong(text('a')),
      text(' and '),
      code('b'),
      text(' and '),
      emphasis(text('c')),
    ]);
  });

  it('nests a code span inside emphasis, which is how a model cites a variable', () => {
    expect(parseInline('_set `API_KEY` now_')).toEqual([
      emphasis(text('set '), code('API_KEY'), text(' now')),
    ]);
  });

  it('nests emphasis inside strong', () => {
    expect(parseInline('**very *odd* indeed**')).toEqual([
      strong(text('very '), emphasis(text('odd')), text(' indeed')),
    ]);
  });

  it('supports a doubled backtick span containing a backtick', () => {
    expect(parseInline('``a ` b``')).toEqual([code('a ` b')]);
  });

  it('returns nothing for an empty string', () => {
    expect(parseInline('')).toEqual([]);
  });
});

describe('block markers, at their edges', () => {
  const first = (input: string): Block | undefined => parseBlocks(input)[0];

  it.each([1, 2, 3, 4, 5, 6])('accepts %i hashes as a heading', (level) => {
    expect(first(`${'#'.repeat(level)} Title`)).toMatchObject({ kind: 'heading', level });
  });

  it('stops at six, because there is no h7 to render it as', () => {
    expect(first('####### Title')).toMatchObject({ kind: 'paragraph' });
  });

  it('accepts a tab after the hashes, not only a space', () => {
    // Models indent with tabs often enough that treating one as prose is visible.
    expect(first('#\tTitle')).toMatchObject({ kind: 'heading', level: 1 });
  });

  it.each(['0. zero', '9. nine'])('treats %s as an ordered item', (line) => {
    expect(first(line)).toMatchObject({ kind: 'list', ordered: true });
  });

  it.each(['1) parenthesis', '1. period'])('accepts %s as the delimiter', (line) => {
    expect(first(line)).toMatchObject({ kind: 'list', ordered: true });
  });

  it.each(['1: colon', '1- dash', '1.no space'])('rejects %s as a list', (line) => {
    expect(first(line)).toMatchObject({ kind: 'paragraph' });
  });

  it('gives up on a number too long to be a list marker', () => {
    // Nine digits is already absurd for a list; past that it is prose that
    // happens to start with a number, like a phone number or an ID.
    expect(first('1234567890. not a list')).toMatchObject({ kind: 'paragraph' });
    expect(first('123456789. still a list')).toMatchObject({ kind: 'list' });
  });

  it.each(['- ', '1. ', '-   '])('does not open a list for the empty item %p', (line) => {
    expect(first(line)).toMatchObject({ kind: 'paragraph' });
  });

  it('trims the item text, so trailing spaces do not reach the DOM', () => {
    expect(first('-   spaced out   ')).toMatchObject({
      kind: 'list',
      items: [[{ kind: 'text', value: 'spaced out' }]],
    });
  });

  it('treats a whitespace-only line as a blank, so it separates paragraphs', () => {
    expect(parseBlocks('one\n   \ntwo')).toHaveLength(2);
  });

  it.each(['text ```', '``` trailing text', '`` too few'])(
    'does not open a fence for %p',
    (line) => {
      expect(first(`${line}\nbody`)).toMatchObject({ kind: 'paragraph' });
    },
  );

  it('closes a fence only on a bare marker, never on one carrying a language', () => {
    // ```ts inside a block is content — a nested example, which models emit
    // constantly — and closing on it truncates the answer mid-snippet.
    const blocks = parseBlocks('```\ninner\n```ts\nmore\n```');

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'codeBlock', content: 'inner\n```ts\nmore' });
  });

  it('joins fenced lines with newlines rather than running them together', () => {
    expect(first('```\na\nb\n```')).toMatchObject({ content: 'a\nb' });
  });
});

describe('inline scanning, at its edges', () => {
  it('trims the inside of a code span, the way CommonMark does', () => {
    expect(parseInline('` padded `')).toEqual([{ kind: 'code', value: 'padded' }]);
  });

  it('emits no empty text node around a span that fills the line', () => {
    // An empty text node renders as nothing but breaks `toEqual` comparisons and
    // multiplies the DOM on a long streamed answer.
    expect(parseInline('`only`')).toEqual([{ kind: 'code', value: 'only' }]);
    expect(parseInline('**only**')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', value: 'only' }] },
    ]);
  });

  it('keeps a code span whole inside strong, not merely inside emphasis', () => {
    expect(parseInline('**a `b` c**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'text', value: 'a ' },
          { kind: 'code', value: 'b' },
          { kind: 'text', value: ' c' },
        ],
      },
    ]);
  });

  it('leaves an unmatched backtick as literal text', () => {
    expect(parseInline('a ` b')).toEqual([{ kind: 'text', value: 'a ` b' }]);
  });

  it('terminates on input whose markers all match emptily', () => {
    // The zero-length-match guard: without it the scanner never advances and the
    // whole app hangs on one malformed line.
    expect(() => parseInline('****')).not.toThrow();
    expect(() => parseInline('``````')).not.toThrow();
    expect(() => parseInline('__')).not.toThrow();
  });
});

describe('parseBlocks', () => {
  const kinds = (blocks: Block[]) => blocks.map((block) => block.kind);

  it('returns a single paragraph for prose', () => {
    expect(parseBlocks('hello there')).toEqual([
      { kind: 'paragraph', spans: [text('hello there')] },
    ]);
  });

  it('splits paragraphs on a blank line', () => {
    expect(kinds(parseBlocks('one\n\ntwo'))).toEqual(['paragraph', 'paragraph']);
  });

  it('keeps a single newline inside one paragraph', () => {
    expect(parseBlocks('one\ntwo')).toEqual([{ kind: 'paragraph', spans: [text('one\ntwo')] }]);
  });

  it.each([
    ['# h1', 1],
    ['## h2', 2],
    ['###### h6', 6],
  ])('parses %s as a heading', (line, level) => {
    expect(parseBlocks(line)).toEqual([
      { kind: 'heading', level, spans: [text(line.split(' ', 2)[1] ?? '')] },
    ]);
  });

  it('does not treat a hash without a space as a heading', () => {
    expect(kinds(parseBlocks('#hashtag'))).toEqual(['paragraph']);
  });

  it.each([
    ['a dash list', '- one\n- two'],
    ['a star list', '* one\n* two'],
    ['a plus list', '+ one\n+ two'],
  ])('parses %s', (_label, input) => {
    expect(parseBlocks(input)).toEqual([
      { kind: 'list', ordered: false, items: [[text('one')], [text('two')]] },
    ]);
  });

  it('parses an ordered list', () => {
    expect(parseBlocks('1. one\n2. two')).toEqual([
      { kind: 'list', ordered: true, items: [[text('one')], [text('two')]] },
    ]);
  });

  it('starts a new list when the marker style changes', () => {
    expect(kinds(parseBlocks('- one\n1. two'))).toEqual(['list', 'list']);
  });

  it('parses inline marks inside list items', () => {
    expect(parseBlocks('- see `main.ts`')).toEqual([
      { kind: 'list', ordered: false, items: [[text('see '), code('main.ts')]] },
    ]);
  });

  it('parses a fenced block with its language', () => {
    expect(parseBlocks('```typescript\nconst a = 1;\n```')).toEqual([
      { kind: 'codeBlock', language: 'typescript', content: 'const a = 1;' },
    ]);
  });

  it('parses a fenced block with no language', () => {
    expect(parseBlocks('```\nplain\n```')).toEqual([
      { kind: 'codeBlock', language: undefined, content: 'plain' },
    ]);
  });

  it('does not parse markup inside a fence', () => {
    const blocks = parseBlocks('```\n# not a heading\n- not a list\n**not bold**\n```');

    expect(blocks).toEqual([
      {
        kind: 'codeBlock',
        language: undefined,
        content: '# not a heading\n- not a list\n**not bold**',
      },
    ]);
  });

  it('lets a longer fence contain a shorter one', () => {
    const blocks = parseBlocks('````\n```\ninner\n```\n````');

    expect(blocks).toEqual([
      { kind: 'codeBlock', language: undefined, content: '```\ninner\n```' },
    ]);
  });

  it('keeps an inner ``` intact inside a widened fence that carries a language', () => {
    expect(parseBlocks('````md\nSee:\n```ts\nconst a = 1;\n```\n````')).toEqual([
      { kind: 'codeBlock', language: 'md', content: 'See:\n```ts\nconst a = 1;\n```' },
    ]);
  });

  it('ignores a fence-like sequence that is not alone on its line', () => {
    expect(parseBlocks('```ts\nconst fence = "```";\n```')).toEqual([
      { kind: 'codeBlock', language: 'ts', content: 'const fence = "```";' },
    ]);
  });

  it('renders an unterminated fence as code, which is the normal streaming state', () => {
    expect(parseBlocks('```ts\nconst half =')).toEqual([
      { kind: 'codeBlock', language: 'ts', content: 'const half =' },
    ]);
  });

  it('drops an unterminated fence that has no content yet, so it cannot flicker', () => {
    expect(parseBlocks('prose\n```ts')).toEqual([{ kind: 'paragraph', spans: [text('prose')] }]);
  });

  it('keeps blank lines inside a fence', () => {
    expect(parseBlocks('```\na\n\nb\n```')).toEqual([
      { kind: 'codeBlock', language: undefined, content: 'a\n\nb' },
    ]);
  });

  it('parses a whole answer of the shape the agent actually produces', () => {
    const answer = [
      '**Offline stub model.** Here is what the index has for _"where"_:',
      '',
      '1. auth.ts:1-4 (score 0.15)',
      '',
      '```typescript',
      'export function authenticateUser() {}',
      '```',
      '',
      'Set `OPENAI_API_KEY` to answer with a real model.',
    ].join('\n');

    expect(kinds(parseBlocks(answer))).toEqual(['paragraph', 'list', 'codeBlock', 'paragraph']);
  });

  it('returns nothing for empty or whitespace-only content', () => {
    expect(parseBlocks('')).toEqual([]);
    expect(parseBlocks('   \n\n  ')).toEqual([]);
  });

  it('is linear in input size, so streaming cannot make it quadratic', () => {
    // A half-typed fence is re-parsed on every token; 20k unbalanced lines must
    // still complete promptly.
    const pathological = `\`\`\`\n${'a'.repeat(20_000)}\n${'x\n'.repeat(20_000)}`;
    const started = performance.now();

    parseBlocks(pathological);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});
