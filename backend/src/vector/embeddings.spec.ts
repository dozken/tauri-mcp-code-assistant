import { describe, expect, it } from 'vitest';
import { HashingEmbeddings, cosineSimilarity, tokenize } from './embeddings.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import type { CodeChunk } from './vector-store.types.js';

const chunk = (id: string, text: string, root = '/repo'): CodeChunk => ({
  id,
  text,
  metadata: {
    path: `${root}/${id}.ts`,
    relativePath: `${id}.ts`,
    root,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    indexedAt: '2026-01-01T00:00:00.000Z',
  },
});

describe('tokenize', () => {
  it('splits camelCase and snake_case into the same tokens', () => {
    expect(tokenize('getUserById')).toEqual(['get', 'user', 'by', 'id']);
    expect(tokenize('get_user_by_id')).toEqual(['get', 'user', 'by', 'id']);
  });
});

describe('HashingEmbeddings', () => {
  const embeddings = new HashingEmbeddings({ dimensions: 64 });

  it('produces deterministic unit vectors of the configured size', async () => {
    const [a, b] = await embeddings.embedDocuments([
      'export const sum = 1',
      'export const sum = 1',
    ]);

    expect(a).toHaveLength(64);
    expect(a).toEqual(b);
    expect(Math.hypot(...a!)).toBeCloseTo(1, 6);
  });

  it('returns a finite zero vector for text with no usable tokens', async () => {
    const vector = await embeddings.embedQuery('!!! ???');

    expect(vector).toHaveLength(64);
    expect(vector.every((value) => Number.isFinite(value))).toBe(true);
    expect(vector.every((value) => value === 0)).toBe(true);
  });

  it('rejects a nonsensical dimension count', () => {
    expect(() => new HashingEmbeddings({ dimensions: 4 })).toThrow(/dimensions/);
  });

  it('scores related text above unrelated text', async () => {
    const query = await embeddings.embedQuery('authenticate user session');
    const [related, unrelated] = await embeddings.embedDocuments([
      'function authenticateUserSession(token) {}',
      'const PI = 3.14159;',
    ]);

    expect(cosineSimilarity(query, related!)).toBeGreaterThan(cosineSimilarity(query, unrelated!));
  });
});

describe('MemoryVectorStore', () => {
  it('ranks by similarity, filters by root and honours the limit', async () => {
    const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 128 }));
    await store.upsert([
      chunk('auth', 'export function authenticateUser(token: string) {}'),
      chunk('math', 'export function addNumbers(a: number, b: number) {}'),
      chunk('other', 'export function authenticateUser(token: string) {}', '/elsewhere'),
    ]);

    expect(await store.count()).toBe(3);

    const results = await store.search('authenticate user', { limit: 2 });
    expect(results[0]!.id).toBe('auth');
    expect(results).toHaveLength(2);

    const scoped = await store.search('authenticate user', { root: '/elsewhere' });
    expect(scoped.map((result) => result.id)).toEqual(['other']);
  });

  it('replaces a chunk on re-upsert instead of duplicating it', async () => {
    const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 }));
    await store.upsert([chunk('a', 'first version')]);
    await store.upsert([chunk('a', 'second version')]);

    expect(await store.count()).toBe(1);
    expect((await store.search('version'))[0]!.text).toBe('second version');
  });

  it('deletes every chunk under a root', async () => {
    const store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 32 }));
    await store.upsert([chunk('a', 'alpha'), chunk('b', 'beta', '/other')]);

    await store.deleteByRoot('/repo');

    expect(await store.count()).toBe(1);
  });
});
