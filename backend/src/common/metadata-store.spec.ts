import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MemoryMetadataStore,
  createMetadataStore,
  type IndexedRootRecord,
  type MetadataStore,
} from './metadata-store.js';

const record = (overrides: Partial<IndexedRootRecord> = {}): IndexedRootRecord => ({
  path: '/repo',
  fileCount: 3,
  chunkCount: 9,
  lastIndexedAt: '2026-01-01T00:00:00.000Z',
  store: 'chroma',
  ...overrides,
});

/** Both implementations must satisfy the same contract, so both run these. */
const behavesLikeAMetadataStore = (name: string, make: () => Promise<MetadataStore>): void => {
  // eslint-disable-next-line vitest/valid-title -- a shared contract suite, named by the caller.
  describe(name, () => {
    let store: MetadataStore;

    beforeEach(async () => {
      store = await make();
    });

    afterEach(async () => {
      await store.close();
    });

    it('starts empty', async () => {
      expect(await store.listRoots()).toEqual([]);
    });

    it('round-trips a record', async () => {
      await store.upsertRoot(record());

      expect(await store.listRoots()).toEqual([record()]);
    });

    it('updates in place instead of duplicating a path', async () => {
      await store.upsertRoot(record());
      await store.upsertRoot(record({ fileCount: 10, chunkCount: 42, store: 'memory' }));

      const roots = await store.listRoots();
      expect(roots).toHaveLength(1);
      expect(roots[0]).toMatchObject({ fileCount: 10, chunkCount: 42, store: 'memory' });
    });

    it('lists roots in path order', async () => {
      await store.upsertRoot(record({ path: '/b' }));
      await store.upsertRoot(record({ path: '/a' }));

      expect((await store.listRoots()).map((entry) => entry.path)).toEqual(['/a', '/b']);
    });

    it('removes a root, and removing a missing one is a no-op', async () => {
      await store.upsertRoot(record());

      await store.removeRoot('/repo');
      await store.removeRoot('/never-existed');

      expect(await store.listRoots()).toEqual([]);
    });

    describe('per-file state', () => {
      const file = (path: string, root = '/repo') => ({
        root,
        path,
        size: 120,
        mtimeMs: 1_700_000_000_000,
        contentHash: `hash-of-${path}`,
        chunkCount: 3,
      });

      it('round-trips the records for one root', async () => {
        await store.upsertFiles([file('/repo/a.ts'), file('/repo/b.ts')]);

        const records = await store.listFiles('/repo');

        expect(records.map((record) => record.path).toSorted()).toEqual([
          '/repo/a.ts',
          '/repo/b.ts',
        ]);
        expect(records[0]).toMatchObject({ size: 120, chunkCount: 3 });
      });

      it('scopes the listing to the root asked for', async () => {
        await store.upsertFiles([file('/repo/a.ts'), file('/other/c.ts', '/other')]);

        expect(await store.listFiles('/other')).toHaveLength(1);
      });

      it('overwrites a record rather than duplicating it', async () => {
        await store.upsertFiles([file('/repo/a.ts')]);
        await store.upsertFiles([{ ...file('/repo/a.ts'), contentHash: 'changed', chunkCount: 9 }]);

        const records = await store.listFiles('/repo');
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ contentHash: 'changed', chunkCount: 9 });
      });

      it('removes named files', async () => {
        await store.upsertFiles([file('/repo/a.ts'), file('/repo/b.ts')]);

        await store.removeFiles(['/repo/a.ts']);

        expect((await store.listFiles('/repo')).map((record) => record.path)).toEqual([
          '/repo/b.ts',
        ]);
      });

      it("leaves another root's files alone when one root is removed", async () => {
        // Both stores iterate every file row to find the ones to drop; matching
        // too loosely would silently un-index every other folder the user has.
        await store.upsertFiles([file('/repo/a.ts'), file('/other/c.ts', '/other')]);

        await store.removeRoot('/repo');

        expect((await store.listFiles('/other')).map((entry) => entry.path)).toEqual([
          '/other/c.ts',
        ]);
      });

      it("forgets a root's files when the root itself is removed", async () => {
        // Otherwise a re-added folder would be diffed against state for chunks that
        // no longer exist, and every file would look unchanged.
        await store.upsertRoot({
          path: '/repo',
          fileCount: 2,
          chunkCount: 6,
          lastIndexedAt: '2026-01-01T00:00:00.000Z',
          store: 'memory',
        });
        await store.upsertFiles([file('/repo/a.ts')]);

        await store.removeRoot('/repo');

        expect(await store.listFiles('/repo')).toEqual([]);
      });
    });
  });
};

behavesLikeAMetadataStore('MemoryMetadataStore', async () => new MemoryMetadataStore());

describe('createMetadataStore', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-meta-')));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates the parent directory and a persistent store', async () => {
    const file = join(directory, 'nested', 'metadata.sqlite');
    const store = await createMetadataStore(file);

    expect(store.kind).toBe('sqlite');
    await store.upsertRoot(record());
    await store.close();

    // A second store over the same file sees what the first one wrote.
    const reopened = await createMetadataStore(file);
    expect(await reopened.listRoots()).toEqual([record()]);
    await reopened.close();
  });

  it('falls back to memory, with a reason, when the database cannot be opened', async () => {
    const reasons: string[] = [];
    // A directory where the file should be: sqlite3 cannot open it.
    const store = await createMetadataStore(directory, (reason) => reasons.push(reason));

    expect(store.kind).toBe('memory');
    expect(reasons).toHaveLength(1);
    // Degraded, but still usable — losing the folder list beats failing to boot.
    await store.upsertRoot(record());
    expect(await store.listRoots()).toEqual([record()]);
    await store.close();
  });
});

describe('SqliteMetadataStore', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-sqlite-')));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  behavesLikeAMetadataStore('backed by a file', async () =>
    createMetadataStore(join(directory, `${String(Date.now())}.sqlite`)),
  );
});
