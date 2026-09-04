import { describe, expect, it, vi } from 'vitest';
import { HashingEmbeddings } from './embeddings.js';
import { createEmbeddings, createVectorStore } from './vector-store.factory.js';
import { VectorStoreService } from './vector-store.service.js';
import { silentLogger, testConfig } from '../../test/helpers.js';

const chunk = {
  id: 'a',
  text: 'export const authenticate = () => true;',
  metadata: {
    path: '/repo/auth.ts',
    relativePath: 'auth.ts',
    root: '/repo',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    indexedAt: '2026-01-01T00:00:00.000Z',
  },
};

describe('createEmbeddings', () => {
  it('uses deterministic local embeddings by default', () => {
    const embeddings = createEmbeddings(testConfig());

    expect(embeddings).toBeInstanceOf(HashingEmbeddings);
  });

  it('honours the configured dimension count', async () => {
    const config = testConfig();
    const embeddings = createEmbeddings({
      ...config,
      embeddings: { ...config.embeddings, dimensions: 96 },
    });

    expect(await embeddings.embedQuery('hello')).toHaveLength(96);
  });

  it('refuses OpenAI embeddings without a key rather than failing on first use', () => {
    const config = testConfig();

    expect(() =>
      createEmbeddings({
        ...config,
        embeddings: { ...config.embeddings, provider: 'openai' },
        llm: { ...config.llm, apiKey: undefined },
      }),
    ).toThrow(/OPENAI_API_KEY/);
  });
});

describe('createVectorStore', () => {
  it('uses the in-memory store when Chroma is disabled, without probing the network', async () => {
    const store = await createVectorStore(testConfig(), createEmbeddings(testConfig()));

    expect(store.kind).toBe('memory');
  });

  it('falls back to memory, reporting why, when Chroma is unreachable', async () => {
    const config = testConfig();
    const reasons: string[] = [];

    const store = await createVectorStore(
      // Port 1 is reserved and refuses instantly, so this stays a fast unit test.
      { ...config, chroma: { ...config.chroma, enabled: true, url: 'http://127.0.0.1:1' } },
      createEmbeddings(config),
      (reason) => reasons.push(reason),
    );

    expect(store.kind).toBe('memory');
    expect(reasons).toHaveLength(1);
  });
});

describe('VectorStoreService', () => {
  const build = (): VectorStoreService =>
    new VectorStoreService(testConfig(), createEmbeddings(testConfig()), silentLogger());

  it('reports `memory` before anything forces resolution', () => {
    expect(build().kind).toBe('memory');
  });

  it('delegates the whole VectorStore contract to the resolved store', async () => {
    const service = build();

    await service.upsert([chunk]);
    expect(await service.count()).toBe(1);
    expect((await service.search('authenticate'))[0]?.id).toBe('a');

    await service.deleteByRoot('/repo');
    expect(await service.count()).toBe(0);
  });

  it('resolves once and reuses the same store across calls', async () => {
    const service = build();

    await service.upsert([chunk]);
    // A second resolution would produce an empty store and lose the chunk.
    expect(await service.count()).toBe(1);
    expect(service.kind).toBe('memory');
  });

  it('retries resolution after a failure instead of caching a broken store', async () => {
    const embeddings = createEmbeddings(testConfig());
    const spy = vi.spyOn(embeddings, 'embedDocuments');
    spy.mockRejectedValueOnce(new Error('embedder offline'));

    const failing = new VectorStoreService(testConfig(), embeddings, silentLogger());
    await expect(failing.upsert([chunk])).rejects.toThrow(/embedder offline/);

    // The store itself resolved fine, so the next call must still work.
    await expect(failing.upsert([chunk])).resolves.toBeUndefined();
    expect(await failing.count()).toBe(1);
    spy.mockRestore();
  });
});
