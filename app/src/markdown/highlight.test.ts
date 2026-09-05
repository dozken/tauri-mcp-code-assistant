import { describe, expect, it } from 'vitest';
import { highlight, type Token, type TokenKind } from './highlight';

const kinds = (code: string, language?: string): TokenKind[] =>
  highlight(code, language).map((token) => token.kind);

const text = (tokens: readonly Token[]): string => tokens.map((token) => token.value).join('');

/** Every token of one kind, in order — what a colour assertion actually cares about. */
const of = (code: string, language: string, kind: TokenKind): string[] =>
  highlight(code, language)
    .filter((token) => token.kind === kind)
    .map((token) => token.value);

describe('highlight keeps the source intact', () => {
  const samples = [
    '',
    'const x = 1;',
    '// just a comment',
    '/* unterminated',
    '"unterminated',
    '`spanning\nliteral`',
    String.raw`x = "a\"b" + 1.5e-3;`,
    'def f(a, b):\n    return a + b  # sum\n',
    'SELECT * FROM t -- all\n',
    '\t  \n\n   ',
    'emoji = "🙂"; naïve = 1',
    '0..10',
  ];

  for (const [index, sample] of samples.entries()) {
    it(`loses nothing from sample ${String(index)}`, () => {
      for (const language of ['ts', 'python', 'sql', 'rust', undefined]) {
        expect(text(highlight(sample, language))).toBe(sample);
      }
    });
  }

  it('loses nothing from random input', () => {
    // A highlighter that drops or reorders a character silently corrupts code the
    // user is about to copy, so this is the property worth fuzzing. Seeded, so a
    // failure is reproducible rather than a rumour.
    let seed = 0x2f6e_2b1;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    // Indexed rather than split into an array: ASCII only, so one code unit is
    // one character, and no lint rule has an opinion about it.
    const alphabet = 'ab {}()[]<>\'"`\\/*#-+.,;:=\n\t0123456789_$';

    for (let round = 0; round < 300; round += 1) {
      const length = Math.floor(next() * 60);
      const code = Array.from(
        { length },
        () => alphabet[Math.floor(next() * alphabet.length)] ?? '',
      ).join('');

      expect(text(highlight(code, 'ts'))).toBe(code);
    }
  });
});

describe('highlight only colours languages it knows', () => {
  it('leaves an unknown language alone rather than guessing', () => {
    expect(highlight('const x = 1;', 'brainfuck')).toEqual([
      { kind: 'plain', value: 'const x = 1;' },
    ]);
  });

  it('leaves a fence with no info string alone', () => {
    expect(highlight('const x = 1;')).toEqual([{ kind: 'plain', value: 'const x = 1;' }]);
  });

  it('has nothing to say about an empty block', () => {
    expect(highlight('', 'ts')).toEqual([]);
    expect(highlight('')).toEqual([]);
  });

  it('matches the language name whatever case the model wrote it in', () => {
    expect(kinds('const', 'TypeScript')).toEqual(['keyword']);
  });
});

/**
 * Every grammar in the table is a claim that a language is supported. One case per
 * family checks the three things that make a snippet readable — its comments, its
 * strings and its keywords — because a table entry nothing exercises is a language
 * that quietly stopped working.
 */
