import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ChromaDb from 'chromadb';
import type { Collection } from 'chromadb';
import type { Embeddings } from '@langchain/core/embeddings';
import {
  ChromaVectorStore,
  parseChromaUrl,
  type ChromaVectorStoreOptions,
} from './chroma-vector-store.js';
import { fnv1a } from './embeddings.js';
import type { CodeChunk } from './vector-store.types.js';

// Hoisted, because a vi.mock factory is lifted above every other statement.
const chroma = vi.hoisted(() => ({ getOrCreateCollection: vi.fn(), heartbeat: vi.fn() }));

vi.mock('chromadb', async (importOriginal) => ({
  ...(await importOriginal<typeof ChromaDb>()),
  // A class, not vi.fn(): the store calls `new ChromaClient(...)`.
  ChromaClient: class {
    getOrCreateCollection = chroma.getOrCreateCollection;
    heartbeat = chroma.heartbeat;
  },
}));

describe('parseChromaUrl', () => {
  it.each([
    ['http://localhost:8000', { host: 'localhost', port: 8000, ssl: false }],
    ['http://127.0.0.1:9000', { host: '127.0.0.1', port: 9000, ssl: false }],
    // No port: 8000 over http, 443 over https — chromadb 3 takes host/port/ssl,
    // not a URL, so this mapping is the whole contract.
    ['http://chroma.internal', { host: 'chroma.internal', port: 8000, ssl: false }],
    ['https://chroma.example.com', { host: 'chroma.example.com', port: 443, ssl: true }],
    ['https://chroma.example.com:8443', { host: 'chroma.example.com', port: 8443, ssl: true }],
  ])('maps %s', (url, expected) => {
    expect(parseChromaUrl(url)).toEqual(expected);
  });

  it.each(['localhost:8000', 'not a url', 'ftp://chroma:8000', ''])(
    'rejects %s instead of connecting to nowhere',
    (url) => {
      // `new URL('localhost:8000')` succeeds — protocol `localhost:`, empty host.
      expect(() => parseChromaUrl(url)).toThrow(/CHROMA_URL/);
    },
  );
});

describe('fnv1a', () => {
  it('is deterministic, so a persisted index stays valid across restarts', () => {
    expect(fnv1a('authenticate')).toBe(fnv1a('authenticate'));
  });

  it('produces an unsigned 32-bit value', () => {
    for (const input of ['', 'a', 'authenticate', '🎉 unicode']) {
      const hash = fnv1a(input);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xff_ff_ff_ff);
    }
  });

  it('separates similar inputs', () => {
    expect(fnv1a('user')).not.toBe(fnv1a('users'));
    expect(fnv1a('ab')).not.toBe(fnv1a('ba'));
  });

  it('changes with the seed, which is what makes the sign bit independent', () => {
    expect(fnv1a('token')).not.toBe(fnv1a('token', 0x9d_c5_81_1c));
  });
});

/**
 * The Chroma adapter is the one store that talks to a server, so it is the one
 * whose logic never runs in the offline test suite: batching, the cosine
 * distance -> score conversion, and the memoised collection handle. A fake
 * `chromadb` client exercises all three without a running Chroma.
 */
