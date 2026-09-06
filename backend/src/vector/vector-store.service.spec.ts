import { describe, expect, it, vi } from 'vitest';
import { createEmbeddings, selectVectorStore } from './vector-store.factory.js';
import { VectorStoreService } from './vector-store.service.js';
import { silentLogger, testConfig, testPlugins } from '../../test/helpers.js';

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

describe('createVectorStore', () => {
  it('uses the in-memory store when Chroma is disabled, without probing the network', async () => {
    const store = await selectVectorStore(
      await testPlugins(),
      testConfig(),
      await createEmbeddings(await testPlugins(), testConfig()),
    );

    expect(store.kind).toBe('memory');
  });

  it('uses the kind VECTOR_STORE names, so a plugin store is selectable', async () => {
    const config = testConfig();
    const store = await selectVectorStore(
      await testPlugins(),
      { ...config, vector: { store: 'memory' }, chroma: { ...config.chroma, enabled: true } },
      await createEmbeddings(await testPlugins(), config),
    );

    // Named explicitly, so Chroma is not consulted even though it is enabled.
    expect(store.kind).toBe('memory');
  });

  it('fails, listing what exists, when VECTOR_STORE names a kind no plugin provides', async () => {
    // No silent downgrade: somebody who configured `qdrant` wants to hear that the
    // plugin is missing, not to search an empty in-memory store forever.
    const config = testConfig();

    await expect(
      selectVectorStore(
        await testPlugins(),
        { ...config, vector: { store: 'qdrant' } },
        await createEmbeddings(await testPlugins(), config),
      ),
    ).rejects.toThrow(/"qdrant".*chroma, memory/s);
  });

  it('falls back to memory, reporting why, when Chroma is unreachable', async () => {
    const config = testConfig();
    const reasons: string[] = [];

    const store = await selectVectorStore(
      await testPlugins(),
      // Port 1 is reserved and refuses instantly, so this stays a fast unit test.
      { ...config, chroma: { ...config.chroma, enabled: true, url: 'http://127.0.0.1:1' } },
      await createEmbeddings(await testPlugins(), config),
      (reason: string) => reasons.push(reason),
    );

    expect(store.kind).toBe('memory');
    expect(reasons).toHaveLength(1);
  });
});

describe('VectorStoreService', () => {
  const build = async (): Promise<VectorStoreService> =>
    new VectorStoreService(
      testConfig(),
      await createEmbeddings(await testPlugins(), testConfig()),
      await testPlugins(),
      silentLogger(),
    );

  it('reports `memory` before anything forces resolution', async () => {
    expect((await build()).kind).toBe('memory');
  });

  it('delegates the whole VectorStore contract to the resolved store', async () => {
    const service = await build();

    await service.upsert([chunk]);
    expect(await service.count()).toBe(1);
    expect((await service.search('authenticate'))[0]?.id).toBe('a');

    await service.deleteByRoot('/repo');
    expect(await service.count()).toBe(0);
  });

  it('resolves once and reuses the same store across calls', async () => {
    const service = await build();

    await service.upsert([chunk]);
    // A second resolution would produce an empty store and lose the chunk.
    expect(await service.count()).toBe(1);
    expect(service.kind).toBe('memory');
  });

  it('retries resolution after a failure instead of caching a broken store', async () => {
    const embeddings = await createEmbeddings(await testPlugins(), testConfig());
    const spy = vi.spyOn(embeddings, 'embedDocuments');
    spy.mockRejectedValueOnce(new Error('embedder offline'));

    const failing = new VectorStoreService(
      testConfig(),
      embeddings,
      await testPlugins(),
      silentLogger(),
    );
    await expect(failing.upsert([chunk])).rejects.toThrow(/embedder offline/);

    // The store itself resolved fine, so the next call must still work.
    await expect(failing.upsert([chunk])).resolves.toBeUndefined();
    expect(await failing.count()).toBe(1);
    spy.mockRestore();
  });
});
