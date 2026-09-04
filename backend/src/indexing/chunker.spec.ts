import { describe, expect, it } from 'vitest';
import { chunkText, detectLanguage } from './chunker.js';

describe('chunkText', () => {
  it('returns a single chunk for short input and keeps line numbers 1-based', () => {
    const chunks = chunkText('const a = 1;\nconst b = 2;\n', { chunkSize: 200, chunkOverlap: 20 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(3);
    expect(chunks[0].text).toContain('const b = 2;');
  });

  it('ignores whitespace-only input', () => {
    expect(chunkText('   \n\n\t\n', { chunkSize: 100, chunkOverlap: 10 })).toEqual([]);
  });

  it('splits long input into overlapping chunks that stay within the size budget', () => {
    const source = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    const chunks = chunkText(source, { chunkSize: 120, chunkOverlap: 30 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(120);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
    }
    // Consecutive chunks must overlap but still move forward.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].startLine).toBeGreaterThan(chunks[i - 1].startLine);
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
    }
    expect(chunks.at(-1)?.endLine).toBe(200);
  });

  it('hard-splits a minified single-line file instead of emitting one huge chunk', () => {
    const chunks = chunkText('x'.repeat(1000), { chunkSize: 100, chunkOverlap: 10 });

    expect(chunks.length).toBeGreaterThanOrEqual(10);
    expect(chunks.every((chunk) => chunk.text.length <= 100)).toBe(true);
    expect(chunks.every((chunk) => chunk.startLine === 1 && chunk.endLine === 1)).toBe(true);
  });

  it('terminates on pathological overlap settings rather than looping forever', () => {
    const source = Array.from({ length: 50 }, (_, index) => `${index}`).join('\n');
    const chunks = chunkText(source, { chunkSize: 10, chunkOverlap: 9 });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.at(-1)?.endLine).toBe(50);
  });

  it('rejects an overlap that is not smaller than the chunk size', () => {
    expect(() => chunkText('a\nb', { chunkSize: 10, chunkOverlap: 10 })).toThrow(/chunkOverlap/);
    expect(() => chunkText('a\nb', { chunkSize: 0, chunkOverlap: 0 })).toThrow(/chunkSize/);
  });
});

describe('detectLanguage', () => {
  it.each([
    ['src/main.ts', 'typescript'],
    ['lib/mod.rs', 'rust'],
    ['app/views.py', 'python'],
    ['README.md', 'markdown'],
    ['Makefile', 'plaintext'],
  ])('maps %s to %s', (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });
});