describe('ChromaVectorStore', () => {
  const chunk = (id: string): CodeChunk => ({
    id,
    text: `text ${id}`,
    metadata: {
      path: `/repo/${id}.ts`,
      relativePath: `${id}.ts`,
      root: '/repo',
      language: 'typescript',
      startLine: 1,
      endLine: 2,
      indexedAt: '2026-01-01T00:00:00.000Z',
    },
  });

  const embeddings = {
    embedDocuments: async (texts: string[]) => texts.map((_, index) => [index, 0, 0]),
    embedQuery: async () => [1, 0, 0],
  } as unknown as Embeddings;

  const makeStore = (
    collection: Partial<Collection>,
    options: Partial<ChromaVectorStoreOptions> = {},
  ): ChromaVectorStore => {
    chroma.getOrCreateCollection.mockResolvedValue(collection);
    chroma.heartbeat.mockResolvedValue(1);
    return new ChromaVectorStore(embeddings, {
      url: 'http://localhost:8000',
      collection: 'code',
      ...options,
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends an upsert in batches, so a large index cannot exceed Chroma limits', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({ upsert }, { batchSize: 2 });

    await store.upsert([chunk('a'), chunk('b'), chunk('c'), chunk('d'), chunk('e')]);

    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert.mock.calls.map((call) => (call[0] as { ids: string[] }).ids)).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
  });

  it('does not touch the server for an empty upsert', async () => {
    const upsert = vi.fn();
    const store = makeStore({ upsert });

    await store.upsert([]);

    expect(upsert).not.toHaveBeenCalled();
    expect(chroma.getOrCreateCollection).not.toHaveBeenCalled();
  });

  it('converts cosine distance to a similarity score', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: () => [
        [
          { id: 'a', document: 'text a', metadata: { root: '/repo' }, distance: 0.25 },
          { id: 'b', document: 'text b', metadata: { root: '/repo' }, distance: 0 },
        ],
      ],
    });
    const store = makeStore({ query });

    const results = await store.search('anything');

    expect(results.map((result) => result.score)).toEqual([0.75, 1]);
  });

  it('fills in a row the server returned without document, metadata or distance', async () => {
    const query = vi.fn().mockResolvedValue({ rows: () => [[{ id: 'a' }]] });
    const store = makeStore({ query });

    expect(await store.search('anything')).toEqual([{ id: 'a', text: '', metadata: {}, score: 0 }]);
  });

  it('returns nothing for a non-positive limit without asking the server', async () => {
    const query = vi.fn();
    const store = makeStore({ query });

    expect(await store.search('anything', { limit: 0 })).toEqual([]);
    expect(chroma.getOrCreateCollection).not.toHaveBeenCalled();
  });

  it('filters by root only when one was asked for', async () => {
    const query = vi.fn().mockResolvedValue({ rows: () => [[]] });
    const store = makeStore({ query });

    await store.search('anything', { root: '/repo' });
    await store.search('anything');

    expect(query.mock.calls.map((call) => (call[0] as { where?: unknown }).where)).toEqual([
      { root: { $eq: '/repo' } },
      undefined,
    ]);
  });

  it('creates the collection once and reuses the handle', async () => {
    const count = vi.fn().mockResolvedValue(7);
    const store = makeStore({ count });

    expect(await store.count()).toBe(7);
    await store.count();

    expect(chroma.getOrCreateCollection).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed collection handle, so the next call retries', async () => {
    const store = makeStore({});
    chroma.getOrCreateCollection
      .mockRejectedValueOnce(new Error('chroma is down'))
      .mockResolvedValue({ count: async () => 3 });

    await expect(store.count()).rejects.toThrow('chroma is down');
    // Without the reset this would resolve the rejected promise forever.
    expect(await store.count()).toBe(3);
    expect(chroma.getOrCreateCollection).toHaveBeenCalledTimes(2);
  });

  it('deletes every chunk under one root', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({ delete: remove });

    await store.deleteByRoot('/repo');

    expect(remove).toHaveBeenCalledWith({ where: { root: { $eq: '/repo' } } });
  });

  it('deletes named files in batches, because `$in` with thousands of paths is rejected', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const store = makeStore({ delete: remove }, { batchSize: 2 });

    await store.deleteByPaths(['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);

    expect(
      remove.mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where),
    ).toEqual([{ path: { $in: ['/repo/a.ts', '/repo/b.ts'] } }, { path: { $in: ['/repo/c.ts'] } }]);
  });

  it('does not touch the server for an empty path list, which would delete the lot', async () => {
    // `delete({ where: { path: { $in: [] } } })` is not obviously a no-op server
    // side, and this runs on every re-index that removed nothing.
    const remove = vi.fn();
    const store = makeStore({ delete: remove });

    await store.deleteByPaths([]);

    expect(remove).not.toHaveBeenCalled();
    expect(chroma.getOrCreateCollection).not.toHaveBeenCalled();
  });

  it('asks the server for the fields it actually reads back', async () => {
    // Dropping one of these silently empties `text`, `metadata` or `score` for
    // every result, which reads as "the index is bad" rather than "the query was".
    const query = vi.fn().mockResolvedValue({ rows: () => [[]] });
    const store = makeStore({ query });

    await store.search('anything', { limit: 3 });

    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        nResults: 3,
        include: ['documents', 'metadatas', 'distances'],
        queryEmbeddings: [[1, 0, 0]],
      }),
    );
  });

  it('returns nothing when the server answers with no row set at all', async () => {
    const query = vi.fn().mockResolvedValue({ rows: () => [] });
    const store = makeStore({ query });

    expect(await store.search('anything')).toEqual([]);
  });

  it('creates the collection with the cosine space its scoring assumes', async () => {
    // `score = 1 - distance` is only a similarity in cosine space; under L2 the
    // same arithmetic silently produces negative nonsense.
    const store = makeStore({ count: vi.fn().mockResolvedValue(0) });

    await store.count();

    expect(chroma.getOrCreateCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'code',
        embeddingFunction: null,
        configuration: { hnsw: { space: 'cosine', ef_construction: 200, max_neighbors: 16 } },
      }),
    );
  });

  it('reports the collection size', async () => {
    const store = makeStore({ count: vi.fn().mockResolvedValue(42) });

    expect(await store.count()).toBe(42);
  });

  it('surfaces an unreachable server from healthCheck, so the caller can fall back', async () => {
    const store = makeStore({});
    chroma.heartbeat.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(store.healthCheck()).rejects.toThrow('ECONNREFUSED');
  });
});
