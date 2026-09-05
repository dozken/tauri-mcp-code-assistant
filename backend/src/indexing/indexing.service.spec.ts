import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, toArray } from 'rxjs';
import { MemoryMetadataStore } from '../common/metadata-store.js';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { silentLogger, testConfig } from '../../test/helpers.js';
import { IndexingService } from './indexing.service.js';

/** The in-memory store satisfies the same contract the service depends on. */
const asVectorStoreService = (store: MemoryVectorStore): VectorStoreService =>
  store as unknown as VectorStoreService;

const settle = async (service: IndexingService): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await service.getStatus();
    if (status.activeJob === null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Indexing did not finish in time');
};

describe('IndexingService', () => {
  let root: string;
  let store: MemoryVectorStore;
  let metadata: MemoryMetadataStore;
  let service: IndexingService;

  const build = async (overrides: Record<string, unknown> = {}): Promise<IndexingService> => {
    const config = testConfig({
      indexing: {
        chunkSize: 400,
        chunkOverlap: 50,
        maxFileBytes: 64 * 1024,
        concurrency: 4,
        allowedRoots: [root],
        ...overrides,
      },
    });
    const instance = new IndexingService(
      config,
      metadata,
      asVectorStoreService(store),
      silentLogger(),
    );
    await instance.onModuleInit();
    return instance;
  };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'companion-index-')));
    store = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 64 }));
    metadata = new MemoryMetadataStore();

    await writeFile(
      join(root, 'auth.ts'),
      'export function authenticateUser(token: string) {\n  return token.length > 0;\n}\n',
    );
    await writeFile(
      join(root, 'math.ts'),
      'export const addNumbers = (a: number, b: number) => a + b;\n',
    );
    await writeFile(join(root, 'README.md'), '# Demo repository\n');
    await writeFile(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = () => {};\n',
    );

    service = await build();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('indexes source files and skips node_modules and binaries', async () => {
    await service.startIndexing(root);
    await settle(service);

    const status = await service.getStatus();
    expect(status.roots).toHaveLength(1);
    expect(status.roots[0]!.path).toBe(root);
    expect(status.roots[0]!.fileCount).toBe(3); // auth.ts, math.ts, README.md
    expect(status.totalChunks).toBeGreaterThan(0);

    const hits = await store.search('authenticate user');
    expect(hits[0]!.metadata.relativePath).toBe('auth.ts');
    expect(hits.every((hit) => !hit.metadata.relativePath.includes('node_modules'))).toBe(true);
  });

  it('honours .gitignore', async () => {
    await writeFile(join(root, '.gitignore'), 'math.ts\n');
    await service.startIndexing(root);
    await settle(service);

    const paths = (await store.search('numbers', { limit: 10 })).map(
      (hit) => hit.metadata.relativePath,
    );
    expect(paths).not.toContain('math.ts');
    expect(await service.getStatus()).toMatchObject({ roots: [{ fileCount: 2 }] });
  });

  it('emits progress that ends in a completed state', async () => {
    const events = firstValueFrom(service.progress.pipe(toArray()));

    await service.startIndexing(root);
    await settle(service);
    // The subject stays open, so close the collection window explicitly.
    (service as unknown as { progressSubject: { complete(): void } }).progressSubject.complete();

    const emitted = await events;
    expect(emitted.length).toBeGreaterThan(1);
    expect(emitted[0]!.state).toBe('running');
    expect(emitted.at(-1)).toMatchObject({ state: 'completed', percent: 100 });
  });

  it('replaces previous chunks when the same folder is re-indexed', async () => {
    await service.startIndexing(root);
    await settle(service);
    const first = await store.count();

    await service.startIndexing(root);
    await settle(service);

    expect(await store.count()).toBe(first);
  });

  it('refuses a second concurrent job', async () => {
    await service.startIndexing(root);
    await expect(service.startIndexing(root)).rejects.toThrow(/already running/);
    await settle(service);
  });

  it('rejects paths outside the allow-list and paths that do not exist', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'companion-outside-')));
    try {
      await expect(service.startIndexing(outside)).rejects.toThrow(/outside the allowed roots/);
      await expect(service.startIndexing(join(root, 'nope'))).rejects.toThrow(/does not exist/);
      await expect(service.startIndexing(join(root, 'auth.ts'))).rejects.toThrow(/Not a directory/);
      await expect(service.startIndexing('   ')).rejects.toThrow(/path is required/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('removes a root from both the vector store and the metadata store', async () => {
    await service.startIndexing(root);
    await settle(service);

    await service.removeRoot(root);

    expect(await store.count()).toBe(0);
    expect(await metadata.listRoots()).toEqual([]);
    await expect(service.removeRoot(root)).rejects.toThrow(/Not an indexed folder/);
  });

  it('removes a root that was added through a symlinked path', async () => {
    const link = join(await realpath(tmpdir()), `companion-link-${Date.now()}`);
    await symlink(root, link, 'dir');
    try {
      await service.startIndexing(link);
      await settle(service);
      expect((await service.getStatus()).roots[0]!.path).toBe(root);

      // Removal has to resolve the symlink too, or the folder is unremovable.
      await service.removeRoot(link);

      expect((await service.getStatus()).roots).toEqual([]);
    } finally {
      await rm(link, { force: true });
    }
  });

  it('marks restored roots as stale when the previous store was not persistent', async () => {
    await metadata.upsertRoot({
      path: root,
      fileCount: 3,
      chunkCount: 9,
      lastIndexedAt: '2026-01-01T00:00:00.000Z',
      store: 'memory',
    });

    const restored = await build();

    expect((await restored.getStatus()).roots[0]).toMatchObject({ stale: true });
  });

  it('keeps going when a single file cannot be read', async () => {
    const spy = vi.spyOn(store, 'upsert');
    spy.mockRejectedValueOnce(new Error('disk on fire'));

    await service.startIndexing(root);
    await settle(service);

    const status = await service.getStatus();
    expect(status.activeJob).toBeNull();
    expect(status.roots[0]!.fileCount).toBe(3);
    spy.mockRestore();
  });

  describe('one job at a time', () => {
    it('accepts only one of two requests that arrive together', async () => {
      // The guard used to be checked before `resolveRoot`, which awaits. Both
      // requests saw no active job, both started, and the second overwrote the
      // abort controller — leaving the first uncancellable and /status reporting
      // idle while it was still writing.
      const results = await Promise.allSettled([
        service.startIndexing(root),
        service.startIndexing(root),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      await settle(service);
    });

    it('accepts a second job once the first has finished', async () => {
      await service.startIndexing(root);
      await settle(service);

      await expect(service.startIndexing(root)).resolves.toMatchObject({ state: 'running' });
      await settle(service);
    });

    it('does not resurrect a folder deleted while it was being indexed', async () => {
      await service.startIndexing(root);
      await service.removeRoot(root);
      await settle(service);

      const status = await service.getStatus();
      expect(status.roots.map((entry) => entry.path)).not.toContain(root);
      expect(await metadata.listRoots()).toEqual([]);
    });
  });
});
