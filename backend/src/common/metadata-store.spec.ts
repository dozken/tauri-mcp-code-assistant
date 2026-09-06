import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryMetadataStore,
  adaptNodeSqlite,
  createMetadataStore,
  type IndexedRootRecord,
  type MetadataStore,
  type NodeSqliteDatabase,
} from './metadata-store.js';
import type * as MetadataStoreModule from './metadata-store.js';

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
    // A directory where the file should be: sqlite cannot open it.
    const store = await createMetadataStore(directory, (reason) => reasons.push(reason));

    expect(store.kind).toBe('memory');
    expect(reasons).toHaveLength(1);
    // Degraded, but still usable — losing the folder list beats failing to boot.
    await store.upsertRoot(record());
    expect(await store.listRoots()).toEqual([record()]);
    await store.close();
  });

  it('falls back without a listener, because nobody has to be watching', async () => {
    // The callback is how the app logs the degradation; a caller that does not want
    // to know must still get a working store rather than a TypeError.
    const store = await createMetadataStore(directory);

    expect(store.kind).toBe('memory');
    await store.close();
  });

  it('really closes the database, rather than only saying so', async () => {
    // A store that returns from `close` without releasing the handle leaks a file
    // descriptor per open, and nothing in the app would ever notice.
    const store = await createMetadataStore(join(directory, 'closed.sqlite'));
    await store.close();

    await expect(store.listRoots()).rejects.toThrow();
  });
});

/**
 * The paths that only run on a runtime this one is not.
 *
 * `node:sqlite` has been unflagged since Node 22.5, so the `sqlite3` fallback
 * beneath it never runs here — which is exactly why it is worth running on
 * purpose. Code that has never executed is not a fallback, it is a guess.
 */
describe('createMetadataStore on a runtime without node:sqlite', () => {
  let directory: string;

  /** A fresh module graph, so the mock below is in place before it imports. */
  const loadModule = async (): Promise<typeof MetadataStoreModule> => {
    vi.resetModules();
    return import('./metadata-store.js');
  };

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'companion-fallback-')));
    // What Node does before 22.5, and between 22.5 and the flag being removed.
    vi.doMock('node:sqlite', () => {
      throw new Error('node:sqlite is an experimental feature and is disabled');
    });
  });

  afterEach(async () => {
    vi.doUnmock('node:sqlite');
    vi.doUnmock('sqlite3');
    vi.resetModules();
    await rm(directory, { recursive: true, force: true });
  });

  it('opens the sqlite3 driver instead, and persists just the same', async () => {
    const { createMetadataStore: create } = await loadModule();
    const file = join(directory, 'driver.sqlite');

    const store = await create(file);
    expect(store.kind).toBe('sqlite');
    await store.upsertRoot(record());
    await store.close();

    const reopened = await create(file);
    expect(await reopened.listRoots()).toEqual([record()]);
    await reopened.close();
  });

  it('finds the constructor on the module default, where Node puts it', async () => {
    // Node's ESM interop hands a CommonJS native module over as `{ default }` and
    // nothing else, while the test runner's interop helpfully adds the named
    // exports too — so only a module shaped like the real one proves this reads the
    // right place. The callback is deferred because the real driver defers it, and
    // resolving synchronously would reach the handle before it exists.
    const opened: string[] = [];
    class FakeDatabase {
      constructor(file: string, callback: (error: Error | null) => void) {
        opened.push(file);
        queueMicrotask(() => callback(null));
      }
      run(_sql: string, _params: unknown[], callback: (error: Error | null) => void): void {
        callback(null);
      }
      all(
        _sql: string,
        _params: unknown[],
        callback: (error: Error | null, rows: unknown[]) => void,
      ): void {
        callback(null, []);
      }
      close(callback: (error: Error | null) => void): void {
        callback(null);
      }
    }
    vi.doMock('sqlite3', () => ({ default: { Database: FakeDatabase }, Database: undefined }));
    const { createMetadataStore: create } = await loadModule();
    const file = join(directory, 'default-export.sqlite');

    const store = await create(file);

    expect(store.kind).toBe('sqlite');
    expect(opened).toEqual([file]);
    await store.close();
  });

  it('says which module let it down when sqlite3 is there but empty', async () => {
    // An optional native dependency that half-installed is not the same as one that
    // is missing, and a fallback reason of "undefined is not an object" helps nobody.
    // Both keys present and empty: a module object, with nothing in it.
    vi.doMock('sqlite3', () => ({ default: undefined, Database: undefined }));
    const { createMetadataStore: create } = await loadModule();
    const reasons: string[] = [];

    const store = await create(join(directory, 'unused.sqlite'), (reason) => reasons.push(reason));

    expect(store.kind).toBe('memory');
    expect(reasons).toEqual(['sqlite3 module did not export a Database constructor']);
    await store.close();
  });
});

/**
 * The adapter is the seam every query goes through on Node's own SQLite, and it is
 * the only place a synchronous throw is turned back into the callback shape the
 * store expects. A throw that escapes here takes the process down.
 */
describe('adaptNodeSqlite', () => {
  const throwing = (thrown: unknown): NodeSqliteDatabase => ({
    prepare: () => {
      throw thrown;
    },
    close: () => {
      throw thrown;
    },
  });

  const failure = new Error('database is locked');

  it('hands a failed statement to the callback instead of throwing', () => {
    const errors: unknown[] = [];

    adaptNodeSqlite(throwing(failure)).run('INSERT INTO t VALUES (?)', ['x'], (error) =>
      errors.push(error),
    );

    expect(errors).toEqual([failure]);
  });

  it('hands a failed query to the callback, with no rows', () => {
    let seen: { error: unknown; rows: unknown } | undefined;

    adaptNodeSqlite(throwing(failure)).all('SELECT 1', [], (error, rows) => {
      seen = { error, rows };
    });

    // The rows argument is not optional to the caller, so an empty list rather than
    // whatever happened to be on the stack.
    expect(seen).toEqual({ error: failure, rows: [] });
  });

  it('hands a failed close to the callback', () => {
    const errors: unknown[] = [];

    adaptNodeSqlite(throwing(failure)).close((error) => errors.push(error));

    expect(errors).toEqual([failure]);
  });

  it('wraps a throw that is not an Error, so the caller always gets one', () => {
    // `throw 'boom'` is legal, and a callback typed `Error | null` that receives a
    // string is a crash one `error.message` later.
    const errors: unknown[] = [];

    adaptNodeSqlite(throwing('boom')).run('SELECT 1', [], (error) => errors.push(error));

    expect(errors).toEqual([new Error('boom')]);
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
