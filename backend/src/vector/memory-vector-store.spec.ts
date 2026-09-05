import { describe, expect, it } from 'vitest';
import { HashingEmbeddings } from './embeddings.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import type { CodeChunk } from './vector-store.types.js';

const chunk = (id: string, path: string): CodeChunk => ({
  id,
  text: `content of ${id}`,
  metadata: {
    path,
    relativePath: path.split('/').at(-1) ?? path,
    root: '/repo',
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    indexedAt: '2026-01-01T00:00:00.000Z',
  },
});

describe('MemoryVectorStore', () => {
  describe('deleteByPaths', () => {
    it('removes only the named files, leaving the rest of the root intact', async () => {
      const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 }));
      await store.upsert([
        chunk('a1', '/repo/a.ts'),
        chunk('a2', '/repo/a.ts'),
        chunk('b1', '/repo/b.ts'),
      ]);

      await store.deleteByPaths(['/repo/a.ts']);

      expect(await store.count()).toBe(1);
      const remaining = await store.search('content', { limit: 10 });
      expect(remaining.map((match) => match.metadata.path)).toEqual(['/repo/b.ts']);
    });

    it('does nothing for an empty list rather than deleting everything', async () => {
      const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 }));
      await store.upsert([
        {
          id: 'a1',
          text: 'kept',
          metadata: {
            path: '/repo/a.ts',
            relativePath: 'a.ts',
            root: '/repo',
            language: 'typescript',
            startLine: 1,
            endLine: 1,
            indexedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      ]);

      await store.deleteByPaths([]);

      expect(await store.count()).toBe(1);
    });
  });
});
