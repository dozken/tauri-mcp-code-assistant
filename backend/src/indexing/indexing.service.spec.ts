import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { firstValueFrom, toArray } from 'rxjs';
import { MemoryMetadataStore } from '../common/metadata-store.js';
import { HashingEmbeddings } from '../vector/embeddings.js';
import { MemoryVectorStore } from '../vector/memory-vector-store.js';
import type { VectorStoreService } from '../vector/vector-store.service.js';
import { recordingLogger, silentLogger, testConfig, testPlugins } from '../../test/helpers.js';
import { IndexingService } from './indexing.service.js';

/**
 * The in-memory store satisfies the same contract the service depends on, plus
 * the one thing only the Nest facade has: the lazily resolved kind.
 */
const asVectorStoreService = (
  store: MemoryVectorStore,
  kind: string = store.kind,
): VectorStoreService =>
  Object.assign(store, {
    kind,
    resolvedStoreKind: () => Promise.resolve(kind),
  }) as unknown as VectorStoreService;

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
        watch: false,
        watchDebounceMs: 5,
        ...overrides,
      },
    });
    const instance = new IndexingService(
      config,
      metadata,
      await testPlugins(),
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

  describe('status and cancellation', () => {
    it('leaves a Chroma-backed root usable after a restart, unlike a memory one', async () => {
      // The whole point of persisting to Chroma: the chunks outlive the process,
      // so the folder is searchable on launch instead of needing a full re-index.
      await metadata.upsertRoot({
        path: '/persisted',
        fileCount: 3,
        chunkCount: 9,
        lastIndexedAt: '2026-01-01T00:00:00.000Z',
        store: 'chroma',
      });
      await metadata.upsertRoot({
        path: '/ephemeral',
        fileCount: 3,
        chunkCount: 9,
        lastIndexedAt: '2026-01-01T00:00:00.000Z',
        store: 'memory',
      });

      const restarted = await build();
      const byPath = new Map(
        (await restarted.getStatus()).roots.map((entry) => [entry.path, entry.stale]),
      );

      expect(byPath.get('/persisted')).toBe(false);
      expect(byPath.get('/ephemeral')).toBe(true);
    });

    it('names the folder it is busy with when it refuses a second job', async () => {
      await service.startIndexing(root);

      await expect(service.startIndexing(root)).rejects.toThrow(root);
      await settle(service);
    });

    it('lists roots in path order, however they were added', async () => {
      // The sidebar renders this list as given; unsorted, a folder jumps position
      // every time another one is re-indexed.
      const second = await realpath(await mkdtemp(join(tmpdir(), 'companion-aaa-')));
      await writeFile(join(second, 'other.ts'), 'export const c = 3;\n');
      const wide = await build({ allowedRoots: [root, second] });

      await wide.startIndexing(root);
      await settle(wide);
      await wide.startIndexing(second);
      await settle(wide);

      const paths = (await wide.getStatus()).roots.map((entry) => entry.path);
      expect(paths).toEqual([...paths].toSorted());
      expect(paths).toHaveLength(2);
      await rm(second, { recursive: true, force: true });
    });

    it('names the real store on the very first status call, not the lazy default', async () => {
      // Resolution is lazy, so `kind` answers `memory` until something forces it.
      // Reading it too early told every user on every launch that their index was
      // in memory and would be lost — with Chroma sitting right there behind it.
      const late = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 64 }));
      const service = new IndexingService(
        testConfig({
          indexing: {
            chunkSize: 400,
            chunkOverlap: 50,
            maxFileBytes: 64 * 1024,
            concurrency: 4,
            allowedRoots: [root],
            watch: false,
            watchDebounceMs: 5,
          },
        }),
        metadata,
        await testPlugins(),
        asVectorStoreService(late, 'pretend-persistent'),
        silentLogger(),
      );

      expect((await service.getStatus()).vectorStore).toBe('pretend-persistent');
    });

    it('reports zero chunks rather than failing status when the store cannot be counted', async () => {
      // `/status` drives the whole sidebar. A Chroma hiccup must degrade one
      // number, not blank the folder list and the progress bar with it.
      vi.spyOn(store, 'count').mockRejectedValue(new Error('chroma unreachable'));

      await expect(service.getStatus()).resolves.toMatchObject({ totalChunks: 0 });
    });

    it('logs the outcome of a run with the fields an operator needs', async () => {
      // This line is the operational contract: it is what somebody greps when a
      // folder looks wrong, and an empty payload turns that into guesswork.
      const logger = recordingLogger();
      const config = testConfig({
        indexing: {
          chunkSize: 400,
          chunkOverlap: 50,
          maxFileBytes: 64 * 1024,
          concurrency: 4,
          allowedRoots: [root],
          watch: false,
          watchDebounceMs: 5,
        },
      });
      const logged = new IndexingService(
        config,
        metadata,
        await testPlugins(),
        asVectorStoreService(store),
        logger,
      );
      await logged.onModuleInit();

      await logged.startIndexing(root);
      await settle(logged);

      const finished = logger.lines.find((line) => line.message === 'Indexing finished');
      expect(finished?.payload).toMatchObject({ root, state: 'completed' });
      expect(finished?.payload.files).toBeGreaterThan(0);
      expect(finished?.payload.chunks).toBeGreaterThan(0);
    });

    it('indexes files in parallel up to the configured concurrency', async () => {
      // Deterministic rather than timed: the barrier only resolves once three
      // files are in flight at once, so a serial walker hangs instead of racing.
      const parallel = 3;
      let inFlight = 0;
      let release = (): void => undefined;
      const everyoneArrived = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(store, 'upsert').mockImplementation(async () => {
        inFlight += 1;
        if (inFlight >= parallel) release();
        await everyoneArrived;
      });

      const concurrent = await build({ concurrency: parallel });
      await concurrent.startIndexing(root);

      await expect(everyoneArrived).resolves.toBeUndefined();
      await settle(concurrent);
    });

    it('emits a progress event at the start and the end, whatever the throttle', async () => {
      // Between those two the stream is rate limited, so without forcing them a
      // fast folder could finish having told the UI nothing at all.
      const events: string[] = [];
      const subscription = service.progress.subscribe((event) => events.push(event.state));

      await service.startIndexing(root);
      await settle(service);
      subscription.unsubscribe();

      expect(events.at(0)).toBe('running');
      expect(events.at(-1)).toBe('completed');
    });

    it('says whether there was anything to cancel', async () => {
      expect(service.cancel()).toBe(false);

      await service.startIndexing(root);
      expect(service.cancel()).toBe(true);
      await settle(service);

      expect((await service.getStatus()).activeJob).toBeNull();
    });

    it('records a cancelled run as an indexed root, so partial work is not lost', async () => {
      await service.startIndexing(root);
      service.cancel();
      await settle(service);

      // Cancelled, not failed: the chunks that did land are real and searchable.
      expect((await service.getStatus()).roots.map((entry) => entry.path)).toEqual([root]);
    });

    it('cancels an in-flight job when its folder is removed', async () => {
      // Otherwise the job's `finally` re-creates the record it just deleted and
      // the folder reappears seconds after the user removed it.
      await service.startIndexing(root);
      await service.removeRoot(root);
      await settle(service);

      const status = await service.getStatus();
      expect(status.roots).toEqual([]);
      expect(status.totalChunks).toBe(0);
    });

    it('marks the job failed, without wedging the slot, when the run itself throws', async () => {
      // Reading the per-file state is the first thing a run does and the first
      // thing that can fail outright — a locked or corrupt SQLite file.
      const listFiles = vi
        .spyOn(metadata, 'listFiles')
        .mockRejectedValue(new Error('database is locked'));
      const events: string[] = [];
      const subscription = service.progress.subscribe((event) => events.push(event.state));

      await service.startIndexing(root);
      await settle(service);
      subscription.unsubscribe();

      expect(events).toContain('failed');
      // A failure must not leave the folder listed as if it had been indexed.
      expect((await service.getStatus()).roots).toEqual([]);

      // And the next request must still be accepted: a failure is not a stuck job.
      listFiles.mockRestore();
      await expect(service.startIndexing(root)).resolves.toMatchObject({ state: 'running' });
      await settle(service);
    });

    it('completes, reporting nothing indexed, when every single file fails to read', async () => {
      // One unreadable file must not abort a repository, so the run completes —
      // but it has to say it embedded nothing rather than claim a healthy index.
      vi.spyOn(store, 'upsert').mockRejectedValue(new Error('disk on fire'));

      await service.startIndexing(root);
      await settle(service);

      const status = await service.getStatus();
      expect(status.roots[0]).toMatchObject({ path: root, chunkCount: 0 });
      expect(status.totalChunks).toBe(0);
    });
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

  it('embeds nothing from a file that is binary despite a source extension', async () => {
    // A minified bundle, a compiled artefact checked in as `.ts`, a `.md` that is
    // really a blob: the extension filter lets it through, and embedding it would
    // fill the store with noise that then answers real queries.
    await writeFile(join(root, 'bundle.ts'), `export const x = 1;\u0000\u0000binary`);

    await service.startIndexing(root);
    await settle(service);

    const hits = await store.search('binary', { limit: 20 });
    expect(hits.map((match) => match.metadata.relativePath)).not.toContain('bundle.ts');
  });

  describe('incremental re-indexing', () => {
    /** Counts embedding calls, which is the cost incremental indexing exists to avoid. */
    const countEmbeds = (target: MemoryVectorStore): { calls: () => number } => {
      let calls = 0;
      const original = target.upsert.bind(target);
      target.upsert = async (chunks) => {
        calls += chunks.length;
        return original(chunks);
      };
      return { calls: () => calls };
    };

    it('re-embeds nothing when no file has changed', async () => {
      await service.startIndexing(root);
      await settle(service);
      const first = await service.getStatus();

      const embeds = countEmbeds(store);
      await service.startIndexing(root);
      await settle(service);

      expect(embeds.calls()).toBe(0);
      // The folder is still fully searchable: the counts did not collapse to zero.
      const second = await service.getStatus();
      expect(second.roots[0]?.chunkCount).toBe(first.roots[0]?.chunkCount);
      expect(second.totalChunks).toBe(first.totalChunks);
    });

    it('re-embeds only the file whose content changed', async () => {
      await service.startIndexing(root);
      await settle(service);

      await writeFile(join(root, 'auth.ts'), 'export const rewritten = "changed";\n');
      const embeds = countEmbeds(store);
      await service.startIndexing(root);
      await settle(service);

      expect(embeds.calls()).toBeGreaterThan(0);
      const results = await store.search('changed', { limit: 20 });
      expect(results.some((match) => match.text.includes('changed'))).toBe(true);
    });

    it('does not re-embed a file whose timestamp moved but whose bytes did not', async () => {
      // A checkout or a `touch` moves mtime without changing content; hashing is
      // what stops that costing a full re-embed of the repository.
      const unchanged = join(root, 'auth.ts');
      const original = await readFile(unchanged, 'utf8');
      await service.startIndexing(root);
      await settle(service);

      await writeFile(unchanged, original);
      const embeds = countEmbeds(store);
      await service.startIndexing(root);
      await settle(service);

      expect(embeds.calls()).toBe(0);
    });

    it('drops the chunks of a file that has been deleted', async () => {
      await service.startIndexing(root);
      await settle(service);
      expect(await store.search('authenticate', { limit: 20 })).not.toHaveLength(0);

      await rm(join(root, 'auth.ts'));
      await service.startIndexing(root);
      await settle(service);

      const remaining = await store.search('authenticate', { limit: 20 });
      expect(remaining.map((match) => match.metadata.relativePath)).not.toContain('auth.ts');
    });

    it('replaces rather than merges when a file shrinks', async () => {
      await writeFile(join(root, 'auth.ts'), `export const a = 1;\n${'// filler\n'.repeat(200)}`);
      await service.startIndexing(root);
      await settle(service);
      const before = await service.getStatus();

      await writeFile(join(root, 'auth.ts'), 'export const a = 1;\n');
      await service.startIndexing(root);
      await settle(service);

      // Orphaned chunks from the longer version must not survive.
      const after = await service.getStatus();
      expect(after.totalChunks).toBeLessThan(before.totalChunks);
    });

    it('reports how many files it skipped', async () => {
      await service.startIndexing(root);
      await settle(service);

      const events: number[] = [];
      const subscription = service.progress.subscribe((event) => events.push(event.filesSkipped));
      await service.startIndexing(root);
      await settle(service);
      subscription.unsubscribe();

      expect(Math.max(...events)).toBeGreaterThan(0);
    });

    it('falls back to a wholesale re-index when the per-file state failed to persist', async () => {
      // `upsertFiles` only warns on failure, so the root can be `stale: false`
      // with no records behind it. Diffing against nothing there would re-embed
      // every file without first dropping what it replaces, stranding the chunks
      // of any file that shrank.
      await writeFile(join(root, 'auth.ts'), `export const a = 1;\n${'// filler\n'.repeat(200)}`);
      vi.spyOn(metadata, 'upsertFiles').mockRejectedValue(new Error('disk full'));

      await service.startIndexing(root);
      await settle(service);
      const before = await service.getStatus();
      expect(await metadata.listFiles(root)).toEqual([]);

      await writeFile(join(root, 'auth.ts'), 'export const a = 1;\n');
      await service.startIndexing(root);
      await settle(service);

      const after = await service.getStatus();
      expect(after.totalChunks).toBeLessThan(before.totalChunks);
      expect(after.totalChunks).toBe(after.roots[0]?.chunkCount);
    });

    it('skips a file on size and mtime alone, without opening it', async () => {
      // Proving the cheap path actually runs, by making the two paths disagree:
      // same length, same timestamp, different bytes. Hashing would notice; the
      // stat comparison deliberately does not, and that is the trade — a restored
      // mtime plus an identical length is indistinguishable from no edit at all.
      const file = join(root, 'auth.ts');
      const original = await readFile(file, 'utf8');

      // A fixed whole-millisecond timestamp on both sides. It has to be pinned
      // before the first run, because that is the value the record keeps, and
      // `stat` reports a sub-millisecond precision that `utimes` cannot restore
      // from a Date — "put it back how it was" misses by a fraction.
      const pinned = new Date(1_700_000_000_000);
      await utimes(file, pinned, pinned);
      await service.startIndexing(root);
      await settle(service);

      await writeFile(file, 'x'.repeat(original.length));
      await utimes(file, pinned, pinned);

      const embeds = countEmbeds(store);
      await service.startIndexing(root);
      await settle(service);

      expect(embeds.calls()).toBe(0);
    });

    it('keeps the chunks of files a cancelled run never reached', async () => {
      // `forgetMissing` drops everything the walk did not see. A cancelled run has
      // not seen most of the folder, so running it there would delete the index
      // the user still has — the counters would look fine and search would be empty.
      await service.startIndexing(root);
      await settle(service);
      const before = await service.getStatus();
      expect(before.totalChunks).toBeGreaterThan(0);

      await service.startIndexing(root);
      service.cancel();
      await settle(service);

      expect((await service.getStatus()).totalChunks).toBe(before.totalChunks);
    });

    it('makes no server call it does not need on a run that changed nothing', async () => {
      // Each of these guards exists to avoid a round trip, and against a real
      // Chroma that is a network request per file. They are invisible in the
      // result — the index is correct either way — so only the call count
      // shows whether they still work.
      await service.startIndexing(root);
      await settle(service);

      const deleteByPaths = vi.spyOn(store, 'deleteByPaths');
      const upsert = vi.spyOn(store, 'upsert');
      await service.startIndexing(root);
      await settle(service);

      // Nothing changed: nothing to replace, nothing to embed, nothing missing.
      expect(deleteByPaths).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('does not embed an empty chunk list for a file that produced none', async () => {
      await writeFile(join(root, 'blob.ts'), `export const x = 1;\u0000`);
      const upsert = vi.spyOn(store, 'upsert');

      await service.startIndexing(root);
      await settle(service);

      // Every call carries work; a binary file contributes no empty batch.
      expect(upsert.mock.calls.every((call) => call[0].length > 0)).toBe(true);
    });

    it('still serves the folder when its root record could not be persisted', async () => {
      // SQLite is a convenience here, not the source of truth: losing the write
      // costs the folder list on next launch, not this session's index.
      vi.spyOn(metadata, 'upsertRoot').mockRejectedValue(new Error('disk full'));

      await service.startIndexing(root);
      await settle(service);

      const status = await service.getStatus();
      expect(status.roots.map((entry) => entry.path)).toEqual([root]);
      expect(status.totalChunks).toBeGreaterThan(0);
    });

    it('drops the chunks of a deleted file even if forgetting its record fails', async () => {
      // The vector store is what answers queries. If the bookkeeping write fails,
      // the stale chunks must already be gone rather than waiting on a retry.
      await service.startIndexing(root);
      await settle(service);

      await rm(join(root, 'auth.ts'));
      vi.spyOn(metadata, 'removeFiles').mockRejectedValue(new Error('disk full'));
      await service.startIndexing(root);
      await settle(service);

      const remaining = await store.search('authenticate', { limit: 20 });
      expect(remaining.map((match) => match.metadata.relativePath)).not.toContain('auth.ts');
    });

    it('does not skip a file that changed size but kept its length-in-bytes timestamp', async () => {
      // Size alone is a weak fingerprint — an edit that swaps one identifier for
      // another of the same length is the common case, not a corner one.
      const file = join(root, 'auth.ts');
      const original = await readFile(file, 'utf8');
      await service.startIndexing(root);
      await settle(service);

      await writeFile(file, 'y'.repeat(original.length));
      const embeds = countEmbeds(store);
      await service.startIndexing(root);
      await settle(service);

      expect(embeds.calls()).toBeGreaterThan(0);
    });

    it('counts every reused file, not merely some of them', async () => {
      await service.startIndexing(root);
      await settle(service);
      const indexed = (await service.getStatus()).roots[0]?.fileCount ?? 0;

      const skipped: number[] = [];
      const subscription = service.progress.subscribe((event) => skipped.push(event.filesSkipped));
      await service.startIndexing(root);
      await settle(service);
      subscription.unsubscribe();

      expect(Math.max(...skipped)).toBe(indexed);
    });

    it('records one row per walked file, with a usable content hash', async () => {
      await service.startIndexing(root);
      await settle(service);

      const records = await metadata.listFiles(root);
      const walked = (await service.getStatus()).roots[0]?.fileCount;

      expect(records).toHaveLength(walked ?? 0);
      for (const record of records) {
        // sha256 as hex: anything else and every comparison next run is a miss.
        expect(record.contentHash).toMatch(/^[\da-f]{64}$/);
        expect(record.root).toBe(root);
      }
    });

    it('keeps the rows intact when only timestamps moved', async () => {
      const file = join(root, 'auth.ts');
      const original = await readFile(file, 'utf8');
      await service.startIndexing(root);
      await settle(service);

      await writeFile(file, original);
      await service.startIndexing(root);
      await settle(service);

      const record = (await metadata.listFiles(root)).find((entry) => entry.path === file);
      expect(record).toMatchObject({ root, path: file });
      expect(record?.chunkCount).toBeGreaterThan(0);
    });

    it('does not treat a file that failed mid-run as one the walk never saw', async () => {
      // A file that threw before its chunks were replaced still exists and its old
      // chunks are still good. Letting it fall through to `forgetMissing` would
      // delete them on the strength of a transient error.
      await service.startIndexing(root);
      await settle(service);

      await writeFile(join(root, 'auth.ts'), 'export const changed = true;\n');
      // Fails on the replace, so `indexOne` throws with the old chunks still in
      // place; the later call from `forgetMissing` would go through.
      vi.spyOn(store, 'deleteByPaths').mockRejectedValueOnce(new Error('transient'));
      await service.startIndexing(root);
      await settle(service);

      const remaining = await store.search('authenticate', { limit: 20 });
      expect(remaining.map((match) => match.metadata.relativePath)).toContain('auth.ts');
    });

    it('makes no per-file delete call on a first index, where nothing can be stale', async () => {
      const deleteByPaths = vi.spyOn(store, 'deleteByPaths');

      await service.startIndexing(root);
      await settle(service);

      expect(deleteByPaths).not.toHaveBeenCalled();
    });

    it('re-indexes from scratch after a restart lost the in-memory chunks', async () => {
      // The live failure this guards: per-file state survives in SQLite, the
      // chunks do not, and trusting the records skipped every file — leaving a
      // folder that reported hundreds of indexed files and zero searchable chunks.
      await service.startIndexing(root);
      await settle(service);

      // A restart: same metadata, a brand-new (empty) vector store.
      const restartedStore = new MemoryVectorStore(new HashingEmbeddings({ dimensions: 64 }));
      const restarted = new IndexingService(
        testConfig({
          indexing: {
            chunkSize: 400,
            chunkOverlap: 50,
            maxFileBytes: 64 * 1024,
            concurrency: 4,
            allowedRoots: [root],
            watch: false,
            watchDebounceMs: 5,
          },
        }),
        metadata,
        await testPlugins(),
        asVectorStoreService(restartedStore),
        silentLogger(),
      );
      await restarted.onModuleInit();
      expect((await restarted.getStatus()).roots[0]?.stale).toBe(true);

      await restarted.startIndexing(root);
      await settle(restarted);

      const status = await restarted.getStatus();
      expect(status.totalChunks).toBeGreaterThan(0);
      expect(status.totalChunks).toBe(status.roots[0]?.chunkCount);
      expect(status.roots[0]?.stale).toBe(false);
    });
  });
});
