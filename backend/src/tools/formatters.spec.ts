import { describe, expect, it } from 'vitest';
import { formatExplainResult, formatSearchResult, formatSnippetResult } from './formatters.js';
import type { SearchCodeResult } from '@ai-code-companion/contracts';

const result = (text: string): SearchCodeResult => ({
  query: 'q',
  matches: [
    {
      path: '/repo/docs/guide.md',
      relativePath: 'docs/guide.md',
      language: 'markdown',
      startLine: 1,
      endLine: 5,
      score: 0.5,
      text,
    },
  ],
});

/** Number of backticks in the opening fence of the rendered block. */
const fenceLength = (rendered: string): number =>
  /\n(`{3,})markdown\n/.exec(rendered)?.[1]?.length ?? 0;

describe('formatSearchResult', () => {
  it('cites each match as path:startLine-endLine with its score', () => {
    expect(formatSearchResult(result('const a = 1;'))).toContain(
      '1. docs/guide.md:1-5 (score 0.5)',
    );
  });

  it('uses a plain fence for ordinary code', () => {
    expect(fenceLength(formatSearchResult(result('const a = 1;')))).toBe(3);
  });

  it('widens the fence so a snippet containing ``` cannot close it early', () => {
    const rendered = formatSearchResult(result('Example:\n```ts\nconst a = 1;\n```\n'));

    expect(fenceLength(rendered)).toBe(4);
    // The inner fence survives intact, and the block still closes exactly once.
    expect(rendered).toContain('```ts');
    expect(rendered.match(/^````$/gm)).toHaveLength(1);
  });

  it('widens further for nested longer fences', () => {
    expect(fenceLength(formatSearchResult(result('````\nnested\n````')))).toBe(5);
  });

  it('explains how to fix an empty result instead of returning nothing', () => {
    expect(formatSearchResult({ query: 'auth', matches: [] })).toMatch(/Index a folder first/);
  });
});

describe('formatSnippetResult', () => {
  it('fences the generated code and keeps the notes outside it', () => {
    const rendered = formatSnippetResult({
      language: 'typescript',
      code: 'export const a = 1;\n',
      notes: 'Template-generated.',
    });

    expect(rendered.startsWith('```typescript\n')).toBe(true);
    expect(rendered.endsWith('Template-generated.')).toBe(true);
  });

  describe('formatExplainResult', () => {
    const explain = (overrides = {}) => ({
      path: '/repo/src/auth.ts',
      language: 'typescript',
      lineCount: 20,
      byteSize: 512,
      imports: ['node:crypto'],
      symbols: [{ kind: 'function', name: 'authenticateUser', line: 4 }],
      summary: 'auth.ts is a 20-line typescript file.',
      ...overrides,
    });

    it('lays out the summary, the file facts, the imports and the symbols', () => {
      expect(formatExplainResult(explain())).toBe(
        [
          'auth.ts is a 20-line typescript file.',
          '',
          'Language: typescript',
          'Lines: 20',
          'Size: 512 bytes',
          'Imports: node:crypto',
          '',
          'Symbols:',
          '- function authenticateUser (line 4)',
        ].join('\n'),
      );
    });

    it('joins several imports with a comma', () => {
      expect(formatExplainResult(explain({ imports: ['a', 'b', 'c'] }))).toContain(
        'Imports: a, b, c',
      );
    });

    it('says "none" rather than leaving the imports line empty', () => {
      expect(formatExplainResult(explain({ imports: [] }))).toContain('Imports: none');
    });

    it('says so explicitly when no top-level symbol was detected', () => {
      // A model reading "Symbols:" followed by nothing may invent one.
      expect(formatExplainResult(explain({ symbols: [] }))).toContain('- none detected');
    });

    it('lists every symbol on its own line', () => {
      const output = formatExplainResult(
        explain({
          symbols: [
            { kind: 'class', name: 'Repo', line: 2 },
            { kind: 'function', name: 'find', line: 9 },
          ],
        }),
      );

      expect(output).toContain('- class Repo (line 2)\n- function find (line 9)');
    });
  });
});