describe('highlight covers each language it lists', () => {
  const cases: [
    language: string,
    source: string,
    expected: { comment: string[]; string: string[]; keyword: string[] },
  ][] = [
    [
      'ts',
      "// note\nconst greeting = 'hi';",
      { comment: ['// note'], string: ["'hi'"], keyword: ['const'] },
    ],
    [
      'json',
      '// note\n{ "enabled": true }',
      { comment: ['// note'], string: ['"enabled"'], keyword: ['true'] },
    ],
    [
      'python',
      "# note\ndef greet(name): return 'hi'",
      { comment: ['# note'], string: ["'hi'"], keyword: ['def', 'return'] },
    ],
    [
      'rust',
      '// note\nlet name: String = "hi".to_string();',
      { comment: ['// note'], string: ['"hi"'], keyword: ['let'] },
    ],
    [
      'go',
      '// note\nfunc main() { s := `raw` }',
      { comment: ['// note'], string: ['`raw`'], keyword: ['func'] },
    ],
    [
      'java',
      '// note\npublic class Greeter { String name = "hi"; }',
      { comment: ['// note'], string: ['"hi"'], keyword: ['public', 'class'] },
    ],
    [
      'bash',
      "# note\nexport NAME='hi'",
      { comment: ['# note'], string: ["'hi'"], keyword: ['export'] },
    ],
    [
      'sql',
      "-- note\nSELECT name FROM users WHERE name = 'hi'",
      { comment: ['-- note'], string: ["'hi'"], keyword: ['SELECT', 'FROM', 'WHERE'] },
    ],
    [
      'yaml',
      "# note\nname: 'hi'\nenabled: true",
      { comment: ['# note'], string: ["'hi'"], keyword: ['true'] },
    ],
    [
      'css',
      "/* note */\n.a { content: 'hi'; color: red !important; }",
      { comment: ['/* note */'], string: ["'hi'"], keyword: ['important'] },
    ],
  ];

  it.each(cases)('reads %s', (language, source, expected) => {
    expect({
      comment: of(source, language, 'comment'),
      string: of(source, language, 'string'),
      keyword: of(source, language, 'keyword'),
    }).toEqual(expected);
  });

  it('keeps the whole keyword list, not just its first line', () => {
    // Each of these sits on a different line of its list. A line lost in an edit
    // shows up here rather than as a word that quietly stopped being coloured.
    const samples: [language: string, word: string][] = [
      ['ts', 'export'],
      ['ts', 'let'],
      ['ts', 'yield'],
      ['python', 'yield'],
      ['rust', 'match'],
      ['go', 'switch'],
      ['java', 'float'],
      ['java', 'volatile'],
      ['sql', 'insert'],
      ['sql', 'values'],
    ];

    for (const [language, word] of samples) {
      expect(of(`${word} x`, language, 'keyword')).toEqual([word]);
    }
  });

  it('reads a block comment in SQL as well as a double dash', () => {
    expect(of('/* why */ SELECT 1 -- also why', 'sql', 'comment')).toEqual([
      '/* why */',
      '-- also why',
    ]);
  });

  it('takes SQL in either case, because both are written', () => {
    expect(of('select 1', 'sql', 'keyword')).toEqual(['select']);
    expect(of('SELECT 1', 'sql', 'keyword')).toEqual(['SELECT']);
    // Only SQL: `Const` is not `const` in a language that means both.
    expect(of('Const x', 'ts', 'keyword')).toEqual([]);
  });

  it('has no line comment in a language that defines none', () => {
    // The guard reads `lineComment === undefined`, and dropping it makes the
    // scanner hunt for the literal text "undefined" instead — which is the only
    // input that tells the two apart.
    expect(of('.a { content: undefined; }', 'css', 'comment')).toEqual([]);
  });
});

describe('highlight reads comments', () => {
  it('ends a line comment at the newline, not at the end of the block', () => {
    expect(of('let a = 1; // why\nlet b = 2;', 'ts', 'comment')).toEqual(['// why']);
  });

  it('runs an unterminated block comment to the end, as a compiler would', () => {
    expect(of('/* half a thought', 'ts', 'comment')).toEqual(['/* half a thought']);
  });

  it('ends a closed block comment where it closes, and lets the code resume', () => {
    expect(of('/* a */ const x', 'ts', 'comment')).toEqual(['/* a */']);
    expect(of('/* a */ const x', 'ts', 'keyword')).toEqual(['const']);
  });

  it('does not let a block comment close on its own opening slash', () => {
    // `/*/*/` is one comment: the search for `*/` starts after the `/*`, not at it.
    expect(highlight('/*/*/', 'ts')).toEqual([{ kind: 'comment', value: '/*/*/' }]);
  });

  it('takes # as a comment in Python and as punctuation in TypeScript', () => {
    expect(of('x = 1  # note', 'python', 'comment')).toEqual(['# note']);
    expect(of('#note', 'ts', 'comment')).toEqual([]);
    expect(kinds('#', 'ts')).toEqual(['punctuation']);
  });

  it('knows SQL comments start with two dashes, not one', () => {
    expect(of('SELECT 1 -- why\n', 'sql', 'comment')).toEqual(['-- why']);
    expect(of('SELECT 1 - 2', 'sql', 'comment')).toEqual([]);
  });
});

