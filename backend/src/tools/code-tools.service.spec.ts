import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { testConfig } from '../../test/helpers.js';
import { CodeToolsService } from './code-tools.service.js';
import { formatSearchResult } from './formatters.js';

const SAMPLE = `import { readFile } from 'node:fs/promises';
import { Logger } from './logger.js';

export interface UserRecord {
  id: string;
}

export class UserRepository {
  async findById(id: string): Promise<UserRecord | undefined> {
    return { id };
  }
}

export const authenticateUser = async (token: string) => token.length > 0;

export function formatUser(user: UserRecord): string {
  return user.id;
}
`;

describe('CodeToolsService', () => {
  let root: string;
  let store: MemoryVectorStore;
  let tools: CodeToolsService;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-tools-')));
    await writeFile(join(root, 'user-repository.ts'), SAMPLE);

    store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 128 }));
    await store.upsert([
      {
        id: 'chunk-1',
        text: SAMPLE,
        metadata: {
          path: join(root, 'user-repository.ts'),
          relativePath: 'user-repository.ts',
          root,
          language: 'typescript',
          startLine: 1,
          endLine: 19,
          indexedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]);

    const config = testConfig({
      indexing: {
        chunkSize: 400,
        chunkOverlap: 40,
        maxFileBytes: 64 * 1024,
        concurrency: 2,
        allowedRoots: [root],
      },
    });
    tools = new CodeToolsService(config, store as unknown as VectorStoreService);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe('search_code', () => {
    it('returns scored snippets with their line range', async () => {
      const result = await tools.searchCode({ query: 'authenticate user token', limit: 3 });

      expect(result.query).toBe('authenticate user token');
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]).toMatchObject({
        relativePath: 'user-repository.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 19,
      });
      expect(result.matches[0].score).toBeGreaterThan(0);
    });

    it('formats an empty result as actionable guidance rather than silence', async () => {
      const empty = await new CodeToolsService(
        testConfig(),
        new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 })) as unknown as VectorStoreService,
      ).searchCode({ query: 'anything' });

      expect(empty.matches).toEqual([]);
      expect(formatSearchResult(empty)).toMatch(/Index a folder first/);
    });
  });

  describe('explain_file', () => {
    it('summarises imports and top-level symbols', async () => {
      const result = await tools.explainFile({ path: join(root, 'user-repository.ts') });

      expect(result.language).toBe('typescript');
      expect(result.imports).toEqual(['node:fs/promises', './logger.js']);
      expect(result.symbols).toEqual(
        expect.arrayContaining([
          { kind: 'interface', name: 'UserRecord', line: 4 },
          { kind: 'class', name: 'UserRepository', line: 8 },
          { kind: 'function', name: 'authenticateUser', line: 14 },
          { kind: 'function', name: 'formatUser', line: 16 },
        ]),
      );
      expect(result.summary).toContain('user-repository.ts');
      expect(result.summary).toContain('1 class');
    });

    it('refuses paths outside the allow-list', async () => {
      await expect(tools.explainFile({ path: '/etc/hosts' })).rejects.toThrow(
        /outside the allowed roots/,
      );
    });

    it('refuses a directory', async () => {
      await expect(tools.explainFile({ path: root })).rejects.toThrow(/Not a file/);
    });

    it('rejects a file above the size limit', async () => {
      const big = join(root, 'huge.ts');
      await writeFile(big, 'x'.repeat(600 * 1024));

      await expect(tools.explainFile({ path: big })).rejects.toThrow(
        /too large to explain \(614400 bytes, limit 524288\)/,
      );
    });
  });

  describe('generate_snippet', () => {
    it('returns a language-appropriate scaffold', async () => {
      const result = await tools.generateSnippet({ prompt: 'debounce a callback', language: 'python' });

      expect(result.language).toBe('python');
      expect(result.code).toContain('def run(');
      expect(result.code).toContain('debounce a callback');
    });

    it('defaults to TypeScript', async () => {
      const result = await tools.generateSnippet({ prompt: 'parse a URL' });

      expect(result.language).toBe('typescript');
      expect(result.code).toContain('export async function run');
    });

    it('falls back to a generic scaffold for an unknown language', async () => {
      const result = await tools.generateSnippet({ prompt: 'do a thing', language: 'Brainfuck' });

      expect(result.language).toBe('brainfuck');
      expect(result.notes).toMatch(/No template/);
      expect(result.code).toContain('do a thing');
    });
  });
});