describe('highlight reads strings', () => {
  it('keeps an escaped quote inside the string', () => {
    expect(of(String.raw`"a\"b" + c`, 'ts', 'string')).toEqual([String.raw`"a\"b"`]);
  });

  it('stops an unterminated quote at the newline, so one typo does not stain the block', () => {
    expect(of('"oops\nconst x = 1;', 'ts', 'string')).toEqual(['"oops']);
    expect(of('"oops\nconst x = 1;', 'ts', 'keyword')).toEqual(['const']);
  });

  it('lets a template literal span lines, because that is what it is for', () => {
    expect(of('`line\nline`', 'ts', 'string')).toEqual(['`line\nline`']);
  });

  it('still calls an unclosed string at the end of the block a string', () => {
    expect(kinds('"oops', 'ts')).toEqual(['string']);
  });

  it('does not treat a backtick as a string in a language without them', () => {
    expect(of('`x`', 'python', 'string')).toEqual([]);
  });
});

describe('highlight reads numbers', () => {
  it('takes hex, exponents and digit separators as one number', () => {
    expect(of('0x1f + 1e-9 + 1_000', 'ts', 'number')).toEqual(['0x1f', '1e-9', '1_000']);
  });

  it('does not mistake the E of a hex literal for an exponent', () => {
    // `0xE-1` is a subtraction; reading the minus as an exponent sign would make
    // it one number and quietly change what the block appears to say.
    expect(of('0xE-1', 'ts', 'number')).toEqual(['0xE', '1']);
    expect(kinds('0xE-1', 'ts')).toEqual(['number', 'punctuation', 'number']);
  });

  it('keeps the dot in 1.5 and gives it back in 1.toFixed', () => {
    expect(of('1.5', 'ts', 'number')).toEqual(['1.5']);
    expect(kinds('1.x', 'ts')).toEqual(['number', 'punctuation', 'plain']);
  });

  it('leaves a Rust range as a range', () => {
    expect(kinds('0..10', 'rust')).toEqual(['number', 'punctuation', 'number']);
  });

  it('takes a positive exponent as readily as a negative one', () => {
    expect(of('1e+9', 'ts', 'number')).toEqual(['1e+9']);
  });

  it('only joins a sign to a number after an exponent', () => {
    // Subtraction and multiplication are operators, not part of the literal.
    expect(kinds('1-2', 'ts')).toEqual(['number', 'punctuation', 'number']);
    expect(kinds('1e*2', 'ts')).toEqual(['number', 'punctuation', 'number']);
  });
});

describe('highlight reads identifiers', () => {
  it('marks a keyword as a keyword even when it is called like a function', () => {
    // `typeof(x)` is a keyword and a parenthesis, not a call.
    expect(kinds('typeof(x)', 'ts')).toEqual(['keyword', 'punctuation', 'plain', 'punctuation']);
  });

  it('marks an identifier before a bracket as a call, through the whitespace', () => {
    expect(of('doThing ()', 'ts', 'function')).toEqual(['doThing']);
    expect(of('doThing\t()', 'ts', 'function')).toEqual(['doThing']);
    expect(of('doThing;', 'ts', 'function')).toEqual([]);
  });

  it('takes a capitalised word for a type, and only a capitalised one', () => {
    expect(of('let x: Widget;', 'ts', 'type')).toEqual(['Widget']);
    // camelCase is a variable, however many capitals it has after the first letter.
    expect(of('let myWidget = 1;', 'ts', 'type')).toEqual([]);
  });

  it('does not find TypeScript keywords in Python, or the other way round', () => {
    expect(of('const x = 1', 'python', 'keyword')).toEqual([]);
    expect(of('elif x:', 'ts', 'keyword')).toEqual([]);
  });
});

describe('highlight keeps the DOM small', () => {
  it('merges a run of one kind into a single token', () => {
    // One span per character of indentation would treble the node count of every
    // block, and this component re-renders on every streamed token.
    expect(highlight('    a b c', 'ts')).toEqual([{ kind: 'plain', value: '    a b c' }]);
  });
});
